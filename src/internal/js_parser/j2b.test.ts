// 第 37 轮：lowerClass 链中三个只能直调覆盖的纯函数（Parse 主链在 M1 不触发装饰器/多 super）。
import test from "node:test";
import assert from "node:assert/strict";
import * as js_ast from "../js_ast/js_ast.ts";
import * as ast from "../ast/ast.ts";
import { Loc } from "../logger/logger.ts";
import { propertyNameHint, fieldOrAccessorOrder, findFirstTopLevelSuperCall } from "./js_parser_lower_class.ts";
import { parser } from "./js_parser.ts";

test("propertyNameHint: EString/EIdentifier/EPrivateIdentifier/其它", () => {
  const p = Object.create(parser.prototype) as parser;
  (p as any).symbols = [
    { OriginalName: "foo" }, { OriginalName: "#bar" }, { OriginalName: "baz" },
  ];
  const s = new js_ast.Expr(new js_ast.EString(new Uint16Array([0x78])), new Loc(0)); // "x"
  assert.equal(propertyNameHint(p, s), "x");
  const id = new js_ast.Expr(new js_ast.EIdentifier(new ast.Ref(0, 0)), new Loc(0));
  assert.equal(propertyNameHint(p, id), "foo");
  const priv = new js_ast.Expr(new js_ast.EPrivateIdentifier(new ast.Ref(0, 1)), new Loc(0));
  assert.equal(propertyNameHint(p, priv), "bar");
  assert.equal(propertyNameHint(p, new js_ast.Expr(new js_ast.ENumber(1), new Loc(0))), "");
});

test("fieldOrAccessorOrder: auto-accessor/field × static/instance + 非字段", () => {
  const P = js_ast.PropertyFlags;
  const K = js_ast.PropertyKind;
  assert.deepEqual(fieldOrAccessorOrder(K.PropertyAutoAccessor, P.PropertyIsStatic), [0, true]);
  assert.deepEqual(fieldOrAccessorOrder(K.PropertyAutoAccessor, 0), [1, true]);
  assert.deepEqual(fieldOrAccessorOrder(K.PropertyField, P.PropertyIsStatic), [2, true]);
  assert.deepEqual(fieldOrAccessorOrder(K.PropertyField, 0), [3, true]);
  assert.deepEqual(fieldOrAccessorOrder(K.PropertyMethod, 0), [0, false]);
});

test("findFirstTopLevelSuperCall: 直接 super() 与逗号链", () => {
  const superRef = new ast.Ref(0, 5);
  const call = new js_ast.ECall();
  call.Target = new js_ast.Expr(new js_ast.EIdentifier(superRef), new Loc(1));
  const expr = new js_ast.Expr(call, new Loc(1));
  const [before, loc, c, after] = findFirstTopLevelSuperCall(expr, superRef);
  assert.ok(c !== null);
  assert.equal(loc.Start, 1);
  assert.equal(before.Data, null);
  assert.equal(after.Data, null);
  assert.equal(call.Target.Data, js_ast.ESuperShared); // 换回 super
  // 非 super 调用返回 null
  const otherCall = new js_ast.ECall();
  otherCall.Target = new js_ast.Expr(new js_ast.EIdentifier(new ast.Ref(0, 9)), new Loc(2));
  const [, , c2] = findFirstTopLevelSuperCall(new js_ast.Expr(otherCall, new Loc(2)), superRef);
  assert.equal(c2, null);
});
