// 1:1 移植自 esbuild internal/xxhash/xxhash.go（commit f6058f83, v0.28.2）
// uint64 一律用 bigint，每次算术后 & MASK64 模拟 Go 的无符号回绕。
// 见 docs/porting-conventions.md 第 2 条。
//
// 注意：Go 里 writeBlocks 与本文件同包，TS 里按文件 1:1 拆分后形成 ESM 循环依赖。
// 这是安全的：xxhash_other.ts 顶层只声明函数，函数体要到调用时才求值。

import { writeBlocks } from "./xxhash_other.ts";

const MASK64 = (1n << 64n) - 1n;

const prime1: bigint = 11400714785074694791n;
const prime2: bigint = 14029467366897019727n;
const prime3: bigint = 1609587929392839161n;
const prime4: bigint = 9650029242287828579n;
const prime5: bigint = 2870177450012600261n;

const prime1v = prime1;
const prime2v = prime2;
const prime3v = prime3;
const prime4v = prime4;
const prime5v = prime5;

const w64 = (x: bigint): bigint => x & MASK64;

/** Go bits.RotateLeft64(x, k)，k 为左旋位数 */
function rotateLeft64(x: bigint, k: bigint): bigint {
  return w64((x << k) | (x >> (64n - k)));
}

/** Digest 复刻 Go 的 xxhash.Digest */
export class Digest {
  v1: bigint = 0n;
  v2: bigint = 0n;
  v3: bigint = 0n;
  v4: bigint = 0n;
  total: bigint = 0n;
  mem: Uint8Array = new Uint8Array(32);
  n: number = 0; // mem 中已使用的字节数

  constructor() {
    this.Reset();
  }

  Reset(): void {
    this.v1 = w64(prime1v + prime2);
    this.v2 = prime2;
    this.v3 = 0n;
    this.v4 = w64(0n - prime1v);
    this.total = 0n;
    this.n = 0;
  }

  Size(): number {
    return 8;
  }

  BlockSize(): number {
    return 32;
  }

  /** Go: func (d *Digest) Write(b []byte) (n int, err error)，永远返回 len(b), nil */
  Write(b: Uint8Array): { n: number; err: Error | null } {
    const len = b.length;
    this.total = w64(this.total + BigInt(len));

    if (this.n + len < 32) {
      // 新数据连当前 block 都填不满
      this.mem.set(b, this.n);
      this.n += len;
      return { n: len, err: null };
    }

    let off = 0;
    if (this.n > 0) {
      // 补满当前半块
      const take = 32 - this.n;
      this.mem.set(b.subarray(0, take), this.n);
      this.v1 = round(this.v1, u64(this.mem, 0));
      this.v2 = round(this.v2, u64(this.mem, 8));
      this.v3 = round(this.v3, u64(this.mem, 16));
      this.v4 = round(this.v4, u64(this.mem, 24));
      off = take;
      this.n = 0;
    }

    if (b.length - off >= 32) {
      // 剩下一个或多个完整 block
      off += writeBlocks(this, b.subarray(off));
    }

    // 保存末尾的残缺 block
    const rest = b.subarray(off);
    this.mem.set(rest, 0);
    this.n = rest.length;
    return { n: len, err: null };
  }

  /** Go: func (d *Digest) Sum(b []byte) []byte，大端序 */
  Sum(b: Uint8Array): Uint8Array {
    const s = this.Sum64();
    const out = new Uint8Array(b.length + 8);
    out.set(b, 0);
    for (let i = 0; i < 8; i++) {
      out[b.length + i] = Number((s >> BigInt(56 - i * 8)) & 0xffn);
    }
    return out;
  }

  Sum64(): bigint {
    let h: bigint;

    if (this.total >= 32n) {
      const v1 = this.v1, v2 = this.v2, v3 = this.v3, v4 = this.v4;
      h = w64(w64(w64(rotateLeft64(v1, 1n) + rotateLeft64(v2, 7n)) + rotateLeft64(v3, 12n)) + rotateLeft64(v4, 18n));
      h = mergeRound(h, v1);
      h = mergeRound(h, v2);
      h = mergeRound(h, v3);
      h = mergeRound(h, v4);
    } else {
      h = w64(this.v3 + prime5);
    }

    h = w64(h + this.total);

    let i = 0;
    const end = this.n;
    for (; i + 8 <= end; i += 8) {
      const k1 = round(0n, u64(this.mem, i));
      h ^= k1;
      h = w64(w64(rotateLeft64(h, 27n) * prime1) + prime4);
    }
    if (i + 4 <= end) {
      h ^= w64(BigInt(u32(this.mem, i)) * prime1);
      h = w64(w64(rotateLeft64(h, 23n) * prime2) + prime3);
      i += 4;
    }
    for (; i < end; i++) {
      h ^= w64(BigInt(this.mem[i]) * prime5);
      h = w64(rotateLeft64(h, 11n) * prime1);
    }

    h ^= h >> 33n;
    h = w64(h * prime2);
    h ^= h >> 29n;
    h = w64(h * prime3);
    h ^= h >> 32n;

    return h;
  }

