// 第 136 批：parseListOfDeclarations / parseAtRule / parseQualifiedRule /
// parseSelectorRule / parseListOfRules 本体（Go 探针 236 例，逐字节）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Tokenize, T } from "../css_lexer/css_lexer.ts";
import { Source, Loc, Range, NewDeferLog, DeferLogKind, MakeLineColumnTracker } from "../logger/logger.ts";
import {
  Rule, RAtCharset, RAtImport, RAtKeyframes, RAtLayer, RAtMedia, RAtScope, RKnownAt,
  RUnknownAt, RSelector, RQualified, RDeclaration, RBadDeclaration, RComment,
  NamespacedName, SSHash, SSClass, SSAttribute, SSPseudoClass, SSPseudoClassWithSelectorList,
} from "../css_ast/css_ast.ts";
import { CSSParser } from "./css_parser.ts";
import {
  parseListOfDeclarations, parseListOfRules, parseAtRule, parseQualifiedRule, parseSelectorRule,
  atRuleValid, atRuleInvalid, atRuleInvalidAfter,
} from "./css_parser.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/main-chain2-go.json", import.meta.url)));
const SHA = "42127dd468520f43ef62b454c000a56311facb564f85aa1920225281cda15a6c";
const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);

function dToks(toks: any[]): any[] {
  return toks.map((t) => [
    t.Kind, t.Text, t.Whitespace, t.UnitOffset, t.PayloadIndex, t.Loc,
    t.Children ? dToks(t.Children) : null,
  ]);
}
function dName(n: any): any {
  const pref = n.NamespacePrefix ? [n.NamespacePrefix.Text, n.NamespacePrefix.Range.Loc.Start, n.NamespacePrefix.Kind] : null;
  return [pref, n.Name.Text, n.Name.Range.Loc.Start, n.Name.Kind];
}
function dSS(ss: any): any {
  if (ss instanceof SSHash) return ["hash", ss.Name.Ref.InnerIndex];
  if (ss instanceof SSClass) return ["class", ss.Name.Ref.InnerIndex];
  if (ss instanceof SSAttribute) return ["attr", ss.MatcherOp, ss.MatcherValue, dName(ss.NamespacedName), ss.MatcherModifier];
  if (ss instanceof SSPseudoClass) return ["pc", ss.Name, dToks(ss.Args), ss.IsElement];
  if (ss instanceof SSPseudoClassWithSelectorList) return ["pcs", dComplex(ss.Selectors), ss.Index.A, ss.Index.B, ss.Kind];
  return ["?"];
}
function dCompound(c: any): any {
  const ts = c.TypeSelector ? dName(c.TypeSelector) : null;
  const sss = (c.SubclassSelectors as any[]).map((ss) => dSS(ss.Data));
  return [ts, sss, c.NestingSelectorLocs, c.CombinatorLoc, c.Combinator, c.WasEmptyFromLocalOrGlobal];
}
function dComplex(cs: any[]): any { return cs.map((c) => (c.Selectors as any[]).map(dCompound)); }
function dMQ(q: any): any { return [q.Loc, q.Data.Hash()]; }
function dMQs(qs: any[]): any { return qs.map(dMQ); }
function dRules(rules: Rule[]): any[] {
  const out: any[] = [];
  for (const r of rules) {
    const base: any[] = [r.Loc];
    const d: any = r.Data;
    if (d instanceof RAtCharset) out.push(["charset", ...base, d.Encoding]);
    else if (d instanceof RAtImport) {
      let cond: any = null;
      if (d.ImportConditions) cond = [dToks(d.ImportConditions.Layers), dToks(d.ImportConditions.Supports), dMQs(d.ImportConditions.Queries)];
      out.push(["import", ...base, d.ImportRecordIndex, cond]);
    } else if (d instanceof RAtKeyframes) {
      const blocks = d.Blocks.map((b) => [b.Selectors, dRules(b.Rules), b.Loc, b.CloseBraceLoc]);
      out.push(["keyframes", ...base, d.AtToken, d.Name.Ref.InnerIndex, blocks, d.CloseBraceLoc]);
    } else if (d instanceof RAtLayer) out.push(["layer", ...base, d.Names, dRules(d.Rules), d.CloseBraceLoc]);
    else if (d instanceof RAtMedia) out.push(["media", ...base, dMQs(d.Queries), dRules(d.Rules), d.CloseBraceLoc]);
    else if (d instanceof RAtScope) out.push(["scope", ...base, dComplex(d.Start), dComplex(d.End), dRules(d.Rules), d.CloseBraceLoc]);
    else if (d instanceof RKnownAt) out.push(["known", ...base, d.AtToken, dToks(d.Prelude), dRules(d.Rules), d.CloseBraceLoc]);
    else if (d instanceof RUnknownAt) out.push(["unknown", ...base, d.AtToken, dToks(d.Prelude), dToks(d.Block)]);
    else if (d instanceof RSelector) out.push(["sel", ...base, dComplex(d.Selectors), dRules(d.Rules), d.CloseBraceLoc]);
    else if (d instanceof RQualified) out.push(["qualified", ...base, dToks(d.Prelude), dRules(d.Rules), d.CloseBraceLoc]);
    else if (d instanceof RDeclaration) out.push(["decl", ...base, d.Key, d.KeyText, dToks(d.Value), d.Important, d.KeyRange.Loc.Start, d.KeyRange.Len]);
    else if (d instanceof RBadDeclaration) out.push(["baddecl", ...base, dToks(d.Tokens)]);
    else if (d instanceof RComment) out.push(["comment", ...base, d.Text]);
    else out.push(["other", ...base]);
  }
  return out;
}
function dMsgs(log: any): any[] {
  return log.Done().map((m: any) => [m.ID, m.Data.Text, (m.Notes ?? []).map((nd: any) => nd.Text)]);
}
function mkParser(src: string, minify: boolean, feature: number): CSSParser {
  const log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null);
  const source = new Source(); source.Contents = new TextEncoder().encode(src);
  const p = new CSSParser(); p.tokens = Tokenize(source).tokens; p.source = source; p.log = log;
  p.tracker = MakeLineColumnTracker(source); p.prevError = new Loc(-1);
  p.options.minifySyntax = minify; p.options.minifyWhitespace = minify;
  p.options.unsupportedCSSFeatures = feature;
  return p;
}

