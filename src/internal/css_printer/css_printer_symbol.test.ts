// 第 75 轮叶子优先规划：css_printer printSymbol（Go 探针固化，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { InvalidRef, NewSymbolMap, Ref, Symbol, SymbolKind } from "../ast/ast.ts";
import { Printer } from "./css_printer.ts";

const FIXTURE = new URL("../../../testdata/css-printer-symbol-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "1283b86a03dbfcd1260b4f4e928639b1ac82064be96e4818c59d6d62a1df3b58";

interface Row { fn: string; arg: string; out: string; }

test("css-printer-symbol fixture sha256 + 6 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-printer-symbol fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const parts = r.arg.split("|");
    const inner = Number(parts[0]), mode = Number(parts[1]), ws = Number(parts[2]), local = parts[3];
    const sm = NewSymbolMap(1);
    const mk = (name: string, link: Ref): Symbol => { const s = new Symbol(); s.OriginalName = name; s.Link = link; s.Kind = SymbolKind.SymbolHoisted; return s; };
    sm.SymbolsForSource[0] = [
      mk("foo", InvalidRef), mk("alias", new Ref(0, 0)), mk("2x", InvalidRef), mk("日本", InvalidRef),
    ];
    const p = new Printer();
    p.symbols = sm;
    if (local !== "") p.localNames.set(`${0}:${inner}`, local);
    p.printSymbol(new Ref(0, inner), mode, ws);
    assert.equal(Buffer.from(p.css).toString("base64"), r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 6);
});
