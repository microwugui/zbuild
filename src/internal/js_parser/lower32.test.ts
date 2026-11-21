// 第 32 轮：couldPotentiallyThrow —— Go 实测（js_parser_lower.go:1886 的 switch 分支语义）。
// 纯 AST 类型判断：字面量/函数/箭头不会抛，其余都会。
import test from "node:test";
import assert from "node:assert/strict";
import * as js_ast from "../js_ast/js_ast.ts";
import { Loc } from "../logger/logger.ts";
import { couldPotentiallyThrow } from "./js_parser_lower.ts";

const expr = (data: js_ast.E): js_ast.Expr => new js_ast.Expr(data, new Loc(0));

test("couldPotentiallyThrow：字面量/函数/箭头不抛，其余会抛", () => {
  const harmless: js_ast.E[] = [
    new js_ast.ENull(), new js_ast.EUndefined(), new js_ast.EBoolean(true),
    new js_ast.ENumber(1), new js_ast.EBigInt("1"), new js_ast.EString(),
    new js_ast.EFunction(), new js_ast.EArrow(),
  ];
  for (const e of harmless) {
    assert.equal(couldPotentiallyThrow(e), false, `couldPotentiallyThrow(${e.constructor.name})`);
  }
  // 会抛/可能有副作用的类型
  const harmful: js_ast.E[] = [
    new js_ast.ECall(), new js_ast.EIdentifier(), new js_ast.EBinary(),
    new js_ast.EDot(), new js_ast.EIndex(), new js_ast.EObject(), new js_ast.EArray(),
  ];
  for (const e of harmful) {
    assert.equal(couldPotentiallyThrow(e), true, `couldPotentiallyThrow(${e.constructor.name})`);
  }
  assert.equal(couldPotentiallyThrow(null), true);
  void expr; // 保留构造 helper 供后续扩展
});
