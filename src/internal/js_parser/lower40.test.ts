// 第 40 轮：js_parser_lower.go 的「纯」降级函数 1:1 移植并接进 visit pass。
// 根因机器实测：es2015/16/17 三档置位 OptionalChain/Nullish/LogicalAssignment/
// ObjectRestSpread/ExponentOperator/AsyncAwait，但此前 TS 的 visitExprInOut 一个都没接，
// 三档字节停在 3592/3630/3797。本轮接 nullish / 逻辑赋值 / 幂赋值 / 对象展开 /
// 对象 rest（decls、for 初始化、catch binding），三档基线上升。
// 期望字节来自 Go tmpgenparseprint / tmpprobe（mode=es2015）逐例实测。
import test from "node:test";
import assert from "node:assert/strict";
import { Log, Path, Source, Range } from "../logger/logger.ts";
import { Parse, Options, newParser } from "./js_parser.ts";
import { markSyntaxFeature, captureThis, captureArguments } from "./js_parser_lower.ts";
import { Lexer } from "../js_lexer/js_lexer.ts";
import { Format, Options as PO, Print } from "../js_printer/js_printer.ts";

const ES2015_BITS = 0x165fe46fc5c5ffb9n;

function lower(src: string): string {
  const s = new Source();
  s.Index = 0;
  s.Contents = new TextEncoder().encode(src);
  s.KeyPath = new Path();
  s.KeyPath.Text = "<stdin>";
  const o = new Options();
  o.unsupportedJSFeatures = ES2015_BITS;
  o.originalTargetEnv = '"es2015"';
  const r = Parse(new Log(), s, o);
  assert.equal(r.ok, true, `parse ok: ${src}`);
  const syms = r.ast.Symbols;
  const ren = { NameForSymbol(ref: { InnerIndex: number }) {
    let i = ref.InnerIndex;
    const seen = new Set<number>();
    while (i < syms.length && syms[i]?.Link && syms[i].Link.InnerIndex !== i && syms[i].Link.InnerIndex < syms.length) {
      const nx = syms[i].Link.InnerIndex;
      if (seen.has(nx)) break;
      seen.add(nx); i = nx;
    }
    return syms[i]?.OriginalName ?? "";
  } };
  const po = new PO();
  po.OutputFormat = Format.FormatESModule;
  return new TextDecoder().decode(Print(r.ast, syms, ren, po).JS).trim();
}

