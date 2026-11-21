// 1:1 移植自 esbuild internal/logger/logger.go（v0.28.2，commit f6058f83）
//
// 已落：Loc / Range / PrettyPaths（含 Select）/ MsgLocation / MsgData / Msg（含 String）/
//       SortableMsgs / ImportAttributes / Path / plural / errorAndWarningSummary / Source(8) /
//       MsgKind.String+Icon / isProbablyWindowsCommandPrompt / hasNoColorEnvironmentVariable /
//       LineColumnTracker(4) / NewStderrLog / OutputOptionsForArgs / PrintMessageToStderr /
//       PrintErrorToStderr / PrintErrorWithNoteToStderr / PrintText / PrintTextWithColor /
//       SummaryTable(3) / PrintSummary / Log + allowOverride / AddError / AddID / AddErrorWithNotes /
//       AddIDWithNotes / AddMsgID / NewDeferLog /
//       StringInJSTableEntry + GenerateStringInJSTable / RemapStringInJSLoc / NewStringInJSLog。
// 未落（明确记录，不留白）：PlatformIndependentPathDirBaseExt。
// 已落（第 84 轮）：style_clang.go / style_visualstudio.go（Msg.String 三风格全通）、
//       vsID 表（style_visualstudio.ts 内嵌，Go 探针固化）。
// 不做空壳：没实现的函数就不写，避免「桩通过测试」冒充等价。
//
// DEVIATION 汇总：
// - Go 结构体是值类型，TS 用 class（引用类型）；Loc/Range 无就地修改依赖，行为等价。
// - Go 的 string 承载 UTF-8 字节（长度按字节、索引按字节）；凡是二进制语义的数据
//   （ImportAttributes.packedData、ImportAttribute.Key/Value、Source.Contents、
//   MsgLocation.LineText、全部格式化中间结果）用 Uint8Array 承载，
//   不把字节硬塞进 JS string，避免非 ASCII 输入下 index 语义漂移。
// - 输出目的地：Go 直接写 os.Stderr；TS 用 FileLike 参数注入（默认 process.stderr）。
//   见 PLAN.md「第 7 次推进」§1。

import {
  ByteBuilder,
  byteLen,
  compareBytes,
  concatBytes,
  decodeLastRune,
  decodeRune,
  indexOfBytes,
  lastIndexOfBytes,
  spaces,
  utf8,
} from "./bytes.ts";
import { msgToStringDefault } from "./style_default.ts";
import { msgToStringClang } from "./style_clang.ts";
import { msgToStringVisualStudio } from "./style_visualstudio.ts";
import { init } from "../helpers/init.ts";
import { GetTerminalInfo, SupportsColorEscapes, writeStringWithColor } from "./logger_linux.ts";
import type { MsgID } from "./msg_ids.ts";

export type { MsgID } from "./msg_ids.ts";

/** Go: type Loc struct { Start int32 } —— 0-based byte index from the start of the file */
export class Loc {
  Start: number;

  constructor(Start: number = 0) {
    this.Start = Start | 0;
  }
}

/** Go: type Range struct { Loc Loc; Len int32 } */
export class Range {
  Loc: Loc;
  Len: number;

  // 坑（已修）：形参曾叫 Loc，而默认值 `new Loc()` 会解析到形参自身（TDZ），
  // 于是 `new Range()`（不传参）直接 ReferenceError。改名避开与类名撞名。
  constructor(loc: Loc = new Loc(), Len: number = 0) {
    this.Loc = loc;
    this.Len = Len | 0;
  }

  /** Go: func (r Range) End() int32 */
  End(): number {
    return (this.Loc.Start + this.Len) | 0;
  }

  /** Go: func (a *Range) ExpandBy(b Range) */
  ExpandBy(b: Range): void {
    if (this.Len === 0) {
      this.Loc = new Loc(b.Loc.Start);
      this.Len = b.Len;
    } else {
      let end = this.End();
      const n = b.End();
      if (n > end) end = n;
      if (b.Loc.Start < this.Loc.Start) this.Loc.Start = b.Loc.Start;
      this.Len = (end - this.Loc.Start) | 0;
    }
  }
}

/** Go: type PrettyPaths struct { Abs string; Rel string } */
export class PrettyPaths {
  Abs = "";
  Rel = "";

  /** Go: func (paths *PrettyPaths) Select(style PathStyle) string */
  Select(style: PathStyle): string {
    if (style === PathStyle.AbsPath) return this.Abs;
    return this.Rel;
  }
}

/** Go: type MsgLocation struct {...} */
export class MsgLocation {
  File: PrettyPaths = new PrettyPaths();
  Namespace = "";
  /**
   * DEVIATION：Go 是 string（就是字节串），TS 用 Uint8Array。
   * 这个字段会被 formatLineSpan 按**字节**下标切片（column/length 都是字节偏移），
   * 用 JS string 会在非 ASCII 输入下切错位置。
   */
  LineText: Uint8Array = new Uint8Array(0);
  Suggestion = "";
  /** 1-based */
  Line = 0;
  /** 0-based, in bytes */
  Column = 0;
  /** in bytes */
  Length = 0;
}

/** Go: type MsgData struct {...} */
export class MsgData {
  UserDetail: unknown = null;
  Location: MsgLocation | null = null;
  Text = "";
  DisableMaximumWidth = false;
}

/**
 * Go: type Span struct { Text string; Range Range }
 *
 * DEVIATION：Text 是 UTF-8 字节（Go 的 string 就是字节串），用 Uint8Array 承载。
 * 目前只有 js_lexer 的 pragma 注释字段（@jsx / @jsxFrag / sourceMappingURL 等）用它。
 */
export class Span {
  Text: Uint8Array = new Uint8Array(0);
  Range: Range = new Range();
}

/** Go: type MsgKind uint8 */
export type MsgKind = number;
export const MsgKind = {
  Error: 0,
  Warning: 1,
  Info: 2,
  Note: 3,
  Debug: 4,
  Verbose: 5,
} as const;

/** Go: const Error MsgKind = iota 等 —— 包级常量名与 Go 对齐 */
export const Error = MsgKind.Error;
export const Warning = MsgKind.Warning;
export const Info = MsgKind.Info;
export const Note = MsgKind.Note;
export const Debug = MsgKind.Debug;
export const Verbose = MsgKind.Verbose;

/** Go: func (kind MsgKind) String() string */
export function String(kind: MsgKind): string {
  switch (kind) {
    case MsgKind.Error:
      return "ERROR";
    case MsgKind.Warning:
      return "WARNING";
    case MsgKind.Info:
      return "INFO";
    case MsgKind.Note:
      return "NOTE";
    case MsgKind.Debug:
      return "DEBUG";
    case MsgKind.Verbose:
      return "VERBOSE";
    default:
      // 注意：本模块导出了常量 `Error`（Go 的 MsgKind.Error），此处必须显式用 globalThis.Error
      throw new globalThis.Error("Internal error");
  }
}

/** Go: var windowsCommandPrompt struct { ... } */
let windowsCommandPromptOnce = false;
let isProbablyCMD = false;

/** Go: func isProbablyWindowsCommandPrompt() bool */
export function isProbablyWindowsCommandPrompt(): boolean {
  if (!windowsCommandPromptOnce) {
    windowsCommandPromptOnce = true;

    // Assume we are running in Windows Command Prompt if we're on Windows. If
    // so, we can't use emoji because it won't be supported. Except we can
    // still use emoji if the WT_SESSION environment variable is present
    // because that means we're running in the new Windows Terminal instead.
    //
    // DEVIATION：Go 的 runtime.GOOS 是编译期常量；TS 用 process.platform。
    if (process.platform === "win32") {
      isProbablyCMD = true;
      if (process.env.WT_SESSION !== undefined) isProbablyCMD = false;
    }
  }

  return isProbablyCMD;
}

/** Go: func (kind MsgKind) Icon() string */
export function Icon(kind: MsgKind): string {
  // Special-case Windows command prompt, which only supports a few characters
  if (isProbablyWindowsCommandPrompt()) {
    switch (kind) {
      case MsgKind.Error:
        return "X";
      case MsgKind.Warning:
        return "▲";
      case MsgKind.Info:
        return "►";
      case MsgKind.Note:
        return "→";
      case MsgKind.Debug:
        return "●";
      case MsgKind.Verbose:
        return "♦";
      default:
        throw new globalThis.Error("Internal error");
    }
  }

  switch (kind) {
    case MsgKind.Error:
      return "✘";
    case MsgKind.Warning:
      return "▲";
    case MsgKind.Info:
      return "▶";
    case MsgKind.Note:
      return "→";
    case MsgKind.Debug:
      return "●";
    case MsgKind.Verbose:
      return "⬥";
    default:
      throw new globalThis.Error("Internal error");
  }
}

