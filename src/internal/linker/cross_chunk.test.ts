// 第 148 批：交叉 chunk 依赖（computeCrossChunkDependencies + 2 sort helper），Go 探针 3 例逐字节。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as ast from "../ast/ast.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import { Source, Path } from "../logger/logger.ts";
import { InputFile, EntryPoint, JSRepr, refKey } from "../graph/input.ts";
import { CloneLinkerGraph } from "../graph/graph.ts";
import { MockFS, MockUnix } from "../fs/fs_mock.ts";
import { linkerContext } from "./linker.ts";
import { computeChunks, computeCrossChunkDependencies, chunkReprJS } from "./linker.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/cross-chunk-deps-go.json", import.meta.url)));
const SHA = "0353a26bdbaa1c4d0da6247830fddb91af97f1d9e41796f1073659c84abdd06e";

interface PartSpec { declared?: number[]; uses?: number[]; importRecs?: number[]; dynamicRecs?: number[]; }
interface FileSpec { path: string; parts: PartSpec[]; symbols: string[]; exports?: string[]; exportAliases?: string[]; forceExport?: boolean; }

function build(specs: FileSpec[], entries: number[], optsFn?: (o: any) => void): linkerContext {
  const inputs: InputFile[] = specs.map((sp, si) => {
    const f = new InputFile();
    const s = new Source(); s.KeyPath = new Path(); s.KeyPath.Text = sp.path; s.KeyPath.Namespace = "file"; s.Contents = new TextEncoder().encode(""); f.Source = s;
    f.SideEffects.Kind = 0;
    const syms = sp.symbols.map((n) => { const y = new ast.Symbol(); y.OriginalName = n; y.Link = ast.InvalidRef; y.Kind = ast.SymbolKind.SymbolConst; return y; });
    const records: any[] = [];
    const parts = sp.parts.map((ps) => {
      const p = new js_ast.Part(); p.SymbolUses = new Map();
      for (const d of ps.declared ?? []) { const ds = new js_ast.DeclaredSymbol(); ds.Ref = new ast.Ref(si, d); ds.IsTopLevel = true; p.DeclaredSymbols.push(ds); }
      for (const u of ps.uses ?? []) { const su = new js_ast.SymbolUse(); su.CountEstimate = 1; p.SymbolUses.set(refKey(new ast.Ref(si, u)), su); }
      for (const rec of ps.importRecs ?? []) { const r: any = new js_ast.ImportRecord(); r.Kind = ast.ImportKind.ImportStmt; r.SourceIndex = rec >= 0 ? rec : undefined; records.push(r); p.ImportRecordIndices.push(records.length - 1); }
      for (const rec of ps.dynamicRecs ?? []) { const r: any = new js_ast.ImportRecord(); r.Kind = ast.ImportKind.ImportDynamic; r.SourceIndex = rec >= 0 ? rec : undefined; records.push(r); p.ImportRecordIndices.push(records.length - 1); }
      return p;
    });
    const repr = new JSRepr();
    repr.AST.Symbols = syms; repr.AST.Parts = parts; repr.AST.ImportRecords = records;
    repr.AST.ModuleScope = new js_ast.Scope(); repr.AST.ExportsRef = new ast.Ref(si, 0);
    for (const e of sp.exports ?? []) { const ne = new js_ast.NamedExport(); ne.Ref = new ast.Ref(si, 0); repr.AST.NamedExports.set(e, ne); }
    repr.Meta.SortedAndFilteredExportAliases = sp.exportAliases ?? [];
    repr.Meta.ForceIncludeExportsForEntryPoint = !!sp.forceExport;
    f.Repr = repr;
    return f;
  });
  const eps = entries.map((si, i) => { const ep = new EntryPoint(); ep.SourceIndex = si; ep.OutputPath = `e${i}.js`; return ep; });
  const g = CloneLinkerGraph(inputs, specs.map((_, i) => i), eps, true);
  const c = new linkerContext();
  c.graph = g; c.fs = MockFS({}, MockUnix, "/"); c.uniqueKeyPrefix = "TEST";
  c.options = {
    CodeSplitting: true, TreeShaking: true, OutputFormat: 3 /* FormatESModule */,
    OutputExtensionJS: ".js", OutputExtensionCSS: ".css", AbsOutputBase: "/p",
    EntryPathTemplate: [{ Data: "./", Placeholder: 1 }, { Data: "/", Placeholder: 2 }],
    ChunkPathTemplate: [{ Data: "./", Placeholder: 2 }, { Data: "-", Placeholder: 3 }],
  };
  if (optsFn) optsFn(c.options);
  c.treeShakingAndCodeSplitting();
  computeChunks(c);
  return c;
}

