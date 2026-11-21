// 第 76 轮 · 任务 B 里程碑：最小单文件 bundle 驱动逐字节等于 Go --bundle（无 import 单文件）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { bundleSingleFile } from "./bundle1.ts";

const bytes = new Uint8Array(readFileSync(new URL("../testdata/bundle1-go.json", import.meta.url)));
const SHA = "ea4f4f944daafd0879505856bfeb06a901bdb8c329f6d34c70be3650bee6187a";
const dec = new TextDecoder();
const enc = new TextEncoder();
interface Row { name: string; source: string; path: string; out: string; }
const rows: Row[] = JSON.parse(dec.decode(bytes));

test("bundle1 fixture sha256 + 3 例单文件 bundle 逐字节等于 Go --bundle", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  for (const r of rows) {
    const got = bundleSingleFile(enc.encode(r.source), r.path);
    assert.equal(got.ok, true, `${r.name}: ok`);
    assert.equal(dec.decode(got.output), r.out, `${r.name}: byte mismatch`);
  }
});

// 第 77 轮：由 three.core.js 真实 diff 反向定序出的三处 ModeBundle 行为，逐字节钉死。
const bytes2 = new Uint8Array(readFileSync(new URL("../testdata/bundle1-go2.json", import.meta.url)));
const SHA2 = "fcbee73a623543fdc09b1600a594951fe6550306e20469e369b9f50ecd01e478";
const rows2: Row[] = JSON.parse(dec.decode(bytes2));

test("bundle1 第 77 轮 fixture sha256 + legal 注释 EOF / class 内层名 / 多声明拆分 逐字节等于 Go --bundle", () => {
  assert.equal(createHash("sha256").update(bytes2).digest("hex"), SHA2);
  for (const r of rows2) {
    const got = bundleSingleFile(enc.encode(r.source), r.path);
    assert.equal(got.ok, true, `${r.name}: ok`);
    assert.equal(dec.decode(got.output), r.out, `${r.name}: byte mismatch`);
  }
});
