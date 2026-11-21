// 1:1 移植自 esbuild internal/helpers/quote.go（commit f6058f83, v0.28.2）
//
// DEVIATION: Go 的 string 参数/[]byte 返回值统一用 Uint8Array 表达字节语义。

import { DecodeWTF8Rune } from "./utf.ts";

const hexChars = "0123456789ABCDEF";
const firstASCII = 0x20;
const lastASCII = 0x7e;
const firstHighSurrogate = 0xd800;
const firstLowSurrogate = 0xdc00;
const lastLowSurrogate = 0xdfff;

/** Go: func canPrintWithoutEscape(c rune, asciiOnly bool) bool */
export function canPrintWithoutEscape(c: number, asciiOnly: boolean): boolean {
  if (c <= lastASCII) {
    return c >= firstASCII && c !== 0x5c /* \ */ && c !== 0x22 /* " */;
  }
  return !asciiOnly && c !== 0xfeff && (c < firstHighSurrogate || c > lastLowSurrogate);
}

/** Go: func QuoteSingle(text string, asciiOnly bool) []byte */
export function QuoteSingle(text: Uint8Array, asciiOnly: boolean): Uint8Array {
  return internalQuote(text, asciiOnly, 0x27 /* ' */);
}

/** Go: func QuoteForJSON(text string, asciiOnly bool) []byte */
export function QuoteForJSON(text: Uint8Array, asciiOnly: boolean): Uint8Array {
  return internalQuote(text, asciiOnly, 0x22 /* " */);
}

/** Go: func internalQuote(text string, asciiOnly bool, quoteChar byte) []byte */
export function internalQuote(text: Uint8Array, asciiOnly: boolean, quoteChar: number): Uint8Array {
  // Estimate the required length（Go 侧只是预估容量，TS 用数组动态增长，保留逻辑以便对照）
  let lenEstimate = 2;
  let estI = 0;
  while (estI < text.length) {
    const { r: c, width } = DecodeWTF8Rune(text, estI);
    if (canPrintWithoutEscape(c, asciiOnly)) {
      lenEstimate += width;
    } else {
      switch (c) {
        case 0x08: case 0x0c: case 0x0a: case 0x0d: case 0x09: case 0x5c:
          lenEstimate += 2;
          break;
        case 0x22:
          if (quoteChar === 0x22) lenEstimate += 2;
          break;
        case 0x27:
          if (quoteChar === 0x27) lenEstimate += 2;
          break;
        default:
          lenEstimate += c <= 0xffff ? 6 : 12;
      }
    }
    estI += width > 0 ? width : 1;
  }

  const bytes: number[] = [];
  bytes.push(quoteChar);

  let i = 0;
  const n = text.length;

  while (i < n) {
    let { r: c, width } = DecodeWTF8Rune(text, i);

    // Fast path: a run of characters that don't need escaping
    if (canPrintWithoutEscape(c, asciiOnly)) {
      const start = i;
      i += width > 0 ? width : 1;
      while (i < n) {
        const d = DecodeWTF8Rune(text, i);
        c = d.r;
        width = d.width;
        if (!canPrintWithoutEscape(c, asciiOnly)) break;
        i += width > 0 ? width : 1;
      }
      for (let k = start; k < i; k++) bytes.push(text[k]);
      continue;
    }

    switch (c) {
      case 0x08: // \b
        bytes.push(0x5c, 0x62);
        i++;
        break;
      case 0x0c: // \f
        bytes.push(0x5c, 0x66);
        i++;
        break;
      case 0x0a: // \n
        bytes.push(0x5c, 0x6e);
        i++;
        break;
      case 0x0d: // \r
        bytes.push(0x5c, 0x72);
        i++;
        break;
      case 0x09: // \t
        bytes.push(0x5c, 0x74);
        i++;
        break;
      case 0x5c: // backslash
        bytes.push(0x5c, 0x5c);
        i++;
        break;
      case 0x22: // "
        if (quoteChar === 0x22) bytes.push(0x5c, 0x22);
        else bytes.push(0x22);
        i++;
        break;
      case 0x27: // '
        if (quoteChar === 0x27) bytes.push(0x5c, 0x27);
        else bytes.push(0x27);
        i++;
        break;
      default:
        i += width > 0 ? width : 1;
        if (c <= 0xffff) {
          pushUnicodeEscape(bytes, c);
        } else {
          const x = c - 0x10000;
          const lo = firstHighSurrogate + ((x >> 10) & 0x3ff);
          const hi = firstLowSurrogate + (x & 0x3ff);
          pushUnicodeEscape(bytes, lo);
          pushUnicodeEscape(bytes, hi);
        }
    }
  }

  bytes.push(quoteChar);
  return new Uint8Array(bytes);
}

function pushUnicodeEscape(out: number[], c: number): void {
  out.push(
    0x5c, 0x75, // \u
    hexChars.charCodeAt((c >> 12) & 15),
    hexChars.charCodeAt((c >> 8) & 15),
    hexChars.charCodeAt((c >> 4) & 15),
    hexChars.charCodeAt(c & 15),
  );
}
