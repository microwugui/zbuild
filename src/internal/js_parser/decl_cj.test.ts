// 第 107 轮：parser.declareCommonJSSymbol 逐字节等于 Go（5 场景状态机）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parser } from "./js_parser.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import { Ref, SymbolKind, Symbol } from "../ast/ast.ts";
import { Source, Loc } from "../logger/logger.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/decl-cj-go.json", import.meta.url)));
const SHA = "0f6dc36a6b36695eba7f7e86ecf4e7a76d3271e76c4164aae597811fb56d1800";
const rows = JSON.parse(new TextDecoder().decode(raw)) as any[];
const rkey = (r: Ref) => `${r.SourceIndex}:${r.InnerIndex}`;

function run(idx: number): any {
  const scope = new js_ast.Scope();
  const p = Object.create(parser.prototype) as parser;
  const src = new Source(); src.Index = 1;
  (p as any).source = src;
  (p as any).moduleScope = scope;
  (p as any).symbols = [];
  (p as any).isFileConsideredToHaveESMExports = false;
  const existing = new Ref(1, 0);
  const setups: [number, string, boolean][] = [
    [SymbolKind.SymbolOther, "foo", false],
    [SymbolKind.SymbolHoisted, "exports", false],
    [SymbolKind.SymbolHoisted, "exports", true],
    [SymbolKind.SymbolOther, "module", false],
    [SymbolKind.SymbolHoisted, "exports", false],
  ];
  const [kind, name] = setups[idx];
  (p as any).isFileConsideredToHaveESMExports = setups[idx][2];
  if (idx > 0) {
    const sm = new js_ast.ScopeMember(); sm.Ref = existing; sm.Loc = new Loc(-1);
    scope.Members.set(name, sm);
    const pre = new Symbol();
    pre.Kind = idx === 4 ? SymbolKind.SymbolOther : SymbolKind.SymbolHoisted;
    (p as any).symbols.push(pre);
  }
  const ref = p.declareCommonJSSymbol(kind, name);
  const symbols = (p as any).symbols as Symbol[];
  return {
    name: rows[idx].name,
    ref: rkey(ref),
    numSymbols: symbols.length,
    lastKind: symbols[symbols.length - 1].Kind,
    memberExists: scope.Members.has(name),
    generated: scope.Generated.map(rkey),
  };
}

test("decl-cj 夹具 sha256（5 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("declareCommonJSSymbol 状态机逐字节等于 Go（5 场景）", () => {
  assert.equal(rows.length, 5);
  for (let i = 0; i < rows.length; i++) assert.deepEqual(run(i), rows[i], `scenario ${i}: ${rows[i].name}`);
});
