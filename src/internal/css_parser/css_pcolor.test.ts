// 第 113 批：parseColor（Go 探针 22 例；xyz 走 1-ULP known-deviation 口径 toFixed10）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Token } from "../css_ast/css_ast.ts";
import { parseColor, looksLikeColor } from "./css_decls_color.ts";

const FIXTURE = new URL("../../../testdata/css-pcolor-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "9b1a57763d479d530f9b1c415409fbee3318312570364a0a63d33066333525ed";
interface Row { tok: any; out: any }
function toTok(x: any): Token { const t = new Token(); t.Kind = x.k; t.Text = x.t; if (x.c) t.Children = x.c.map(toTok); return t; }

test("css-pcolor fixture sha256 + 22 例等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-pcolor fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const { color, ok } = parseColor(toTok(r.tok));
    if (r.out === "FAIL") { assert.equal(ok, false, `expect FAIL ${JSON.stringify(r.tok)}`); continue; }
    const got: any = [color.hasColorSpace, color.hex >>> 0,
      [color.x.Value(), color.y.Value(), color.z.Value()].map((v) => v.toFixed(10)).join(",")];
    assert.equal(ok, true, `expect ok ${JSON.stringify(r.tok)}`);
    assert.equal(JSON.stringify(got), JSON.stringify(r.out), `${JSON.stringify(r.tok)} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 22);
});

const F2 = new URL("../../../testdata/css-llc-go.json", import.meta.url);
const b2 = new Uint8Array(readFileSync(F2));
const S2 = "cc8fb8d14370aa3bd724dab410a04206d4f29ca162f5c1a27acd24e01d5518ed";
test("css-llc fixture sha256 + 11 例 looksLikeColor 等于 Go", () => {
  assert.equal(createHash("sha256").update(b2).digest("hex"), S2, "css-llc fixture sha256");
  const rows: { tok: any; out: boolean }[] = JSON.parse(new TextDecoder().decode(b2));
  for (const r of rows) assert.equal(looksLikeColor(toTok(r.tok)), r.out, JSON.stringify(r.tok));
  assert.equal(rows.length, 11);
});
