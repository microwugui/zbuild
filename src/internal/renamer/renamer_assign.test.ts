// 第 55 轮叶子优先规划：renamer NumberRenamer 命名链路（Go 探针固化，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { InvalidRef, NewSymbolMap, Ref, Symbol, SymbolFlags, SymbolKind } from "../ast/ast.ts";
import { Scope, ScopeMember } from "../js_ast/js_ast.ts";
import { NewNumberRenamer } from "./renamer.ts";

const FIXTURE = new URL("../../../testdata/renamer-assign-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "c7e4a51909196c413dec642b9387c58373d552cb9c27a7073dee5e43b7a47966";

interface Row { fn: string; arg: string; out: string; }
const HOISTED = SymbolKind.SymbolHoisted;
function mkSym(name: string, kind: number, flags: number): Symbol {
  const s = new Symbol();
  s.OriginalName = name; s.Kind = kind; s.Flags = flags; s.Link = InvalidRef;
  return s;
}
function mkMap(syms: Symbol[]) {
  const sm = NewSymbolMap(1);
  sm.SymbolsForSource[0] = syms;
  return sm;
}
function dumpNames(r: ReturnType<typeof NewNumberRenamer>, sm: ReturnType<typeof mkMap>): string {
  const out: string[] = [];
  for (let ii = 0; ii < sm.SymbolsForSource[0]!.length; ii++) out.push(r.NameForSymbol(new Ref(0, ii)));
  return out.join(";");
}
function member(ii: number): ScopeMember { const m = new ScopeMember(); m.Ref = new Ref(0, ii); return m; }

test("renamer-assign fixture sha256 + 4 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "renamer-assign fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    if (r.fn === "AddTopLevelSymbol" && r.arg === "dedupe") {
      const sm = mkMap([mkSym("foo", HOISTED, 0), mkSym("bar", HOISTED, 0), mkSym("foo2", HOISTED, 0)]);
      const nr = NewNumberRenamer(sm, new Map([["foo", 1]]));
      for (const ii of [0, 1, 0, 2]) nr.AddTopLevelSymbol(new Ref(0, ii));
      got = dumpNames(nr, sm);
    } else if (r.fn === "AddTopLevelSymbol" && r.arg === "jsx-private") {
      const sm = mkMap([
        mkSym("foo", HOISTED, SymbolFlags.MustStartWithCapitalLetterForJSX),
        mkSym("#bar", SymbolKind.SymbolPrivateField, 0),
      ]);
      const nr = NewNumberRenamer(sm, new Map());
      nr.AddTopLevelSymbol(new Ref(0, 0));
      nr.AddTopLevelSymbol(new Ref(0, 1));
      got = dumpNames(nr, sm);
    } else if (r.fn === "AssignNamesByScope" && r.arg === "tree") {
      const sm = mkMap([mkSym("a", HOISTED, 0), mkSym("b", HOISTED, 0), mkSym("c", HOISTED, 0), mkSym("d", HOISTED, 0), mkSym("label", SymbolKind.SymbolLabel, 0)]);
      const nr = NewNumberRenamer(sm, new Map());
      const labelScope = new Scope();
      labelScope.Label.Ref = new Ref(0, 4);
      const child = new Scope();
      child.Members.set("c", member(2));
      child.Generated.push(new Ref(0, 3));
      const root = new Scope();
      root.Members.set("a", member(0)); root.Members.set("b", member(1));
      root.Children.push(child, labelScope);
      nr.AssignNamesByScope(new Map([[0, [root]]]));
      got = dumpNames(nr, sm);
    } else if (r.fn === "AssignNamesByScope" && r.arg === "chain") {
      const sm = mkMap([mkSym("x", HOISTED, 0), mkSym("y", HOISTED, 0)]);
      const nr = NewNumberRenamer(sm, new Map());
      const leaf = new Scope(); leaf.Members.set("y", member(1));
      const mid = new Scope(); mid.Children.push(leaf);
      const root = new Scope(); root.Members.set("x", member(0)); root.Children.push(mid);
      nr.AssignNamesByScope(new Map([[0, [root]]]));
      got = dumpNames(nr, sm);
    } else throw new Error(`unknown ${r.fn}/${r.arg}`);
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 4);
});
