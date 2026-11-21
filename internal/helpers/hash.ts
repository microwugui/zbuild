// 1:1 移植自 esbuild internal/helpers/hash.go（v0.28.2）
// Go 的 uint32 运算在 JS 里用 >>> 0 归正。
// DEVIATION: HashCombineString 的 string 参数改为 Uint8Array（Go 按 rune 迭代）。

import { DecodeWTF8Rune } from "./utf.ts";
import { RuneError } from "./utf_consts.ts";

/** Go: func HashCombine(seed uint32, hash uint32) uint32 */
export function HashCombine(seed: number, hash: number): number {
  return (seed ^ (((hash + 0x9e3779b9 + ((seed << 6) >>> 0) + (seed >>> 2)) >>> 0))) >>> 0;
}

/** Go: func HashCombineString(seed uint32, text string) uint32 */
export function HashCombineString(seed: number, text: Uint8Array): number {
  seed = HashCombine(seed, text.length >>> 0);
  let i = 0;
  while (i < text.length) {
    let { r, width } = DecodeWTF8Rune(text, i);
    // Go 的 `for range string` 把非法 UTF-8 / 孤立代理视为 RuneError
    if (width === 0 || (r >= 0xd800 && r <= 0xdfff) || r > 0x10ffff) {
      r = RuneError;
      width = 1;
    }
    seed = HashCombine(seed, r);
    i += width;
  }
  return seed;
}
