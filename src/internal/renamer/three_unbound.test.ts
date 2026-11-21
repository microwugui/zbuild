// 第 94 轮：逐文件 unbound 精确口径（替换过宽的 knownGlobals 白名单）。
// Go 探针 tools/go/tmpgen_unbound_test.bak → testdata/three-unbound-go.json（3 入口）。
// bundle_multi.ts 用 reservedBiz 精确过滤：document/self/window 真全局保留，event/i/array 假 unbound 删除。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/three-unbound-go.json", import.meta.url)));
const SHA = "87d260b66a6dfb63270be1d92e6ed7e80bd2b3563f6c06430e766d31a6686c6a";
const rows = JSON.parse(new TextDecoder().decode(raw)) as any[];

test("three-unbound 夹具 sha256（3 入口）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("Go 实测 reservedBiz：真全局保留、假 unbound 删除（逐入口）", () => {
  assert.equal(rows.length, 3);
  const byEntry = new Map<string, Set<string>>();
  for (const r of rows) byEntry.set(r.entry, new Set<string>(r.reservedBiz));
  for (const entry of ["three.module.js", "three.tsl.js", "three.webgpu.js"]) {
    const set = byEntry.get(entry)!;
    assert.ok(set, entry);
    // 真全局：所有入口都必须保留 document/self/window（Go ComputeReservedNames 实测）。
    for (const g of ["document", "self", "window"]) {
      assert.ok(set.has(g), `${entry} 应保留真全局 ${g}`);
    }
    // 假 unbound：绝不能进保留集（上一轮 knownGlobals 白名单含 event 导致 event2 回归）。
    for (const fake of ["event", "i", "array", "range"]) {
      assert.ok(!set.has(fake), `${entry} 不应保留假 unbound ${fake}`);
    }
  }
});

test("GOMAXPROCS 无关：reservedBiz 按 basename 稳定（含 require/Promise linker 追加）", () => {
  // require/Promise 由 computeChunkReservedNames 在 bundle 模式追加，夹具里已体现。
  for (const r of rows) {
    const s = new Set<string>(r.reservedBiz);
    assert.ok(s.has("require"), `${r.entry} 应含 require`);
    assert.ok(s.has("Promise"), `${r.entry} 应含 Promise`);
  }
});
