// 1:1 移植自 esbuild internal/helpers/utf.go（commit f6058f83, v0.28.2）
//
// 偏差说明（见 docs/porting-conventions.md 第 3 条）：
// Go 的 string 是 UTF-8 字节序列，TS 的 string 是 UTF-16 码元序列。
// 因此本文件里凡是 Go 侧接收 string / 返回 string 的函数，TS 侧一律改用
// Uint8Array 承载 UTF-8 字节，语义与 Go 完全一致。
// DEVIATION: 参数类型由 string 改为 Uint8Array（字节语义不变）。

import { RuneError, MaxRune, UTFMax } from "./utf_consts.ts";

/** Go: func ContainsNonBMPCodePoint(text string) bool */
export function ContainsNonBMPCodePoint(text: Uint8Array): boolean {
  let i = 0;
  while (i < text.length) {
    const { r, width } = decodeUTF8Rune(text, i);
    if (r > 0xffff) return true;
    i += width > 0 ? width : 1;
  }
  return false;
}

/** Go: func ContainsNonBMPCodePointUTF16(text []uint16) bool */
export function ContainsNonBMPCodePointUTF16(text: Uint16Array | number[]): boolean {
  const n = text.length;
  for (let i = 0; i < n - 1; i++) {
    const c = text[i];
    if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = text[i + 1];
      if (c2 >= 0xdc00 && c2 <= 0xdfff) return true;
    }
  }
  return false;
}

/** Go: func StringToUTF16(text string) []uint16 */
export function StringToUTF16(text: Uint8Array): number[] {
  const decoded: number[] = [];
  let i = 0;
  while (i < text.length) {
    const { r, width } = decodeUTF8Rune(text, i);
    if (r <= 0xffff) {
      decoded.push(r);
    } else {
      const c = r - 0x10000;
      decoded.push(0xd800 + ((c >> 10) & 0x3ff), 0xdc00 + (c & 0x3ff));
    }
    i += width > 0 ? width : 1;
  }
  return decoded;
}

/** Go: func UTF16ToString(text []uint16) string —— 返回 UTF-8 字节 */
export function UTF16ToString(text: Uint16Array | number[]): Uint8Array {
  const out: number[] = [];
  const temp = new Uint8Array(UTFMax);
  const n = text.length;
  for (let i = 0; i < n; i++) {
    let r1 = text[i];
    if (r1 >= 0xd800 && r1 <= 0xdbff && i + 1 < n) {
      const r2 = text[i + 1];
      if (r2 >= 0xdc00 && r2 <= 0xdfff) {
        r1 = ((r1 - 0xd800) << 10 | (r2 - 0xdc00)) + 0x10000;
        i++;
      }
    }
    const width = encodeWTF8Rune(temp, 0, r1);
    for (let k = 0; k < width; k++) out.push(temp[k]);
  }
  return new Uint8Array(out);
}

/** Go: func UTF16ToStringWithValidation(text []uint16) (string, uint16, bool) */
export function UTF16ToStringWithValidation(
  text: Uint16Array | number[],
): { value: Uint8Array; bad: number; ok: boolean } {
  const out: number[] = [];
  const temp = new Uint8Array(UTFMax);
  const n = text.length;
  for (let i = 0; i < n; i++) {
    let r1 = text[i];
    if (r1 >= 0xd800 && r1 <= 0xdbff) {
      if (i + 1 < n) {
        const r2 = text[i + 1];
        if (r2 >= 0xdc00 && r2 <= 0xdfff) {
          r1 = ((r1 - 0xd800) << 10 | (r2 - 0xdc00)) + 0x10000;
          i++;
        } else {
          return { value: new Uint8Array(0), bad: r1, ok: false };
        }
      } else {
        return { value: new Uint8Array(0), bad: r1, ok: false };
      }
    } else if (r1 >= 0xdc00 && r1 <= 0xdfff) {
      return { value: new Uint8Array(0), bad: r1, ok: false };
    }
    const width = encodeWTF8Rune(temp, 0, r1);
    for (let k = 0; k < width; k++) out.push(temp[k]);
  }
  return { value: new Uint8Array(out), bad: 0, ok: true };
}

