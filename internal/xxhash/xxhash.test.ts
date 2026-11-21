// 对应 esbuild internal/xxhash 包（Go 侧没有 _test.go，这里用差分基准补齐）
// 期望值全部由 Go 参考实现生成：tools/gen_xxhash_fixture.go
// （round/mergeRound 等纯算术的期望值由独立计算得到，见提交说明）

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  Digest,
  New,
  appendUint64,
  consumeUint64,
  mergeRound,
  rol1,
  rol7,
  rol11,
  rol12,
  rol18,
  rol23,
  rol27,
  rol31,
  round,
  u32,
  u64,
} from "./xxhash.ts";
import { Sum64, writeBlocks } from "./xxhash_other.ts";

interface Case {
  name: string;
  hex: string;
  sum64: string;
  chunks: number[];
  chunkSum64: string;
  marshaled: string;
  remarshaled: string;
}

const fixturePath = join(import.meta.dirname, "../../../testdata/xxhash.json");
const fixture: { cases: Case[] } = JSON.parse(readFileSync(fixturePath, "utf8"));

function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

const hex64 = (x: bigint): string => x.toString(16).padStart(16, "0");

test("Digest.Size", () => {
  assert.equal(New().Size(), 8);
});

test("Digest.BlockSize", () => {
  assert.equal(New().BlockSize(), 32);
});

test("Digest.Reset", () => {
  const d = New();
  d.Write(new TextEncoder().encode("some data to move the state"));
  d.Reset();
  assert.equal(d.n, 0);
  assert.equal(d.total, 0n);
  assert.equal(hex64(d.Sum64()), hex64(Sum64(new Uint8Array(0))));
});

test("Digest.Write returns n", () => {
  const d = New();
  const b = new Uint8Array(100);
  const r = d.Write(b);
  assert.equal(r.n, 100);
  assert.equal(r.err, null);
});

test("Digest.Sum appends big-endian", () => {
  const d = New();
  d.Write(new Uint8Array([1, 2, 3]));
  const prefix = new Uint8Array([0xaa, 0xbb]);
  const out = d.Sum(prefix);
  assert.equal(out.length, 10);
  assert.equal(out[0], 0xaa);
  assert.equal(out[1], 0xbb);
  let expect = "";
  const s = d.Sum64();
  for (let i = 0; i < 8; i++) expect += Number((s >> BigInt(56 - i * 8)) & 0xffn).toString(16).padStart(2, "0");
  assert.equal(toHex(out.subarray(2)), expect);
});

test("Digest.UnmarshalBinary rejects bad magic", () => {
  const d = New();
  const err = d.UnmarshalBinary(new Uint8Array(76));
  assert.ok(err instanceof Error);
  assert.equal(err.message, "xxhash: invalid hash state identifier");
});

test("Digest.UnmarshalBinary rejects bad size", () => {
  const d = New();
  const b = new Uint8Array(10);
  b.set([0x78, 0x78, 0x68, 0x06]);
  const err = d.UnmarshalBinary(b);
  assert.ok(err instanceof Error);
  assert.equal(err.message, "xxhash: invalid hash state size");
});

test("appendUint64", () => {
  const b = appendUint64(new Uint8Array([1]), 0x0102030405060708n);
  assert.equal(toHex(b), "010807060504030201");
});

test("consumeUint64", () => {
  const r = consumeUint64(fromHex("0807060504030201ff"));
  assert.equal(r.x, 0x0102030405060708n);
  assert.equal(toHex(r.b), "ff");
});

test("u64", () => {
  assert.equal(u64(fromHex("ffffffffffffffff")), (1n << 64n) - 1n);
  assert.equal(u64(fromHex("0000000000000000")), 0n);
});

test("u32", () => {
  assert.equal(u32(fromHex("ffffffff")), 0xffffffff);
  assert.equal(u32(fromHex("01000000")), 1);
});

test("round and mergeRound", () => {
  assert.equal(round(0n, 0n), 0n);
  assert.equal(mergeRound(0n, 0n), 9650029242287828579n);
  // 由独立 BigInt 计算得到：acc=1+1*P2 → rol31 → *P1
  assert.equal(round(1n, 1n), 4756955278768118994n);
});

test("rotate helpers", () => {
  assert.equal(rol1(1n), 2n);
  assert.equal(rol7(1n), 128n);
  assert.equal(rol11(1n), 2048n);
  assert.equal(rol12(1n), 4096n);
  assert.equal(rol18(1n), 262144n);
  assert.equal(rol23(1n), 8388608n);
  assert.equal(rol27(1n), 134217728n);
  assert.equal(rol31(1n), 2147483648n);
  // 回绕：最高位旋到最低位
  assert.equal(rol1(1n << 63n), 1n);
});

test("writeBlocks", () => {
  const d = New();
  const b = new Uint8Array(70);
  for (let i = 0; i < b.length; i++) b[i] = i;
  assert.equal(writeBlocks(d, b), 64);
  // 与 Digest.Write 走同一路径后的状态一致
  const d2 = New();
  d2.Write(b);
  assert.equal(d.v1, d2.v1);
  assert.equal(d.v2, d2.v2);
  assert.equal(d.v3, d2.v3);
  assert.equal(d.v4, d2.v4);
});

for (const c of fixture.cases) {
  test(`Sum64 差分: ${c.name}`, () => {
    const data = fromHex(c.hex);
    assert.equal(hex64(Sum64(data)), c.sum64);
  });

  test(`Digest 分块差分: ${c.name}`, () => {
    const data = fromHex(c.hex);
    const d = New();
    let off = 0;
    for (const n of c.chunks) {
      if (off >= data.length) break;
      const end = Math.min(off + n, data.length);
      d.Write(data.subarray(off, end));
      off = end;
    }
    if (off < data.length) d.Write(data.subarray(off));
    assert.equal(hex64(d.Sum64()), c.chunkSum64);
    // 一次性路径与分块路径必须一致
    assert.equal(c.chunkSum64, c.sum64);
  });

  test(`MarshalBinary 差分: ${c.name}`, () => {
    const data = fromHex(c.hex);
    const d = New();
    d.Write(data);
    const m = d.MarshalBinary();
    assert.equal(m.err, null);
    assert.equal(toHex(m.b), c.marshaled);

    const d2 = new Digest();
    assert.equal(d2.UnmarshalBinary(m.b), null);
    assert.equal(hex64(d2.Sum64()), c.chunkSum64);
    assert.equal(toHex(d2.MarshalBinary().b), c.remarshaled);
  });
}
