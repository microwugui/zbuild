// 第 109 批：js_printer.simplifyUnusedExpr / lateConstantFoldUnaryOrBinaryOrIfExpr
// 直接 AST→AST 逐字节等于 Go（8 场景）。Go 期望来自 tools/go/tmpgen_minfold_test.go。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { printer, Options } from "./js_printer.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import { Ref, Symbol, InvalidRef, SymbolFlags } from "../ast/ast.ts";
import { ConstValue, ConstValueKind } from "../js_ast/js_ast.ts";
import { init } from "../helpers/init.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/min-fold-go.json", import.meta.url)));
const SHA = "e64462d1d80ee9931dad1a34c20dadb60d9db7a37cf09cf8b7c2ba72ace8a49e";
const rows = JSON.parse(new TextDecoder().decode(raw)) as { name: string; out: any }[];

function makePrinter(): { p: printer; ren: any } {
  const syms: Symbol[] = [];
  const mk = (name: string, flags: number) => {
    const s = new Symbol();
    s.OriginalName = name;
    s.Link = new Ref(InvalidRef.SourceIndex, InvalidRef.InnerIndex);
    s.Flags = flags;
    syms.push(s);
  };
  mk("emptyFn", SymbolFlags.IsEmptyFunction);
  mk("identity", SymbolFlags.IsIdentityFunction);
  mk("mutated", SymbolFlags.IsEmptyFunction | SymbolFlags.CouldPotentiallyBeMutated);
  mk("plain", 0);
  const ren = { NameForSymbol(ref: Ref) { return syms[ref.InnerIndex]?.OriginalName ?? ""; } };
  const opts = new Options();
  opts.MinifySyntax = true;
  const cv = new ConstValue();
  cv.Kind = ConstValueKind.ConstValueNumber;
  cv.Number = 42;
  opts.ConstValues.set("3", cv);
  return { p: new printer(syms, ren as any, opts), ren };
}

const id = (i: number): js_ast.Expr => new js_ast.Expr(new js_ast.EIdentifier(new Ref(0, i)));
const impid = (i: number): js_ast.Expr => new js_ast.Expr(new js_ast.EImportIdentifier(new Ref(0, i)));
const num = (v: number): js_ast.Expr => new js_ast.Expr(new js_ast.ENumber(v));
const call = (target: js_ast.Expr, ...args: js_ast.Expr[]): js_ast.Expr =>
  new js_ast.Expr(init(new js_ast.ECall(), { Target: target, Args: args }));
const bin = (op: js_ast.OpCode, l: js_ast.Expr, r: js_ast.Expr): js_ast.Expr =>
  new js_ast.Expr(init(new js_ast.EBinary(), { Op: op, Left: l, Right: r }));
const un = (op: js_ast.OpCode, v: js_ast.Expr): js_ast.Expr =>
  new js_ast.Expr(init(new js_ast.EUnary(), { Op: op, Value: v }));
const O = js_ast.OpCode;

function dumpE(e: js_ast.Expr): any {
  const d = e.Data;
  if (d === null) return "nil";
  if (d instanceof js_ast.EIdentifier) return ["id", d.Ref.InnerIndex];
  if (d instanceof js_ast.EImportIdentifier) return ["impid", d.Ref.InnerIndex];
  if (d instanceof js_ast.ENumber) return ["num", d.Value];
  if (d instanceof js_ast.EString) return ["str", new TextDecoder().decode(d.Value)];
  if (d instanceof js_ast.EBoolean) return ["bool", d.Value];
  if (d instanceof js_ast.EUndefined) return "undef";
  if (d instanceof js_ast.ENull) return "null";
  if (d instanceof js_ast.EBinary) return ["bin", d.Op, dumpE(d.Left), dumpE(d.Right)];
  if (d instanceof js_ast.EUnary) return ["un", d.Op, dumpE(d.Value)];
  if (d instanceof js_ast.ECall) return ["call", dumpE(d.Target), ...d.Args.map(dumpE)];
  if (d instanceof js_ast.EDot) return ["dot", dumpE(d.Target), d.Name];
  if (d instanceof js_ast.EArray) return ["arr", ...d.Items.map(dumpE)];
  if (d instanceof js_ast.EInlinedEnum) return ["inlineEnum", dumpE(d.Value), d.Comment];
  if (d instanceof js_ast.EIf) return ["if", dumpE(d.Test), dumpE(d.Yes), dumpE(d.No)];
  return "other";
}

function run(idx: number): any {
  const { p } = makePrinter();
  const C = js_ast.OpCode;
  switch (idx) {
    case 0: return dumpE(p.simplifyUnusedExpr(bin(C.BinOpComma, call(id(0)), num(5))));
    case 1: return dumpE(p.simplifyUnusedExpr(call(id(1), id(3))));
    case 2: return dumpE(p.simplifyUnusedExpr(call(id(2), id(3))));
    case 3: return dumpE(p.simplifyUnusedExpr(bin(C.BinOpComma, bin(C.BinOpComma, num(0), num(1)), call(id(3)))));
    case 4: return dumpE(p.lateConstantFoldUnaryOrBinaryOrIfExpr(un(C.UnOpNeg, impid(3))));
    case 5: return dumpE(p.lateConstantFoldUnaryOrBinaryOrIfExpr(bin(C.BinOpAdd, impid(3), num(1))));
    case 6: return dumpE(p.lateConstantFoldUnaryOrBinaryOrIfExpr(new js_ast.Expr(init(new js_ast.EIf(), { Test: impid(3), Yes: num(1), No: num(2) }))));
    case 7: return dumpE(p.lateConstantFoldUnaryOrBinaryOrIfExpr(impid(3)));
  }
  throw new Error("bad idx");
}

test("min-fold 夹具 sha256（8 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("simplifyUnusedExpr / lateConstantFold 逐字节等于 Go（8 场景）", () => {
  assert.equal(rows.length, 8);
  for (let i = 0; i < rows.length; i++) {
    assert.deepEqual(run(i), rows[i].out, `scenario ${i}: ${rows[i].name}`);
  }
});
