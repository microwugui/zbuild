// 1:1 移植自 esbuild internal/js_lexer/js_lexer.go（v0.28.2，commit f6058f83）
//
// 本轮（第 11 次推进）只落「裸 token 循环能执行到」的那批函数（共 22 个），
// 并用 V2 夹具（1,738 例 / 15,886 token）做逐 token 差分。**没有落的**是 parser 驱动才用得到的
// 那批（JSX 三个 Next* / Expect* / ScanRegExp / RescanCloseBraceAsTemplateToken /
// RangeOfIdentifier 等），它们会要求执行率却拿不到语料，故留到 parser 阶段一起做——
// 清单见 PLAN.md「第 11 次推进」§3。
//
// 语义约定（与 logger.Source 的既定决策一致，见 PLAN.md「第 6 次推进」§0）：
//   - `source.Contents` 是 Uint8Array；所有 range 都是**字节**偏移；`Raw()` 返回字节切片。
//   - `codePoint === -1` 表示 EOF（Go 用 width==0 表示）。
//   - Go 的 `panic(LexerPanic{})` → TS 的 `throw new LexerPanic()`；`LexerPanic` 是终止态，
//     调用方不得继续用同一个 lexer（这与 Go 的 recover 语义一致）。
//
// 已确认按 Go 原样保留的两处「看似 bug」的行为（不是笔误，1:1 优先）：
//   1. `maybeExpandEquals` 里写的是 `lexer.Token == '='`（应为 `lexer.codePoint`）——
//      由于 61 号 token 是 TGreaterThanGreaterThanGreaterThanEquals，这个分支实际永不命中。
//      本轮未移植该函数，移植时必须照抄。
//   2. `TNoSubstitutionTemplateLiteral` 等模板 token 在裸循环里会产生「重复扫反引号」的假象，
//      这属于「必须由 parser 重扫」的结构性事实（PLAN.md「第 10 次推进」§3.2）。

import {
  AddError,
  AddErrorWithNotes,
  AddID,
  Loc,
  MakeLineColumnTracker,
  Msg,
  MsgData,
  MsgKind,
  Range,
  Span,
  type Log,
  type LineColumnTracker,
  type Source,
} from "../logger/logger.ts";
import { decodeRune } from "../logger/bytes.ts";
import { UTF16ToString } from "../helpers/utf.ts";
import {
  IsIdentifier,
  IsIdentifierContinue,
  IsIdentifierStart,
  IsWhitespace,
} from "../js_ast/js_ident.ts";
import { jsxEntity, Keywords, T, tokenToString } from "./tables.ts";
import type { AssertOrWithEntry } from "../ast/ast.ts";
import { MsgID_JS_HTMLCommentInJS } from "../logger/msg_ids.ts";

/**
 * DEVIATION: config 包（M3）尚未移植。js_lexer 只用到 `TSOptions.Parse`（JSX 文本里的
 * `}`/`>` 报错级别）与 `NoAmbiguousLessThan`，这里先按结构声明；config 落地后改为 import。
 */
export interface TSOptions {
  Parse: boolean;
  NoAmbiguousLessThan: boolean;
}

/** Go: func (t T) IsAssign() bool —— T 在 TS 里是 number，所以写成自由函数 */
export function IsAssign(t: T): boolean {
  return t >= T.TAmpersandAmpersandEquals && t <= T.TSlashEquals;
}

/** Go: type JSONFlavor uint8 */
export type JSONFlavor = number;
export const JSONFlavor = {
  // Specification: https://json.org/
  JSON: 0,

  // TypeScript's JSON superset is not documented but appears to allow:
  // - Comments: https://github.com/microsoft/TypeScript/issues/4987
  // - Trailing commas
  // - Full JS number syntax
  TSConfigJSON: 1,

  // This is used by the JavaScript lexer
  NotJSON: 2,
} as const;

/**
 * Go: type MaybeSubstring struct { String string; Start ast.Index32 }
 *
 * DEVIATION：String 用 Uint8Array 承载（Go 的 string 就是 UTF-8 字节串）。
 * Start 为 0（invalid）时表示 String 不是 source.Contents 的切片（例如转义标识符）。
 */
export class MaybeSubstring {
  String: Uint8Array;
  Start: number;

  constructor(String_: Uint8Array = new Uint8Array(0), Start: number = 0) {
    this.String = String_;
    this.Start = Start | 0;
  }
}

export type CommentBefore = number;
export const CommentBefore = {
  PureCommentBefore: 1 << 0,
  KeyCommentBefore: 1 << 1,
  NoSideEffectsCommentBefore: 1 << 2,
} as const;

export const pragmaNoSpaceFirst = 0;
export const pragmaSkipSpaceFirst = 1;

const normalIdentifier = 0;
const privateIdentifier = 1;

/** Go: type LexerPanic struct{} */
export class LexerPanic extends Error {
  constructor() {
    super("LexerPanic");
    this.name = "LexerPanic";
  }
}

// ---------------------------------------------------------------------------
// 小工具（Go 的 strings / strconv / fmt 里本文件用到的那一点）
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

/** 字节切片 → latin1 字符串（仅用于 map 查找；非 ASCII 字典序不会碰巧命中关键字） */
function latin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function hasPrefixBytes(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix[i]) return false;
  return true;
}

const PREFIX_HASHBANG = encoder.encode("#!");
const PREFIX_HTML_OPEN = encoder.encode("<!--");

/** Go: fmt.Sprintf("%c", r) —— 输出该码点的 UTF-8 字节 */
function runeToString(r: number): string {
  if (r < 0) return "\uFFFD"; // Go 的 %c 对非法 rune 输出 U+FFFD
  return String.fromCodePoint(r);
}

/**
 * Go: fmt.Sprintf("%q", text)（= strconv.Quote）
 *
 * 覆盖：`"`/`\\`、\a\b\f\n\r\t\v、可打印 ASCII 原样；其余按 \xNN / \uNNNN / \UNNNNNNNN。
 *
 * DEVIATION（未执行到，先记录）：非 ASCII 的「可打印」判定需要 unicode.IsPrint 的
 * L/M/N/P/S + Zs 表，本文件暂按「U+00A0 及以上的非空白一律转义」处理。
 * 该路径只用于 `Invalid identifier: %q` / `Unexpected %q` 这两条报错文案，
 * 当前 1,854 条语料（V2 + lex-err）里一次都没有命中；命中前必须先补 IsPrint 表。
 */
export function goQuote(bytes: Uint8Array): string {
  let out = '"';
  let i = 0;
  while (i < bytes.length) {
    const { r, width } = decodeRune(bytes, i);
    if (width === 1 && r === 0xfffd && bytes[i] >= 0x80) {
      out += "\\x" + bytes[i].toString(16).padStart(2, "0");
      i++;
      continue;
    }
    i += width;
    if (r === 0x22 || r === 0x5c) {
      out += "\\" + String.fromCharCode(r);
      continue;
    }
    if (r >= 0x20 && r < 0x7f) {
      out += String.fromCharCode(r);
      continue;
    }
    switch (r) {
      case 0x07: out += "\\a"; continue;
      case 0x08: out += "\\b"; continue;
      case 0x0c: out += "\\f"; continue;
      case 0x0a: out += "\\n"; continue;
      case 0x0d: out += "\\r"; continue;
      case 0x09: out += "\\t"; continue;
      case 0x0b: out += "\\v"; continue;
    }
    if (r < 0x20 || r === 0x7f) {
      out += "\\x" + r.toString(16).padStart(2, "0");
    } else if (r < 0x10000) {
      out += "\\u" + r.toString(16).padStart(4, "0");
    } else {
      out += "\\U" + r.toString(16).padStart(8, "0");
    }
  }
  return out + '"';
}

