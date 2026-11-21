// 第 150 批：isolated hash 簇（generateIsolatedHash / generateIsolatedHashInParallel /
// appendIsolatedHashesForImportedChunks），Go 探针 5 例逐字节。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Source, Path } from "../logger/logger.ts";
import { InputFile, JSRepr, OutputFile } from "../graph/input.ts";
import { LinkerGraph, LinkerFile } from "../graph/graph.ts";
import { MockFS, MockUnix } from "../fs/fs_mock.ts";
import { Joiner } from "../helpers/joiner.ts";
import { New as NewHash } from "../xxhash/xxhash.ts";
import { linkerContext, chunkInfo, chunkReprJS, chunkReprCSS, outputPieceNone, outputPieceAssetIndex } from "./linker.ts";
import { generateIsolatedHash, generateIsolatedHashInParallel, appendIsolatedHashesForImportedChunks } from "./linker.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/isolated-hash-go.json", import.meta.url)));
const SHA = "ad9d0a9403b718cf00175dd3c4a5339274e79551f5baa9d6e9a5412309c779da";
const enc = new TextEncoder(); const dec = new TextDecoder();
const toHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

function build(): linkerContext {
  const c = new linkerContext();
  c.fs = MockFS({}, MockUnix, "/"); c.uniqueKeyPrefix = "TEST"; c.uniqueKeyPrefixBytes = enc.encode("TEST");
  c.options = { AbsOutputDir: "/p/out", PublicPath: "/static/" };
  c.graph = new LinkerGraph();
  c.graph.Files = [new LinkerFile(), new LinkerFile()];
  const s0 = new Source(); s0.KeyPath = new Path(); s0.KeyPath.Text = "/p/src/a.js"; s0.KeyPath.Namespace = "file";
  (s0.PrettyPaths as any).Rel = "src/a.js";
  const s1 = new Source(); s1.KeyPath = new Path(); s1.KeyPath.Text = "virtual:data"; s1.KeyPath.Namespace = "virtual";
  c.graph.Files[0].InputFile = new InputFile(); c.graph.Files[0].InputFile.Source = s0;
  c.graph.Files[0].InputFile.Repr = new JSRepr();
  const of = new OutputFile(); of.AbsPath = "/p/out/assets/x.png";
  c.graph.Files[0].InputFile.AdditionalFiles = [of];
  c.graph.Files[1].InputFile = new InputFile(); c.graph.Files[1].InputFile.Source = s1;
  c.graph.Files[1].InputFile.Repr = new JSRepr();
  return c;
}
function mkTPL(data: string, ph: number): any { return { Data: data, Placeholder: ph }; }

const ROWS: { fn: string; arg: any; run: () => string }[] = [
  { fn: "generateIsolatedHash", arg: { scenario: "A" }, run: () => {
    const c = build();
    const ch = new chunkInfo();
    ch.finalTemplate = [mkTPL("./", 1), mkTPL("x", 3)];
    const r = new chunkReprJS(); r.partsInChunkInOrder = [
      { sourceIndex: 0, partIndexBegin: 0, partIndexEnd: 3 }, { sourceIndex: 1, partIndexBegin: 2, partIndexEnd: 4 },
    ]; ch.chunkRepr = r;
    ch.intermediateOutput = { pieces: [{ data: enc.encode("abc"), index: 0, kind: outputPieceNone }, { data: enc.encode("def"), index: 0, kind: outputPieceNone }], joiner: null };
    ch.outputSourceMap = { Prefix: enc.encode("PRE"), Mappings: enc.encode("MAP"), Suffix: enc.encode("SUF") };
    return toHex(generateIsolatedHash(c, ch));
  } },
  { fn: "generateIsolatedHash", arg: { scenario: "B" }, run: () => {
    const c = build(); c.options.PublicPath = "";
    const j = new Joiner(); j.AddString(enc.encode("joined content"));
    const ch = new chunkInfo(); ch.intermediateOutput = { pieces: null, joiner: j }; ch.chunkRepr = new chunkReprCSS();
    return toHex(generateIsolatedHash(c, ch));
  } },
  { fn: "generateIsolatedHashInParallel", arg: {}, run: () => {
    const c = build();
    const ch = new chunkInfo(); ch.finalTemplate = [mkTPL("x.js", 0)]; ch.chunkRepr = new chunkReprJS();
    const j = new Joiner(); j.AddString(enc.encode("hello")); ch.intermediateOutput = { pieces: null, joiner: j };
    generateIsolatedHashInParallel(c, ch);
    return toHex(ch.waitForIsolatedHash!());
  } },
  { fn: "appendIsolatedHashesForImportedChunks", arg: { scenario: "chain" }, run: () => {
    const c = build();
    const ch0 = new chunkInfo(); ch0.crossChunkImports = [{ chunkIndex: 1, importKind: 1 }];
    ch0.intermediateOutput = { pieces: [{ data: enc.encode("z"), index: 0, kind: outputPieceAssetIndex }], joiner: null };
    ch0.waitForIsolatedHash = () => new Uint8Array([0x11, 0x22, 0x33]);
    const ch1 = new chunkInfo(); ch1.waitForIsolatedHash = () => new Uint8Array([0xAA, 0xBB]);
    c.chunks = [ch0, ch1];
    const d = NewHash();
    appendIsolatedHashesForImportedChunks(c, d, 0, [0, 0], 1);
    return toHex(d.Sum(new Uint8Array(0)));
  } },
  { fn: "appendIsolatedHashesForImportedChunks", arg: { scenario: "cycle" }, run: () => {
    const c = build();
    const ch0 = new chunkInfo(); ch0.crossChunkImports = [{ chunkIndex: 1, importKind: 1 }];
    ch0.waitForIsolatedHash = () => new Uint8Array([0x01]);
    const ch1 = new chunkInfo(); ch1.crossChunkImports = [{ chunkIndex: 0, importKind: 1 }];
    ch1.waitForIsolatedHash = () => new Uint8Array([0x02]);
    c.chunks = [ch0, ch1];
    const d = NewHash();
    appendIsolatedHashesForImportedChunks(c, d, 0, [0, 0], 1);
    return toHex(d.Sum(new Uint8Array(0)));
  } },
];

test("isolated-hash fixture sha256 + 5 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(dec.decode(bytes));
  assert.equal(rows.length, ROWS.length);
  for (let i = 0; i < rows.length; i++) {
    assert.equal(ROWS[i].fn, rows[i].fn);
    assert.deepEqual(ROWS[i].arg, rows[i].arg);
    assert.equal(ROWS[i].run(), rows[i].out, `${rows[i].fn} ${JSON.stringify(rows[i].arg)} mismatch`);
  }
});
