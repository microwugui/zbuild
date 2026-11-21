// 第 156 批：generateChunkJS / generateChunkCSS 本体，Go 探针 2 例逐字节。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as ast from "../ast/ast.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import { Source, Path, Loc } from "../logger/logger.ts";
import { InputFile, JSRepr } from "../graph/input.ts";
import { LinkerGraph, LinkerFile } from "../graph/graph.ts";
import { MockFS, MockUnix } from "../fs/fs_mock.ts";
import { NewDeferLog, DeferLogKind } from "../logger/logger.ts";
import { linkerContext, chunkInfo, chunkReprJS } from "./linker.ts";
import { generateChunkJS } from "./linker.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/chunkjs-go.json", import.meta.url)));
const SHA = "5541f8cd20603d6e28f2a3f499332e78f92043da112ea5987eaf54748d01d362";
const dec = new TextDecoder();
const enc = new TextEncoder();
const ref = (s: number, i: number): ast.Ref => new ast.Ref(s, i);
function mkSym(name: string): ast.Symbol { const s = new ast.Symbol(); s.OriginalName = name; s.Link = ast.InvalidRef; return s; }

function build(withJS: boolean, banner: string, footer: string, minWS = false, format = 3): linkerContext {
  const c = new linkerContext();
  c.graph = new LinkerGraph(); c.graph.Files = [new LinkerFile(), new LinkerFile()];
  c.graph.Symbols = ast.NewSymbolMap(2);
  const rtScope = new js_ast.Scope(); rtScope.Members = new Map();
  rtScope.Members.set("__toCommonJS", scopeMember(ref(0, 0)));
  rtScope.Members.set("__esm", scopeMember(ref(0, 1)));
  rtScope.Members.set("__require", scopeMember(ref(0, 2)));
  c.graph.Symbols.SymbolsForSource[0] = [mkSym("__toCommonJS"), mkSym("__esm"), mkSym("__require")];
  const rt = new JSRepr(); rt.AST.ModuleScope = rtScope; c.graph.Files[0].InputFile.Repr = rt;

  const sm = new js_ast.Scope(); sm.Members = new Map();
  let parts: js_ast.Part[] = [];
  if (withJS) {
    c.graph.Symbols.SymbolsForSource[1] = [mkSym("foo"), mkSym("bar")];
    sm.Members.set("foo", scopeMember(ref(1, 0))); sm.Members.set("bar", scopeMember(ref(1, 1)));
    const local = new js_ast.SLocal(); local.Kind = js_ast.LocalKind.LocalVar;
    const d = new js_ast.Decl(); const b = new js_ast.Binding(); const bi = new js_ast.BIdentifier(); bi.Ref = ref(1, 0); b.Data = bi; d.Binding = b;
    const num = new js_ast.ENumber(); num.Value = 1; d.ValueOrNil = new js_ast.Expr(); d.ValueOrNil.Data = num;
    local.Decls = [d];
    const p0 = new js_ast.Part(); p0.IsLive = true; p0.Stmts = [new js_ast.Stmt()]; p0.Stmts[0].Data = local;
    const ds = new js_ast.DeclaredSymbol(); ds.Ref = ref(1, 0); ds.IsTopLevel = true; p0.DeclaredSymbols = [ds];
    parts = [p0];
  }
  const repr = new JSRepr();
  repr.AST.Symbols = c.graph.Symbols.SymbolsForSource[1] ?? [];
  repr.AST.Parts = parts; repr.AST.ModuleScope = sm; repr.AST.ExportsRef = ref(1, 0);
  c.graph.Files[1].InputFile.Repr = repr;
  const src = new Source(); src.KeyPath = new Path(); src.KeyPath.Text = "/p/src/main.js"; src.KeyPath.Namespace = "file";
  src.Contents = enc.encode("var foo = 1;"); src.PrettyPaths.Rel = "main.js"; src.PrettyPaths.Abs = "/p/src/main.js";
  c.graph.Files[1].InputFile.Source = src;

  c.fs = MockFS({}, MockUnix, "/");
  c.options = { MinifyIdentifiers: false, OutputFormat: format, JSBanner: banner, JSFooter: footer, Mode: 2, UnsupportedJSFeatures: 0, MinifyWhitespace: minWS };
  c.uniqueKeyPrefix = "TEST"; c.uniqueKeyPrefixBytes = enc.encode("TEST");
  c.log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, new Map());
  c.dataForSourceMaps = () => new Array(2).fill(null);
  return c;
}
function scopeMember(r: ast.Ref): js_ast.ScopeMember { const m = new js_ast.ScopeMember(); m.Ref = r; return m; }
function ioDump(io: any): any {
  const out: any = { hasJoiner: io.pieces === null, bytes: "", pieces: [] };
  if (io.pieces === null) out.bytes = Buffer.from(io.joiner.Done()).toString("hex");
  else out.pieces = io.pieces.map((p: any) => [Buffer.from(p.data).toString("hex"), p.kind, p.index]);
  return out;
}

