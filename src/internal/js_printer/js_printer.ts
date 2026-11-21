// 1:1 移植自 esbuild internal/js_printer/js_printer.go（v0.28.2，commit f6058f83）
//
// ⚠️ 这是**最小子集**（第 14 次推进）：只覆盖当前 js_parser 骨架能产出的节点。
// 未覆盖的语法一律 `throw`（cli 退出非 0 → oracle 记 ts-error），绝不静默输出错误字节。
// 已覆盖：SLocal/SExpr/SReturn/SFunction/SBlock/SIf/SDebugger/SDirective、
// ENumber/EString/EBoolean/ENull/EUndefined/EThis/EMissing/ERegExp/EIdentifier/EUnary/EBinary/
// ECall/EDot/EIndex/EArray/EObject/ESpread/ETemplate/EFunction/EImportMeta。
// 未覆盖（明确登记）：JSX、class、arrow、import/export 子句、TS 语法、注释、sourcemap、重命名。
//
// 期望值来自 Go 实测：`/root/esbuild/tmpgenprinter`（Parse + 真实 js_printer.Print）
// → testdata/js_printer/basic.json。生成命令见 PLAN.md「第 14 次推进」§4。

import * as js_ast from "../js_ast/js_ast.ts";
import { init } from "../helpers/init.ts";
import { IsIdentifier, IsIdentifierES5AndESNext, IsIdentifierES5AndESNextUTF16 } from "../js_ast/js_ident.ts";
import { Ref, Symbol, SymbolKind } from "../ast/ast.ts";
import * as ast from "../ast/ast.ts";
import { ImportPhase } from "../ast/ast.ts";
import { String as AssertOrWithKeywordString } from "../ast/ast.ts";
import { Loc } from "../logger/logger.ts";
import { ContainsNonBMPCodePoint, ContainsNonBMPCodePointUTF16, StringToUTF16, UTF16EqualsString, UTF16ToString } from "../helpers/utf.ts";
import * as js_ast_helpers from "../js_ast/js_ast_helpers.ts";
import { Has, JSFeature } from "../compat/compat.ts";
import { EscapeClosingTag } from "../helpers/comment.ts";
import * as sourcemap from "../sourcemap/sourcemap.ts";

/** Go: type Options struct (js_printer.go:4911) 的字段子集 */
export class Options {
  OutputFormat: number = 0;
  MinifyWhitespace: boolean = false;
  MinifyIdentifiers: boolean = false;
  MinifySyntax: boolean = false;
  ASCIIOnly: boolean = false;
  Indent: number = 2;
  LineLimit: number = 0;
  UnsupportedFeatures: bigint = 0n;
  LegalComments: number = 0;
  SourceMap: number = 0;
  AddSourceMappings: boolean = false;
  NeedsMetafile: boolean = false;
  /** Go: Options.InputSourceMap / LineOffsetTables（M2 sourcemap 通道） */
  InputSourceMap: sourcemap.SourceMap | null = null;
  LineOffsetTables: sourcemap.LineOffsetTable[] = [];
  /** Go: Options.TSEnums map[ast.Ref]map[string]js_ast.TSEnumValue（跨模块 enum 内联，打印期） */
  TSEnums: Map<number, Map<string, js_ast.TSEnumValue>> = new Map();
  /** Go: Options.MangledProps map[ast.Ref]string（属性重命名结果，打印期） */
  MangledProps: Map<number, string> = new Map();
  /** Go: Options.ConstValues map[ast.Ref]js_ast.ConstValue（跨模块常量内联，打印期，第 109 批） */
  ConstValues: Map<string, js_ast.ConstValue> = new Map();
  /** Go: Options.ToESMRef / RuntimeRequireRef / ToCommonJSRef（import-record 底座，第 111 批） */
  ToESMRef: ast.Ref = new ast.Ref(0xffffffff, 0xffffffff);
  RuntimeRequireRef: ast.Ref = new ast.Ref(0xffffffff, 0xffffffff);
  ToCommonJSRef: ast.Ref = new ast.Ref(0xffffffff, 0xffffffff);
  /** Go: Options.RequireOrImportMetaForSource（internal import 的 wrapper meta，第 111 批底座） */
  RequireOrImportMetaForSource: ((sourceIndex: number) => RequireOrImportMeta) | null = null;
}

/** Go: type RequireOrImportMeta (js_printer.go) */
export class RequireOrImportMeta {
  WrapperRef: ast.Ref = new ast.Ref(0xffffffff, 0xffffffff);
  ExportsRef: ast.Ref = new ast.Ref(0xffffffff, 0xffffffff);
  IsWrapperAsync: boolean = false;
}

/** Go: config.Format (config/config.go) 的子集 */
export const Format = {
  FormatNone: 0,
  FormatIIFE: 1,
  FormatCommonJS: 2,
  FormatESModule: 3,
} as const;

/** Go: type PrintResult struct */
export class PrintResult {
  JS: Uint8Array = new Uint8Array(0);
  ExtractedLegalComments: string[] = [];
  /** Go: PrintResult.SourceMapChunk sourcemap.Chunk（AddSourceMappings=true 时填充） */
  SourceMapChunk: sourcemap.Chunk = new sourcemap.Chunk();
}

/** Go: type Renamer interface { NameForSymbol(ast.Ref) string } (renamer/renamer.go:59) */
export interface Renamer {
  NameForSymbol(ref: Ref): string;
}

/** Go: printQuotedFlags (js_printer.go 内部) */
export const printQuotedFlags = {
  printQuotedNone: 0,
  printQuotedAllowBacktick: 1 << 0,
  printQuotedJSON: 1 << 1,
  printQuotedNoWrap: 1 << 2,
} as const;

/** Go: printExprFlags */
export const printExprFlags = {
  printExprFlagNone: 0,
  printExprFlagStartOfLine: 1 << 0,
  printExprFlagForbidCall: 1 << 1,
  printExprFlagForbidIn: 1 << 2,
  // Go: printExprFlags 的 isDeleteTarget / isCallTargetOrTemplateTag（第 38 轮 guardAgainst 移植）
  isDeleteTarget: 1 << 3,
  isCallTargetOrTemplateTag: 1 << 4,
  // Go: parentWasUnaryOrBinaryOrIfTest（printExprFlags 第 11 位，第 109 批 lateConstantFold 接线）
  parentWasUnaryOrBinaryOrIfTest: 1 << 5,
  // Go: exprResultIsUnused / didAlreadySimplifyUnusedExprs（第 109 批 simplifyUnusedExpr 接线）
  exprResultIsUnused: 1 << 6,
  didAlreadySimplifyUnusedExprs: 1 << 7,
  isNewTarget: 1 << 8,
} as const;

/** Go: printStmtFlags */
export const printStmtFlags = {
  printStmtFlagNone: 0,
  printStmtFlagIsInOneLineStatement: 1 << 0,
} as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const hexChars = "0123456789ABCDEF";

/** Go: func canUseShorthandProperty(key []uint16, name string, flags js_ast.PropertyFlags) bool (js_printer.go:1332) */
function canUseShorthandProperty(key: Uint16Array, name: string, flags: js_ast.PropertyFlags): boolean {
  if (!UTF16EqualsString(key, encoder.encode(name))) return false;
  return name !== "__proto__" || (flags & js_ast.PropertyFlags.PropertyWasShorthand) !== 0;
}

/** Go: func QuoteIdentifier(js []byte, name string, unsupportedFeatures compat.JSFeature) []byte (js_printer.go:33) */
export function QuoteIdentifier(name: string): Uint8Array {
  const out: number[] = [];
  for (const ch of name) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x20 && c <= 0x7e) {
      out.push(c);
    } else if (c <= 0xffff) {
      out.push(0x5c, 0x75, hexChars.charCodeAt(c >> 12), hexChars.charCodeAt((c >> 8) & 15),
        hexChars.charCodeAt((c >> 4) & 15), hexChars.charCodeAt(c & 15));
    } else {
      throw new Error("Internal error: Cannot encode identifier: Unicode escapes are unsupported");
    }
  }
  return new Uint8Array(out);
}

/** Go: helpers.StringToUTF16(string) —— 字符串 → UTF-16 码元序列（printPath/printClauseAlias 用） */
function utf16FromString(text: string): Uint16Array {
  return new Uint16Array(StringToUTF16(encoder.encode(text)));
}

/**
 * Go: func CanEscapeIdentifier(name string, UnsupportedFeatures compat.JSFeature, asciiOnly bool) bool (js_printer.go:426)
 * 1:1（第 42 轮）：与 p.canPrintIdentifier 同判定，参数显式传入的 features/asciiOnly。
 * Go 探针实测（/tmp/printer_helpers.json）：UnicodeEscapes 位未置时 asciiOnly 不改变结果
 * （「日本」asciiOnly=true 仍为 true），因为 `!Has(UnicodeEscapes)` 项先短路。
 */
export function CanEscapeIdentifier(name: string, unsupportedFeatures: bigint, asciiOnly: boolean): boolean {
  return IsIdentifierES5AndESNext(encoder.encode(name)) &&
    (!asciiOnly || !Has(unsupportedFeatures, JSFeature.UnicodeEscapes) ||
      !ContainsNonBMPCodePoint(encoder.encode(name)));
}

/**
 * Go: func parseSmallInt(bytes []byte) int (js_printer.go:3544)
 * 1:1（第 42 轮）：无错误校验的十进制解析（只用于浮点指数）。
 */
export function parseSmallInt(bytes: Uint8Array | string): number {
  const b: Uint8Array = typeof bytes === "string" ? encoder.encode(bytes) : bytes;
  let i = 0;
  const wasNegative = b.length > 0 && b[0] === 0x2d; // '-'
  if (wasNegative) i = 1;
  let n = 0;
  for (; i < b.length; i++) n = n * 10 + (b[i] - 0x30); // '0'
  return wasNegative ? -n : n;
}

/** Go: type printAfterDecorator uint8 (js_printer.go:914) */
export const printAfterDecorator = {
  printNewlineAfterDecorator: 0,
  printSpaceAfterDecorator: 1,
} as const;

/** Go: binaryExprVisitor 在 checkAndPrepare 与 visitRightAndFinish 间传递的局部状态 */
interface BinaryPrintState {
  entry: { Level: js_ast.L; Text: string; IsKeyword: boolean };
  wrap: boolean;
  leftLevel: js_ast.L;
  leftFlags: number;
  rightLevel: js_ast.L;
  flags: number;
}

/**
 * 阶段2：输出字节缓冲。替代 number[] + 逐字节 push + 每次 encode 分配 Uint8Array。
 * - length getter 保持既有 `this.js.length` 偏移比较语义不变；
 * - at(i) 取代 `this.js[i]` 的读取；
 * - print() 用 encoder.encodeInto 直接写入（UTF-8 语义与 TextEncoder.encode 相同）。
 */
class OutBuf {
  buf: Uint8Array = new Uint8Array(1 << 16);
  len: number = 0;
  get length(): number { return this.len; }
  ensure(n: number): void {
    if (this.len + n > this.buf.length) {
      let cap = this.buf.length;
      while (cap < this.len + n) cap *= 2;
      const nb = new Uint8Array(cap);
      nb.set(this.buf.subarray(0, this.len));
      this.buf = nb;
    }
  }
  at(i: number): number { return this.buf[i]; }
  append(bytes: Uint8Array): void {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }
  toUint8Array(): Uint8Array { return this.buf.subarray(0, this.len); }
}

export class printer {
  js: OutBuf = new OutBuf();
  options: Options;
  symbols: Symbol[];
  renamer: Renamer;
  /** Go: p.importRecords（import/export 的路径与 phase） */
  importRecords: js_ast.ImportRecord[] = [];
  indent: number = 0;
  lineLength: number = 0;
  prevOpEndsWithOpenBrace: boolean = false;
  prevOpEndsWithCloseBrace: boolean = false;
  prevOpIsUnaryPlusOrMinus_: boolean = false;
  prevOpIsDot: boolean = false;
  /** Go: prevOp js_ast.OpCode / prevOpEnd int / prevRegExpEnd int */
  prevOp: js_ast.OpCode = 0 as js_ast.OpCode;
  prevOpEnd: number = -1;
  /** Go: needSpaceBeforeDot int（默认 -1）——整数后紧跟 "." 要加空格 */
  needSpaceBeforeDot: number = -1;
  prevRegExpEnd: number = -1;
  /** Go: stmtStart int / arrowExprStart int（对象字面量在语句开头或箭头函数体开头时必须加括号） */
  stmtStart: number = -1;
  exportDefaultStart: number = -1;
  arrowExprStart: number = -1;
  /** Go: needsSemicolon bool（minify 时把分号推迟到下一个 token 之前） */
  needsSemicolon: boolean = false;
  /** Go: exprComments map[logger.Loc][]string（来自 parser；非 minify 才收集） */
  exprComments: Map<number, string[]> = new Map();
  /** Go: printedExprComments map[logger.Loc]bool */
  printedExprComments: Map<number, boolean> = new Map();
  /** Go: hasLegalComment map[string]struct{} / extractedLegalComments []string */
  hasLegalComment: Set<string> = new Set();
  extractedLegalComments: string[] = [];
  /** Go: p.wasLazyExport（js_printer.go:338） */
  wasLazyExport: boolean = false;
  /** Go: p.moduleType（js_printer.go，第 111 批 import-record 底座） */
  moduleType: number = 0;
  /** Go: noLeadingNewlineHere int（默认 -1，与 Go 的 printer 初始化一致） */
  noLeadingNewlineHere: number = -1;
  /** Go: withNesting int（js_printer.go:298）——with 体内 NaN/Infinity 要输出 0 / 0、1 / 0 */
  withNesting: number = 0;
  /** Go: p.intToBytesBuffer [64]byte（js_printer.go:305）—— smallIntToBytes 的免分配缓冲 */
  intToBytesBuffer: Uint8Array = new Uint8Array(64);
  /** Go: oldLineStart / oldLineEnd（js_printer.go）—— currentLineLength 的增量行起点缓存 */
  oldLineStart: number = 0;
  oldLineEnd: number = 0;
  /** Go: p.builder sourcemap.ChunkBuilder（M2 sourcemap 通道） */
  builder: sourcemap.ChunkBuilder;

  constructor(symbols: Symbol[], renamer: Renamer, options: Options) {
    this.symbols = symbols;
    this.renamer = renamer;
    this.options = options;
    this.builder = sourcemap.MakeChunkBuilder(options.InputSourceMap, options.LineOffsetTables, options.ASCIIOnly);
  }

  /** Go: func (p *printer) addSourceMapping(loc logger.Loc) (js_printer.go:333) */
  addSourceMapping(loc: Loc): void {
    if (this.options.AddSourceMappings) {
      this.builder.AddSourceMapping(loc, "", this.js.toUint8Array());
    }
  }

  /** Go: func (p *printer) addSourceMappingForName(loc logger.Loc, name string, ref ast.Ref) (js_printer.go:339) */
  addSourceMappingForName(loc: Loc, name: string, ref: Ref): void {
    if (this.options.AddSourceMappings) {
      const followed = this.followSymbols(ref);
      const originalName = this.symbols[followed.InnerIndex]?.OriginalName ?? "";
      if (originalName !== name) this.builder.AddSourceMapping(loc, originalName, this.js.toUint8Array());
      else this.builder.AddSourceMapping(loc, "", this.js.toUint8Array());
    }
  }

  /** Go: func (p *printer) canPrintIdentifier(name string) bool (js_printer.go:432) */
  canPrintIdentifier(name: string): boolean {
    for (const ch of name) {
      const c = ch.codePointAt(0)!;
      if (!(c === 0x24 || c === 0x5f || (c >= 0x30 && c <= 0x39) ||
        (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a))) {
        return false;
      }
    }
    return name.length > 0;
  }

  /** Go: func (p *printer) printIdentifier(name string) (js_printer.go:444) */
  printIdentifier(name: string): void {
    // Go：只有 ASCIIOnly 才走 QuoteIdentifier；否则直接写 UTF-8。
    // （第 18 轮修正：旧实现用 canPrintIdentifier 决定是否 Quote，导致默认 ASCIIOnly=false
    //   时非 ASCII 标识符被错误转义，甚或 panic：「Cannot encode identifier」。）
    if (this.options.ASCIIOnly) {
      this.printBytes(QuoteIdentifier(name));
    } else {
      this.print(name);
    }
  }

  /** Go: func (p *printer) printJSXTag(tagOrNil js_ast.Expr) (js_printer.go:252) */
  printJSXTag(tagOrNil: js_ast.Expr | null): void {
    const data = tagOrNil === null ? null : tagOrNil.Data;
    if (data instanceof js_ast.EString) {
      // JSX tag syntax doesn't support character escapes so non-ASCII identifiers
      // must be printed as UTF-8 even when the charset is set to ASCII.
      this.printBytes(UTF16ToString(data.Value));
    } else if (data instanceof js_ast.EIdentifier) {
      this.printIdentifier(this.renamer.NameForSymbol(data.Ref));
    } else if (data instanceof js_ast.EDot) {
      this.printJSXTag(data.Target);
      this.print(".");
      this.print(data.Name);
    } else if (tagOrNil !== null) {
      this.printExpr(tagOrNil, js_ast.L.LLowest, printExprFlags.printExprFlagNone);
    }
  }

  /** Go: func (p *printer) print(text string) (js_printer.go:312) */
  print(text: string): void {
    // 阶段2：encodeInto 直接写入可增长缓冲，避免每次 print 分配一个 Uint8Array。
    // UTF-8 最坏 3 字节/UTF-16 码元（代理对按 2 码元 4 字节；孤立代理项按 U+FFFD 3 字节）。
    this.js.ensure(text.length * 3);
    const r = encoder.encodeInto(text, this.js.buf.subarray(this.js.len));
    const written = r.written as number;
    if (written > 0) {
      const seg = this.js.buf.subarray(this.js.len, this.js.len + written);
      const nl = seg.lastIndexOf(0x0a);
      if (nl >= 0) this.lineLength = seg.length - nl - 1;
      else this.lineLength += seg.length;
    }
    this.js.len += written;
  }

  /** Go: func (p *printer) printBytes(bytes []byte) (js_printer.go:318) */
  printBytes(bytes: Uint8Array): void {
    const nl = bytes.lastIndexOf(0x0a);
    if (nl >= 0) this.lineLength = bytes.length - nl - 1;
    else this.lineLength += bytes.length;
    this.js.append(bytes);
  }

