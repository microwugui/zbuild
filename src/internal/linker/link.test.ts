// 第 118 轮：Link 顶层编排端到端逐字节等于 Go（4 场景，注入真实 Parse AST + dataForSourceMaps）。
// Go 探针 tools/go/tmpgen_link2_test.go → testdata/link-go.json（SHA 96be01ac…）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Link } from "./linker.ts";
import { Parse, OptionsFromConfig } from "../js_parser/js_parser.ts";
import { Source as RuntimeSource } from "../runtime/runtime.ts";
import { Log, Source, Path } from "../logger/logger.ts";
import { JSRepr, InputFile } from "../graph/input.ts";
import { EntryPoint } from "../graph/input.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/link-go.json", import.meta.url)));
const SHA = "b4daf25712a7fbbae91a96b21d2e9c5db34d548614ce268aaaa53ff9a550d5c6";
const rows = JSON.parse(new TextDecoder().decode(raw)) as any[];

type TC = { name: string; entrySource: string; format: number };
const cases: TC[] = [
  { name: "esm-var", entrySource: "var x = 1;", format: 3 },
  { name: "side-effect", entrySource: "console.log(1);", format: 3 },
  { name: "multi-stmt", entrySource: "var x = 1; var y = 2; console.log(x + y);", format: 3 },
];

function parseAST(path: string, contents: string, index: number, opts: any): { ast: any; source: Source } {
  const src = new Source();
  src.Index = index;
  const kp = new Path(); kp.Text = path; kp.Namespace = "file";
  src.KeyPath = kp;
  src.Contents = new TextEncoder().encode(contents);
  const r = Parse(new Log(), src, OptionsFromConfig(opts));
  return { ast: r.ast, source: src };
}

function run(tc: TC): any {
  const opts: any = {
    Mode: 2, OutputFormat: tc.format,
    ExtensionToLoader: new Map([[" .js".trim(), 10]]),
    AbsOutputDir: "/p/out", AbsOutputBase: "/p", OutputExtensionJS: ".js",
    EntryPathTemplate: [{ Data: "a", Placeholder: 0 }],
    ChunkPathTemplate: [{ Data: "a", Placeholder: 0 }],
    TreeShaking: false, UnsupportedJSFeatures: 0n,
    CodeSplitting: false, ProfilerNames: false,
    NeedsMetafile: false, ASCIIOnly: false,
  };
  opts.ExclusiveMangleCacheUpdate = (cb: any) => { cb(new Map(), new Set()); };
  // runtime AST via real parse
  const rtSrc = RuntimeSource(0n);
  const rt = parseAST("<runtime>", new TextDecoder().decode(rtSrc.Contents), 0, opts);
  const rtFile: any = new InputFile(); rtFile.Source = rt.source; rtFile.Repr = new JSRepr(); (rtFile.Repr as any).AST = rt.ast;
  rtFile.OmitFromSourceMapsAndMetafile = true;
  // entry
  const ent = parseAST("/p/a.js", tc.entrySource, 1, opts);
  const entFile: any = new InputFile(); entFile.Source = ent.source; entFile.Repr = new JSRepr(); (entFile.Repr as any).AST = ent.ast;
  entFile.Loader = 10;
  const inputFiles = [rtFile, entFile];
  const entries = [new EntryPoint()]; entries[0].OutputPath = "a"; entries[0].SourceIndex = 1;
  const mockFS: any = { Cwd: () => "/p", Rel: (b: string, t: string) => ({ value: t.slice(b.length + 1), ok: t.startsWith(b + "/") }),
    Join: (parts: string[]) => parts.join("/"), IsAbs: (p: string) => p.startsWith("/"), Dir: () => "/", Base: (p: string) => p.split("/").pop(), Ext: () => "" };
  const outputs = Link(opts, new Log(), mockFS, null, inputFiles, entries, "key", [0, 1], () => [{} as any, {} as any]);
  return {
    name: tc.name,
    outputs: outputs.map((o: any) => {
      const pathBytes = new TextEncoder().encode(o.AbsPath);
      const blob = new Uint8Array(pathBytes.length + 1 + o.Contents.length);
      blob.set(pathBytes, 0); blob[pathBytes.length] = 0; blob.set(o.Contents, pathBytes.length + 1);
      return Buffer.from(blob).toString("base64");
    }),
  };
}

test("link 夹具 sha256（4 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("Link 端到端逐字节等于 Go", () => {
  for (let i = 0; i < rows.length; i++) {
    const got = run(cases[i]);
    assert.deepEqual(got, rows[i], `scenario ${i}: ${rows[i].name}`);
  }
});
