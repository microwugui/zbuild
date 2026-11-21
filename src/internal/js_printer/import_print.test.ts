// 第 111 批：import-record 底座 —— printRequireOrImportExpr / printImportCallAssertOrWith
// 逐字节等于 Go（6 场景，手工构造外部 import record + ERequireString/EImportString/ERequireResolveString）。
// Go 期望来自 tools/go/tmpgen_importprint_test.go。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Print, Options } from "./js_printer.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import * as ast from "../ast/ast.ts";
import { Range, Loc } from "../logger/logger.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/import-print-go.json", import.meta.url)));
const SHA = "c4b83e999c45492f59dcfe3e9e1063d2668b293bf661b53b570cdf0dee796b47";
const rows = JSON.parse(new TextDecoder().decode(raw)) as { name: string; out: string }[];

const u16 = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

function rec(kind: number, path: string, aow: ast.ImportAssertOrWith | null = null): js_ast.ImportRecord {
  const r = new js_ast.ImportRecord();
  r.Kind = kind;
  r.Path.Text = path;
  r.Range = new Range(new Loc(0), 4);
  r.AssertOrWith = aow;
  return r;
}
function aow(keyword: number, key: string, value: string): ast.ImportAssertOrWith {
  const a = new ast.ImportAssertOrWith();
  a.Keyword = keyword;
  a.Entries = [{ Key: u16(key), Value: u16(value), KeyLoc: new Loc(0), ValueLoc: new Loc(0), PreferQuotedKey: false }];
  return a;
}
function treeWith(expr: js_ast.Expr, records: js_ast.ImportRecord[]): js_ast.AST {
  const tree = new js_ast.AST();
  const se = new js_ast.SExpr();
  se.Value = expr;
  tree.Parts = [new js_ast.Part()];
  tree.Parts[0].Stmts = [new js_ast.Stmt(se, new Loc(0))];
  tree.ImportRecords = records;
  tree.ExprComments = new Map();
  return tree;
}
const nodeExpr = (data: js_ast.E): js_ast.Expr => new js_ast.Expr(data, new Loc(0));

function run(idx: number): string {
  const IK = ast.ImportKind;
  const AWK = ast.AssertOrWithKeyword;
  let tree: js_ast.AST;
  const opts = new Options();
  switch (idx) {
    case 0: {
      const e = new js_ast.ERequireString(); e.ImportRecordIndex = 0;
      tree = treeWith(nodeExpr(e), [rec(IK.ImportRequire, "foo")]);
      break;
    }
    case 1: {
      const e = new js_ast.ERequireResolveString(); e.ImportRecordIndex = 0;
      tree = treeWith(nodeExpr(e), [rec(IK.ImportRequireResolve, "foo")]);
      break;
    }
    case 2: {
      const e = new js_ast.EImportString(); e.ImportRecordIndex = 0;
      tree = treeWith(nodeExpr(e), [rec(IK.ImportDynamic, "bar")]);
      break;
    }
    case 3: {
      const e = new js_ast.EImportString(); e.ImportRecordIndex = 0;
      tree = treeWith(nodeExpr(e), [rec(IK.ImportDynamic, "bar", aow(AWK.WithKeyword, "type", "json"))]);
      break;
    }
    case 4: {
      const e = new js_ast.EImportString(); e.ImportRecordIndex = 0;
      tree = treeWith(nodeExpr(e), [rec(IK.ImportDynamic, "bar", aow(AWK.AssertKeyword, "type", "json"))]);
      break;
    }
    case 5: {
      const e = new js_ast.EImportString(); e.ImportRecordIndex = 0;
      tree = treeWith(nodeExpr(e), [rec(IK.ImportDynamic, "bar", aow(AWK.WithKeyword, "type", "json"))]);
      opts.UnsupportedFeatures = (1n << 31n) | (1n << 32n); // ImportAssertions | ImportAttributes
      break;
    }
    default: throw new Error("bad idx");
  }
  const ren = { NameForSymbol(_r: ast.Ref) { return "x"; } };
  const sym = new ast.Symbol();
  sym.OriginalName = "x";
  sym.Link = ast.InvalidRef;
  return new TextDecoder().decode(Print(tree, [sym], ren as any, opts).JS);
}

test("import-print 夹具 sha256（6 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("printRequireOrImportExpr / printImportCallAssertOrWith 逐字节等于 Go", () => {
  assert.equal(rows.length, 6);
  for (let i = 0; i < rows.length; i++) {
    const want = new TextDecoder().decode(Uint8Array.from(atob(rows[i].out), (c) => c.charCodeAt(0)));
    assert.equal(run(i), want, `scenario ${i}: ${rows[i].name}`);
  }
});
