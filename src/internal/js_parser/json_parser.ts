// 1:1 移植自 esbuild internal/js_parser/json_parser.go（v0.28.2，commit f6058f83）
//
// 作用：JSON 子集解析器。Go 侧两个入口：
//   1. `ParseDefineExpr`（js_parser.ts）—— define 文本 / `@jsx` `@jsxFrag` pragma 的 JSON 值；
//   2. `ParseJSON`（TS 侧 `testdata` 里的 JSON 配置解析在 M2/M3 才接）。
//
// 口径与 Go 一致：
//   - JSONFlavor 的零值就是 `JSON`（Go: `JSON JSONFlavor = iota`），所以
//     `JSONOptions{IsForDefine: true}` 走的是**严格 JSON** lexer（单引号/注释报错）；
//   - 解析失败用 `LexerPanic` 传播，`ParseJSON` 接住并返回 ok=false（Go 用 recover）；
//   - 诊断文案（含 `%q` 的引号形态）逐字对齐 Go 的 `fmt.Sprintf`。

import {
  AddError,
  AddIDWithNotes,
  MakeLineColumnTracker,
  MsgKind,
  Range,
  Log,
  type LineColumnTracker,
  type Source,
} from "../logger/logger.ts";
import { MsgID_JS_DuplicateObjectKey } from "../logger/msg_ids.ts";
import { UTF16EqualsString, UTF16ToString } from "../helpers/utf.ts";
import { IsInsideNodeModules } from "../helpers/path.ts";
import { Has as HasFeature, JSFeature } from "../compat/compat.ts";
import { init } from "../helpers/init.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import { JSONFlavor, Lexer, LexerPanic } from "../js_lexer/js_lexer.ts";
import { T } from "../js_lexer/tables.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Go: js_lexer.Identifier 是 string；TS 的 MaybeSubstring 用字节承载 */
function bytesToString(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/**
 * Go: fmt.Sprintf("%q", s)（strconv.Quote）
 *
 * 只用于诊断文案（重复 key 警告）。规则与 Go 一致：
 *   - `"` 与 `\` 加反斜杠；
 *   - `\a \b \f \n \r \t \v` 用短转义；
 *   - 其余 < 0x20 或 0x7f 用 `\xNN`；
 *   - Go 的 unicode.IsPrint（L/M/N/P/S + ASCII 空格）原样输出，
 *     否则 < 0x10000 用 `\uNNNN`、否则 `\UNNNNNNNN`。
 */
function goQuoted(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    switch (cp) {
      case 0x22: out += '\\"'; continue;
      case 0x5c: out += "\\\\"; continue;
      case 0x07: out += "\\a"; continue;
      case 0x08: out += "\\b"; continue;
      case 0x0c: out += "\\f"; continue;
      case 0x0a: out += "\\n"; continue;
      case 0x0d: out += "\\r"; continue;
      case 0x09: out += "\\t"; continue;
      case 0x0b: out += "\\v"; continue;
    }
    if (cp < 0x20 || cp === 0x7f) {
      out += "\\x" + cp.toString(16).padStart(2, "0");
    } else if (cp < 0x80) {
      out += ch;
    } else if (/^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u.test(ch)) {
      out += ch;
    } else if (cp < 0x10000) {
      out += "\\u" + cp.toString(16).padStart(4, "0");
    } else {
      out += "\\U" + cp.toString(16).padStart(8, "0");
    }
  }
  return out + '"';
}

/** Go: type jsonParser struct (json_parser.go:13) */
class jsonParser {
  log: Log;
  source: Source;
  tracker: LineColumnTracker;
  lexer: Lexer;
  options: JSONOptions;
  suppressWarningsAboutWeirdCode: boolean;

  constructor(
    log: Log,
    source: Source,
    tracker: LineColumnTracker,
    lexer: Lexer,
    options: JSONOptions,
    suppressWarningsAboutWeirdCode: boolean,
  ) {
    this.log = log;
    this.source = source;
    this.tracker = tracker;
    this.lexer = lexer;
    this.options = options;
    this.suppressWarningsAboutWeirdCode = suppressWarningsAboutWeirdCode;
  }

