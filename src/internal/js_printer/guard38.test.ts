// 第 38 轮：guardAgainstBehaviorChangeDueToSubstitution / isUnboundIdentifier /
// isIdentifierOrNumericConstantOrPropertyAccess —— ② comma-target 语义保护的 printer 侧真函数（Go js_printer.go:1725/1857/1862）。
import test from "node:test";
import assert from "node:assert/strict";
import * as js_ast from "../js_ast/js_ast.ts";
import * as ast from "../ast/ast.ts";
import { printer, printExprFlags, Options } from "./js_printer.ts";
import { Loc } from "../logger/logger.ts";

function mkPrinter(symbols: ast.Symbol[]): printer {
  const ren = { NameForSymbol(r: { InnerIndex: number }) { return symbols[r.InnerIndex]?.OriginalName ?? ""; } };
  return new printer(symbols, ren, new Options());
}
test("guardAgainst: isDeleteTarget 包裹非逗号表达式，逗号表达式不裹", () => {
  const p = mkPrinter([new ast.Symbol()]);
  const id = new js_ast.Expr(new js_ast.EIdentifier(new ast.Ref(0, 0)), new Loc(1));
  const wrapped = p.guardAgainstBehaviorChangeDueToSubstitution(id, printExprFlags.isDeleteTarget);
  assert.ok(wrapped.Data instanceof js_ast.EBinary);
  assert.equal((wrapped.Data as js_ast.EBinary).Op, js_ast.OpCode.BinOpComma);
  // 已是逗号表达式则不包裹
  const comma = new js_ast.EBinary();
  comma.Op = js_ast.OpCode.BinOpComma;
  const ce = new js_ast.Expr(comma, new Loc(1));
  const notWrapped = p.guardAgainstBehaviorChangeDueToSubstitution(ce, printExprFlags.isDeleteTarget);
  assert.equal(notWrapped, ce);
});

test("guardAgainst: isCallTargetOrTemplateTag 包裹属性访问目标", () => {
  const p = mkPrinter([new ast.Symbol()]);
  const dot = new js_ast.Expr(new js_ast.EDot(), new Loc(1));
  const wrapped = p.guardAgainstBehaviorChangeDueToSubstitution(dot, printExprFlags.isCallTargetOrTemplateTag);
  assert.ok(wrapped.Data instanceof js_ast.EBinary);
  assert.equal((wrapped.Data as js_ast.EBinary).Op, js_ast.OpCode.BinOpComma);
});

test("isUnboundIdentifier / isIdentifierOrNumericConstantOrPropertyAccess", () => {
  const sym = new ast.Symbol();
  sym.Kind = ast.SymbolKind.SymbolUnbound;
  sym.OriginalName = "x";
  const p = mkPrinter([sym]);
  const id = new js_ast.Expr(new js_ast.EIdentifier(new ast.Ref(0, 0)), new Loc(1));
  assert.equal(p.isUnboundIdentifier(id), true);
  assert.equal(p.isIdentifierOrNumericConstantOrPropertyAccess(id), true);
  const inf = new js_ast.Expr(new js_ast.ENumber(Infinity), new Loc(1));
  assert.equal(p.isIdentifierOrNumericConstantOrPropertyAccess(inf), true); // IsInf
  const num = new js_ast.Expr(new js_ast.ENumber(1), new Loc(1));
  assert.equal(p.isIdentifierOrNumericConstantOrPropertyAccess(num), false);
});