/** Go: type LogLevel int8 */
export type LogLevel = number;
export const LogLevel = {
  None: 0,
  Verbose: 1,
  Debug: 2,
  Info: 3,
  Warning: 4,
  Error: 5,
  Silent: 6,
} as const;

/** Go: type UseColor uint8 */
export type UseColor = number;
export const UseColor = {
  ColorIfTerminal: 0,
  ColorNever: 1,
  ColorAlways: 2,
} as const;

/** Go: type LogStyle int8 */
export type LogStyle = number;
export const LogStyle = {
  StyleDefault: 0,
  StyleClang: 1,
  StyleVisualStudio: 2,
} as const;

/** Go: type PathStyle uint8 */
export type PathStyle = number;
export const PathStyle = {
  RelPath: 0,
  AbsPath: 1,
} as const;

/** Go: const defaultTerminalWidth = 80（logger.go） */
export const defaultTerminalWidth = 80;

/** Go: const extraMarginChars = 9（logger.go） */
export const extraMarginChars = 9;

/** Go: type Msg struct { Notes []MsgData; PluginName string; Data MsgData; Kind MsgKind; ID MsgID } */
export class Msg {
  Notes: MsgData[] = [];
  PluginName = "";
  Data: MsgData = new MsgData();
  Kind: MsgKind = 0;
  ID: MsgID = 0;

  /**
   * Go: func (msg Msg) String(options OutputOptions, terminalInfo TerminalInfo) string
   *
   * 三种 LogStyle 全部移植：default / clang / visualstudio（第 84 轮）。
   */
  String(options: OutputOptions, terminalInfo: TerminalInfo): Uint8Array {
    switch (options.LogStyle) {
      case LogStyle.StyleClang:
        return msgToStringClang(this, options, terminalInfo);
      case LogStyle.StyleVisualStudio:
        return msgToStringVisualStudio(this, options, terminalInfo);
      default:
        return msgToStringDefault(this, options, terminalInfo);
    }
  }
}

/** Go: type SortableMsgs []Msg */
export class SortableMsgs {
  msgs: Msg[];

  constructor(msgs: Msg[] = []) {
    this.msgs = msgs;
  }

  /** Go: func (a SortableMsgs) Len() int */
  Len(): number {
    return this.msgs.length;
  }

  /** Go: func (a SortableMsgs) Swap(i int, j int) */
  Swap(i: number, j: number): void {
    const t = this.msgs[i];
    this.msgs[i] = this.msgs[j];
    this.msgs[j] = t;
  }

  /** Go: func (a SortableMsgs) Less(i int, j int) bool */
  Less(i: number, j: number): boolean {
    const ai = this.msgs[i];
    const aj = this.msgs[j];
    const aiLoc = ai.Data.Location;
    const ajLoc = aj.Data.Location;
    if (aiLoc === null || ajLoc === null) {
      return aiLoc === null && ajLoc !== null;
    }
    if (aiLoc.File.Abs !== ajLoc.File.Abs || aiLoc.File.Rel !== ajLoc.File.Rel) {
      // Go 的 string 比较是按字节；JS 的 < 比的是 UTF-16 码元，非 ASCII 下会不同。
      const absCmp = compareBytes(utf8(aiLoc.File.Abs), utf8(ajLoc.File.Abs));
      if (absCmp !== 0) return absCmp < 0;
      return compareBytes(utf8(aiLoc.File.Rel), utf8(ajLoc.File.Rel)) < 0;
    }
    if (aiLoc.Line !== ajLoc.Line) return aiLoc.Line < ajLoc.Line;
    if (aiLoc.Column !== ajLoc.Column) return aiLoc.Column < ajLoc.Column;
    if (ai.Kind !== aj.Kind) return ai.Kind < aj.Kind;
    return compareBytes(utf8(ai.Data.Text), utf8(aj.Data.Text)) < 0;
  }
}

/** Go: type ImportAttribute struct { Key string; Value string } */
export interface ImportAttribute {
  Key: Uint8Array;
  Value: Uint8Array;
}

/**
 * Go: type ImportAttributes struct { packedData string }
 *
 * Go 用 string 承载二进制（小端 uint32 长度前缀 + 原始字节）；TS 用 Uint8Array，逐字节对齐。
 */
export class ImportAttributes {
  packedData: Uint8Array;

  constructor(packedData: Uint8Array = new Uint8Array(0)) {
    this.packedData = packedData;
  }

  /** Go: func (attrs ImportAttributes) DecodeIntoArray() (result []ImportAttribute) */
  DecodeIntoArray(): ImportAttribute[] {
    if (this.packedData.length === 0) return [];

    const result: ImportAttribute[] = [];
    const bytes = this.packedData;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    while (offset < bytes.length) {
      const kn = 4 + view.getUint32(offset, true);
      const k = bytes.slice(offset + 4, offset + kn);
      offset += kn;

      const vn = 4 + view.getUint32(offset, true);
      const v = bytes.slice(offset + 4, offset + vn);
      offset += vn;

      result.push({ Key: k, Value: v });
    }
    return result;
  }

  /** Go: func (attrs ImportAttributes) DecodeIntoMap() (result map[string]string) */
  DecodeIntoMap(): Map<string, Uint8Array> | null {
    const array = this.DecodeIntoArray();
    if (array.length === 0) return null;
    const result = new Map<string, Uint8Array>();
    const decoder = new TextDecoder();
    for (const attr of array) result.set(decoder.decode(attr.Key), attr.Value);
    return result;
  }
}

/**
 * Go: func EncodeImportAttributes(value map[string]string) ImportAttributes
 *
 * Go 的 `sort.Strings` 按字节序排序；TS 默认字符串比较按 UTF-16 码元，对非 ASCII 键序不同，
 * 因此这里显式按 UTF-8 字节比较，与 Go 逐字节一致。
 */
export function EncodeImportAttributes(value: Map<string, Uint8Array>): ImportAttributes {
  if (value.size === 0) return new ImportAttributes();

  const encoder = new TextEncoder();
  const keys = [...value.keys()].map((k) => encoder.encode(k));
  keys.sort(compareBytes);

  const parts: Uint8Array[] = [];
  const n = new Uint8Array(4);
  const dataView = new DataView(n.buffer);
  for (const keyBytes of keys) {
    const valBytes = value.get(new TextDecoder().decode(keyBytes))!;
    dataView.setUint32(0, keyBytes.length, true);
    parts.push(n.slice(), keyBytes);
    dataView.setUint32(0, valBytes.length, true);
    parts.push(n.slice(), valBytes);
  }

  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return new ImportAttributes(out);
}

/** Go: type PathFlags uint8 */
export type PathFlags = number;
export const PathFlags = {
  /** Go: PathDisabled —— corresponds to a value of "false" in the "browser" package.json field */
  PathDisabled: 1 << 0,
} as const;

/** Go: type Path struct { Text, Namespace, IgnoredSuffix string; ImportAttributes ImportAttributes; Flags PathFlags } */
export class Path {
  Text = "";
  Namespace = "";
  IgnoredSuffix = "";
  ImportAttributes: ImportAttributes = new ImportAttributes();
  Flags: PathFlags = 0;

  /** Go: func (p Path) IsDisabled() bool */
  IsDisabled(): boolean {
    return (this.Flags & PathFlags.PathDisabled) !== 0;
  }
}

/**
 * Go: func PlatformIndependentPathDirBaseExt(path string) (dir string, base string, ext string)
 * (logger.go:353)
 *
 * 与 Go 逐行一致（含 Windows 盘符分支里 `c >= 'a' && c < 'z'` 的严格小于——故意保留，
 * bug-for-bug）。注意 Go 是对**字节**做 LastIndexAny/LastIndexByte，这里对 UTF-16 code unit
 * 做同样的事：分隔符 `/\.` 都是 ASCII 单字节，两种索引在含非 ASCII 的路径上切出的位置相同。
 */
