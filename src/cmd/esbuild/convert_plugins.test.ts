// 第 101 轮：convertPlugins 确定性可观测逐字节等于 Go（4 例）。
// Go 探针 tools/go/tmpgen_convertplugins_test.bak → testdata/convert-plugins-go.json。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { serviceType, activeBuild } from "./service.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/convert-plugins-go.json", import.meta.url)));
const SHA = "3f16db5bf5cd85ef22ec88f056076e8b274105d679097b0f4d862e24b7ad33fc";
const rows = JSON.parse(new TextDecoder().decode(raw)) as { name: string; plugins: number; hasOnEnd: boolean; err: string }[];

test("convert-plugins 夹具 sha256（4 例）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("convertPlugins 逐字节等于 Go（plugin 数 / hasOnEnd / 错误文案）", () => {
  const mk = () => new serviceType();
  const ab = new activeBuild();
  const cases: Record<string, any> = {
    "empty": [],
    "onend": [{ name: "p", onEnd: true, onResolve: [], onLoad: [] }],
    "plain": [{ name: "p", onEnd: false, onResolve: [], onLoad: [] }],
    "bad-filter": [{ name: "p", onEnd: false, onResolve: [{ id: 1, filter: "[", namespace: "" }], onLoad: [] }],
  };
  for (const r of rows) {
    const res = mk().convertPlugins(0, cases[r.name], ab);
    assert.equal(res.plugins.length, r.plugins, `${r.name}: plugins`);
    assert.equal(res.hasOnEnd, r.hasOnEnd, `${r.name}: hasOnEnd`);
    assert.equal(res.err ?? "", r.err, `${r.name}: err`);
  }
});