  /** Go: func (p *printer) printIndent() (js_printer.go:349) */
  printIndent(): void {
    if (!this.options.MinifyWhitespace) {
      for (let i = 0; i < this.indent; i++) this.print("  ");
    }
  }

  /** Go: func (p *printer) printSpace() (js_printer.go:779) */
  printSpace(): void {
    if (!this.options.MinifyWhitespace) this.print(" ");
  }

  /** Go: func (p *printer) printNewline() (js_printer.go:785) */
  printNewline(): void {
    if (!this.options.MinifyWhitespace) this.print("\n");
  }

  /** Go: func (p *printer) printSemicolonAfterStatement() (js_printer.go:837) */
  printSemicolonAfterStatement(): void {
    if (!this.options.MinifyWhitespace) this.print(";\n");
    else this.needsSemicolon = true;
  }

  /** Go: func (p *printer) printSemicolonIfNeeded() (js_printer.go:845) */
  printSemicolonIfNeeded(): void {
    if (this.needsSemicolon) {
      this.print(";");
      this.needsSemicolon = false;
    }
  }

  // -------------------------------------------------------------------------
  // 表达式注释（Go: js_printer.go:549 / 1917）
  // -------------------------------------------------------------------------

  /** Go: func (p *printer) willPrintExprCommentsAtLoc(loc logger.Loc) bool (js_printer.go:549) */
  willPrintExprCommentsAtLoc(loc: Loc): boolean {
    return !this.options.MinifyWhitespace && this.exprComments.get(loc.Start) !== undefined &&
      !this.printedExprComments.get(loc.Start);
  }

  /** Go: func (p *printer) willPrintExprCommentsForAnyOf(exprs []js_ast.Expr) bool (js_printer.go:553) */
  willPrintExprCommentsForAnyOf(exprs: js_ast.Expr[]): boolean {
    for (const expr of exprs) {
      if (this.willPrintExprCommentsAtLoc(expr.Loc)) return true;
    }
    return false;
  }

  /** Go: type exprStartFlags (js_printer.go:1865) */
  saveExprStartFlags(): number {
    const n = this.js.length;
    let flags = 0;
    if (this.stmtStart === n) flags |= 1;
    if (this.arrowExprStart === n) flags |= 2;
    return flags;
  }

  /** Go: func (p *printer) restoreExprStartFlags(flags exprStartFlags) (js_printer.go:1898) */
  restoreExprStartFlags(flags: number): void {
    if (flags !== 0) {
      const n = this.js.length;
      if ((flags & 1) !== 0) this.stmtStart = n;
      if ((flags & 2) !== 0) this.arrowExprStart = n;
    }
  }

  /** Go: func (p *printer) printIndentedComment(text string) (js_printer.go:3905) */
  printIndentedComment(raw: string): void {
    // Go: 默认 UnsupportedFeatures=0，因此总是走 EscapeClosingTag(text, "/script")。
    const escaped = EscapeClosingTag(encoder.encode(raw), encoder.encode("/script"));
    let text = decoder.decode(escaped);

    if (text.startsWith("/*")) {
      // Re-indent multi-line comments
      for (;;) {
        const newline = text.indexOf("\n");
        if (newline === -1) break;
        this.print(text.slice(0, newline + 1));
        this.printIndent();
        text = text.slice(newline + 1);
      }
      this.print(text);
      this.printNewline();
    } else {
      // Print a mandatory newline after single-line comments
      this.print(text);
      this.print("\n");
    }
  }

  /** Go: func (p *printer) printExprCommentsAtLoc(loc logger.Loc) (js_printer.go:1917) */
  printExprCommentsAtLoc(loc: Loc): void {
    if (this.options.MinifyWhitespace) return;
    const comments = this.exprComments.get(loc.Start);
    if (comments === undefined || this.printedExprComments.get(loc.Start)) return;

    const flags = this.saveExprStartFlags();

    // We must never generate a newline before certain expressions. For example,
    // generating a newline before the expression in a "return" statement will
    // cause a semicolon to be inserted, which would change the code's behavior.
    if (this.noLeadingNewlineHere === this.js.length) {
      for (const comment of comments) {
        if (comment.startsWith("//")) {
          this.print("/*");
          this.print(comment.slice(2));
          if (comment.startsWith("// ")) this.print(" ");
          this.print("*/");
        } else {
          this.print(comment.split("\n").join(""));
        }
        this.printSpace();
      }
    } else {
      for (const comment of comments) {
        this.printIndentedComment(comment);
        this.printIndent();
      }
    }

    this.printedExprComments.set(loc.Start, true);
    this.restoreExprStartFlags(flags);
  }

  /** Go: func (p *printer) printExprCommentsAfterCloseTokenAtLoc(loc logger.Loc) (js_printer.go:1955) */
  printExprCommentsAfterCloseTokenAtLoc(loc: Loc): void {
    const comments = this.exprComments.get(loc.Start);
    if (comments === undefined || this.printedExprComments.get(loc.Start)) return;

    const flags = this.saveExprStartFlags();
    for (const comment of comments) {
      this.printIndent();
      this.printIndentedComment(comment);
    }
    this.printedExprComments.set(loc.Start, true);
    this.restoreExprStartFlags(flags);
  }

  /** Go: func (p *printer) printSpaceBeforeIdentifier() (js_printer.go:852) */
  printSpaceBeforeIdentifier(): void {
    if (this.js.length === 0) return;
    const last = this.js.at(this.js.length - 1);
    // 多字节 UTF-8 的末字节落在 0x80..0xBF：Go 的 DecodeLastRune 对残片返回 RuneError，
    // 而 RuneError 不是标识符继续字符，所以只看末字节与 Go 一致（非 ASCII 全字符名按 ASCII 判定）。
    if (last === 0x24 || last === 0x5f || (last >= 0x30 && last <= 0x39) ||
      (last >= 0x41 && last <= 0x5a) || (last >= 0x61 && last <= 0x7a) ||
      this.prevRegExpEnd === this.js.length) {
      this.print(" ");
    }
  }

  /** Go: func (p *printer) canPrintIdentifierUTF16(name []uint16) bool (js_printer.go:442) */
  canPrintIdentifierUTF16(name: Uint16Array): boolean {
    if (!IsIdentifierES5AndESNextUTF16(name)) return false;
    if (this.options.ASCIIOnly && ContainsNonBMPCodePointUTF16(name)) return false;
    return true;
  }

  /** Go: func (p *printer) printIdentifierUTF16(name []uint16) (js_printer.go:456) */
  printIdentifierUTF16(name: Uint16Array): void {
    const out: number[] = [];
    for (let i = 0; i < name.length; i++) {
      let c = name[i];
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < name.length) {
        const c2 = name[i + 1];
        if (c2 >= 0xdc00 && c2 <= 0xdfff) {
          c = (c << 10) + c2 + (0x10000 - (0xd800 << 10) - 0xdc00);
          i++;
        }
      }

      if (this.options.ASCIIOnly && c > 0x7e) {
        if (c <= 0xffff) {
          out.push(0x5c, 0x75,
            hexChars.charCodeAt(c >> 12), hexChars.charCodeAt((c >> 8) & 15),
            hexChars.charCodeAt((c >> 4) & 15), hexChars.charCodeAt(c & 15));
        } else {
          throw new Error("Internal error: Cannot encode identifier: Unicode escapes are unsupported");
        }
        continue;
      }

      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    this.printBytes(new Uint8Array(out));
  }

  /** Go: func (p *printer) printSpaceBeforeOperator(next js_ast.OpCode) (js_printer.go:817) */
  printSpaceBeforeOperator(next: js_ast.OpCode): void {
    if (this.prevOpEnd === this.js.length) {
      const prev = this.prevOp;

      // "+ + y" => "+ +y" 等不得合并成别的 token
      if (((prev === js_ast.OpCode.BinOpAdd || prev === js_ast.OpCode.UnOpPos) &&
        (next === js_ast.OpCode.BinOpAdd || next === js_ast.OpCode.UnOpPos || next === js_ast.OpCode.UnOpPreInc)) ||
        ((prev === js_ast.OpCode.BinOpSub || prev === js_ast.OpCode.UnOpNeg) &&
          (next === js_ast.OpCode.BinOpSub || next === js_ast.OpCode.UnOpNeg || next === js_ast.OpCode.UnOpPreDec)) ||
        (prev === js_ast.OpCode.UnOpPostDec && next === js_ast.OpCode.BinOpGt) ||
        (prev === js_ast.OpCode.UnOpNot && next === js_ast.OpCode.UnOpPreDec &&
          this.js.length > 1 && this.js.at(this.js.length - 2) === 0x3c)) {
        this.print(" ");
      }
    }
  }

  /** Go: func (p *printer) printNonNegativeFloat(absValue float64) (js_printer.go:3564) */
  printNonNegativeFloat(absValue: number): void {
    // We can avoid the slow call to strconv.FormatFloat() for integers less than
    // 1000 because we know that exponential notation will always be longer than
    // the integer representation. This is not the case for 1000 which is "1e3".
    if (absValue < 1000) {
      if (Number.isInteger(absValue)) {
        this.print(String(absValue));
        // Integers always need a space before "." to avoid making a decimal point
        this.needSpaceBeforeDot = this.js.length;
        return;
      }
    }

    // Go 的 strconv.FormatFloat(absValue, 'g', -1, 64)。JS 的 String() 与它对最短十进制位一致，
    // 差异只在指数阈值上；该差异面已由 testdata/js_printer/basic.json 的 numbers 表（60 条边界值，
    // 含 1e3/1e-7/1e21/2**53/5e-324/1.797e308/1.23e-10）逐字节钉死（PLAN.md「第 15 次推进」§2）。
    let result = String(absValue);

    // Simplify the exponent: "e+05" => "e5"
    {
      const e = result.lastIndexOf("e");
      if (e !== -1) {
        let sign = "";
        let rest = result.slice(e + 1);
        if (rest[0] === "+") rest = rest.slice(1);
        else if (rest[0] === "-") { sign = "-"; rest = rest.slice(1); }
        rest = rest.replace(/^0+/, "");
        result = result.slice(0, e + 1) + sign + rest;
      }
    }

    const dot = result.indexOf(".");

    if (dot === 1 && result[0] === "0") {
      // Simplify numbers starting with "0."
      let afterDot = 2;
      if (this.options.MinifyWhitespace) {
        result = result.slice(1);
        afterDot--;
      }

      // Try using an exponent: "0.001" => "1e-3"
      if (result[afterDot] === "0") {
        let i = afterDot + 1;
        while (result[i] === "0") i++;
        const remaining = result.slice(i);
        const exponent = String(afterDot - i - remaining.length);
        if (result.length > remaining.length + 1 + exponent.length) {
          result = remaining + "e" + exponent;
        }
      }
    } else if (dot !== -1) {
      // Try to get rid of a "." and maybe also an "e"
      const e = result.lastIndexOf("e");
      if (e !== -1) {
        const integer = result.slice(0, dot);
        const fraction = result.slice(dot + 1, e);
        const exponent = parseInt(result.slice(e + 1), 10) - fraction.length;

        if (exponent >= 0 && exponent <= 2) {
          // "1.2e1" => "12" / "1.2e2" => "120"
          if (result.length >= integer.length + fraction.length + exponent) {
            result = integer + fraction + "0".repeat(exponent);
          }
        } else {
          // "1.2e4" => "12e3"
          const exponentStr = String(exponent);
          if (result.length >= integer.length + fraction.length + 1 + exponentStr.length) {
            result = integer + fraction + "e" + exponentStr;
          }
        }
      }
    } else if (result.endsWith("0")) {
      // Simplify numbers ending with "0" by trying to use an exponent
      // "1000" => "1e3"
      let i = result.length - 1;
      while (i > 0 && result[i - 1] === "0") i--;
      const remaining = result.slice(0, i);
      const exponent = String(result.length - i);
      if (result.length > remaining.length + 1 + exponent.length) {
        result = remaining + "e" + exponent;
      }
    }

    this.print(result);

    // We'll need a space before "." if it could be parsed as a decimal point
    if (!/[.ex]/.test(result)) this.needSpaceBeforeDot = this.js.length;
  }

  /** Go: func (p *printer) printNumber(value float64, level js_ast.L) (js_printer.go:484) */
  printNumber(value: number, level: js_ast.L): void {
    // Go: js_printer.go:495 —— 非负数的前面要调 printSpaceBeforeIdentifier()，
    // 否则压缩输出里 "export default 1" 会变成 "export default1"。
    const absValue = Math.abs(value);
    if (Number.isNaN(value)) {
      this.printSpaceBeforeIdentifier();
      if (this.withNesting !== 0) {
        // "with (x) NaN" really means "x.NaN" so avoid identifiers when "with" is present
        const wrap = level >= js_ast.L.LMultiply;
        if (wrap) this.print("(");
        if (this.options.MinifyWhitespace) {
          this.print("0/0");
        } else {
          this.print("0 / 0");
        }
        if (wrap) this.print(")");
      } else {
        this.print("NaN");
      }
    } else if (absValue === Infinity) {
      // "with (x) Infinity" really means "x.Infinity" so avoid identifiers when "with" is present
      const wrap = ((this.options.MinifySyntax || this.withNesting !== 0) && level >= js_ast.L.LMultiply) ||
        (value === -Infinity && level >= js_ast.L.LPrefix);
      if (wrap) this.print("(");
      if (value === -Infinity) {
        this.printSpaceBeforeOperator(js_ast.OpCode.UnOpNeg);
        this.print("-");
      } else {
        this.printSpaceBeforeIdentifier();
      }
      if (!this.options.MinifySyntax && this.withNesting === 0) {
        this.print("Infinity");
      } else if (this.options.MinifyWhitespace) {
        this.print("1/0");
      } else {
        this.print("1 / 0");
      }
      if (wrap) this.print(")");
    } else if (value >= 0 && !Object.is(value, -0)) {
      this.printSpaceBeforeIdentifier();
      this.printNonNegativeFloat(absValue);
    } else if (level >= js_ast.L.LPrefix) {
      // Expressions such as "(-1).toString" need to wrap negative numbers
      this.print("(-");
      this.printNonNegativeFloat(absValue);
      this.print(")");
    } else {
      this.printSpaceBeforeOperator(js_ast.OpCode.UnOpNeg);
      this.print("-");
      this.printNonNegativeFloat(absValue);
    }
  }

  /**
   * Go: func (p *printer) smallIntToBytes(n int) []byte (js_printer.go:3514)
   * 1:1（第 42 轮）：从缓冲区末端向前写十进制数字，可选负号。
   */
  smallIntToBytes(n: number): Uint8Array {
    const wasNegative = n < 0;
    if (wasNegative) n = -n;
    const bytes = this.intToBytesBuffer;
    let start = bytes.length;
    for (;;) {
      start--;
      bytes[start] = 0x30 + (n % 10);
      n = Math.floor(n / 10);
      if (n === 0) break;
    }
    if (wasNegative) {
      start--;
      bytes[start] = 0x2d;
    }
    return bytes.subarray(start);
  }

  /**
   * Go: func (p *printer) followSymbols(ref Ref) Ref —— TS 扁平数组版 ast.FollowSymbols。
   * 与 isUnboundIdentifier 内联版同口径：沿 Link.InnerIndex 跟随到终点，带环保护。
   */
  private followSymbols(ref: Ref): Ref {
    let idx = ref.InnerIndex;
    const seen = new Set<number>();
    while (idx < this.symbols.length && this.symbols[idx]?.Link &&
      this.symbols[idx].Link.InnerIndex !== idx && this.symbols[idx].Link.InnerIndex < this.symbols.length) {
      const nx = this.symbols[idx].Link.InnerIndex;
      if (seen.has(nx)) break;
      seen.add(nx);
      idx = nx;
    }
    return new Ref(idx, ref.SourceIndex);
  }

  /**
   * Go: func (p *printer) mangledPropName(ref ast.Ref) string (js_printer.go:369)
   * 1:1（第 42 轮 sweep）：FollowSymbols → MangledProps 命中返回改名，否则 renamer。
   */
  mangledPropName(ref: Ref): string {
    const followed = this.followSymbols(ref);
    const mangled = this.options.MangledProps.get(followed.InnerIndex);
    if (mangled !== undefined) return mangled;
    return this.renamer.NameForSymbol(followed);
  }

  /** Go: p.options.ConstValues[FollowSymbols(ref)]（第 109 批，键按 InnerIndex） */
  private constValueFor(ref: Ref): js_ast.ConstValue | undefined {
    // followSymbols 返回的 Ref 有两个字段对调的历史口径（SourceIndex 内装的是跟随后的 idx），
    // 这里只取跟随后的 InnerIndex（Go 的 ref.InnerIndex）作为 ConstValues 键。
    let idx = ref.InnerIndex;
    const seen = new Set<number>();
    while (idx < this.symbols.length && this.symbols[idx]?.Link &&
      this.symbols[idx].Link.InnerIndex !== idx && this.symbols[idx].Link.InnerIndex < this.symbols.length) {
      const nx = this.symbols[idx].Link.InnerIndex;
      if (seen.has(nx)) break;
      seen.add(nx);
      idx = nx;
    }
    return this.options.ConstValues.get(String(idx));
  }

  /**
   * Go: func (p *printer) simplifyUnusedExpr(expr js_ast.Expr) js_ast.Expr (js_printer.go:1673)
   * 第 109 批：打印期把未使用的空函数/恒等函数调用剥掉，逐字节对齐 Go minify 通道。
   */
  simplifyUnusedExpr(expr: js_ast.Expr): js_ast.Expr {
    const d = expr.Data;
    if (d instanceof js_ast.EBinary) {
      if (d.Op === js_ast.OpCode.BinOpComma) {
        const left = this.simplifyUnusedExpr(d.Left);
        const right = this.simplifyUnusedExpr(d.Right);
        if (left.Data !== d.Left.Data || right.Data !== d.Right.Data) {
          return js_ast_helpers.JoinWithComma(left, right);
        }
      }
    } else if (d instanceof js_ast.ECall) {
      let symbolFlags = 0;
      const target = d.Target.Data;
      if (target instanceof js_ast.EIdentifier) {
        symbolFlags = this.symbols[target.Ref.InnerIndex]?.Flags ?? 0;
      } else if (target instanceof js_ast.EImportIdentifier) {
        const ref = this.followSymbols(target.Ref);
        symbolFlags = this.symbols[ref.InnerIndex]?.Flags ?? 0;
      }
      const FM = ast.SymbolFlags;
      if ((symbolFlags & (FM.IsEmptyFunction | FM.CouldPotentiallyBeMutated)) === FM.IsEmptyFunction) {
        let replacement = new js_ast.Expr();
        for (const arg of d.Args) {
          // Go 原地改 arg.Data = &EArray{Items:[arg]}（自引用，仅用于 spread 形态占位）；
          // 用等价的新 Expr 包装：Array 的 Items[0] 仍指向原 arg（含 ESpread）。
          const a = arg.Data instanceof js_ast.ESpread
            ? new js_ast.Expr(init(new js_ast.EArray(), { Items: [arg], IsSingleLine: true }), arg.Loc)
            : arg;
          replacement = js_ast_helpers.JoinWithComma(replacement, this.helperSimplifyUnused(this.simplifyUnusedExpr(a)));
        }
        return replacement;
      }
      if ((symbolFlags & (FM.IsIdentityFunction | FM.CouldPotentiallyBeMutated)) === FM.IsIdentityFunction && d.Args.length === 1) {
        const arg = d.Args[0];
        if (!(arg.Data instanceof js_ast.ESpread)) return this.helperSimplifyUnused(this.simplifyUnusedExpr(arg));
      }
    }
    return expr;
  }

