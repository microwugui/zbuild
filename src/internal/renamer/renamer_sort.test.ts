// 第 53 轮叶子优先规划：renamer sort.Interface 助手（Go 探针固化，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { StableSymbolCount, StableSymbolCountArray, slotAndCount, slotAndCountArray } from "./renamer.ts";

const FIXTURE = new URL("../../../testdata/renamer-sort-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "cec162bf3975610ef8e0ae40e4bd6d5de0643e7f844c3b22c47b326045c4df47";

interface Row { fn: string; arg: string; out: string; }

test("renamer-sort fixture sha256 + 6 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "renamer-sort fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    if (r.fn === "StableSymbolCountArray") {
      const raw: number[][] = JSON.parse(r.arg);
      const a = new StableSymbolCountArray(raw.map((x) => {
        const s = new StableSymbolCount();
        s.StableSourceIndex = x[0]; s.RefInnerIndex = x[1]; s.Count = x[2];
        return s;
      }));
      const less: string[] = [];
      for (let i = 0; i < a.Len(); i++) for (let j = 0; j < a.Len(); j++) less.push(String(a.Less(i, j)));
      if (a.Len() >= 2) a.Swap(0, a.Len() - 1);
      const dump = a.items.map((x) => `(${x.StableSourceIndex},${x.RefInnerIndex},${x.Count})`).join("");
      got = `${a.Len()}|${less.join(",")}|${dump}`;
    } else if (r.fn === "slotAndCountArray") {
      const raw: number[][] = JSON.parse(r.arg);
      const a = new slotAndCountArray(raw.map((x) => {
        const s = new slotAndCount(); s.slot = x[0]; s.count = x[1]; return s;
      }));
      const less: string[] = [];
      for (let i = 0; i < a.Len(); i++) for (let j = 0; j < a.Len(); j++) less.push(String(a.Less(i, j)));
      if (a.Len() >= 2) a.Swap(0, a.Len() - 1);
      const dump = a.items.map((x) => `(${x.slot},${x.count})`).join("");
      got = `${a.Len()}|${less.join(",")}|${dump}`;
    } else throw new Error(`unknown ${r.fn}`);
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 6);
});
