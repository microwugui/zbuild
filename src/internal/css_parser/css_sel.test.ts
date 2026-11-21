// 第 106 批：selector 纯助手（Go 探针 11 例，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Loc } from "../logger/logger.ts";
import {
  CompoundSelector, ComplexSelector, SubclassSelector, SSPseudoClass, SSPseudoClassWithSelectorList,
  NamespacedName, NameToken, T,
} from "../css_ast/css_ast.ts";
import { mergeCompoundSelectors, containsLocalOrGlobalSelector, analyzeLeadingAmpersand } from "./css_parser_selector.ts";
import { compoundSelectorTermCount, complexSelectorTermCount } from "./css_nesting.ts";

const FIXTURE = new URL("../../../testdata/css-sel-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "f14efff202fddd6ac1bb92af350d27a26035858911aa380fb96fc00ba253f9ed";
interface Row { fn: string; a: any; b: any; flag: boolean; out: any }

function toCp(x: any): CompoundSelector {
  const c = new CompoundSelector();
  c.Combinator = x.cb ?? 0; c.WasEmptyFromLocalOrGlobal = !!x.empty;
  c.NestingSelectorLocs = Array.from({ length: x.nest ?? 0 }, (_, i) => i);
  if (x.ts) { const nn = new NamespacedName(); nn.Name = new NameToken(); nn.Name.Text = x.ts; nn.Name.Kind = T.TIdent; c.TypeSelector = nn; }
  c.SubclassSelectors = (x.sub ?? []).map((s: any) => {
    const sub = new SubclassSelector();
    if (s.ty === "pseudo") { const p = new SSPseudoClass(); p.Name = s.name; sub.Data = p; }
    else { const p = new SSPseudoClassWithSelectorList(); p.Kind = s.kind ?? 0; p.Selectors = (s.sels ?? []).map(toCx); sub.Data = p; }
    return sub;
  });
  return c;
}
function toCx(x: any): ComplexSelector { const c = new ComplexSelector(); c.Selectors = (x.sels ?? []).map(toCp); return c; }
function dumpCx(c: ComplexSelector): any {
  return c.Selectors.map((s) => {
    const ts = s.TypeSelector === null ? null : (s.TypeSelector as NamespacedName).Name.Text;
    const subs = (s.SubclassSelectors as SubclassSelector[]).map((ss) =>
      ss.Data instanceof SSPseudoClass ? ["pseudo", ss.Data.Name] :
      ["list", (ss.Data as SSPseudoClassWithSelectorList).Kind, dumpCxs((ss.Data as SSPseudoClassWithSelectorList).Selectors)]);
    return [ts, subs, s.NestingSelectorLocs.length, s.Combinator, s.WasEmptyFromLocalOrGlobal];
  });
}
function dumpCxs(cs: ComplexSelector[]): any { return cs.map(dumpCx); }

test("css-sel fixture sha256 + 11 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-sel fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: any;
    switch (r.fn) {
      case "containsLocalOrGlobalSelector": got = containsLocalOrGlobalSelector(toCx(r.a)); break;
      case "analyzeLeadingAmpersand": got = analyzeLeadingAmpersand(toCx(r.a), r.flag); break;
      case "compoundSelectorTermCount": got = compoundSelectorTermCount(toCp(r.a.sels[0])); break;
      case "complexSelectorTermCount": got = complexSelectorTermCount([toCx(r.a)]); break;
      case "mergeCompoundSelectors": { const t = toCp(r.a); mergeCompoundSelectors(t, toCp(r.b)); got = dumpCx({ Selectors: [t] } as ComplexSelector); } break;
      default: throw new Error("unknown " + r.fn);
    }
    assert.equal(JSON.stringify(got), JSON.stringify(r.out), `${r.fn} ${JSON.stringify(r.a)} ${JSON.stringify(r.b)} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 11);
});
