// 字节层工具。
//
// 为什么需要这一层：Go 的 `string` 在 logger 里被当成**字节串**用 —— `len()` 是字节数，
// `s[i]` 是第 i 个字节，`s[a:b]` 按字节切；而 JS 的 string 是 UTF-16 码元序列，两者在
// 非 ASCII 输入下语义不同（决策记录见 PLAN.md「第 6 次推进」§0）。移植里凡是「偏移 / 长度 /
// 切片」的语义一律走 `Uint8Array`，只有真正需要文本时（写终端、拼模板里的纯文本）才编码。
//
// 本文件里的函数名都标注了对应的 Go 标准库函数，方便逐条对照。

import { DecodeWTF8Rune, encodeWTF8Rune } from "../helpers/utf.ts";

/** Go: unicode/utf8.RuneError */
export const RuneError = 0xfffd;

const encoder = new TextEncoder();

/** Go: []byte(s) —— UTF-8 编码（孤立代理会被替换成 U+FFFD，与 Go 的编码器一致） */
export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

/** Go: len(s) —— 字节长度，不是码元长度 */
export function byteLen(s: string): number {
  return encoder.encode(s).length;
}

/** Go: strings.Compare(a, b) —— 按字节比较 */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = a.length < b.length ? a.length : b.length;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** Go: strings.Index(string(haystack), string(needle)) */
export function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0) return 0;
  const n = haystack.length - needle.length;
  for (let i = 0; i <= n; i++) {
    let j = 0;
    while (j < needle.length && haystack[i + j] === needle[j]) j++;
    if (j === needle.length) return i;
  }
  return -1;
}

/** Go: strings.LastIndex(string(haystack), string(needle)) */
export function lastIndexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0) return haystack.length;
  for (let i = haystack.length - needle.length; i >= 0; i--) {
    let j = 0;
    while (j < needle.length && haystack[i + j] === needle[j]) j++;
    if (j === needle.length) return i;
  }
  return -1;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** strings.Repeat(" ", n) 的字节版 */
export function spaces(n: number): Uint8Array {
  return new Uint8Array(n < 0 ? 0 : n).fill(0x20);
}

/**
 * Go: func DecodeRuneInString(s string) (r rune, size int)
 *
 * 非法编码一律返回 (RuneError, 1)，与 Go 一致；WTF-8 的代理码点也算非法
 * （Go 的 UTF-8 解码器不接受代理码点）。
 */
export function decodeRune(bytes: Uint8Array, off: number): { r: number; width: number } {
  if (off >= bytes.length) return { r: RuneError, width: 0 };
  const b0 = bytes[off];
  if (b0 < 0x80) return { r: b0, width: 1 };
  const d = DecodeWTF8Rune(bytes, off);
  if (d.width === 0) return { r: RuneError, width: 1 };
  if (d.r >= 0xd800 && d.r <= 0xdfff) return { r: RuneError, width: 1 };
  return d;
}

/**
 * Go: func DecodeLastRuneInString(s string) (r rune, size int)
 *
 * 逐行照抄 Go 的实现：末字节是 ASCII 就直接返回；否则最多回退 3 个字节找 rune 起始字节，
 * 再正向解一次，宽度对不上就返回 (RuneError, 1)。
 */
export function decodeLastRune(bytes: Uint8Array, end: number): { r: number; width: number } {
  if (end <= 0) return { r: RuneError, width: 0 };
  const last = bytes[end - 1];
  if (last < 0x80) return { r: last, width: 1 };

  let start = end - 1;
  const lim = Math.max(0, end - 4);
  start--;
  while (start >= lim) {
    if ((bytes[start] & 0xc0) !== 0x80) break;
    start--;
  }
  if (start < 0) start = 0;
  const d = decodeRune(bytes, start);
  if (start + d.width !== end) return { r: RuneError, width: 1 };
  return d;
}

/**
 * Go: strings.Builder（只做「追加字节」这一件事）。
 *
 * Go 的 `sb.WriteString(s)` 写的就是 s 的字节；这里 `writeString` 收 JS string 并编码成 UTF-8，
 * `writeBytes` 收原始字节。两者最终拼成一个 `Uint8Array`，交给写终端的出口。
 */
export class ByteBuilder {
  parts: Uint8Array[] = [];

  writeBytes(b: Uint8Array): void {
    if (b.length > 0) this.parts.push(b);
  }

  writeString(s: string): void {
    if (s.length > 0) this.parts.push(encoder.encode(s));
  }

  writeByte(c: number): void {
    this.parts.push(new Uint8Array([c & 0xff]));
  }

  /** Go: sb.WriteRune(r) —— 非法码点写成 U+FFFD（与 Go 的 WriteRune 一致） */
  writeRune(r: number): void {
    const tmp = new Uint8Array(4);
    const n = encodeWTF8Rune(tmp, 0, r);
    this.parts.push(tmp.subarray(0, n));
  }

  bytes(): Uint8Array {
    return concatBytes(this.parts);
  }
}
