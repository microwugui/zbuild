// 1:1 移植自 esbuild internal/helpers/strings.go（v0.28.2）
// 该文件里的字符串是配置/报错文本，用 JS string 承载。
// StringArrayToQuotedCommaSeparatedString 复刻 Go fmt.Sprintf("%q") 即 strconv.Quote。

/** Go: func StringArraysEqual(a []string, b []string) bool */
// DEVIATION: Go 的 nil slice 长度是 0，JSON 夹具里就是 `null`；TS 必须同样把 null 当空数组，
// 否则 `StringArraysEqual(nil, nil)` 会抛 TypeError（Go 返回 true）。
export function StringArraysEqual(a: string[] | null, b: string[] | null): boolean {
  const aLen = a === null ? 0 : a.length;
  const bLen = b === null ? 0 : b.length;
  if (aLen !== bLen) return false;
  for (let i = 0; i < aLen; i++) if (a![i] !== b![i]) return false;
  return true;
}

/** Go: func StringArrayArraysEqual(a [][]string, b [][]string) bool */
export function StringArrayArraysEqual(a: (string[] | null)[] | null, b: (string[] | null)[] | null): boolean {
  const aLen = a === null ? 0 : a.length;
  const bLen = b === null ? 0 : b.length;
  if (aLen !== bLen) return false;
  for (let i = 0; i < aLen; i++) if (!StringArraysEqual(a![i], b![i])) return false;
  return true;
}

/** Go: func StringArrayToQuotedCommaSeparatedString(a []string) string */
export function StringArrayToQuotedCommaSeparatedString(a: string[]): string {
  let sb = "";
  for (let i = 0; i < a.length; i++) {
    if (i > 0) sb += ", ";
    sb += goQuote(a[i]);
  }
  return sb;
}

const hexDigits = "0123456789abcdef";

/** 复刻 Go strconv.Quote 的转义规则（输入视为合法 UTF-16 文本） */
function goQuote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const r = ch.codePointAt(0)!;
    switch (r) {
      case 0x07: out += "\\a"; break;
      case 0x08: out += "\\b"; break;
      case 0x0c: out += "\\f"; break;
      case 0x0a: out += "\\n"; break;
      case 0x0d: out += "\\r"; break;
      case 0x09: out += "\\t"; break;
      case 0x0b: out += "\\v"; break;
      case 0x5c: out += "\\\\"; break;
      case 0x22: out += '\\"'; break;
      default:
        if (r >= 0x20 && r <= 0x7e) {
          out += ch;
        } else if (r < 0x20 || r === 0x7f) {
          out += "\\x" + hex(r, 2);
        } else if (isPrintGo(ch)) {
          out += ch;
        } else if (r <= 0xffff) {
          out += "\\u" + hex(r, 4);
        } else {
          out += "\\U" + hex(r, 8);
        }
    }
  }
  return out + '"';
}

function hex(n: number, width: number): string {
  let s = "";
  for (let i = width - 1; i >= 0; i--) s += hexDigits[(n >> (i * 4)) & 15];
  return s;
}

/**
 * Go unicode.IsPrint：类别 L/M/N/P/S 以及 ASCII 空格。
 * 用 JS 的 Unicode 属性转义近似同一集合（Z 类中只保留 ASCII 空格）。
 */
function isPrintGo(ch: string): boolean {
  return ch === " " || /[\p{L}\p{M}\p{N}\p{P}\p{S}]/u.test(ch);
}
