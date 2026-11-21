// 第 152 批：statement 转换底座（shouldRemoveImportExportStmt / convertStmtsForChunk），Go 探针 9 例逐字节。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as ast from "../ast/ast.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import { Loc } from "../logger/logger.ts";
import { InputFile, JSRepr } from "../graph/input.ts";
import { LinkerFile, LinkerGraph } from "../graph/graph.ts";
import { NewSymbolMap } from "../ast/ast.ts";
import { linkerContext, stmtList, shouldRemoveImportExportStmt, convertStmtsForChunk } from "./linker.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/stmt-convert-go.json", import.meta.url)));
const SHA = "3c87665d560ec3bc9ed18f3b7496b78e64ab9684432e5f6ceae058993ebbd462";
const ref = (s: number, i: number): ast.Ref => new ast.Ref(s, i);

function exprDump(e: js_ast.Expr): any {
  const d: any = e.Data;
  if (d instanceof js_ast.ERequireString) return ["require", d.ImportRecordIndex];
  if (d instanceof js_ast.EIdentifier) return ["id", d.Ref.SourceIndex, d.Ref.InnerIndex];
  if (d instanceof js_ast.EDot) return ["dot", exprDump(d.Target), d.Name];
  if (d instanceof js_ast.ECall) return ["call", exprDump(d.Target), d.Args.map(exprDump)];
  if (d instanceof js_ast.EAwait) return ["await", exprDump(d.Value)];
  return ["expr"];
}
function stmtDump(s: js_ast.Stmt): any {
  const d: any = s.Data;
  if (d instanceof js_ast.SImport) {
    const items = d.Items !== null ? d.Items.map((it: any) => [it.OriginalName, it.Alias]) : [];
    return ["import", d.NamespaceRef.SourceIndex, d.NamespaceRef.InnerIndex, d.ImportRecordIndex, items];
  }
  if (d instanceof js_ast.SExportStar) {
    const alias = d.Alias !== null ? [d.Alias.OriginalName, d.Alias.Loc.Start] : null;
    return ["exportStar", alias, d.NamespaceRef.SourceIndex, d.NamespaceRef.InnerIndex, d.ImportRecordIndex];
  }
  if (d instanceof js_ast.SExportFrom) {
    const items = d.Items.map((it: any) => [it.OriginalName, it.Alias]);
    return ["exportFrom", items, d.NamespaceRef.SourceIndex, d.NamespaceRef.InnerIndex, d.IsSingleLine];
  }
  if (d instanceof js_ast.SExportClause) return ["exportClause", d.Items.map((it: any) => [it.Alias])];
  if (d instanceof js_ast.SFunction) {
    const name = d.Fn.Name !== null ? `${d.Fn.Name.Ref.SourceIndex}:${d.Fn.Name.Ref.InnerIndex}` : null;
    return ["function", name, d.IsExport];
  }
  if (d instanceof js_ast.SClass) {
    const name = d.Class.Name !== null ? `${d.Class.Name.Ref.SourceIndex}:${d.Class.Name.Ref.InnerIndex}` : null;
    return ["class", name, d.IsExport];
  }
  if (d instanceof js_ast.SLocal) return ["local", d.Kind, d.IsExport, d.Decls.map((dc: any) => exprDump(dc.ValueOrNil))];
  if (d instanceof js_ast.SExportDefault) return ["exportDefault", `${d.DefaultName.Ref.SourceIndex}:${d.DefaultName.Ref.InnerIndex}`, stmtDump(d.Value)];
  if (d instanceof js_ast.SExpr) return ["expr", exprDump(d.Value)];
  return ["other"];
}
function dumpList(l: stmtList): any {
  return { prefix: l.insideWrapperPrefix.map(stmtDump), suffix: l.insideWrapperSuffix.map(stmtDump), outside: l.outsideWrapperPrefix.map(stmtDump) };
}