const ROWS: { fn: string; arg: any; run: () => any }[] = [
  { fn: "generateChunkJS", arg: { case: "empty-banner" }, run: () => {
    const c = build(false, "/* banner */", "/* footer */");
    const ci = new chunkReprJS();
    const ch = new chunkInfo(); ch.chunkRepr = ci; ch.isEntryPoint = false; ch.finalTemplate = [{ Data: "chunk.js", Placeholder: 0 } as any];
    c.chunks = [ch];
    let done = 0; generateChunkJS(c, 0, { done: () => { done++; } });
    return ioDump(ch.intermediateOutput);
  }},
  { fn: "generateChunkJS", arg: { case: "js-parts" }, run: () => {
    const c = build(true, "", "");
    const ci = new chunkReprJS(); ci.filesInChunkInOrder = [1]; ci.partsInChunkInOrder = [{ sourceIndex: 1, partIndexBegin: 0, partIndexEnd: 1 }];
    const ch = new chunkInfo(); ch.chunkRepr = ci; ch.isEntryPoint = false; ch.finalTemplate = [{ Data: "chunk.js", Placeholder: 0 } as any];
    c.chunks = [ch];
    generateChunkJS(c, 0, { done: () => {} });
    return ioDump(ch.intermediateOutput);
  }},
  { fn: "generateChunkJS", arg: { case: "js-parts-minws" }, run: () => {
    const c = build(true, "", "", true, 3);
    const ci = new chunkReprJS(); ci.filesInChunkInOrder = [1]; ci.partsInChunkInOrder = [{ sourceIndex: 1, partIndexBegin: 0, partIndexEnd: 1 }];
    const ch = new chunkInfo(); ch.chunkRepr = ci; ch.isEntryPoint = false; ch.finalTemplate = [{ Data: "chunk.js", Placeholder: 0 } as any];
    c.chunks = [ch];
    generateChunkJS(c, 0, { done: () => {} });
    return ioDump(ch.intermediateOutput);
  }},
  { fn: "generateChunkJS", arg: { case: "iife" }, run: () => {
    const c = build(false, "", "", false, 1);
    const ch = new chunkInfo(); ch.chunkRepr = new chunkReprJS(); ch.isEntryPoint = false; ch.finalTemplate = [{ Data: "chunk.js", Placeholder: 0 } as any];
    c.chunks = [ch];
    generateChunkJS(c, 0, { done: () => {} });
    return ioDump(ch.intermediateOutput);
  }},
  { fn: "generateChunkJS", arg: { case: "crosschunk-prefix" }, run: () => {
    const c = build(false, "", "");
    const rtRepr = c.graph.Files[0].InputFile.Repr as JSRepr;
    const rec = new js_ast.ImportRecord(); rec.Kind = ast.ImportKind.ImportStmt; rec.Path = new Path(); rec.Path.Text = "TESTC00000001";
    rtRepr.AST.ImportRecords = [rec];
    const ns = new js_ast.SImport(); ns.NamespaceRef = ref(0, 3); ns.ImportRecordIndex = 0;
    (c.graph.Symbols.SymbolsForSource[0] as any[]).push(mkSym("ns"));
    const ci = new chunkReprJS(); ci.crossChunkPrefixStmts = [new js_ast.Stmt()]; ci.crossChunkPrefixStmts[0].Data = ns;
    const ch = new chunkInfo(); ch.chunkRepr = ci; ch.isEntryPoint = false; ch.finalTemplate = [{ Data: "chunk.js", Placeholder: 0 } as any];
    ch.crossChunkImports = [{ chunkIndex: 1, importKind: ast.ImportKind.ImportStmt }];
    const ch1 = new chunkInfo(); ch1.chunkRepr = new chunkReprJS(); ch1.uniqueKey = "TESTC00000001";
    c.chunks = [ch, ch1];
    generateChunkJS(c, 0, { done: () => {} });
    return ioDump(ch.intermediateOutput);
  }},
];

test("chunkjs fixture sha256 + 5 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(dec.decode(bytes));
  assert.equal(rows.length, ROWS.length);
  for (let i = 0; i < rows.length; i++) {
    assert.equal(ROWS[i].fn, rows[i].fn);
    assert.deepEqual(ROWS[i].arg, rows[i].arg, `arg@${i}`);
    assert.deepEqual(ROWS[i].run(), rows[i].out, `${JSON.stringify(rows[i].arg)} mismatch`);
  }
});