export function PlatformIndependentPathDirBaseExt(
  path: string,
): { dir: string; base: string; ext: string } {
  let dir = "";
  let base = "";
  let ext = "";
  let absRootSlash = -1;

  // Make sure we don't strip off the slash for the root of the file system
  if (path.length > 0 && (path[0] === "/" || path[0] === "\\")) {
    absRootSlash = 0; // Unix
  } else if (path.length > 2 && path[1] === ":" && (path[2] === "/" || path[2] === "\\")) {
    const c = path.charCodeAt(0);
    if ((c >= 0x61 && c < 0x7a) || (c >= 0x41 && c <= 0x5a)) {
      absRootSlash = 2; // Windows
    }
  }

  for (;;) {
    // Go: i := strings.LastIndexAny(path, "/\\")
    const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));

    // Stop if there are no more slashes
    if (i < 0) {
      base = path;
      break;
    }

    // Stop if we found a non-trailing slash
    if (i === absRootSlash) {
      dir = path.slice(0, i + 1);
      base = path.slice(i + 1);
      break;
    }
    if (i + 1 !== path.length) {
      dir = path.slice(0, i);
      base = path.slice(i + 1);
      break;
    }

    // Ignore trailing slashes
    path = path.slice(0, i);
  }

  // Strip off the extension
  let dot = base.lastIndexOf(".");
  if (dot >= 0) {
    ext = base.slice(dot);

    // We default to the "local-css" loader for ".module.css" files. Make sure
    // the string names generated by this don't all have "_module_" in them.
    if (ext === ".css") {
      const dot2 = base.slice(0, dot).lastIndexOf(".");
      if (dot2 >= 0 && base.slice(dot2) === ".module.css") {
        dot = dot2;
        ext = base.slice(dot);
      }
    }

    base = base.slice(0, dot);
  }

  return { dir, base, ext };
}

/** Go: func plural(prefix string, count int, shown int, someAreMissing bool) string */
export function plural(prefix: string, count: number, shown: number, someAreMissing: boolean): string {
  let text: string;
  if (count === 1) {
    text = `${count} ${prefix}`;
  } else {
    text = `${count} ${prefix}s`;
  }
  if (shown < count) {
    text = `${shown} of ${text}`;
  } else if (someAreMissing && count > 1) {
    text = "all " + text;
  }
  return text;
}

/** Go: func errorAndWarningSummary(errors, warnings, shownErrors, shownWarnings int) string */
export function errorAndWarningSummary(
  errors: number, warnings: number, shownErrors: number, shownWarnings: number,
): string {
  const someAreMissing = shownWarnings < warnings || shownErrors < errors;
  if (errors === 0) return plural("warning", warnings, shownWarnings, someAreMissing);
  if (warnings === 0) return plural("error", errors, shownErrors, someAreMissing);
  return `${plural("warning", warnings, shownWarnings, someAreMissing)} and ${
    plural("error", errors, shownErrors, someAreMissing)
  }`;
}

/**
 * Go: type Source struct {...}
 *
 * DEVIATION（已论证的硬约束）：`Contents` 用 `Uint8Array` 而不是 JS string。
 * Go 的 `Contents` 是 UTF-8 字节串，所有 range 都是**字节**偏移；用 UTF-16 字符串会让
 * 非 ASCII 输入下的 `Loc.Start`/`Len` 静默偏离 Go。因此：
 * - 切片一律 `Contents.subarray(a, b)`，不得转成字符串参与偏移计算；
 * - `TextForRange` 返回字节（Go 返回的 string 本身就是字节串）。
 */
export class Source {
  PrettyPaths: PrettyPaths = new PrettyPaths();
  IdentifierName = "";
  Contents: Uint8Array = new Uint8Array(0);
  KeyPath: Path = new Path();
  Index = 0;

  /** Go: func (s *Source) TextForRange(r Range) string */
  TextForRange(r: Range): Uint8Array {
    return this.Contents.subarray(r.Loc.Start, r.Loc.Start + r.Len);
  }

  /**
   * Go: func (s *Source) LocBeforeWhitespace(loc Loc) Loc
   *
   * 只跳过 ' ' / '\t' / '\r' / '\n'（均为单字节）。Go 用 DecodeLastRuneInString 拿到 width，
   * 但非空白 rune 会立即 break，所以逐字节回退与非 ASCII 情形等价。
   */
  LocBeforeWhitespace(loc: Loc): Loc {
    let start = loc.Start;
    while (start > 0) {
      const c = this.Contents[start - 1];
      if (c !== 0x20 && c !== 0x09 && c !== 0x0d && c !== 0x0a) break;
      start--;
    }
    return new Loc(start);
  }

  /** Go: func (s *Source) RangeOfOperatorBefore(loc Loc, op string) Range */
  RangeOfOperatorBefore(loc: Loc, op: string): Range {
    const opBytes = new TextEncoder().encode(op);
    const text = this.Contents.subarray(0, loc.Start);
    const index = lastIndexOfBytes(text, opBytes);
    if (index >= 0) return new Range(new Loc(index), opBytes.length);
    return new Range(new Loc(loc.Start), 0);
  }

  /** Go: func (s *Source) RangeOfOperatorAfter(loc Loc, op string) Range */
  RangeOfOperatorAfter(loc: Loc, op: string): Range {
    const opBytes = new TextEncoder().encode(op);
    const text = this.Contents.subarray(loc.Start);
    const index = indexOfBytes(text, opBytes);
    if (index >= 0) return new Range(new Loc(loc.Start + index), opBytes.length);
    return new Range(new Loc(loc.Start), 0);
  }

  /** Go: func (s *Source) RangeOfString(loc Loc) Range */
  RangeOfString(loc: Loc): Range {
    const text = this.Contents.subarray(loc.Start);
    if (text.length === 0) return new Range(new Loc(loc.Start), 0);

    const quote = text[0];
    if (quote === 0x22 || quote === 0x27) {
      // Search for the matching quote character
      for (let i = 1; i < text.length; i++) {
        const c = text[i];
        if (c === quote) return new Range(new Loc(loc.Start), i + 1);
        if (c === 0x5c) i += 1;
      }
    }

    if (quote === 0x60) {
      // Search for the matching quote character
      for (let i = 1; i < text.length; i++) {
        const c = text[i];
        if (c === quote) return new Range(new Loc(loc.Start), i + 1);
        if (c === 0x5c) i += 1;
        else if (c === 0x24 && i + 1 < text.length && text[i + 1] === 0x7b) break; // `${`
      }
    }

    return new Range(new Loc(loc.Start), 0);
  }

  /** Go: func (s *Source) RangeOfNumber(loc Loc) (r Range) */
  RangeOfNumber(loc: Loc): Range {
    const text = this.Contents.subarray(loc.Start);
    let len = 0;
    if (text.length > 0) {
      const c0 = text[0];
      if (c0 >= 0x30 && c0 <= 0x39) {
        len = 1;
        while (len < text.length) {
          const c = text[len];
          if (
            (c < 0x30 || c > 0x39) && (c < 0x61 || c > 0x7a) && (c < 0x41 || c > 0x5a) &&
            c !== 0x2e && c !== 0x5f
          ) break;
          len++;
        }
      }
    }
    return new Range(new Loc(loc.Start), len);
  }

  /** Go: func (s *Source) RangeOfLegacyOctalEscape(loc Loc) (r Range) */
  RangeOfLegacyOctalEscape(loc: Loc): Range {
    const text = this.Contents.subarray(loc.Start);
    let len = 0;
    if (text.length >= 2 && text[0] === 0x5c) {
      len = 2;
      while (len < 4 && len < text.length) {
        const c = text[len];
        if (c < 0x30 || c > 0x39) break;
        len++;
      }
    }
    return new Range(new Loc(loc.Start), len);
  }

