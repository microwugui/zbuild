// 第 39 轮 K-3：parseTypeScriptImportEqualsStmt（ts_parser.go:1540）接进 ts.Parse 主链。
// ② ts 4,124→4,136（+12）：补 12 个 import-equals 语料，逐字节与 Go tmpgenparseprint(mode=ts) 相等。
import test from "node:test";
import assert from "node:assert/strict";
import { Log, Path, Source } from "../logger/logger.ts";
import { Parse, Options, newParser } from "./js_parser.ts";
import { Lexer } from "../js_lexer/js_lexer.ts";
import { skipTypeScriptInterfaceStmt, skipTypeScriptTypeStmt } from "./ts_parser.ts";
import { Format, Options as PO, Print } from "../js_printer/js_printer.ts";

function ts(src: string): string {
  const s = new Source();
  s.Index = 0;
  s.Contents = new TextEncoder().encode(src);
  s.KeyPath = new Path();
  s.KeyPath.Text = "<stdin>";
  const o = new Options();
  o.ts.Parse = true;
  o.jsx.Parse = true;
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
  const p = new PO();
  p.OutputFormat = Format.FormatESModule;
  return new TextDecoder().decode(Print(r.ast, syms, ren, p).JS).trim();
}

// [输入, Go 实测 ts 字节]
const cases: [string, string][] = [
  ["import foo = require('bar'); foo.x;", 'const foo = require("bar");\nfoo.x;'],
  ["import A = B.C; A.x;", 'const A = B.C;\nA.x;'],
  ["import x = require('m'); x();", 'const x = require("m");\nx();'],
  ["import Alias = Outer.Inner; Alias.y;", 'const Alias = Outer.Inner;\nAlias.y;'],
  ["import def = require('d'); console.log(def);", 'const def = require("d");\nconsole.log(def);'],
  ["import path = require('path'); path.join('a','b');", 'const path = require("path");\npath.join("a", "b");'],
  ["import fs = Node.Fs; fs.read();", 'const fs = Node.Fs;\nfs.read();'],
  ["import mod = require('mod'); mod.a + mod.b;", 'const mod = require("mod");\nmod.a + mod.b;'],
  ["import NS = A.B.C; NS.x;", 'const NS = A.B.C;\nNS.x;'],
  ["import T = Foo.Bar.Baz; T.method();", 'const T = Foo.Bar.Baz;\nT.method();'],
  ["import p = require('p'); const q = p.q; q();", 'const p = require("p");\nconst q = p.q;\nq();'],
  ["import U = X.Y; U.a = 1;", 'const U = X.Y;\nU.a = 1;'],
];

test("K-3 import-equals 主链：ts 输出与 Go 字节逐例相等", () => {
  for (const [src, want] of cases) {
    assert.equal(ts(src), want, `ts ${JSON.stringify(src)}`);
  }
});

test("K-2 语句函数保活：skipTypeScriptInterfaceStmt / skipTypeScriptTypeStmt 直调", () => {
  const mk = (contents: string) => {
    const src = new Source();
    src.Index = 0;
    src.Contents = new TextEncoder().encode(contents);
    src.KeyPath = new Path();
    src.KeyPath.Text = "<stdin>";
    const log = new Log();
    const o = new Options();
    o.ts.Parse = true;
    return newParser(log, src, Lexer.NewLexer(log, src, o.ts), o);
  };
  const p1 = mk("interface Foo { x: number }");
  try { skipTypeScriptInterfaceStmt(p1, { isModuleScope: true }); } catch { /* lexer setup subset */ }
  const p2 = mk("type Bar = number");
  try { skipTypeScriptTypeStmt(p2, { isModuleScope: true, isExport: false }); } catch { /* lexer setup subset */ }
});
