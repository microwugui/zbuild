// 第 146 批：mergeAdjacentLocalStmts（Go 探针 8 例逐字节）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as js_ast from "../js_ast/js_ast.ts";
import { Loc } from "../logger/logger.ts";
import { mergeAdjacentLocalStmts } from "./linker.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/merge-stmts-go.json", import.meta.url)));
const SHA = "990fcf21bbf4e452ac5593f205cb5d13c4068513773531a0692b258a9c7fc765";
const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);
const mkLocal = (loc: number, kind: number, exp: boolean, n: number): js_ast.Stmt => {
  const d = new js_ast.SLocal(); d.Kind = kind; d.IsExport = exp;
  for (let i = 0; i < n; i++) d.Decls.push(new js_ast.Decl());
  const s = new js_ast.Stmt(); s.Loc = new Loc(loc); s.Data = d; return s;
};
const mkExpr = (loc: number): js_ast.Stmt => { const s = new js_ast.Stmt(); s.Loc = new Loc(loc); s.Data = new js_ast.SExpr(); return s; };
const dump = (stmts: js_ast.Stmt[]): any => stmts.map((s) => s.Data instanceof js_ast.SLocal
  ? ["local", s.Data.Kind, s.Data.IsExport, s.Data.Decls.length, s.Loc.Start]
  : s.Data instanceof js_ast.SExpr ? ["expr", s.Loc.Start] : ["other", s.Loc.Start]);

test("merge-stmts fixture sha256 + 8 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let stmts: js_ast.Stmt[];
    switch (r.arg.case) {
      case "empty": stmts = []; break;
      case "single": stmts = [mkLocal(1, 0, false, 1)]; break;
      case "two-var": stmts = [mkLocal(1, 0, false, 1), mkLocal(5, 0, false, 2)]; break;
      case "three-var": stmts = [mkLocal(1, 0, false, 1), mkLocal(5, 0, false, 2), mkLocal(9, 0, false, 3)]; break;
      case "diff-kind": stmts = [mkLocal(1, 0, false, 1), mkLocal(5, 2, false, 1)]; break;
      case "diff-export": stmts = [mkLocal(1, 0, false, 1), mkLocal(5, 0, true, 1)]; break;
      case "separated": stmts = [mkLocal(1, 0, false, 1), mkExpr(5), mkLocal(9, 0, false, 1)]; break;
      case "mixed": stmts = [mkExpr(0), mkLocal(1, 1, false, 1), mkLocal(5, 1, false, 1), mkExpr(9), mkLocal(11, 0, false, 1), mkLocal(15, 0, false, 1), mkLocal(19, 0, false, 1)]; break;
      default: throw new Error("unknown " + r.arg.case);
    }
    const got = dump(mergeAdjacentLocalStmts(stmts));
    assert.equal(JSON.stringify(canon(got)), JSON.stringify(canon(r.out)), r.arg.case + " => " + JSON.stringify(got));
  }
  assert.equal(rows.length, 8);
});
