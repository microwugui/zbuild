// js_printer 最小子集的差分测试（第 14 次推进）。
//
// 期望值来自 Go 实测：/root/esbuild/tmpgenprinter 用**真实的** js_parser.Parse + js_printer.Print
// 生成 testdata/js_printer/basic.json（hex 编码，避免转义歧义）。
// 生成命令见 PLAN.md「第 14 次推进」§4；夹具 sha256 钉在 tools/fixtures.json。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Log, Path, Source } from "../logger/logger.ts";
import { Options, Parse } from "../js_parser/js_parser.ts";
import { Format, Options as PrintOptions, Print, printer, QuoteIdentifier } from "./js_printer.ts";
import type { Ref } from "../ast/ast.ts";

interface PrinterCase {
  name: string;
  input: string;
  jsHex: string;
  minJsHex: string;
}

const fixture: { cases: PrinterCase[]; quotes: { input: string; hex: string }[]; numbers: PrinterCase[] } = JSON.parse(
  readFileSync(new URL("../../../testdata/js_printer/basic.json", import.meta.url), "utf8"),
);

function print(input: string, minify: boolean): Uint8Array | null {
  const source = new Source();
  source.Index = 0;
  source.Contents = new TextEncoder().encode(input);
  source.KeyPath = new Path();
  source.KeyPath.Text = "<stdin>";

  const { ast, ok } = Parse(new Log(), source, new Options());
  if (!ok) return null;

  const symbols = ast.Symbols;
  const renamer = {
    NameForSymbol(ref: Ref): string {
      return symbols[ref.InnerIndex].OriginalName;
    },
  };
  const options = new PrintOptions();
  options.OutputFormat = Format.FormatESModule;
  options.MinifyWhitespace = minify;
  return Print(ast, symbols, renamer, options).JS;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

test("QuoteIdentifier 与 Go 实测一致", () => {
  for (const q of fixture.quotes) {
    assert.equal(toHex(QuoteIdentifier(q.input)), q.hex, q.input);
  }
});

// 第 18 次推进：JSX 打印 / IIFE pure / void 折叠 / canPrintIdentifier 的最小覆盖。
// 期望值来自 Go 实测（`/root/esbuild/tmpgenparseprint` 的 Parse+Print，不经 linker）：
//   <x/>                    => /* @__PURE__ */ React.createElement("x", null);\n
//   <a b={1}>t</a>          => /* @__PURE__ */ React.createElement("a", { b: 1 }, "t");\n
//   (() => {})();           => /* @__PURE__ */ (() => {\n})();\n
//   x = void 0;             => x = void 0;\n
//   void 0;                 => （空输出）
const goByteCases: { name: string; input: string; expected: string }[] = [
  { name: "jsx-self-closing", input: "<x/>", expected: '/* @__PURE__ */ React.createElement("x", null);\n' },
  { name: "jsx-attrs-child", input: "<a b={1}>t</a>", expected: '/* @__PURE__ */ React.createElement("a", { b: 1 }, "t");\n' },
  { name: "iife-pure", input: "(() => {})();", expected: "/* @__PURE__ */ (() => {\n})();\n" },
  { name: "void-fold", input: "x = void 0;", expected: "x = void 0;\n" },
];

test("JSX / IIFE / void 折叠与 Go 实测字节一致", () => {
  for (const c of goByteCases) {
    const out = print(c.input, false);
    assert.notEqual(out, null, c.name);
    assert.equal(new TextDecoder().decode(out!), c.expected, c.name);
  }
});

test("canPrintIdentifier 与 Go 实测一致", () => {
  const p = new printer([], { NameForSymbol: () => "" }, new PrintOptions());
  assert.equal(p.canPrintIdentifier("abc"), true);
  assert.equal(p.canPrintIdentifier("$"), true);
  assert.equal(p.canPrintIdentifier("a-b"), false);
  assert.equal(p.canPrintIdentifier("a b"), false);
  assert.equal(p.canPrintIdentifier(""), false);
});

// JSX preserve 模式的期望值来自 Go 实测（包内临时 go test：jsx.Parse=1, jsx.Preserve=1）：
//   <x/>          => <x />;\n
//   <a b={1}>t</a> => <a b={1}>t</a>;\n
//   <>f</>        => <>f</>;\n
function printPreserve(input: string): string {
  const source = new Source();
  source.Index = 0;
  source.Contents = new TextEncoder().encode(input);
  source.KeyPath = new Path();
  source.KeyPath.Text = "<stdin>";

  const options = new Options();
  options.jsx.Parse = true;
  options.jsx.Preserve = true;
  const { ast, ok } = Parse(new Log(), source, options);
  assert.equal(ok, true, input);
  const symbols = ast.Symbols;
  const renamer = { NameForSymbol: (ref: Ref) => symbols[ref.InnerIndex].OriginalName };
  const printOptions = new PrintOptions();
  printOptions.OutputFormat = Format.FormatESModule;
  return new TextDecoder().decode(Print(ast, symbols, renamer, printOptions).JS);
}

test("JSX preserve 打印与 Go 实测字节一致", () => {
  assert.equal(printPreserve("<x/>"), "<x />;\n");
  assert.equal(printPreserve("<a b={1}>t</a>"), "<a b={1}>t</a>;\n");
  assert.equal(printPreserve("<>f</>"), "<>f</>;\n");
});

// 第 19 次推进新增语法（with / using / private / accessor / decorators / import attributes /
// 动态 import / 数组洞 / await 标识符）的期望值全部由 Go 实测得到：
//   cd /root/esbuild && go run ./tmpgenparseprint   # js_parser.Parse + js_printer.Print
// 输入与输出在本文件的表里一一对应（不做任何归一化，逐字节比）。
const newSyntaxCases: { input: string; expected: string }[] = [
  { input: "class f {} with (x) y", expected: "class f {\n}\nwith (x) y;\n" },
  { input: "with (x) y(undefined); z(undefined)", expected: "with (x) y(undefined);\nz(void 0);\n" },
  { input: "using x = y", expected: "using x = y;\n" },
  { input: "async function foo() { await using x = y }", expected: "async function foo() {\n  await using x = y;\n}\n" },
  { input: "for (using x of y) ;", expected: "for (using x of y) ;\n" },
  { input: "class Foo { #foo }", expected: "class Foo {\n  #foo;\n}\n" },
  {
    input: "class Foo { #foo = #foo in (#bar in this); #bar }",
    expected: "class Foo {\n  #foo = #foo in (#bar in this);\n  #bar;\n}\n",
  },
  { input: "Foo = class { static accessor x = y }", expected: "Foo = class {\n  static accessor x = y;\n};\n" },
  { input: "class Foo { accessor [x] = y }", expected: "class Foo {\n  accessor [x] = y;\n}\n" },
  { input: "@dec class Foo {}", expected: "@dec class Foo {\n}\n" },
  { input: "@ x @ y class Foo {}", expected: "@x @y class Foo {\n}\n" },
  { input: "@x @y export class Foo {}", expected: "@x @y export class Foo {\n}\n" },
  { input: "export default @x class {}", expected: "@x export default class {\n}\n" },
  { input: "class Foo { @x static y() {} }", expected: "class Foo {\n  @x static y() {\n  }\n}\n" },
  { input: "import 'x' assert {type: 'json'}", expected: "import \"x\" assert { type: \"json\" };\n" },
  { input: "import 'x' with {a: 'b', c: 'd',}", expected: "import \"x\" with { a: \"b\", c: \"d\" };\n" },
  { input: "import defer * as foo from 'bar'", expected: "import defer * as foo from \"bar\";\n" },
  { input: "export * from 'x' with {x: 'y'}", expected: "export * from \"x\" with { x: \"y\" };\n" },
  { input: "import('foo')", expected: "import(\"foo\");\n" },
  { input: "import(x, {with: {x: 'y'}})", expected: "import(x, { with: { x: \"y\" } });\n" },
  { input: "new (import('foo'))", expected: "new (import(\"foo\"))();\n" },
  { input: "import.meta", expected: "import.meta;\n" },
  { input: "[1,,2]", expected: "[1, , 2];\n" },
  { input: "[,]", expected: "[,];\n" },
  { input: "function foo(x = await) {}", expected: "function foo(x = await) {\n}\n" },
  { input: "for (var x = y(a in b);;);", expected: "for (var x = y(a in b); ; ) ;\n" },
  { input: "export default async => {}", expected: "export default (async) => {\n};\n" },
  { input: "for await (async of []) ;", expected: "for await (async of []) ;\n" },
  { input: "x = async function() {}", expected: "x = async function() {\n};\n" },
];

test("第 19 次推进新增语法：与 Go 实测字节一致", () => {
  for (const c of newSyntaxCases) {
    const js = print(c.input, false);
    assert.notEqual(js, null, `Parse 失败: ${c.input}`);
    assert.equal(new TextDecoder().decode(js!), c.expected, `输出不一致: ${c.input}`);
  }
});

// 第 20 次推进：可选链 continuation / JSX pragma+automatic runtime / 块级函数 hoisting。
// 期望值由常驻 Go 生成器当场产出（输入写进 /tmp/p20/*.js，用 tools/go/tmpgenparseprint 的
// 同一条协议跑 `cd /root/esbuild && go run ./tmpgenparseprint`）：
//   a?.b(c) → a?.b(c);   while (1) { function x() {} } → let x = function() {}; var x = x;
// 表里逐字节比，不做归一化。
const p20Cases: { input: string; expected: string }[] = [
  { input: "a?.[b](c)", expected: "a?.[b](c);\n" },
  { input: "a?.b(c)", expected: "a?.b(c);\n" },
  { input: "(a?.b).c", expected: "(a?.b).c;\n" },
  { input: "a?.b.c(d)", expected: "a?.b.c(d);\n" },
  { input: "a?.[b]?.(c)", expected: "a?.[b]?.(c);\n" },
  { input: "(0, a?.b)()", expected: "(0, a?.b)();\n" },
  { input: "// @jsxFrag f\n<></>", expected: "/* @__PURE__ */ React.createElement(f, null);\n" },
  { input: "/*@jsx h*/\n<a/>", expected: "/* @__PURE__ */ h(\"a\", null);\n" },
  { input: "<a/>\n// @jsx h", expected: "/* @__PURE__ */ h(\"a\", null);\n" },
  { input: "/*@jsx a.b.c*/<></>", expected: "/* @__PURE__ */ a.b.c(React.Fragment, null);\n" },
  {
    input: "/*@jsxRuntime automatic*/\n<a/>",
    expected: "import { jsx } from \"react/jsx-runtime\";\n/* @__PURE__ */ jsx(\"a\", {});\n",
  },
  {
    input: "/*@jsxRuntime automatic @jsxImportSource src*/\n<a/>",
    expected: "import { jsx } from \"src/jsx-runtime\";\n/* @__PURE__ */ jsx(\"a\", {});\n",
  },
  {
    input: "// @jsxRuntime automatic @jsxFrag f\n<></>",
    expected: "import { Fragment, jsx } from \"react/jsx-runtime\";\n/* @__PURE__ */ jsx(Fragment, {});\n",
  },
  {
    input: "while (1) { function x() {} }",
    expected: "while (1) {\n  let x = function() {\n  };\n  var x = x;\n}\n",
  },
  {
    input: "if (1) function x() {}",
    expected: "if (1) {\n  let x = function() {\n  };\n  var x = x;\n}\n",
  },
  {
    input: "x: function f() {}",
    expected: "x: {\n  let f = function() {\n  };\n  var f = f;\n}\n",
  },
  {
    input: "'use strict'; if (foo) { function x() {} }",
    expected: "\"use strict\";\nif (foo) {\n  let x = function() {\n  };\n}\n",
  },
  { input: "{async function f() {}} let f", expected: "{\n  async function f() {\n  }\n}\nlet f;\n" },
  { input: "while(1) { async function x() {} }", expected: "while (1) {\n  async function x() {\n  }\n}\n" },
  {
    input: "if (foo) { eval(''); function x() {} }",
    expected: "if (foo) {\n  function x() {\n  }\n  eval(\"\");\n}\n",
  },
  { input: "{function f() {}} let f", expected: "{\n  let f = function() {\n  };\n}\nlet f;\n" },
  { input: "var x = function() { y() }()", expected: "var x = (function() {\n  y();\n})();\n" },
  { input: "x: { function f() {} }", expected: "x: {\n  let f = function() {\n  };\n  var f = f;\n}\n" },
];

test("第 20 次推进：可选链 continuation / JSX pragma / 块级 hoisting 与 Go 实测字节一致", () => {
  for (const c of p20Cases) {
    const js = print(c.input, false);
    assert.notEqual(js, null, `Parse 失败: ${c.input}`);
    assert.equal(new TextDecoder().decode(js!), c.expected, `输出不一致: ${c.input}`);
  }
});

// 第 21 次推进：模板字面量里的 "</script" 必须降级成 __template(...)（带 tag 时）。
// 期望值全部来自 `/root/esbuild/tmpgenparseprint`（输入写进 /tmp/p21/*.js，串连起来一次跑完，
// 含 control：a5 只匹配 "script" 前缀（所以 </scriptx> 也降级）、a9 无 tag 不降级、
// a8 两个模板 → `var _a, _b;`）。
const p21TemplateCases: { input: string; expected: string }[] = [
  {
    input: "tag`</script>`",
    expected: 'import { __template } from "<runtime>";\nvar _a;\ntag(_a || (_a = __template(["<\\/script>"])));\n',
  },
  {
    input: "tag`${a}</script>`",
    expected: 'import { __template } from "<runtime>";\nvar _a;\ntag(_a || (_a = __template(["", "<\\/script>"])), a);\n',
  },
  {
    input: "tag`</script>${a}`",
    expected: 'import { __template } from "<runtime>";\nvar _a;\ntag(_a || (_a = __template(["<\\/script>", ""])), a);\n',
  },
  {
    input: "tag`</SCRIPT>`",
    expected: 'import { __template } from "<runtime>";\nvar _a;\ntag(_a || (_a = __template(["<\\/SCRIPT>"])));\n',
  },
  {
    input: "tag`</scriptx>`",
    expected: 'import { __template } from "<runtime>";\nvar _a;\ntag(_a || (_a = __template(["<\\/scriptx>"])));\n',
  },
  {
    input: "x=1;\ntag`</script>`;",
    expected: 'import { __template } from "<runtime>";\nvar _a;\nx = 1;\ntag(_a || (_a = __template(["<\\/script>"])));\n',
  },
  {
    input: "// c\ntag`</script>`",
    expected: 'import { __template } from "<runtime>";\nvar _a;\ntag(_a || (_a = __template(["<\\/script>"])));\n',
  },
  {
    input: "tag`</script>`; tag`</script>`",
    expected: 'import { __template } from "<runtime>";\nvar _a, _b;\ntag(_a || (_a = __template(["<\\/script>"])));\ntag(_b || (_b = __template(["<\\/script>"])));\n',
  },
  { input: "\u0060</script>\u0060", expected: '`<\\/script>`;\n' },
  { input: "tag`a${b}c`", expected: "tag`a${b}c`;\n" },
];

test("第 21 次推进：模板 </script> lowering（含 __template 运行时 import 与临时变量）与 Go 字节一致", () => {
  for (const c of p21TemplateCases) {
    const js = print(c.input, false);
    assert.notEqual(js, null, `Parse 失败: ${c.input}`);
    assert.equal(new TextDecoder().decode(js!), c.expected, `输出不一致: ${c.input}`);
  }
});

test("js_printer 夹具不得缩水", () => {  assert.ok(fixture.cases.length >= 20, `夹具只有 ${fixture.cases.length} 条`);
});

test("js_printer：20 个输入的默认输出与 Go 实测逐字节一致", () => {
  for (const c of fixture.cases) {
    const js = print(c.input, false);
    assert.notEqual(js, null, `[${c.name}] Parse 失败`);
    assert.equal(toHex(js!), c.jsHex, `[${c.name}] 输出字节不一致`);
  }
});

test("js_printer：minifyWhitespace 输出与 Go 实测逐字节一致", () => {
  for (const c of fixture.cases) {
    if (c.minJsHex === "") continue;
    const js = print(c.input, true);
    assert.notEqual(js, null, `[${c.name}] Parse 失败`);
    assert.equal(toHex(js!), c.minJsHex, `[${c.name}] minify 输出字节不一致`);
  }
});

test("printNonNegativeFloat 边界表：与 Go 实测逐字节一致（≥50 条数值）", () => {
  assert.ok(fixture.numbers.length >= 50, `数值表只有 ${fixture.numbers.length} 条`);
  for (const c of fixture.numbers) {
    const js = print(c.input, false);
    assert.notEqual(js, null, `[${c.name}] Parse 失败`);
    assert.equal(toHex(js!), c.jsHex, `[${c.name}] 数值输出字节不一致`);
    if (c.minJsHex !== "") {
      const min = print(c.input, true);
      assert.notEqual(min, null, `[${c.name}] minify Parse 失败`);
      assert.equal(toHex(min!), c.minJsHex, `[${c.name}] minify 数值输出字节不一致`);
    }
  }
});
