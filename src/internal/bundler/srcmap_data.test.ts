// 第 112 批：computeDataForSourceMapsInParallel 逐字节等于 Go（5 场景）。
// Go 期望来自 tools/go/tmpgen_srcmap_test.go。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { computeDataForSourceMapsInParallel } from "./bundler.ts";
import { Source, Path } from "../logger/logger.ts";
import { Loader } from "../config/config.ts";
import { JSRepr } from "../graph/input.ts";
import * as js_ast from "../js_ast/js_ast.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/srcmap-go.json", import.meta.url)));
const SHA = "f36e0e5f5e7a40ec49f15a8519223659f761469048c6defc7435e2df2abd3677";
type Row = { name: string; count: number; lotCounts: number[] | null; quoted: string[][] | null };
const rows = JSON.parse(new TextDecoder().decode(raw)) as Row[];
const dec = new TextDecoder();

function mkFile(contents: string, index: number): any {
  const src = new Source();
  (src as any).Index = index;
  (src as any).Contents = new TextEncoder().encode(contents);
  src.KeyPath = new Path();
  src.KeyPath.Text = "f.js";
  const repr = new JSRepr();
  repr.AST = new js_ast.AST();
  (repr.AST as any).ApproximateLineCount = 0;
  return { inputFile: { Source: src, Loader: Loader.LoaderJS, Repr: repr, InputSourceMap: null } };
}
function run(idx: number): any {
  const cases = [
    { sm: 0, contents: ["var x = 1;\n"], exclude: false, ascii: false },
    { sm: 1, contents: ["var x = 1;\nvar y = 2;\n"], exclude: false, ascii: false },
    { sm: 1, contents: ["a\nb\n", "x\ny\nz\n"], exclude: false, ascii: false },
    { sm: 1, contents: ["var x = 1;\n"], exclude: true, ascii: false },
    { sm: 1, contents: ["var s = \"\u00e9\";\n"], exclude: false, ascii: true },
  ];
  const c = cases[idx];
  const b = { files: c.contents.map((x, i) => mkFile(x, i)) };
  const data = computeDataForSourceMapsInParallel(b, { SourceMap: c.sm, ExcludeSourcesContent: c.exclude, ASCIIOnly: c.ascii },
    c.contents.map((_, i) => i))();
  return {
    name: rows[idx].name, count: data.length,
    lotCounts: data.length ? data.map((d: any) => d.LineOffsetTables.length) : null,
    quoted: data.length ? data.map((d: any) => d.QuotedContents.map((q: Uint8Array) => dec.decode(q))) : null,
  };
}

test("srcmap 夹具 sha256（5 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("computeDataForSourceMapsInParallel 逐字节等于 Go", () => {
  assert.equal(rows.length, 5);
  for (let i = 0; i < rows.length; i++) {
    assert.deepEqual(run(i), rows[i], `scenario ${i}: ${rows[i].name}`);
  }
});