/** Go: strconv.ParseFloat(text, 64)（text 一定是 ASCII 数字文法） */
function parseFloat(text: Uint8Array): number {
  return Number(latin1(text));
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

export class Lexer {
  LegalCommentsBeforeToken: Range[] = [];
  CommentsBeforeToken: Range[] = [];
  AllComments: Range[] = [];
  Identifier: MaybeSubstring = new MaybeSubstring();
  log: Log;
  source: Source;
  JSXFactoryPragmaComment: Span = new Span();
  JSXFragmentPragmaComment: Span = new Span();
  JSXRuntimePragmaComment: Span = new Span();
  JSXImportSourcePragmaComment: Span = new Span();
  SourceMappingURL: Span = new Span();
  BadArrowInTSXSuggestion = "";

  // Escape sequences in string literals are decoded lazily because they are
  // not interpreted inside tagged templates, and tagged templates can contain
  // invalid escape sequences. If the decoded array is nil, the encoded value
  // should be passed to "tryToDecodeEscapeSequences" first.
  decodedStringLiteralOrNil: Uint16Array | null = null;
  encodedStringLiteralText: Uint8Array = new Uint8Array(0);

  errorSuffix = "";
  tracker: LineColumnTracker;

  encodedStringLiteralStart = 0;

  Number = 0;
  current = 0;
  start = 0;
  end = 0;
  ApproximateNewlineCount = 0;
  CouldBeBadArrowInTSX = 0;
  BadArrowInTSXRange: Range = new Range();
  LegacyOctalLoc: Loc = new Loc();
  AwaitKeywordLoc: Loc = new Loc();
  FnOrArrowStartLoc: Loc;
  PreviousBackslashQuoteInJSX: Range = new Range();
  LegacyHTMLCommentRange: Range = new Range();
  codePoint = 0;
  prevErrorLoc: Loc;
  json: JSONFlavor = JSONFlavor.NotJSON;
  Token: T = T.TEndOfFile;
  ts: TSOptions = { Parse: false, NoAmbiguousLessThan: false };
  HasNewlineBefore = false;
  HasCommentBefore: CommentBefore = 0;
  IsLegacyOctalLiteral = false;
  PrevTokenWasAwaitKeyword = false;
  rescanCloseBraceAsTemplateToken = false;
  forGlobalName = false;

  // The log is disabled during speculative scans that may backtrack
  IsLogDisabled = false;

  constructor(log: Log, source: Source) {
    this.log = log;
    this.source = source;
    this.tracker = MakeLineColumnTracker(source);
    this.prevErrorLoc = new Loc(-1);
    this.FnOrArrowStartLoc = new Loc(-1);
  }

  /** Go: func NewLexer(log logger.Log, source logger.Source, ts config.TSOptions) Lexer */
  static NewLexer(log: Log, source: Source, ts: TSOptions): Lexer {
    const lexer = new Lexer(log, source);
    lexer.ts = ts;
    lexer.json = JSONFlavor.NotJSON;
    lexer.step();
    lexer.Next();
    return lexer;
  }

  /** Go: func NewLexerGlobalName(log logger.Log, source logger.Source) Lexer */
  static NewLexerGlobalName(log: Log, source: Source): Lexer {
    const lexer = new Lexer(log, source);
    lexer.forGlobalName = true;
    lexer.json = JSONFlavor.NotJSON;
    lexer.step();
    lexer.Next();
    return lexer;
  }

  /** Go: func NewLexerJSON(log logger.Log, source logger.Source, json JSONFlavor, errorSuffix string) Lexer */
  static NewLexerJSON(
    log: Log,
    source: Source,
    json: JSONFlavor,
    errorSuffix: string,
  ): Lexer {
    const lexer = new Lexer(log, source);
    lexer.errorSuffix = errorSuffix;
    lexer.json = json;
    lexer.step();
    lexer.Next();
    return lexer;
  }

  /** Go: func (lexer *Lexer) Loc() logger.Loc */
  Loc(): Loc {
    return new Loc(this.start);
  }

  /** Go: func (lexer *Lexer) Range() logger.Range */
  Range(): Range {
    return new Range(new Loc(this.start), this.end - this.start);
  }

  /** Go: func (lexer *Lexer) Raw() string —— 返回字节切片 */
  Raw(): Uint8Array {
    return this.source.Contents.subarray(this.start, this.end);
  }

  /** Go: func (lexer *Lexer) rawIdentifier() MaybeSubstring */
  rawIdentifier(): MaybeSubstring {
    return new MaybeSubstring(this.Raw(), this.start);
  }

  /** Go: func (lexer *Lexer) StringLiteral() []uint16 */
  StringLiteral(): Uint16Array {
    if (this.decodedStringLiteralOrNil === null) {
      // Lazily decode escape sequences if needed
      const result = this.tryToDecodeEscapeSequences(
        this.encodedStringLiteralStart,
        this.encodedStringLiteralText,
        true, /* reportErrors */
      );
      if (!result.ok) {
        this.end = result.end;
        this.SyntaxError();
        throw new LexerPanic(); // 不可达：SyntaxError 已抛
      }
      this.decodedStringLiteralOrNil = result.decoded!;
    }
    return this.decodedStringLiteralOrNil;
  }

  /**
   * Go: func (lexer *Lexer) CookedAndRawTemplateContents() ([]uint16, string)
   *
   * DEVIATION：Go 的 raw 是 string（UTF-8 字节串），TS 用 Uint8Array 保留原始字节；
   * CRLF/CR 归一化成 LF 的逻辑逐字移植（目标数组与 Go 一样是「原地重写 + 截断」）。
   */
  CookedAndRawTemplateContents(): { cooked: Uint16Array | null; raw: Uint8Array } {
    let raw = new Uint8Array(0);

    switch (this.Token) {
      case T.TNoSubstitutionTemplateLiteral:
      case T.TTemplateTail:
        // "`x`" or "}x`"
        raw = this.source.Contents.subarray(this.start + 1, this.end - 1);
        break;

      case T.TTemplateHead:
      case T.TTemplateMiddle:
        // "`x${" or "}x${"
        raw = this.source.Contents.subarray(this.start + 1, this.end - 2);
        break;
    }

    if (raw.indexOf(0x0d) !== -1) {
      // From the specification:
      //
      // 11.8.6.1 Static Semantics: TV and TRV
      //
      // TV excludes the code units of LineContinuation while TRV includes them.
      // <CR><LF> and <CR> LineTerminatorSequences are normalized to <LF> for both TV and TRV.
      const bytes = raw.slice();
      let end = 0;
      let i = 0;

      while (i < bytes.length) {
        let c = bytes[i];
        i++;

        if (c === 0x0d) {
          // Convert '\r\n' into '\n'
          if (i < bytes.length && bytes[i] === 0x0a) i++;
          // Convert '\r' into '\n'
          c = 0x0a;
        }

        bytes[end] = c;
        end++;
      }

      raw = bytes.subarray(0, end);
    }

    // This will return nil on failure, which will become "undefined" for the tag
    const result = this.tryToDecodeEscapeSequences(this.start + 1, raw, false /* reportErrors */);
    return { cooked: result.ok ? result.decoded : null, raw };
  }

  /** Go: func (lexer *Lexer) IsIdentifierOrKeyword() bool */
  IsIdentifierOrKeyword(): boolean {
    return this.Token >= T.TIdentifier;
  }

  /** Go: func (lexer *Lexer) IsContextualKeyword(text string) bool */
  IsContextualKeyword(text: string): boolean {
    return this.Token === T.TIdentifier && rawEqualsString(this.Raw(), text);
  }

  /** Go: func (lexer *Lexer) ExpectContextualKeyword(text string) */
  ExpectContextualKeyword(text: string): void {
    if (!this.IsContextualKeyword(text)) {
      this.ExpectedString(goQuoteString(text));
    }
    this.Next();
  }

  /** Go: func (lexer *Lexer) SyntaxError() */
  SyntaxError(): void {
    const loc = new Loc(this.end);
    let message = "Unexpected end of file";
    if (this.end < this.source.Contents.length) {
      const { r: c } = decodeRune(this.source.Contents, this.end);
      if (c < 0x20) {
        message = 'Syntax error "\\x' + c.toString(16).toUpperCase().padStart(2, "0") + '"';
      } else if (c >= 0x80) {
        message = 'Syntax error "\\u{' + c.toString(16) + '}"';
      } else if (c !== 0x22) {
        message = 'Syntax error "' + String.fromCharCode(c) + '"';
      } else {
        message = "Syntax error '\"'";
      }
    }
    this.addRangeError(new Range(loc, 0), message);
    throw new LexerPanic();
  }

  /** Go: func (lexer *Lexer) ExpectedString(text string) */
  ExpectedString(text: string): void {
    // Provide a friendly error message about "await" without "async"
    if (this.PrevTokenWasAwaitKeyword) {
      let notes: MsgData[] = [];
      if (this.FnOrArrowStartLoc.Start !== -1) {
        const note = this.tracker.MsgData(
          new Range(new Loc(this.FnOrArrowStartLoc.Start), 0),
          'Consider adding the "async" keyword here:',
        );
        note.Location!.Suggestion = "async";
        notes = [note];
      }
      this.AddRangeErrorWithNotes(
        RangeOfIdentifier(this.source, this.AwaitKeywordLoc),
        '"await" can only be used inside an "async" function',
        notes,
      );
      throw new LexerPanic();
    }

    let found = goQuote(this.Raw());
    if (this.start === this.source.Contents.length) {
      found = "end of file";
    }

    let suggestion = "";
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
      suggestion = text.slice(1, text.length - 1);
    }

    this.addRangeErrorWithSuggestion(
      this.Range(),
      "Expected " + text + this.errorSuffix + " but found " + found,
      suggestion,
    );
    throw new LexerPanic();
  }

  /** Go: func (lexer *Lexer) Expected(token T) */
  Expected(token: T): void {
    const text = tokenToString.get(token);
    if (text !== undefined) {
      this.ExpectedString(text);
    } else {
      this.Unexpected();
    }
  }

  /** Go: func (lexer *Lexer) Expect(token T) */
  Expect(token: T): void {
    if (this.Token !== token) {
      this.Expected(token);
    }
    this.Next();
  }

  /** Go: func (lexer *Lexer) ExpectOrInsertSemicolon() */
  ExpectOrInsertSemicolon(): void {
    if (
      this.Token === T.TSemicolon || (!this.HasNewlineBefore &&
        this.Token !== T.TCloseBrace && this.Token !== T.TEndOfFile)
    ) {
      this.Expect(T.TSemicolon);
    }
  }

  /**
   * Go: func (lexer *Lexer) ExpectLessThan(isInsideJSXElement bool)
   *
   * This parses a single "<" token. If that is the first part of a longer token,
   * this function splits off the first "<" and leaves the remainder of the
   * current token as another, smaller token. For example, "<<=" becomes "<=".
   */
  ExpectLessThan(isInsideJSXElement: boolean): void {
    switch (this.Token) {
      case T.TLessThan:
        if (isInsideJSXElement) {
          this.NextInsideJSXElement();
        } else {
          this.Next();
        }
        break;

      case T.TLessThanEquals:
        this.Token = T.TEquals;
        this.start++;
        this.maybeExpandEquals();
        break;

      case T.TLessThanLessThan:
        this.Token = T.TLessThan;
        this.start++;
        break;

      case T.TLessThanLessThanEquals:
        this.Token = T.TLessThanEquals;
        this.start++;
        break;

      default:
        this.Expected(T.TLessThan);
    }
  }

  /**
   * Go: func (lexer *Lexer) ExpectGreaterThan(isInsideJSXElement bool)
   *
   * This parses a single ">" token. If that is the first part of a longer token,
   * this function splits off the first ">" and leaves the remainder of the
   * current token as another, smaller token. For example, ">>=" becomes ">=".
   */
  ExpectGreaterThan(isInsideJSXElement: boolean): void {
    switch (this.Token) {
      case T.TGreaterThan:
        if (isInsideJSXElement) {
          this.NextInsideJSXElement();
        } else {
          this.Next();
        }
        break;

      case T.TGreaterThanEquals:
        this.Token = T.TEquals;
        this.start++;
        this.maybeExpandEquals();
        break;

      case T.TGreaterThanGreaterThan:
        this.Token = T.TGreaterThan;
        this.start++;
        break;

      case T.TGreaterThanGreaterThanEquals:
        this.Token = T.TGreaterThanEquals;
        this.start++;
        break;

      case T.TGreaterThanGreaterThanGreaterThan:
        this.Token = T.TGreaterThanGreaterThan;
        this.start++;
        break;

      case T.TGreaterThanGreaterThanGreaterThanEquals:
        this.Token = T.TGreaterThanGreaterThanEquals;
        this.start++;
        break;

      default:
        this.Expected(T.TGreaterThan);
    }
  }

  /**
   * Go: func (lexer *Lexer) maybeExpandEquals()
   *
   * 1:1 优先：Go 这里写的是 `lexer.Token == '='`（不是 lexer.codePoint），
   * 由于 61 号 token 是 TGreaterThanGreaterThanGreaterThanEquals，该分支实际永不命中。
   * 已确认是否笔误不影响 1:1 目标，照抄。
   */
  maybeExpandEquals(): void {
    switch (this.codePoint) {
      case 0x3e: // '>'
        // "=" + ">" = "=>"
        this.Token = T.TEqualsGreaterThan;
        this.step();
        break;

      case 0x3d: // '='
        // "=" + "=" = "=="
        this.Token = T.TEqualsEquals;
        this.step();

        if (this.Token === 0x3d) {
          // "=" + "==" = "==="
          this.Token = T.TEqualsEqualsEquals;
          this.step();
        }
        break;
    }
  }

  /** Go: func (lexer *Lexer) Unexpected() */
  Unexpected(): void {
    let found = goQuote(this.Raw());
    if (this.start === this.source.Contents.length) {
      found = "end of file";
    }
    this.addRangeError(this.Range(), "Unexpected " + found + this.errorSuffix);
    throw new LexerPanic();
  }

  /** Go: func (lexer *Lexer) Next() */
  Next(): void {
    this.HasNewlineBefore = this.end === 0;
    this.HasCommentBefore = 0;
    this.PrevTokenWasAwaitKeyword = false;
    this.LegalCommentsBeforeToken = [];
    this.CommentsBeforeToken = [];

    for (;;) {
      this.start = this.end;
      this.Token = 0;

      switch (this.codePoint) {
        case -1: // This indicates the end of the file
          this.Token = T.TEndOfFile;
          break;

        case 0x23: // '#'
          if (this.start === 0 && hasPrefixBytes(this.source.Contents, PREFIX_HASHBANG)) {
            // "#!/usr/bin/env node"
            this.Token = T.THashbang;
            for (;;) {
              this.step();
              switch (this.codePoint) {
                case 0x0d:
                case 0x0a:
                case 0x2028:
                case 0x2029:
                case -1: // This indicates the end of the file
                  break;
                default:
                  continue;
              }
              break;
            }
            this.Identifier = this.rawIdentifier();
          } else {
            // "#foo"
            this.step();
            if (this.codePoint === 0x5c /* '\\' */) {
              const r = this.scanIdentifierWithEscapes(privateIdentifier);
              this.Identifier = r.maybe;
            } else {
              if (!IsIdentifierStart(this.codePoint)) {
                this.SyntaxError();
              }
              this.step();
              while (IsIdentifierContinue(this.codePoint)) this.step();
              if (this.codePoint === 0x5c /* '\\' */) {
                const r = this.scanIdentifierWithEscapes(privateIdentifier);
                this.Identifier = r.maybe;
              } else {
                this.Identifier = this.rawIdentifier();
              }
            }
            this.Token = T.TPrivateIdentifier;
          }
          break;

        case 0x0d: // '\r'
        case 0x0a: // '\n'
        case 0x2028:
        case 0x2029:
          this.step();
          this.HasNewlineBefore = true;
          continue;

        case 0x09: // '\t'
        case 0x20: // ' '
          this.step();
          continue;

        case 0x28: // '('
          this.step();
          this.Token = T.TOpenParen;
          break;

        case 0x29: // ')'
          this.step();
          this.Token = T.TCloseParen;
          break;

        case 0x5b: // '['
          this.step();
          this.Token = T.TOpenBracket;
          break;

        case 0x5d: // ']'
          this.step();
          this.Token = T.TCloseBracket;
          break;

        case 0x7b: // '{'
          this.step();
          this.Token = T.TOpenBrace;
          break;

        case 0x7d: // '}'
          this.step();
          this.Token = T.TCloseBrace;
          break;

        case 0x2c: // ','
          this.step();
          this.Token = T.TComma;
          break;

        case 0x3a: // ':'
          this.step();
          this.Token = T.TColon;
          break;

        case 0x3b: // ';'
          this.step();
          this.Token = T.TSemicolon;
          break;

        case 0x40: // '@'
          this.step();
          this.Token = T.TAt;
          break;

        case 0x7e: // '~'
          this.step();
          this.Token = T.TTilde;
          break;

        case 0x3f: { // '?'
          // '?' or '?.' or '??' or '??='
          this.step();
          switch (this.codePoint) {
            case 0x3f: // '?'
              this.step();
              switch (this.codePoint) {
                case 0x3d: // '='
                  this.step();
                  this.Token = T.TQuestionQuestionEquals;
                  break;
                default:
                  this.Token = T.TQuestionQuestion;
              }
              break;
            case 0x2e: { // '.'
              this.Token = T.TQuestion;
              const current = this.current;
              const contents = this.source.Contents;

              // Lookahead to disambiguate with 'a?.1:b'
              if (current < contents.length) {
                const c = contents[current];
                if (c < 0x30 || c > 0x39) {
                  this.step();
                  this.Token = T.TQuestionDot;
                }
              }
              break;
            }
            default:
              this.Token = T.TQuestion;
          }
          break;
        }

        case 0x25: // '%'
          // '%' or '%='
          this.step();
          switch (this.codePoint) {
            case 0x3d: // '='
              this.step();
              this.Token = T.TPercentEquals;
              break;
            default:
              this.Token = T.TPercent;
          }
          break;

        case 0x26: // '&'
          // '&' or '&=' or '&&' or '&&='
          this.step();
          switch (this.codePoint) {
            case 0x3d: // '='
              this.step();
              this.Token = T.TAmpersandEquals;
              break;
            case 0x26: // '&'
              this.step();
              switch (this.codePoint) {
                case 0x3d: // '='
                  this.step();
                  this.Token = T.TAmpersandAmpersandEquals;
                  break;
                default:
                  this.Token = T.TAmpersandAmpersand;
              }
              break;
            default:
              this.Token = T.TAmpersand;
          }
          break;

        case 0x7c: // '|'
          // '|' or '|=' or '||' or '||='
          this.step();
          switch (this.codePoint) {
            case 0x3d: // '='
              this.step();
              this.Token = T.TBarEquals;
              break;
            case 0x7c: // '|'
              this.step();
              switch (this.codePoint) {
                case 0x3d: // '='
                  this.step();
                  this.Token = T.TBarBarEquals;
                  break;
                default:
                  this.Token = T.TBarBar;
              }
              break;
            default:
              this.Token = T.TBar;
          }
          break;

        case 0x5e: // '^'
          // '^' or '^='
          this.step();
          switch (this.codePoint) {
            case 0x3d: // '='
              this.step();
              this.Token = T.TCaretEquals;
              break;
            default:
              this.Token = T.TCaret;
          }
          break;

        case 0x2b: // '+'
          // '+' or '+=' or '++'
          this.step();
          switch (this.codePoint) {
            case 0x3d: // '='
              this.step();
              this.Token = T.TPlusEquals;
              break;
            case 0x2b: // '+'
              this.step();
              this.Token = T.TPlusPlus;
              break;
            default:
              this.Token = T.TPlus;
          }
          break;

        case 0x2d: // '-'
          // '-' or '-=' or '--' or '-->'
          this.step();
          switch (this.codePoint) {
            case 0x3d: // '='
              this.step();
              this.Token = T.TMinusEquals;
              break;
            case 0x2d: // '-'
              this.step();

              // Handle legacy HTML-style comments
              if (this.codePoint === 0x3e /* '>' */ && this.HasNewlineBefore) {
                this.step();
                this.LegacyHTMLCommentRange = this.Range();
                AddID(
                  this.log,
                  MsgID_JS_HTMLCommentInJS,
                  MsgKind.Warning,
                  this.tracker,
                  this.Range(),
                  'Treating "-->" as the start of a legacy HTML single-line comment',
                );
                for (;;) {
                  switch (this.codePoint) {
                    case 0x0d:
                    case 0x0a:
                    case 0x2028:
                    case 0x2029:
                    case -1: // This indicates the end of the file
                      break;
                    default:
                      this.step();
                      continue;
                  }
                  break;
                }
                continue;
              }

              this.Token = T.TMinusMinus;
              break;
            default:
              this.Token = T.TMinus;
              if (
                this.json === JSONFlavor.JSON && this.codePoint !== 0x2e &&
                (this.codePoint < 0x30 || this.codePoint > 0x39)
              ) {
                this.Unexpected();
              }
          }
          break;

        case 0x2a: // '*'
          // '*' or '*=' or '**' or '**='
          this.step();
          switch (this.codePoint) {
            case 0x3d: // '='
              this.step();
              this.Token = T.TAsteriskEquals;
              break;
            case 0x2a: // '*'
              this.step();
              switch (this.codePoint) {
                case 0x3d: // '='
                  this.step();
                  this.Token = T.TAsteriskAsteriskEquals;
                  break;
                default:
                  this.Token = T.TAsteriskAsterisk;
              }
              break;
            default:
              this.Token = T.TAsterisk;
          }
          break;

        case 0x2f: // '/'
          // '/' or '/=' or '//' or '/* ... */'
          this.step();
          if (this.forGlobalName) {
            this.Token = T.TSlash;
            break;
          }
          switch (this.codePoint) {
            case 0x3d: // '='
              this.step();
              this.Token = T.TSlashEquals;
              break;

            case 0x2f: // '/'
              for (;;) {
                this.step();
                switch (this.codePoint) {
                  case 0x0d:
                  case 0x0a:
                  case 0x2028:
                  case 0x2029:
                  case -1: // This indicates the end of the file
                    break;
                  default:
                    continue;
                }
                break;
              }
              if (this.json === JSONFlavor.JSON) {
                this.addRangeError(this.Range(), "JSON does not support comments");
              }
              this.scanCommentText();
              continue;

            case 0x2a: { // '*'
              this.step();
              const startRange = this.Range();
              for (;;) {
                switch (this.codePoint) {
                  case 0x2a: // '*'
                    this.step();
                    if (this.codePoint === 0x2f /* '/' */) {
                      this.step();
                      break;
                    }
                    continue;
                  case 0x0d:
                  case 0x0a:
                  case 0x2028:
                  case 0x2029:
                    this.step();
                    this.HasNewlineBefore = true;
                    continue;
                  case -1: // This indicates the end of the file
                    this.start = this.end;
                    this.AddRangeErrorWithNotes(
                      new Range(this.Loc(), 0),
                      'Expected "*/" to terminate multi-line comment',
                      [this.tracker.MsgData(startRange, "The multi-line comment starts here:")],
                    );
                    throw new LexerPanic();
                  default:
                    this.step();
                    continue;
                }
                break;
              }
              if (this.json === JSONFlavor.JSON) {
                this.addRangeError(this.Range(), "JSON does not support comments");
              }
              this.scanCommentText();
              continue;
            }

            default:
              this.Token = T.TSlash;
          }
          break;

        case 0x3d: // '='
          // '=' or '=>' or '==' or '==='
          this.step();
          switch (this.codePoint) {
            case 0x3e: // '>'
              this.step();
              this.Token = T.TEqualsGreaterThan;
              break;
            case 0x3d: // '='
              this.step();
              switch (this.codePoint) {
                case 0x3d: // '='
                  this.step();
                  this.Token = T.TEqualsEqualsEquals;
                  break;
                default:
                  this.Token = T.TEqualsEquals;
              }
              break;
            default:
              this.Token = T.TEquals;
          }
          break;

        case 0x3c: // '<'
          // '<' or '<<' or '<=' or '<<=' or '<!--'
          this.step();
          switch (this.codePoint) {
            case 0x3d: // '='
              this.step();
              this.Token = T.TLessThanEquals;
              break;
            case 0x3c: // '<'
              this.step();
              switch (this.codePoint) {
                case 0x3d: // '='
                  this.step();
                  this.Token = T.TLessThanLessThanEquals;
                  break;
                default:
                  this.Token = T.TLessThanLessThan;
              }
              break;
            case 0x21: // '!'
              if (hasPrefixBytes(this.source.Contents.subarray(this.start), PREFIX_HTML_OPEN)) {
                this.step();
                this.step();
                this.step();
                this.LegacyHTMLCommentRange = this.Range();
                AddID(
                  this.log,
                  MsgID_JS_HTMLCommentInJS,
                  MsgKind.Warning,
                  this.tracker,
                  this.Range(),
                  'Treating "<!--" as the start of a legacy HTML single-line comment',
                );
                for (;;) {
                  switch (this.codePoint) {
                    case 0x0d:
                    case 0x0a:
                    case 0x2028:
                    case 0x2029:
                    case -1: // This indicates the end of the file
                      break;
                    default:
                      this.step();
                      continue;
                  }
                  break;
                }
                continue;
              }

              this.Token = T.TLessThan;
              break;
            default:
              this.Token = T.TLessThan;
          }
          break;

        case 0x3e: // '>'
          // '>' or '>>' or '>>>' or '>=' or '>>=' or '>>>='
          this.step();
          switch (this.codePoint) {
            case 0x3d: // '='
              this.step();
              this.Token = T.TGreaterThanEquals;
              break;
            case 0x3e: // '>'
              this.step();
              switch (this.codePoint) {
                case 0x3d: // '='
                  this.step();
                  this.Token = T.TGreaterThanGreaterThanEquals;
                  break;
                case 0x3e: // '>'
                  this.step();
                  switch (this.codePoint) {
                    case 0x3d: // '='
                      this.step();
                      this.Token = T.TGreaterThanGreaterThanGreaterThanEquals;
                      break;
                    default:
                      this.Token = T.TGreaterThanGreaterThanGreaterThan;
                  }
                  break;
                default:
                  this.Token = T.TGreaterThanGreaterThan;
              }
              break;
            default:
              this.Token = T.TGreaterThan;
          }
          break;

        case 0x21: // '!'
          // '!' or '!=' or '!=='
          this.step();
          switch (this.codePoint) {
            case 0x3d: // '='
              this.step();
              switch (this.codePoint) {
                case 0x3d: // '='
                  this.step();
                  this.Token = T.TExclamationEqualsEquals;
                  break;
                default:
                  this.Token = T.TExclamationEquals;
              }
              break;
            default:
              this.Token = T.TExclamation;
          }
          break;

        case 0x27: // '\''
        case 0x22: // '"'
        case 0x60: { // '`'
          const quote = this.codePoint;
          let needsSlowPath = false;
          let suffixLen = 1;

          if (quote !== 0x60) {
            this.Token = T.TStringLiteral;
          } else if (this.rescanCloseBraceAsTemplateToken) {
            this.Token = T.TTemplateTail;
          } else {
            this.Token = T.TNoSubstitutionTemplateLiteral;
          }
          this.step();

          stringLiteral:
          for (;;) {
            // Go 的 switch 里有一支是 `case quote:`（quote 是变量），TS 的 case 只能是常量，
            // 所以把它提到 switch 之前——它与前几个字面量分支互斥，语义完全等价。
            if (this.codePoint === quote) {
              this.step();
              break stringLiteral;
            }

            switch (this.codePoint) {
              case 0x5c: // '\\'
                needsSlowPath = true;
                this.step();

                // Handle Windows CRLF
                if (this.codePoint === 0x0d && this.json !== JSONFlavor.JSON) {
                  this.step();
                  if (this.codePoint === 0x0a) this.step();
                  continue stringLiteral;
                }
                break;

              case -1: // This indicates the end of the file
                this.addRangeError(
                  new Range(new Loc(this.end), 0),
                  "Unterminated string literal",
                );
                throw new LexerPanic();

              case 0x0d: // '\r'
                if (quote !== 0x60) {
                  this.addRangeError(
                    new Range(new Loc(this.end), 0),
                    "Unterminated string literal",
                  );
                  throw new LexerPanic();
                }

                // Template literals require newline normalization
                needsSlowPath = true;
                break;

              case 0x0a: // '\n'
                if (quote !== 0x60) {
                  this.addRangeError(
                    new Range(new Loc(this.end), 0),
                    "Unterminated string literal",
                  );
                  throw new LexerPanic();
                }
                break;

              case 0x24: // '$'
                if (quote === 0x60) {
                  this.step();
                  if (this.codePoint === 0x7b /* '{' */) {
                    suffixLen = 2;
                    this.step();
                    if (this.rescanCloseBraceAsTemplateToken) {
                      this.Token = T.TTemplateMiddle;
                    } else {
                      this.Token = T.TTemplateHead;
                    }
                    break stringLiteral;
                  }
                  continue stringLiteral;
                }
                break;

              default:
                // Non-ASCII strings need the slow path
                if (this.codePoint >= 0x80) {
                  needsSlowPath = true;
                } else if (this.json === JSONFlavor.JSON && this.codePoint < 0x20) {
                  this.SyntaxError();
                }
            }
            this.step();
          }

          const text = this.source.Contents.subarray(this.start + 1, this.end - suffixLen);

          if (needsSlowPath) {
            // Slow path
            this.decodedStringLiteralOrNil = null;
            this.encodedStringLiteralStart = this.start + 1;
            this.encodedStringLiteralText = text;
          } else {
            // Fast path
            const n = text.length;
            const copy = new Uint16Array(n);
            for (let i = 0; i < n; i++) copy[i] = text[i];
            this.decodedStringLiteralOrNil = copy;
          }

          if (quote === 0x27 &&
            (this.json === JSONFlavor.JSON || this.json === JSONFlavor.TSConfigJSON)) {
            this.addRangeError(this.Range(), "JSON strings must use double quotes");
          }
          break;
        }

        // Note: This case is hot in profiles
        case 0x5f: // '_'
        case 0x24: // '$'
        case 0x61:
        case 0x62:
        case 0x63:
        case 0x64:
        case 0x65:
        case 0x66:
        case 0x67:
        case 0x68:
        case 0x69:
        case 0x6a:
        case 0x6b:
        case 0x6c:
        case 0x6d:
        case 0x6e:
        case 0x6f:
        case 0x70:
        case 0x71:
        case 0x72:
        case 0x73:
        case 0x74:
        case 0x75:
        case 0x76:
        case 0x77:
        case 0x78:
        case 0x79:
        case 0x7a:
        case 0x41:
        case 0x42:
        case 0x43:
        case 0x44:
        case 0x45:
        case 0x46:
        case 0x47:
        case 0x48:
        case 0x49:
        case 0x4a:
        case 0x4b:
        case 0x4c:
        case 0x4d:
        case 0x4e:
        case 0x4f:
        case 0x50:
        case 0x51:
        case 0x52:
        case 0x53:
        case 0x54:
        case 0x55:
        case 0x56:
        case 0x57:
        case 0x58:
        case 0x59:
        case 0x5a: {
          // This is a fast path for long ASCII identifiers. Doing this in a loop
          // first instead of doing "step()" and "js_ast.IsIdentifierContinue()" like we
          // do after this is noticeably faster in the common case of ASCII-only
          // text. For example, doing this sped up end-to-end consuming of a large
          // TypeScript type declaration file from 97ms to 79ms (around 20% faster).
          const contents = this.source.Contents;
          const n = contents.length;
          let i = this.current;
          while (i < n) {
            const c = contents[i];
            if (
              (c < 0x61 || c > 0x7a) && (c < 0x41 || c > 0x5a) &&
              (c < 0x30 || c > 0x39) && c !== 0x5f && c !== 0x24
            ) break;
            i++;
          }
          this.current = i;

          // Now do the slow path for any remaining non-ASCII identifier characters
          this.step();
          if (this.codePoint >= 0x80) {
            while (IsIdentifierContinue(this.codePoint)) this.step();
          }

          // If there's a slash, then we're in the extra-slow (and extra-rare) case
          // where the identifier has embedded escapes
          if (this.codePoint === 0x5c /* '\\' */) {
            const r = this.scanIdentifierWithEscapes(normalIdentifier);
            this.Identifier = r.maybe;
            this.Token = r.token;
            break;
          }

          // Otherwise (if there was no escape) we can slice the code verbatim
          this.Identifier = this.rawIdentifier();
          const keyword = Keywords.get(latin1(this.Raw()));
          this.Token = keyword === undefined ? T.TIdentifier : keyword;
          break;
        }

        case 0x5c: { // '\\'
          const r = this.scanIdentifierWithEscapes(normalIdentifier);
          this.Identifier = r.maybe;
          this.Token = r.token;
          break;
        }

        case 0x2e: // '.'
        case 0x30:
        case 0x31:
        case 0x32:
        case 0x33:
        case 0x34:
        case 0x35:
        case 0x36:
        case 0x37:
        case 0x38:
        case 0x39:
          this.parseNumericLiteralOrDot();
          break;

        default:
          // Check for unusual whitespace characters
          if (IsWhitespace(this.codePoint)) {
            this.step();
            continue;
          }

          if (IsIdentifierStart(this.codePoint)) {
            this.step();
            while (IsIdentifierContinue(this.codePoint)) this.step();
            if (this.codePoint === 0x5c /* '\\' */) {
              const r = this.scanIdentifierWithEscapes(normalIdentifier);
              this.Identifier = r.maybe;
              this.Token = r.token;
            } else {
              this.Token = T.TIdentifier;
              this.Identifier = this.rawIdentifier();
            }
            break;
          }

          this.end = this.current;
          this.Token = T.TSyntaxError;
      }

      return;
    }
  }

  /** Go: func (lexer *Lexer) ExpectJSXElementChild(token T) */
  ExpectJSXElementChild(token: T): void {
    if (this.Token !== token) {
      this.Expected(token);
    }
    this.NextJSXElementChild();
  }

  /** Go: func (lexer *Lexer) NextJSXElementChild() */
  NextJSXElementChild(): void {
    this.HasNewlineBefore = false;
    const originalStart = this.end;

    for (;;) {
      this.start = this.end;
      this.Token = 0;

      switch (this.codePoint) {
        case -1: // This indicates the end of the file
          this.Token = T.TEndOfFile;
          break;

        case 0x7b: // '{'
          this.step();
          this.Token = T.TOpenBrace;
          break;

        case 0x3c: // '<'
          this.step();
          this.Token = T.TLessThan;
          break;

        default: {
          let needsFixing = false;

          stringLiteral:
          for (;;) {
            switch (this.codePoint) {
              case -1:
              case 0x7b: // '{'
              case 0x3c: // '<'
                // Stop when the string ends
                break stringLiteral;

              case 0x26: // '&'
              case 0x0d: // '\r'
              case 0x0a: // '\n'
              case 0x2028:
              case 0x2029:
                // This needs fixing if it has an entity or if it's a multi-line string
                needsFixing = true;
                this.step();
                break;

              case 0x7d: // '}'
              case 0x3e: // '>'
                // These technically aren't valid JSX: https://facebook.github.io/jsx/
                //
                //   JSXTextCharacter :
                //     * SourceCharacter but not one of {, <, > or }
                {
                  let replacement: string;
                  if (this.codePoint === 0x7d) {
                    replacement = "{'}'}";
                  } else {
                    replacement = "{'>'}";
                  }
                  const msg = new Msg();
                  msg.Kind = MsgKind.Error;
                  msg.Data = this.tracker.MsgData(
                    new Range(new Loc(this.end), 1),
                    'The character "' + String.fromCodePoint(this.codePoint) +
                      '" is not valid inside a JSX element',
                  );

                  // Attempt to provide a better error message if this looks like an arrow function
                  if (
                    this.CouldBeBadArrowInTSX > 0 && this.codePoint === 0x3e &&
                    this.source.Contents[this.end - 1] === 0x3d
                  ) {
                    const note = this.tracker.MsgData(
                      this.BadArrowInTSXRange,
                      "TypeScript's TSX syntax interprets arrow functions with a single generic type parameter as an opening JSX element. " +
                        "If you want it to be interpreted as an arrow function instead, you need to add a trailing comma after the type parameter to disambiguate:",
                    );
                    note.Location!.Suggestion = this.BadArrowInTSXSuggestion;
                    msg.Notes = [note];
                  } else {
                    const note = new MsgData();
                    note.Text = "Did you mean to escape it as " + goQuoteString(replacement) + " instead?";
                    msg.Notes = [note];
                    msg.Data.Location!.Suggestion = replacement;
                    if (!this.ts.Parse) {
                      // TypeScript treats this as an error but Babel doesn't treat this
                      // as an error yet, so allow this in JS for now.
                      msg.Kind = MsgKind.Warning;
                    }
                  }

                  this.log.AddMsg(msg);
                  this.step();
                }
                break;

              default:
                // Non-ASCII strings need the slow path
                if (this.codePoint >= 0x80) {
                  needsFixing = true;
                }
                this.step();
            }
          }

          this.Token = T.TStringLiteral;
          const text = this.source.Contents.subarray(originalStart, this.end);

          if (needsFixing) {
            // Slow path
            this.decodedStringLiteralOrNil = fixWhitespaceAndDecodeJSXEntities(text);
          } else {
            // Fast path
            const copy = new Uint16Array(text.length);
            for (let i = 0; i < text.length; i++) copy[i] = text[i];
            this.decodedStringLiteralOrNil = copy;
          }
          break;
        }
      }

      break;
    }
  }

  /** Go: func (lexer *Lexer) ExpectInsideJSXElement(token T) */
  ExpectInsideJSXElement(token: T): void {
    if (this.Token !== token) {
      this.Expected(token);
    }
    this.NextInsideJSXElement();
  }

  /** Go: func (lexer *Lexer) NextInsideJSXElement() */
  NextInsideJSXElement(): void {
    this.HasNewlineBefore = false;

    for (;;) {
      this.start = this.end;
      this.Token = 0;

      switch (this.codePoint) {
        case -1: // This indicates the end of the file
          this.Token = T.TEndOfFile;
          break;

        case 0x0d: // '\r'
        case 0x0a: // '\n'
        case 0x2028:
        case 0x2029:
          this.step();
          this.HasNewlineBefore = true;
          continue;

        case 0x09: // '\t'
        case 0x20: // ' '
          this.step();
          continue;

        case 0x2e: // '.'
          this.step();
          this.Token = T.TDot;
          break;

        case 0x3a: // ':'
          this.step();
          this.Token = T.TColon;
          break;

        case 0x3d: // '='
          this.step();
          this.Token = T.TEquals;
          break;

        case 0x7b: // '{'
          this.step();
          this.Token = T.TOpenBrace;
          break;

        case 0x7d: // '}'
          this.step();
          this.Token = T.TCloseBrace;
          break;

        case 0x3c: // '<'
          this.step();
          this.Token = T.TLessThan;
          break;

        case 0x3e: // '>'
          this.step();
          this.Token = T.TGreaterThan;
          break;

        case 0x2f: // '/'
          // '/' or '//' or '/* ... */'
          this.step();
          switch (this.codePoint) {
            case 0x2f: // '/'
              singleLineComment:
              for (;;) {
                this.step();
                switch (this.codePoint) {
                  case 0x0d:
                  case 0x0a:
                  case 0x2028:
                  case 0x2029:
                    break singleLineComment;
                  case -1: // This indicates the end of the file
                    break singleLineComment;
                }
              }
              continue;

            case 0x2a: // '*'
              this.step();
              const startRange = this.Range();
              multiLineComment:
              for (;;) {
                switch (this.codePoint) {
                  case 0x2a: // '*'
                    this.step();
                    if (this.codePoint === 0x2f /* '/' */) {
                      this.step();
                      break multiLineComment;
                    }
                    break;

                  case 0x0d:
                  case 0x0a:
                  case 0x2028:
                  case 0x2029:
                    this.step();
                    this.HasNewlineBefore = true;
                    break;

                  case -1: // This indicates the end of the file
                    this.start = this.end;
                    this.AddRangeErrorWithNotes(
                      new Range(this.Loc(), 0),
                      'Expected "*/" to terminate multi-line comment',
                      [this.tracker.MsgData(startRange, "The multi-line comment starts here:")],
                    );
                    throw new LexerPanic();

                  default:
                    this.step();
                }
              }
              continue;

            default:
              this.Token = T.TSlash;
          }
          break;

        case 0x27: // '\''
        case 0x22: { // '"'
          let backslash = new Range();
          const quote = this.codePoint;
          let needsDecode = false;
          this.step();

          stringLiteral:
          for (;;) {
            switch (this.codePoint) {
              case -1: // This indicates the end of the file
                this.SyntaxError();
                break;

              case 0x26: // '&'
                needsDecode = true;
                this.step();
                break;

              case 0x5c: // '\\'
                backslash = new Range(new Loc(this.end), 1);
                this.step();
                continue;

              default:
                if (this.codePoint === quote) {
                  if (backslash.Len > 0) {
                    backslash.Len++;
                    this.PreviousBackslashQuoteInJSX = backslash;
                  }
                  this.step();
                  break stringLiteral;
                }

                // Non-ASCII strings need the slow path
                if (this.codePoint >= 0x80) {
                  needsDecode = true;
                }
                this.step();
            }
            backslash = new Range();
          }

          this.Token = T.TStringLiteral;
          const text = this.source.Contents.subarray(this.start + 1, this.end - 1);

          if (needsDecode) {
            // Slow path
            this.decodedStringLiteralOrNil = new Uint16Array(decodeJSXEntities([], text));
          } else {
            // Fast path
            const copy = new Uint16Array(text.length);
            for (let i = 0; i < text.length; i++) copy[i] = text[i];
            this.decodedStringLiteralOrNil = copy;
          }
          break;
        }

        default:
          // Check for unusual whitespace characters
          if (IsWhitespace(this.codePoint)) {
            this.step();
            continue;
          }

          if (IsIdentifierStart(this.codePoint)) {
            this.step();
            while (IsIdentifierContinue(this.codePoint) || this.codePoint === 0x2d /* '-' */) {
              this.step();
            }

            this.Identifier = this.rawIdentifier();
            this.Token = T.TIdentifier;
            break;
          }

          this.end = this.current;
          this.Token = T.TSyntaxError;
      }

      return;
    }
  }

  /** Go: func (lexer *Lexer) ScanRegExp() */
  ScanRegExp(): void {
    const validateAndStep = () => {
      if (this.codePoint === 0x5c /* '\\' */) {
        this.step();
      }

      switch (this.codePoint) {
        case -1: // This indicates the end of the file
        case 0x0d: // '\r'
        case 0x0a: // '\n'
        case 0x2028:
        case 0x2029: // Newlines aren't allowed in regular expressions
          this.addRangeError(new Range(new Loc(this.end), 0), "Unterminated regular expression");
          throw new LexerPanic();

        default:
          this.step();
      }
    };

    for (;;) {
      switch (this.codePoint) {
        case 0x2f: // '/'
          this.step();
          let bits = 0;
          while (IsIdentifierContinue(this.codePoint)) {
            switch (this.codePoint) {
              case 0x64: // 'd'
              case 0x67: // 'g'
              case 0x69: // 'i'
              case 0x6d: // 'm'
              case 0x73: // 's'
              case 0x75: // 'u'
              case 0x76: // 'v'
              case 0x79: { // 'y'
                const bit = 1 << (this.codePoint - 0x61 /* 'a' */);
                if ((bit & bits) !== 0) {
                  // Reject duplicate flags
                  let r1Start = this.start;
                  const r1 = new Range(new Loc(r1Start), 1);
                  const r2 = new Range(new Loc(this.end), 1);
                  while (r1Start < r2.Loc.Start && this.source.Contents[r1Start] !== (this.codePoint & 0xff)) {
                    r1Start++;
                  }
                  r1.Loc = new Loc(r1Start);
                  AddErrorWithNotes(
                    this.log,
                    this.tracker,
                    r2,
                    'Duplicate flag "' + String.fromCodePoint(this.codePoint) + '" in regular expression',
                    [
                      this.tracker.MsgData(
                        r1,
                        'The first "' + String.fromCodePoint(this.codePoint) + '" was here:',
                      ),
                    ],
                  );
                } else {
                  bits |= bit;
                }
                this.step();
                break;
              }

              default:
                this.SyntaxError();
            }
          }
          return;

        case 0x5b: // '['
          this.step();
          while (this.codePoint !== 0x5d /* ']' */) {
            validateAndStep();
          }
          this.step();
          break;

        default:
          validateAndStep();
      }
    }
  }

  /** Go: func (lexer *Lexer) RescanCloseBraceAsTemplateToken() */
  RescanCloseBraceAsTemplateToken(): void {
    if (this.Token !== T.TCloseBrace) {
      this.Expected(T.TCloseBrace);
    }

    this.rescanCloseBraceAsTemplateToken = true;
    this.codePoint = 0x60; // '`'
    this.current = this.end;
    this.end -= 1;
    this.Next();
    this.rescanCloseBraceAsTemplateToken = false;
  }

  /**
   * Go: func (lexer *Lexer) scanIdentifierWithEscapes(kind identifierKind) (MaybeSubstring, T)
   *
   * This is an edge case that doesn't really exist in the wild, so it doesn't
   * need to be as fast as possible.
   */
  scanIdentifierWithEscapes(kind: number): { maybe: MaybeSubstring; token: T } {
    // First pass: scan over the identifier to see how long it is
    for (;;) {
      // Scan a unicode escape sequence. There is at least one because that's
      // what caused us to get on this slow path in the first place.
      if (this.codePoint === 0x5c /* '\\' */) {
        this.step();
        if (this.codePoint !== 0x75 /* 'u' */) {
          this.SyntaxError();
        }
        this.step();
        if (this.codePoint === 0x7b /* '{' */) {
          // Variable-length
          this.step();
          while (this.codePoint !== 0x7d /* '}' */) {
            switch (this.codePoint) {
              case 0x30:
              case 0x31:
              case 0x32:
              case 0x33:
              case 0x34:
              case 0x35:
              case 0x36:
              case 0x37:
              case 0x38:
              case 0x39:
              case 0x61:
              case 0x62:
              case 0x63:
              case 0x64:
              case 0x65:
              case 0x66:
              case 0x41:
              case 0x42:
              case 0x43:
              case 0x44:
              case 0x45:
              case 0x46:
                this.step();
                break;
              default:
                this.SyntaxError();
            }
          }
          this.step();
        } else {
          // Fixed-length
          for (let j = 0; j < 4; j++) {
            switch (this.codePoint) {
              case 0x30:
              case 0x31:
              case 0x32:
              case 0x33:
              case 0x34:
              case 0x35:
              case 0x36:
              case 0x37:
              case 0x38:
              case 0x39:
              case 0x61:
              case 0x62:
              case 0x63:
              case 0x64:
              case 0x65:
              case 0x66:
              case 0x41:
              case 0x42:
              case 0x43:
              case 0x44:
              case 0x45:
              case 0x46:
                this.step();
                break;
              default:
                this.SyntaxError();
            }
          }
        }
        continue;
      }

      // Stop when we reach the end of the identifier
      if (!IsIdentifierContinue(this.codePoint)) break;
      this.step();
    }

    // Second pass: re-use our existing escape sequence parser
    const result = this.tryToDecodeEscapeSequences(this.start, this.Raw(), true /* reportErrors */);
    if (!result.ok) {
      this.end = result.end;
      this.SyntaxError();
    }
    const decoded = result.decoded!;
    const text = UTF16ToString(decoded);

    // Even though it was escaped, it must still be a valid identifier
    let identifier = text;
    if (kind === privateIdentifier) {
      identifier = identifier.subarray(1); // Skip over the "#"
    }
    if (!IsIdentifier(identifier)) {
      this.addRangeError(
        new Range(new Loc(this.start), this.end - this.start),
        "Invalid identifier: " + goQuote(text),
      );
    }

    // Escaped keywords are not allowed to work as actual keywords, but they are
    // allowed wherever we allow identifiers or keywords. For example:
    //
    //   // This is an error (equivalent to "var var;")
    //   var \u0076\u0061\u0072;
    //
    //   // This is an error (equivalent to "var foo;" except for this rule)
    //   \u0076\u0061\u0072 foo;
    //
    //   // This is a fine (equivalent to "foo.var;")
    //   foo.\u0076\u0061\u0072;
    //
    if (Keywords.has(latin1(text))) {
      return { maybe: new MaybeSubstring(text), token: T.TEscapedKeyword };
    }
    return { maybe: new MaybeSubstring(text), token: T.TIdentifier };
  }

  /** Go: func (lexer *Lexer) parseNumericLiteralOrDot() */
  parseNumericLiteralOrDot(): void {
    // Number or dot
    const first = this.codePoint;
    this.step();

    // Dot without a digit after it
    if (first === 0x2e && (this.codePoint < 0x30 || this.codePoint > 0x39)) {
      // "..."
      if (
        this.codePoint === 0x2e &&
        this.current < this.source.Contents.length &&
        this.source.Contents[this.current] === 0x2e
      ) {
        this.step();
        this.step();
        this.Token = T.TDotDotDot;
        return;
      }

      // "."
      this.Token = T.TDot;
      return;
    }

    let underscoreCount = 0;
    let lastUnderscoreEnd = 0;
    let hasDotOrExponent = first === 0x2e;
    let isMissingDigitAfterDot = false;
    let base = 0.0;
    this.IsLegacyOctalLiteral = false;

    // Assume this is a number, but potentially change to a bigint later
    this.Token = T.TNumericLiteral;

    // Check for binary, octal, or hexadecimal literal
    if (first === 0x30 /* '0' */) {
      switch (this.codePoint) {
        case 0x62:
        case 0x42: // 'b', 'B'
          base = 2;
          break;
        case 0x6f:
        case 0x4f: // 'o', 'O'
          base = 8;
          break;
        case 0x78:
        case 0x58: // 'x', 'X'
          base = 16;
          break;
        case 0x30:
        case 0x31:
        case 0x32:
        case 0x33:
        case 0x34:
        case 0x35:
        case 0x36:
        case 0x37:
        case 0x5f: // '0'..'7', '_'
          base = 8;
          this.IsLegacyOctalLiteral = true;
          break;
        case 0x38:
        case 0x39: // '8', '9'
          this.IsLegacyOctalLiteral = true;
          break;
      }
    }

    if (base !== 0) {
      // Integer literal
      let isFirst = true;
      let isInvalidLegacyOctalLiteral = false;
      this.Number = 0;
      if (!this.IsLegacyOctalLiteral) {
        this.step();
      }

      integerLiteral:
      for (;;) {
        switch (this.codePoint) {
          case 0x5f: // '_'
            // Cannot have multiple underscores in a row
            if (lastUnderscoreEnd > 0 && this.end === lastUnderscoreEnd + 1) {
              this.SyntaxError();
            }

            // The first digit must exist
            if (isFirst || this.IsLegacyOctalLiteral) {
              this.SyntaxError();
            }

            lastUnderscoreEnd = this.end;
            underscoreCount++;
            break;

          case 0x30:
          case 0x31: // '0', '1'
            this.Number = this.Number * base + (this.codePoint - 0x30);
            break;

          case 0x32:
          case 0x33:
          case 0x34:
          case 0x35:
          case 0x36:
          case 0x37: // '2'..'7'
            if (base === 2) {
              this.SyntaxError();
            }
            this.Number = this.Number * base + (this.codePoint - 0x30);
            break;

          case 0x38:
          case 0x39: // '8', '9'
            if (this.IsLegacyOctalLiteral) {
              isInvalidLegacyOctalLiteral = true;
            } else if (base < 10) {
              this.SyntaxError();
            }
            this.Number = this.Number * base + (this.codePoint - 0x30);
            break;

          case 0x41:
          case 0x42:
          case 0x43:
          case 0x44:
          case 0x45:
          case 0x46: // 'A'..'F'
            if (base !== 16) {
              this.SyntaxError();
            }
            this.Number = this.Number * base + (this.codePoint + 10 - 0x41);
            break;

          case 0x61:
          case 0x62:
          case 0x63:
          case 0x64:
          case 0x65:
          case 0x66: // 'a'..'f'
            if (base !== 16) {
              this.SyntaxError();
            }
            this.Number = this.Number * base + (this.codePoint + 10 - 0x61);
            break;

          default:
            // The first digit must exist
            if (isFirst) {
              this.SyntaxError();
            }
            break integerLiteral;
        }

        this.step();
        isFirst = false;
      }

      const isBigIntegerLiteral = this.codePoint === 0x6e && !hasDotOrExponent;

      // Slow path: do we need to re-scan the input as text?
      if (isBigIntegerLiteral || isInvalidLegacyOctalLiteral) {
        let text = this.rawIdentifier();

        // Can't use a leading zero for bigint literals
        if (isBigIntegerLiteral && this.IsLegacyOctalLiteral) {
          this.SyntaxError();
        }

        // Filter out underscores
        if (underscoreCount > 0) {
          const bytes = new Uint8Array(text.String.length - underscoreCount);
          let n = 0;
          for (let i = 0; i < text.String.length; i++) {
            const c = text.String[i];
            if (c !== 0x5f) bytes[n++] = c;
          }
          text = new MaybeSubstring(bytes);
        }

        // Store bigints as text to avoid precision loss
        if (isBigIntegerLiteral) {
          this.Identifier = text;
        } else if (isInvalidLegacyOctalLiteral) {
          // Legacy octal literals may turn out to be a base 10 literal after all
          this.Number = parseFloat(text.String);
        }
      }
    } else {
      // Floating-point literal
      const isInvalidLegacyOctalLiteral =
        first === 0x30 && (this.codePoint === 0x38 || this.codePoint === 0x39);

      // Initial digits
      for (;;) {
        if (this.codePoint < 0x30 || this.codePoint > 0x39) {
          if (this.codePoint !== 0x5f) break;

          // Cannot have multiple underscores in a row
          if (lastUnderscoreEnd > 0 && this.end === lastUnderscoreEnd + 1) {
            this.SyntaxError();
          }

          // The specification forbids underscores in this case
          if (isInvalidLegacyOctalLiteral) {
            this.SyntaxError();
          }

          lastUnderscoreEnd = this.end;
          underscoreCount++;
        }
        this.step();
      }

      // Fractional digits
      if (first !== 0x2e && this.codePoint === 0x2e) {
        // An underscore must not come last
        if (lastUnderscoreEnd > 0 && this.end === lastUnderscoreEnd + 1) {
          this.end--;
          this.SyntaxError();
        }

        hasDotOrExponent = true;
        this.step();
        if (this.codePoint === 0x5f) {
          this.SyntaxError();
        }
        isMissingDigitAfterDot = true;
        for (;;) {
          if (this.codePoint >= 0x30 && this.codePoint <= 0x39) {
            isMissingDigitAfterDot = false;
          } else {
            if (this.codePoint !== 0x5f) break;

            // Cannot have multiple underscores in a row
            if (lastUnderscoreEnd > 0 && this.end === lastUnderscoreEnd + 1) {
              this.SyntaxError();
            }

            lastUnderscoreEnd = this.end;
            underscoreCount++;
          }
          this.step();
        }
      }

      // Exponent
      if (this.codePoint === 0x65 || this.codePoint === 0x45) {
        // An underscore must not come last
        if (lastUnderscoreEnd > 0 && this.end === lastUnderscoreEnd + 1) {
          this.end--;
          this.SyntaxError();
        }

        hasDotOrExponent = true;
        this.step();
        if (this.codePoint === 0x2b || this.codePoint === 0x2d) {
          this.step();
        }
        if (this.codePoint < 0x30 || this.codePoint > 0x39) {
          this.SyntaxError();
        }
        for (;;) {
          if (this.codePoint < 0x30 || this.codePoint > 0x39) {
            if (this.codePoint !== 0x5f) break;

            // Cannot have multiple underscores in a row
            if (lastUnderscoreEnd > 0 && this.end === lastUnderscoreEnd + 1) {
              this.SyntaxError();
            }

            lastUnderscoreEnd = this.end;
            underscoreCount++;
          }
          this.step();
        }
      }

      // Take a slice of the text to parse
      let text = this.rawIdentifier();

      // Filter out underscores
      if (underscoreCount > 0) {
        const bytes = new Uint8Array(text.String.length - underscoreCount);
        let n = 0;
        for (let i = 0; i < text.String.length; i++) {
          const c = text.String[i];
          if (c !== 0x5f) bytes[n++] = c;
        }
        text = new MaybeSubstring(bytes);
      }

      if (this.codePoint === 0x6e && !hasDotOrExponent) {
        // The only bigint literal that can start with 0 is "0n"
        if (text.String.length > 1 && first === 0x30) {
          this.SyntaxError();
        }

        // Store bigints as text to avoid precision loss
        this.Identifier = text;
      } else if (!hasDotOrExponent && this.end - this.start < 10) {
        // Parse a 32-bit integer (very fast path)
        let number = 0;
        for (let i = 0; i < text.String.length; i++) {
          number = (number * 10 + (text.String[i] - 0x30)) >>> 0;
        }
        this.Number = number;
      } else {
        // Parse a double-precision floating-point number
        this.Number = parseFloat(text.String);
      }
    }

    // An underscore must not come last
    if (lastUnderscoreEnd > 0 && this.end === lastUnderscoreEnd + 1) {
      this.end--;
      this.SyntaxError();
    }

    // Handle bigint literals after the underscore-at-end check above
    if (this.codePoint === 0x6e && !hasDotOrExponent) {
      this.Token = T.TBigIntegerLiteral;
      this.step();
    }

    // Identifiers can't occur immediately after numbers
    if (IsIdentifierStart(this.codePoint)) {
      this.SyntaxError();
    }

    // None of these are allowed in JSON
    if (
      this.json === JSONFlavor.JSON &&
      (first === 0x2e || base !== 0 || underscoreCount > 0 || isMissingDigitAfterDot)
    ) {
      this.Unexpected();
    }
  }

  /**
   * Go: func (lexer *Lexer) tryToDecodeEscapeSequences(start int, text string, reportErrors bool) ([]uint16, bool, int)
   *
   * If this fails, this returns "decoded: null, ok: false, end" where "end" is the value to
   * store to "lexer.end" before calling "lexer.SyntaxError()" if relevant
   */
  tryToDecodeEscapeSequences(
    start: number,
    text: Uint8Array,
    reportErrors: boolean,
  ): { decoded: Uint16Array | null; ok: boolean; end: number } {
    const decoded: number[] = [];
    let i = 0;

    while (i < text.length) {
      let d = decodeRune(text, i);
      let c = d.r;
      const width = d.width;
      i += width;

      switch (c) {
        case 0x0d: // '\r'
          // From the specification:
          //
          // 11.8.6.1 Static Semantics: TV and TRV
          //
          // TV excludes the code units of LineContinuation while TRV includes
          // them. <CR><LF> and <CR> LineTerminatorSequences are normalized to
          // <LF> for both TV and TRV. An explicit EscapeSequence is needed to
          // include a <CR> or <CR><LF> sequence.

          // Convert '\r\n' into '\n'
          if (i < text.length && text[i] === 0x0a) i++;

          // Convert '\r' into '\n'
          decoded.push(0x0a);
          continue;

        case 0x5c: { // '\\'
          const d2 = decodeRune(text, i);
          const c2 = d2.r;
          const width2 = d2.width;
          i += width2;

          switch (c2) {
            case 0x62: // 'b'
              decoded.push(0x08);
              continue;

            case 0x66: // 'f'
              decoded.push(0x0c);
              continue;

            case 0x6e: // 'n'
              decoded.push(0x0a);
              continue;

            case 0x72: // 'r'
              decoded.push(0x0d);
              continue;

            case 0x74: // 't'
              decoded.push(0x09);
              continue;

            case 0x76: // 'v'
              if (this.json === JSONFlavor.JSON) {
                return { decoded: null, ok: false, end: start + i - width2 };
              }
              decoded.push(0x0b);
              continue;

            case 0x30:
            case 0x31:
            case 0x32:
            case 0x33:
            case 0x34:
            case 0x35:
            case 0x36:
            case 0x37: { // '0'..'7'
              const octalStart = i - 2;
              if (this.json === JSONFlavor.JSON) {
                return { decoded: null, ok: false, end: start + i - width2 };
              }

              // 1-3 digit octal
              let isBad = false;
              let value = c2 - 0x30;
              const d3 = decodeRune(text, i);
              const c3 = d3.r;
              const width3 = d3.width;
              switch (c3) {
                case 0x30:
                case 0x31:
                case 0x32:
                case 0x33:
                case 0x34:
                case 0x35:
                case 0x36:
                case 0x37: {
                  value = value * 8 + c3 - 0x30;
                  i += width3;
                  const d4 = decodeRune(text, i);
                  const c4 = d4.r;
                  const width4 = d4.width;
                  switch (c4) {
                    case 0x30:
                    case 0x31:
                    case 0x32:
                    case 0x33:
                    case 0x34:
                    case 0x35:
                    case 0x36:
                    case 0x37: {
                      const temp = value * 8 + c4 - 0x30;
                      if (temp < 256) {
                        value = temp;
                        i += width4;
                      }
                      break;
                    }
                    case 0x38:
                    case 0x39: // '8', '9'
                      isBad = true;
                      break;
                  }
                  break;
                }
                case 0x38:
                case 0x39: // '8', '9'
                  isBad = true;
                  break;
              }
              c = value;

              // Forbid the use of octal literals other than "\0"
              if (isBad || !bytesEqual(text, octalStart, i, STRING_BACKSLASH_ZERO)) {
                this.LegacyOctalLoc = new Loc(start + octalStart);
              }
              break;
            }

            case 0x38:
            case 0x39: // '8', '9'
              c = c2;

              // Forbid the invalid octal literals "\8" and "\9"
              this.LegacyOctalLoc = new Loc(start + i - 2);
              break;

            case 0x78: { // 'x'
              if (this.json === JSONFlavor.JSON) {
                return { decoded: null, ok: false, end: start + i - width2 };
              }

              // 2-digit hexadecimal
              let value = 0;
              for (let j = 0; j < 2; j++) {
                const d3 = decodeRune(text, i);
                const c3 = d3.r;
                const width3 = d3.width;
                i += width3;
                switch (c3) {
                  case 0x30:
                  case 0x31:
                  case 0x32:
                  case 0x33:
                  case 0x34:
                  case 0x35:
                  case 0x36:
                  case 0x37:
                  case 0x38:
                  case 0x39:
                    value = value * 16 | (c3 - 0x30);
                    break;
                  case 0x61:
                  case 0x62:
                  case 0x63:
                  case 0x64:
                  case 0x65:
                  case 0x66:
                    value = value * 16 | (c3 + 10 - 0x61);
                    break;
                  case 0x41:
                  case 0x42:
                  case 0x43:
                  case 0x44:
                  case 0x45:
                  case 0x46:
                    value = value * 16 | (c3 + 10 - 0x41);
                    break;
                  default:
                    return { decoded: null, ok: false, end: start + i - width3 };
                }
              }
              c = value;
              break;
            }

            case 0x75: { // 'u'
              // Unicode
              let value = 0;

              // Check the first character
              let d3 = decodeRune(text, i);
              let c3 = d3.r;
              let width3 = d3.width;
              i += width3;

              if (c3 === 0x7b /* '{' */) {
                if (this.json === JSONFlavor.JSON) {
                  return { decoded: null, ok: false, end: start + i - width2 };
                }

                // Variable-length
                const hexStart = i - width - width2 - width3;
                let isFirst = true;
                let isOutOfRange = false;
                variableLength:
                for (;;) {
                  d3 = decodeRune(text, i);
                  c3 = d3.r;
                  width3 = d3.width;
                  i += width3;

                  switch (c3) {
                    case 0x30:
                    case 0x31:
                    case 0x32:
                    case 0x33:
                    case 0x34:
                    case 0x35:
                    case 0x36:
                    case 0x37:
                    case 0x38:
                    case 0x39:
                      value = value * 16 | (c3 - 0x30);
                      break;
                    case 0x61:
                    case 0x62:
                    case 0x63:
                    case 0x64:
                    case 0x65:
                    case 0x66:
                      value = value * 16 | (c3 + 10 - 0x61);
                      break;
                    case 0x41:
                    case 0x42:
                    case 0x43:
                    case 0x44:
                    case 0x45:
                    case 0x46:
                      value = value * 16 | (c3 + 10 - 0x41);
                      break;
                    case 0x7d: // '}'
                      if (isFirst) {
                        return { decoded: null, ok: false, end: start + i - width3 };
                      }
                      break variableLength;
                    default:
                      return { decoded: null, ok: false, end: start + i - width3 };
                  }

                  if (value > 0x10ffff) { // utf8.MaxRune
                    isOutOfRange = true;
                  }

                  isFirst = false;
                }

                if (isOutOfRange && reportErrors) {
                  this.addRangeError(
                    new Range(new Loc(start + hexStart), i - hexStart),
                    "Unicode escape sequence is out of range",
                  );
                  throw new LexerPanic();
                }
              } else {
                // Fixed-length
                for (let j = 0; j < 4; j++) {
                  switch (c3) {
                    case 0x30:
                    case 0x31:
                    case 0x32:
                    case 0x33:
                    case 0x34:
                    case 0x35:
                    case 0x36:
                    case 0x37:
                    case 0x38:
                    case 0x39:
                      value = value * 16 | (c3 - 0x30);
                      break;
                    case 0x61:
                    case 0x62:
                    case 0x63:
                    case 0x64:
                    case 0x65:
                    case 0x66:
                      value = value * 16 | (c3 + 10 - 0x61);
                      break;
                    case 0x41:
                    case 0x42:
                    case 0x43:
                    case 0x44:
                    case 0x45:
                    case 0x46:
                      value = value * 16 | (c3 + 10 - 0x41);
                      break;
                    default:
                      return { decoded: null, ok: false, end: start + i - width3 };
                  }

                  if (j < 3) {
                    d3 = decodeRune(text, i);
                    c3 = d3.r;
                    width3 = d3.width;
                    i += width3;
                  }
                }
              }
              c = value;
              break;
            }

            case 0x0d: // '\r'
              if (this.json === JSONFlavor.JSON) {
                return { decoded: null, ok: false, end: start + i - width2 };
              }

              // Ignore line continuations. A line continuation is not an escaped newline.
              if (i < text.length && text[i] === 0x0a) {
                // Make sure Windows CRLF counts as a single newline
                i++;
              }
              continue;

            case 0x0a: // '\n'
            case 0x2028:
            case 0x2029:
              if (this.json === JSONFlavor.JSON) {
                return { decoded: null, ok: false, end: start + i - width2 };
              }

              // Ignore line continuations. A line continuation is not an escaped newline.
              continue;

            default:
              if (this.json === JSONFlavor.JSON) {
                switch (c2) {
                  case 0x22:
                  case 0x5c:
                  case 0x2f: // '"', '\\', '/'
                    break;
                  default:
                    return { decoded: null, ok: false, end: start + i - width2 };
                }
              }

              c = c2;
          }
          break;
        }
      }

      if (c <= 0xffff) {
        decoded.push(c);
      } else {
        c -= 0x10000;
        decoded.push(0xd800 + ((c >> 10) & 0x3ff), 0xdc00 + (c & 0x3ff));
      }
    }

    return { decoded: Uint16Array.from(decoded), ok: true, end: 0 };
  }

  /** Go: func (lexer *Lexer) step() */
  step(): void {
    const { r, width } = decodeRune(this.source.Contents, this.current);
    let codePoint = r;

    // Use -1 to indicate the end of the file
    if (width === 0) {
      codePoint = -1;
    }

    // Track the approximate number of newlines in the file so we can preallocate
    // the line offset table in the printer for source maps. The line offset table
    // is the #1 highest allocation in the heap profile, so this is worth doing.
    // This count is approximate because it handles "\n" and "\r\n" (the common
    // cases) but not "\r" or "\u2028" or "\u2029". Getting this wrong is harmless
    // because it's only a preallocation. The array will just grow if it's too small.
    if (codePoint === 0x0a) {
      this.ApproximateNewlineCount++;
    }

    this.codePoint = codePoint;
    this.end = this.current;
    this.current += width;
  }

  /** Go: func (lexer *Lexer) addRangeError(r logger.Range, text string) */
  addRangeError(r: Range, text: string): void {
    // Don't report multiple errors in the same spot
    if (r.Loc.Start === this.prevErrorLoc.Start) return;
    this.prevErrorLoc = new Loc(r.Loc.Start);

    if (!this.IsLogDisabled) {
      AddError(this.log, this.tracker, r, text);
    }
  }

  /** Go: func (lexer *Lexer) addRangeErrorWithSuggestion(r logger.Range, text string, suggestion string) */
  addRangeErrorWithSuggestion(r: Range, text: string, suggestion: string): void {
    // Don't report multiple errors in the same spot
    if (r.Loc.Start === this.prevErrorLoc.Start) return;
    this.prevErrorLoc = new Loc(r.Loc.Start);

    if (!this.IsLogDisabled) {
      const data = this.tracker.MsgData(r, text);
      data.Location!.Suggestion = suggestion;
      const msg = new Msg();
      msg.Kind = MsgKind.Error;
      msg.Data = data;
      this.log.AddMsg(msg);
    }
  }

  /** Go: func (lexer *Lexer) AddRangeErrorWithNotes(r logger.Range, text string, notes []logger.MsgData) */
  AddRangeErrorWithNotes(r: Range, text: string, notes: MsgData[]): void {
    // Don't report multiple errors in the same spot
    if (r.Loc.Start === this.prevErrorLoc.Start) return;
    this.prevErrorLoc = new Loc(r.Loc.Start);

    if (!this.IsLogDisabled) {
      AddErrorWithNotes(this.log, this.tracker, r, text, notes);
    }
  }

  /** Go: func (lexer *Lexer) scanCommentText() */
  scanCommentText(): void {
    const text = this.source.Contents.subarray(this.start, this.end);
    let hasLegalAnnotation = text.length > 2 && text[2] === 0x21 /* '!' */;
    const isMultiLineComment = text[1] === 0x2a /* '*' */;
    let omitFromGeneralCommentPreservation = false;

    // Save the original comment text so we can subtract comments from the
    // character frequency analysis used by symbol minification
    this.AllComments.push(this.Range());

    // Omit the trailing "*/" from the checks below
    let endOfCommentText = text.length;
    if (isMultiLineComment) {
      endOfCommentText -= 2;
    }

    for (let i = 0, n = text.length; i < n; i++) {
      switch (text[i]) {
        case 0x23: { // '#'
          const rest = text.subarray(i + 1, endOfCommentText);
          if (hasPrefixWithWordBoundary(rest, "__PURE__")) {
            omitFromGeneralCommentPreservation = true;
            this.HasCommentBefore |= CommentBefore.PureCommentBefore;
          } else if (hasPrefixWithWordBoundary(rest, "__KEY__")) {
            omitFromGeneralCommentPreservation = true;
            this.HasCommentBefore |= CommentBefore.KeyCommentBefore;
          } else if (hasPrefixWithWordBoundary(rest, "__NO_SIDE_EFFECTS__")) {
            omitFromGeneralCommentPreservation = true;
            this.HasCommentBefore |= CommentBefore.NoSideEffectsCommentBefore;
          } else if (i === 2 && hasPrefixBytes(rest, PREFIX_SOURCE_MAPPING_URL)) {
            const arg = scanForPragmaArg(
              pragmaNoSpaceFirst,
              this.start + i + 1,
              " sourceMappingURL=",
              rest,
            );
            if (arg.ok) {
              omitFromGeneralCommentPreservation = true;
              this.SourceMappingURL = arg.span!;
            }
          }
          break;
        }

        case 0x40: { // '@'
          const rest = text.subarray(i + 1, endOfCommentText);
          if (hasPrefixWithWordBoundary(rest, "__PURE__")) {
            omitFromGeneralCommentPreservation = true;
            this.HasCommentBefore |= CommentBefore.PureCommentBefore;
          } else if (hasPrefixWithWordBoundary(rest, "__KEY__")) {
            omitFromGeneralCommentPreservation = true;
            this.HasCommentBefore |= CommentBefore.KeyCommentBefore;
          } else if (hasPrefixWithWordBoundary(rest, "__NO_SIDE_EFFECTS__")) {
            omitFromGeneralCommentPreservation = true;
            this.HasCommentBefore |= CommentBefore.NoSideEffectsCommentBefore;
          } else if (
            hasPrefixWithWordBoundary(rest, "preserve") ||
            hasPrefixWithWordBoundary(rest, "license")
          ) {
            hasLegalAnnotation = true;
          } else if (hasPrefixWithWordBoundary(rest, "jsx")) {
            const arg = scanForPragmaArg(pragmaSkipSpaceFirst, this.start + i + 1, "jsx", rest);
            if (arg.ok) {
              this.JSXFactoryPragmaComment = arg.span!;
            }
          } else if (hasPrefixWithWordBoundary(rest, "jsxFrag")) {
            const arg = scanForPragmaArg(pragmaSkipSpaceFirst, this.start + i + 1, "jsxFrag", rest);
            if (arg.ok) {
              this.JSXFragmentPragmaComment = arg.span!;
            }
          } else if (hasPrefixWithWordBoundary(rest, "jsxRuntime")) {
            const arg = scanForPragmaArg(pragmaSkipSpaceFirst, this.start + i + 1, "jsxRuntime", rest);
            if (arg.ok) {
              this.JSXRuntimePragmaComment = arg.span!;
            }
          } else if (hasPrefixWithWordBoundary(rest, "jsxImportSource")) {
            const arg = scanForPragmaArg(
              pragmaSkipSpaceFirst,
              this.start + i + 1,
              "jsxImportSource",
              rest,
            );
            if (arg.ok) {
              this.JSXImportSourcePragmaComment = arg.span!;
            }
          } else if (i === 2 && hasPrefixBytes(rest, PREFIX_SOURCE_MAPPING_URL)) {
            const arg = scanForPragmaArg(
              pragmaNoSpaceFirst,
              this.start + i + 1,
              " sourceMappingURL=",
              rest,
            );
            if (arg.ok) {
              omitFromGeneralCommentPreservation = true;
              this.SourceMappingURL = arg.span!;
            }
          }
          break;
        }
      }
    }

    if (hasLegalAnnotation) {
      this.LegalCommentsBeforeToken.push(this.Range());
    }

    if (!omitFromGeneralCommentPreservation) {
      this.CommentsBeforeToken.push(this.Range());
    }
  }
}