// [输入, Go 实测 es2015 字节]（15 例逐字节钉死）
const cases: [string, string][] = [
  ["var x = a ?? b;", "var x = a != null ? a : b;"],
  ["var x = a ?? b ?? c;", "var _a;\nvar x = (_a = a != null ? a : b) != null ? _a : c;"],
  ["a ||= b;", "a || (a = b);"],
  ["a &&= b;", "a && (a = b);"],
  ["a ??= b;", "a != null ? a : a = b;"],
  ["a **= b;", 'import { __pow } from "<runtime>";\na = __pow(a, b);'],
  ["var x = {a, ...b};", 'import { __spreadValues } from "<runtime>";\nvar x = __spreadValues({ a }, b);'],
  ["var x = {...a, b, ...c};", 'import { __spreadProps, __spreadValues } from "<runtime>";\nvar x = __spreadValues(__spreadProps(__spreadValues({}, a), { b }), c);'],
  ["var {a, ...b} = c;", 'import { __objRest } from "<runtime>";\nvar _a = c, { a } = _a, b = __objRest(_a, ["a"]);'],
  ["var [a, {b, ...c}, d] = e;", 'import { __objRest } from "<runtime>";\nvar [a, _a, ..._b] = e, _c = _a, { b } = _c, c = __objRest(_c, ["b"]), [d] = _b;'],
  ["for (const {a, ...b} of x) {}", 'import { __objRest } from "<runtime>";\nfor (const _a of x) {\n  const _b = _a, { a } = _b, b = __objRest(_b, ["a"]);\n}'],
  ["try {} catch ({a, ...b}) {}", 'import { __objRest } from "<runtime>";\ntry {\n} catch (_a) {\n  let _b = _a, { a } = _b, b = __objRest(_b, ["a"]);\n}'],
  ["foo({a, ...b});", 'import { __spreadValues } from "<runtime>";\nfoo(__spreadValues({ a }, b));'],
  ["var x = obj.a ?? obj.b;", "var _a;\nvar x = (_a = obj.a) != null ? _a : obj.b;"],
  ["var x = f() ?? g();", "var _a;\nvar x = (_a = f()) != null ? _a : g();"],
  // 可选链（lowerOptionalChain / lowerParenthesizedOptionalChain 接 EDot/EIndex/ECall/delete）
  ["var x = a?.b;", "var x = a == null ? void 0 : a.b;"],
  ["var x = a?.b?.c;", "var _a;\nvar x = (_a = a == null ? void 0 : a.b) == null ? void 0 : _a.c;"],
  ["var x = a?.b();", "var x = a == null ? void 0 : a.b();"],
  ["var x = a?.b?.();", "var _a;\nvar x = (_a = a == null ? void 0 : a.b) == null ? void 0 : _a.call(a);"],
  ["var x = a?.[b];", "var x = a == null ? void 0 : a[b];"],
  ["var x = a?.b?.[c];", "var _a;\nvar x = (_a = a == null ? void 0 : a.b) == null ? void 0 : _a[c];"],
  ["delete a?.b;", "a == null ? true : delete a.b;"],
  ["var x = a?.b.c;", "var x = a == null ? void 0 : a.b.c;"],
  ["var x = a?.b(c);", "var x = a == null ? void 0 : a.b(c);"],
  // 对象 rest 赋值（lowerAssign）+ 括号可选链（lowerParenthesizedOptionalChain）+ for-in expr rest
  ["({a, ...b} = c);", 'import { __objRest } from "<runtime>";\nvar _a;\n_a = c, { a } = _a, b = __objRest(_a, ["a"]);'],
  ["var x = ({a, ...b} = c);", 'import { __objRest } from "<runtime>";\nvar _a, _b;\nvar x = (_b = _a = c, { a } = _b, b = __objRest(_b, ["a"]), _a);'],
  ["for ({a, ...b} in c) {}", 'import { __objRest } from "<runtime>";\nvar _a, _b;\nfor (_a in c) {\n  _b = _a, { a } = _b, b = __objRest(_b, ["a"]);\n}'],
  ["(a?.b)();", "(a == null ? void 0 : a.b).call(a);"],
  ["(a?.b).c;", "(a == null ? void 0 : a.b).c;"],
  // async / generator / for-await 降级（第 41 轮，lowerFunction/maybeLowerAwait/lowerForAwaitLoop）
  ["async function f(x) { await x }", 'import { __async } from "<runtime>";\nfunction f(x) {\n  return __async(this, null, function* () {\n    yield x;\n  });\n}'],
  ["var f = async () => 1;", 'import { __async } from "<runtime>";\nvar f = () => __async(null, null, function* () {\n  return 1;\n});'],
  ["async function* f() { yield 1 }", 'import { __asyncGenerator } from "<runtime>";\nfunction f() {\n  return __asyncGenerator(this, null, function* () {\n    yield 1;\n  });\n}'],
  ["async function f() { for await (const x of y) {} }", 'import { __async, __forAwait } from "<runtime>";\nfunction f() {\n  return __async(this, null, function* () {\n    try {\n      for (var iter = __forAwait(y), more, temp, error; more = !(temp = yield iter.next()).done; more = false) {\n        const x = temp.value;\n      }\n    } catch (temp) {\n      error = [temp];\n    } finally {\n      try {\n        more && (temp = iter.return) && (yield temp.call(iter));\n      } finally {\n        if (error)\n          throw error[0];\n      }\n    }\n  });\n}'],
  ["function* g() { yield 1 }", "function* g() {\n  yield 1;\n}"],
];

test("lowering 家族接 visit 主链：es2015 逐字节等于 Go", () => {
  for (const [src, want] of cases) {
    assert.equal(lower(src), want, `lowering: ${src}`);
  }
});

// 直调单测（j2b.test.ts 同款）：覆盖只在 es5/箭头降级分支可达的辅助函数。
// 这些函数已接主链（markSyntaxFeature←markAsyncFn、captureThis←EThis、
// captureArguments←EIdentifier），三档 target 位不触发对应分支，故用直调验证真实行为。
test("async lowering 辅助函数直调：真实分配 ref / 返回 false", () => {
  const src = new Source();
  src.Contents = new TextEncoder().encode("");
  src.KeyPath = new Path();
  src.KeyPath.Text = "<stdin>";
  const log = new Log();
  const p = newParser(log, src, new Lexer(log, src), new Options());
  // markSyntaxFeature：目标位未置时返回 false（未产生错误），且不改 AST
  assert.equal(markSyntaxFeature(p, 1n << 37n, new Range()), false);
  // captureThis / captureArguments：第一次分配新符号，第二次复用同一 ref
  const t1 = captureThis(p);
  const t2 = captureThis(p);
  assert.equal(t1.InnerIndex, t2.InnerIndex, "captureThis 复用同一 ref");
  const a1 = captureArguments(p);
  const a2 = captureArguments(p);
  assert.equal(a1.InnerIndex, a2.InnerIndex, "captureArguments 复用同一 ref");
});
