// 第 37 轮：J-2+J-3 lowerClass 完整生成链接进 visitClass 三处调用点。
// ① es2015 equal 3491→3576（+85）/ es2016 +85 / es2017 +85；③ minify 2454→2479。
// 期望字节来自 tmpgenparseprint（mode=es2015）的 Go 实测，逐例钉死。
import test from "node:test";
import assert from "node:assert/strict";
import { Log, Path, Source } from "../logger/logger.ts";
import { Parse, Options } from "./js_parser.ts";
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
  // Go: renamer.NewNoOpRenamer → ast.FollowSymbols（跟随 Symbol.Link 链）
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

// [输入, Go 实测 es2015 字节]
const cases: [string, string][] = [
  ["class Foo { static #foo = 1 }",
    'import { __privateAdd } from "<runtime>";\nvar _foo;\nclass Foo {\n}\n_foo = new WeakMap();\n__privateAdd(Foo, _foo, 1);'],
  ["class Foo { #foo = 1 }",
    'import { __privateAdd } from "<runtime>";\nvar _foo;\nclass Foo {\n  constructor() {\n    __privateAdd(this, _foo, 1);\n  }\n}\n_foo = new WeakMap();'],
  ["(class { static foo = () => super[x] })",
    'import { __publicField, __superGet } from "<runtime>";\nvar _a;\n_a = class {\n}, __publicField(_a, "foo", () => __superGet(_a, _a, x)), _a;'],
  ["(class { static foo = () => super.x })",
    'import { __publicField, __superGet } from "<runtime>";\nvar _a;\n_a = class {\n}, __publicField(_a, "foo", () => __superGet(_a, _a, "x")), _a;'],
  ["class Foo { foo = 1; constructor() { super(); } }",
    'import { __publicField } from "<runtime>";\nclass Foo {\n  constructor() {\n    __publicField(this, "foo", 1);\n    super();\n  }\n}'],
  ["class Foo extends Bar { foo = 1; constructor() {} }",
    'import { __publicField } from "<runtime>";\nclass Foo extends Bar {\n  constructor() {\n    __publicField(this, "foo", 1);\n  }\n}'],
  ["class Foo { static { x = 1 } }", 'class Foo {\n}\nx = 1;'],
  ["class Foo { static { let x = 1; f(x) } }", 'class Foo {\n}\n(() => {\n  let x = 1;\n  f(x);\n})();'],
  ["class Foo { [a()] = 1 }",
    'import { __publicField } from "<runtime>";\nvar _a;\n_a = a();\nclass Foo {\n  constructor() {\n    __publicField(this, _a, 1);\n  }\n}'],
  ["export default class { static foo = 1 }",
    'import { __publicField } from "<runtime>";\nexport default class _default {\n}\n__publicField(_default, "foo", 1);'],
  ["class A { x = 1; y = this.x; }",
    'import { __publicField } from "<runtime>";\nclass A {\n  constructor() {\n    __publicField(this, "x", 1);\n    __publicField(this, "y", this.x);\n  }\n}'],
  ["class C { static s = 1; i = 2; static { foo() } }",
    'import { __publicField } from "<runtime>";\nclass C {\n  constructor() {\n    __publicField(this, "i", 2);\n  }\n}\n__publicField(C, "s", 1);\nfoo();'],
];

test("J-2+J-3 lowerClass 主链：es2015 输出与 Go 字节逐例相等", () => {
  for (const [src, want] of cases) {
    assert.equal(lower(src), want, `es2015 ${JSON.stringify(src)}`);
  }
});

// 覆盖 6 个分支函数：private method / auto-accessor / 多 super / 装饰器（不钉字节，只验不抛且主链执行）
const covCases = [
  "class Foo { #m() {}; foo() { return this.#m() } }",
  "class Foo { accessor x = 1 }",
  "class Foo { accessor [k] = 1 }",
  "class A extends B { constructor(x){ if(x) super(); else super(); } p=1 }",
  "class Foo { static accessor s = 2 }",
  "@dec class Foo { @dec x = 1 }",
];

test("J-2+J-3 分支覆盖：private method / auto-accessor / 多 super / 装饰器主链不抛", () => {
  for (const src of covCases) {
    const out = lower(src);
    assert.ok(out.length > 0, `output non-empty: ${src}`);
  }
});