  /** Go: func (d *Digest) MarshalBinary() ([]byte, error) */
  MarshalBinary(): { b: Uint8Array; err: Error | null } {
    const b = new Uint8Array(marshaledSize);
    b.set(magicBytes, 0);
    let off = magicBytes.length;
    for (const v of [this.v1, this.v2, this.v3, this.v4, this.total]) {
      b.set(appendUint64(new Uint8Array(0), v), off);
      off += 8;
    }
    b.set(this.mem.subarray(0, this.n), off);
    return { b, err: null };
  }

  /** Go: func (d *Digest) UnmarshalBinary(b []byte) error */
  UnmarshalBinary(b: Uint8Array): Error | null {
    if (b.length < magicBytes.length || !bytesEqual(b.subarray(0, magicBytes.length), magicBytes)) {
      return new Error("xxhash: invalid hash state identifier");
    }
    if (b.length !== marshaledSize) {
      return new Error("xxhash: invalid hash state size");
    }
    let off = magicBytes.length;
    const vals: bigint[] = [];
    for (let i = 0; i < 5; i++) {
      const r = consumeUint64(b, off);
      vals.push(r.x);
      off += 8;
    }
    this.v1 = vals[0];
    this.v2 = vals[1];
    this.v3 = vals[2];
    this.v4 = vals[3];
    this.total = vals[4];
    this.mem = new Uint8Array(32);
    this.mem.set(b.subarray(off, off + 32), 0);
    this.n = Number(this.total % 32n);
    return null;
  }
}

const magicBytes = new Uint8Array([0x78, 0x78, 0x68, 0x06]); // "xxh\x06"
const marshaledSize = magicBytes.length + 8 * 5 + 32;

/** Go: func appendUint64(b []byte, x uint64) []byte，小端序 */
export function appendUint64(b: Uint8Array, x: bigint): Uint8Array {
  const a = new Uint8Array(8);
  let v = x;
  for (let i = 0; i < 8; i++) {
    a[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  const out = new Uint8Array(b.length + 8);
  out.set(b, 0);
  out.set(a, b.length);
  return out;
}

/** Go: func consumeUint64(b []byte) ([]byte, uint64) */
export function consumeUint64(b: Uint8Array, off = 0): { b: Uint8Array; x: bigint } {
  const x = u64(b, off);
  return { b: b.subarray(off + 8), x };
}

/** Go: func u64(b []byte) uint64，小端序 */
export function u64(b: Uint8Array, off = 0): bigint {
  let x = 0n;
  for (let i = 7; i >= 0; i--) {
    x = (x << 8n) | BigInt(b[off + i]);
  }
  return x;
}

/** Go: func u32(b []byte) uint32，小端序 */
export function u32(b: Uint8Array, off = 0): number {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}

/** Go: func round(acc, input uint64) uint64 */
export function round(acc: bigint, input: bigint): bigint {
  acc = w64(acc + w64(input * prime2));
  acc = rotateLeft64(acc, 31n);
  acc = w64(acc * prime1);
  return acc;
}

/** Go: func mergeRound(acc, val uint64) uint64 */
export function mergeRound(acc: bigint, val: bigint): bigint {
  val = round(0n, val);
  acc ^= val;
  acc = w64(w64(acc * prime1) + prime4);
  return acc;
}

export function rol1(x: bigint): bigint { return rotateLeft64(x, 1n); }
export function rol7(x: bigint): bigint { return rotateLeft64(x, 7n); }
export function rol11(x: bigint): bigint { return rotateLeft64(x, 11n); }
export function rol12(x: bigint): bigint { return rotateLeft64(x, 12n); }
export function rol18(x: bigint): bigint { return rotateLeft64(x, 18n); }
export function rol23(x: bigint): bigint { return rotateLeft64(x, 23n); }
export function rol27(x: bigint): bigint { return rotateLeft64(x, 27n); }
export function rol31(x: bigint): bigint { return rotateLeft64(x, 31n); }

/** Go: func New() *Digest */
export function New(): Digest {
  return new Digest();
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
