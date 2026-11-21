// 第 130 批：nesting lowering 三函数（Go 探针 7 例，逐字节）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Source, Loc, NewDeferLog, DeferLogKind, MakeLineColumnTracker } from "../logger/logger.ts";
import {
  Rule, RSelector, RKnownAt, RAtMedia, RAtLayer, RDeclaration,
  CompoundSelector, ComplexSelector, NamespacedName, NameToken, SubclassSelector, SSPseudoClass, Token,
} from "../css_ast/css_ast.ts";
import { CSSParser } from "./css_parser.ts";
import { lowerNestingContext, lowerNestingInRule, lowerNestingInRulesAndReturnRemaining, lowerNestingInRuleWithContext } from "./css_nesting.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/nest-lower-go.json", import.meta.url)));
const SHA = "e8a9166de68b8e417ba9dac348355f9e0e1f8c35dc6957b1c4c7d37d4be57901";
const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);
const mk = (): CSSParser => {
  const log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null);
  const source = new Source(); source.Contents = new TextEncoder().encode("abcdefghijklmnop");
  const p = new CSSParser(); p.log = log; p.source = source; p.tracker = MakeLineColumnTracker(source);
  return p;
};
const compound = (text: string): CompoundSelector => {
  const c = new CompoundSelector();
  if (text === "&") c.NestingSelectorLocs = [1];
  else { const n = new NamespacedName(); const t = new NameToken(); t.Text = text; t.Kind = 29; n.Name = t; c.TypeSelector = n; }
  return c;
};
const complex = (...texts: string[]): ComplexSelector => { const c = new ComplexSelector(); c.Selectors = texts.map(compound); return c; };
const decl = (name: string): Rule => { const r = new Rule(); r.Loc = 2; const d = new RDeclaration(); d.Key = 0; d.KeyText = name; const t = new Token(); t.Kind = 29; t.Text = "red"; d.Value = [t]; r.Data = d; return r; };
const selector = (sels: ComplexSelector[], rules: Rule[]): Rule => { const r = new Rule(); r.Loc = 0; const s = new RSelector(); s.Selectors = sels; s.Rules = rules; r.Data = s; return r; };
const at = (name: string, rules: Rule[]): Rule => { const r = new Rule(); const d = new RKnownAt(); d.AtToken = name; d.Rules = rules; r.Data = d; return r; };
function dump(rules: Rule[]): any[] {
  const out: any[] = [];
  for (const r of rules) {
    const d = r.Data;
    if (d instanceof RSelector) out.push({ t: "sel", selectors: d.Selectors.map((c) => c.Selectors.map((cp) => ({ type: cp.TypeSelector === null ? null : (cp.TypeSelector as NamespacedName).Name.Text, nest: cp.NestingSelectorLocs, comb: cp.Combinator }))), rules: dump(d.Rules) });
    else if (d instanceof RDeclaration) out.push({ t: "decl", name: d.KeyText });
    else if (d instanceof RKnownAt) out.push({ t: "at", name: d.AtToken, rules: dump(d.Rules) });
    else if (d instanceof RAtMedia) out.push({ t: "media", rules: dump(d.Rules) });
    else if (d instanceof RAtLayer) out.push({ t: "layer", rules: dump(d.Rules) });
    else out.push({ t: "other" });
  }
  return out;
}

test("nest-lower fixture sha256 + 7 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  const cases: Record<string, Rule> = {
    "nested-desc": selector([complex("div")], [selector([complex("&", "b")], [decl("color")])]),
    "nested-hover": selector([complex("div")], [selector([complex("&")], [decl("color")])]),
    "relative": selector([complex("div")], [selector([complex("b")], [decl("color")])]),
    "at-rule": selector([complex("div")], [at("supports", [decl("color")])]),
  };
  for (const r of rows) {
    let got: any;
    const p = mk();
    if (r.fn === "lowerNestingInRule") got = dump(lowerNestingInRule(p, cases[r.case], []));
    else if (r.fn === "lowerNestingInRuleWithContext") {
      const ctx = new lowerNestingContext();
      ctx.parentSelectorsNoPseudo = [complex("div"), complex("span")];
      ctx.parentSelectorsWithPseudo = ctx.parentSelectorsNoPseudo;
      const input = r.case === "sel" ? selector([complex("&", "b")], [decl("color")]) : at("supports", [decl("color")]);
      got = { rule: dump([lowerNestingInRuleWithContext(p, input, ctx)]), lowered: dump(ctx.loweredRules) };
    } else if (r.fn === "lowerNestingInRulesAndReturnRemaining") {
      const ctx = new lowerNestingContext();
      ctx.parentSelectorsNoPseudo = [complex("div"), complex("span")];
      ctx.parentSelectorsWithPseudo = ctx.parentSelectorsNoPseudo;
      const remain = lowerNestingInRulesAndReturnRemaining(p, [decl("color"), selector([complex("&")], [decl("x")])], ctx);
      got = { remaining: dump(remain), lowered: dump(ctx.loweredRules) };
    } else throw new Error("unknown " + r.fn);
    assert.equal(JSON.stringify(canon(got)), JSON.stringify(canon(r.out)), `${r.fn} ${r.case} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 7);
});