const STRING_BACKSLASH_ZERO = new Uint8Array([0x5c, 0x30]);
const PREFIX_SOURCE_MAPPING_URL = encoder.encode(" sourceMappingURL=");

/** 比较 text[a:b] 是否与 bytes 相等（Go: text[a:b] == "\\0"） */
function bytesEqual(text: Uint8Array, a: number, b: number, bytes: Uint8Array): boolean {
  if (b - a !== bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (text[a + i] !== bytes[i]) return false;
  return true;
}

/** Go: func hasPrefixWithWordBoundary(text string, prefix string) bool */
export function hasPrefixWithWordBoundary(text: Uint8Array, prefix: string): boolean {
  const pb = encoder.encode(prefix);
  const t = text.length;
  const p = pb.length;
  if (t >= p && hasPrefixBytes(text, pb)) {
    if (t === p) return true;
    const { r: c } = decodeRune(text, p);
    if (!IsIdentifierContinue(c)) return true;
  }
  return false;
}

/**
 * Go: func scanForPragmaArg(kind pragmaArg, start int, pragma string, text string) (logger.Span, bool)
 *
 * DEVIATION：TS 版返回 `{ span: Span | null; ok: boolean }`（Go 用零值 + bool）。
 */
export function scanForPragmaArg(
  kind: number,
  start: number,
  pragma: string,
  textIn: Uint8Array,
): { span: Span | null; ok: boolean } {
  const pb = encoder.encode(pragma);
  let base = pb.length;
  start += pb.length;

  if (base >= textIn.length) {
    return { span: null, ok: false };
  }

  let d = decodeRune(textIn, base);
  let c = d.r;
  let width = d.width;
  if (kind === pragmaSkipSpaceFirst) {
    if (!IsWhitespace(c)) return { span: null, ok: false };
    while (IsWhitespace(c)) {
      base += width;
      start += width;
      if (base >= textIn.length) return { span: null, ok: false };
      d = decodeRune(textIn, base);
      c = d.r;
      width = d.width;
    }
  }

  // One or more non-whitespace characters
  let i = 0;
  while (!IsWhitespace(c)) {
    i += width;
    if (i >= textIn.length - base) break;
    d = decodeRune(textIn, base + i);
    c = d.r;
    width = d.width;
    if (IsWhitespace(c)) break;
  }

  const span = new Span();
  span.Text = textIn.subarray(base, base + i);
  span.Range = new Range(new Loc(start), i);
  return { span, ok: true };
}

/** Go: func isUpperASCII(c byte) bool */
export function isUpperASCII(c: number): boolean {
  return c >= 0x41 && c <= 0x5a;
}

/** Go: func isLetterASCII(c byte) bool */
export function isLetterASCII(c: number): boolean {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a);
}

