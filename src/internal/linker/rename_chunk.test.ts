// 第 153 批：renameSymbolsInChunk（chunk 符号重命名核心），Go 探针 3 例逐字节。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as ast from "../ast/ast.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import { InputFile, JSRepr } from "../graph/input.ts";
import { LinkerGraph, CloneLinkerGraph, LinkerFile } from "../graph/graph.ts";
import { EntryPoint } from "../graph/input.ts";
import { NewSymbolMap } from "../ast/ast.ts";
import { linkerContext, chunkInfo, chunkReprJS } from "./linker.ts";
import { renameSymbolsInChunk } from "./linker.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/rename-chunk-go.json", import.meta.url)));
const SHA = "288cf9d1ff15b03faf96894c56a83e122135b8540eeb5caf09e798354e7a3fac";
const ref = (s: number, i: number): ast.Ref => new ast.Ref(s, i);
function mkSymbol(name: string): ast.Symbol { const s = new ast.Symbol(); s.OriginalName = name; s.Link = ast.InvalidRef; s.Kind = ast.SymbolKind.SymbolConst; return s; }
function mkScope(members: [string, ast.Ref][]): js_ast.Scope {
  const s = new js_ast.Scope(); s.Members = new Map();
  for (const [n, r] of members) { const m = new js_ast.ScopeMember(); m.Ref = r; s.Members.set(n, m); }
  return s;
}

const ROWS: { fn: string; arg: any; run: () => any }[] = [
  { fn: "renameSymbolsInChunk", arg: { minify: false }, run: () => {
    const inputs: InputFile[] = [new InputFile(), new InputFile()];
    const rt = new JSRepr(); rt.AST.ModuleScope = new js_ast.Scope(); inputs[0].Repr = rt;
    const syms = [mkSymbol("alpha"), mkSymbol("beta"), mkSymbol("if"), mkSymbol("helper")];
    const ms = mkScope([["alpha", ref(1, 0)], ["beta", ref(1, 1)], ["if", ref(1, 2)]]);
    const nested = mkScope([["helper", ref(1, 3)]]);
    ms.Children.push(nested);
    const part = new js_ast.Part();
    part.DeclaredSymbols = [decl(ref(1, 0)), decl(ref(1, 1))];
    const u1 = new js_ast.SymbolUse(); u1.CountEstimate = 3; part.SymbolUses.set("1:0", u1);
    const u2 = new js_ast.SymbolUse(); u2.CountEstimate = 1; part.SymbolUses.set("1:1", u2);
    part.Scopes.push(nested); part.IsLive = true;
    const repr = new JSRepr(); repr.AST.Symbols = syms; repr.AST.Parts = [part]; repr.AST.ModuleScope = ms;
    inputs[1].Repr = repr;
    const ep = new EntryPoint(); ep.SourceIndex = 1; ep.OutputPath = "e.js";
    const g = CloneLinkerGraph(inputs, [0, 1], [ep], false);
    const c = new linkerContext(); c.graph = g; c.options = { MinifyIdentifiers: false, OutputFormat: 1, Mode: 2 };
    const chunk = new chunkInfo(); chunk.chunkRepr = new chunkReprJS();
    const r = renameSymbolsInChunk(c, chunk, [1], null);
    return [0, 1, 2, 3].map((i) => r.NameForSymbol(ref(1, i)));
  }},
  { fn: "renameSymbolsInChunk", arg: { minify: true }, run: () => {
    const inputs: InputFile[] = [new InputFile(), new InputFile()];
    const rt = new JSRepr(); rt.AST.ModuleScope = new js_ast.Scope(); inputs[0].Repr = rt;
    const syms = [mkSymbol("alpha"), mkSymbol("beta"), mkSymbol("if"), mkSymbol("helper")];
    const ms = mkScope([["alpha", ref(1, 0)], ["beta", ref(1, 1)], ["if", ref(1, 2)]]);
    const nested = mkScope([["helper", ref(1, 3)]]); ms.Children.push(nested);
    const part = new js_ast.Part();
    part.DeclaredSymbols = [decl(ref(1, 0)), decl(ref(1, 1))];
    const u1 = new js_ast.SymbolUse(); u1.CountEstimate = 3; part.SymbolUses.set("1:0", u1);
    const u2 = new js_ast.SymbolUse(); u2.CountEstimate = 1; part.SymbolUses.set("1:1", u2);
    part.Scopes.push(nested); part.IsLive = true;
    const repr = new JSRepr(); repr.AST.Symbols = syms; repr.AST.Parts = [part]; repr.AST.ModuleScope = ms;
    inputs[1].Repr = repr;
    const ep = new EntryPoint(); ep.SourceIndex = 1; ep.OutputPath = "e.js";
    const g = CloneLinkerGraph(inputs, [0, 1], [ep], false);
    const c = new linkerContext(); c.graph = g; c.options = { MinifyIdentifiers: true, OutputFormat: 1, Mode: 2 };
    const chunk = new chunkInfo(); chunk.chunkRepr = new chunkReprJS();
    const r = renameSymbolsInChunk(c, chunk, [1], null);
    return [0, 1, 2, 3].map((i) => r.NameForSymbol(ref(1, i)));
  }},
  { fn: "renameSymbolsInChunk", arg: { scenario: "collision" }, run: () => {
    const inputs: InputFile[] = [new InputFile(), new InputFile(), new InputFile()];
    inputs[0].Repr = (() => { const r = new JSRepr(); r.AST.ModuleScope = new js_ast.Scope(); return r; })();
    for (const si of [1, 2]) {
      const syms = [mkSymbol("value"), mkSymbol("default")];
      const ms = mkScope([["value", ref(si, 0)], ["default", ref(si, 1)]]);
      const part = new js_ast.Part(); part.DeclaredSymbols = [decl(ref(si, 0))]; part.IsLive = true;
      const repr = new JSRepr(); repr.AST.Symbols = syms; repr.AST.Parts = [part]; repr.AST.ModuleScope = ms;
      inputs[si].Repr = repr;
    }
    const e1 = new EntryPoint(); e1.SourceIndex = 1; e1.OutputPath = "a.js";
    const e2 = new EntryPoint(); e2.SourceIndex = 2; e2.OutputPath = "b.js";
    const g = CloneLinkerGraph(inputs, [0, 1, 2], [e1, e2], false);
    const c = new linkerContext(); c.graph = g; c.options = { MinifyIdentifiers: false, OutputFormat: 3, Mode: 2 };
    const chunk = new chunkInfo(); chunk.chunkRepr = new chunkReprJS();
    const r = renameSymbolsInChunk(c, chunk, [1, 2], null);
    return [[1, 0], [1, 1], [2, 0], [2, 1]].map(([s, i]) => r.NameForSymbol(ref(s, i)));
  }},
];
function decl(r: ast.Ref): js_ast.DeclaredSymbol { const d = new js_ast.DeclaredSymbol(); d.Ref = r; d.IsTopLevel = true; return d; }

test("rename-chunk fixture sha256 + 3 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  assert.equal(rows.length, ROWS.length);
  for (let i = 0; i < rows.length; i++) {
    assert.equal(ROWS[i].fn, rows[i].fn);
    assert.deepEqual(ROWS[i].arg, rows[i].arg, `arg@${i}`);
    assert.deepEqual(ROWS[i].run(), rows[i].out, `${JSON.stringify(rows[i].arg)} mismatch`);
  }
});