interface Spec { wrap: number; isEntry?: boolean; outputFormat: number; mode: number; otherWrap: number; otherLive?: boolean; otherExportsKind?: number; external?: boolean; }
function build(spec: Spec): linkerContext {
  const c = new linkerContext();
  c.graph = new LinkerGraph();
  c.graph.Files = [new LinkerFile(), new LinkerFile(), new LinkerFile()];
  const rt = new JSRepr(); rt.AST.ModuleScope = new js_ast.Scope();
  const re = new js_ast.ScopeMember(); re.Ref = ref(0, 100); rt.AST.ModuleScope.Members.set("__reExport", re);
  c.graph.Files[0].InputFile.Repr = rt;
  const repr = new JSRepr();
  repr.AST.ExportsRef = ref(1, 9); repr.AST.ModuleScope = new js_ast.Scope(); repr.AST.ExportsKind = js_ast.ExportsKind.ExportsESM;
  repr.Meta.Wrap = spec.wrap;
  c.graph.Files[1].InputFile.Repr = repr;
  c.unboundModuleRef = ref(0, 50);
  c.options = { Mode: spec.mode, OutputFormat: spec.outputFormat, UnsupportedJSFeatures: 0 };
  const rec = new js_ast.ImportRecord(); rec.Kind = ast.ImportKind.ImportStmt; rec.Flags = ast.ImportRecordFlags.CallsRunTimeReExportFn;
  rec.SourceIndex = spec.external ? (undefined as any) : 2;
  repr.AST.ImportRecords = [rec];
  const other = new JSRepr();
  other.AST.ExportsRef = ref(2, 8); other.AST.WrapperRef = ref(2, 7); other.AST.ModuleScope = new js_ast.Scope();
  other.AST.ExportsKind = spec.otherExportsKind ?? js_ast.ExportsKind.ExportsNone;
  other.Meta.Wrap = spec.otherWrap;
  c.graph.Files[2].InputFile.Repr = other;
  c.graph.Files[2].IsLive = !!spec.otherLive;
  return c;
}
function stmt(loc: number, data: js_ast.S): js_ast.Stmt { const s = new js_ast.Stmt(); s.Loc = new Loc(loc); s.Data = data; return s; }

const ROWS: { fn: string; arg: any; run: () => any }[] = [];
for (const wrap of [0, 1, 2]) {
  for (const external of [false, true]) {
    ROWS.push({ fn: "shouldRemoveImportExportStmt", arg: { external, wrap }, run: () => {
      const c = build({ wrap, otherWrap: 1, otherLive: true, external, outputFormat: 3 /* ESM */, mode: 2 /* bundle */ });
      const list = new stmtList();
      const removed = shouldRemoveImportExportStmt(c, 1, list, 5, ref(1, 3), 0);
      return { removed, list: dumpList(list) };
    }});
  }
}
ROWS.push({ fn: "convertStmtsForChunk", arg: { scenario: "stripExports" }, run: () => {
  const c = build({ wrap: 0, outputFormat: 3, mode: 2, otherWrap: 0, otherLive: true, external: true });
  const fn = new js_ast.SFunction(); fn.Fn = new js_ast.Fn(); fn.Fn.Name = new ast.LocRef(new Loc(0), ref(1, 10)); fn.IsExport = true;
  const local = new js_ast.SLocal(); local.IsExport = true; local.Kind = js_ast.LocalKind.LocalConst;
  const list = new stmtList();
  convertStmtsForChunk(c, 1, list, [stmt(1, fn), stmt(2, local)]);
  return dumpList(list);
}});
ROWS.push({ fn: "convertStmtsForChunk", arg: { scenario: "esmWrap" }, run: () => {
  const c = build({ wrap: 2, outputFormat: 3, mode: 2, otherWrap: 0, otherLive: true, external: true });
  const imp = new js_ast.SImport(); imp.NamespaceRef = ref(1, 3); imp.ImportRecordIndex = 0;
  const ec = new js_ast.SExportClause(); const it = new js_ast.ClauseItem(); it.Alias = "x"; ec.Items = [it];
  const list = new stmtList();
  convertStmtsForChunk(c, 1, list, [stmt(3, imp), stmt(4, ec)]);
  return dumpList(list);
}});
ROWS.push({ fn: "convertStmtsForChunk", arg: { scenario: "exportDefault" }, run: () => {
  const c = build({ wrap: 0, outputFormat: 3, mode: 2, otherWrap: 0, external: true });
  const ed = new js_ast.SExportDefault(); ed.DefaultName = new ast.LocRef(new Loc(0), ref(1, 20));
  const se = new js_ast.SExpr(); const id = new js_ast.EIdentifier(); id.Ref = ref(1, 21);
  const ve = new js_ast.Expr(); ve.Data = id; se.Value = ve;
  ed.Value = new js_ast.Stmt(); ed.Value.Data = se;
  const list = new stmtList();
  convertStmtsForChunk(c, 1, list, [stmt(5, ed)]);
  return dumpList(list);
}});

test("stmt-convert fixture sha256 + 9 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  assert.equal(rows.length, ROWS.length);
  for (let i = 0; i < rows.length; i++) {
    assert.equal(ROWS[i].fn, rows[i].fn);
    assert.deepEqual(ROWS[i].arg, rows[i].arg, `arg@${i}`);
    assert.deepEqual(ROWS[i].run(), rows[i].out, `${rows[i].fn} ${JSON.stringify(rows[i].arg)} mismatch`);
  }
});
