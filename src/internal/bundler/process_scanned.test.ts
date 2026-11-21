// 第 116 轮：scanner.processScannedFiles 逐字节等于 Go（4 场景：nometa/meta-noimports/
// collision with 属性消歧 / big-minified）。Go 期望 testdata/process-scanned-go.json（SHA 0ee5b9f5…）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { processScannedFiles } from "./bundler.ts";
import { Source, Path, PrettyPaths, EncodeImportAttributes } from "../logger/logger.ts";
import { JSRepr, InputFile, SideEffects } from "../graph/input.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/process-scanned-go.json", import.meta.url)));
const SHA = "0ee5b9f56a6aaae9da07dbaed1813b2061e43636a06b94b17f5a3af5e5a5e075";
const rows = JSON.parse(new TextDecoder().decode(raw)) as any[];

function mkResult(abs: string, rel: string, attrs: [string, string][] | null): any {
  const kp = new Path(); kp.Text = "/p/" + rel; kp.Namespace = "file";
  if (attrs && attrs.length) {
    const m = new Map<string, Uint8Array>();
    for (const [k, v] of attrs) m.set(k, new TextEncoder().encode(v));
    (kp as any).ImportAttributes = EncodeImportAttributes(m);
  }
  const src = new Source();
  src.KeyPath = kp;
  src.PrettyPaths = (() => { const p = new PrettyPaths(); p.Abs = abs; p.Rel = rel; return p; })();
  src.Contents = new TextEncoder().encode("var x=1;");
  const repr = new JSRepr();
  repr.AST.ImportRecords = [];
  const inp = new InputFile(); inp.Source = src; inp.Repr = repr;
  return { ok: true, file: { inputFile: inp, jsonMetadataChunk: "" } };
}

type TC = { name: string; needsMeta: boolean; minified: boolean; results: any[] };
const cases: TC[] = [
  { name: "nometa", needsMeta: false, minified: false, results: [mkResult("/p/a.js", "a.js", null)] },
  { name: "meta-noimports", needsMeta: true, minified: false, results: [mkResult("/p/a.js", "a.js", null)] },
  { name: "collision", needsMeta: true, minified: false, results: [
    mkResult("/p/m.js", "m.js", [["type", "json"]]),
    mkResult("/p/m.js", "m.js", [["type", "text"]]),
  ] },
  { name: "big-minified", needsMeta: true, minified: true, results: [mkResult("/p/a.js", "a.js", null)] },
];

function run(tc: TC): any {
  const s: any = {
    fs: null,
    options: { NeedsMetafile: tc.needsMeta, MetafileFormat: tc.minified ? 1 : 0 },
    results: tc.results,
  };
  const out = processScannedFiles(s);
  return { name: tc.name, meta: out.map((o) => o.meta), relAfter: out.map((o) => o.relAfter), mf: out[0]?.mf ?? s.options.MetafileFormat };
}

test("process-scanned 夹具 sha256（4 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("processScannedFiles 逐字节等于 Go", () => {
  assert.deepEqual(cases.map(run), rows);
});
