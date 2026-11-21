// 1:1 移植自 esbuild internal/xxhash/xxhash_other.go（commit f6058f83, v0.28.2）

import { Digest, round, u32, u64, rol1, rol7, rol11, rol12, rol18, rol23, rol27, mergeRound } from "./xxhash.ts";

const prime1: bigint = 11400714785074694791n;
const prime2: bigint = 14029467366897019727n;
const prime3: bigint = 1609587929392839161n;
const prime4: bigint = 9650029242287828579n;
const prime5: bigint = 2870177450012600261n;
const MASK64 = (1n << 64n) - 1n;

const w64 = (x: bigint): bigint => x & MASK64;

/**
 * Go: func Sum64(b []byte) uint64
 * 一次算完的快速路径，语义与 Digest 路径必须完全一致（差分测试会校验）。
 */
export function Sum64(b: Uint8Array): bigint {
  const n = b.length;
  let h: bigint;
  let off = 0;

  if (n >= 32) {
    let v1 = w64(prime1 + prime2);
    let v2 = prime2;
    let v3 = 0n;
    let v4 = w64(0n - prime1);
    while (n - off >= 32) {
      v1 = round(v1, u64(b, off));
      v2 = round(v2, u64(b, off + 8));
      v3 = round(v3, u64(b, off + 16));
      v4 = round(v4, u64(b, off + 24));
      off += 32;
    }
    h = w64(w64(w64(rol1(v1) + rol7(v2)) + rol12(v3)) + rol18(v4));
    h = mergeRound(h, v1);
    h = mergeRound(h, v2);
    h = mergeRound(h, v3);
    h = mergeRound(h, v4);
  } else {
    h = prime5;
  }

  h = w64(h + BigInt(n));

  let i = off;
  const end = n;
  for (; i + 8 <= end; i += 8) {
    const k1 = round(0n, u64(b, i));
    h ^= k1;
    h = w64(w64(rol27(h) * prime1) + prime4);
  }
  if (i + 4 <= end) {
    h ^= w64(BigInt(u32(b, i)) * prime1);
    h = w64(w64(rol23(h) * prime2) + prime3);
    i += 4;
  }
  for (; i < end; i++) {
    h ^= w64(BigInt(b[i]) * prime5);
    h = w64(rol11(h) * prime1);
  }

  h ^= h >> 33n;
  h = w64(h * prime2);
  h ^= h >> 29n;
  h = w64(h * prime3);
  h ^= h >> 32n;

  return h;
}

/** Go: func writeBlocks(d *Digest, b []byte) int */
export function writeBlocks(d: Digest, b: Uint8Array): number {
  let v1 = d.v1, v2 = d.v2, v3 = d.v3, v4 = d.v4;
  const n = b.length;
  let off = 0;
  while (n - off >= 32) {
    v1 = round(v1, u64(b, off));
    v2 = round(v2, u64(b, off + 8));
    v3 = round(v3, u64(b, off + 16));
    v4 = round(v4, u64(b, off + 24));
    off += 32;
  }
  d.v1 = v1;
  d.v2 = v2;
  d.v3 = v3;
  d.v4 = v4;
  return off;
}
