// 1:1 移植自 esbuild internal/js_ast/js_ident.go（v0.28.2，commit f6058f83）
//
// 第 12 次推进落了 js_lexer 依赖的四个函数；第 13 次推进补齐剩余 6 个：
//   IsIdentifierES5AndESNext / ForceValidIdentifier / IsIdentifierUTF16 /
//   IsIdentifierES5AndESNextUTF16 / IsIdentifierStartES5AndESNext / IsIdentifierContinueES5AndESNext。
// 至此 js_ident.go 10/10。
//
// DEVIATION：Go 的 `text string` 是 UTF-8 字节串，TS 侧用 `Uint8Array` 承载（与 helpers/utf.ts 一致）；
// 逐 rune 遍历用 `decodeRune`（复刻 Go 的 `utf8.DecodeRuneInString`：非法字节 → U+FFFD, width 1）。
//
// 坑（第 11 次推进踩到并修）：TS 的 `case 0x61, 0x62, ...:` 是**逗号运算符**，只匹配最后一个值。
// Go 那种多值 case 必须写成多个 case 标签（或等价的区间判断）。下面用区间判断，
// 与 Go 的显式清单（46/53 个 ASCII 码点）逐点等价，且更不容易写错。

import { decodeRune, utf8, concatBytes } from "../logger/bytes.ts";
import { isInRangeTable, UnicodeRangeTables } from "./unicode.ts";

/** Go: func IsIdentifier(text string) bool */
export function IsIdentifier(text: Uint8Array): boolean {
  if (text.length === 0) return false;
  let i = 0;
  let first = true;
  while (i < text.length) {
    const { r, width } = decodeRune(text, i);
    if (first) {
      if (!IsIdentifierStart(r)) return false;
      first = false;
    } else if (!IsIdentifierContinue(r)) {
      return false;
    }
    i += width;
  }
  return true;
}

/** Go: func IsIdentifierStart(codePoint rune) bool */
export function IsIdentifierStart(codePoint: number): boolean {
  // switch codePoint { case '_', '$', 'a'..'z', 'A'..'Z': return true }
  if (codePoint === 0x5f || codePoint === 0x24) return true;
  if (codePoint >= 0x61 && codePoint <= 0x7a) return true;
  if (codePoint >= 0x41 && codePoint <= 0x5a) return true;

  // All ASCII identifier start code points are listed above
  if (codePoint < 0x7f) return false;

  return isInRangeTable(UnicodeRangeTables.idStartES5OrESNext, codePoint);
}

/** Go: func IsIdentifierContinue(codePoint rune) bool */
export function IsIdentifierContinue(codePoint: number): boolean {
  // switch codePoint { case '_', '$', '0'..'9', 'a'..'z', 'A'..'Z': return true }
  if (codePoint === 0x5f || codePoint === 0x24) return true;
  if (codePoint >= 0x30 && codePoint <= 0x39) return true;
  if (codePoint >= 0x61 && codePoint <= 0x7a) return true;
  if (codePoint >= 0x41 && codePoint <= 0x5a) return true;

  // All ASCII identifier start code points are listed above
  if (codePoint < 0x7f) return false;

  // ZWNJ and ZWJ are allowed in identifiers
  if (codePoint === 0x200c || codePoint === 0x200d) return true;

  return isInRangeTable(UnicodeRangeTables.idContinueES5OrESNext, codePoint);
}

// See the "White Space Code Points" table in the ECMAScript standard
/** Go: func IsWhitespace(codePoint rune) bool */
export function IsWhitespace(codePoint: number): boolean {
  switch (codePoint) {
    case 0x0009: // character tabulation
    case 0x000b: // line tabulation
    case 0x000c: // form feed
    case 0x0020: // space
    case 0x00a0: // no-break space

    // Unicode "Space_Separator" code points
    case 0x1680: // ogham space mark
    case 0x2000: // en quad
    case 0x2001: // em quad
    case 0x2002: // en space
    case 0x2003: // em space
    case 0x2004: // three-per-em space
    case 0x2005: // four-per-em space
    case 0x2006: // six-per-em space
    case 0x2007: // figure space
    case 0x2008: // punctuation space
    case 0x2009: // thin space
    case 0x200a: // hair space
    case 0x202f: // narrow no-break space
    case 0x205f: // medium mathematical space
    case 0x3000: // ideographic space

    case 0xfeff: // zero width non-breaking space
      return true;

    default:
      return false;
  }
}

