// 第 129 批：nesting 纯助手 4 函数（Go 探针 8 例，逐字节）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Source, Loc, NewDeferLog, DeferLogKind, MakeLineColumnTracker, MsgKind } from "../logger/logger.ts";
import {
  CompoundSelector, ComplexSelector, SubclassSelector, NamespacedName, NameToken,
  SSPseudoClass, SSPseudoClassWithSelectorList, PseudoClassKindAll,
} from "../css_ast/css_ast.ts";
import { CSSParser } from "./css_parser.ts";
import { compoundSelectorTermCount, complexSelectorTermCount, addExpansionError, substituteAmpersandsInCompoundSelector, multipleComplexSelectorsToSingleComplexSelector, reportNestingWithGeneratedPseudoClassIs, keepLeadingCombinator } from "./css_nesting.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/nest-helpers-go.json", import.meta.url)));
const SHA = "73d913db3a97a105bb5959a89b72b9c6b5b41745a1c0716a93f2ebf82400b36d";
const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);
const mk = (): CSSParser => {
  const log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null);
  const source = new Source(); source.Contents = new TextEncoder().encode("abcdefghijklmnopqrstuvwxyz");
  const p = new CSSParser(); p.log = log; p.tracker = MakeLineColumnTracker(source); p.source = source;
  return p;
};
const plain = (name: string): CompoundSelector => { const s = new CompoundSelector(); const n = new NamespacedName(); const t = new NameToken(); t.Text = name; t.Kind = 29; n.Name = t; s.TypeSelector = n; return s; };
const plist = (kind: number, ...sels: ComplexSelector[]): SubclassSelector => {
  const d = new SSPseudoClassWithSelectorList(); d.Kind = kind; d.Selectors = sels;
  return new SubclassSelector(d);
};
function dCompound(s: CompoundSelector): any {
  const subs: any[] = [];
  for (const ss of s.SubclassSelectors as SubclassSelector[]) {
    const d = ss.Data;
    if (d instanceof SSPseudoClass) subs.push({ t: "pseudo", name: d.Name, element: d.IsElement });
    else if (d instanceof SSPseudoClassWithSelectorList) subs.push({ t: "plist", kind: d.Kind, selectors: d.Selectors.map((c) => c.Selectors.map(dCompound)) });
    else subs.push({ t: "other" });
  }
  const type = s.TypeSelector === null ? null : (s.TypeSelector as NamespacedName).Name.Text;
  return { type, subs, nesting: s.NestingSelectorLocs, comb: s.Combinator };
}
const msgs = (p: CSSParser): string[] => p.log.Done().map((m: any) => `${m.Kind}|${m.Data.Text}`);

test("nest-helpers fixture sha256 + 8 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: any;
    const p = mk();
    switch (r.fn) {
      case "compoundSelectorTermCount":
      case "complexSelectorTermCount": {
        const inner = new ComplexSelector(); inner.Selectors = [plain("a"), plain("b")];
        const comp = plain("div");
        const h = new SSPseudoClass(); h.Name = "hover";
        comp.SubclassSelectors = [plist(PseudoClassKindAll.PseudoClassIs, inner), new SubclassSelector(h)];
        const complex = new ComplexSelector(); complex.Selectors = [comp];
        got = r.fn === "compoundSelectorTermCount" ? compoundSelectorTermCount(comp) : complexSelectorTermCount([complex]);
        break;
      }
      case "addExpansionError": addExpansionError(p, 3, 100); got = msgs(p); break;
      case "substituteAmpersandsInCompoundSelector": {
        const sel = plain("div"); sel.NestingSelectorLocs = [2];
        const h = new SSPseudoClass(); h.Name = "hover"; sel.SubclassSelectors = [new SubclassSelector(h)];
        const repl = (loc: number): ComplexSelector => {
          if (r.arg === "single") { const c = plain(".foo"); return { Selectors: [c] } as ComplexSelector; }
          const a = plain(".a"), b = plain(".b"); a.Combinator = 62;
          return { Selectors: [a, b] } as ComplexSelector;
        };
        got = { result: substituteAmpersandsInCompoundSelector(p, sel, repl, [], keepLeadingCombinator).map(dCompound), msgs: msgs(p) };
        break;
      }
      case "multipleComplexSelectorsToSingleComplexSelector": {
        const a = plain("a"), b = plain("b"); b.Combinator = 62;
        const f = multipleComplexSelectorsToSingleComplexSelector(p, [{ Selectors: [a] } as ComplexSelector, { Selectors: [b] } as ComplexSelector]);
        got = [f(7)].map((c) => c.Selectors.map(dCompound));
        break;
      }
      case "reportNestingWithGeneratedPseudoClassIs": {
        p.options.unsupportedCSSFeatures = r.arg ? 256 : 0;
        p.options.originalTargetEnv = "chrome100";
        reportNestingWithGeneratedPseudoClassIs(p, 1);
        reportNestingWithGeneratedPseudoClassIs(p, 1);
        got = msgs(p);
        break;
      }
      default: throw new Error("unknown " + r.fn);
    }
    assert.equal(JSON.stringify(canon(got)), JSON.stringify(canon(r.out)), `${r.fn} ${JSON.stringify(r.arg)} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 8);
});