  /** Go: p.astHelpers.SimplifyUnusedExpr(expr, p.options.UnsupportedFeatures) */
  private helperSimplifyUnused(expr: js_ast.Expr): js_ast.Expr {
    const ctx = js_ast_helpers.MakeHelperContext(() => false);
    return ctx.SimplifyUnusedExpr(expr, this.options.UnsupportedFeatures);
  }

  /**
   * Go: func (p *printer) lateConstantFoldUnaryOrBinaryOrIfExpr(expr js_ast.Expr) js_ast.Expr (js_printer.go:1765)
   * 第 109 批：打印期对跨模块内联常量做局部折叠，逐字节对齐 Go minify 通道。
   */
  lateConstantFoldUnaryOrBinaryOrIfExpr(expr: js_ast.Expr): js_ast.Expr {
    const d = expr.Data;
    if (d instanceof js_ast.EImportIdentifier) {
      const value = this.constValueFor(d.Ref);
      if (value && value.Kind !== js_ast.ConstValueKind.ConstValueNone) {
        return js_ast.ConstValueToExpr(expr.Loc, value);
      }
    } else if (d instanceof js_ast.EDot) {
      const value = this.tryToGetImportedEnumValue(d.Target, d.Name);
      if (value !== null) {
        const inlined = value.String !== null
          ? new js_ast.Expr(new js_ast.EString(value.String), expr.Loc)
          : new js_ast.Expr(new js_ast.ENumber(value.Number), expr.Loc);
        if (!d.Name.includes("*/")) return inlined;
        return new js_ast.Expr(init(new js_ast.EInlinedEnum(), { Value: inlined, Comment: d.Name }), inlined.Loc);
      }
    } else if (d instanceof js_ast.EUnary) {
      const value = this.lateConstantFoldUnaryOrBinaryOrIfExpr(d.Value);
      if (value.Data !== d.Value.Data) {
        const [num, numOk] = js_ast_helpers.ToNumberWithoutSideEffects(value.Data);
        if (numOk) {
          if (d.Op === js_ast.OpCode.UnOpPos) return new js_ast.Expr(new js_ast.ENumber(num), expr.Loc);
          if (d.Op === js_ast.OpCode.UnOpNeg) return new js_ast.Expr(new js_ast.ENumber(-num), expr.Loc);
          if (d.Op === js_ast.OpCode.UnOpCpl) return new js_ast.Expr(new js_ast.ENumber(js_ast_helpers.ToInt32(num) ^ -1), expr.Loc);
        }
        expr.Data = init(new js_ast.EUnary(), { Op: d.Op, Value: value });
      }
    } else if (d instanceof js_ast.EBinary) {
      const left = this.lateConstantFoldUnaryOrBinaryOrIfExpr(d.Left);
      const right = this.lateConstantFoldUnaryOrBinaryOrIfExpr(d.Right);
      if (left.Data !== d.Left.Data || right.Data !== d.Right.Data) {
        const binary = init(new js_ast.EBinary(), { Op: d.Op, Left: left, Right: right });
        if (js_ast_helpers.ShouldFoldBinaryOperatorWhenMinifying(binary)) {
          const result = js_ast_helpers.FoldBinaryOperator(expr.Loc, binary);
          if (result.Data !== null) return result;
        }
        expr.Data = binary;
      }
    } else if (d instanceof js_ast.EIf) {
      const test = this.lateConstantFoldUnaryOrBinaryOrIfExpr(d.Test);
      if (test.Data !== d.Test.Data) {
        const [boolean, sideEffects, ok] = js_ast_helpers.ToBooleanWithSideEffects(test.Data);
        if (ok && sideEffects === js_ast_helpers.NoSideEffects) {
          return boolean ? this.lateConstantFoldUnaryOrBinaryOrIfExpr(d.Yes) : this.lateConstantFoldUnaryOrBinaryOrIfExpr(d.No);
        }
        expr.Data = init(new js_ast.EIf(), { Test: test, Yes: d.Yes, No: d.No });
      }
    }
    return expr;
  }

  /**
   * Go: func (p *printer) tryToGetImportedEnumValue(target js_ast.Expr, name string) (js_ast.TSEnumValue, bool) (js_printer.go:377)
   * 1:1（第 42 轮 sweep）：EImportIdentifier → FollowSymbols → SymbolTSEnum → TSEnums[name]。
   */
  tryToGetImportedEnumValue(target: js_ast.Expr, name: string): js_ast.TSEnumValue | null {
    if (target.Data instanceof js_ast.EImportIdentifier) {
      const ref = this.followSymbols(target.Data.Ref);
      if (this.symbols[ref.InnerIndex]?.Kind === SymbolKind.SymbolTSEnum) {
        const enumMap = this.options.TSEnums.get(ref.InnerIndex);
        if (enumMap !== undefined && enumMap.has(name)) return enumMap.get(name)!;
      }
    }
    return null;
  }

  /**
   * Go: func (p *printer) tryToGetImportedEnumValueUTF16(target js_ast.Expr, name []uint16) (js_ast.TSEnumValue, string, bool) (js_printer.go:390)
   * 1:1（第 42 轮 sweep）：同上但 name 是 UTF16，返回解码后的 string。
   */
  tryToGetImportedEnumValueUTF16(target: js_ast.Expr, name: Uint16Array): { value: js_ast.TSEnumValue; name: string } | null {
    if (target.Data instanceof js_ast.EImportIdentifier) {
      const ref = this.followSymbols(target.Data.Ref);
      if (this.symbols[ref.InnerIndex]?.Kind === SymbolKind.SymbolTSEnum) {
        const enumMap = this.options.TSEnums.get(ref.InnerIndex);
        if (enumMap !== undefined) {
          // Go: helpers.UTF16ToString([]uint16) 返回 string；TS 版返回 UTF-8 字节，需 TextDecoder。
          const decoded = new TextDecoder().decode(UTF16ToString(name));
          const value = enumMap.get(decoded);
          if (value !== undefined) return { value, name: decoded };
        }
      }
    }
    return null;
  }

  /**
   * Go: func (p *printer) printQuotedUTF8(text string, flags printQuotedFlags) (js_printer.go:329)
   * 1:1（第 42 轮）：UTF-8 字符串 → UTF16 后转调 printQuotedUTF16。
   */
  printQuotedUTF8(text: string, flags: number): void {
    this.printQuotedUTF16(utf16FromString(text), flags);
  }

  /**
   * Go: func (p *printer) currentLineLength() int (js_printer.go:791)
   * 1:1（第 42 轮）：从 js 末尾回扫到 oldLineEnd，更新 oldLineStart，返回当前行长度。
   */
  currentLineLength(): number {
    const js = this.js;
    const n = js.length;
    const stop = this.oldLineEnd;
    for (let i = n; i > stop; i--) {
      const c = js.at(i - 1);
      if (c === 0x0d || c === 0x0a) { // '\r' / '\n'
        this.oldLineStart = i;
        break;
      }
    }
    this.oldLineEnd = n;
    return n - this.oldLineStart;
  }

  /**
   * Go: func (p *printer) printNewlinePastLineLimit() bool (js_printer.go:808)
   * 1:1（第 42 轮）：超过行宽限制则换行+缩进并返回 true。
   */
  printNewlinePastLineLimit(): boolean {
    if (this.currentLineLength() < this.options.LineLimit) return false;
    this.print("\n");
    this.printIndent();
    return true;
  }

  /**
   * Go: func (p *printer) printDotThenPrefix() js_ast.L (js_printer.go:1609)
   * 1:1（第 42 轮）：Arrow 降级分支输出 function(){return ...}，否则输出箭头。
   */
  printDotThenPrefix(): js_ast.L {
    if (Has(this.options.UnsupportedFeatures, JSFeature.Arrow)) {
      this.print(".then(function()");
      this.printSpace();
      this.print("{");
      this.printNewline();
      // Go 用 p.options.Indent 作缩进；TS printer 已把它映射到独立字段 this.indent
      // （printIndent() 读 this.indent），故此处增 this.indent 才是 TS 侧的等价操作。
      this.indent++;
      this.printIndent();
      this.print("return");
      this.printSpace();
      return js_ast.L.LLowest;
    } else {
      this.print(".then(()");
      this.printSpace();
      this.print("=>");
      this.printSpace();
      return js_ast.L.LComma;
    }
  }

  /**
   * Go: func (p *printer) printDotThenSuffix() (js_printer.go:1629)
   * 1:1（第 42 轮）：与 printDotThenPrefix 配对的收尾。
   */
  printDotThenSuffix(): void {
    if (Has(this.options.UnsupportedFeatures, JSFeature.Arrow)) {
      if (!this.options.MinifyWhitespace) this.print(";");
      this.printNewline();
      this.indent--;
      this.printIndent();
      this.print("})");
    } else {
      this.print(")");
    }
  }

  /**
   * Go: func (p *printer) printUndefined(loc logger.Loc, level js_ast.L) (js_printer.go:1643)
   * 1:1（第 42 轮）：EUndefined 打印 "void 0"（高优先级加括号）。
   * 注：Go 此函数含 addSourceMapping(loc)，M1 无 sourcemap 通道，loc 仅占位不产生字节。
   */
  printUndefined(_loc: Loc, level: js_ast.L): void {
    if (level >= js_ast.L.LPrefix) {
      this.print("(void 0)");
    } else {
      this.printSpaceBeforeIdentifier();
      this.print("void 0");
    }
  }

  /** Go: func (p *printer) printQuotedUTF16(data []uint16, flags printQuotedFlags) (js_printer.go:1353) */
  printQuotedUTF16(data: Uint16Array, flags: number): void {
    // Go: UnsupportedFeatures.Has(compat.TemplateLiteral) 时禁用 backtick。
    if (Has(this.options.UnsupportedFeatures, JSFeature.TemplateLiteral)) {
      flags &= ~printQuotedFlags.printQuotedAllowBacktick;
    }
    let singleCost = 0;
    let doubleCost = 0;
    let backtickCost = 0;

    for (let i = 0; i < data.length; i++) {
      const c = data[i];
      switch (c) {
        case 0x0a: // '\n'
          if (this.options.MinifySyntax) backtickCost--;
          break;
        case 0x27: // '\''
          singleCost++;
          break;
        case 0x22: // '"'
          doubleCost++;
          break;
        case 0x60: // '`'
          backtickCost++;
          break;
        case 0x24: // '$'
          if (i + 1 < data.length && data[i + 1] === 0x7b) backtickCost++;
          break;
      }
    }

    let quote = '"';
    if (doubleCost > singleCost) {
      quote = "'";
      if (singleCost > backtickCost && (flags & printQuotedFlags.printQuotedAllowBacktick) !== 0) {
        quote = "`";
      }
    } else if (doubleCost > backtickCost && (flags & printQuotedFlags.printQuotedAllowBacktick) !== 0) {
      quote = "`";
    }

    this.print(quote);
    this.printUnquotedUTF16(data, quote.charCodeAt(0));
    this.print(quote);
  }

  /** Go: func (p *printer) printUnquotedUTF16(text []uint16, quote rune, flags printQuotedFlags) (js_printer.go:65) */
  printUnquotedUTF16(text: Uint16Array, quote: number, _flags: number = 0): void {
    const n = text.length;
    let i = 0;
    while (i < n) {
      const c = text[i];
      i++;

      switch (c) {
        case 0x00:
          // We don't want "\x001" to be written as "\01"
          if (i < n && text[i] >= 0x30 && text[i] <= 0x39) this.print("\\x00");
          else this.print("\\0");
          break;
        case 0x07: this.print("\\x07"); break;
        case 0x08: this.print("\\b"); break;
        case 0x0c: this.print("\\f"); break;
        case 0x0a:
          if (quote === 0x60) this.print("\n");
          else this.print("\\n");
          break;
        case 0x0d: this.print("\\r"); break;
        case 0x0b: this.print("\\v"); break;
        case 0x1b: this.print("\\x1B"); break;
        case 0x5c: this.print("\\\\"); break;
        case 0x2f: { // '/'
          // Avoid generating the sequence "</script" in JS code
          if (i >= 2 && text[i - 2] === 0x3c && i + 6 <= n) {
            const script = "script";
            let matches = true;
            for (let j = 0; j < 6; j++) {
              let a = text[i + j];
              if (a >= 0x41 && a <= 0x5a) a += 0x61 - 0x41;
              if (a !== script.charCodeAt(j)) {
                matches = false;
                break;
              }
            }
            if (matches) this.print("\\");
          }
          this.print("/");
          break;
        }
        case 0x27: // '\''
          if (quote === 0x27) this.print("\\");
          this.print("'");
          break;
        case 0x22: // '"'
          if (quote === 0x22) this.print("\\");
          this.print("\"");
          break;
        case 0x60: // '`'
          if (quote === 0x60) this.print("\\");
          this.print("`");
          break;
        case 0x24: // '$'
          if (quote === 0x60 && i < n && text[i] === 0x7b) this.print("\\");
          this.print("$");
          break;
        case 0x2028: this.print("\\u2028"); break;
        case 0x2029: this.print("\\u2029"); break;
        case 0xfeff: this.print("\\uFEFF"); break;
        default:
          if (c <= 0x7e) {
            this.print(String.fromCharCode(c));
          } else if (c >= 0xd800 && c <= 0xdbff) {
            if (i < n && text[i] >= 0xdc00 && text[i] <= 0xdfff) {
              const c2 = text[i];
              const r = (c << 10) + c2 + (0x10000 - (0xd800 << 10) - 0xdc00);
              i++;
              if (this.options.ASCIIOnly) {
                // Go: UnsupportedFeatures.Has(compat.UnicodeEscapes) 为假（默认 0）
                this.print("\\u{" + r.toString(16).toUpperCase() + "}");
                continue;
              }
              this.print(String.fromCodePoint(r));
              continue;
            }
            this.print("\\u" + c.toString(16).toUpperCase().padStart(4, "0"));
          } else if ((c >= 0xdc00 && c <= 0xdfff) || (this.options.ASCIIOnly && c > 0xff)) {
            this.print("\\u" + c.toString(16).toUpperCase().padStart(4, "0"));
          } else if (this.options.ASCIIOnly) {
            this.print("\\x" + c.toString(16).toUpperCase().padStart(2, "0"));
          } else {
            this.print(String.fromCharCode(c));
          }
      }
    }
  }

  /** 非 Go 函数：ETemplate 的 cooked 文本输出（Go 在 printExpr 内联处理） */
  printTemplateCooked(data: Uint16Array): void {
    for (let i = 0; i < data.length; i++) {
      const c = data[i];
      if (c === 0x5c) this.print("\\\\");
      else if (c === 0x60) this.print("\\`");
      else if (c === 0x24 && i + 1 < data.length && data[i + 1] === 0x7b) this.print("\\$");
      else if (c === 0x0d) this.print("\\r");
      else if (c === 0x0a) this.print("\\n");
      else this.print(String.fromCharCode(c));
    }
  }

  /** Go: func (p *printer) printBinding(binding js_ast.Binding) (js_printer.go:562) */
  printBinding(binding: js_ast.Binding): void {
    const b = binding.Data;
    if (b instanceof js_ast.BIdentifier) {
      this.printSpaceBeforeIdentifier();
      this.printIdentifier(this.renamer.NameForSymbol(b.Ref));
    } else if (b instanceof js_ast.BMissing) {
      // 空
    } else if (b instanceof js_ast.BArray) {
      const isMultiLine = b.Items.length > 0 && !b.IsSingleLine;
      this.print("[");
      if (b.Items.length > 0 || isMultiLine) {
        if (isMultiLine) this.indent++;

        for (let i = 0; i < b.Items.length; i++) {
          if (i !== 0) this.print(",");
          if (isMultiLine) {
            this.printNewline();
            this.printIndent();
          } else if (i !== 0) {
            this.printSpace();
          }
          if (b.HasSpread && i + 1 === b.Items.length) this.print("...");
          this.printBinding(b.Items[i].Binding);

          if (b.Items[i].DefaultValueOrNil !== null) {
            this.printSpace();
            this.print("=");
            this.printSpace();
            this.printExprWithoutLeadingNewline(b.Items[i].DefaultValueOrNil!, js_ast.L.LComma, printExprFlags.printExprFlagNone);
          }
        }

        if (isMultiLine) {
          this.printNewline();
          this.indent--;
          this.printIndent();
        }
      }
      this.print("]");
    } else if (b instanceof js_ast.BObject) {
      const isMultiLine = b.Properties.length > 0 && !b.IsSingleLine;
      this.print("{");
      if (b.Properties.length > 0 || isMultiLine) {
        if (isMultiLine) this.indent++;

        for (let i = 0; i < b.Properties.length; i++) {
          const property = b.Properties[i];
          if (i !== 0) this.print(",");
          if (isMultiLine) {
            this.printNewline();
            this.printIndent();
          } else {
            this.printSpace();
          }

          if (property.IsSpread) {
            this.print("...");
            this.printBinding(property.Value);
            continue;
          }

          if (property.IsComputed) {
            this.print("[");
            this.printExpr(property.Key, js_ast.L.LComma, printExprFlags.printExprFlagNone);
            this.print("]:");
            this.printSpace();
          } else if (property.Key.Data instanceof js_ast.EString &&
            !property.PreferQuotedKey && this.canPrintIdentifierUTF16(property.Key.Data.Value)) {
            // Use a shorthand property if the names are the same
            const keyValue = property.Key.Data.Value;
            const valueData = property.Value.Data;
            if (valueData instanceof js_ast.BIdentifier &&
              UTF16EqualsString(keyValue, encoder.encode(this.renamer.NameForSymbol(valueData.Ref)))) {
              this.printIdentifierUTF16(keyValue);
              if (property.DefaultValueOrNil !== null) {
                this.printSpace();
                this.print("=");
                this.printSpace();
                this.printExprWithoutLeadingNewline(property.DefaultValueOrNil, js_ast.L.LComma, printExprFlags.printExprFlagNone);
              }
              continue;
            }

            this.printIdentifierUTF16(keyValue);
            this.print(":");
            this.printSpace();
          } else if (property.Key.Data instanceof js_ast.EString) {
            this.printQuotedUTF16(property.Key.Data.Value, printQuotedFlags.printQuotedNone);
            this.print(":");
            this.printSpace();
          } else {
            this.printExpr(property.Key, js_ast.L.LLowest, printExprFlags.printExprFlagNone);
            this.print(":");
            this.printSpace();
          }

          this.printBinding(property.Value);

          if (property.DefaultValueOrNil !== null) {
            this.printSpace();
            this.print("=");
            this.printSpace();
            this.printExprWithoutLeadingNewline(property.DefaultValueOrNil, js_ast.L.LComma, printExprFlags.printExprFlagNone);
          }
        }

        if (isMultiLine) {
          this.printNewline();
          this.indent--;
          this.printIndent();
        } else {
          this.printSpace();
        }
      }
      this.print("}");
    } else {
      throw new Error("printer: unsupported binding");
    }
  }

