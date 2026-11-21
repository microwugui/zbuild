// 第 132 批：insertPrefixedDeclaration / lowerInset（Go 探针 17 例，逐字节）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { RDeclaration, Rule, Token as ASTToken } from "../css_ast/css_ast.ts";
import { Range, Loc } from "../logger/logger.ts";
import { insertPrefixedDeclaration, lowerInset } from "./css_decls.ts";
import { knownDeclarations } from "./known_declarations_generated.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/decl-ins-go.json", import.meta.url)));
const SHA = "c3bee11a04e4e1d566d87d42cca9d4c0e24828b1d133df98841daec962a0c7ef";
const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);
const token = (text: string, dimension = false): ASTToken => {
  const t = new ASTToken();
  t.Kind = dimension ? 26 : 29; t.Text = text; t.Loc = 1;
  if (dimension) t.UnitOffset = text.length - 2;
  return t;
};
const decl = (name: string, vals: string[], dimension = false): RDeclaration => {
  const d = new RDeclaration(); d.Key = knownDeclarations.get(name) ?? 0; d.KeyText = name; d.KeyRange = new Range(new Loc(1), name.length);
  d.Value = vals.map((v) => token(v, dimension)); return d;
};
const rule = (d: RDeclaration): Rule => { const r = new Rule(); r.Loc = 3; r.Data = d; return r; };
const dump = (rules: Rule[]): any[] => rules.map((r) => {
  const d = r.Data;
  if (!(d instanceof RDeclaration)) return { t: "other" };
  return { key: d.KeyText, val: d.Value.map((t: any) => t.Text), important: d.Important };
});

test("decl-ins fixture sha256 + 17 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  const prefixValues = [["text"], ["border-box"], ["sticky"], ["stretch"], ["stretch"], ["none"], ["add", "subtract"], ["red"], ["red"]];
  let pi = 0;
  for (const r of rows) {
    let got: any;
    if (r.fn === "insertPrefixedDeclaration") {
      const a = r.arg;
      const d = decl(a.name, prefixValues[pi++], false);
      got = dump(insertPrefixedDeclaration([rule(d)], a.prefix, 3, d, new Set(a.existing ?? [])));
    } else {
      const a = r.arg;
      const d = decl("inset", a.vals, true);
      const v = lowerInset(0, d, a.minify);
      got = { ok: v.ok, rules: dump(v.rules) };
    }
    assert.equal(JSON.stringify(canon(got)), JSON.stringify(canon(r.out)), `${r.fn} ${JSON.stringify(r.arg)} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 17);
});
