// 第 149 批：输出装配底座（breakOutputIntoPieces / breakJoinerIntoPieces /
// substituteFinalPaths / accurateFinalByteCount），Go 探针 8 例逐字节。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { InputFile, OutputFile, JSRepr } from "../graph/input.ts";
import { LinkerGraph, LinkerFile } from "../graph/graph.ts";
import { MockFS, MockUnix } from "../fs/fs_mock.ts";
import { Joiner } from "../helpers/joiner.ts";
import { linkerContext, chunkInfo } from "./linker.ts";
import { breakOutputIntoPieces, breakJoinerIntoPieces, substituteFinalPaths, accurateFinalByteCount } from "./linker.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/output-pieces-go.json", import.meta.url)));
const SHA = "4ac8d0729ddd06ec837857cf4d265c17beb8810792f575f4b864ed9b24d66259";
const enc = new TextEncoder();
const dec = new TextDecoder();

function build(): linkerContext {
  const c = new linkerContext();
  c.fs = MockFS({}, MockUnix, "/");
  c.uniqueKeyPrefix = "TEST";
  c.uniqueKeyPrefixBytes = enc.encode("TEST");
  c.options = { AbsOutputDir: "/p/out", PublicPath: "/static/" };
  c.graph = new LinkerGraph();
  c.graph.Files = [new LinkerFile(), new LinkerFile()];
  const f1 = c.graph.Files[1];
  f1.InputFile = new InputFile();
  f1.InputFile.Repr = new JSRepr();
  const of = new OutputFile(); of.AbsPath = "/p/out/assets/img.png";
  f1.InputFile.AdditionalFiles = [of];
  f1.InputFile.UniqueKeyForAdditionalFile = "TESTA00000001";
  const ch = new chunkInfo(); ch.uniqueKey = "TESTC00000000"; ch.finalRelPath = "sub/final.js";
  c.chunks = [ch];
  return c;
}

const dumpIO = (io: any, extra?: any): any => {
  const d: any = {
    pieces: (io.pieces ?? []).map((p: any) => ({ data: dec.decode(p.data), index: p.index, kind: p.kind })),
    hasJoiner: io.pieces === null,
    ...(extra ?? {}),
  };
  return d;
};
const modify = (s: string): string => "FINAL_" + s;

const ROWS: { fn: string; run: () => any }[] = [
  { fn: "breakOutputIntoPieces", run: () => dumpIO(breakOutputIntoPieces(build(), enc.encode("abcTESTA00000001MIDTESTC00000000END"))) },
  { fn: "breakOutputIntoPieces.bad", run: () => dumpIO(breakOutputIntoPieces(build(), enc.encode("xTESTA00000099yTESTCzzzzzzzzz"))) },
  { fn: "breakOutputIntoPieces.none", run: () => dumpIO(breakOutputIntoPieces(build(), enc.encode("plain output"))) },
  { fn: "breakJoinerIntoPieces.with", run: () => { const j = new Joiner(); j.AddString(enc.encode("abcTESTA00000001MIDTESTC00000000END")); return dumpIO(breakJoinerIntoPieces(build(), j)); } },
  { fn: "breakJoinerIntoPieces.without", run: () => { const j = new Joiner(); j.AddString(enc.encode("no boundary here")); return dumpIO(breakJoinerIntoPieces(build(), j)); } },
  { fn: "substituteFinalPaths", run: () => { const io = breakOutputIntoPieces(build(), enc.encode("abcTESTA00000001MIDTESTC00000000END")); const [j, shifts] = substituteFinalPaths(build(), io, modify); return dumpIO(io, { bytes: dec.decode(j.Done()), shifts: shifts.map((s) => [s.Before.Lines, s.Before.Columns, s.After.Lines, s.After.Columns]) }); } },
  { fn: "substituteFinalPaths.fast", run: () => { const j0 = new Joiner(); j0.AddString(enc.encode("plain")); const [j, shifts] = substituteFinalPaths(build(), { pieces: null, joiner: j0 }, modify); return dumpIO({ pieces: null, joiner: j0 }, { bytes: dec.decode(j.Done()), shifts: shifts.map((s) => [s.Before.Lines, s.Before.Columns, s.After.Lines, s.After.Columns]) }); } },
  { fn: "accurateFinalByteCount", run: () => { const io = breakOutputIntoPieces(build(), enc.encode("abcTESTA00000001MIDTESTC00000000END")); return { count: accurateFinalByteCount(build(), io, "/p/out/sub") }; } },
];

test("output-pieces fixture sha256 + 8 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(dec.decode(bytes));
  assert.equal(rows.length, ROWS.length);
  for (let i = 0; i < rows.length; i++) {
    assert.equal(ROWS[i].fn, rows[i].fn);
    assert.deepEqual(ROWS[i].run(), rows[i].out, `${rows[i].fn} mismatch`);
  }
});
