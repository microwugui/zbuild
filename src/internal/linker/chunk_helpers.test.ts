// 第 145 批：chunk 助手 3 函数（Go 探针 7 例逐字节）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as ast from "../ast/ast.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import { Source } from "../logger/logger.ts";
import { NewDeferLog, DeferLogKind } from "../logger/logger.ts";
import { InputFile, EntryPoint, JSRepr } from "../graph/input.ts";
import { CloneLinkerGraph } from "../graph/graph.ts";
import { MockFS } from "../fs/fs_mock.ts";
import { linkerContext, findImportedCSSFilesInJSOrder, shouldIncludePart, pathBetweenChunks } from "./linker.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/chunk-helpers-go.json", import.meta.url)));
const SHA = "e21ce7dedec4f3f8f3faaa6c56558ec5662ed5570bb057acb7a02cf20c33fe44";
const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);

type Spec = { parts: number[][]; imports: number[]; cssSource: number };
function build(specs: Spec[], entry: number): linkerContext {
  const inputs = specs.map((sp) => {
    const f = new InputFile(); const repr = new JSRepr(); repr.AST.ModuleScope = new js_ast.Scope();
    for (const recs of sp.parts) { const p = new js_ast.Part(); p.ImportRecordIndices = recs.map((r) => r); repr.AST.Parts.push(p); }
    for (const imp of sp.imports) repr.AST.ImportRecords.push({ Kind: 1, SourceIndex: imp >= 0 ? imp : undefined } as any);
    if (sp.cssSource >= 0) repr.CSSSourceIndex = ast.MakeIndex32(sp.cssSource);
    f.Repr = repr; const src = new Source(); src.Contents = new TextEncoder().encode(""); f.Source = src;
    return f;
  });
  const g = CloneLinkerGraph(inputs, specs.map((_, i) => i), [{ SourceIndex: entry, OutputPath: "e.js" } as EntryPoint], false);
  const c = new linkerContext(); c.graph = g; c.options = {}; c.log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null);
  return c;
}
const SPECS: Spec[] = [
  { parts: [[0, 1]], imports: [1, 3], cssSource: 5 },
  { parts: [[0]], imports: [2], cssSource: 2 },
  { parts: [], imports: [], cssSource: -1 },
  { parts: [[0]], imports: [2], cssSource: 4 },
  { parts: [], imports: [], cssSource: -1 },
  { parts: [], imports: [], cssSource: -1 },
];

test("chunk-helpers fixture sha256 + 7 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const a = r.arg; let got: any;
    const c = build(SPECS, 0);
    if (r.fn === "findImportedCSSFilesInJSOrder") got = findImportedCSSFilesInJSOrder(c, a.entry);
    else if (r.fn === "shouldIncludePart") {
      const repr = c.graph.Files[0].InputFile.Repr as JSRepr;
      let part: js_ast.Part;
      if (a.case === "single-import") { part = new js_ast.Part(); const si = new js_ast.SImport(); si.ImportRecordIndex = 0; part.Stmts = [new js_ast.Stmt(si)]; }
      else if (a.case === "normal") { part = new js_ast.Part(); part.Stmts = [new js_ast.Stmt(new js_ast.SExpr())]; }
      else part = new js_ast.Part();
      got = shouldIncludePart(c, repr, part);
    } else if (r.fn === "pathBetweenChunks") {
      c.fs = MockFS(new Map(), 0, "/out"); c.options.PublicPath = a.public;
      got = pathBetweenChunks(c, a.from, a.to);
    } else throw new Error("unknown " + r.fn);
    assert.equal(JSON.stringify(canon(got)), JSON.stringify(canon(r.out)), `${r.fn} ${JSON.stringify(a)} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 7);
});
