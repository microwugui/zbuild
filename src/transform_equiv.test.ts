// 第 75 轮 · 任务 A 的机器验证子集：单文件 transform-equivalent 驱动。
// 逐字节对齐 Go transform（--loader=js --format=esm --target=esnext，无 bundle）。
// 这些用例覆盖 NumberRenamer 冲突改名（tmp→tmp2）+ export tail 重写 + IsExport 剥离。
// 期望字节来自 /tmp/esbuild-go 当场实测，SHA 钉死。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { transformEquivalent } from "./transform_equiv.ts";

const bytes = new Uint8Array(readFileSync(new URL("../testdata/transform-equiv-go.json", import.meta.url)));
const SHA = "8f47162e34658415117a46ab3e87c894c0d8a6c1786260f68ee363db38bb4bcb";
const dec = new TextDecoder();
const enc = new TextEncoder();

interface Row { name: string; source: string; out: string; }
const rows: Row[] = JSON.parse(dec.decode(bytes));

test("transform-equiv fixture sha256 + 逐字节等于 Go transform", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  for (const r of rows) {
    const got = transformEquivalent(enc.encode(r.source));
    assert.equal(got.ok, true, `${r.name}: ok`);
    assert.equal(dec.decode(got.JS), r.out, `${r.name}: byte mismatch`);
  }
});
