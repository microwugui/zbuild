// 第 180 批（第 75 轮）：linker 出口簇逐字节对齐 Go 探针 testdata/lnkexport2-go.json（bf01389d…）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as ast from "../ast/ast.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import { Source, Path, Loc, Range, Log, NewDeferLog, DeferLogKind } from "../logger/logger.ts";
import { InputFile, JSRepr, ExportData, ImportData } from "../graph/input.ts";
import { LinkerGraph, CloneLinkerGraph } from "../graph/graph.ts";
import { NewNoOpRenamer } from "../renamer/renamer.ts";
import { Format } from "../config/config.ts";
import { linkerContext } from "./linker.ts";
import { createExportsForFile, matchImportWithExport, matchImportsWithExportsForFile,
  generateEntryPointTailJS, generateExtraDataForFileJS, generateCodeForFileInChunkJS } from "./linker.ts";
import { refKey } from "../graph/input.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/lnkexport2-go.json", import.meta.url)));
const SHA = "1afae15d8bd2008b20426a151121977f315664ef61f4471ca213cdd0e83a953d";
const dec = new TextDecoder();
const ref = (s: number, i: number): ast.Ref => new ast.Ref(s, i);
const exLoc = (i: number): Loc => new Loc(i);

function build(n: number): linkerContext {
  const c = new linkerContext();
  const inputs: InputFile[] = [];
  for (let si = 0; si < n; si++) {
    const f = new InputFile();
    const src = new Source();
    src.IdentifierName = `f${si}`;
    src.Contents = new TextEncoder().encode("foo bar baz qux foo bar foo default _proto foo bar baz qux foo bar foo default _proto foo bar baz qux");
    src.PrettyPaths.Rel = `f${si}.js`;
    f.Source = src;
    inputs.push(f);
  }
  const reachable = Array.from({ length: n }, (_, i) => i);
  c.graph = CloneLinkerGraph(inputs, reachable, [], false);
  for (let si = 0; si < n; si++) {
    const repr = new JSRepr();
    repr.AST.ModuleScope = new js_ast.Scope();
    c.graph.Files[si].InputFile.Repr = repr;
  }
  const rtScope = new js_ast.Scope();
  const smEx = new js_ast.ScopeMember(); smEx.Ref = ref(0, 0); rtScope.Members.set("__export", smEx);
  const smTcjs = new js_ast.ScopeMember(); smTcjs.Ref = ref(0, 1); rtScope.Members.set("__toCommonJS", smTcjs);
  (c.graph.Files[0].InputFile.Repr as JSRepr).AST.ModuleScope = rtScope;
  c.graph.Symbols.SymbolsForSource[0] = [sym("__export"), sym("__toCommonJS")];
  (c.graph.Files[0].InputFile.Repr as JSRepr).Meta.TopLevelSymbolToPartsOverlay.set(refKey(ref(0, 0)), [0]);
  (c.graph.Files[0].InputFile.Repr as JSRepr).Meta.TopLevelSymbolToPartsOverlay.set(refKey(ref(0, 1)), [0]);
  c.unboundModuleRef = ast.InvalidRef;
  c.cjsRuntimeRef = ref(0, 0); c.esmRuntimeRef = ref(0, 1);
  c.options = { OutputFormat: Format.FormatESModule };
  c.log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, new Map());
  return c;
}
function sym(name: string): ast.Symbol { const s = new ast.Symbol(); s.OriginalName = name; s.Link = ast.InvalidRef; return s; }
function setSyms(c: linkerContext, si: number, names: string[]): void {
  const syms = names.map(sym);
  c.graph.Symbols.SymbolsForSource[si] = syms;
  (c.graph.Files[si].InputFile.Repr as JSRepr).AST.Symbols = syms;
}
function dumpStmts(repr: JSRepr): any {
  return repr.AST.Parts.map((p: any) => ({
    kinds: p.Stmts.map((s: any) => (s.Data?.constructor?.name || "nil").replace(/^/, "*js_ast.")),
    canRemove: p.CanBeRemovedIfUnused, forceTree: p.ForceTreeShaking,
    symUses: p.SymbolUses.size, declared: p.DeclaredSymbols.length, deps: p.Dependencies.length,
  }));
}
function exportData(r: number, i: number, si: number, nl = 0): ExportData {
  const d = new ExportData(); d.Ref = ref(r, i); d.SourceIndex = si; d.NameLoc = nl; return d;
}

