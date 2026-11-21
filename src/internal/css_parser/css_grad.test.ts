// 第 111 批：gradient token 助手 4 函数（Go 探针 7 例，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NewF64 } from "../helpers/float.ts";
import { Token } from "../css_ast/css_ast.ts";
import { makePositionToken, makeColorToken, switchToSinglePositions, switchToDoublePositions, ColorStop } from "./css_decls_gradient.ts";
import type { valueWithUnit } from "./css_decls_gradient.ts";

const FIXTURE = new URL("../../../testdata/css-grad-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "4a4b67b73ee785988840f461ef3afeb5620d7146c2f0dae7823d97a9ff9adde0";
interface Row { fn: string; loc: number; terms?: any[]; xyza?: number[]; stops?: any[]; out: any }
function toTok(x: any): Token { const t = new Token(); t.Kind = x.k; t.Text = x.t; t.Whitespace = x.w ?? 0; return t; }
function dumpTok(t: Token): any { return [t.Kind, t.Text, t.Whitespace, t.Loc, t.UnitOffset, t.Children === null ? null : t.Children.map(dumpTok)]; }
function dumpStops(ss: ColorStop[]): any { return ss.map((s) => [s.positions.map(dumpTok), dumpTok(s.color), dumpTok(s.midpoint)]); }
function toStop(x: any): ColorStop { const s = new ColorStop(); s.positions = x.pos.map(toTok); s.color = toTok(x.color); if (x.mid) s.midpoint = toTok(x.mid); return s; }

test("css-grad fixture sha256 + 7 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-grad fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: any;
    switch (r.fn) {
      case "makePositionToken": {
        const terms: valueWithUnit[] = r.terms!.map((t) => ({ unit: t.unit, value: NewF64(t.value) }));
        got = dumpTok(makePositionToken(r.loc, terms)); break;
      }
      case "makeColorToken": {
        const [x, y, z, a] = r.xyza!.map(NewF64);
        got = dumpTok(makeColorToken(r.loc, x, y, z, a)); break;
      }
      case "switchToSinglePositions": got = dumpStops(switchToSinglePositions(r.stops!.map(toStop))); break;
      case "switchToDoublePositions": got = dumpStops(switchToDoublePositions(r.stops!.map(toStop))); break;
      default: throw new Error("unknown " + r.fn);
    }
    assert.equal(JSON.stringify(got), JSON.stringify(r.out), `${r.fn} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 7);
});
