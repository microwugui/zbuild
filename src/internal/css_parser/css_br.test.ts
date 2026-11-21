// 第 110 批：borderRadiusTracker 整簇（Go 探针 7 例，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Loc, Range } from "../logger/logger.ts";
import { Token, Rule, RDeclaration, RComment } from "../css_ast/css_ast.ts";
import { borderRadiusTracker } from "./css_decls_border_radius.ts";

const FIXTURE = new URL("../../../testdata/css-br-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "fb88ccc9da7011d6e764af2756e0f7ba61f7de0d7a17aa7acb76a2b5cec27119";
interface Row { ops: any[]; minify: boolean; nrules: number; out: any[] }
function toTok(x: any): Token { const t = new Token(); t.Kind = x.k; t.Text = x.t; t.UnitOffset = x.u ?? 0; t.Whitespace = x.w ?? 0; return t; }
function dumpRules(rs: Rule[]): any[] {
  return rs.map((r) => {
    if (r.Data === null || r.Data instanceof RComment) return "empty";
    if (r.Data instanceof RDeclaration) {
      const d = r.Data;
      return ["decl", d.Key, d.KeyText, d.Value.map((t) => [t.Kind, t.Text, t.Whitespace]), d.Important, r.Loc];
    }
    return "other";
  });
}

test("css-br fixture sha256 + 7 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-br fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const rules: Rule[] = [];
    for (let i = 0; i < r.nrules; i++) { const x = new Rule(); x.Data = new RComment(); x.Loc = i * 10; rules.push(x); }
    const br = new borderRadiusTracker();
    for (const op of r.ops) {
      const toks = op.toks.map(toTok);
      const decl = new RDeclaration(); decl.Key = 66; decl.KeyText = "border-radius"; decl.Value = toks; decl.Important = op.imp;
      decl.KeyRange = new Range(new Loc(rules.length * 10), 13);
      rules.push(new Rule());
      if (op.m === "mangleCorners") br.mangleCorners(rules, decl, r.minify);
      else br.mangleCorner(rules, decl, r.minify, op.corner);
    }
    const got = dumpRules(rules);
    assert.equal(JSON.stringify(got), JSON.stringify(r.out), `ops=${r.ops.map((o: any) => o.m)} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 7);
});