  /**
   * TS 会对 `this.lexer.Token` 做过窄的控制流推断（Go 的 Token 是可变字段）；
   * 与 js_parser.ts 的 `tokenIs` 同一理由。
   */
  private tokenIs(t: T): boolean {
    return this.lexer.Token === t;
  }

  /** Go: func (p *jsonParser) parseMaybeTrailingComma(closeToken js_lexer.T) bool (json_parser.go:22) */
  parseMaybeTrailingComma(closeToken: T): boolean {
    const commaRange = this.lexer.Range();
    this.lexer.Expect(T.TComma);

    if (this.tokenIs(closeToken)) {
      if (this.options.Flavor === JSONFlavor.JSON) {
        AddError(this.log, this.tracker, commaRange, "JSON does not support trailing commas");
      }
      return false;
    }

    return true;
  }

  /** Go: func (p *jsonParser) parseExpr() js_ast.Expr (json_parser.go:36) */
  parseExpr(): js_ast.Expr {
    const loc = this.lexer.Loc();

    switch (this.lexer.Token) {
      case T.TFalse:
        this.lexer.Next();
        return new js_ast.Expr(init(new js_ast.EBoolean(), { Value: false }), loc);

      case T.TTrue:
        this.lexer.Next();
        return new js_ast.Expr(init(new js_ast.EBoolean(), { Value: true }), loc);

      case T.TNull:
        this.lexer.Next();
        return new js_ast.Expr(js_ast.ENullShared, loc);

      case T.TStringLiteral: {
        const value = this.lexer.StringLiteral();
        this.lexer.Next();
        return new js_ast.Expr(init(new js_ast.EString(), { Value: value }), loc);
      }

      case T.TNumericLiteral: {
        const value = this.lexer.Number;
        this.lexer.Next();
        return new js_ast.Expr(init(new js_ast.ENumber(), { Value: value }), loc);
      }

      case T.TMinus: {
        this.lexer.Next();
        const value = this.lexer.Number;
        this.lexer.Expect(T.TNumericLiteral);
        return new js_ast.Expr(init(new js_ast.ENumber(), { Value: -value }), loc);
      }

      case T.TOpenBracket: {
        this.lexer.Next();
        let isSingleLine = !this.lexer.HasNewlineBefore;
        const items: js_ast.Expr[] = [];

        while (!this.tokenIs(T.TCloseBracket)) {
          if (items.length > 0) {
            if (this.lexer.HasNewlineBefore) {
              isSingleLine = false;
            }
            if (!this.parseMaybeTrailingComma(T.TCloseBracket)) {
              break;
            }
            if (this.lexer.HasNewlineBefore) {
              isSingleLine = false;
            }
          }

          const item = this.parseExpr();
          items.push(item);
        }

        if (this.lexer.HasNewlineBefore) {
          isSingleLine = false;
        }
        const closeBracketLoc = this.lexer.Loc();
        this.lexer.Expect(T.TCloseBracket);
        return new js_ast.Expr(init(new js_ast.EArray(), {
          Items: items,
          IsSingleLine: isSingleLine,
          CloseBracketLoc: closeBracketLoc,
        }), loc);
      }

      case T.TOpenBrace: {
        this.lexer.Next();
        let isSingleLine = !this.lexer.HasNewlineBefore;
        const properties: js_ast.Property[] = [];
        const duplicates = new Map<string, Range>();

        while (!this.tokenIs(T.TCloseBrace)) {
          if (properties.length > 0) {
            if (this.lexer.HasNewlineBefore) {
              isSingleLine = false;
            }
            if (!this.parseMaybeTrailingComma(T.TCloseBrace)) {
              break;
            }
            if (this.lexer.HasNewlineBefore) {
              isSingleLine = false;
            }
          }

          const keyString = this.lexer.StringLiteral();
          const keyRange = this.lexer.Range();
          const key = new js_ast.Expr(init(new js_ast.EString(), { Value: keyString }), keyRange.Loc);
          this.lexer.Expect(T.TStringLiteral);

          // Warn about duplicate keys
          if (!this.suppressWarningsAboutWeirdCode) {
            const keyText = bytesToString(UTF16ToString(keyString));
            const prevRange = duplicates.get(keyText);
            if (prevRange !== undefined) {
              AddIDWithNotes(
                this.log,
                MsgID_JS_DuplicateObjectKey,
                MsgKind.Warning,
                this.tracker,
                keyRange,
                `Duplicate key ${goQuoted(keyText)} in object literal`,
                [this.tracker.MsgData(prevRange, `The original key ${goQuoted(keyText)} is here:`)],
              );
            } else {
              duplicates.set(keyText, keyRange);
            }
          }

          this.lexer.Expect(T.TColon);
          const value = this.parseExpr();

          const property = init(new js_ast.Property(), {
            Kind: js_ast.PropertyKind.PropertyField,
            Loc: keyRange.Loc,
            Key: key,
            ValueOrNil: value,
          });

          // The key "__proto__" must not be a string literal in JavaScript because
          // that actually modifies the prototype of the object. This can be
          // avoided by using a computed property key instead of a string literal.
          if (
            UTF16EqualsString(keyString, encoder.encode("__proto__")) &&
            !HasFeature(this.options.UnsupportedJSFeatures, JSFeature.ObjectExtensions)
          ) {
            property.Flags |= js_ast.PropertyFlags.PropertyIsComputed;
          }

          properties.push(property);
        }

        if (this.lexer.HasNewlineBefore) {
          isSingleLine = false;
        }
        const closeBraceLoc = this.lexer.Loc();
        this.lexer.Expect(T.TCloseBrace);
        return new js_ast.Expr(init(new js_ast.EObject(), {
          Properties: properties,
          IsSingleLine: isSingleLine,
          CloseBraceLoc: closeBraceLoc,
        }), loc);
      }

      case T.TBigIntegerLiteral: {
        if (!this.options.IsForDefine) {
          this.lexer.Unexpected();
        }
        const value = bytesToString(this.lexer.Identifier.String);
        this.lexer.Next();
        return new js_ast.Expr(init(new js_ast.EBigInt(), { Value: value }), loc);
      }

      default:
        this.lexer.Unexpected();
        return new js_ast.Expr();
    }
  }
}

