// 第 116 批：parseGradient（Go 探针 18 例，逐字节）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Token } from "../css_ast/css_ast.ts";
import { parseGradient } from "./css_decls_gradient.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/css-pg-go.json", import.meta.url)));
const SHA = "b70a00af8a604bab01b30d40ac19765102ba707e39a5d79c95ed309a8995c30b";
function toTok(x: any): Token {
  const t = new Token(); t.Kind = x.k; t.Text = x.t; t.UnitOffset = x.u ?? 0;
  if (x.c) t.Children = x.c.map(toTok);
  return t;
}
const d = (t: Token): any => [t.Kind, t.Text];
const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);

test("css-pg fixture sha256 + 18 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const { gradient, ok } = parseGradient(toTok(r.tok));
    if (r.out === "FAIL") { assert.equal(ok, false, JSON.stringify(r.tok)); continue; }
    assert.equal(ok, true, JSON.stringify(r.tok));
    const got = {
      kind: gradient.kind, repeating: gradient.repeating,
      lead: gradient.leadingTokens.map(d),
      stops: gradient.colorStops.map((s: any) => ({ color: d(s.color), pos: s.positions.map(d), mid: d(s.midpoint) })),
    };
    assert.equal(JSON.stringify(canon(got)), JSON.stringify(canon(r.out)), JSON.stringify(r.tok));
  }
  assert.equal(rows.length, 18);
});