function addUse(c: linkerContext, fileIdx: number, partIdx: number, srcIdx: number, innerIdx: number): void {
  const repr = c.graph.Files[fileIdx].InputFile.Repr as JSRepr;
  const su = new js_ast.SymbolUse(); su.CountEstimate = 1;
  repr.AST.Parts[partIdx].SymbolUses.set(refKey(new ast.Ref(srcIdx, innerIdx)), su);
}

function dump(c: linkerContext): any[] {
  const out: any[] = [];
  for (const ch of c.chunks) {
    const d: any = { key: ch.uniqueKey, crossImports: [], exports: {}, importGroups: [], prefix: [], suffix: [] };
    for (const ci of ch.crossChunkImports) d.crossImports.push({ kind: ci.importKind, chunkIndex: ci.chunkIndex });
    if (ch.chunkRepr instanceof chunkReprJS) {
      const r = ch.chunkRepr;
      for (const [k, alias] of r.exportsToOtherChunks) d.exports[k] = alias;
      for (const [ci, arr] of r.importsFromOtherChunks) {
        d.importGroups.push({ chunkIndex: ci, items: arr.entries.map((it: any) => ({ ref: [it.ref.SourceIndex, it.ref.InnerIndex], alias: it.exportAlias })).sort((a: any, b: any) => a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0) });
      }
      d.importGroups.sort((a: any, b: any) => a.chunkIndex - b.chunkIndex);
      d.prefix = dumpClauses(r.crossChunkPrefixStmts);
      d.suffix = dumpClauses(r.crossChunkSuffixStmts);
    }
    out.push(d);
  }
  return out;
}
function dumpClauses(stmts: js_ast.Stmt[]): any[] {
  const out: any[] = [];
  for (const st of stmts) {
    if (st.Data instanceof js_ast.SExportClause) {
      for (const it of st.Data.Items) out.push({ ref: [it.Name.Ref.SourceIndex, it.Name.Ref.InnerIndex], alias: it.Alias });
    } else if (st.Data instanceof js_ast.SImport && st.Data.Items !== null) {
      for (const it of st.Data.Items) out.push({ ref: [it.Name.Ref.SourceIndex, it.Name.Ref.InnerIndex], alias: it.Alias });
    }
  }
  return out;
}

const KEYS = ["A", "B", "C"];
const buildScenario = (key: string): linkerContext => {
  if (key === "A") {
    const c = build([
      { path: "/p/a.js", symbols: ["shared"], parts: [{ declared: [0] }], exports: ["shared"], exportAliases: ["shared"] },
      { path: "/p/b.js", symbols: ["b"], parts: [{}] },
    ], [0, 1]);
    addUse(c, 1, 0, 0, 0);
    computeCrossChunkDependencies(c);
    return c;
  }
  if (key === "B") {
    const c = build([
      { path: "/p/a.js", symbols: ["alpha", "beta"], parts: [{ declared: [0, 1] }], exports: ["alpha", "beta"], exportAliases: ["alpha", "beta"] },
      { path: "/p/b.js", symbols: ["b"], parts: [{}] },
    ], [0, 1], (o) => { o.MinifyIdentifiers = true; });
    addUse(c, 1, 0, 0, 0); addUse(c, 1, 0, 0, 1);
    computeCrossChunkDependencies(c);
    return c;
  }
  const c = build([
    { path: "/p/entry.js", symbols: ["e"], parts: [{ dynamicRecs: [1] }] },
    { path: "/p/dyn.js", symbols: ["d"], parts: [{}] },
  ], [0, 1]);
  computeCrossChunkDependencies(c);
  return c;
};

test("cross-chunk-deps fixture sha256 + 3 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  assert.equal(rows.length, 3);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const got = dump(buildScenario(KEYS[i]));
    assert.deepEqual(got, r.out, `scenario ${KEYS[i]} mismatch`);
  }
});
