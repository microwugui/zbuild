// 第 56 轮叶子优先规划：renamer MinifyRenamer 计数/分配/命名链路（Go 探针固化，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DefaultNameMinifierJS, InvalidRef, MakeIndex32, NamespaceAlias, NewSymbolMap, Ref, Symbol, SymbolFlags, SymbolKind } from "../ast/ast.ts";
import { SymbolUse } from "../js_ast/js_ast.ts";
import { MinifyRenamer, NewMinifyRenamer, StableSymbolCountArray } from "./renamer.ts";

const FIXTURE = new URL("../../../testdata/renamer-minify-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "c47bee5e7e5df82c5777dc5c280ebe73a8222dc99e0938594f7d64dfe5ed70a5";

interface Row { fn: string; arg: string; out: string; }
const HOISTED = SymbolKind.SymbolHoisted;
function mk(name: string, kind: number, flags: number, nested: number, alias?: Ref): Symbol {
  const s = new Symbol();
  s.OriginalName = name; s.Kind = kind; s.Flags = flags; s.Link = InvalidRef;
  if (nested >= 0) s.NestedScopeSlot = MakeIndex32(nested);
  if (alias) s.NamespaceAlias = new NamespaceAlias("", alias);
  return s;
}
function dumpSlots(r: MinifyRenamer): string {
  let s = "";
  for (let ns = 0; ns < r.slots.length; ns++) {
    for (const sl of r.slots[ns]) s += `${ns}:${sl.name}:${sl.count}:${sl.needsCapitalForJSX};`;
  }
  return s;
}

test("renamer-minify fixture sha256 + 4 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "renamer-minify fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    if (r.arg === "main") {
      const sm = NewSymbolMap(2);
      sm.SymbolsForSource[0] = [
        mk("n0", HOISTED, 0, 0),
        mk("n1", HOISTED, SymbolFlags.MustStartWithCapitalLetterForJSX, 1),
        mk("top", HOISTED, 0, -1),
        mk("pinned", HOISTED, SymbolFlags.MustNotBeRenamed, -1),
        mk("ns", HOISTED, 0, 0),
        mk("viaAlias", HOISTED, 0, -1, new Ref(0, 4)),
        mk("lab", SymbolKind.SymbolLabel, 0, 0),
      ];
      const mr = NewMinifyRenamer(sm, [3, 1, 0, 0], new Map([["a", 1], ["b", 2]]));
      const uses = new Map<string, SymbolUse>();
      const add = (ii: number, count: number) => { const u = new SymbolUse(); u.CountEstimate = count; uses.set(`0:${ii}`, u); };
      add(0, 5); add(1, 9); add(2, 7); add(3, 100); add(5, 3); add(6, 4);
      const tops = new StableSymbolCountArray();
      mr.AccumulateSymbolUseCounts(tops, uses, [10, 20]);
      if (r.fn === "AccumulateSymbolUseCounts") {
        const dumpTops = tops.items.map((x) => `${x.StableSourceIndex}:${x.RefInnerIndex}:${x.Count},`).join("");
        got = dumpSlots(mr) + "|" + tops.Len() + "|" + dumpTops;
      } else if (r.fn === "AllocateTopLevelSymbolSlots") {
        mr.AllocateTopLevelSymbolSlots(tops);
        got = dumpSlots(mr) + "|" + mr.topLevelSymbolToSlot.size;
      } else if (r.fn === "AssignNamesByFrequency") {
        mr.AllocateTopLevelSymbolSlots(tops);
        mr.AssignNamesByFrequency(DefaultNameMinifierJS);
        got = dumpSlots(mr);
      } else throw new Error(`unknown ${r.fn}`);
    } else if (r.fn === "AssignNamesByFrequency" && r.arg === "label") {
      const sm = NewSymbolMap(1);
      sm.SymbolsForSource[0] = [mk("x", SymbolKind.SymbolLabel, 0, 0)];
      const mr = NewMinifyRenamer(sm, [0, 4, 0, 0], new Map());
      mr.slots[1][0].count = 5; mr.slots[1][1].count = 4; mr.slots[1][2].count = 3; mr.slots[1][3].count = 2;
      mr.AssignNamesByFrequency(DefaultNameMinifierJS);
      got = dumpSlots(mr);
    } else throw new Error(`unknown ${r.fn}/${r.arg}`);
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 4);
});