/** Go: type JSONOptions struct (json_parser.go:182) */
export class JSONOptions {
  UnsupportedJSFeatures: JSFeature = 0n;
  /** Go 的零值是 `JSON`（iota 第一项），不是 `NotJSON` */
  Flavor: JSONFlavor = JSONFlavor.JSON;
  ErrorSuffix = "";
  IsForDefine = false;
}

/**
 * Go: func ParseJSON(log logger.Log, source logger.Source, options JSONOptions) (result js_ast.Expr, ok bool)
 * (json_parser.go:189)
 */
export function ParseJSON(
  log: Log,
  source: Source,
  options: JSONOptions,
): { expr: js_ast.Expr; ok: boolean } {
  let ok = true;
  let result = new js_ast.Expr();

  try {
    if (options.ErrorSuffix === "") {
      options.ErrorSuffix = " in JSON";
    }

    const p = new jsonParser(
      log,
      source,
      MakeLineColumnTracker(source),
      Lexer.NewLexerJSON(log, source, options.Flavor, options.ErrorSuffix),
      options,
      IsInsideNodeModules(source.KeyPath.Text),
    );

    result = p.parseExpr();
    p.lexer.Expect(T.TEndOfFile);
  } catch (e) {
    if (e instanceof LexerPanic) {
      ok = false;
    } else {
      throw e;
    }
  }

  return { expr: result, ok };
}

/** Go: func isValidJSON(value js_ast.Expr) bool (json_parser.go:218) */
export function isValidJSON(value: js_ast.Expr): boolean {
  const data = value.Data;
  if (
    data instanceof js_ast.ENull || data instanceof js_ast.EBoolean ||
    data instanceof js_ast.EString || data instanceof js_ast.ENumber
  ) {
    return true;
  }

  if (data instanceof js_ast.EArray) {
    for (const item of data.Items) {
      if (!isValidJSON(item)) return false;
    }
    return true;
  }

  if (data instanceof js_ast.EObject) {
    for (const property of data.Properties) {
      if (
        property.Kind !== js_ast.PropertyKind.PropertyField ||
        js_ast.Has(property.Flags, js_ast.PropertyFlags.PropertyIsComputed)
      ) {
        return false;
      }
      if (!(property.Key.Data instanceof js_ast.EString)) return false;
      if (property.ValueOrNil === null || !isValidJSON(property.ValueOrNil)) return false;
    }
    return true;
  }

  return false;
}
