// 第 109 批：boxTracker 整簇（Go 探针 8 例，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Loc, Range } from "../logger/logger.ts";
import { Token, Rule, RDeclaration, RComment } from "../css_ast/css_ast.ts";
import { boxTracker } from "./css_decls_box.ts";

const FIXTURE = new URL("../../../testdata/css-box2-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "55565ecc975ba7fc74fbd627eaf7f72c58086dc9ee92d1f3b184ad30832b6df5";
interface Row { ops: any[]; minify: boolean; allowAuto: boolean; nrules: number; out: any[] }
function toTok(x: any): Token { const t = new Token(); t.Kind = x.k; t.Text = x.t; t.UnitOffset = x.u ?? 0; t.Whitespace = x.w ?? 0; return t; }
function dumpRules(rs: Rule[]): any[] {
  return rs.map((r) => {
    if (r.Data === null || r.Data instanceof RComment) return "empty";
    if (r.Data instanceof RDeclaration) {
      const d = r.Data;
      const toks = d.Value.map((t) => [t.Kind, t.Text, t.Whitespace]);
      return ["decl", d.Key, d.KeyText, toks, d.Important, r.Loc];
    }
    return "other";
  });
}

test("css-box2 fixture sha256 + 8 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-box2 fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const rules: Rule[] = [];
    for (let i = 0; i < r.nrules; i++) { const x = new Rule(); x.Data = new RComment(); x.Loc = i * 10; rules.push(x); }
    const box = new boxTracker(); box.key = 189; box.keyText = "margin"; box.allowAuto = r.allowAuto;
    for (const op of r.ops) {
      const toks = op.toks.map(toTok);
      const decl = new RDeclaration(); decl.Key = box.key; decl.KeyText = box.keyText; decl.Value = toks; decl.Important = op.imp;
      decl.KeyRange = new Range(new Loc(rules.length * 10), 6);
      const nr = new Rule(); rules.push(nr);
      if (op.m === "mangleSides") box.mangleSides(rules, decl, r.minify);
      else box.mangleSide(rules, decl, r.minify, op.side);
    }
    const got = dumpRules(rules);
    assert.equal(JSON.stringify(got), JSON.stringify(r.out), `ops=${r.ops.map((o: any) => o.m)} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 8);
});
