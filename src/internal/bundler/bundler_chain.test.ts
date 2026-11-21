// 第 89 批：reportExplicitPhaseImport / findReachableFiles / generateMetadataJSON（16 行逐字节）。
// Go 探针 tools/go/tmpgen_bundler_chain_test.bak → testdata/bundler-chain-go.json。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { reportExplicitPhaseImport, findReachableFiles, generateMetadataJSON } from "./bundler.ts";
import { MakeIndex32 } from "../ast/ast.ts";
import { MockFS, MockUnix } from "../fs/fs_mock.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/bundler-chain-go.json", import.meta.url)));
const SHA = "4d5eff2ea76036d09942884f6578e89a6c43a7330202873dd10eb9257fa5aa11";
const fx = JSON.parse(new TextDecoder().decode(raw)) as { rows: { name: string; data: any }[] };
const by = Object.fromEntries(fx.rows.map((r) => [r.name, r.data]));

test("bundler-chain 夹具 sha256（16 行）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

// 捕获 AddError 文本的假 log（reportExplicitPhaseImport 调 log.AddError(tracker,r,text)）
function fakeLog() {
  const errors: string[] = [];
  return { errors, AddError: (_tracker: any, _r: any, text: string) => errors.push(text) };
}

test("reportExplicitPhaseImport 逐字节等于 Go（6 例）", () => {
  const cases: [string, number, boolean, number][] = [
    ["defer-cjs", 1, false, 2], ["defer-esm-internal", 1, false, 3],
    ["defer-esm-external", 1, true, 3], ["source-iife", 2, false, 1],
    ["source-esm-external", 2, true, 3], ["eval-ignored", 0, false, 2],
  ];
  for (const [n, phase, ext, fmt] of cases) {
    const log = fakeLog();
    reportExplicitPhaseImport(log, null, {}, phase, ext, fmt);
    assert.deepStrictEqual({ errors: log.errors }, by["report:" + n], "report:" + n);
  }
});

test("findReachableFiles 逐字节等于 Go（5 例）", () => {
  const invalid = () => ({ IsValid: () => false, GetIndex: () => 0 });
  const js = (records: any[]) => ({ CSSSourceIndex: invalid(), ImportRecords: () => records });
  const imp = (idx: number) => ({ SourceIndex: MakeIndex32(idx), CopySourceIndex: invalid() });
  const copyImp = (idx: number) => ({ SourceIndex: invalid(), CopySourceIndex: MakeIndex32(idx) });
  const files = [
    { Repr: js([]) },
    { Repr: js([imp(2), imp(0)]) },
    { Repr: js([imp(3)]) },
    { Repr: js([]) },
    { Repr: js([copyImp(4)]) },
    { Repr: js([]) },
  ];
  for (const [n, eps] of [
    ["empty", []], ["one", [{ SourceIndex: 1 }]], ["two", [{ SourceIndex: 1 }, { SourceIndex: 3 }]],
    ["copy-cycle", [{ SourceIndex: 4 }]], ["isolated", [{ SourceIndex: 5 }]],
  ] as const) {
    assert.deepStrictEqual({ order: findReachableFiles(files, eps as any) }, by["reachable:" + n], "reachable:" + n);
  }
});

test("generateMetadataJSON 逐字节等于 Go（5 例）", () => {
  const realFS = MockFS({}, MockUnix, "/home/user/project");
  const cases: [string, Record<number, string>, any[], boolean][] = [
    ["empty", {}, [], false],
    ["one-input", { 0: '"./a.js": {"bytes": 10}' }, [], false],
    ["with-output", { 1: '"./a.js": {"bytes": 10}' }, [{ AbsPath: "/dist/out.js", JSONMetadataChunk: '"./out.js": {"bytes": 20}' }], false],
    ["minified", { 1: '"./a.js": {"bytes": 10}' }, [{ AbsPath: "/dist/out.js", JSONMetadataChunk: '"./out.js": {"bytes": 20}' }], true],
    ["dup-output", {}, [{ AbsPath: "/dist/out.js", JSONMetadataChunk: "A" }, { AbsPath: "/dist/out.js", JSONMetadataChunk: "B" }], false],
  ];
  for (const [n, inputs, outputs, minify] of cases) {
    const max = Object.keys(inputs).reduce((a, k) => Math.max(a, Number(k)), 0);
    const bf: any[] = [];
    for (let i = 0; i <= max; i++) bf.push({ jsonMetadataChunk: "" });
    for (const [idx, chunk] of Object.entries(inputs)) bf[Number(idx)].jsonMetadataChunk = chunk;
    const bundle = { fs: realFS, files: bf };
    const all = bf.map((_, i) => i);
    const options = { MetafileFormat: minify ? 1 : 0, ASCIIOnly: false, MetafilePathStyle: 0 };
    assert.deepStrictEqual({ json: generateMetadataJSON(bundle, outputs, all, options) }, by["metadata:" + n], "metadata:" + n);
  }
});
