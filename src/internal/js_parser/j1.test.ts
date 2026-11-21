// 第 34 轮 J-1：js_parser_lower_class.go:14-379 的 private/super lowering 14 个函数。
// Go 字节证据钉在 testdata/lower-j1-go.json（8 条 es2015 输出，包内探针产出）。
// 本测试逐函数直调，断言其产出的 AST 调用的 runtime helper 名与参数结构，
// 与 8 条 Go 字节里的 __privateGet/__privateMethod/__privateSet/__privateIn/__superGet 等逐一对上。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as js_ast from "../js_ast/js_ast.ts";
import { SymbolKind } from "../ast/ast.ts";
import { Loc, Log, Path, Source } from "../logger/logger.ts";
import { newParser, Options, type parser } from "./js_parser.ts";
import { Lexer } from "../js_lexer/js_lexer.ts";
import {
  privateSymbolNeedsToBeLowered, lowerPrivateBrandCheck, lowerPrivateGet, lowerPrivateSet,
  lowerPrivateSetUnOp, lowerPrivateSetBinOp, extractPrivateIndex, extractSuperProperty,
  lowerSuperPropertyOrPrivateInAssign, shouldLowerSuperPropertyAccess, callSuperPropertyWrapper,
  lowerSuperPropertyGet, lowerSuperPropertySet, lowerSuperPropertySetBinOp,
  maybeLowerSuperPropertyGetInsideCall,
} from "./js_parser_lower_class.ts";

const ES2015_BITS = 0x165fe46fc5c5ffb9n;

function makeParser(es2015 = true): parser {
  const log = new Log();
  const source = new Source();
  source.Index = 0;
  source.Contents = new Uint8Array(0);
  source.KeyPath = new Path();
  source.KeyPath.Text = "<stdin>";
  const options = new Options();
  if (es2015) options.unsupportedJSFeatures = ES2015_BITS;
  return newParser(log, source, Lexer.NewLexer(log, source, options.ts), options);
}

const L = (n = 0): Loc => new Loc(n);
const ex = (d: js_ast.E | null, n = 0): js_ast.Expr => new js_ast.Expr(d, L(n));

/** 新建一个私有标识符 + 指定 SymbolKind 的符号 */
function priv(p: parser, kind: SymbolKind, name = "#x"): js_ast.EPrivateIdentifier {
  const ref = p.newSymbol(kind, name);
  p.symbols[ref.InnerIndex].Kind = kind;
  return new js_ast.EPrivateIdentifier(ref);
}

/** 读取一个 Expr 的 runtime helper 名（ECall.Target 的 EIdentifier 的符号名） */
function runtimeName(p: parser, e: js_ast.Expr): string {
  const call = e.Data as js_ast.ECall;
  const ident = call.Target.Data as js_ast.EIdentifier;
  return p.symbols[ident.Ref.InnerIndex].OriginalName;
}

/** Go 字节证据：8 条 es2015 输出 */
const goBytes = JSON.parse(
  readFileSync(new URL("../../../testdata/lower-j1-go.json", import.meta.url), "utf8"),
) as { Name: string; JS: string }[];

function byName(n: string): string {
  const hit = goBytes.find((c) => c.Name === n);
  assert.ok(hit, `Go 字节证据缺少 ${n}`);
  return hit!.JS;
}

test("J-1 Go 字节证据：8 条 es2015 输出含预期 runtime helper", () => {
  assert.equal(goBytes.length, 8);
  assert.match(byName("private-field"), /__privateGet\(this, _x\)/);
  assert.match(byName("private-method"), /__privateMethod\(this, _A_instances, m_fn\)/);
  assert.match(byName("private-get-set"), /__privateSet\(this, _x, a\)/);
  assert.match(byName("private-in"), /__privateIn\(_x, o\)/);
  assert.match(byName("super-get"), /super\.foo/);
  assert.match(byName("super-call"), /super\.foo\(\)/);
});

