// 第 104 批：css calc 归约整链（Go 探针 27 例，out 由 Go 真实调用产生，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Token, T } from "../css_ast/css_ast.ts";
import { tryToReduceCalcExpression } from "./css_reduce_calc.ts";

const FIXTURE = new URL("../../../testdata/css-calc-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "ce98274bf6d6933b4c8dd1554af980487872ab1513e2ddb03caf8042b2a08bc0";
interface Row { tok: any; minify: boolean; out: any }

function toT(x: any): Token {
  const t = new Token();
  t.Kind = x.k; t.Text = x.t; t.UnitOffset = x.u ?? 0; t.Whitespace = x.w ?? 0; t.PayloadIndex = x.pi ?? 0;
  if (x.c) t.Children = x.c.map(toT);
  return t;
}
function dump(t: Token): any {
  return [t.Kind, t.Text, t.UnitOffset, t.Whitespace, t.PayloadIndex, t.Children === null ? null : t.Children.map(dump)];
}

test("css-calc fixture sha256 + 27 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-calc fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const got = dump(tryToReduceCalcExpression(toT(r.tok), r.minify));
    assert.equal(JSON.stringify(got), JSON.stringify(r.out), `minify=${r.minify} ${JSON.stringify(r.tok)} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 27);
});
