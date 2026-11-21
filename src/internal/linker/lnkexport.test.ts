// 第 177 批：linker export/wrap 图遍历簇三函数，Go 探针 8 例逐字节固化。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as ast from "../ast/ast.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import * as graph from "../graph/graph.ts";
import { JSRepr, ExportData, ImportData, InputFile, EntryPoint } from "../graph/input.ts";
import { NewDeferLog, DeferLogKind, Loc } from "../logger/logger.ts";
import { linkerContext } from "./linker.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/lnkexport-go.json", import.meta.url)));
const SHA = "ca2d80ecab55a559b80654c4b410157ba77939be7e881fbed34243362dd935f4";

const ref = (s: number, i: number) => new ast.Ref(s, i);

// 与 Go 探针 leBuild 对齐：构造 n 文件图，kinds/exportStars/named/entryPoints
function build(n: number, kinds: number[], exportStars: number[][], named: string[][], entryPoints: number[] | null): linkerContext {
  const c = new linkerContext();
  const inputs: InputFile[] = [];
  for (let si = 0; si < n; si++) {
    const repr = new JSRepr();
    const syms: ast.Symbol[] = [new ast.Symbol()]; syms[0].OriginalName = "runtime";
    for (const nm of named[si]) { const s = new ast.Symbol(); s.OriginalName = nm; s.Kind = ast.SymbolKind.SymbolConst; syms.push(s); }
    repr.AST.Symbols = syms;
    repr.AST.ExportsKind = kinds[si];
    const records: js_ast.ImportRecord[] = [];
    const starIdx: number[] = [];
    for (const tgt of exportStars[si]) {
      const r = new js_ast.ImportRecord(); r.Kind = ast.ImportKind.ImportStmt;
      if (tgt >= 0) r.SourceIndex = tgt; else r.SourceIndex = undefined as any;
      records.push(r); starIdx.push(records.length - 1);
    }
    repr.AST.ImportRecords = records;
    repr.AST.ExportStarImportRecords = starIdx;
    const namedExports = new Map<string, js_ast.NamedExport>();
    named[si].forEach((nm, k) => { const ne = new js_ast.NamedExport(); ne.Ref = ref(si, k + 1); ne.AliasLoc = new Loc(k + 1); namedExports.set(nm, ne); });
    repr.AST.NamedExports = namedExports;
    repr.AST.ModuleScope = new js_ast.Scope();
    const inp = new InputFile(); inp.Repr = repr;
    inputs.push(inp);
  }
  const reachable = inputs.map((_, i) => i);
  const eps = (entryPoints ?? []).map((si, i) => { const ep = new EntryPoint(); ep.SourceIndex = si; ep.OutputPath = `e${i}.js`; return ep; });
  c.graph = graph.CloneLinkerGraph(inputs, reachable, eps, false);
  c.options = { OutputFormat: 3 /* FormatESModule */ };
  c.log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null);
  return c;
}
function wrapDump(c: linkerContext): any[] {
  return c.graph.Files.map((f) => [(f.InputFile.Repr as JSRepr).Meta.Wrap, (f.InputFile.Repr as JSRepr).Meta.DidWrapDependencies]);
}
function kindsDump(c: linkerContext): number[] {
  return c.graph.Files.map((f) => (f.InputFile.Repr as JSRepr).AST.ExportsKind);
}
function resolvedDump(c: linkerContext, si: number): any[] {
  const repr = c.graph.Files[si].InputFile.Repr as JSRepr;
  return [...repr.Meta.ResolvedExports.keys()].sort().map((k) => {
    const d = repr.Meta.ResolvedExports.get(k)!;
    return [k, d.Ref.SourceIndex, d.Ref.InnerIndex, d.SourceIndex, d.PotentiallyAmbiguousExportStarRefs.length];
  });
}

test("lnkexport fixture sha256 + 8 例逐字节等于 Go（linker export/wrap 簇）", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const a = r.arg;
    let c: linkerContext;
    let got: any;
    if (r.fn === "recursivelyWrapDependencies") {
      if (a.name === "cjs-dep") {
        c = build(3, [2, 2, 1], [[], [], []], [[], [], []], [1]);
        const f1 = c.graph.Files[1].InputFile.Repr as JSRepr;
        const rec = new js_ast.ImportRecord(); rec.Kind = ast.ImportKind.ImportStmt; rec.SourceIndex = 2;
        f1.AST.ImportRecords = [rec];
        c.recursivelyWrapDependencies(1);
      } else {
        c = build(2, [2, 2], [[], []], [[], []], [1]);
        c.recursivelyWrapDependencies(0);
      }
      got = wrapDump(c);
    } else if (r.fn === "hasDynamicExportsDueToExportStar") {
      if (a.name === "external-nonentry") {
        c = build(2, [2, 2], [[], [-1]], [[], []], null);
      } else if (a.name === "external-entry-keepesm") {
        c = build(2, [2, 2], [[], [-1]], [[], []], [1]);
        c.options.OutputFormat = 0; // FormatPreserve → KeepESM true
      } else if (a.name === "cjs-transitive") {
        c = build(3, [2, 2, 1], [[], [2], []], [[], [], []], [1]);
      } else {
        c = build(3, [2, 2, 2], [[], [2], [1]], [[], [], []], [1]);
      }
      const res = c.hasDynamicExportsDueToExportStar(1, new Set());
      got = [res, kindsDump(c)];
    } else if (r.fn === "addExportsForExportStar") {
      if (a.name === "chain") {
        c = build(4, [2, 2, 2, 2], [[], [2], [3], []], [[], [], [], ["x"]], [1]);
        const f1 = c.graph.Files[1].InputFile.Repr as JSRepr;
        c.addExportsForExportStar(f1.Meta.ResolvedExports, 1, []);
        got = resolvedDump(c, 1);
      } else {
        c = build(3, [2, 2, 1], [[], [2], []], [[], [], ["x"]], [1]);
        const f1 = c.graph.Files[1].InputFile.Repr as JSRepr;
        c.addExportsForExportStar(f1.Meta.ResolvedExports, 1, []);
        got = resolvedDump(c, 1);
      }
    } else throw new Error(`unknown fn ${r.fn}`);
    assert.deepEqual(got, r.out, `${r.fn}/${a.name}\n got ${JSON.stringify(got)}\nwant ${JSON.stringify(r.out)}`);
  }
});