test("J-1.14 privateSymbolNeedsToBeLowered：es2015 私有字段/方法需降级", () => {
  const p = makeParser();
  const field = priv(p, SymbolKind.SymbolPrivateField);
  const method = priv(p, SymbolKind.SymbolPrivateMethod);
  assert.equal(privateSymbolNeedsToBeLowered(p, field), true);
  assert.equal(privateSymbolNeedsToBeLowered(p, method), true);
  const plain = makeParser(false);
  const fieldPlain = priv(plain, SymbolKind.SymbolPrivateField);
  assert.equal(privateSymbolNeedsToBeLowered(plain, fieldPlain), false);
});

test("J-1.19 lowerPrivateBrandCheck → __privateIn(#x, target)", () => {
  const p = makeParser();
  const x = priv(p, SymbolKind.SymbolPrivateField);
  const target = ex(js_ast.EThisShared);
  const out = lowerPrivateBrandCheck(p, target, L(), x);
  assert.equal(runtimeName(p, out), "__privateIn");
  const args = (out.Data as js_ast.ECall).Args;
  assert.equal(args.length, 2);
  assert.ok(args[0].Data instanceof js_ast.EIdentifier);
  assert.equal((args[0].Data as js_ast.EIdentifier).Ref.InnerIndex, x.Ref.InnerIndex);
  assert.match(byName("private-in"), /__privateIn/);
});

test("J-1.27 lowerPrivateGet 三分支 → __privateGet / __privateMethod", () => {
  // 字段分支（默认）
  const p1 = makeParser();
  const field = priv(p1, SymbolKind.SymbolPrivateField);
  const out1 = lowerPrivateGet(p1, ex(js_ast.EThisShared), L(), field);
  assert.equal(runtimeName(p1, out1), "__privateGet");
  assert.equal((out1.Data as js_ast.ECall).Args.length, 2);

  // 方法分支（含 getter fn）
  const p2 = makeParser();
  const method = priv(p2, SymbolKind.SymbolPrivateMethod);
  const fnRef = p2.newSymbol(SymbolKind.SymbolOther, "m_fn");
  p2.privateGetters.set(method.Ref.SourceIndex + ":" + method.Ref.InnerIndex, fnRef);
  const out2 = lowerPrivateGet(p2, ex(js_ast.EThisShared), L(), method);
  assert.equal(runtimeName(p2, out2), "__privateMethod");
  assert.equal((out2.Data as js_ast.ECall).Args.length, 3);
  assert.match(byName("private-method"), /__privateMethod\(this, _A_instances, m_fn\)/);

  // getter/setter pair 分支
  const p3 = makeParser();
  const gs = priv(p3, SymbolKind.SymbolPrivateGetSetPair);
  const gRef = p3.newSymbol(SymbolKind.SymbolOther, "x_get");
  p3.privateGetters.set(gs.Ref.SourceIndex + ":" + gs.Ref.InnerIndex, gRef);
  const out3 = lowerPrivateGet(p3, ex(js_ast.EThisShared), L(), gs);
  assert.equal(runtimeName(p3, out3), "__privateGet");
  assert.equal((out3.Data as js_ast.ECall).Args.length, 3);
});

test("J-1.59 lowerPrivateSet → __privateSet（含/不含 setter fn）", () => {
  const p1 = makeParser();
  const field = priv(p1, SymbolKind.SymbolPrivateField);
  const out1 = lowerPrivateSet(p1, ex(js_ast.EThisShared), L(), field, ex(new js_ast.ENumber(1)));
  assert.equal(runtimeName(p1, out1), "__privateSet");
  assert.equal((out1.Data as js_ast.ECall).Args.length, 3);

  const p2 = makeParser();
  const setter = priv(p2, SymbolKind.SymbolPrivateSet);
  const sRef = p2.newSymbol(SymbolKind.SymbolOther, "x_set");
  p2.privateSetters.set(setter.Ref.SourceIndex + ":" + setter.Ref.InnerIndex, sRef);
  const out2 = lowerPrivateSet(p2, ex(js_ast.EThisShared), L(), setter, ex(new js_ast.EIdentifier(p2.newSymbol(SymbolKind.SymbolOther, "a"))));
  assert.equal(runtimeName(p2, out2), "__privateSet");
  assert.equal((out2.Data as js_ast.ECall).Args.length, 4);
  assert.match(byName("private-get-set"), /__privateSet\(this, _x, a\)/);
});