  /**
   * Go: func (s *Source) CommentTextWithoutIndent(r Range) string
   *
   * 返回字节（Go 返回 string，即字节串）。
   * 坑：Go 的 `indent` 是**rune 计数**（在 prefix 上反向扫描），但后面 `line[indent:]` 是**字节**切片。
   * 两者一致的前提是：被切掉的都是每行开头的空格/制表符（ASCII）。由于 indent 会与每行的
   * 前导空白数（同样按 rune 计数，且实际只能是空格/制表符）取最小值，这个前提总是成立。
   */
  CommentTextWithoutIndent(r: Range): Uint8Array {
    const text = this.Contents.subarray(r.Loc.Start, r.End());
    if (text.length < 2 || !(text[0] === 0x2f && text[1] === 0x2a)) return text;

    // Figure out the initial indent（按 rune 计数，跳过 \r \n \u2028 \u2029）
    let indent = 0;
    let prefixEnd = r.Loc.Start;
    while (prefixEnd > 0) {
      const { r: rune, width } = decodeLastRune(this.Contents, prefixEnd);
      if (rune === 0x0d || rune === 0x0a || rune === 0x2028 || rune === 0x2029) break;
      prefixEnd -= width;
      indent++;
    }

    // Split the comment into lines（按字节扫，'\u2028'/'\u2029' 是 3 字节 UTF-8）
    const lines: Uint8Array[] = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === 0x0d || c === 0x0a) {
        // Don't double-append for Windows style "\r\n" newlines
        if (start <= i) lines.push(text.subarray(start, i));
        start = i + 1;
        // Ignore the second part of Windows style "\r\n" newlines
        if (c === 0x0d && start < text.length && text[start] === 0x0a) start++;
      } else if (c === 0xe2 && i + 2 < text.length && text[i + 1] === 0x80 &&
        (text[i + 2] === 0xa8 || text[i + 2] === 0xa9)) {
        lines.push(text.subarray(start, i));
        i += 2;
        start = i + 1;
      }
    }
    lines.push(text.subarray(start));

    // Find the minimum indent over all lines after the first line
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      let lineIndent = 0;
      for (let j = 0; j < line.length; j++) {
        const c = line[j];
        if (c !== 0x20 && c !== 0x09) break;
        lineIndent++;
      }
      if (indent > lineIndent) indent = lineIndent;
    }

    // Trim the indent off of all lines after the first line
    const parts: Uint8Array[] = [];
    for (let i = 0; i < lines.length; i++) {
      parts.push(i > 0 ? lines[i].subarray(indent) : lines[i]);
      if (i + 1 < lines.length) parts.push(new Uint8Array([0x0a]));
    }
    return concatBytes(parts);
  }
}

// ---------------------------------------------------------------------------
// TerminalInfo / Colors / 输出选项 / 输出目的地
// ---------------------------------------------------------------------------

/** Go: type TerminalInfo struct { IsTTY bool; UseColorEscapes bool; Width int; Height int } */
export class TerminalInfo {
  IsTTY = false;
  UseColorEscapes = false;
  Width = 0;
  Height = 0;
}

/** Go: type Colors struct {...} —— 零值全是空串（即不输出颜色转义） */
export class Colors {
  Reset = "";
  Bold = "";
  Dim = "";
  Underline = "";

  Red = "";
  Green = "";
  Blue = "";

  Cyan = "";
  Magenta = "";
  Yellow = "";

  RedBgRed = "";
  RedBgWhite = "";
  GreenBgGreen = "";
  GreenBgWhite = "";
  BlueBgBlue = "";
  BlueBgWhite = "";

  CyanBgCyan = "";
  CyanBgBlack = "";
  MagentaBgMagenta = "";
  MagentaBgBlack = "";
  YellowBgYellow = "";
  YellowBgBlack = "";
}

/** Go: var TerminalColors = Colors{...} */
export const TerminalColors: Colors = init(new Colors(), {
  Reset: "\x1b[0m",
  Bold: "\x1b[1m",
  Dim: "\x1b[37m",
  Underline: "\x1b[4m",

  Red: "\x1b[31m",
  Green: "\x1b[32m",
  Blue: "\x1b[34m",

  Cyan: "\x1b[36m",
  Magenta: "\x1b[35m",
  Yellow: "\x1b[33m",

  RedBgRed: "\x1b[41;31m",
  RedBgWhite: "\x1b[41;97m",
  GreenBgGreen: "\x1b[42;32m",
  GreenBgWhite: "\x1b[42;97m",
  BlueBgBlue: "\x1b[44;34m",
  BlueBgWhite: "\x1b[44;97m",

  CyanBgCyan: "\x1b[46;36m",
  CyanBgBlack: "\x1b[46;30m",
  MagentaBgMagenta: "\x1b[45;35m",
  MagentaBgBlack: "\x1b[45;30m",
  YellowBgYellow: "\x1b[43;33m",
  YellowBgBlack: "\x1b[43;30m",
});

/** Go: type OutputOptions struct {...} */
export class OutputOptions {
  MessageLimit = 0;
  IncludeSource = false;
  Color: UseColor = UseColor.ColorIfTerminal;
  LogLevel: LogLevel = LogLevel.None;
  LogStyle: LogStyle = LogStyle.StyleDefault;
  PathStyle: PathStyle = PathStyle.RelPath;
  Overrides: Map<MsgID, LogLevel> | null = null;
}

/**
 * 输出目的地。Go 的参数是 `*os.File`（只用 WriteString），TS 用这个接口；
 * `Stream` 对应 fd，仅 GetTerminalInfo 用。
 */
export interface FileLike {
  /** Go: (*os.File).WriteString(s string) —— Go 的 string 就是字节串 */
  WriteString(text: Uint8Array): void;
  Stream?: { isTTY?: boolean; columns?: number; rows?: number };
}

/** 默认输出到 stderr（对应 Go 里到处直接用的 os.Stderr） */
export const stderr: FileLike = {
  WriteString(text: Uint8Array): void {
    process.stderr.write(text);
  },
  Stream: process.stderr as unknown as { isTTY?: boolean; columns?: number; rows?: number },
};

/** Go: var noColorResult bool / noColorOnce sync.Once */
let noColorResult: boolean | null = null;

/** Go: func hasNoColorEnvironmentVariable() bool */
export function hasNoColorEnvironmentVariable(): boolean {
  if (noColorResult === null) {
    // Read "NO_COLOR" from the environment. This is a convention that some
    // software follows. See https://no-color.org/ for more information.
    noColorResult = process.env.NO_COLOR !== undefined;
  }
  return noColorResult;
}

// ---------------------------------------------------------------------------
// LineColumnTracker
// ---------------------------------------------------------------------------

/**
 * Go: type LineColumnTracker struct {...}
 *
 * 从上次扫到的位置继续扫，避免 n 个告警的 O(n^2) —— 语义与 Go 一致（含 CRLF 只算一个换行）。
 */
export class LineColumnTracker {
  contents: Uint8Array = new Uint8Array(0);
  prettyPaths: PrettyPaths = new PrettyPaths();
  offset = 0;
  line = 0;
  lineStart = 0;
  lineEnd = 0;
  hasLineStart = false;
  hasLineEnd = false;
  hasSource = false;

  /** Go: func (tracker *LineColumnTracker) MsgData(r Range, text string) MsgData */
  MsgData(r: Range, text: string): MsgData {
    const data = new MsgData();
    data.Text = text;
    data.Location = this.MsgLocationOrNil(r);
    return data;
  }

  /** Go: func (t *LineColumnTracker) scanTo(offset int32) */
  scanTo(offset: number): void {
    const contents = this.contents;
    let i = this.offset;

    // Scan forward
    if (i < offset) {
      for (;;) {
        const { r, width: size } = decodeRune(contents, i);
        i += size;

        switch (r) {
          case 0x0a: // '\n'
            this.hasLineStart = true;
            this.hasLineEnd = false;
            this.lineStart = i;
            if (i === size || contents[i - size - 1] !== 0x0d) this.line++;
            break;

          case 0x0d: // '\r'
          case 0x2028:
          case 0x2029:
            this.hasLineStart = true;
            this.hasLineEnd = false;
            this.lineStart = i;
            this.line++;
            break;
        }

        if (i >= offset) {
          this.offset = i;
          return;
        }
      }
    }

    // Scan backward
    if (i > offset) {
      for (;;) {
        const { r, width: size } = decodeLastRune(contents, i);
        i -= size;

        switch (r) {
          case 0x0a: // '\n'
            this.hasLineStart = false;
            this.hasLineEnd = true;
            this.lineEnd = i;
            if (i === 0 || contents[i - 1] !== 0x0d) this.line--;
            break;

          case 0x0d: // '\r'
          case 0x2028:
          case 0x2029:
            this.hasLineStart = false;
            this.hasLineEnd = true;
            this.lineEnd = i;
            this.line--;
            break;
        }

        if (i <= offset) {
          this.offset = i;
          return;
        }
      }
    }
  }

