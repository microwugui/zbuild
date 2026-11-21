// 第 120 批：containsDeadSelectors / allSelectorsAreDead / isSafeSelectors（Go 探针 15 例）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  CompoundSelector, ComplexSelector, SSPseudoClass, SSPseudoClassWithSelectorList, SSAttribute,
  SubclassSelector, NamespacedName, NameToken, PseudoClassKindAll,
} from "../css_ast/css_ast.ts";
import { T } from "../css_lexer/css_lexer.ts";
import { CSSParser } from "./css_parser.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/css-safe-go.json", import.meta.url)));
const SHA = "200953e36d7bcdf48b214573d46f541ffe4531c27c5b434fd0c01d7482d41ffa";
const name = (text: string): NamespacedName => {
  const n = new NamespacedName(); n.Name = new NameToken(); n.Name.Text = text; n.Name.Kind = T.TIdent; return n;
};
const typeSel = (text: string): NamespacedName => name(text);
const sub = (data: any): SubclassSelector => new SubclassSelector(data);
function compounds(desc: string): CompoundSelector[] {
  const plain = (): CompoundSelector => new CompoundSelector();
  const div = plain(); div.TypeSelector = typeSel("div");
  const section = plain(); section.TypeSelector = typeSel("section");
  const ns = plain(); const n = typeSel("div"); n.NamespacePrefix = new NameToken(); n.NamespacePrefix.Text = "svg"; ns.TypeSelector = n;
  const nest = plain(); nest.NestingSelectorLocs = [0];
  const comb = plain(); comb.Combinator = 62; // '>'
  const wrap = (d: any): CompoundSelector => { const c = plain(); c.SubclassSelectors = [sub(d)]; return c; };
  const withIs = new SSPseudoClassWithSelectorList(); withIs.Kind = PseudoClassKindAll.PseudoClassIs;
  const withWhere = new SSPseudoClassWithSelectorList(); withWhere.Kind = PseudoClassKindAll.PseudoClassWhere;
  const emptyIs = wrap(withIs);
  const emptyWhere = wrap(withWhere);
  const attrData = new SSAttribute(); attrData.MatcherOp = "="; attrData.MatcherModifier = 105;
  const attr = wrap(attrData);
  const focusData = new SSPseudoClass(); focusData.Name = "focus";
  const focus = wrap(focusData);
  const hoverData = new SSPseudoClass(); hoverData.Name = "hover";
  const hover = wrap(hoverData);
  const listData = new SSPseudoClassWithSelectorList(); listData.Kind = PseudoClassKindAll.PseudoClassWhere;
  const listInner = new ComplexSelector(); listInner.Selectors = [div];
  listData.Selectors = [listInner];
  const withList = wrap(listData);
  switch (desc) {
    case "empty :is": return [emptyIs];
    case "normal div":
    case "plain div": return [div];
    case "plain then empty :is": return [div, emptyIs];
    case "all dead": return [emptyIs, emptyWhere];
    case "non-IE7 element": return [section];
    case "namespace": return [ns];
    case "nesting": return [nest];
    case "combinator": return [comb];
    case "attribute modifier": return [attr];
    case "focus": return [focus];
    case "hover": return [hover];
    case "pseudo with list": return [withList];
    case "multiple": return [div, hover];
    default: throw new Error(desc);
  }
}

test("css-safe fixture sha256 + 15 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  const p = new CSSParser();
  for (const r of rows) {
    let got: boolean;
    if (r.desc === "one live") {
      const a = new ComplexSelector(); a.Selectors = compounds("empty :is");
      const b = new ComplexSelector(); b.Selectors = compounds("normal div");
      got = p.allSelectorsAreDead([a, b]);
    } else {
      const cs = new ComplexSelector(); cs.Selectors = compounds(r.desc);
      switch (r.fn) {
        case "containsDeadSelectors": got = p.containsDeadSelectors(cs.Selectors); break;
        case "allSelectorsAreDead": got = p.allSelectorsAreDead([cs]); break;
        case "isSafeSelectors": got = p.isSafeSelectors([cs]); break;
        default: throw new Error(r.fn);
      }
    }
    assert.equal(got, r.out, `${r.fn} ${r.desc} => ${got} != ${r.out}`);
  }
  assert.equal(rows.length, 15);
});
