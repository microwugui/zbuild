// 第 107 轮：parser.maybeRelocateVarsToTopLevel 逐字节等于 Go（6 场景状态机）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parser, Options } from "./js_parser.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import { Ref, Symbol, SymbolKind } from "../ast/ast.ts";
import { ScopeKind } from "../js_ast/js_ast.ts";
import { Loc } from "../logger/logger.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/relocate-go.json", import.meta.url)));
const SHA = "acce0fae5d65878a3015ed5d34f9e8a49c8d10a5616e3e3de049a3996e0820f2";
const rows = JSON.parse(new TextDecoder().decode(raw)) as any[];

function run(idx: number): any {
  const ref = new Ref(1, 0);
  const p = Object.create(parser.prototype) as parser;
  const sym = new Symbol(); sym.Kind = SymbolKind.SymbolConst; sym.OriginalName = "x";
  (p as any).symbols = [sym];
  const moduleScope = new js_ast.Scope(); moduleScope.Kind = ScopeKind.ScopeEntry;
  (p as any).moduleScope = moduleScope;
  let cur = moduleScope;
  const topLevel = idx === 1;
  if (!topLevel) { cur = new js_ast.Scope(); cur.Kind = ScopeKind.ScopeBlock; cur.Parent = moduleScope; }
  (p as any).currentScope = cur;
  const o = new Options();
  o.mode = idx === 0 ? 0 : 1; // ModePassThrough / ModeBundle
  (p as any).options = o;
  (p as any).singleStmtDepth = idx === 5 ? 1 : 0;
  (p as any).relocatedTopLevelVars = [];
  const decl = new js_ast.Decl();
  const bi = new js_ast.BIdentifier(); bi.Ref = ref; decl.Binding.Data = bi; decl.Binding.Loc = new Loc(0);
  const withInit = idx === 0 || idx === 1 || idx === 2 || idx === 5;
  if (withInit) { const e = new js_ast.ENumber(42); decl.ValueOrNil = new js_ast.Expr(e, new Loc(5)); }
  const mode = idx === 4 ? 1 : 0;
  const [stmt, ok] = p.maybeRelocateVarsToTopLevel([decl], mode);
  let valueKind = "none", isExpr = false, loc = 0;
  if (ok && stmt) {
    const se = stmt.Data as js_ast.SExpr;
    if (se instanceof js_ast.SExpr) {
      isExpr = true; loc = stmt.Loc.Start;
      if (se.Value.Data instanceof js_ast.EBinary) valueKind = "binary";
      else if (se.Value.Data instanceof js_ast.EIdentifier) valueKind = "identifier";
    }
  } else if (ok && idx === 3) isExpr = false;
  return { name: rows[idx].name, ok, isExpr, loc, relocated: (p as any).relocatedTopLevelVars.length, useCount: sym.UseCountEstimate, valueKind };
}

test("relocate 夹具 sha256（6 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("maybeRelocateVarsToTopLevel 状态机逐字节等于 Go（6 场景）", () => {
  assert.equal(rows.length, 6);
  for (let i = 0; i < rows.length; i++) assert.deepEqual(run(i), rows[i], `scenario ${i}: ${rows[i].name}`);
});
