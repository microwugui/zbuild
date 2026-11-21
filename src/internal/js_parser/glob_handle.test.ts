// 第 108 轮：parser.handleGlobPattern 逐字节等于 Go（3 场景：名称生成/字符串常量/去重）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parser, Options } from "./js_parser.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import { Ref, Symbol } from "../ast/ast.ts";
import { Source, Loc, NewDeferLog, DeferLogKind } from "../logger/logger.ts";
const u16 = (s: string) => Uint16Array.from(s, (c) => c.charCodeAt(0));

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/glob-handle-go.json", import.meta.url)));
const SHA = "1fc3a621a1a837b3572c702d360d85900121852487c27fe04ded9fdeffc502a3";
const rows = JSON.parse(new TextDecoder().decode(raw)) as any[];

function strExpr(s: string): js_ast.Expr { const e = new js_ast.EString(u16(s)); return new js_ast.Expr(e, new Loc(0)); }
function tmplExpr(): js_ast.Expr {
  const e = new js_ast.ETemplate();
  e.HeadCooked = u16("./a/");
  e.HeadRaw = new Uint8Array(0);
  const tp = new js_ast.TemplatePart();
  tp.Value = new js_ast.Expr(new js_ast.EIdentifier(new Ref(1, 9)), new Loc(8));
  tp.TailCooked = u16("/*.js");
  e.Parts = [tp];
  return new js_ast.Expr(e, new Loc(0));
}
function newP(): parser {
  const p = Object.create(parser.prototype) as parser;
  const src = new Source(); src.Contents = new TextEncoder().encode("`./a/${x}/*.js`"); src.KeyPath.Text = "main.js"; src.Index = 1;
  (p as any).source = src;
  (p as any).symbols = [new Symbol()];
  const scope = new js_ast.Scope();
  (p as any).moduleScope = scope;
  (p as any).log = NewDeferLog(DeferLogKind.DeferLogAll, null);
  (p as any).globPatternImports = [];
  (p as any).options = new Options();
  return p;
}
function dump(p: parser, out: js_ast.Expr): any {
  const r: any = { isCall: false, refName: "", numSyms: (p as any).symbols.length, numImports: (p as any).globPatternImports.length };
  if (out.Data instanceof js_ast.ECall) {
    r.isCall = true;
    const id = (out.Data as js_ast.ECall).Target.Data;
    if (id instanceof js_ast.EIdentifier) r.refName = (p as any).symbols[id.Ref.InnerIndex]?.OriginalName ?? "";
  }
  return r;
}
function run(idx: number): any {
  const p = newP();
  let out: js_ast.Expr;
  if (idx === 0) out = p.handleGlobPattern(tmplExpr(), 1, 0, "./_glob", null);
  else if (idx === 1) out = p.handleGlobPattern(strExpr("./a.js"), 1, 0, "./_glob", null);
  else { p.handleGlobPattern(tmplExpr(), 1, 0, "./_glob", null); out = p.handleGlobPattern(tmplExpr(), 1, 0, "./_glob", null); }
  return { name: rows[idx].name, ...dump(p, out) };
}

test("glob-handle 夹具 sha256（3 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("handleGlobPattern 逐字节等于 Go（3 场景）", () => {
  assert.equal(rows.length, 3);
  for (let i = 0; i < rows.length; i++) assert.deepEqual(run(i), rows[i], `scenario ${i}: ${rows[i].name}`);
});