  /** Go: func (p *printer) printFnArgs(args []js_ast.Arg, opts fnArgsOpts) (js_printer.go:865) */
  printFnArgs(args: js_ast.Arg[], opts: { hasRestArg?: boolean; isArrow?: boolean } = {}): void {
    let wrap = true;

    // Minify "(a) => {}" as "a=>{}"
    if (this.options.MinifyWhitespace && !opts.hasRestArg && opts.isArrow && args.length === 1) {
      if (args[0].Binding.Data instanceof js_ast.BIdentifier && args[0].DefaultOrNil === null) {
        wrap = false;
      }
    }

    if (wrap) this.print("(");

    for (let i = 0; i < args.length; i++) {
      if (i !== 0) {
        this.print(",");
        this.printSpace();
      }
      if (opts.hasRestArg && i + 1 === args.length) this.print("...");
      this.printBinding(args[i].Binding);
      if (args[i].DefaultOrNil !== null) {
        this.printSpace();
        this.print("=");
        this.printSpace();
        this.printExprWithoutLeadingNewline(args[i].DefaultOrNil, js_ast.L.LComma, printExprFlags.printExprFlagNone);
      }
    }

    if (wrap) this.print(")");
  }

  /** Go: func (p *printer) printFn(fn js_ast.Fn) (js_printer.go:906) */
  printFn(fn: js_ast.Fn): void {
    this.printFnArgs(fn.Args, { hasRestArg: fn.HasRestArg });
    this.printSpace();
    this.printBlock(fn.Body.Block);
  }

  /** Go: func (p *printer) printProperty(property js_ast.Property) (js_printer.go:1077) 的 JS 子集 */
  printProperty(property: js_ast.Property): void {
    this.printExprCommentsAtLoc(property.Loc);
    if (property.Kind === js_ast.PropertyKind.PropertySpread) {
      this.print("...");
      this.printExpr(property.ValueOrNil!, js_ast.L.LComma, printExprFlags.printExprFlagNone);
      return;
    }

    if (property.Flags & js_ast.PropertyFlags.PropertyIsStatic) {
      this.printSpaceBeforeIdentifier();
      this.print("static");
      this.printSpace();
    }

    switch (property.Kind) {
      case js_ast.PropertyKind.PropertyGetter:
        this.printSpaceBeforeIdentifier();
        this.print("get");
        this.printSpace();
        break;

      case js_ast.PropertyKind.PropertySetter:
        this.printSpaceBeforeIdentifier();
        this.print("set");
        this.printSpace();
        break;

      case js_ast.PropertyKind.PropertyAutoAccessor:
        this.printSpaceBeforeIdentifier();
        this.print("accessor");
        this.printSpace();
        break;
    }

    const valueData = property.ValueOrNil !== null ? property.ValueOrNil.Data : null;
    const isMethod = js_ast.IsMethodDefinition(property.Kind);
    if (isMethod && valueData instanceof js_ast.EFunction) {
      if (valueData.Fn.IsAsync) {
        this.printSpaceBeforeIdentifier();
        this.print("async");
        this.printSpace();
      }
      if (valueData.Fn.IsGenerator) this.print("*");
    }

    const isComputed = (property.Flags & js_ast.PropertyFlags.PropertyIsComputed) !== 0;

    if (isComputed) {
      this.print("[");
      this.printExpr(property.Key, js_ast.L.LComma, printExprFlags.printExprFlagNone);
      this.print("]");

      if (property.ValueOrNil !== null) {
        if (isMethod && valueData instanceof js_ast.EFunction) {
          this.printFn(valueData.Fn);
          return;
        }

        this.print(":");
        this.printSpace();
        this.printExprWithoutLeadingNewline(property.ValueOrNil, js_ast.L.LComma, printExprFlags.printExprFlagNone);
      }

      if (property.InitializerOrNil !== null) {
        this.printSpace();
        this.print("=");
        this.printSpace();
        this.printExprWithoutLeadingNewline(property.InitializerOrNil, js_ast.L.LComma, printExprFlags.printExprFlagNone);
      }
      return;
    }

    const key = property.Key.Data;
    if (key instanceof js_ast.EPrivateIdentifier) {
      // Go: js_printer.go:1206 —— 类私有名直接打印（不再加空格，前面的 static/accessor 已补）
      this.printIdentifier(this.renamer.NameForSymbol(key.Ref));
    } else if (key instanceof js_ast.EString) {
      if (!(property.Flags & js_ast.PropertyFlags.PropertyPreferQuotedKey) && this.canPrintIdentifierUTF16(key.Value)) {
        this.printSpaceBeforeIdentifier();

        // Use a shorthand property if the names are the same
        if (property.ValueOrNil !== null) {
          const v = property.ValueOrNil.Data;
          if (v instanceof js_ast.EIdentifier) {
            const name = this.renamer.NameForSymbol(v.Ref);
            if (canUseShorthandProperty(key.Value, name, property.Flags)) {
              this.printIdentifierUTF16(key.Value);
              if (property.InitializerOrNil !== null) {
                this.printSpace();
                this.print("=");
                this.printSpace();
                this.printExprWithoutLeadingNewline(property.InitializerOrNil, js_ast.L.LComma, printExprFlags.printExprFlagNone);
              }
              return;
            }
          }
        }

        // The JavaScript specification special-cases the property identifier "__proto__"
        if ((property.Flags & js_ast.PropertyFlags.PropertyWasShorthand) !== 0 &&
          UTF16EqualsString(key.Value, encoder.encode("__proto__"))) {
          this.print("[");
          this.printQuotedUTF16(key.Value, printQuotedFlags.printQuotedNone);
          this.print("]");
        } else {
          this.printIdentifierUTF16(key.Value);
        }
      } else {
        this.printQuotedUTF16(key.Value, printQuotedFlags.printQuotedNone);
      }
    } else if (key instanceof js_ast.ENumber) {
      this.printNumber(key.Value, js_ast.L.LLowest);
    } else {
      this.printExpr(property.Key, js_ast.L.LLowest, printExprFlags.printExprFlagNone);
    }

    if (isMethod && valueData instanceof js_ast.EFunction) {
      this.printFn(valueData.Fn);
      return;
    }

    if (property.ValueOrNil !== null) {
      this.print(":");
      this.printSpace();
      this.printExprWithoutLeadingNewline(property.ValueOrNil, js_ast.L.LComma, printExprFlags.printExprFlagNone);
    }

    if (property.InitializerOrNil !== null) {
      this.printSpace();
      this.print("=");
      this.printSpace();
      this.printExprWithoutLeadingNewline(property.InitializerOrNil, js_ast.L.LComma, printExprFlags.printExprFlagNone);
    }
  }

  /** 可选链出现在非可选节点的 target 里时必须括起来（"(a?.b).c"） */
  targetContainsOptionalChain(expr: js_ast.Expr): boolean {
    for (;;) {
      const d = expr.Data;
      if (d instanceof js_ast.EDot) {
        if (d.OptionalChain !== js_ast.OptionalChain.OptionalChainNone) return true;
        expr = d.Target;
      } else if (d instanceof js_ast.EIndex) {
        if (d.OptionalChain !== js_ast.OptionalChain.OptionalChainNone) return true;
        expr = d.Target;
      } else if (d instanceof js_ast.ECall) {
        if (d.OptionalChain !== js_ast.OptionalChain.OptionalChainNone) return true;
        expr = d.Target;
      } else {
        return false;
      }
    }
  }

  /** 打印 target；若 target 含可选链且当前节点不是可选链，则加括号 */
  printOptionalChainTarget(target: js_ast.Expr, level: js_ast.L, flags: number, isOptional: boolean): void {
    if (!isOptional && this.targetContainsOptionalChain(target)) {
      this.print("(");
      this.printExpr(target, js_ast.L.LLowest, printExprFlags.printExprFlagNone);
      this.print(")");
    } else {
      this.printExpr(target, level, flags);
    }
  }

  /** Go: func (p *printer) isUnboundEvalIdentifier(value js_ast.Expr) bool (js_printer.go:3504) */
  isUnboundEvalIdentifier(value: js_ast.Expr): boolean {
    const id = value.Data;
    if (!(id instanceof js_ast.EIdentifier)) return false;
    const name = this.renamer.NameForSymbol(id.Ref);
    return name === "eval" && this.symbols[id.Ref.InnerIndex].Kind === SymbolKind.SymbolUnbound;
  }

  /** Go: func (p *printer) isUnboundIdentifier(expr js_ast.Expr) bool (js_printer.go:1857) */
  isUnboundIdentifier(expr: js_ast.Expr): boolean {
    const id = expr.Data;
    if (!(id instanceof js_ast.EIdentifier)) return false;
    // Go: ast.FollowSymbols(p.symbols, id.Ref) —— TS 侧扁平数组按 InnerIndex 跟随 Link
    let idx = id.Ref.InnerIndex;
    const seen = new Set<number>();
    while (idx < this.symbols.length && this.symbols[idx]?.Link && this.symbols[idx].Link.InnerIndex !== idx && this.symbols[idx].Link.InnerIndex < this.symbols.length) {
      const nx = this.symbols[idx].Link.InnerIndex;
      if (seen.has(nx)) break;
      seen.add(nx); idx = nx;
    }
    return this.symbols[idx]?.Kind === SymbolKind.SymbolUnbound;
  }
  /** Go: func (p *printer) isIdentifierOrNumericConstantOrPropertyAccess(expr) bool (js_printer.go:1862) */
  isIdentifierOrNumericConstantOrPropertyAccess(expr: js_ast.Expr): boolean {
    const e = expr.Data;
    if (e instanceof js_ast.EIdentifier || e instanceof js_ast.EDot || e instanceof js_ast.EIndex) return true;
    if (e instanceof js_ast.ENumber) return !Number.isFinite(e.Value) || e.Value === Infinity || e.Value === -Infinity; // IsInf/IsNaN
    return false;
  }
  /** Go: func (p *printer) guardAgainstBehaviorChangeDueToSubstitution(expr, flags) (js_printer.go:1725) */
  guardAgainstBehaviorChangeDueToSubstitution(expr: js_ast.Expr, flags: number): js_ast.Expr {
    let wrap = false;
    if ((flags & printExprFlags.isDeleteTarget) !== 0) {
      const binary = expr.Data;
      if (!(binary instanceof js_ast.EBinary) || binary.Op !== js_ast.OpCode.BinOpComma) wrap = true;
    } else if ((flags & printExprFlags.isCallTargetOrTemplateTag) !== 0) {
      const d = expr.Data;
      if (d instanceof js_ast.EDot || d instanceof js_ast.EIndex) wrap = true;
      else if (d instanceof js_ast.EIdentifier && this.isUnboundEvalIdentifier(expr)) wrap = true;
    }
    if (wrap) {
      const right = expr;
      const e0 = new js_ast.Expr(new js_ast.ENumber(0), expr.Loc);
      const comma = new js_ast.EBinary();
      comma.Op = js_ast.OpCode.BinOpComma;
      comma.Left = e0;
      comma.Right = right;
      expr = new js_ast.Expr(comma, expr.Loc);
    }
    return expr;
  }

  /** Go: func (p *printer) printExprWithoutLeadingNewline(expr js_ast.Expr, level js_ast.L, flags printExprFlags) (js_printer.go:1971) */
  printExprWithoutLeadingNewline(expr: js_ast.Expr, level: js_ast.L, flags: number): void {
    // Go: 如果这里要打印注释，则先加括号换行，避免 ASI 改变语义。
    if (!this.options.MinifyWhitespace && this.willPrintExprCommentsAtLoc(expr.Loc)) {
      this.print("(");
      this.printNewline();
      this.indent++;
      this.printIndent();
      this.printExpr(expr, level, flags);
      this.printNewline();
      this.indent--;
      this.printIndent();
      this.print(")");
      return;
    }

    this.noLeadingNewlineHere = this.js.length;
    this.printExpr(expr, level, flags);
  }