  /** Go: func (t *LineColumnTracker) computeLineAndColumn(offset int) (lineCount, columnCount, lineStart, lineEnd int) */
  computeLineAndColumn(offset: number): { lineCount: number; columnCount: number; lineStart: number; lineEnd: number } {
    this.scanTo(offset);

    // Scan for the start of the line
    if (!this.hasLineStart) {
      const contents = this.contents;
      let i = this.offset;
      while (i > 0) {
        const { r, width: size } = decodeLastRune(contents, i);
        if (r === 0x0a || r === 0x0d || r === 0x2028 || r === 0x2029) break;
        i -= size;
      }
      this.hasLineStart = true;
      this.lineStart = i;
    }

    // Scan for the end of the line
    if (!this.hasLineEnd) {
      const contents = this.contents;
      let i = this.offset;
      const n = contents.length;
      while (i < n) {
        const { r, width: size } = decodeRune(contents, i);
        if (r === 0x0a || r === 0x0d || r === 0x2028 || r === 0x2029) break;
        i += size;
      }
      this.hasLineEnd = true;
      this.lineEnd = i;
    }

    return {
      lineCount: this.line,
      columnCount: offset - this.lineStart,
      lineStart: this.lineStart,
      lineEnd: this.lineEnd,
    };
  }

  /** Go: func (tracker *LineColumnTracker) MsgLocationOrNil(r Range) *MsgLocation */
  MsgLocationOrNil(r: Range): MsgLocation | null {
    if (!this.hasSource) return null;

    // Convert the index into a line and column number
    const { lineCount, columnCount, lineStart, lineEnd } = this.computeLineAndColumn(r.Loc.Start);

    const loc = new MsgLocation();
    // Go 是值拷贝（PrettyPaths）；这里也拷一份，避免后续修改 Source 时把旧 msg 一起改掉
    loc.File = new PrettyPaths();
    loc.File.Abs = this.prettyPaths.Abs;
    loc.File.Rel = this.prettyPaths.Rel;
    loc.Line = lineCount + 1; // 0-based to 1-based
    loc.Column = columnCount;
    loc.Length = r.Len;
    loc.LineText = this.contents.subarray(lineStart, lineEnd);
    return loc;
  }
}

/** Go: func MakeLineColumnTracker(source *Source) LineColumnTracker */
export function MakeLineColumnTracker(source: Source | null): LineColumnTracker {
  const tracker = new LineColumnTracker();
  if (source === null) {
    tracker.hasSource = false;
    return tracker;
  }

  const prettyPaths = new PrettyPaths();
  prettyPaths.Abs = source.PrettyPaths.Abs;
  prettyPaths.Rel = source.PrettyPaths.Rel;

  tracker.contents = source.Contents;
  tracker.prettyPaths = prettyPaths;
  tracker.hasLineStart = true;
  tracker.hasSource = true;
  return tracker;
}

// ---------------------------------------------------------------------------
// Log / 打印器
// ---------------------------------------------------------------------------

/** Go: type DeferLogKind uint8 */
export type DeferLogKind = number;
export const DeferLogKind = {
  DeferLogAll: 0,
  DeferLogNoVerboseOrDebug: 1,
} as const;

/** Go: type Log struct { AddMsg, HasErrors, Peek, Done func...; Level LogLevel; Overrides map[MsgID]LogLevel } */
export class Log {
  AddMsg: (msg: Msg) => void = () => {};
  HasErrors: () => boolean = () => false;
  Peek: () => Msg[] = () => [];
  Done: () => Msg[] = () => [];

  Level: LogLevel = LogLevel.None;
  Overrides: Map<MsgID, LogLevel> | null = null;
}

/** Go: func allowOverride(overrides map[MsgID]LogLevel, id MsgID, kind MsgKind) (MsgKind, bool) */
export function allowOverride(
  overrides: Map<MsgID, LogLevel> | null,
  id: MsgID,
  kind: MsgKind,
): { kind: MsgKind; ok: boolean } {
  const logLevel = overrides === null ? undefined : overrides.get(id);
  if (logLevel !== undefined) {
    switch (logLevel) {
      case LogLevel.Verbose:
        return { kind: MsgKind.Verbose, ok: true };
      case LogLevel.Debug:
        return { kind: MsgKind.Debug, ok: true };
      case LogLevel.Info:
        return { kind: MsgKind.Info, ok: true };
      case LogLevel.Warning:
        return { kind: MsgKind.Warning, ok: true };
      case LogLevel.Error:
        return { kind: MsgKind.Error, ok: true };
      default:
        // Setting the log level to "silent" silences this log message
        return { kind: 0, ok: false };
    }
  }
  return { kind, ok: true };
}

/** Go: func (log Log) AddError(tracker *LineColumnTracker, r Range, text string) */
export function AddError(log: Log, tracker: LineColumnTracker | null, r: Range, text: string): void {
  const msg = new Msg();
  msg.Kind = MsgKind.Error;
  // Go: tracker.MsgData 在 nil receiver 下仍可用（MsgLocationOrNil 返回 nil）。
  msg.Data = tracker !== null ? tracker.MsgData(r, text) : (() => { const d = new MsgData(); d.Text = text; d.Location = null; return d; })();
  log.AddMsg(msg);
}

/** Go: func (log Log) AddID(id MsgID, kind MsgKind, tracker *LineColumnTracker, r Range, text string) */
export function AddID(
  log: Log,
  id: MsgID,
  kind: MsgKind,
  tracker: LineColumnTracker,
  r: Range,
  text: string,
): void {
  const override = allowOverride(log.Overrides, id, kind);
  if (override.ok) {
    const msg = new Msg();
    msg.ID = id;
    msg.Kind = override.kind;
    msg.Data = tracker.MsgData(r, text);
    log.AddMsg(msg);
  }
}

/** Go: func (log Log) AddErrorWithNotes(tracker *LineColumnTracker, r Range, text string, notes []MsgData) */
export function AddErrorWithNotes(
  log: Log,
  tracker: LineColumnTracker | null,
  r: Range,
  text: string,
  notes: MsgData[],
): void {
  const msg = new Msg();
  msg.Kind = MsgKind.Error;
  msg.Data = tracker !== null ? tracker.MsgData(r, text) : (() => { const d = new MsgData(); d.Text = text; d.Location = null; return d; })();
  msg.Notes = notes;
  log.AddMsg(msg);
}

/** Go: func (log Log) AddIDWithNotes(id MsgID, kind MsgKind, tracker *LineColumnTracker, r Range, text string, notes []MsgData) */
export function AddIDWithNotes(
  log: Log,
  id: MsgID,
  kind: MsgKind,
  tracker: LineColumnTracker,
  r: Range,
  text: string,
  notes: MsgData[],
): void {
  const override = allowOverride(log.Overrides, id, kind);
  if (override.ok) {
    const msg = new Msg();
    msg.ID = id;
    msg.Kind = override.kind;
    msg.Data = tracker.MsgData(r, text);
    msg.Notes = notes;
    log.AddMsg(msg);
  }
}

/** Go: func (log Log) AddMsgID(id MsgID, msg Msg) */
export function AddMsgID(log: Log, id: MsgID, msg: Msg): void {
  const override = allowOverride(log.Overrides, id, msg.Kind);
  if (override.ok) {
    // Go 的参数是**值**（`msg Msg` 结构体拷贝）：调用方的 msg 不会被改写，只有发出去的副本带 id/override。
    // 期望值由 Go 探针实测（tools/gen_cli_path_fixtures.go 末段；夹具 cli-paths.json 的 addMsgID* 字段）。
    // 拷贝粒度与 Go 的结构体拷贝一致：Data 整体复制（Location 是指针，两边共享），Notes 是 slice（共享底层数组）。
    const emitted = new Msg();
    const data = new MsgData();
    data.UserDetail = msg.Data.UserDetail;
    data.Location = msg.Data.Location;
    data.Text = msg.Data.Text;
    data.DisableMaximumWidth = msg.Data.DisableMaximumWidth;
    emitted.Data = data;
    emitted.Notes = msg.Notes;
    emitted.PluginName = msg.PluginName;
    emitted.ID = id;
    emitted.Kind = override.kind;
    log.AddMsg(emitted);
  }
}

