// 第 155 批：generateSourceMapForChunk（chunk sourcemap 生成），Go 探针 4 例逐字节。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Source, Path, Loc } from "../logger/logger.ts";
import { Index32 } from "../ast/ast.ts";
import { SourceMapState, MappingsBuffer } from "../sourcemap/sourcemap.ts";
import { InputFile } from "../graph/input.ts";
import { LinkerGraph, LinkerFile } from "../graph/graph.ts";
import { MockFS, MockUnix } from "../fs/fs_mock.ts";
import { QuoteForJSON } from "../helpers/quote.ts";
import { MakeChunkBuilder, GenerateLineOffsetTables } from "../sourcemap/sourcemap.ts";
import { linkerContext } from "./linker.ts";
import { generateSourceMapForChunk } from "./linker.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/sourcemap-chunk-go.json", import.meta.url)));
const SHA = "7b80333d29b843db0d0b6d2d464116f9fb5f583c7a3c3cf62c319c2bc8f3724d";
const enc = new TextEncoder();
const dec = new TextDecoder();
const q = (s: string): Uint8Array => QuoteForJSON(enc.encode(s), false);

function mkFile(text: string, ns: string, rel: string, abs: string): LinkerFile {
  const f = new InputFile();
  const s = new Source(); s.KeyPath = new Path(); s.KeyPath.Text = text; s.KeyPath.Namespace = ns;
  s.Contents = enc.encode("x"); (s as any).PrettyPaths = { Rel: rel, Abs: abs };
  f.Source = s;
  const lf = new LinkerFile(); lf.InputFile = f;
  return lf;
}
function buildChunk(contents: string, name: string, output: string): any {
  const b = MakeChunkBuilder(null, GenerateLineOffsetTables(contents, 2), false);
  b.AddSourceMapping(new Loc(0), name, enc.encode(output));
  return b.GenerateChunk(enc.encode(output));
}

const ROWS: { fn: string; arg: any; run: () => any }[] = [
  { fn: "generateSourceMapForChunk", arg: { case: "single", shifts: true }, run: () => {
    const c = new linkerContext(); c.fs = MockFS({}, MockUnix, "/"); c.options = {};
    c.graph = new LinkerGraph(); c.graph.Files = [new LinkerFile(), mkFile("/p/src/a.js", "file", "src/a.js", "/p/src/a.js")];
    const results = [{ sourceMapChunk: buildChunk("hello\n", "origName", "var x = 1;\n"), generatedOffset: { Lines: 0, Columns: 0 }, sourceIndex: 1, isNullEntry: false }];
    const data: any[] = [null, { QuotedContents: [q("hello")] }];
    const p = generateSourceMapForChunk(c, results, "/p/out", data, true);
    return { prefix: dec.decode(p.Prefix), mappings: dec.decode(p.Mappings), suffix: dec.decode(p.Suffix) };
  }},
  { fn: "generateSourceMapForChunk", arg: { case: "single", shifts: false }, run: () => {
    const c = new linkerContext(); c.fs = MockFS({}, MockUnix, "/"); c.options = {};
    c.graph = new LinkerGraph(); c.graph.Files = [new LinkerFile(), mkFile("/p/src/a.js", "file", "src/a.js", "/p/src/a.js")];
    const results = [{ sourceMapChunk: buildChunk("x", "", "x"), generatedOffset: { Lines: 0, Columns: 0 }, sourceIndex: 1, isNullEntry: false }];
    const data: any[] = [null, { QuotedContents: [q("hello")] }];
    const p = generateSourceMapForChunk(c, results, "/p/out", data, false);
    return { prefix: dec.decode(p.Prefix), mappings: dec.decode(p.Mappings), suffix: dec.decode(p.Suffix) };
  }},
  { fn: "generateSourceMapForChunk", arg: { case: "multi-null", shifts: true }, run: () => {
    const c = new linkerContext(); c.fs = MockFS({}, MockUnix, "/"); c.options = { ExcludeSourcesContent: true, SourceRoot: "webpack:///" };
    c.graph = new LinkerGraph();
    c.graph.Files = [new LinkerFile(), mkFile("/p/src/a.js", "file", "/p/src/a.js", "/p/src/a.js"), mkFile("/p/src/b.js", "file", "/p/src/b.js", "/p/src/b.js")];
    const results = [
      { sourceMapChunk: buildChunk("aaa;\nbbb", "n1", "aaa;"), generatedOffset: { Lines: 0, Columns: 0 }, sourceIndex: 1, isNullEntry: false },
      { sourceMapChunk: { Buffer: { Data: new Uint8Array(0), FirstNameOffset: new Index32() }, QuotedNames: [], EndState: new SourceMapState(), FinalGeneratedColumn: 0 }, generatedOffset: { Lines: 1, Columns: 0 }, sourceIndex: 2, isNullEntry: true },
      { sourceMapChunk: buildChunk("bbb;", "n2", "bbb;"), generatedOffset: { Lines: 2, Columns: 0 }, sourceIndex: 2, isNullEntry: false },
    ];
    const p = generateSourceMapForChunk(c, results, "/p/out", [null, null, null], true);
    return { prefix: dec.decode(p.Prefix), mappings: dec.decode(p.Mappings), suffix: dec.decode(p.Suffix) };
  }},
  { fn: "generateSourceMapForChunk", arg: { case: "virtual", shifts: true }, run: () => {
    const c = new linkerContext(); c.fs = MockFS({}, MockUnix, "/"); c.options = {};
    c.graph = new LinkerGraph(); c.graph.Files = [new LinkerFile(), mkFile("plugin:virtual.js", "https", "virtual.js", "virtual.js")];
    const results = [{ sourceMapChunk: buildChunk("abc", "", "z"), generatedOffset: { Lines: 0, Columns: 0 }, sourceIndex: 1, isNullEntry: false }];
    const data: any[] = [null, { QuotedContents: [q("abc")] }];
    const p = generateSourceMapForChunk(c, results, "/p/out", data, true);
    return { prefix: dec.decode(p.Prefix), mappings: dec.decode(p.Mappings), suffix: dec.decode(p.Suffix) };
  }},
];

test("sourcemap-chunk fixture sha256 + 4 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(dec.decode(bytes));
  assert.equal(rows.length, ROWS.length);
  for (let i = 0; i < rows.length; i++) {
    assert.equal(ROWS[i].fn, rows[i].fn);
    assert.deepEqual(ROWS[i].arg, rows[i].arg, `arg@${i}`);
    assert.deepEqual(ROWS[i].run(), rows[i].out, `${JSON.stringify(rows[i].arg)} mismatch`);
  }
});
