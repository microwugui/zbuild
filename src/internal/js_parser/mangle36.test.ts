// 第 36 轮：mangleStmts / mangleIf 接进 visitStmts 主链，③ minify 真实字节基线 1767→2454。
// 期望字节来自 tmpgenparseprint（mode=minify）的 Go 实测，逐例钉死。
import test from "node:test";
import assert from "node:assert/strict";
import { Log, Path, Source } from "../logger/logger.ts";
import { Parse, Options } from "./js_parser.ts";
import { Format, Options as PO, Print } from "../js_printer/js_printer.ts";

function minify(src: string): string {
  const s = new Source();
  s.Index = 0;
  s.Contents = new TextEncoder().encode(src);
  s.KeyPath = new Path();
  s.KeyPath.Text = "<stdin>";
  const o = new Options();
  o.minifyWhitespace = true;
  o.minifySyntax = true;
  const r = Parse(new Log(), s, o);
  assert.equal(r.ok, true, `parse ok: ${src}`);
  const syms = r.ast.Symbols;
  const ren = { NameForSymbol(ref: { InnerIndex: number }) { return syms[ref.InnerIndex].OriginalName; } };
  const po = new PO();
  po.OutputFormat = Format.FormatESModule;
  po.MinifyWhitespace = true;
  po.MinifySyntax = true;
  return new TextDecoder().decode(Print(r.ast, syms, ren, po).JS).trim();
}

// 每条 [输入, Go 实测 minify 字节]
const cases: [string, string][] = [
  ["if (1) { foo(); } else { bar(); }", "foo();"],
  ["var x = 1; if (x) foo(); else bar();", "var x=1;x?foo():bar();"],
  ["if(a) b(); else c();", "a?b():c();"],
  ["let a = 1; a; ; ; console.log(a);", "let a=1;console.log(a);"],
  ["class A extends B { x = 1; constructor() { super(); return c } }", "class A extends B{x=1;constructor(){return super(),c}}"],
];

test("G-3 mangleStmts/mangleIf 主链：minify 输出与 Go 字节逐例相等", () => {
  for (const [src, want] of cases) {
    assert.equal(minify(src), want, `minify ${JSON.stringify(src)}`);
  }
});