/** Go: func NewDeferLog(kind DeferLogKind, overrides map[MsgID]LogLevel) Log */
export function NewDeferLog(kind: DeferLogKind, overrides: Map<MsgID, LogLevel> | null): Log {
  let msgs: Msg[] = [];
  let hasErrors = false;

  const log = new Log();
  log.Level = LogLevel.Info;
  log.Overrides = overrides;

  log.AddMsg = (msg: Msg): void => {
    if (kind === DeferLogKind.DeferLogNoVerboseOrDebug && (msg.Kind === MsgKind.Verbose || msg.Kind === MsgKind.Debug)) {
      return;
    }
    if (msg.Kind === MsgKind.Error) hasErrors = true;
    msgs.push(msg);
  };

  log.HasErrors = (): boolean => hasErrors;

  log.Peek = (): Msg[] => msgs.slice();

  log.Done = (): Msg[] => {
    stableSortMsgs(msgs);
    return msgs;
  };

  return log;
}

/** Go: sort.Stable(msgs) —— 稳定排序（比较器等价时保持输入顺序） */
function stableSortMsgs(msgs: Msg[]): void {
  const sortable = new SortableMsgs(msgs);
  const order = msgs.map((_, i) => i);
  order.sort((a, b) => (sortable.Less(a, b) ? -1 : sortable.Less(b, a) ? 1 : a - b));
  const out = order.map((i) => msgs[i]);
  for (let i = 0; i < out.length; i++) msgs[i] = out[i];
}

/** Go: func NewStderrLog(options OutputOptions) Log */
export function NewStderrLog(options: OutputOptions, file: FileLike = stderr): Log {
  let msgs: Msg[] = [];
  const terminalInfo = GetTerminalInfo(file);
  let errors = 0;
  let warnings = 0;
  let shownErrors = 0;
  let shownWarnings = 0;
  let hasErrors = false;
  let remainingMessagesBeforeLimit = options.MessageLimit;
  if (remainingMessagesBeforeLimit === 0) remainingMessagesBeforeLimit = 0x7fffffff;
  let deferredWarnings: Msg[] = [];

  const finalizeLog = (): void => {
    // Print the deferred warning now if there was no error after all
    while (remainingMessagesBeforeLimit > 0 && deferredWarnings.length > 0) {
      shownWarnings++;
      writeStringWithColor(file, deferredWarnings[0].String(options, terminalInfo));
      deferredWarnings = deferredWarnings.slice(1);
      remainingMessagesBeforeLimit--;
    }

    // Print out a summary
    if (options.MessageLimit > 0 && errors + warnings > options.MessageLimit) {
      writeStringWithColor(
        file,
        utf8(
          `${errorAndWarningSummary(errors, warnings, shownErrors, shownWarnings)}` +
            " shown (disable the message limit with --log-limit=0)\n",
        ),
      );
    } else if (options.LogLevel <= LogLevel.Info && (warnings !== 0 || errors !== 0)) {
      writeStringWithColor(file, utf8(`${errorAndWarningSummary(errors, warnings, shownErrors, shownWarnings)}\n`));
    }
  };

  switch (options.Color) {
    case UseColor.ColorNever:
      terminalInfo.UseColorEscapes = false;
      break;
    case UseColor.ColorAlways:
      terminalInfo.UseColorEscapes = SupportsColorEscapes;
      break;
  }

  const log = new Log();
  log.Level = options.LogLevel;
  log.Overrides = options.Overrides;

  log.AddMsg = (msg: Msg): void => {
    msgs.push(msg);

    switch (msg.Kind) {
      case MsgKind.Verbose:
        if (options.LogLevel <= LogLevel.Verbose) writeStringWithColor(file, msg.String(options, terminalInfo));
        break;

      case MsgKind.Debug:
        if (options.LogLevel <= LogLevel.Debug) writeStringWithColor(file, msg.String(options, terminalInfo));
        break;

      case MsgKind.Info:
        if (options.LogLevel <= LogLevel.Info) writeStringWithColor(file, msg.String(options, terminalInfo));
        break;

      case MsgKind.Error:
        hasErrors = true;
        if (options.LogLevel <= LogLevel.Error) errors++;
        break;

      case MsgKind.Warning:
        if (options.LogLevel <= LogLevel.Warning) warnings++;
        break;
    }

    // Be silent if we're past the limit so we don't flood the terminal
    if (remainingMessagesBeforeLimit === 0) return;

    switch (msg.Kind) {
      case MsgKind.Error:
        if (options.LogLevel <= LogLevel.Error) {
          shownErrors++;
          writeStringWithColor(file, msg.String(options, terminalInfo));
          remainingMessagesBeforeLimit--;
        }
        break;

      case MsgKind.Warning:
        if (options.LogLevel <= LogLevel.Warning) {
          if (remainingMessagesBeforeLimit > Math.trunc((options.MessageLimit + 1) / 2)) {
            shownWarnings++;
            writeStringWithColor(file, msg.String(options, terminalInfo));
            remainingMessagesBeforeLimit--;
          } else {
            // If we have less than half of the slots left, wait for potential
            // future errors instead of using up all of the slots with warnings.
            // We want the log for a failed build to always have at least one
            // error in it.
            deferredWarnings.push(msg);
          }
        }
        break;
    }
  };

  log.HasErrors = (): boolean => hasErrors;

  log.Peek = (): Msg[] => {
    stableSortMsgs(msgs);
    return msgs.slice();
  };

  log.Done = (): Msg[] => {
    finalizeLog();
    stableSortMsgs(msgs);
    return msgs;
  };

  return log;
}

/** Go: func PrintErrorToStderr(osArgs []string, text string) */
export function PrintErrorToStderr(osArgs: string[], text: string, file: FileLike = stderr): void {
  const msg = new Msg();
  msg.Kind = MsgKind.Error;
  msg.Data = new MsgData();
  msg.Data.Text = text;
  PrintMessageToStderr(osArgs, msg, file);
}

/** Go: func PrintErrorWithNoteToStderr(osArgs []string, text string, note string) */
export function PrintErrorWithNoteToStderr(
  osArgs: string[],
  text: string,
  note: string,
  file: FileLike = stderr,
): void {
  const msg = new Msg();
  msg.Kind = MsgKind.Error;
  msg.Data = new MsgData();
  msg.Data.Text = text;
  if (note !== "") {
    const data = new MsgData();
    data.Text = note;
    msg.Notes = [data];
  }
  PrintMessageToStderr(osArgs, msg, file);
}

/** Go: func OutputOptionsForArgs(osArgs []string) OutputOptions */
export function OutputOptionsForArgs(osArgs: string[]): OutputOptions {
  const options = new OutputOptions();
  options.IncludeSource = true;

  // Implement a mini argument parser so these options always work even if we
  // haven't yet gotten to the general-purpose argument parsing code
  for (const arg of osArgs) {
    switch (arg) {
      case "--color=false":
        options.Color = UseColor.ColorNever;
        break;
      case "--color=true":
      case "--color":
        options.Color = UseColor.ColorAlways;
        break;

      case "--log-level=info":
        options.LogLevel = LogLevel.Info;
        break;
      case "--log-level=warning":
        options.LogLevel = LogLevel.Warning;
        break;
      case "--log-level=error":
        options.LogLevel = LogLevel.Error;
        break;
      case "--log-level=silent":
        options.LogLevel = LogLevel.Silent;
        break;

      case "--log-style=default":
        options.LogStyle = LogStyle.StyleDefault;
        break;
      // NOTE: Go 源码这里就是 "--log-level=clang"/"--log-level=visualstudio"（疑似笔误），
      // 1:1 照抄，不修。
      case "--log-level=clang":
        options.LogStyle = LogStyle.StyleClang;
        break;
      case "--log-level=visualstudio":
        options.LogStyle = LogStyle.StyleVisualStudio;
        break;
    }
  }

  return options;
}

/** Go: func PrintMessageToStderr(osArgs []string, msg Msg) */
export function PrintMessageToStderr(osArgs: string[], msg: Msg, file: FileLike = stderr): void {
  const log = NewStderrLog(OutputOptionsForArgs(osArgs), file);
  log.AddMsg(msg);
  log.Done();
}