const ROWS: { fn: string; arg: any; run: () => any }[] = [
  { fn: "createExportsForFile", arg: { name: "two-exports" }, run: () => {
    const c = build(2); setSyms(c, 1, ["foo", "bar"]);
    const r = c.graph.Files[1].InputFile.Repr as JSRepr;
    r.AST.ExportsRef = ref(1, 0);
    r.Meta.SortedAndFilteredExportAliases = ["bar", "foo"];
    r.Meta.ResolvedExports.set("bar", exportData(1, 1, 1)); r.Meta.ResolvedExports.set("foo", exportData(1, 0, 1));
    r.Meta.NeedsExportsVariable = true; r.AST.Parts = [new js_ast.Part()];
    createExportsForFile(c, 1);
    return dumpStmts(r);
  }},
  { fn: "createExportsForFile", arg: { name: "proto-alias" }, run: () => {
    const c = build(2); setSyms(c, 1, ["p"]);
    const r = c.graph.Files[1].InputFile.Repr as JSRepr;
    r.AST.ExportsRef = ref(1, 0);
    r.Meta.SortedAndFilteredExportAliases = ["__proto__"];
    r.Meta.ResolvedExports.set("__proto__", exportData(1, 0, 1));
    r.Meta.NeedsExportsVariable = false; r.AST.Parts = [new js_ast.Part()];
    createExportsForFile(c, 1);
    return dumpStmts(r);
  }},
  { fn: "matchImportWithExport", arg: { name: "found" }, run: () => {
    const c = build(3); setSyms(c, 1, ["imp"]); setSyms(c, 2, ["foo"]);
    const r1 = c.graph.Files[1].InputFile.Repr as JSRepr, r2 = c.graph.Files[2].InputFile.Repr as JSRepr;
    const ni = new js_ast.NamedImport(); ni.Alias = "foo"; ni.ImportRecordIndex = 0; ni.AliasLoc = exLoc(5); ni.NamespaceRef = ast.InvalidRef;
    r1.AST.NamedImports.set(refKey(ref(1, 0)), ni);
    const rec = new js_ast.ImportRecord(); rec.SourceIndex = 2; rec.Kind = ast.ImportKind.ImportStmt; r1.AST.ImportRecords = [rec];
    r2.Meta.ResolvedExports.set("foo", exportData(2, 0, 2, 9)); r2.AST.ExportsKind = js_ast.ExportsKind.ExportsESM;
    r2.AST.ExportKeyword = new Range(exLoc(0), 6);
    const { result, reExports } = matchImportWithExport(c, { sourceIndex: 1, nameLoc: 5, importRef: ref(1, 0) }, []);
    return [result.kind, result.alias, result.namespaceRef.SourceIndex, result.namespaceRef.InnerIndex,
      result.sourceIndex, result.ref.SourceIndex, result.ref.InnerIndex, result.nameLoc,
      result.otherSourceIndex, result.otherNameLoc, reExports.length];
  }},
  { fn: "matchImportsWithExportsForFile", arg: { name: "found" }, run: () => {
    const c = build(3); setSyms(c, 1, ["imp"]); setSyms(c, 2, ["foo"]);
    const r1 = c.graph.Files[1].InputFile.Repr as JSRepr, r2 = c.graph.Files[2].InputFile.Repr as JSRepr;
    const ni = new js_ast.NamedImport(); ni.Alias = "foo"; ni.ImportRecordIndex = 0; ni.AliasLoc = exLoc(5); ni.NamespaceRef = ast.InvalidRef;
    r1.AST.NamedImports.set(refKey(ref(1, 0)), ni);
    const rec = new js_ast.ImportRecord(); rec.SourceIndex = 2; rec.Kind = ast.ImportKind.ImportStmt; r1.AST.ImportRecords = [rec];
    r2.Meta.ResolvedExports.set("foo", exportData(2, 0, 2, 9)); r2.AST.ExportsKind = js_ast.ExportsKind.ExportsESM;
    r2.AST.ExportKeyword = new Range(exLoc(0), 6);
    matchImportsWithExportsForFile(c, 1);
    const d = r1.Meta.ImportsToBind.get(refKey(ref(1, 0)))!;
    return [d.Ref.SourceIndex, d.Ref.InnerIndex, d.SourceIndex, d.ReExports.length];
  }},
  { fn: "matchImportWithExport", arg: { name: "commonjs" }, run: () => {
    const c = build(3); setSyms(c, 1, ["imp"]); setSyms(c, 2, ["x"]);
    const r1 = c.graph.Files[1].InputFile.Repr as JSRepr, r2 = c.graph.Files[2].InputFile.Repr as JSRepr;
    const ni = new js_ast.NamedImport(); ni.Alias = "foo"; ni.ImportRecordIndex = 0; ni.AliasLoc = exLoc(1); ni.NamespaceRef = ref(1, 0);
    r1.AST.NamedImports.set(refKey(ref(1, 0)), ni);
    const rec = new js_ast.ImportRecord(); rec.SourceIndex = 2; rec.Kind = ast.ImportKind.ImportStmt; r1.AST.ImportRecords = [rec];
    r2.AST.ExportsKind = js_ast.ExportsKind.ExportsCommonJS;
    const { result, reExports } = matchImportWithExport(c, { sourceIndex: 1, nameLoc: 0, importRef: ref(1, 0) }, []);
    return [result.kind, result.alias, result.namespaceRef.SourceIndex, result.namespaceRef.InnerIndex,
      result.sourceIndex, result.ref.SourceIndex, result.ref.InnerIndex, result.nameLoc,
      result.otherSourceIndex, result.otherNameLoc, reExports.length];
  }},
  { fn: "matchImportWithExport", arg: { name: "cycle" }, run: () => {
    const c = build(2); setSyms(c, 1, ["a"]);
    const r1 = c.graph.Files[1].InputFile.Repr as JSRepr;
    const ni = new js_ast.NamedImport(); ni.Alias = "a"; ni.ImportRecordIndex = 0; ni.AliasLoc = exLoc(1); ni.NamespaceRef = ast.InvalidRef;
    r1.AST.NamedImports.set(refKey(ref(1, 0)), ni);
    const rec = new js_ast.ImportRecord(); rec.SourceIndex = 1; rec.Kind = ast.ImportKind.ImportStmt; r1.AST.ImportRecords = [rec];
    r1.Meta.ResolvedExports.set("a", exportData(1, 0, 1)); r1.AST.ExportsKind = js_ast.ExportsKind.ExportsESM;
    r1.AST.ExportKeyword = new Range(exLoc(0), 6);
    const { result, reExports } = matchImportWithExport(c, { sourceIndex: 1, nameLoc: 0, importRef: ref(1, 0) }, []);
    return [result.kind, result.alias, result.namespaceRef.SourceIndex, result.namespaceRef.InnerIndex,
      result.sourceIndex, result.ref.SourceIndex, result.ref.InnerIndex, result.nameLoc,
      result.otherSourceIndex, result.otherNameLoc, reExports.length];
  }},
  { fn: "generateEntryPointTailJS", arg: { name: "esm-two" }, run: () => {
    const c = build(2); setSyms(c, 1, ["foo", "bar"]);
    const r = c.graph.Files[1].InputFile.Repr as JSRepr;
    r.AST.ExportsRef = ref(1, 0); r.Meta.SortedAndFilteredExportAliases = ["bar", "foo"];
    r.Meta.ResolvedExports.set("bar", exportData(1, 1, 1)); r.Meta.ResolvedExports.set("foo", exportData(1, 0, 1));
    const out = generateEntryPointTailJS(c, NewNoOpRenamer(c.graph.Symbols), ref(0, 0), ref(0, 1), 1);
    return Buffer.from(out.JS).toString("hex");
  }},
  { fn: "generateEntryPointTailJS", arg: { name: "esm-default" }, run: () => {
    const c = build(2); setSyms(c, 1, ["default_x"]);
    const r = c.graph.Files[1].InputFile.Repr as JSRepr;
    r.AST.ExportsRef = ref(1, 0); r.Meta.SortedAndFilteredExportAliases = ["default"];
    r.Meta.ResolvedExports.set("default", exportData(1, 0, 1));
    const out = generateEntryPointTailJS(c, NewNoOpRenamer(c.graph.Symbols), ref(0, 0), ref(0, 1), 1);
    return Buffer.from(out.JS).toString("hex");
  }},
  { fn: "generateEntryPointTailJS", arg: { name: "esm-empty" }, run: () => {
    const c = build(2); setSyms(c, 1, ["x"]);
    const out = generateEntryPointTailJS(c, NewNoOpRenamer(c.graph.Symbols), ref(0, 0), ref(0, 1), 1);
    return Buffer.from(out.JS).toString("hex");
  }},
  { fn: "generateExtraDataForFileJS", arg: { name: "debug-off" }, run: () => {
    const c = build(2); return generateExtraDataForFileJS(c, 1);
  }},
  { fn: "generateCodeForFileInChunkJS", arg: { name: "no-wrap" }, run: () => {
    const c = build(2); setSyms(c, 1, ["foo"]);
    const repr = c.graph.Files[1].InputFile.Repr as JSRepr;
    const local = new js_ast.SLocal(); local.Kind = js_ast.LocalKind.LocalVar;
    const d = new js_ast.Decl(); const b = new js_ast.Binding(); b.Data = new js_ast.BIdentifier(ref(1, 0)); d.Binding = b;
    d.ValueOrNil = new js_ast.Expr(new js_ast.ENumber(1)); local.Decls = [d];
    const part = new js_ast.Part(); part.IsLive = true; part.Stmts = [new js_ast.Stmt(local)];
    const ds = new js_ast.DeclaredSymbol(); ds.Ref = ref(1, 0); ds.IsTopLevel = true; part.DeclaredSymbols = [ds];
    repr.AST.Parts = [part]; repr.Meta.Wrap = 0;
    const res = { JS: new Uint8Array() };
    generateCodeForFileInChunkJS(c, NewNoOpRenamer(c.graph.Symbols), { done: () => {} },
      { sourceIndex: 1, partIndexBegin: 0, partIndexEnd: 1 }, ref(0,0), ref(0,1), ref(0,0), res, new Array(2).fill(null));
    return Buffer.from(res.JS).toString("hex");
  }},
  { fn: "generateCodeForFileInChunkJS", arg: { name: "two-parts" }, run: () => {
    const c = build(2); setSyms(c, 1, ["foo", "bar"]);
    const repr = c.graph.Files[1].InputFile.Repr as JSRepr;
    const mkPart = (ri: number, val: number) => {
      const local = new js_ast.SLocal(); local.Kind = js_ast.LocalKind.LocalVar;
      const d = new js_ast.Decl(); const b = new js_ast.Binding(); b.Data = new js_ast.BIdentifier(ref(1, ri)); d.Binding = b;
      d.ValueOrNil = new js_ast.Expr(new js_ast.ENumber(val)); local.Decls = [d];
      const part = new js_ast.Part(); part.IsLive = true; part.Stmts = [new js_ast.Stmt(local)];
      const ds = new js_ast.DeclaredSymbol(); ds.Ref = ref(1, ri); ds.IsTopLevel = true; part.DeclaredSymbols = [ds];
      return part;
    };
    repr.AST.Parts = [mkPart(0, 1), mkPart(1, 2)]; repr.Meta.Wrap = 0;
    const res = { JS: new Uint8Array() };
    generateCodeForFileInChunkJS(c, NewNoOpRenamer(c.graph.Symbols), { done: () => {} },
      { sourceIndex: 1, partIndexBegin: 0, partIndexEnd: 2 }, ref(0,0), ref(0,1), ref(0,0), res, new Array(2).fill(null));
    return Buffer.from(res.JS).toString("hex");
  }},
];

test("lnkexport2 fixture sha256 + 12 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(dec.decode(bytes));
  assert.equal(rows.length, ROWS.length);
  for (let i = 0; i < rows.length; i++) {
    assert.equal(ROWS[i].fn, rows[i].fn);
    assert.deepEqual(ROWS[i].arg, rows[i].arg, `arg@${i}`);
    assert.deepEqual(ROWS[i].run(), rows[i].out, `${JSON.stringify(rows[i].arg)} mismatch`);
  }
});
