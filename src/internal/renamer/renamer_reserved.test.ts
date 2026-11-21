// 第 57 轮叶子优先规划：renamer 保留名 + 嵌套槽位链路（Go 探针固化，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { InvalidRef, LocRef, NewSymbolMap, Ref, Symbol as ASymbol, SymbolFlags, SymbolKind } from "../ast/ast.ts";
import { Scope, ScopeMember } from "../js_ast/js_ast.ts";
import { AssignNestedScopeSlots, ComputeReservedNames } from "./renamer.ts";

const FIXTURE = new URL("../../../testdata/renamer-reserved-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "0f943ffcbcbd686ac35fbf3ca1fb1871ab746bb21ed6ee8638b711df42901d0e";

interface Row { fn: string; arg: string; out: string; }
const HOISTED = SymbolKind.SymbolHoisted;
function mk(name: string, kind: number, flags: number): ASymbol {
  const s = new ASymbol();
  s.OriginalName = name; s.Kind = kind; s.Flags = flags; s.Link = InvalidRef;
  return s;
}
function member(ii: number): ScopeMember { const m = new ScopeMember(); m.Ref = new Ref(0, ii); return m; }
function dumpNames(m: Map<string, number>): string {
  return [...m.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0).map(([k, v]) => `${k}=${v}`).join(",");
}

test("renamer-reserved fixture sha256 + 2 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "renamer-reserved fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    if (r.fn === "ComputeReservedNames") {
      const sm = NewSymbolMap(1);
      sm.SymbolsForSource[0] = [
        mk("unboundName", SymbolKind.SymbolUnbound, 0),
        mk("pinnedName", HOISTED, SymbolFlags.MustNotBeRenamed),
        mk("normalName", HOISTED, 0),
        mk("evalChildName", SymbolKind.SymbolUnbound, 0),
      ];
      const child = new Scope(); child.ContainsDirectEval = true; child.Members.set("evalChildName", member(3));
      const noEvalChild = new Scope(); noEvalChild.Members.set("ignored", member(2));
      const root = new Scope();
      root.Members.set("u", member(0)); root.Members.set("p", member(1)); root.Members.set("n", member(2));
      root.Generated.push(new Ref(0, 1));
      root.ContainsDirectEval = true;
      root.Children.push(child, noEvalChild);
      got = dumpNames(ComputeReservedNames([root], sm));
    } else if (r.fn === "AssignNestedScopeSlots") {
      const syms = [
        mk("topA", HOISTED, 0), mk("topB", HOISTED, 0), mk("nestedX", HOISTED, 0),
        mk("nestedY", HOISTED, 0), mk("nestedPinned", HOISTED, SymbolFlags.MustNotBeRenamed),
        mk("label", SymbolKind.SymbolLabel, 0), mk("grandZ", HOISTED, 0),
      ];
      const grand = new Scope(); grand.Members.set("z", member(6));
      const child = new Scope();
      child.Members.set("x", member(2)); child.Members.set("p", member(4));
      child.Generated.push(new Ref(0, 3));
      child.Label = new LocRef(undefined, new Ref(0, 5));
      child.Children.push(grand);
      const root = new Scope();
      root.Members.set("topA", member(0)); root.Generated.push(new Ref(0, 1));
      root.Children.push(child);
      const counts = AssignNestedScopeSlots(root, syms);
      const slots = syms.map((s, i) => `${i}:${s.NestedScopeSlot.IsValid() ? s.NestedScopeSlot.GetIndex() : "invalid"},`).join("");
      got = slots + "|[" + counts.values.slice(0, 4).join(",") + "]";
    } else throw new Error(`unknown ${r.fn}`);
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 2);
});
