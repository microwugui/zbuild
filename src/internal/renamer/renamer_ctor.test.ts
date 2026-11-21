// 第 54 轮叶子优先规划：renamer 构造器 + NameForSymbol（Go 探针固化，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { InvalidRef, MakeIndex32, NewSymbolMap, Ref, Symbol, SymbolFlags, SymbolKind } from "../ast/ast.ts";
import { NewMinifyRenamer, NewNoOpRenamer, NewNumberRenamer } from "./renamer.ts";

const FIXTURE = new URL("../../../testdata/renamer-ctor-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "8dfa1977796adb0872ece824218bffa42eaaec58958d3990a74496d31f650161";

interface Row { fn: string; arg: string; out: string; }
function buildSymbols() {
  const sm = NewSymbolMap(1);
  const mk = (name: string, kind: number, flags: number, link: Ref, nested: ReturnType<typeof MakeIndex32> | null): Symbol => {
    const s = new Symbol();
    s.OriginalName = name; s.Kind = kind; s.Flags = flags; s.Link = link;
    if (nested) s.NestedScopeSlot = nested;
    return s;
  };
  sm.SymbolsForSource[0] = [
    mk("foo", SymbolKind.SymbolHoisted, 0, InvalidRef, null),
    mk("alias", SymbolKind.SymbolHoisted, 0, new Ref(0, 0), null),
    mk("pinned", SymbolKind.SymbolHoisted, SymbolFlags.MustNotBeRenamed, InvalidRef, null),
    mk("bar", SymbolKind.SymbolHoisted, 0, InvalidRef, MakeIndex32(0)),
    mk("unbound", SymbolKind.SymbolUnbound, 0, InvalidRef, null),
  ];
  return sm;
}
function refOf(s: string): Ref {
  const p = s.indexOf(":");
  return new Ref(Number(s.slice(0, p)), Number(s.slice(p + 1)));
}

test("renamer-ctor fixture sha256 + 15 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "renamer-ctor fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));

  const noOp = NewNoOpRenamer(buildSymbols());
  const mr = NewMinifyRenamer(buildSymbols(), [1, 0, 0, 0], new Map([["foo", 1]]));
  mr.slots[0][0].name = "a";
  mr.topLevelSymbolToSlot.set("0:0", 0);
  const nr = NewNumberRenamer(buildSymbols(), new Map([["foo", 1]]));
  nr.names[0] = new Array(5);
  nr.names[0][0] = "X";

  for (const r of rows) {
    let got: string;
    if (r.fn === "noOp") got = noOp.NameForSymbol(refOf(r.arg));
    else if (r.fn === "minify") got = mr.NameForSymbol(refOf(r.arg));
    else if (r.fn === "number") got = nr.NameForSymbol(refOf(r.arg));
    else throw new Error(`unknown ${r.fn}`);
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 15);
});
