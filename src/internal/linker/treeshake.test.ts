// 第 144 批：tree-shaking / code-splitting 簇（part 图遍历 / entry bit 传播），Go 探针 5 例逐字节。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as ast from "../ast/ast.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import { Source } from "../logger/logger.ts";
import { InputFile, EntryPoint, JSRepr } from "../graph/input.ts";
import { CloneLinkerGraph } from "../graph/graph.ts";
import { linkerContext } from "./linker_context.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/treeshake-go.json", import.meta.url)));
const SHA = "ad58cb6416d45a331b8511d949d65530cbbd1a0daf3658fc8ad909ab903b54df";
const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);

// side-effect kinds: 0=HasSideEffects, 2=NoSideEffects_EmptyAST
function buildCtx(specs: any[], entryIdx: number[], treeShaking: boolean, codeSplitting: boolean, ignoreDCE: boolean): linkerContext {
  const inputs: InputFile[] = specs.map((sp, si) => {
    const f = new InputFile(); const repr = new JSRepr();
    repr.AST.ModuleScope = new js_ast.Scope();
    repr.AST.ExportsRef = new ast.Ref(si, 0);
    for (const ps of sp.parts) {
      const p = new js_ast.Part(); p.CanBeRemovedIfUnused = !!ps.removable; p.ForceTreeShaking = !!ps.forceTree;
      for (const d of ps.deps || []) { const dep = new js_ast.Dependency(); dep.SourceIndex = d[0]; dep.PartIndex = d[1]; p.Dependencies.push(dep); }
      p.ImportRecordIndices = ps.importRecs || [];
      repr.AST.Parts.push(p);
    }
    for (let j = 0; j < (sp.imports || []).length; j++) {
      const rec: any = { Kind: sp.importKinds[j], SourceIndex: sp.imports[j] >= 0 ? sp.imports[j] : undefined };
      repr.AST.ImportRecords.push(rec);
    }
    if (sp.cssSource >= 0) repr.CSSSourceIndex = ast.MakeIndex32(sp.cssSource);
    f.Repr = repr; const src = new Source(); src.Contents = new TextEncoder().encode(""); f.Source = src;
    f.SideEffects.Kind = sp.sideEffects;
    return f;
  });
  const eps = entryIdx.map((si) => { const e = new EntryPoint(); e.SourceIndex = si; e.OutputPath = "e.js"; return e; });
  const reachable = specs.map((_, i) => i);
  const g = CloneLinkerGraph(inputs, reachable, eps, codeSplitting);
  const c = new linkerContext(); c.graph = g; c.options = { TreeShaking: treeShaking, CodeSplitting: codeSplitting, IgnoreDCEAnnotations: ignoreDCE };
  return c;
}
function dump(c: linkerContext): any {
  return c.graph.Files.map((f) => {
    const parts: boolean[] = [];
    if (f.InputFile.Repr instanceof JSRepr) for (const p of f.InputFile.Repr.AST.Parts) parts.push(p.IsLive);
    const bits: number[] = [];
    for (let b = 0; b < 4; b++) if (b / 8 < f.EntryBits.entries.length && f.EntryBits.HasBit(b)) bits.push(b);
    return { live: f.IsLive, dist: f.DistanceFromEntryPoint, bits, parts };
  });
}

test("treeshake fixture sha256 + 5 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const a = r.arg; let c: linkerContext;
    if (a.scenario === "A") {
      const specs = [
        { parts: [{ importRecs: [0] }, { removable: true }], imports: [1], importKinds: [ast.ImportKind.ImportStmt], sideEffects: 0 },
        { parts: [{}, { removable: true, deps: [[2, 0]] }], sideEffects: 0 },
        { parts: [{ removable: true }], sideEffects: 2 },
      ];
      c = buildCtx(specs, [0], a.treeShaking, false, false);
    } else if (a.scenario === "B") {
      const specs = [
        { parts: [{ importRecs: [0] }], imports: [2], importKinds: [ast.ImportKind.ImportStmt], sideEffects: 0 },
        { parts: [{ importRecs: [0] }], imports: [2], importKinds: [ast.ImportKind.ImportStmt], sideEffects: 0 },
        { parts: [{}], sideEffects: 0 },
      ];
      c = buildCtx(specs, [0, 1], true, a.codeSplit, false);
    } else {
      const specs = [
        { parts: [{ deps: [[1, 0]] }], sideEffects: 0 },
        { parts: [{ removable: true }], sideEffects: 0 },
      ];
      c = buildCtx(specs, [0], true, false, false);
    }
    if (r.fn === "treeShakingAndCodeSplitting") c.treeShakingAndCodeSplitting();
    else if (r.fn === "markPartLiveForTreeShaking") c.markPartLiveForTreeShaking(0, 0);
    else throw new Error("unknown " + r.fn);
    assert.equal(JSON.stringify(canon(dump(c))), JSON.stringify(canon(r.out)),
      `${r.fn} ${JSON.stringify(a)} => ${JSON.stringify(dump(c))} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 5);
});