  /** Go: printExpr 的内部实现（原来的整体 switch） */
  printExprInner(expr: js_ast.Expr, level: js_ast.L, flags: number): void {
    const e = expr.Data;

    if (e === null) return;

    // Go: js_printer.go:2029 —— EAnnotation 只打印其内层值（DCE 注解不产生输出）
    if (e instanceof js_ast.EAnnotation) {
      this.printExpr(e.Value, level, flags);
      return;
    }

    // Go: func printExprInner 的 EInlinedEnum 分支（js_printer.go:3066）。
    // 1:1（第 42 轮 sweep 链）：打印内层值，非 minify 时附加 /* comment */。
    // 这是 enum 值内联（`console.log(1 /* A */)`）字节成立的关键底座。
    if (e instanceof js_ast.EInlinedEnum) {
      this.printExpr(e.Value, level, flags);
      if (!this.options.MinifyWhitespace && !this.options.MinifyIdentifiers) {
        this.print(" /* ");
        this.print(e.Comment);
        this.print(" */");
      }
      return;
    }

    if (e instanceof js_ast.EIdentifier) {
      const name = this.renamer.NameForSymbol(e.Ref);
      this.printSpaceBeforeIdentifier();
      this.addSourceMappingForName(expr.Loc, name, e.Ref);
      this.printIdentifier(name);
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.ENumber) {
      this.addSourceMapping(expr.Loc);
      this.printNumber(e.Value, level);
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EBigInt) {
      this.addSourceMapping(expr.Loc);
      this.print(e.Value);
      this.print("n");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EString) {
      // Go: js_printer.go:2934
      this.addSourceMapping(expr.Loc);
      let flags = printQuotedFlags.printQuotedNone;
      if (e.ContainsUniqueKey) flags |= printQuotedFlags.printQuotedNoWrap;
      if (!this.options.MinifyWhitespace && e.HasPropertyKeyComment) this.print("/* @__KEY__ */ ");

      // If this was originally a template literal, print it as one as long as we're not minifying
      if (e.PreferTemplate && !this.options.MinifySyntax) {
        this.print("`");
        this.printUnquotedUTF16(e.Value, 0x60, flags);
        this.print("`");
        this.prevOpEndsWithOpenBrace = false;
        this.prevOpEndsWithCloseBrace = false;
      } else {
        this.printQuotedUTF16(e.Value, flags | printQuotedFlags.printQuotedAllowBacktick);
        this.prevOpEndsWithOpenBrace = false;
        this.prevOpEndsWithCloseBrace = false;
      }
    } else if (e instanceof js_ast.EBoolean) {
      this.printSpaceBeforeIdentifier();
      this.addSourceMapping(expr.Loc);
      this.print(e.Value ? "true" : "false");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.ENull) {
      this.printSpaceBeforeIdentifier();
      this.addSourceMapping(expr.Loc);
      this.print("null");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EUndefined) {
      // Go: printUndefined（js_printer.go:1643）——不是字面 "undefined"，而是 "void 0"。
      this.printUndefined(expr.Loc, level);
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EAwait) {
      // Go: js_printer.go:3204
      const wrap = level >= js_ast.L.LPrefix;
      if (wrap) this.print("(");
      this.printSpaceBeforeIdentifier();
      this.print("await");
      this.printSpace();
      this.printExpr(e.Value, (js_ast.L.LPrefix - 1) as js_ast.L, printExprFlags.printExprFlagNone);
      if (wrap) this.print(")");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EYield) {
      // Go: js_printer.go:3221
      const wrap = level >= js_ast.L.LAssign;
      if (wrap) this.print("(");
      this.printSpaceBeforeIdentifier();
      this.print("yield");
      if (e.ValueOrNil !== null) {
        if (e.IsStar) this.print("*");
        this.printSpace();
        this.printExprWithoutLeadingNewline(e.ValueOrNil, js_ast.L.LYield, printExprFlags.printExprFlagNone);
      }
      if (wrap) this.print(")");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EThis) {
      this.printSpaceBeforeIdentifier();
      this.print("this");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.ESuper) {
      this.printSpaceBeforeIdentifier();
      this.print("super");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.ENewTarget) {
      this.printSpaceBeforeIdentifier();
      this.print("new.target");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EIf) {
      // Go: js_printer.go:2692
      const wrap = level >= js_ast.L.LConditional;
      if (wrap) this.print("(");
      this.printExpr(e.Test, js_ast.L.LConditional, printExprFlags.printExprFlagNone);
      this.printSpace();
      this.print("?");
      this.printSpace();
      this.printExprWithoutLeadingNewline(e.Yes, js_ast.L.LYield, printExprFlags.printExprFlagNone);
      this.printSpace();
      this.print(":");
      this.printSpace();
      this.printExprWithoutLeadingNewline(e.No, js_ast.L.LYield, printExprFlags.printExprFlagNone);
      if (wrap) this.print(")");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.ENew) {
      // Go: js_printer.go:2235
      let wrap = level >= js_ast.L.LCall;
      const hasPureComment = !this.options.MinifyWhitespace && e.CanBeUnwrappedIfUnused;
      if (hasPureComment && level >= js_ast.L.LPostfix) wrap = true;
      if (wrap) this.print("(");
      if (hasPureComment) this.print("/* @__PURE__ */ ");

      this.printSpaceBeforeIdentifier();
      this.print("new");
      this.printSpace();
      // Go: js_printer.go:2256 —— new 的目标里的可选链必须加括号
      if (this.targetContainsOptionalChain(e.Target)) {
        this.print("(");
        this.printExpr(e.Target, js_ast.L.LLowest, printExprFlags.printExprFlagNone);
        this.print(")");
      } else {
        this.printExpr(e.Target, js_ast.L.LNew, printExprFlags.printExprFlagNone);
      }

      // Go: 压缩时无参且不在 postfix 语境可以省掉 "()"
      const omitParens = this.options.MinifyWhitespace && e.Args.length === 0 && level < js_ast.L.LPostfix;
      if (!omitParens) {
        const isMultiLine = !this.options.MinifyWhitespace &&
          ((e.IsMultiLine && e.Args.length > 0) ||
            this.willPrintExprCommentsForAnyOf(e.Args) ||
            this.willPrintExprCommentsAtLoc(e.CloseParenLoc));
        this.print("(");
        if (isMultiLine) this.indent++;
        for (let i = 0; i < e.Args.length; i++) {
          if (i !== 0) this.print(",");
          if (isMultiLine) {
            this.printNewline();
            this.printIndent();
          } else if (i !== 0) {
            this.printSpace();
          }
          this.printExpr(e.Args[i], js_ast.L.LComma, printExprFlags.printExprFlagNone);
        }
        if (isMultiLine) {
          if (e.Args.length > 0 || this.willPrintExprCommentsAtLoc(e.CloseParenLoc)) this.printNewline();
          this.printExprCommentsAfterCloseTokenAtLoc(e.CloseParenLoc);
          this.indent--;
          this.printIndent();
        }
        this.print(")");
      }

      if (wrap) this.print(")");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EMissing) {
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.ERegExp) {
      this.print(e.Value);
      // Need a space before the next identifier to avoid it turning into flags
      this.prevRegExpEnd = this.js.length;
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EImportMeta) {
      this.printSpaceBeforeIdentifier();
      this.print("import.meta");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.ERequireResolveString) {
      // Go: js_printer.go:2462 —— require.resolve("x")（第 111 批 import-record 底座）
      const idx = e.ImportRecordIndex;
      const recordLoc = this.importRecords[idx].Range.Loc;
      const isMultiLine = this.willPrintExprCommentsAtLoc(recordLoc) || this.willPrintExprCommentsAtLoc(e.CloseParenLoc);
      const wrap = level >= js_ast.L.LNew || (flags & printExprFlags.isNewTarget) !== 0;
      if (wrap) this.print("(");
      this.printSpaceBeforeIdentifier();
      this.addSourceMapping(expr.Loc);
      this.print("require.resolve(");
      if (isMultiLine) { this.printNewline(); this.options.Indent++; this.printIndent(); this.printExprCommentsAtLoc(recordLoc); }
      this.printPath(idx, ast.ImportKind.ImportRequireResolve);
      if (isMultiLine) { this.printNewline(); this.printExprCommentsAfterCloseTokenAtLoc(e.CloseParenLoc); this.options.Indent--; this.printIndent(); }
      if (e.CloseParenLoc.Start > expr.Loc.Start) this.addSourceMapping(e.CloseParenLoc);
      this.print(")");
      if (wrap) this.print(")");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.ERequireString || e instanceof js_ast.EImportString) {
      // Go: js_printer.go:2451/2490 —— 字符串参数 require/import 表达式
      const idx = e.ImportRecordIndex;
      const phase = e instanceof js_ast.EImportString ? this.importRecords[idx]?.Phase ?? 0 : 0;
      this.addSourceMapping(expr.Loc);
      this.printRequireOrImportExpr(idx, level, flags, e.CloseParenLoc, phase);
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EImportCall) {
      // Go: js_printer.go:2491
      const printImportAssertOrWith = e.OptionsOrNil !== null;
      const isMultiLine = !this.options.MinifyWhitespace &&
        (this.willPrintExprCommentsAtLoc(e.Expr.Loc) ||
          (printImportAssertOrWith && this.willPrintExprCommentsAtLoc(e.OptionsOrNil!.Loc)) ||
          this.willPrintExprCommentsAtLoc(e.CloseParenLoc));
      const wrap = level >= js_ast.L.LNew;
      if (wrap) this.print("(");
      this.printSpaceBeforeIdentifier();
      switch (e.Phase) {
        case ImportPhase.DeferPhase:
          this.print("import.defer(");
          break;
        case ImportPhase.SourcePhase:
          this.print("import.source(");
          break;
        default:
          this.print("import(");
      }
      if (isMultiLine) {
        this.printNewline();
        this.indent++;
        this.printIndent();
      }
      this.printExpr(e.Expr, js_ast.L.LComma, printExprFlags.printExprFlagNone);

      if (printImportAssertOrWith) {
        this.print(",");
        if (isMultiLine) {
          this.printNewline();
          this.printIndent();
        } else {
          this.printSpace();
        }
        this.printExpr(e.OptionsOrNil!, js_ast.L.LComma, printExprFlags.printExprFlagNone);
      }

      if (isMultiLine) {
        this.printNewline();
        this.printExprCommentsAfterCloseTokenAtLoc(e.CloseParenLoc);
        this.indent--;
        this.printIndent();
      }
      this.print(")");
      if (wrap) this.print(")");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EUnary) {
      const entry = js_ast.OpTable[e.Op];
      const wrap = level >= entry.Level;
      if (wrap) this.print("(");

      const isPrefix = js_ast.IsPrefix(e.Op);
      if (!isPrefix) {
        this.printExpr(e.Value, (js_ast.L.LPostfix - 1) as js_ast.L, printExprFlags.printExprFlagNone);
      }

      if (entry.IsKeyword) {
        this.printSpaceBeforeIdentifier();
        this.print(entry.Text);
        this.printSpace();
      } else {
        this.printSpaceBeforeOperator(e.Op);
        this.print(entry.Text);
        this.prevOp = e.Op;
        this.prevOpEnd = this.js.length;
      }

      if (isPrefix) {
        // Go: js_printer.go:3279-3286 —— 防止 "typeof (0, x)" → "typeof x" / "delete (0, x)" → "delete x"
        const guard =
          (e.Op === js_ast.OpCode.UnOpTypeof && !e.WasOriginallyTypeofIdentifier && this.isUnboundIdentifier(e.Value)) ||
          (e.Op === js_ast.OpCode.UnOpDelete && !e.WasOriginallyDeleteOfIdentifierOrPropertyAccess && this.isIdentifierOrNumericConstantOrPropertyAccess(e.Value));
        if (guard) {
          this.print("(0,");
          this.printSpace();
          this.printExpr(e.Value, (js_ast.L.LPrefix - 1) as js_ast.L, printExprFlags.printExprFlagNone);
          this.print(")");
        } else {
          this.printExpr(e.Value, (js_ast.L.LPrefix - 1) as js_ast.L, printExprFlags.printExprFlagNone);
        }
      }

      if (wrap) this.print(")");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EBinary) {
      // Go: binaryExprVisitor.checkAndPrepare / visitRightAndFinish (js_printer.go:3381/3471)
      // 第 113 轮：抽出为独立方法（正常打印路径调用），TS 用递归替代 Go 的 WASM 防溢出堆栈。
      const bst = this.checkAndPrepare(e, level, flags);
      if (bst === null) return;
      this.printExpr(e.Left, bst.leftLevel, bst.leftFlags);
      this.visitRightAndFinish(e, bst);
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.ECall) {
      // Go: js_printer.go:2389
      const wrap0 = level >= js_ast.L.LNew;
      const hasPureComment = !this.options.MinifyWhitespace && e.CanBeUnwrappedIfUnused;
      // Go: js_printer.go:2385 —— 带 @__PURE__ 的调用在 postfix 语境里必须括起来
      const wrap = wrap0 || (hasPureComment && level >= js_ast.L.LPostfix);
      if (wrap) this.print("(");
      if (hasPureComment) this.print("/* @__PURE__ */ ");
      const targetData = e.Target.Data;
      const isPropertyAccess = targetData instanceof js_ast.EDot || targetData instanceof js_ast.EIndex;
      if ((e.Kind !== js_ast.CallKind.DirectEval && this.isUnboundEvalIdentifier(e.Target) &&
        e.OptionalChain === js_ast.OptionalChain.OptionalChainNone) ||
        (e.Kind !== js_ast.CallKind.TargetWasOriginallyPropertyAccess && isPropertyAccess)) {
        this.print("(0,");
        this.printSpace();
        this.printExpr(e.Target, js_ast.L.LPostfix, flags);
        this.print(")");
      } else {
        this.printOptionalChainTarget(
          e.Target,
          js_ast.L.LPostfix,
          flags,
          e.OptionalChain !== js_ast.OptionalChain.OptionalChainNone,
        );
      }
      if (e.OptionalChain === js_ast.OptionalChain.OptionalChainStart) this.print("?.");
      // Go: js_printer.go:2415 —— 多行判定与逐参换行/缩进逻辑。
      const isMultiLine = !this.options.MinifyWhitespace &&
        ((e.IsMultiLine && e.Args.length > 0) ||
          this.willPrintExprCommentsForAnyOf(e.Args) ||
          this.willPrintExprCommentsAtLoc(e.CloseParenLoc));
      this.print("(");
      if (isMultiLine) this.indent++;
      for (let i = 0; i < e.Args.length; i++) {
        if (i > 0) this.print(",");
        if (isMultiLine) {
          this.printNewline();
          this.printIndent();
        } else if (i > 0) {
          this.printSpace();
        }
        this.printExpr(e.Args[i], js_ast.L.LComma, printExprFlags.printExprFlagNone);
      }
      if (isMultiLine) {
        this.printNewline();
        this.printExprCommentsAfterCloseTokenAtLoc(e.CloseParenLoc);
        this.indent--;
        this.printIndent();
      }
      this.print(")");
      if (wrap) this.print(")");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EDot) {
      this.printOptionalChainTarget(
        e.Target,
        js_ast.L.LPostfix,
        flags,
        e.OptionalChain !== js_ast.OptionalChain.OptionalChainNone,
      );
      if (e.OptionalChain === js_ast.OptionalChain.OptionalChainStart) {
        this.print("?.");
      } else {
        if (this.needSpaceBeforeDot === this.js.length) {
          // "1.toString" is a syntax error, so print "1 .toString" instead
          this.print(" ");
        }
        this.print(".");
      }
      this.printIdentifier(e.Name);
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EIndex) {
      this.printOptionalChainTarget(
        e.Target,
        js_ast.L.LPostfix,
        flags,
        e.OptionalChain !== js_ast.OptionalChain.OptionalChainNone,
      );
      if (e.OptionalChain === js_ast.OptionalChain.OptionalChainStart) this.print("?.");
      if (e.Index.Data instanceof js_ast.EPrivateIdentifier) {
        // Go: js_printer.go:2629 —— "a.#b" / "a?.#b"
        if (e.OptionalChain !== js_ast.OptionalChain.OptionalChainStart) {
          this.print(".");
        }
        this.printIdentifier(this.renamer.NameForSymbol(e.Index.Data.Ref));
        this.prevOpEndsWithOpenBrace = false;
        this.prevOpEndsWithCloseBrace = false;
        return;
      }
      this.print("[");
      this.printExpr(e.Index, js_ast.L.LLowest, printExprFlags.printExprFlagNone);
      this.print("]");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EArray) {
      // Go: js_printer.go:2180 —— 注释也会强制多行。
      let isMultiLine = (e.Items.length > 0 && !e.IsSingleLine) || this.willPrintExprCommentsAtLoc(e.CloseBracketLoc);
      if (!this.options.MinifyWhitespace && !isMultiLine) {
        for (const item of e.Items) {
          if (this.willPrintExprCommentsAtLoc(item.Loc)) {
            isMultiLine = true;
            break;
          }
        }
      }
      this.print("[");
      if (e.Items.length > 0 || isMultiLine) {
        if (isMultiLine) this.indent++;

        for (let i = 0; i < e.Items.length; i++) {
          if (i !== 0) this.print(",");
          if (isMultiLine) {
            this.printNewline();
            this.printIndent();
          } else if (i !== 0) {
            this.printSpace();
          }
          this.printExpr(e.Items[i], js_ast.L.LComma, printExprFlags.printExprFlagNone);

          // Make sure there's a comma after trailing missing items
          if (e.Items[i].Data instanceof js_ast.EMissing && i === e.Items.length - 1) {
            this.print(",");
          }
        }

        if (isMultiLine) {
          this.printNewline();
          this.printExprCommentsAfterCloseTokenAtLoc(e.CloseBracketLoc);
          this.indent--;
          this.printIndent();
        }
      }
      this.print("]");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EObject) {
      // Go: js_printer.go:2085 —— 注释也会强制多行。
      let isMultiLine = (e.Properties.length > 0 && !e.IsSingleLine) || this.willPrintExprCommentsAtLoc(e.CloseBraceLoc);
      if (!this.options.MinifyWhitespace && !isMultiLine) {
        for (const property of e.Properties) {
          if (this.willPrintExprCommentsAtLoc(property.Loc)) {
            isMultiLine = true;
            break;
          }
        }
      }
      // Go: "{ a: 1 }" 作为语句开头（或箭头函数体开头）必须包括号，否则会被当成块
      const wrap = this.stmtStart === this.js.length || this.arrowExprStart === this.js.length;
      if (wrap) this.print("(");
      this.print("{");
      if (e.Properties.length > 0 || isMultiLine) {
        if (isMultiLine) this.indent++;

        for (let i = 0; i < e.Properties.length; i++) {
          if (i !== 0) this.print(",");
          if (isMultiLine) {
            this.printNewline();
            this.printIndent();
          } else {
            this.printSpace();
          }
          this.printProperty(e.Properties[i]);
        }

        if (isMultiLine) {
          this.printNewline();
          this.printExprCommentsAfterCloseTokenAtLoc(e.CloseBraceLoc);
          this.indent--;
          this.printIndent();
        } else if (e.Properties.length > 0) {
          this.printSpace();
        }
      }
      this.print("}");
      if (wrap) this.print(")");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EArrow) {
      const wrap = e.IsParenthesized || level >= js_ast.L.LAssign;
      if (wrap) this.print("(");
      if (e.IsAsync) {
        this.printSpaceBeforeIdentifier();
        this.print("async");
        this.printSpace();
      }
      this.printFnArgs(e.Args, { hasRestArg: e.HasRestArg, isArrow: true });
      this.printSpace();
      this.print("=>");
      this.printSpace();

      let wasPrinted = false;
      if (e.Body.Block.Stmts.length === 1 && e.PreferExpr) {
        const s = e.Body.Block.Stmts[0].Data;
        if (s instanceof js_ast.SReturn && s.ValueOrNil !== null) {
          this.arrowExprStart = this.js.length;
          this.printExprWithoutLeadingNewline(s.ValueOrNil, js_ast.L.LComma, printExprFlags.printExprFlagNone);
          wasPrinted = true;
        }
      }
      if (!wasPrinted) this.printBlock(e.Body.Block);
      if (wrap) this.print(")");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EClass) {
      // Go: js_printer.go:2791
      const wrap = this.stmtStart === this.js.length || this.exportDefaultStart === this.js.length;
      if (wrap) this.print("(");
      this.printDecorators(e.Class.Decorators, printAfterDecorator.printSpaceAfterDecorator, false);
      this.printSpaceBeforeIdentifier();
      this.print("class");
      if (e.Class.Name !== null) {
        this.print(" ");
        this.printIdentifier(this.renamer.NameForSymbol(e.Class.Name.Ref));
      }
      this.printClass(e.Class);
      if (wrap) this.print(")");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EJSXElement) {
      // Go: js_printer.go:2075
      this.print("<");
      this.printJSXTag(e.TagOrNil);
      if (!e.IsTagSingleLine) this.indent++;

      for (const property of e.Properties) {
        if (e.IsTagSingleLine) {
          this.printSpace();
        } else {
          this.printNewline();
          this.printIndent();
        }

        if (property.Kind === js_ast.PropertyKind.PropertySpread) {
          if (this.willPrintExprCommentsAtLoc(property.Loc)) {
            this.print("{");
            this.printNewline();
            this.indent++;
            this.printIndent();
            this.printExprCommentsAtLoc(property.Loc);
            this.print("...");
            this.printExpr(property.ValueOrNil!, js_ast.L.LComma, printExprFlags.printExprFlagNone);
            this.printNewline();
            this.indent--;
            this.printIndent();
            this.print("}");
          } else {
            this.print("{...");
            this.printExpr(property.ValueOrNil!, js_ast.L.LComma, printExprFlags.printExprFlagNone);
            this.print("}");
          }
          continue;
        }

        this.printSpaceBeforeIdentifier();
        if (property.Key.Data instanceof js_ast.ENameOfSymbol) {
          const name = this.renamer.NameForSymbol(property.Key.Data.Ref);
          this.printIdentifier(name);
        } else if (property.Key.Data instanceof js_ast.EString) {
          this.printBytes(UTF16ToString(property.Key.Data.Value));
        } else {
          this.print("{...{");
          this.printSpace();
          this.print("[");
          this.printExpr(property.Key, js_ast.L.LComma, printExprFlags.printExprFlagNone);
          this.print("]:");
          this.printSpace();
          this.printExpr(property.ValueOrNil!, js_ast.L.LComma, printExprFlags.printExprFlagNone);
          this.printSpace();
          this.print("}}");
          continue;
        }

        const isMultiLine = this.willPrintExprCommentsAtLoc(property.ValueOrNil!.Loc);

        if ((property.Flags & js_ast.PropertyFlags.PropertyWasShorthand) !== 0) {
          // Implicit "true" value
          if (property.ValueOrNil!.Data instanceof js_ast.EBoolean && property.ValueOrNil!.Data.Value) {
            continue;
          }

          // JSX element as JSX attribute value
          if (property.ValueOrNil!.Data instanceof js_ast.EJSXElement) {
            this.print("=");
            this.printExpr(property.ValueOrNil!, js_ast.L.LLowest, printExprFlags.printExprFlagNone);
            continue;
          }
        }

        // Special-case raw text
        if (property.ValueOrNil!.Data instanceof js_ast.EJSXText) {
          this.print("=");
          this.printBytes(property.ValueOrNil!.Data.Raw);
          continue;
        }

        // Generic JS value
        this.print("={");
        if (isMultiLine) {
          this.printNewline();
          this.indent++;
          this.printIndent();
        }
        this.printExpr(property.ValueOrNil!, js_ast.L.LComma, printExprFlags.printExprFlagNone);
        if (isMultiLine) {
          this.printNewline();
          this.indent--;
          this.printIndent();
        }
        this.print("}");
      }

      if (!e.IsTagSingleLine) {
        this.indent--;
        if (e.Properties.length > 0) {
          this.printNewline();
          this.printIndent();
        }
      }
      if (e.TagOrNil !== null && e.NullableChildren.length === 0) {
        if (e.IsTagSingleLine || e.Properties.length === 0) this.printSpace();
        this.print("/>");
        this.prevOpEndsWithOpenBrace = false;
        this.prevOpEndsWithCloseBrace = false;
      } else {
        this.print(">");

        for (const childOrNil of e.NullableChildren) {
          if (childOrNil.Data instanceof js_ast.EJSXElement) {
            this.printExpr(childOrNil, js_ast.L.LLowest, printExprFlags.printExprFlagNone);
          } else if (childOrNil.Data instanceof js_ast.EJSXText) {
            this.printBytes(childOrNil.Data.Raw);
          } else if (childOrNil.Data !== null) {
            const isMultiLine = this.willPrintExprCommentsAtLoc(childOrNil.Loc);
            this.print("{");
            if (isMultiLine) {
              this.printNewline();
              this.indent++;
              this.printIndent();
            }
            this.printExpr(childOrNil, js_ast.L.LComma, printExprFlags.printExprFlagNone);
            if (isMultiLine) {
              this.printNewline();
              this.indent--;
              this.printIndent();
            }
            this.print("}");
          } else {
            this.print("{");
            if (this.willPrintExprCommentsAtLoc(childOrNil.Loc)) {
              this.printNewline();
              this.indent++;
              this.printExprCommentsAfterCloseTokenAtLoc(childOrNil.Loc);
              this.indent--;
              this.printIndent();
            }
            this.print("}");
          }
        }

        this.print("</");
        this.printJSXTag(e.TagOrNil);
        this.print(">");
        this.prevOpEndsWithOpenBrace = false;
        this.prevOpEndsWithCloseBrace = false;
      }
    } else if (e instanceof js_ast.ESpread) {
      this.print("...");
      this.printExpr(e.Value, js_ast.L.LComma, printExprFlags.printExprFlagNone);
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.ETemplate) {
      let tpl: js_ast.ETemplate = e;
      if (e.TagOrNil === null && (this.options.MinifySyntax || this.wasLazyExport)) {
        // Go js_printer.go:2955 —— minify/lazy-export 时把模板里的原始值内联（第 36 轮）
        // Inline enums and mangled properties when minifying. M1 语料无 mangled props / TS enum，
        // ENameOfSymbol / EDot-enum 两支在此口径下不产生 inlinedValue（对应 Go 的 tryToGetImportedEnumValue
        // 与 mangledPropName，均属 M2/C 批），直接进入 InlinePrimitivesIntoTemplate。
        const copy = new js_ast.ETemplate();
        copy.TagOrNil = e.TagOrNil;
        copy.HeadRaw = e.HeadRaw;
        copy.HeadCooked = e.HeadCooked;
        copy.Parts = e.Parts;
        copy.HeadLoc = e.HeadLoc;
        copy.LegacyOctalLoc = e.LegacyOctalLoc;
        copy.CanBeUnwrappedIfUnused = e.CanBeUnwrappedIfUnused;
        copy.TagWasOriginallyPropertyAccess = e.TagWasOriginallyPropertyAccess;
        const inlined = js_ast_helpers.InlinePrimitivesIntoTemplate(expr.Loc, copy);
        if (inlined.Data instanceof js_ast.EString) {
          this.printQuotedUTF16(inlined.Data.Value, printQuotedFlags.printQuotedAllowBacktick);
          return;
        } else if (inlined.Data instanceof js_ast.ETemplate) {
          tpl = inlined.Data;
        }
        // Convert no-substitution template literals into strings if it's smaller
        if (tpl.Parts.length === 0 && tpl.HeadCooked !== null) {
          this.printQuotedUTF16(tpl.HeadCooked, printQuotedFlags.printQuotedAllowBacktick);
          return;
        }
      }

      if (tpl.TagOrNil !== null) {
        const tagIsPropertyAccess = tpl.TagOrNil.Data instanceof js_ast.EDot ||
          tpl.TagOrNil.Data instanceof js_ast.EIndex;
        if (!tpl.TagWasOriginallyPropertyAccess && tagIsPropertyAccess) {
          this.print("(0,");
          this.printSpace();
          this.printExpr(tpl.TagOrNil, js_ast.L.LLowest, printExprFlags.printExprFlagNone);
          this.print(")");
        } else if (js_ast_helpers.IsOptionalChain(tpl.TagOrNil)) {
          this.print("(");
          this.printExpr(tpl.TagOrNil, js_ast.L.LLowest, printExprFlags.printExprFlagNone);
          this.print(")");
        } else {
          this.printExpr(tpl.TagOrNil, js_ast.L.LPostfix, printExprFlags.printExprFlagNone);
        }
      }
      this.print("`");
      if (tpl.TagOrNil !== null) {
        this.printBytes(tpl.HeadRaw);
      } else {
        this.printUnquotedUTF16(tpl.HeadCooked ?? new Uint16Array(0), 0x60);
      }
      for (const part of tpl.Parts) {
        this.print("${");
        this.printExpr(part.Value, js_ast.L.LLowest, printExprFlags.printExprFlagNone);
        this.print("}");
        if (tpl.TagOrNil !== null) {
          this.printBytes(part.TailRaw);
        } else {
          this.printUnquotedUTF16(part.TailCooked ?? new Uint16Array(0), 0x60);
        }
      }
      this.print("`");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EFunction) {
      // Go: js_printer.go:2760
      const wrap = e.IsParenthesized || this.stmtStart === this.js.length ||
        this.exportDefaultStart === this.js.length;
      if (wrap) this.print("(");
      this.printSpaceBeforeIdentifier();
      if (e.Fn.IsAsync) this.print("async ");
      this.print("function");
      if (e.Fn.IsGenerator) {
        this.print("*");
        this.printSpace();
      }
      if (e.Fn.Name !== null) {
        this.printSpaceBeforeIdentifier();
        this.printIdentifier(this.renamer.NameForSymbol(e.Fn.Name.Ref));
      }
      this.printFn(e.Fn);
      if (wrap) this.print(")");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else {
      throw new Error(`printer: unsupported expr ${(e as object).constructor?.name ?? "?"}`);
    }
  }

  /** Go: func (p *printer) printExpr(expr js_ast.Expr, level js_ast.L, flags printExprFlags) (js_printer.go:2005) */
  /**
   * Go: func (v *binaryExprVisitor) checkAndPrepare(p *printer) bool
   *     (js_printer.go:3381) —— 二元表达式打印的前置准备：逗号未用表达式简化、wrap 判定、
   * 左右优先级计算、私有品牌检查特例。第 113 轮从 printExpr 的 EBinary 分支抽出为独立方法。
   * 返回 null 表示该表达式已被本方法完全打印（调用方应直接返回）；否则返回传给
   * visitRightAndFinish 的局部状态。
   */
  checkAndPrepare(e: js_ast.EBinary, level: js_ast.L, flags: number): BinaryPrintState | null {
    // Go: js_printer.go:3381 —— 逗号左侧/未用右侧简化
    if (e.Op === js_ast.OpCode.BinOpComma && (flags & printExprFlags.didAlreadySimplifyUnusedExprs) === 0) {
      const left = this.simplifyUnusedExpr(e.Left);
      let right = e.Right;
      if ((flags & printExprFlags.exprResultIsUnused) !== 0) right = this.simplifyUnusedExpr(right);
      if (left.Data !== e.Left.Data || right.Data !== e.Right.Data) {
        this.printExpr(this.guardAgainstBehaviorChangeDueToSubstitution(js_ast_helpers.JoinWithComma(left, right), flags), level, flags | printExprFlags.didAlreadySimplifyUnusedExprs);
        return null;
      }
    }
    const entry = js_ast.OpTable[e.Op];
    let wrap = level >= entry.Level || (e.Op === js_ast.OpCode.BinOpIn && (flags & printExprFlags.printExprFlagForbidIn) !== 0);

    // Destructuring assignments must be parenthesized
    if ((this.stmtStart === this.js.length || this.arrowExprStart === this.js.length) &&
      e.Left.Data instanceof js_ast.EObject) {
      wrap = true;
    }

    if (wrap) this.print("(");

    // Go: js_printer.go:3454 —— "#foo in bar" 的左操作数直接打印名字（特例，已完整打印）
    if (e.Left.Data instanceof js_ast.EPrivateIdentifier && e.Op === js_ast.OpCode.BinOpIn) {
      this.printIdentifier(this.renamer.NameForSymbol(e.Left.Data.Ref));
      this.printSpace();
      this.printSpaceBeforeIdentifier();
      this.print("in");
      this.printSpace();
      this.printExpr(e.Right, js_ast.IsLeftAssociative(e.Op) ? entry.Level : (entry.Level - 1) as js_ast.L,
        flags & printExprFlags.printExprFlagForbidIn);
      if (wrap) this.print(")");
      return null;
    }

    let leftLevel = (entry.Level - 1) as js_ast.L;
    let rightLevel = (entry.Level - 1) as js_ast.L;
    if (js_ast.IsRightAssociative(e.Op)) leftLevel = entry.Level;
    if (js_ast.IsLeftAssociative(e.Op)) rightLevel = entry.Level;

    // Go: js_printer.go:3424 —— "??" 不能直接包含 "||"/"&&"
    if (e.Op === js_ast.OpCode.BinOpNullishCoalescing) {
      if (e.Left.Data instanceof js_ast.EBinary &&
        (e.Left.Data.Op === js_ast.OpCode.BinOpLogicalOr || e.Left.Data.Op === js_ast.OpCode.BinOpLogicalAnd)) {
        leftLevel = js_ast.L.LPrefix;
      }
      if (e.Right.Data instanceof js_ast.EBinary &&
        (e.Right.Data.Op === js_ast.OpCode.BinOpLogicalOr || e.Right.Data.Op === js_ast.OpCode.BinOpLogicalAnd)) {
        rightLevel = js_ast.L.LPrefix;
      }
    }

    // Go: js_printer.go:3431 —— "**" 左侧的某些一元表达式必须加括号
    if (e.Op === js_ast.OpCode.BinOpPow) {
      const leftData = e.Left.Data;
      if (leftData instanceof js_ast.EUnary && js_ast.UnaryAssignTarget(leftData.Op) === js_ast.AssignTarget.AssignTargetNone) {
        leftLevel = js_ast.L.LCall;
      } else if (leftData instanceof js_ast.EAwait) {
        leftLevel = js_ast.L.LCall;
      } else if (leftData instanceof js_ast.EUndefined) {
        leftLevel = js_ast.L.LCall;
      } else if (leftData instanceof js_ast.ENumber) {
        leftLevel = js_ast.L.LCall;
      }
    }

    return {
      entry, wrap, leftLevel,
      leftFlags: flags & printExprFlags.printExprFlagForbidIn,
      rightLevel,
      flags,
    };
  }

  /**
   * Go: func (v *binaryExprVisitor) visitRightAndFinish(p *printer)
   *     (js_printer.go:3471) —— 打印运算符与右操作数并收尾。
   */
  visitRightAndFinish(e: js_ast.EBinary, st: BinaryPrintState): void {
    if (e.Op !== js_ast.OpCode.BinOpComma) {
      this.printSpace();
    }
    if (st.entry.IsKeyword) {
      this.printSpaceBeforeIdentifier();
      this.print(st.entry.Text);
    } else {
      this.printSpaceBeforeOperator(e.Op);
      this.print(st.entry.Text);
    }
    this.printSpace();

    this.printExpr(e.Right, st.rightLevel, st.flags & printExprFlags.printExprFlagForbidIn);
    if (st.wrap) this.print(")");
    this.prevOpEndsWithOpenBrace = false;
    this.prevOpEndsWithCloseBrace = false;
  }

  printExpr(expr: js_ast.Expr, level: js_ast.L, flags: number): void {
    // Go: js_printer.go:2016 —— minify 时对 EUnary/EBinary/EIf 做一次打印期常量折叠
    // （跨模块内联常量位运算压缩）。parentWasUnaryOrBinaryOrIfTest 时跳过避免 O(n²)。
    if (this.options.MinifySyntax && (flags & printExprFlags.parentWasUnaryOrBinaryOrIfTest) === 0) {
      const d = expr.Data;
      if (d instanceof js_ast.EUnary || d instanceof js_ast.EBinary || d instanceof js_ast.EIf) {
        expr = this.lateConstantFoldUnaryOrBinaryOrIfExpr(expr);
      }
    }
    this.printExprCommentsAtLoc(expr.Loc);
    this.printExprInner(expr, level, flags);
  }

  /** Go: func (p *printer) printDecls(keyword string, decls []js_ast.Decl, flags printExprFlags) (js_printer.go:3734) */
  printDecls(keyword: string, decls: js_ast.Decl[], flags: number): void {
    this.print(keyword);
    // Go: printSpace()（压缩时不出空格）；压缩下 "const x" 的空格由 printBinding 的
    // printSpaceBeforeIdentifier() 补，而 "const{" 不需要空格——与 Go 完全一致。
    this.printSpace();
    for (let i = 0; i < decls.length; i++) {
      if (i > 0) {
        this.print(",");
        this.printSpace();
      }
      this.printBinding(decls[i].Binding);
      if (decls[i].ValueOrNil !== null) {
        this.printSpace();
        this.print("=");
        this.printSpace();
        this.printExprWithoutLeadingNewline(decls[i].ValueOrNil!, js_ast.L.LComma, flags);
      }
    }
  }

  /** Go: func (p *printer) printClauseAlias(loc logger.Loc, alias string) (js_printer.go:404) */
  printClauseAlias(loc: Loc, alias: string): void {
    this.addSourceMapping(loc);
    if (IsIdentifier(encoder.encode(alias))) {
      this.printSpaceBeforeIdentifier();
      this.printIdentifier(alias);
    } else {
      this.printQuotedUTF8(alias, printQuotedFlags.printQuotedNone);
    }
  }

  /** Go: func (p *printer) printImportCallAssertOrWith(a *ImportAssertOrWith, outerIsMultiLine bool) (js_printer.go:3967) —— 第 111 批 */
  printImportCallAssertOrWith(assertOrWith: ast.ImportAssertOrWith | null, outerIsMultiLine: boolean): void {
    if (assertOrWith === null ||
      (Has(this.options.UnsupportedFeatures, JSFeature.ImportAssertions) &&
        Has(this.options.UnsupportedFeatures, JSFeature.ImportAttributes))) return;

    const isMultiLine = this.willPrintExprCommentsAtLoc(assertOrWith.KeywordLoc) ||
      this.willPrintExprCommentsAtLoc(assertOrWith.InnerOpenBraceLoc) ||
      this.willPrintExprCommentsAtLoc(assertOrWith.OuterCloseBraceLoc);

    this.print(",");
    if (outerIsMultiLine) { this.printNewline(); this.printIndent(); }
    else this.printSpace();
    this.printExprCommentsAtLoc(assertOrWith.OuterOpenBraceLoc);
    this.addSourceMapping(assertOrWith.OuterOpenBraceLoc);
    this.print("{");

    if (isMultiLine) { this.printNewline(); this.options.Indent++; this.printIndent(); }
    else this.printSpace();

    this.printExprCommentsAtLoc(assertOrWith.KeywordLoc);
    this.addSourceMapping(assertOrWith.KeywordLoc);
    this.print(AssertOrWithKeywordString(assertOrWith.Keyword));
    this.print(":");

    if (this.willPrintExprCommentsAtLoc(assertOrWith.InnerOpenBraceLoc)) {
      this.printNewline();
      this.options.Indent++;
      this.printIndent();
      this.printExprCommentsAtLoc(assertOrWith.InnerOpenBraceLoc);
      this.printImportAssertOrWithClause(assertOrWith);
      this.options.Indent--;
    } else {
      this.printSpace();
      this.printImportAssertOrWithClause(assertOrWith);
    }

    if (isMultiLine) {
      this.printNewline();
      this.printExprCommentsAfterCloseTokenAtLoc(assertOrWith.OuterCloseBraceLoc);
      this.options.Indent--;
      this.printIndent();
    } else this.printSpace();

    this.addSourceMapping(assertOrWith.OuterCloseBraceLoc);
    this.print("}");
  }

  /** Go: func (p *printer) printRequireOrImportExpr(record index, level, flags, closeParenLoc, phase) (js_printer.go:1399) —— 第 111 批 */
  printRequireOrImportExpr(importRecordIndex: number, level: js_ast.L, flags: number, closeParenLoc: Loc, phase: ImportPhase): void {
    const record = this.importRecords[importRecordIndex];
    let closed = false;
    const close = () => { if (!closed) { closed = true; this.print(")"); } };

    if (level >= js_ast.L.LNew || (flags & printExprFlags.isNewTarget) !== 0) {
      this.print("(");
      level = js_ast.L.LLowest;
    }

    if (record.SourceIndex === 0) {
      // External "require()"
      if (record.Kind !== ast.ImportKind.ImportDynamic) {
        const wrapWithToESM = ast.Has(record.Flags, ast.ImportRecordFlags.WrapWithToESM);
        if (wrapWithToESM) {
          this.printSpaceBeforeIdentifier();
          this.printIdentifier(this.renamer.NameForSymbol(this.options.ToESMRef));
          this.print("(");
        }
        this.printSpaceBeforeIdentifier();
        if (ast.Has(record.Flags, ast.ImportRecordFlags.CallRuntimeRequire)) {
          this.printIdentifier(this.renamer.NameForSymbol(this.options.RuntimeRequireRef));
        } else this.print("require");

        const isMultiLine = this.willPrintExprCommentsAtLoc(record.Range.Loc) || this.willPrintExprCommentsAtLoc(closeParenLoc);
        this.print("(");
        if (isMultiLine) { this.printNewline(); this.options.Indent++; this.printIndent(); }
        this.printExprCommentsAtLoc(record.Range.Loc);
        this.printPath(importRecordIndex, ast.ImportKind.ImportRequire);
        if (isMultiLine) {
          this.printNewline();
          this.printExprCommentsAfterCloseTokenAtLoc(closeParenLoc);
          this.options.Indent--;
          this.printIndent();
        }
        if (closeParenLoc.Start > record.Range.Loc.Start) this.addSourceMapping(closeParenLoc);
        this.print(")");
        if (wrapWithToESM) {
          if (js_ast.IsESM(this.moduleType)) { this.print(","); this.printSpace(); this.print("1"); }
          this.print(")");
        }
        if (level >= js_ast.L.LNew || (flags & printExprFlags.isNewTarget) !== 0) this.print(")");
        return;
      }

      // External "import()"
      let kind: number = ast.ImportKind.ImportDynamic;
      if (!Has(this.options.UnsupportedFeatures, JSFeature.DynamicImport)) {
        this.printSpaceBeforeIdentifier();
        if (phase === ImportPhase.DeferPhase) this.print("import.defer(");
        else if (phase === ImportPhase.SourcePhase) this.print("import.source(");
        else this.print("import(");
      } else {
        kind = ast.ImportKind.ImportRequire;
        this.printSpaceBeforeIdentifier();
        this.print("Promise.resolve()");
        this.printDotThenPrefix();
        this.printSpaceBeforeIdentifier();
        if (ast.Has(record.Flags, ast.ImportRecordFlags.CallRuntimeRequire)) {
          this.printIdentifier(this.renamer.NameForSymbol(this.options.RuntimeRequireRef));
        } else this.print("require");
        this.print("(");
      }
      const isMultiLine = this.willPrintExprCommentsAtLoc(record.Range.Loc) ||
        this.willPrintExprCommentsAtLoc(closeParenLoc) ||
        (record.AssertOrWith !== null &&
          !Has(this.options.UnsupportedFeatures, JSFeature.DynamicImport) &&
          (!Has(this.options.UnsupportedFeatures, JSFeature.ImportAssertions) ||
            !Has(this.options.UnsupportedFeatures, JSFeature.ImportAttributes)) &&
          this.willPrintExprCommentsAtLoc(record.AssertOrWith.OuterOpenBraceLoc));
      if (isMultiLine) { this.printNewline(); this.options.Indent++; this.printIndent(); }
      this.printExprCommentsAtLoc(record.Range.Loc);
      this.printPath(importRecordIndex, kind);
      if (!Has(this.options.UnsupportedFeatures, JSFeature.DynamicImport)) {
        this.printImportCallAssertOrWith(record.AssertOrWith, isMultiLine);
      }
      if (isMultiLine) {
        this.printNewline();
        this.printExprCommentsAfterCloseTokenAtLoc(closeParenLoc);
        this.options.Indent--;
        this.printIndent();
      }
      if (closeParenLoc.Start > record.Range.Loc.Start) this.addSourceMapping(closeParenLoc);
      this.print(")");
      if (Has(this.options.UnsupportedFeatures, JSFeature.DynamicImport)) this.printDotThenSuffix();
      if (level >= js_ast.L.LNew || (flags & printExprFlags.isNewTarget) !== 0) this.print(")");
      return;
    }

    // Internal import/require —— 需 bundler meta 底座；本批走外部路径，内部路径 faithful 保留最小实现
    const meta = this.options.RequireOrImportMetaForSource?.(record.SourceIndex) ?? new RequireOrImportMeta();
    if ((flags & printExprFlags.exprResultIsUnused) !== 0) meta.ExportsRef = new ast.Ref(0xffffffff, 0xffffffff);
    const Invalid = new ast.Ref(0xffffffff, 0xffffffff);
    if (record.Kind === ast.ImportKind.ImportDynamic && meta.IsWrapperAsync) {
      this.printSpaceBeforeIdentifier();
      this.printIdentifier(this.renamer.NameForSymbol(meta.WrapperRef));
      this.print("()");
      if (!meta.ExportsRef.Equals(Invalid)) { this.printDotThenPrefix(); this.printSpaceBeforeIdentifier(); this.printIdentifier(this.renamer.NameForSymbol(meta.ExportsRef)); this.printDotThenSuffix(); }
      if (level >= js_ast.L.LNew || (flags & printExprFlags.isNewTarget) !== 0) this.print(")");
      return;
    }
    if (record.Kind === ast.ImportKind.ImportDynamic) {
      this.printSpaceBeforeIdentifier();
      this.print("Promise.resolve()");
      level = this.printDotThenPrefix();
    }
    if (!meta.ExportsRef.Equals(Invalid) && level >= js_ast.L.LComma) { this.print("("); closed = false; }
    const wrapWithToESM = ast.Has(record.Flags, ast.ImportRecordFlags.WrapWithToESM);
    if (wrapWithToESM) {
      this.printSpaceBeforeIdentifier();
      this.printIdentifier(this.renamer.NameForSymbol(this.options.ToESMRef));
      this.print("(");
    }
    this.printSpaceBeforeIdentifier();
    this.printIdentifier(this.renamer.NameForSymbol(meta.WrapperRef));
    this.print("()");
    if (!meta.ExportsRef.Equals(Invalid)) {
      this.print(","); this.printSpace();
      const wrapWithTpCJS = ast.Has(record.Flags, ast.ImportRecordFlags.WrapWithToCJS);
      if (wrapWithTpCJS) { this.printIdentifier(this.renamer.NameForSymbol(this.options.ToCommonJSRef)); this.print("("); }
      this.printIdentifier(this.renamer.NameForSymbol(meta.ExportsRef));
      if (wrapWithTpCJS) this.print(")");
    }
    if (wrapWithToESM) {
      if (js_ast.IsESM(this.moduleType)) { this.print(","); this.printSpace(); this.print("1"); }
      this.print(")");
    }
    if (record.Kind === ast.ImportKind.ImportDynamic) this.printDotThenSuffix();
    if (level >= js_ast.L.LNew || (flags & printExprFlags.isNewTarget) !== 0) this.print(")");
    void close;
  }

  /** Go: func (p *printer) printPath(importRecordIndex uint32, importKind ast.ImportKind) (js_printer.go:3931) */
  printPath(importRecordIndex: number, importKind: number = ast.ImportKind.ImportStmt): void {
    const record = this.importRecords[importRecordIndex];
    this.addSourceMapping(record.Range.Loc);
    this.printQuotedUTF8(record.Path.Text, printQuotedFlags.printQuotedNone);

    // Go: js_printer.go:3948 —— 仅静态 import 语句就地打 assert/with；import() 由 printImportCallAssertOrWith 单独打
    if (record.AssertOrWith !== null && importKind === ast.ImportKind.ImportStmt) {
      this.printSpace();
      this.print(AssertOrWithKeywordString(record.AssertOrWith.Keyword));
      this.printSpace();
      this.printImportAssertOrWithClause(record.AssertOrWith);
    }
  }

  /** Go: func (p *printer) printImportAssertOrWithClause(a ast.ImportAssertOrWith) (js_printer.go:4025) */
  printImportAssertOrWithClause(assertOrWith: ast.ImportAssertOrWith): void {
    let isMultiLine = this.willPrintExprCommentsAtLoc(assertOrWith.InnerCloseBraceLoc);
    if (!isMultiLine) {
      for (const entry of assertOrWith.Entries) {
        if (this.willPrintExprCommentsAtLoc(entry.KeyLoc) || this.willPrintExprCommentsAtLoc(entry.ValueLoc)) {
          isMultiLine = true;
          break;
        }
      }
    }

    this.print("{");
    if (isMultiLine) this.indent++;

    for (let i = 0; i < assertOrWith.Entries.length; i++) {
      const entry = assertOrWith.Entries[i];
      if (i > 0) this.print(",");
      if (isMultiLine) {
        this.printNewline();
        this.printIndent();
      } else {
        this.printSpace();
      }

      this.printExprCommentsAtLoc(entry.KeyLoc);
      const key = new Uint16Array(entry.Key);
      if (!entry.PreferQuotedKey && this.canPrintIdentifierUTF16(key)) {
        this.printSpaceBeforeIdentifier();
        this.printIdentifierUTF16(key);
      } else {
        this.printQuotedUTF16(key, printQuotedFlags.printQuotedNone);
      }

      this.print(":");

      if (this.willPrintExprCommentsAtLoc(entry.ValueLoc)) {
        this.printNewline();
        this.indent++;
        this.printIndent();
        this.printExprCommentsAtLoc(entry.ValueLoc);
        this.printQuotedUTF16(new Uint16Array(entry.Value), printQuotedFlags.printQuotedNone);
        this.indent--;
      } else {
        this.printSpace();
        this.printQuotedUTF16(new Uint16Array(entry.Value), printQuotedFlags.printQuotedNone);
      }
    }

    if (isMultiLine) {
      this.printNewline();
      this.printExprCommentsAfterCloseTokenAtLoc(assertOrWith.InnerCloseBraceLoc);
      this.indent--;
      this.printIndent();
    } else if (assertOrWith.Entries.length > 0) {
      this.printSpace();
    }

    this.print("}");
  }

  /** Go: func (p *printer) printDeclStmt(isExport bool, keyword string, decls []js_ast.Decl) (js_printer.go:3702) */
  printDeclStmt(isExport: boolean, keyword: string, decls: js_ast.Decl[]): void {
    if (isExport) {
      this.print("export");
      this.print(" ");
    }
    this.printDecls(keyword, decls, printExprFlags.printExprFlagNone);
    this.printSemicolonAfterStatement();
  }

  /** Go: func (p *printer) printForLoopInit(init js_ast.Stmt, flags printExprFlags) (js_printer.go:3712) */
  printForLoopInit(init: js_ast.Stmt, flags: number): void {
    const s = init.Data!;
    if (s instanceof js_ast.SExpr) {
      this.printExpr(s.Value, js_ast.L.LLowest, flags);
    } else if (s instanceof js_ast.SLocal) {
      const keyword = s.Kind === js_ast.LocalKind.LocalConst ? "const"
        : s.Kind === js_ast.LocalKind.LocalLet ? "let"
        : s.Kind === js_ast.LocalKind.LocalUsing ? "using"
        : s.Kind === js_ast.LocalKind.LocalAwaitUsing ? "await using" : "var";
      this.printDecls(keyword, s.Decls, flags);
    } else {
      throw new Error("Internal error");
    }
  }

  /** Go: func (p *printer) printBlock(loc logger.Loc, block js_ast.SBlock) (js_printer.go:3772) */
  printBlock(block: js_ast.SBlock): void {
    this.print("{");
    this.printNewline();

    this.indent++;
    for (const stmt of block.Stmts) {
      this.printSemicolonIfNeeded();
      // Go 是「每个 printStmt case 自己打缩进」（如 js_printer.go:4131-4133 的 SComment
      // 自己调 p.printIndent()）；TS 的 printBlock 统一打了一次，所以 SComment 会重复
      // 打一次缩进（注释行 4 空格 vs Go 的 2 空格，M1 差异簇 4 例）。此处跳过。
      if (!(stmt.Data instanceof js_ast.SComment)) this.printIndent();
      this.printStmt(stmt, printStmtFlags.printStmtFlagNone);
    }
    this.indent--;
    this.needsSemicolon = false;

    this.printIndent();
    this.print("}");
  }

  /** Go: func (p *printer) printDecorators(decorators []js_ast.Decorator, defaultMode printAfterDecorator) (js_printer.go:919) */
  printDecorators(
    decorators: js_ast.Decorator[],
    defaultMode: number,
    indentAlreadyPrinted: boolean,
  ): boolean {
    let oldMode = defaultMode;

    for (let i = 0; i < decorators.length; i++) {
      const decorator = decorators[i];
      let wrap = false;
      let wasCallTarget = false;
      let expr = decorator.Value;
      const mode = decorator.OmitNewlineAfter
        ? printAfterDecorator.printSpaceAfterDecorator
        : defaultMode;

      outer: for (;;) {
        wasCallTarget = false;
        const data = expr.Data;
        if (data instanceof js_ast.EIdentifier) {
          // "@foo"
          break outer;
        } else if (data instanceof js_ast.ECall) {
          // "@foo()"
          expr = data.Target;
          wasCallTarget = true;
          continue;
        } else if (data instanceof js_ast.EDot) {
          // "@foo.bar"
          if (this.canPrintIdentifier(data.Name)) {
            expr = data.Target;
            continue;
          }
          break;
        } else if (data instanceof js_ast.EIndex) {
          // "@foo.#bar"
          if (data.Index.Data instanceof js_ast.EPrivateIdentifier) {
            expr = data.Target;
            continue;
          }
          break;
        }
        // "@(foo + bar)" / "@(() => {})"
        wrap = true;
        break outer;
      }
      void wasCallTarget;

      if (oldMode === printAfterDecorator.printNewlineAfterDecorator && !(i === 0 && indentAlreadyPrinted)) {
        this.printIndent();
      }

      this.print("@");
      if (wrap) this.print("(");
      this.printExpr(decorator.Value, js_ast.L.LLowest, printExprFlags.printExprFlagNone);
      if (wrap) this.print(")");

      if (mode === printAfterDecorator.printNewlineAfterDecorator) {
        this.printNewline();
      } else {
        this.printSpace();
      }
      oldMode = mode;
    }

    return oldMode === printAfterDecorator.printSpaceAfterDecorator;
  }

  /** Go: func (p *printer) printClass(class js_ast.Class) (js_printer.go:1028) */
  printClass(cls: js_ast.Class): void {
    if (cls.ExtendsOrNil !== null) {
      this.print(" extends");
      this.printSpace();
      this.printExpr(cls.ExtendsOrNil, (js_ast.L.LNew - 1) as js_ast.L, printExprFlags.printExprFlagNone);
    }
    this.printSpace();

    this.print("{");
    this.printNewline();
    this.indent++;

    for (const item of cls.Properties) {
      this.printSemicolonIfNeeded();
      const omitIndent = this.printDecorators(item.Decorators, printAfterDecorator.printNewlineAfterDecorator, false);
      if (!omitIndent) this.printIndent();

      if (item.Kind === js_ast.PropertyKind.PropertyClassStaticBlock) {
        this.print("static");
        this.printSpace();
        this.printBlock(item.ClassStaticBlock!.Block);
        this.printNewline();
        continue;
      }

      this.printProperty(item);

      // Need semicolons after class fields
      if (item.ValueOrNil === null) {
        this.printSemicolonAfterStatement();
      } else {
        this.printNewline();
      }
    }

    this.needsSemicolon = false;
    this.printExprCommentsAfterCloseTokenAtLoc(cls.CloseBraceLoc);
    this.indent--;
    this.printIndent();
    this.print("}");
  }

  /** Go: func (p *printer) printBody(body js_ast.Stmt, isSingleLine bool) (js_printer.go:3756) */
  printBody(body: js_ast.Stmt, isSingleLine: boolean): void {
    if (body.Data instanceof js_ast.SBlock) {
      this.printSpace();
      this.printBlock(body.Data);
      this.printNewline();
    } else if (isSingleLine) {
      this.printSpace();
      this.printStmt(body, printStmtFlags.printStmtFlagIsInOneLineStatement);
    } else {
      this.printNewline();
      this.indent++;
      this.printIndent();
      this.printStmt(body, printStmtFlags.printStmtFlagNone);
      this.indent--;
    }
  }

  /** Go: func wrapToAvoidAmbiguousElse(s js_ast.S) bool (js_printer.go:3792) */
  wrapToAvoidAmbiguousElse(s: js_ast.S): boolean {
    for (; ;) {
      if (s instanceof js_ast.SIf) {
        if (s.NoOrNil === null || s.NoOrNil.Data === null) return true;
        s = s.NoOrNil.Data;
      } else if (s instanceof js_ast.SFor) {
        s = s.Body.Data!;
      } else if (s instanceof js_ast.SWhile) {
        s = s.Body.Data!;
      } else if (s instanceof js_ast.SWith) {
        s = s.Body.Data!;
      } else if (s instanceof js_ast.SDoWhile || s instanceof js_ast.SLabel) {
        return true;
      } else {
        return false;
      }
    }
  }

  /** Go: func (p *printer) printIf(s *js_ast.SIf) (js_printer.go:3825) */
  printIf(s: js_ast.SIf): void {
    this.printSpaceBeforeIdentifier();
    this.print("if");
    this.printSpace();
    this.print("(");
    this.printExpr(s.Test, js_ast.L.LLowest, printExprFlags.printExprFlagNone);
    this.print(")");

    const no = s.NoOrNil;

    if (s.Yes.Data instanceof js_ast.SBlock) {
      this.printSpace();
      this.printBlock(s.Yes.Data);
      if (no !== null) this.printSpace();
      else this.printNewline();
    } else if (this.wrapToAvoidAmbiguousElse(s.Yes.Data!)) {
      this.printSpace();
      this.print("{");
      this.printNewline();

      this.indent++;
      this.printIndent();
      this.printStmt(s.Yes, printStmtFlags.printStmtFlagNone);
      this.indent--;
      this.needsSemicolon = false;

      this.printIndent();
      this.print("}");

      if (no !== null) this.printSpace();
      else this.printNewline();
    } else {
      this.printBody(s.Yes, s.IsSingleLineYes);
      if (no !== null) this.printIndent();
    }

    if (no !== null) {
      this.printSemicolonIfNeeded();
      this.printSpaceBeforeIdentifier();
      this.print("else");

      if (no.Data instanceof js_ast.SBlock) {
        this.printSpace();
        this.printBlock(no.Data);
        this.printNewline();
      } else if (no.Data instanceof js_ast.SIf) {
        this.printIf(no.Data);
      } else {
        this.printBody(no, s.IsSingleLineNo);
      }
    }
  }

  /** Go: func (p *printer) printStmt(stmt js_ast.Stmt, flags printStmtFlags) (js_printer.go:4101) */
  printStmt(stmt: js_ast.Stmt, flags: number): void {
    const s = stmt.Data;
    if (s === null) return;

    if (s instanceof js_ast.SEmpty) {
      this.print(";");
      this.printNewline();
    } else if (s instanceof js_ast.SComment) {
      // Go: js_printer.go:4107
      const text = s.Text;
      if (s.IsLegalComment) {
        // Go config.LegalComments: 0=Inline 1=None 2=EndOfFile 3=Linked 4=External
        switch (this.options.LegalComments) {
          case 1:
            return;
          case 2:
          case 3:
          case 4:
            // Don't record the same legal comment more than once per file
            if (this.hasLegalComment.has(text)) return;
            this.hasLegalComment.add(text);
            this.extractedLegalComments.push(text);
            return;
        }
      }
      this.printIndent();
      this.printIndentedComment(text);
    } else if (s instanceof js_ast.SDirective) {
      this.printQuotedUTF16(s.Value, printQuotedFlags.printQuotedNone);
      this.printSemicolonAfterStatement();
    } else if (s instanceof js_ast.SExpr) {
      // "if (x) !y; else z" 之类需要括号的地方暂不处理
      this.stmtStart = this.js.length;
      this.printExpr(s.Value, js_ast.L.LLowest, printExprFlags.printExprFlagNone);
      this.printSemicolonAfterStatement();
    } else if (s instanceof js_ast.SReturn) {
      this.print("return");
      if (s.ValueOrNil !== null) {
        this.print(" ");
        this.printExprWithoutLeadingNewline(s.ValueOrNil, js_ast.L.LLowest, printExprFlags.printExprFlagNone);
      }
      this.printSemicolonAfterStatement();
    } else if (s instanceof js_ast.SLocal) {
      const keyword = s.Kind === js_ast.LocalKind.LocalConst ? "const"
        : s.Kind === js_ast.LocalKind.LocalLet ? "let"
        : s.Kind === js_ast.LocalKind.LocalUsing ? "using"
        : s.Kind === js_ast.LocalKind.LocalAwaitUsing ? "await using" : "var";
      this.printDeclStmt(s.IsExport, keyword, s.Decls);
    } else if (s instanceof js_ast.SFunction) {
      this.printSpaceBeforeIdentifier();
      if (s.IsExport) this.print("export ");
      if (s.Fn.IsAsync) this.print("async ");
      this.print("function");
      if (s.Fn.IsGenerator) {
        this.print("*");
        this.printSpace();
      }
      this.printSpaceBeforeIdentifier();
      this.printIdentifier(this.renamer.NameForSymbol(s.Fn.Name!.Ref));
      this.printFn(s.Fn);
      this.printNewline();
    } else if (s instanceof js_ast.SClass) {
      this.printSpaceBeforeIdentifier();
      if (s.Class.Decorators.length > 0) {
        const omitIndent = this.printDecorators(s.Class.Decorators, printAfterDecorator.printNewlineAfterDecorator, true);
        if (!omitIndent) this.printIndent();
      }
      if (s.IsExport) this.print("export ");
      this.print("class ");
      this.printIdentifier(this.renamer.NameForSymbol(s.Class.Name!.Ref));
      this.printClass(s.Class);
      this.printNewline();
    } else if (s instanceof js_ast.SLabel) {
      // Go: js_printer.go:4518
      this.printSpaceBeforeIdentifier();
      this.printIdentifier(this.renamer.NameForSymbol(s.Name.Ref));
      this.print(":");
      this.printBody(s.Stmt, s.IsSingleLineStmt);
    } else if (s instanceof js_ast.SBreak) {
      this.printSpaceBeforeIdentifier();
      this.print("break");
      if (s.Label !== null) {
        this.print(" ");
        this.printIdentifier(this.renamer.NameForSymbol(s.Label.Ref));
      }
      this.printSemicolonAfterStatement();
    } else if (s instanceof js_ast.SContinue) {
      this.printSpaceBeforeIdentifier();
      this.print("continue");
      if (s.Label !== null) {
        this.print(" ");
        this.printIdentifier(this.renamer.NameForSymbol(s.Label.Ref));
      }
      this.printSemicolonAfterStatement();
    } else if (s instanceof js_ast.SThrow) {
      this.printSpaceBeforeIdentifier();
      this.print("throw");
      this.printSpace();
      this.printExprWithoutLeadingNewline(s.Value, js_ast.L.LLowest, printExprFlags.printExprFlagNone);
      this.printSemicolonAfterStatement();
    } else if (s instanceof js_ast.SWhile) {
      this.printSpaceBeforeIdentifier();
      this.print("while");
      this.printSpace();
      this.print("(");
      this.printExpr(s.Test, js_ast.L.LLowest, printExprFlags.printExprFlagNone);
      this.print(")");
      this.printBody(s.Body, s.IsSingleLineBody);
    } else if (s instanceof js_ast.SDoWhile) {
      this.printSpaceBeforeIdentifier();
      this.print("do");
      if (s.Body.Data instanceof js_ast.SBlock) {
        this.printSpace();
        this.printBlock(s.Body.Data);
        this.printSpace();
      } else {
        this.printNewline();
        this.indent++;
        this.printIndent();
        this.printStmt(s.Body, printStmtFlags.printStmtFlagNone);
        this.printSemicolonIfNeeded();
        this.indent--;
        this.printIndent();
      }
      this.print("while");
      this.printSpace();
      this.print("(");
      this.printExpr(s.Test, js_ast.L.LLowest, printExprFlags.printExprFlagNone);
      this.print(")");
      this.printSemicolonAfterStatement();
    } else if (s instanceof js_ast.SFor) {
      this.printSpaceBeforeIdentifier();
      this.print("for");
      this.printSpace();
      this.print("(");
      if (s.InitOrNil !== null) {
        this.printForLoopInit(s.InitOrNil, printExprFlags.printExprFlagForbidIn);
      }
      this.print(";");
      this.printSpace();
      if (s.TestOrNil !== null) {
        this.printExpr(s.TestOrNil, js_ast.L.LLowest, printExprFlags.printExprFlagNone);
      }
      this.print(";");
      this.printSpace();
      if (s.UpdateOrNil !== null) {
        this.printExpr(s.UpdateOrNil, js_ast.L.LLowest, printExprFlags.printExprFlagNone);
      }
      this.print(")");
      this.printBody(s.Body, s.IsSingleLineBody);
    } else if (s instanceof js_ast.SForIn) {
      this.printSpaceBeforeIdentifier();
      this.print("for");
      this.printSpace();
      this.print("(");
      this.printForLoopInit(s.Init, printExprFlags.printExprFlagNone);
      this.printSpace();
      this.printSpaceBeforeIdentifier();
      this.print("in");
      this.printSpace();
      this.printExpr(s.Value, js_ast.L.LLowest, printExprFlags.printExprFlagNone);
      this.print(")");
      this.printBody(s.Body, s.IsSingleLineBody);
    } else if (s instanceof js_ast.SForOf) {
      this.printSpaceBeforeIdentifier();
      this.print("for");
      if (s.Await.Len > 0) this.print(" await");
      this.printSpace();
      this.print("(");
      this.printForLoopInit(s.Init, printExprFlags.printExprFlagNone);
      this.printSpace();
      this.printSpaceBeforeIdentifier();
      this.print("of");
      this.printSpace();
      this.printExpr(s.Value, js_ast.L.LComma, printExprFlags.printExprFlagNone);
      this.print(")");
      this.printBody(s.Body, s.IsSingleLineBody);
    } else if (s instanceof js_ast.STry) {
      this.printSpaceBeforeIdentifier();
      this.print("try");
      this.printSpace();
      this.printBlock(s.Block);

      if (s.Catch !== null) {
        this.printSpace();
        this.print("catch");
        if (s.Catch.BindingOrNil !== null) {
          this.printSpace();
          this.print("(");
          this.printBinding(s.Catch.BindingOrNil);
          this.print(")");
        }
        this.printSpace();
        this.printBlock(s.Catch.Block);
      }

      if (s.Finally !== null) {
        this.printSpace();
        this.print("finally");
        this.printSpace();
        this.printBlock(s.Finally.Block);
      }

      this.printNewline();
    } else if (s instanceof js_ast.SWith) {
      // Go: js_printer.go:4514
      this.printSpaceBeforeIdentifier();
      this.print("with");
      this.printSpace();
      this.print("(");
      if (this.willPrintExprCommentsAtLoc(s.Value.Loc)) {
        this.printNewline();
        this.indent++;
        this.printIndent();
        this.printExpr(s.Value, js_ast.L.LLowest, printExprFlags.printExprFlagNone);
        this.printNewline();
        this.indent--;
        this.printIndent();
      } else {
        this.printExpr(s.Value, js_ast.L.LLowest, printExprFlags.printExprFlagNone);
      }
      this.print(")");
      this.withNesting++;
      this.printBody(s.Body, s.IsSingleLineBody);
      this.withNesting--;
    } else if (s instanceof js_ast.SSwitch) {
      this.printSpaceBeforeIdentifier();
      this.print("switch");
      this.printSpace();
      this.print("(");
      this.printExpr(s.Test, js_ast.L.LLowest, printExprFlags.printExprFlagNone);
      this.print(")");
      this.printSpace();
      this.print("{");
      this.printNewline();
      this.indent++;

      for (const c of s.Cases) {
        this.printSemicolonIfNeeded();
        this.printIndent();
        // Go: js_printer.go:4673 —— case 前的注释（如 TextureUtils.js 的参考链接）。
        this.printExprCommentsAtLoc(c.Loc);

        if (c.ValueOrNil !== null) {
          this.print("case");
          this.printSpace();
          this.printExpr(c.ValueOrNil, js_ast.L.LLogicalAnd, printExprFlags.printExprFlagNone);
        } else {
          this.print("default");
        }
        this.print(":");

        if (c.Body.length === 1 && c.Body[0].Data instanceof js_ast.SBlock) {
          this.printSpace();
          this.printBlock(c.Body[0].Data);
          this.printNewline();
          continue;
        }

        this.printNewline();
        this.indent++;
        for (const stmt of c.Body) {
          this.printSemicolonIfNeeded();
          this.printIndent();
          this.printStmt(stmt, printStmtFlags.printStmtFlagNone);
        }
        this.indent--;
      }

      this.indent--;
      this.printIndent();
      this.print("}");
      this.printNewline();
      this.needsSemicolon = false;
    } else if (s instanceof js_ast.SImport) {
      // Go: js_printer.go:4710（items / star / path 与 Go 同顺序）
      let itemCount = 0;
      this.printSpaceBeforeIdentifier();
      const importPhase = this.importRecords[s.ImportRecordIndex].Phase;
      if (importPhase === ImportPhase.DeferPhase) {
        this.print("import defer");
      } else if (importPhase === ImportPhase.SourcePhase) {
        this.print("import source");
      } else {
        this.print("import");
      }
      this.printSpace();

      if (s.DefaultName !== null) {
        this.printSpaceBeforeIdentifier();
        this.printIdentifier(this.renamer.NameForSymbol(s.DefaultName.Ref));
        itemCount++;
      }

      if (s.Items !== null) {
        if (itemCount > 0) {
          this.print(",");
          this.printSpace();
        }

        this.print("{");
        if (!s.IsSingleLine) {
          this.indent++;
        }

        for (let i = 0; i < s.Items.length; i++) {
          const item = s.Items[i];
          if (i !== 0) {
            this.print(",");
          }

          if (s.IsSingleLine) {
            this.printSpace();
          } else {
            this.printNewline();
            this.printIndent();
          }

          this.printClauseAlias(item.AliasLoc, item.Alias);

          const name = this.renamer.NameForSymbol(item.Name.Ref);
          if (name !== item.Alias) {
            this.printSpace();
            this.printSpaceBeforeIdentifier();
            this.print("as ");
            this.printIdentifier(name);
          }
        }

        if (!s.IsSingleLine) {
          this.indent--;
          this.printNewline();
          this.printIndent();
        } else if (s.Items.length > 0) {
          this.printSpace();
        }

        this.print("}");
        itemCount++;
      }

      if (s.StarNameLoc !== null) {
        if (itemCount > 0) {
          this.print(",");
          this.printSpace();
        }

        this.print("*");
        this.printSpace();
        this.print("as ");
        this.printIdentifier(this.renamer.NameForSymbol(s.NamespaceRef));
        itemCount++;
      }

      if (itemCount > 0) {
        this.printSpace();
        this.printSpaceBeforeIdentifier();
        this.print("from");
        this.printSpace();
      }

      this.printPath(s.ImportRecordIndex);
      this.printSemicolonAfterStatement();
    } else if (s instanceof js_ast.SExportStar) {
      // Go: js_printer.go:4247
      this.printSpaceBeforeIdentifier();
      this.print("export");
      this.printSpace();
      this.print("*");
      this.printSpace();
      if (s.Alias !== null) {
        this.print("as");
        this.printSpace();
        this.printClauseAlias(s.Alias.Loc, s.Alias.OriginalName);
        this.printSpace();
        this.printSpaceBeforeIdentifier();
      }
      this.print("from");
      this.printSpace();
      this.printPath(s.ImportRecordIndex);
      this.printSemicolonAfterStatement();
    } else if (s instanceof js_ast.SExportClause) {
      // Go: js_printer.go:4267
      this.printSpaceBeforeIdentifier();
      this.print("export");
      this.printSpace();
      this.print("{");

      if (!s.IsSingleLine) {
        this.indent++;
      }

      for (let i = 0; i < s.Items.length; i++) {
        const item = s.Items[i];
        if (i !== 0) {
          this.print(",");
        }

        if (s.IsSingleLine) {
          this.printSpace();
        } else {
          this.printNewline();
          this.printIndent();
        }

        const name = this.renamer.NameForSymbol(item.Name.Ref);
        this.printIdentifier(name);
        if (name !== item.Alias) {
          this.print(" as");
          this.printSpace();
          this.printClauseAlias(item.AliasLoc, item.Alias);
        }
      }

      if (!s.IsSingleLine) {
        this.indent--;
        this.printNewline();
        this.printIndent();
      } else if (s.Items.length > 0) {
        this.printSpace();
      }

      this.print("}");
      this.printSemicolonAfterStatement();
    } else if (s instanceof js_ast.SExportFrom) {
      // Go: js_printer.go:4314
      this.printSpaceBeforeIdentifier();
      this.print("export");
      this.printSpace();
      this.print("{");

      if (!s.IsSingleLine) {
        this.indent++;
      }

      for (let i = 0; i < s.Items.length; i++) {
        const item = s.Items[i];
        if (i !== 0) {
          this.print(",");
        }

        if (s.IsSingleLine) {
          this.printSpace();
        } else {
          this.printNewline();
          this.printIndent();
        }

        this.printClauseAlias(item.Name.Loc, item.OriginalName);
        if (item.OriginalName !== item.Alias) {
          this.printSpace();
          this.printSpaceBeforeIdentifier();
          this.print("as");
          this.printSpace();
          this.printClauseAlias(item.AliasLoc, item.Alias);
        }
      }

      if (!s.IsSingleLine) {
        this.indent--;
        this.printNewline();
        this.printIndent();
      } else if (s.Items.length > 0) {
        this.printSpace();
      }

      this.print("}");
      this.printSpace();
      this.print("from");
      this.printSpace();
      this.printPath(s.ImportRecordIndex);
      this.printSemicolonAfterStatement();
    } else if (s instanceof js_ast.SExportDefault) {
      // Go: js_printer.go:4184
      const value = s.Value.Data;
      if (value instanceof js_ast.SClass && value.Class.Decorators.length > 0) {
        const omitIndent = this.printDecorators(value.Class.Decorators, printAfterDecorator.printNewlineAfterDecorator, true);
        if (!omitIndent) this.printIndent();
      }
      this.printSpaceBeforeIdentifier();
      this.print("export default");
      this.printSpace();

      if (value instanceof js_ast.SExpr) {
        // Functions and classes must be wrapped to avoid confusion with their statement forms
        this.exportDefaultStart = this.js.length;
        this.printExprWithoutLeadingNewline(value.Value, js_ast.L.LComma, printExprFlags.printExprFlagNone);
        this.printSemicolonAfterStatement();
      } else if (value instanceof js_ast.SFunction) {
        this.printSpaceBeforeIdentifier();
        if (value.Fn.IsAsync) {
          this.print("async ");
        }
        this.print("function");
        if (value.Fn.IsGenerator) {
          this.print("*");
          this.printSpace();
        }
        if (value.Fn.Name !== null) {
          this.printSpaceBeforeIdentifier();
          this.printIdentifier(this.renamer.NameForSymbol(value.Fn.Name.Ref));
        }
        this.printFn(value.Fn);
        this.printNewline();
      } else if (value instanceof js_ast.SClass) {
        this.printSpaceBeforeIdentifier();
        this.print("class");
        if (value.Class.Name !== null) {
          this.print(" ");
          this.printIdentifier(this.renamer.NameForSymbol(value.Class.Name.Ref));
        }
        this.printClass(value.Class);
        this.printNewline();
      } else {
        throw new Error("Internal error");
      }
    } else if (s instanceof js_ast.SBlock) {
      this.printBlock(s);
      this.printNewline();
    } else if (s instanceof js_ast.SIf) {
      this.printIf(s);
    } else if (s instanceof js_ast.SDebugger) {
      this.print("debugger");
      this.printSemicolonAfterStatement();
    } else {
      throw new Error(`printer: unsupported stmt ${(s as object).constructor?.name ?? "?"}`);
    }
  }
}

/** Go: func Print(tree js_ast.AST, symbols ast.SymbolMap, r renamer.Renamer, options Options) PrintResult (js_printer.go:4969) */
export function Print(
  tree: js_ast.AST,
  symbols: Symbol[],
  r: Renamer,
  options: Options,
): PrintResult {
  const p = new printer(symbols, r, options);
  p.importRecords = tree.ImportRecords;
  p.exprComments = tree.ExprComments ?? new Map();
  p.wasLazyExport = tree.HasLazyExport;
  p.moduleType = tree.ModuleTypeData?.Type ?? 0;

  if (tree.Hashbang !== "") {
    p.print("#!" + tree.Hashbang + "\n");
  }

  for (const directive of tree.Directives ?? []) {
    p.print("\"" + directive + "\";\n");
  }

  // Hashbang / directives 之后按 part 顺序打印语句
  for (const part of tree.Parts) {
    for (const stmt of part.Stmts) {
      p.printStmt(stmt, printStmtFlags.printStmtFlagNone);
      p.printSemicolonIfNeeded();
    }
  }

  const result = init(new PrintResult(), {
    JS: p.js.toUint8Array(),
    ExtractedLegalComments: p.extractedLegalComments,
  });
  // Go: js_printer.go:5021 —— SourceMap != None 时生成 chunk（M2 sourcemap 通道）
  if (options.SourceMap !== 0) {
    result.SourceMapChunk = p.builder.GenerateChunk(p.js.toUint8Array());
  }
  return result;
}