/** Go: func PrintText(file *os.File, level LogLevel, osArgs []string, callback func(Colors) string) */
export function PrintText(
  file: FileLike,
  level: LogLevel,
  osArgs: string[],
  callback: (colors: Colors) => Uint8Array,
): void {
  const options = OutputOptionsForArgs(osArgs);

  // Skip logging these if these logs are disabled
  if (options.LogLevel > level) return;

  PrintTextWithColor(file, options.Color, callback);
}

/** Go: func PrintTextWithColor(file *os.File, useColor UseColor, callback func(Colors) string) */
export function PrintTextWithColor(
  file: FileLike,
  useColor: UseColor,
  callback: (colors: Colors) => Uint8Array,
): void {
  let useColorEscapes: boolean;
  switch (useColor) {
    case UseColor.ColorNever:
      useColorEscapes = false;
      break;
    case UseColor.ColorAlways:
      useColorEscapes = SupportsColorEscapes;
      break;
    default: // ColorIfTerminal
      useColorEscapes = GetTerminalInfo(file).UseColorEscapes;
      break;
  }

  let colors = new Colors();
  if (useColorEscapes) colors = TerminalColors;
  writeStringWithColor(file, callback(colors));
}

/** Go: type SummaryTableEntry struct { Dir, Base, Size string; Bytes int; IsSourceMap bool } */
export class SummaryTableEntry {
  Dir = "";
  Base = "";
  Size = "";
  Bytes = 0;
  IsSourceMap = false;
}

/** Go: type SummaryTable []SummaryTableEntry —— 这个类型只是为了用 Go 的原生排序 */
export class SummaryTable {
  entries: SummaryTableEntry[];

  constructor(entries: SummaryTableEntry[] = []) {
    this.entries = entries;
  }

  /** Go: func (t SummaryTable) Len() int */
  Len(): number {
    return this.entries.length;
  }

  /** Go: func (t SummaryTable) Swap(i int, j int) */
  Swap(i: number, j: number): void {
    const x = this.entries[i];
    this.entries[i] = this.entries[j];
    this.entries[j] = x;
  }

  /** Go: func (t SummaryTable) Less(i int, j int) bool */
  Less(i: number, j: number): boolean {
    const ti = this.entries[i];
    const tj = this.entries[j];

    // Sort source maps last
    if (!ti.IsSourceMap && tj.IsSourceMap) return true;
    if (ti.IsSourceMap && !tj.IsSourceMap) return false;

    // Sort by size first
    if (ti.Bytes > tj.Bytes) return true;
    if (ti.Bytes < tj.Bytes) return false;

    // Sort alphabetically by directory first（Go 的 string 比较是按字节）
    if (compareBytes(utf8(ti.Dir), utf8(tj.Dir)) < 0) return true;
    if (compareBytes(utf8(ti.Dir), utf8(tj.Dir)) > 0) return false;

    // Then sort alphabetically by file name
    return compareBytes(utf8(ti.Base), utf8(tj.Base)) < 0;
  }
}

/** Show a warning icon next to output files that are 1mb or larger */
const sizeWarningThreshold = 1024 * 1024;

/** Go: func PrintSummary(useColor UseColor, table SummaryTable, start *time.Time) */
export function PrintSummary(useColor: UseColor, table: SummaryTable, start: Date | null): void {
  PrintTextWithColor(stderr, useColor, (colors: Colors): Uint8Array => {
    const isProbablyCMD = isProbablyWindowsCommandPrompt();
    const sb = new ByteBuilder();

    let entries = table.entries;
    if (entries.length > 0) {
      const info = GetTerminalInfo(stderr);

      // Truncate the table in case it's really long
      let maxLength = Math.trunc(info.Height / 2);
      if (info.Height === 0) {
        maxLength = 20;
      } else if (maxLength < 5) {
        maxLength = 5;
      }
      const length = entries.length;
      sortSummaryTable(table);
      if (length > maxLength) entries = entries.slice(0, maxLength);

      // Compute the maximum width of the size column
      const spacingBetweenColumns = 2;
      let hasSizeWarning = false;
      let maxPath = 0;
      let maxSize = 0;
      for (const entry of entries) {
        const path = byteLen(entry.Dir) + byteLen(entry.Base);
        const size = byteLen(entry.Size) + spacingBetweenColumns;
        if (path > maxPath) maxPath = path;
        if (size > maxSize) maxSize = size;
        if (!entry.IsSourceMap && entry.Bytes >= sizeWarningThreshold) hasSizeWarning = true;
      }

      const margin = "  ";
      let layoutWidth = info.Width;
      if (layoutWidth < 1) layoutWidth = defaultTerminalWidth;
      layoutWidth -= 2 * byteLen(margin);
      if (hasSizeWarning) {
        // Add space for the warning icon
        layoutWidth -= 2;
      }
      if (layoutWidth > maxPath + maxSize) layoutWidth = maxPath + maxSize;
      sb.writeByte(0x0a);

      for (const entry of entries) {
        let dir = utf8(entry.Dir);
        let base = utf8(entry.Base);
        const pathWidth = layoutWidth - maxSize;

        // Truncate the path with "..." to fit on one line
        if (dir.length + base.length > pathWidth) {
          // Trim the directory from the front, leaving the trailing slash
          if (dir.length > 0) {
            let n = pathWidth - base.length - 3;
            if (n < 1) n = 1;
            dir = concatBytes([utf8("..."), dir.subarray(dir.length - n)]);
          }

          // Trim the file name from the back
          if (dir.length + base.length > pathWidth) {
            let n = pathWidth - dir.length - 3;
            if (n < 0) n = 0;
            base = concatBytes([base.subarray(0, n), utf8("...")]);
          }
        }

        let spacer = layoutWidth - byteLen(entry.Size) - dir.length - base.length;
        if (spacer < 0) spacer = 0;

        // Put a warning next to the size if it's above a certain threshold
        let sizeColor = colors.Cyan;
        let sizeWarning = "";
        if (!entry.IsSourceMap && entry.Bytes >= sizeWarningThreshold) {
          sizeColor = colors.Yellow;

          // Emoji don't work in Windows Command Prompt
          if (!isProbablyCMD) sizeWarning = " ⚠️";
        }

        sb.writeString(margin);
        sb.writeString(colors.Dim);
        sb.writeBytes(dir);
        sb.writeString(colors.Reset);
        sb.writeString(colors.Bold);
        sb.writeBytes(base);
        sb.writeString(colors.Reset);
        sb.writeBytes(spaces(spacer));
        sb.writeString(sizeColor);
        sb.writeString(entry.Size);
        sb.writeString(sizeWarning);
        sb.writeString(colors.Reset);
        sb.writeByte(0x0a);
      }

      // Say how many remaining files are not shown
      if (length > maxLength) {
        let plural = "s";
        if (length === maxLength + 1) plural = "";
        sb.writeString(margin);
        sb.writeString(colors.Dim);
        sb.writeString(`...and ${length - maxLength} more output file${plural}...`);
        sb.writeString(colors.Reset);
        sb.writeByte(0x0a);
      }
    }
    sb.writeByte(0x0a);

    let lightningSymbol = "⚡ ";

    // Emoji don't work in Windows Command Prompt
    if (isProbablyCMD) lightningSymbol = "";

    // Printing the time taken is optional
    if (start !== null) {
      sb.writeString(lightningSymbol);
      sb.writeString(colors.Green);
      sb.writeString(`Done in ${Date.now() - start.getTime()}ms`);
      sb.writeString(colors.Reset);
      sb.writeByte(0x0a);
    }

    return sb.bytes();
  });
}

/** Go: sort.Sort(table) —— 不稳定排序；TS 的 Array#sort 是稳定的（只有完全相等的条目顺序可能不同） */
function sortSummaryTable(table: SummaryTable): void {
  const entries = table.entries;
  const order = entries.map((_, i) => i);
  order.sort((a, b) => (table.Less(a, b) ? -1 : table.Less(b, a) ? 1 : a - b));
  const out = order.map((i) => entries[i]);
  for (let i = 0; i < out.length; i++) entries[i] = out[i];
}