/** Go: func UTF16EqualsString(text []uint16, str string) bool */
export function UTF16EqualsString(text: Uint16Array | number[], str: Uint8Array): boolean {
  if (text.length > str.length) return false;
  const temp = new Uint8Array(UTFMax);
  const n = text.length;
  let j = 0;
  for (let i = 0; i < n; i++) {
    let r1 = text[i];
    if (r1 >= 0xd800 && r1 <= 0xdbff && i + 1 < n) {
      const r2 = text[i + 1];
      if (r2 >= 0xdc00 && r2 <= 0xdfff) {
        r1 = ((r1 - 0xd800) << 10 | (r2 - 0xdc00)) + 0x10000;
        i++;
      }
    }
    const width = encodeWTF8Rune(temp, 0, r1);
    if (j + width > str.length) return false;
    for (let k = 0; k < width; k++) {
      if (temp[k] !== str[j]) return false;
      j++;
    }
  }
  return j === str.length;
}

/** Go: func UTF16EqualsUTF16(a []uint16, b []uint16) bool */
export function UTF16EqualsUTF16(a: Uint16Array | number[], b: Uint16Array | number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Go: func encodeWTF8Rune(p []byte, r rune) int
 * 返回写入字节数；写入位置从 off 开始（Go 侧总是 p[0]）。
 */
export function encodeWTF8Rune(p: Uint8Array, off: number, r: number): number {
  const i = r >>> 0;
  if (i <= 0x7f) {
    p[off] = r & 0xff;
    return 1;
  }
  if (i <= 0x7ff) {
    p[off] = 0xc0 | ((r >> 6) & 0xff);
    p[off + 1] = 0x80 | (r & 0x3f);
    return 2;
  }
  if (i > MaxRune) {
    // Go: r = utf8.RuneError; fallthrough 到 3 字节分支
    r = RuneError;
    p[off] = 0xe0 | ((r >> 12) & 0xff);
    p[off + 1] = 0x80 | ((r >> 6) & 0x3f);
    p[off + 2] = 0x80 | (r & 0x3f);
    return 3;
  }
  if (i <= 0xffff) {
    p[off] = 0xe0 | ((r >> 12) & 0xff);
    p[off + 1] = 0x80 | ((r >> 6) & 0x3f);
    p[off + 2] = 0x80 | (r & 0x3f);
    return 3;
  }
  p[off] = 0xf0 | ((r >> 18) & 0xff);
  p[off + 1] = 0x80 | ((r >> 12) & 0x3f);
  p[off + 2] = 0x80 | ((r >> 6) & 0x3f);
  p[off + 3] = 0x80 | (r & 0x3f);
  return 4;
}

/** Go: func DecodeWTF8Rune(s string) (rune, int) */
export function DecodeWTF8Rune(s: Uint8Array, off = 0): { r: number; width: number } {
  const n = s.length - off;
  if (n < 1) return { r: RuneError, width: 0 };

  const s0 = s[off];
  if (s0 < 0x80) return { r: s0, width: 1 };

  let sz: number;
  if ((s0 & 0xe0) === 0xc0) sz = 2;
  else if ((s0 & 0xf0) === 0xe0) sz = 3;
  else if ((s0 & 0xf8) === 0xf0) sz = 4;
  else return { r: RuneError, width: 1 };

  if (n < sz) return { r: RuneError, width: 0 };

  const s1 = s[off + 1];
  if ((s1 & 0xc0) !== 0x80) return { r: RuneError, width: 1 };

  if (sz === 2) {
    const cp = ((s0 & 0x1f) << 6) | (s1 & 0x3f);
    if (cp < 0x80) return { r: RuneError, width: 1 };
    return { r: cp, width: 2 };
  }
  const s2 = s[off + 2];
  if ((s2 & 0xc0) !== 0x80) return { r: RuneError, width: 1 };

  if (sz === 3) {
    const cp = ((s0 & 0x0f) << 12) | ((s1 & 0x3f) << 6) | (s2 & 0x3f);
    if (cp < 0x0800) return { r: RuneError, width: 1 };
    return { r: cp, width: 3 };
  }
  const s3 = s[off + 3];
  if ((s3 & 0xc0) !== 0x80) return { r: RuneError, width: 1 };

  const cp = ((s0 & 0x07) << 18) | ((s1 & 0x3f) << 12) | ((s2 & 0x3f) << 6) | (s3 & 0x3f);
  if (cp < 0x010000 || cp > 0x10ffff) return { r: RuneError, width: 1 };
  return { r: cp, width: 4 };
}

/** Go 的 `for range string` 语义：非法 UTF-8 产生 RuneError、宽度 1 */
function decodeUTF8Rune(b: Uint8Array, off: number): { r: number; width: number } {
  const d = DecodeWTF8Rune(b, off);
  if (d.width === 0) return { r: RuneError, width: 1 };
  // DecodeWTF8Rune 接受 WTF-8 的代理码点，而 Go 的 range 会将其视为非法
  if (d.r >= 0xd800 && d.r <= 0xdfff) return { r: RuneError, width: 1 };
  return d;
}
