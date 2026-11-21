// 第 116 轮：scanAllDependencies 非 bundle drain 逐字节等于 Go（2 场景，有区分度）。
// Go 期望：testdata/scan-drain-go.json（SHA 954ec59c…）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { scanAllDependencies } from "./bundler.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/scan-drain-go.json", import.meta.url)));
const SHA = "954ec59c0a16f92a9a3ac784aff0545d559c93d0e3c655c842b72ec66121ab1f";
const rows = JSON.parse(new TextDecoder().decode(raw)) as any[];

type TC = { name: string; results: { idx: number; ok: boolean; mark: string }[] };
const cases: TC[] = [
  { name: "drain-order", results: [{ idx: 2, ok: true, mark: "C" }, { idx: 0, ok: true, mark: "A" }, { idx: 1, ok: true, mark: "B" }] },
  { name: "skip-notok", results: [{ idx: 0, ok: true, mark: "A" }, { idx: 1, ok: false, mark: "BAD" }, { idx: 2, ok: true, mark: "C" }] },
];

function run(tc: TC): any {
  const s: any = {
    options: { Mode: 0 },
    resultChannel: tc.results.map((r) => ({ ok: r.ok, file: { inputFile: { Source: { Index: r.idx, Contents: new TextEncoder().encode(r.mark) } } } })),
    results: new Array(4).fill(undefined),
    remaining: tc.results.length,
  };
  scanAllDependencies(s);
  return { name: tc.name, slots: s.results.map((r: any) => (r ? new TextDecoder().decode(r.file.inputFile.Source.Contents) : "")) };
}

test("scan-drain 夹具 sha256（2 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("scanAllDependencies 非 bundle drain 逐字节等于 Go", () => {
  assert.deepEqual(cases.map(run), rows);
});