test("main-chain2 fixture sha256 + 236 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const p = mkParser(r.src, r.minify, r.feature);
    let rules: Rule[];
    if (r.fn === "parseListOfDeclarations") {
      rules = parseListOfDeclarations(p, { canInlineNoOpNesting: true });
    } else if (r.fn === "parseQualifiedRule") {
      rules = [parseQualifiedRule(p, { isTopLevel: r.top, isDeclarationContext: r.declctx })];
    } else if (r.fn === "parseSelectorRule") {
      rules = [parseSelectorRule(p, r.top, {})];
    } else if (r.fn === "parseAtRule") {
      rules = [parseAtRule(p, {
        charsetValidity: r.valid, importValidity: r.valid, afterLoc: 5,
        isDeclarationList: r.declctx, canInlineNoOpNesting: true,
      })];
    } else if (r.fn === "parseListOfRules") {
      rules = parseListOfRules(p, { isTopLevel: r.top, parseSelectors: true });
    } else throw new Error("unknown fn " + r.fn);
    const got: any = {
      rules: dRules(rules), msgs: dMsgs(p.log), idx: p.index,
      nesting: p.nestingIsPresent, subtree: p.inSelectorSubtree,
      layer: p.enclosingLayer.length ? p.enclosingLayer : null,
      postLayers: p.layersPostImport,
      imports: p.importRecords.map((x: any) => [x.Kind, x.Path.Text, x.Range.Loc.Start, x.Range.Len]),
      seenImport: p.hasSeenAtImport,
    };
    assert.equal(JSON.stringify(canon(got)), JSON.stringify(canon(r.out)),
      `${r.fn} ${JSON.stringify(r.src)} m=${r.minify} f=${r.feature} top=${r.top} decl=${r.declctx} valid=${r.valid} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 236);
});