test("J-1.88 lowerPrivateSetUnOp → __privateWrapper(...)._ 的一元表达式", () => {
  const p = makeParser();
  const field = priv(p, SymbolKind.SymbolPrivateField);
  const out = lowerPrivateSetUnOp(p, ex(js_ast.EThisShared), L(), field, js_ast.OpCode.UnOpPostInc);
  const unary = out.Data as js_ast.EUnary;
  assert.equal(unary.Op, js_ast.OpCode.UnOpPostInc);
  const dot = unary.Value.Data as js_ast.EDot;
  assert.equal(dot.Name, "_");
  assert.equal(runtimeName(p, dot.Target), "__privateWrapper");
  assert.equal((dot.Target.Data as js_ast.ECall).Args.length, 2);
});

test("J-1.137 lowerPrivateSetBinOp → __privateSet(__privateGet(...)+v)", () => {
  const p = makeParser();
  const field = priv(p, SymbolKind.SymbolPrivateField);
  const out = lowerPrivateSetBinOp(p, ex(js_ast.EThisShared), L(), field, js_ast.OpCode.BinOpAdd, ex(new js_ast.ENumber(1)));
  const setCall = out.Data as js_ast.ECall;
  assert.equal(runtimeName(p, out), "__privateSet");
  const binary = setCall.Args[2].Data as js_ast.EBinary;
  assert.equal(binary.Op, js_ast.OpCode.BinOpAdd);
  assert.equal(runtimeName(p, binary.Left), "__privateGet");
});

test("J-1.149 extractPrivateIndex 命中/未命中", () => {
  const p = makeParser();
  const field = priv(p, SymbolKind.SymbolPrivateField);
  const index = ex(field);
  const target = ex(js_ast.EThisShared);
  const eIndex = ex(new js_ast.EIndex());
  (eIndex.Data as js_ast.EIndex).Target = target;
  (eIndex.Data as js_ast.EIndex).Index = index;
  const hit = extractPrivateIndex(p, eIndex);
  assert.ok(hit !== null);
  assert.ok(hit!.private === field);
  assert.equal(extractPrivateIndex(p, ex(js_ast.EThisShared)), null);
});

test("J-1.160/251 extractSuperProperty + shouldLowerSuperPropertyAccess", () => {
  const p = makeParser();
  const superExpr = ex(js_ast.ESuperShared);
  const dot = ex(new js_ast.EDot());
  (dot.Data as js_ast.EDot).Target = superExpr;
  (dot.Data as js_ast.EDot).Name = "foo";
  assert.equal(shouldLowerSuperPropertyAccess(p, superExpr), false); // 默认未置位
  p.fnOrArrowDataVisit.shouldLowerSuperPropertyAccess = true;
  assert.equal(shouldLowerSuperPropertyAccess(p, superExpr), true);
  const key = extractSuperProperty(p, dot);
  assert.ok(key !== null);
  assert.deepEqual(Array.from((key!.Data as js_ast.EString).Value), Array.from(new TextEncoder().encode("foo")));
});

test("J-1.174 lowerSuperPropertyOrPrivateInAssign：解构里的 super.foo", () => {
  const p = makeParser();
  p.fnOrArrowDataVisit.shouldLowerSuperPropertyAccess = true;
  p.fnOnlyDataVisit.innerClassNameRef = p.newSymbol(SymbolKind.SymbolConst, "_B");
  const arr = ex(new js_ast.EArray());
  const dot = ex(new js_ast.EDot());
  (dot.Data as js_ast.EDot).Target = ex(js_ast.ESuperShared);
  (dot.Data as js_ast.EDot).Name = "foo";
  (arr.Data as js_ast.EArray).Items = [dot];
  const r = lowerSuperPropertyOrPrivateInAssign(p, arr);
  assert.equal(r.didLower, true);
  // 函数原地替换 arr.Items[0] 为 __superWrapper(...)._
  const loweredDot = (arr.Data as js_ast.EArray).Items[0].Data as js_ast.EDot;
  assert.equal(loweredDot.Name, "_");
  assert.equal(runtimeName(p, loweredDot.Target), "__superWrapper");
});

