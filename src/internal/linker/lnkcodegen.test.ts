// 第 179 批：createWrapperForFile / generateCodeForLazyExport，Go 探针 6 例逐字节固化。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as ast from "../ast/ast.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import * as graph from "../graph/graph.ts";
import { JSRepr, InputFile, EntryPoint } from "../graph/input.ts";
import { StringToUTF16 } from "../helpers/utf.ts";
import { NewDeferLog, DeferLogKind } from "../logger/logger.ts";
import { linkerContext } from "./linker.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/lnkcodegen-go.json", import.meta.url)));
const SHA = "32ee904d9451348f320614cc75ca2be26a8db9b1af68bd0f0f6eef23f4667c55";

function build(n: number): linkerContext {
  const c = new linkerContext();
  const inputs: InputFile[] = [];
  for (let si = 0; si < n; si++) {
    const f = new InputFile(); f.Source.IdentifierName = `f${si}`; inputs.push(f);
  }
  const reachable = inputs.map((_, i) => i);
  c.graph = graph.CloneLinkerGraph(inputs, reachable, [], false);
  for (let si = 0; si < n; si++) {
    const repr = new JSRepr();
    repr.AST.ModuleScope = new js_ast.Scope();
    repr.AST.Parts = [];
    repr.AST.Symbols = [new ast.Symbol()]; repr.AST.Symbols[0].OriginalName = "sym";
    const r0 = new ast.Ref(si, 0);
    repr.AST.ExportsRef = r0; repr.AST.ModuleRef = r0; repr.AST.WrapperRef = r0;
    c.graph.Files[si].InputFile.Repr = repr;
  }
  c.graph.Symbols.SymbolsForSource[0] = [(() => { const s = new ast.Symbol(); s.OriginalName = "runtime"; s.Link = ast.InvalidRef; return s; })()];
  c.cjsRuntimeRef = new ast.Ref(0, 0); c.esmRuntimeRef = new ast.Ref(0, 0);
  c.options = { OutputFormat: 3 };
  c.log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null);
  return c;
}
function dumpParts(c: linkerContext, si: number): any[] {
  const repr = c.graph.Files[si].InputFile.Repr as JSRepr;
  return repr.AST.Parts.map((p) => {
    const decls = p.DeclaredSymbols.map((d) => `${d.Ref.SourceIndex}:${d.Ref.InnerIndex}`);
    const deps = p.Dependencies.map((d) => `${d.SourceIndex}:${d.PartIndex}`);
    const kinds = p.Stmts.map((s) => `*js_ast.${s.Data?.constructor.name}`);
    return [decls, deps, kinds, p.CanBeRemovedIfUnused];
  });
}
function lazyPart(value: js_ast.Expr): js_ast.Part {
  const p = new js_ast.Part();
  const sl = new js_ast.SLazyExport(); sl.Value = value;
  p.Stmts = [new js_ast.Stmt(sl)];
  return p;
}

test("lnkcodegen fixture sha256 + 6 例逐字节等于 Go（createWrapperForFile/generateCodeForLazyExport）", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const a = r.arg;
    let got: any;
    if (r.fn === "createWrapperForFile") {
      const c = build(2);
      const repr = c.graph.Files[1].InputFile.Repr as JSRepr;
      repr.Meta.Wrap = a.name === "cjs" ? 1 : a.name === "esm" ? 2 : 0;
      const rt = c.graph.Files[0].InputFile.Repr as JSRepr;
      rt.Meta.TopLevelSymbolToPartsOverlay.set("0:0", [0]);
      c.createWrapperForFile(1);
      got = [repr.Meta.WrapperPartIndex.GetIndex(), dumpParts(c, 1)];
    } else if (r.fn === "generateCodeForLazyExport") {
      const c = build(2);
      const repr = c.graph.Files[1].InputFile.Repr as JSRepr;
      if (a.name === "cjs") {
        repr.AST.ExportsKind = js_ast.ExportsKind.ExportsCommonJS;
        const num = new js_ast.ENumber(); num.Value = 42;
        repr.AST.Parts = [lazyPart(new js_ast.Expr(num))];
        c.generateCodeForLazyExport(1);
        got = dumpParts(c, 1);
      } else {
        repr.AST.ExportsKind = js_ast.ExportsKind.ExportsESM;
        if (a.name === "esm-object") {
          const obj = new js_ast.EObject();
          for (const [k, v] of [["foo", 1], ["default", 2]] as [string, number][]) {
            const p = new js_ast.Property();
            const es = new js_ast.EString(); es.Value = new Uint16Array(StringToUTF16(new TextEncoder().encode(k)));
            p.Key = new js_ast.Expr(es);
            const num = new js_ast.ENumber(); num.Value = v;
            p.ValueOrNil = new js_ast.Expr(num);
            obj.Properties.push(p);
          }
          repr.AST.Parts = [lazyPart(new js_ast.Expr(obj))];
        } else {
          const num = new js_ast.ENumber(); num.Value = 7;
          repr.AST.Parts = [lazyPart(new js_ast.Expr(num))];
        }
        c.generateCodeForLazyExport(1);
        const resolved = [...repr.Meta.ResolvedExports.keys()].sort();
        got = [dumpParts(c, 1), resolved];
      }
    } else throw new Error(`unknown fn ${r.fn}`);
    assert.deepEqual(got, r.out, `${r.fn}/${a.name}\n got ${JSON.stringify(got)}\nwant ${JSON.stringify(r.out)}`);
  }
});