// ============================================================================
// 第 172 批：Yarn PnP 内嵌 JSON 的位置重映射（Go logger.go:1467-1642）
//
// .pnp.js 把 manifest JSON 塞在 JS 字符串字面量里，JSON 解析诊断的行列必须映射
// 回外层 JS 文件坐标。此前这三件套在文件头登记为「永久缺口 / M4 收口 pkg/api 时补」，
// 理由是「只有 JS API 错误位置重映射才用到」；但第 72 轮明确要求搭厚 PnP 底座来
// 正面落地 tryToExtractYarnPnPDataFromJS，而它唯一的 JS 拦截路径（JSON.parse 分支）
// 正是这三件套的调用方 —— 原「回来条件」已经触发，故本批按 Go 1:1 补齐。
// 与 [15766]/[15902] 的「按约束不碰」不冲突：那条约束的前提是「PnP JS 路径不在范围内」，
// 前提已被本轮新要求推翻，属于按既定回来条件回归，不是擅自扩大范围。
// ============================================================================

/** Go: type StringInJSTableEntry struct {...} (logger.go:1467) */
export class StringInJSTableEntry {
  innerLine: number;
  innerColumn: number;
  innerLoc: Loc;
  outerLoc: Loc;

  constructor(innerLine: number, innerColumn: number, innerLoc: Loc, outerLoc: Loc) {
    this.innerLine = innerLine | 0;
    this.innerColumn = innerColumn | 0;
    this.innerLoc = innerLoc;
    this.outerLoc = outerLoc;
  }
}

const RUNE_LF = 0x0a, RUNE_CR = 0x0d, RUNE_BACKSLASH = 0x5c;
const RUNE_LS = 0x2028, RUNE_PS = 0x2029;
const RUNE_x = 0x78, RUNE_u = 0x75, RUNE_LBRACE = 0x7b, RUNE_RBRACE = 0x7d;

function isNewlineRune(c: number): boolean {
  return c === RUNE_LF || c === RUNE_CR || c === RUNE_LS || c === RUNE_PS;
}

/**
 * Go: func GenerateStringInJSTable(outerContents string, outerStringLiteralLoc Loc, innerContents string) []StringInJSTableEntry (logger.go:1477)
 *
 * DEVIATION：Go 的 string 是字节串，用 Uint8Array 承载；utf8.DecodeRuneInString → decodeRune。
 * 所有逐字节分支（行续行、\x / \u{...} 转义、CRLF 双字节换行）与 Go 逐一对应。
 */
export function GenerateStringInJSTable(
  outerContents: Uint8Array,
  outerStringLiteralLoc: Loc,
  innerContents: Uint8Array,
): StringInJSTableEntry[] {
  const table: StringInJSTableEntry[] = [];
  let i = 0;
  const n = innerContents.length;
  let line = 1;
  let column = 0;
  let locStart = outerStringLiteralLoc.Start + 1;

  while (i < n) {
    // Ignore line continuations. A line continuation is not an escaped newline.
    for (;;) {
      if (decodeRune(outerContents, locStart).r !== RUNE_BACKSLASH) break;
      const esc = decodeRune(outerContents, locStart + 1);
      if (isNewlineRune(esc.r)) {
        locStart += 1 + esc.width;
        if (esc.r === RUNE_CR && outerContents[locStart] === RUNE_LF) locStart++;
        continue;
      }
      break;
    }

    const innerRune = decodeRune(innerContents, i);
    const c = innerRune.r;
    const width = innerRune.width;

    // Compress the table using run-length encoding
    table.push(new StringInJSTableEntry(line, column, new Loc(i), new Loc(locStart)));
    if (table.length > 1) {
      const last = table[table.length - 2];
      if (line === last.innerLine && locStart - column === last.outerLoc.Start - last.innerColumn) {
        table.pop();
      }
    }

    // Advance the inner line/column
    if (isNewlineRune(c)) {
      line++;
      column = 0;
      if (c === RUNE_CR && i + 1 < n && innerContents[i + 1] === RUNE_LF) i++;
    } else {
      column += width;
    }
    i += width;

    // Advance the outer loc, assuming the string syntax is already valid
    const outerRune = decodeRune(outerContents, locStart);
    const oc = outerRune.r;
    if (oc === RUNE_CR && outerContents[locStart + 1] === RUNE_LF) {
      locStart += 2;
    } else if (oc !== RUNE_BACKSLASH) {
      locStart += outerRune.width;
    } else {
      const esc = decodeRune(outerContents, locStart + 1);
      if (esc.r === RUNE_x) {
        locStart += 1 + 2;
      } else if (esc.r === RUNE_u) {
        locStart++;
        if (outerContents[locStart] === RUNE_LBRACE) {
          while (locStart < outerContents.length && outerContents[locStart] !== RUNE_RBRACE) locStart++;
          locStart++;
        } else {
          locStart += 4;
        }
      } else if (isNewlineRune(esc.r)) {
        // This will be handled by the next iteration
      } else {
        locStart += 1 + esc.width;
      }
    }
  }

  return table;
}

/** Go: func RemapStringInJSLoc(table []StringInJSTableEntry, innerLoc Loc) Loc (logger.go:1570) */
export function RemapStringInJSLoc(table: StringInJSTableEntry[], innerLoc: Loc): Loc {
  // Go 对空表会 panic；TS 防御性返回原 loc（正常 PnP 输入 innerContents 非空，表必有条目）。
  if (table.length === 0) return innerLoc;
  let count = table.length;
  let index = 0;
  while (count > 0) {
    const step = Math.floor(count / 2);
    const i = index + step;
    if (i + 1 < table.length) {
      if (table[i + 1].innerLoc.Start < innerLoc.Start) {
        index = i + 1;
        count -= step + 1;
        continue;
      }
    }
    count = step;
  }
  const entry = table[index];
  // Go 里 entry 是值拷贝，修改 outerLoc.Start 不动原表；TS 必须显式 new Loc 避免污染表。
  return new Loc(entry.outerLoc.Start + innerLoc.Start - entry.innerLoc.Start);
}

/**
 * Go: func NewStringInJSLog(log Log, outerTracker *LineColumnTracker, table []StringInJSTableEntry) Log (logger.go:1593)
 *
 * DEVIATION：Go 的 Log/Msg/MsgData 是值类型（按值传、改字段只影响副本）；TS 用 class，
 * 故这里显式构造新的 Log/Msg/MsgData 副本，绝不原地改调用方的 log 或 msg。
 */
export function NewStringInJSLog(
  log: Log, outerTracker: LineColumnTracker, table: StringInJSTableEntry[],
): Log {
  const oldAddMsg = log.AddMsg;

  const remapLineAndColumnToLoc = (line: number, column: number): Loc => {
    if (table.length === 0) return new Loc(0);
    let count = table.length;
    let index = 0;
    while (count > 0) {
      const step = Math.floor(count / 2);
      const i = index + step;
      if (i + 1 < table.length) {
        const e = table[i + 1];
        if (e.innerLine < line || (e.innerLine === line && e.innerColumn < column)) {
          index = i + 1;
          count -= step + 1;
          continue;
        }
      }
      count = step;
    }
    const e = table[index];
    return new Loc(e.outerLoc.Start + column - e.innerColumn);
  };

  const remapData = (data: MsgData): MsgData => {
    if (data.Location === null) return data;
    const loc = remapLineAndColumnToLoc(data.Location.Line, data.Location.Column);
    const r = new Range(loc, 0);
    if (data.Location.Length !== 0) {
      r.Len = remapLineAndColumnToLoc(data.Location.Line, data.Location.Column + data.Location.Length).Start - loc.Start;
    }
    const location = outerTracker.MsgData(r, data.Text).Location!;
    location.Suggestion = data.Location.Suggestion;
    const out = new MsgData();
    out.UserDetail = data.UserDetail;
    out.Location = location;
    out.Text = data.Text;
    out.DisableMaximumWidth = data.DisableMaximumWidth;
    return out;
  };

  const wrapped = new Log();
  wrapped.AddMsg = (msg: Msg): void => {
    const out = new Msg();
    out.PluginName = msg.PluginName;
    out.Kind = msg.Kind;
    out.ID = msg.ID;
    out.Data = remapData(msg.Data);
    out.Notes = msg.Notes.map((note) => remapData(note));
    oldAddMsg(out);
  };
  wrapped.HasErrors = log.HasErrors;
  wrapped.Peek = log.Peek;
  wrapped.Done = log.Done;
  wrapped.Level = log.Level;
  wrapped.Overrides = log.Overrides;
  return wrapped;
}