// ---------------------------------------------------------------------------
// 包级函数（Go 侧不在 Lexer 上）
// ---------------------------------------------------------------------------

/** 字节切片与 ASCII 字符串逐字节相等（Go: Raw() == text） */
function rawEqualsString(bytes: Uint8Array, text: string): boolean {
  if (bytes.length !== text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** Go: fmt.Sprintf("%q", text)（text 是 TS string，转成 UTF-8 字节后走 goQuote） */
function goQuoteString(text: string): string {
  return goQuote(encoder.encode(text));
}

/** Go: type KeyOrValue uint8 */
export type KeyOrValue = number;
export const KeyOrValue = {
  KeyRange: 0,
  ValueRange: 1,
  KeyAndValueRange: 2,
} as const;

/** Go: func RangeOfIdentifier(source logger.Source, loc logger.Loc) logger.Range */
export function RangeOfIdentifier(source: Source, loc: Loc): Range {
  const text = source.Contents;
  const base = loc.Start;
  if (base >= text.length) {
    return new Range(new Loc(loc.Start), 0);
  }

  let i = base;
  let d = decodeRune(text, i);
  let c = d.r;

  // Handle private names
  if (c === 0x23 /* '#' */) {
    i += 1;
    d = decodeRune(text, i);
    c = d.r;
  }

  if (IsIdentifierStart(c) || c === 0x5c /* '\\' */) {
    // Search for the end of the identifier
    while (i < text.length) {
      const d2 = decodeRune(text, i);
      const c2 = d2.r;
      const width2 = d2.width;
      if (c2 === 0x5c /* '\\' */) {
        i += width2;

        // Skip over bracketed unicode escapes such as "\u{10000}"
        if (i + 2 < text.length && text[i] === 0x75 /* 'u' */ && text[i + 1] === 0x7b /* '{' */) {
          i += 2;
          while (i < text.length) {
            if (text[i] === 0x7d /* '}' */) {
              i++;
              break;
            }
            i++;
          }
        }
      } else if (!IsIdentifierContinue(c2)) {
        return new Range(new Loc(loc.Start), i - base);
      } else {
        i += width2;
      }
    }
  }

  // When minifying, this identifier may have originally been a string
  return source.RangeOfString(loc);
}

/** Go: func RangeOfImportAssertOrWith(source logger.Source, assertOrWith ast.AssertOrWithEntry, which KeyOrValue) logger.Range */
export function RangeOfImportAssertOrWith(
  source: Source,
  assertOrWith: AssertOrWithEntry,
  which: KeyOrValue,
): Range {
  if (which === KeyOrValue.KeyRange) {
    return RangeOfIdentifier(source, assertOrWith.KeyLoc);
  }
  if (which === KeyOrValue.ValueRange) {
    return source.RangeOfString(assertOrWith.ValueLoc);
  }
  const loc = RangeOfIdentifier(source, assertOrWith.KeyLoc).Loc;
  return new Range(loc, source.RangeOfString(assertOrWith.ValueLoc).End() - loc.Start);
}

/**
 * Go: strconv.ParseInt(s, base, 32)（只用于 JSX 实体里的十进制/十六进制数字）
 *
 * 返回 null 表示 Go 侧会拿到 err != nil：空串、非法字符、超出 int32 范围。
 */
function parseInt32(s: string, base: number): number | null {
  let i = 0;
  let negative = false;
  if (i < s.length && (s[i] === "+" || s[i] === "-")) {
    negative = s[i] === "-";
    i++;
  }
  if (i === s.length) return null;
  let value = 0;
  for (; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    let digit: number;
    if (ch >= 0x30 && ch <= 0x39) digit = ch - 0x30;
    else if (base === 16 && ch >= 0x61 && ch <= 0x66) digit = ch - 0x61 + 10;
    else if (base === 16 && ch >= 0x41 && ch <= 0x46) digit = ch - 0x41 + 10;
    else return null;
    value = value * base + digit;
    if (value > 0x80000000) return null;
  }
  if (negative) value = -value;
  if (value > 0x7fffffff || value < -0x80000000) return null;
  return value;
}

function latin1FromBytes(bytes: Uint8Array): string {
  return latin1(bytes);
}

/** Go: func decodeJSXEntities(decoded []uint16, text string) []uint16 */
export function decodeJSXEntities(decoded: number[], text: Uint8Array): number[] {
  let i = 0;

  while (i < text.length) {
    const d = decodeRune(text, i);
    let c = d.r;
    const width = d.width;
    i += width;

    if (c === 0x26 /* '&' */) {
      const length = text.subarray(i).indexOf(0x3b);
      if (length > 0) {
        const entity = latin1FromBytes(text.subarray(i, i + length));
        if (entity.charCodeAt(0) === 0x23 /* '#' */) {
          let number = entity.slice(1);
          let base = 10;
          if (number.length > 1 && number[0] === "x") {
            number = number.slice(1);
            base = 16;
          }
          const value = parseInt32(number, base);
          if (value !== null) {
            c = value;
            i += length + 1;
          }
        } else {
          const value = jsxEntity.get(entity);
          if (value !== undefined) {
            c = value;
            i += length + 1;
          }
        }
      }
    }

    if (c <= 0xffff) {
      decoded.push(c & 0xffff);
    } else {
      c -= 0x10000;
      decoded.push(0xd800 + ((c >> 10) & 0x3ff), 0xdc00 + (c & 0x3ff));
    }
  }

  return decoded;
}

/** Go: func fixWhitespaceAndDecodeJSXEntities(text string) []uint16 */
export function fixWhitespaceAndDecodeJSXEntities(text: Uint8Array): Uint16Array {
  let afterLastNonWhitespace = -1;
  let decoded: number[] = [];
  let i = 0;

  // Trim whitespace off the end of the first line
  let firstNonWhitespace = 0;

  // Split into lines
  while (i < text.length) {
    const d = decodeRune(text, i);
    const c = d.r;
    const width = d.width;

    switch (c) {
      case 0x0d: // '\r'
      case 0x0a: // '\n'
      case 0x2028:
      case 0x2029:
        // Newline
        if (firstNonWhitespace !== -1 && afterLastNonWhitespace !== -1) {
          if (decoded.length > 0) {
            decoded.push(0x20 /* ' ' */);
          }

          // Trim whitespace off the start and end of lines in the middle
          decoded = decodeJSXEntities(
            decoded,
            text.subarray(firstNonWhitespace, afterLastNonWhitespace),
          );
        }

        // Reset for the next line
        firstNonWhitespace = -1;
        break;

      case 0x09: // '\t'
      case 0x20: // ' '
        // Whitespace
        break;

      default:
        // Check for unusual whitespace characters
        if (!IsWhitespace(c)) {
          afterLastNonWhitespace = i + width;
          if (firstNonWhitespace === -1) {
            firstNonWhitespace = i;
          }
        }
    }

    i += width;
  }

  if (firstNonWhitespace !== -1) {
    if (decoded.length > 0) {
      decoded.push(0x20 /* ' ' */);
    }

    // Trim whitespace off the start of the last line
    decoded = decodeJSXEntities(decoded, text.subarray(firstNonWhitespace));
  }

  return new Uint16Array(decoded);
}