test("J-1.259/284/309 callSuperPropertyWrapper / lowerSuperPropertyGet / lowerSuperPropertySet", () => {
  const p = makeParser();
  p.fnOnlyDataVisit.innerClassNameRef = p.newSymbol(SymbolKind.SymbolConst, "_B");
  p.fnOrArrowDataVisit.shouldLowerSuperPropertyAccess = true;
  const key = ex(new js_ast.EString(new Uint16Array([102, 111, 111]))); // "foo"
  const wrap = callSuperPropertyWrapper(p, L(), key);
  const wrapDot = wrap.Data as js_ast.EDot;
  assert.equal(wrapDot.Name, "_");
  assert.equal(runtimeName(p, wrapDot.Target), "__superWrapper");
  assert.match(byName("super-get"), /__superGet|super\.foo/);

  // 静态上下文：class 不加 .prototype
  p.fnOnlyDataVisit.isInStaticClassContext = true;
  const get = lowerSuperPropertyGet(p, L(), key);
  assert.equal(runtimeName(p, get), "__superGet");
  assert.equal((get.Data as js_ast.ECall).Args.length, 3);
  assert.equal(((get.Data as js_ast.ECall).Args[0].Data as js_ast.EIdentifier).Ref.InnerIndex, p.fnOnlyDataVisit.innerClassNameRef.InnerIndex);

  const set = lowerSuperPropertySet(p, L(), key, ex(new js_ast.ENumber(1)));
  assert.equal(runtimeName(p, set), "__superSet");
  assert.equal((set.Data as js_ast.ECall).Args.length, 4);

  // 非静态上下文：class 应为 Class.prototype
  p.fnOnlyDataVisit.isInStaticClassContext = false;
  const get2 = lowerSuperPropertyGet(p, L(), key);
  const classArg = (get2.Data as js_ast.ECall).Args[0].Data as js_ast.EDot;
  assert.ok(classArg instanceof js_ast.EDot);
  assert.equal(classArg.Name, "prototype");
});

test("J-1.337 lowerSuperPropertySetBinOp → __superSet(__superGet(...)+v)", () => {
  const p = makeParser();
  p.fnOnlyDataVisit.innerClassNameRef = p.newSymbol(SymbolKind.SymbolConst, "_B");
  const prop = ex(new js_ast.EString(new Uint16Array([102, 111, 111])));
  const out = lowerSuperPropertySetBinOp(p, L(), prop, js_ast.OpCode.BinOpAdd, ex(new js_ast.ENumber(1)));
  assert.equal(runtimeName(p, out), "__superSet");
  const binary = (out.Data as js_ast.ECall).Args[3].Data as js_ast.EBinary;
  assert.equal(runtimeName(p, binary.Left), "__superGet");
});

test("J-1.349 maybeLowerSuperPropertyGetInsideCall → __superGet(...).call(this, ...)", () => {
  const p = makeParser();
  p.fnOnlyDataVisit.innerClassNameRef = p.newSymbol(SymbolKind.SymbolConst, "_B");
  p.fnOrArrowDataVisit.shouldLowerSuperPropertyAccess = true;
  const dot = ex(new js_ast.EDot());
  (dot.Data as js_ast.EDot).Target = ex(js_ast.ESuperShared);
  (dot.Data as js_ast.EDot).Name = "foo";
  const call = new js_ast.ECall();
  call.Target = dot;
  call.Args = [ex(new js_ast.ENumber(1))];
  maybeLowerSuperPropertyGetInsideCall(p, call);
  assert.equal(call.Args.length, 2);
  assert.ok(call.Args[0].Data instanceof js_ast.EThis);
  const nameDot = call.Target.Data as js_ast.EDot;
  assert.equal(nameDot.Name, "call");
  assert.equal(runtimeName(p, nameDot.Target), "__superGet");
});
