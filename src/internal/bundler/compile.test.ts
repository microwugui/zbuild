// 第 116 轮：Bundle.Compile 真 1:1 端口逐字节（注入 link 回调，5 场景）。
// Go 期望：tools/go/tmpgen_compile_test.go → testdata/compile-go.json（SHA f9235a35…）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Compile } from "./bundler.ts";
import { Source, Path, PrettyPaths } from "../logger/logger.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/compile-go.json", import.meta.url)));
const SHA = "f9235a351bbf0a3715f77ae455e7b00104300e1efed4c7a8ff973003c6680740";
const rows = JSON.parse(new TextDecoder().decode(raw)) as {
  name: string; outputs: string[]; metafile: string; errors: string[];
}[];

type TC = {
  name: string; writeToStdout?: boolean; needsMeta?: boolean; allowOverwrite?: boolean;
  api: number; linkOutputs: { AbsPath: string; Contents: string; CanBeMerged?: boolean }[];
  inputAbs: string[]; entryCount: number;
};
const cases: TC[] = [
  { name: "basic", api: 1, linkOutputs: [{ AbsPath: "/out/a.js", Contents: "console.log(1)" }], inputAbs: [], entryCount: 1 },
  { name: "two-entries-group", api: 1, linkOutputs: [{ AbsPath: "/out/a.js", Contents: "a" }, { AbsPath: "/out/b.js", Contents: "b" }], inputAbs: [], entryCount: 1 },
  { name: "dedup-merged", api: 1, linkOutputs: [{ AbsPath: "/out/a.js", Contents: "same", CanBeMerged: true }, { AbsPath: "/out/a.js", Contents: "same", CanBeMerged: true }], inputAbs: [], entryCount: 1 },
  { name: "overwrite-input", api: 1, linkOutputs: [{ AbsPath: "/src/a.js", Contents: "out" }], inputAbs: ["/src/a.js"], entryCount: 1 },
  { name: "allow-overwrite", api: 1, allowOverwrite: true, linkOutputs: [{ AbsPath: "/src/a.js", Contents: "out" }], inputAbs: ["/src/a.js"], entryCount: 1 },
];

const enc = new TextEncoder();
function mkInput(abs: string): any {
  const src = new Source();
  const kp = new Path(); kp.Text = abs; kp.Namespace = "file";
  src.KeyPath = kp;
  src.PrettyPaths = new PrettyPaths();
  return { Source: src, Repr: { ImportRecords: () => [], CSSSourceIndex: null } };
}

function run(tc: TC): { name: string; outputs: string[]; metafile: string; errors: string[] } {
  const errors: string[] = [];
  const log = { addError: (t: string) => { errors.push(t); } };
  const files: any[] = [mkInput("<runtime>")];
  for (const abs of tc.inputAbs) files.push(mkInput(abs));
  const entryIdx = tc.inputAbs.length > 0 ? files.length - 1 : 0;
  const entryPoints: any[] = [];
  for (let i = 0; i < tc.entryCount; i++) entryPoints.push({ SourceIndex: entryIdx });
  const b: any = {
    fs: { Cwd: () => "/", Rel: (base: string, target: string) => (target.startsWith(base + "/") ? [target.slice(base.length + 1), true] : ["", false]) },
    files: files.map((f) => ({ inputFile: f })),
    entryPoints,
    options: { WriteToStdout: !!tc.writeToStdout, NeedsMetafile: !!tc.needsMeta, AllowOverwrite: !!tc.allowOverwrite, CodeSplitting: true, API: tc.api, LogPathStyle: 0 },
    uniqueKeyPrefix: "key",
  };
  const link = () => tc.linkOutputs.map((o) => ({
    AbsPath: o.AbsPath, Contents: enc.encode(o.Contents), CanBeMerged: !!o.CanBeMerged, JSONMetadataChunk: "",
  }));
  const res = Compile(b, log, new Map(), link);
  const outputs = res.outputs.map((o: any) => {
    const blob = new Uint8Array(o.AbsPath.length + 1 + o.Contents.length);
    blob.set(enc.encode(o.AbsPath), 0);
    blob[o.AbsPath.length] = 0;
    blob.set(o.Contents, o.AbsPath.length + 1);
    return Buffer.from(blob).toString("base64");
  });
  return { name: tc.name, outputs, metafile: Buffer.from(res.metafile).toString("base64"), errors };
}

test("compile 夹具 sha256（5 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("Compile 5 场景逐字节等于 Go", () => {
  assert.equal(rows.length, cases.length);
  for (let i = 0; i < rows.length; i++) {
    assert.deepEqual(run(cases[i]), rows[i], `scenario ${i}: ${rows[i].name}`);
  }
});
