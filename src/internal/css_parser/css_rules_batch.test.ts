// 第 127 批：scanForEndOfRule + mangleRules + DeadRuleRemover（Go 探针 17 例）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Tokenize } from "../css_lexer/css_lexer.ts";
import { Source, Loc, NewDeferLog, DeferLogKind, MakeLineColumnTracker } from "../logger/logger.ts";
import {
  Rule, RSelector, RDeclaration, RKnownAt, RAtMedia, RAtLayer, RComment,
  ComplexSelector, CompoundSelector, NamespacedName, NameToken, SubclassSelector,
  Token, MediaQuery, MQPlainOrBoolean, SSPseudoClassWithSelectorList, PseudoClassKindAll,
} from "../css_ast/css_ast.ts";
import { SymbolMap } from "../ast/ast.ts";
import { CSSParser, MakeDeadRuleMangler } from "./css_parser.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/rules-batch-go.json", import.meta.url)));
const SHA = "b57db24540ae21809186b7c418e0d77f3ccf71b50a4e21c435e374e9b223288f";
const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);
const mkParser = (src = ""): CSSParser => {
  const log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null);
  const source = new Source(); source.Contents = new TextEncoder().encode(src);
  const p = new CSSParser(); p.tokens = Tokenize(source).tokens; p.source = source; p.log = log;
  p.tracker = MakeLineColumnTracker(source); p.prevError = new Loc(0);
  return p;
};
const decl = (name: string, value: string): Rule => { const r = new Rule(); const d = new RDeclaration(); d.Key = 0; d.KeyText = name; const t = new Token(); t.Kind = 29; t.Text = value; d.Value = [t]; r.Data = d; return r; };
const sel = (name: string, rules: Rule[] = []): Rule => {
  const r = new Rule(); const s = new RSelector(); const c = new ComplexSelector(); const cp = new CompoundSelector();
  const n = new NamespacedName(); const nt = new NameToken(); nt.Text = name; nt.Kind = 29; n.Name = nt; cp.TypeSelector = n;
  c.Selectors = [cp]; s.Selectors = [c]; s.Rules = rules; r.Data = s; return r;
};
const knownAt = (name: string, rules: Rule[] = []): Rule => { const r = new Rule(); const d = new RKnownAt(); d.AtToken = name; d.Rules = rules; r.Data = d; return r; };
const media = (rules: Rule[] = []): Rule => { const r = new Rule(); const d = new RAtMedia(); const q = new MediaQuery(); const p = new MQPlainOrBoolean(); p.Name = "screen"; q.Data = p; d.Queries = [q]; d.Rules = rules; r.Data = d; return r; };
const comment = (): Rule => { const r = new Rule(); r.Data = new RComment(); return r; };
function dump(rules: Rule[]): any[] {
  return rules.map((r) => {
    const d = r.Data;
    if (d instanceof RSelector) return { t: "sel", names: d.Selectors.map((c) => c.Selectors[0]?.TypeSelector?.Name.Text), rules: dump(d.Rules) };
    if (d instanceof RDeclaration) return { t: "decl", key: d.Key, val: d.Value[0]?.Text };
    if (d instanceof RKnownAt) return { t: "at", name: d.AtToken, rules: dump(d.Rules) };
    if (d instanceof RAtMedia) return { t: "media", rules: dump(d.Rules) };
    if (d instanceof RComment) return { t: "comment" };
    if (d instanceof RAtLayer) return { t: "layer", rules: dump(d.Rules) };
    return { t: "other" };
  });
}
const sets: Rule[][] = [
  [sel("a", [decl("color", "red")]), sel("b", [decl("color", "red")])],
  [sel("a"), knownAt("media"), media(), decl("x", "y")],
  [sel("a", [decl("color", "red")]), comment(), sel("b", [decl("color", "red")])],
  [media([sel("a", [decl("color", "red")])])],
];

test("rules-batch fixture sha256 + 17 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: any;
    if (r.fn === "scanForEndOfRule") {
      got = mkParser(r.src).scanForEndOfRule();
    } else if (r.fn === "mangleRules") {
      got = dump(mkParser().mangleRules(sets[r.arg.set].map((x) => x), r.arg.top));
    } else if (r.fn === "RemoveDeadRulesInPlace") {
      const dead = new Rule(); const s = new RSelector(); const c = new ComplexSelector(); const cp = new CompoundSelector();
      const plist = new SSPseudoClassWithSelectorList(); plist.Kind = PseudoClassKindAll.PseudoClassIs;
      cp.SubclassSelectors = [new SubclassSelector(plist)]; c.Selectors = [cp]; s.Selectors = [c]; dead.Data = s;
      const input = [dead, sel("a", [decl("color", "red")]), sel("a", [decl("color", "red")])];
      got = dump(MakeDeadRuleMangler(new SymbolMap()).RemoveDeadRulesInPlace(0, input, []));
    } else throw new Error("unknown " + r.fn);
    assert.equal(JSON.stringify(canon(got)), JSON.stringify(canon(r.out)), `${r.fn} ${JSON.stringify(r.arg)} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 17);
});