/** Go: func IsIdentifierES5AndESNext(text string) bool */
export function IsIdentifierES5AndESNext(text: Uint8Array): boolean {
  if (text.length === 0) return false;
  let i = 0;
  let first = true;
  while (i < text.length) {
    const { r, width } = decodeRune(text, i);
    if (first) {
      if (!IsIdentifierStartES5AndESNext(r)) return false;
      first = false;
    } else if (!IsIdentifierContinueES5AndESNext(r)) {
      return false;
    }
    i += width;
  }
  return true;
}

/** Go: func ForceValidIdentifier(prefix string, text string) string */
export function ForceValidIdentifier(prefix: Uint8Array, text: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];

  // Private identifiers must be prefixed by "#"
  if (prefix.length > 0) parts.push(prefix);

  // Identifier start（Go 对空串也会先取一次 DecodeRuneInString，得到 RuneError，
  // 于是写 '_'；这里必须同样特判）
  if (text.length === 0) {
    parts.push(utf8("_"));
    return concatBytes(parts);
  }

  let i = 0;
  {
    const { r, width } = decodeRune(text, i);
    i += width;
    parts.push(utf8(IsIdentifierStart(r) ? String.fromCodePoint(r) : "_"));
  }

  // Identifier continue
  while (i < text.length) {
    const { r, width } = decodeRune(text, i);
    i += width;
    parts.push(utf8(IsIdentifierContinue(r) ? String.fromCodePoint(r) : "_"));
  }

  return concatBytes(parts);
}

// This does "IsIdentifier(UTF16ToString(text))" without any allocations
/** Go: func IsIdentifierUTF16(text []uint16) bool */
export function IsIdentifierUTF16(text: Uint16Array | number[]): boolean {
  const n = text.length;
  if (n === 0) return false;
  for (let i = 0; i < n; i++) {
    const isStart = i === 0;
    let r1 = text[i];
    if (r1 >= 0xd800 && r1 <= 0xdbff && i + 1 < n) {
      const r2 = text[i + 1];
      if (r2 >= 0xdc00 && r2 <= 0xdfff) {
        r1 = (r1 << 10) + r2 + (0x10000 - (0xd800 << 10) - 0xdc00);
        i++;
      }
    }
    if (isStart) {
      if (!IsIdentifierStart(r1)) return false;
    } else if (!IsIdentifierContinue(r1)) {
      return false;
    }
  }
  return true;
}

// This does "IsIdentifierES5AndESNext(UTF16ToString(text))" without any allocations
/** Go: func IsIdentifierES5AndESNextUTF16(text []uint16) bool */
export function IsIdentifierES5AndESNextUTF16(text: Uint16Array | number[]): boolean {
  const n = text.length;
  if (n === 0) return false;
  for (let i = 0; i < n; i++) {
    const isStart = i === 0;
    let r1 = text[i];
    if (r1 >= 0xd800 && r1 <= 0xdbff && i + 1 < n) {
      const r2 = text[i + 1];
      if (r2 >= 0xdc00 && r2 <= 0xdfff) {
        r1 = (r1 << 10) + r2 + (0x10000 - (0xd800 << 10) - 0xdc00);
        i++;
      }
    }
    if (isStart) {
      if (!IsIdentifierStartES5AndESNext(r1)) return false;
    } else if (!IsIdentifierContinueES5AndESNext(r1)) {
      return false;
    }
  }
  return true;
}

/** Go: func IsIdentifierStartES5AndESNext(codePoint rune) bool */
export function IsIdentifierStartES5AndESNext(codePoint: number): boolean {
  if (codePoint === 0x5f || codePoint === 0x24) return true;
  if (codePoint >= 0x61 && codePoint <= 0x7a) return true;
  if (codePoint >= 0x41 && codePoint <= 0x5a) return true;

  // All ASCII identifier start code points are listed above
  if (codePoint < 0x7f) return false;

  return isInRangeTable(UnicodeRangeTables.idStartES5AndESNext, codePoint);
}

/** Go: func IsIdentifierContinueES5AndESNext(codePoint rune) bool */
export function IsIdentifierContinueES5AndESNext(codePoint: number): boolean {
  if (codePoint === 0x5f || codePoint === 0x24) return true;
  if (codePoint >= 0x30 && codePoint <= 0x39) return true;
  if (codePoint >= 0x61 && codePoint <= 0x7a) return true;
  if (codePoint >= 0x41 && codePoint <= 0x5a) return true;

  // All ASCII identifier start code points are listed above
  if (codePoint < 0x7f) return false;

  // ZWNJ and ZWJ are allowed in identifiers
  if (codePoint === 0x200c || codePoint === 0x200d) return true;

  return isInRangeTable(UnicodeRangeTables.idContinueES5AndESNext, codePoint);
}
