// 第 137 批：Parse / computeCharacterFrequency / OptionsFromConfig / Options.Equal（Go 探针 52 例）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Tokenize, T } from "../css_lexer/css_lexer.ts";
import { Source, Loc, Range, NewDeferLog, DeferLogKind, MakeLineColumnTracker } from "../logger/logger.ts";
import { SymbolKind, Symbol } from "../ast/ast.ts";
import { Loader as ConfigLoader } from "../config/config.ts";
import {
  Rule, RAtCharset, RAtImport, RAtKeyframes, RAtLayer, RAtMedia, RAtScope, RKnownAt,
  RUnknownAt, RSelector, RQualified, RDeclaration, RBadDeclaration, RComment,
  SSHash, SSClass, SSAttribute, SSPseudoClass, SSPseudoClassWithSelectorList,
} from "../css_ast/css_ast.ts";
import { CSSParser, Options, OptionsFromConfig, Parse } from "./css_parser.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/parse-entry-go.json", import.meta.url)));
const SHA = "5767d54e2236fc791e92020513e3a27c7f7adc16958e7e744ba169e753e0f61f";
const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);

function dToks(toks: any[]): any[] { return toks.map((t) => [t.Kind, t.Text, t.Whitespace, t.UnitOffset, t.PayloadIndex, t.Loc, t.Children ? dToks(t.Children) : null]); }
function dName(n: any): any { const pref = n.NamespacePrefix ? [n.NamespacePrefix.Text, n.NamespacePrefix.Range.Loc.Start, n.NamespacePrefix.Kind] : null; return [pref, n.Name.Text, n.Name.Range.Loc.Start, n.Name.Kind]; }
function dSS(ss: any): any {
  if (ss instanceof SSHash) return ["hash", ss.Name.Ref.InnerIndex];
  if (ss instanceof SSClass) return ["class", ss.Name.Ref.InnerIndex];
  if (ss instanceof SSAttribute) return ["attr", ss.MatcherOp, ss.MatcherValue, dName(ss.NamespacedName), ss.MatcherModifier];
  if (ss instanceof SSPseudoClass) return ["pc", ss.Name, dToks(ss.Args), ss.IsElement];
  if (ss instanceof SSPseudoClassWithSelectorList) return ["pcs", dComplex(ss.Selectors), ss.Index.A, ss.Index.B, ss.Kind];
  return ["?"];
}
function dCompound(c: any): any { const ts = c.TypeSelector ? dName(c.TypeSelector) : null; return [ts, (c.SubclassSelectors as any[]).map((ss) => dSS(ss.Data)), c.NestingSelectorLocs, c.CombinatorLoc, c.Combinator, c.WasEmptyFromLocalOrGlobal]; }
function dComplex(cs: any[]): any { return cs.map((c) => (c.Selectors as any[]).map(dCompound)); }
function dMQ(q: any): any { return [q.Loc, q.Data.Hash()]; }
function dMQs(qs: any[]): any { return qs.map(dMQ); }
function dRules(rules: Rule[]): any[] {
  const out: any[] = [];
  for (const r of rules) {
    const base: any[] = [r.Loc]; const d: any = r.Data;
    if (d instanceof RAtCharset) out.push(["charset", ...base, d.Encoding]);
    else if (d instanceof RAtImport) { let cond: any = null; if (d.ImportConditions) cond = [dToks(d.ImportConditions.Layers), dToks(d.ImportConditions.Supports), dMQs(d.ImportConditions.Queries)]; out.push(["import", ...base, d.ImportRecordIndex, cond]); }
    else if (d instanceof RAtKeyframes) out.push(["keyframes", ...base, d.AtToken, d.Name.Ref.InnerIndex, d.Blocks.map((b) => [b.Selectors, dRules(b.Rules), b.Loc, b.CloseBraceLoc]), d.CloseBraceLoc]);
    else if (d instanceof RAtLayer) out.push(["layer", ...base, d.Names, dRules(d.Rules), d.CloseBraceLoc]);
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
function dMsgs(log: any): any[] { return log.Done().map((m: any) => [m.ID, m.Data.Text, (m.Notes ?? []).map((nd: any) => nd.Text)]); }
function dCF(f: any): any { return f === null ? null : Array.from(f.values as Int32Array); }

test("parse-entry fixture sha256 + 52 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: any;
    if (r.fn === "Parse") {
      const log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null);
      const source = new Source(); source.Contents = new TextEncoder().encode(r.src);
      const o = new Options(); o.minifyIdentifiers = r.arg.idents; o.symbolMode = r.arg.mode;
      const ast = Parse(log, source, o);
      const localSymbols = ast.LocalSymbols.map((l: any) => [l.Ref.InnerIndex, l.Loc.Start]);
      got = {
        rules: dRules(ast.Rules), msgs: dMsgs(log), charfreq: dCF(ast.CharFreq),
        symbols: ast.Symbols.map((s: any, i: number) => [s.OriginalName, s.Kind, s.UseCountEstimate, i]),
        imports: ast.ImportRecords.map((x: any) => [x.Kind, x.Path.Text, x.Range.Loc.Start, x.Range.Len]),
        lineCount: ast.ApproximateLineCount, localSymbols,
        globalKeys: Array.from(ast.GlobalScope.keys()).sort(), localKeys: Array.from(ast.LocalScope.keys()).sort(),
        preLayers: ast.LayersPreImport, postLayers: ast.LayersPostImport,
        sourceMapText: new TextDecoder().decode(ast.SourceMapComment.Text),
      };
    } else if (r.fn === "computeCharacterFrequency") {
      const log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null);
      const source = new Source(); source.Contents = new TextEncoder().encode(r.src);
      const tk = Tokenize(source, { recordAllComments: true });
      const p = new CSSParser(); p.log = log; p.source = source; p.tokens = tk.tokens; p.allComments = tk.allComments;
      p.options.minifyIdentifiers = true;
      p.importRecords.push({ Path: { Text: "xyz" }, IsSourceIndexValid: false });
      const s1 = new Symbol(); s1.Kind = SymbolKind.SymbolLocalCSS; s1.OriginalName = "abc"; s1.UseCountEstimate = 2; p.symbols.push(s1);
      const s2 = new Symbol(); s2.Kind = SymbolKind.SymbolGlobalCSS; s2.OriginalName = "xyz"; s2.UseCountEstimate = 3; p.symbols.push(s2);
      got = dCF(p.computeCharacterFrequency());
    } else if (r.fn === "OptionsFromConfig") {
      const o = OptionsFromConfig(r.arg.loader, { CSSPrefixData: null, MinifySyntax: true, MinifyWhitespace: false, MinifyIdentifiers: true, OriginalTargetEnv: "es2020", UnsupportedCSSFeatures: 2048 });
      got = { minifySyntax: o.minifySyntax, minifyWhitespace: o.minifyWhitespace, minifyIdentifiers: o.minifyIdentifiers, feature: Number(o.unsupportedCSSFeatures), env: o.originalTargetEnv, symbolMode: o.symbolMode };
    } else if (r.fn === "Options.Equal") {
      const mk = (kind: string): Options => {
        const o = new Options();
        if (kind === "min") o.minifySyntax = true;
        if (kind === "map2") o.cssPrefixData = new Map([[1, 2]]);
        if (kind === "map3") o.cssPrefixData = new Map([[1, 3]]);
        return o;
      };
      const pairs: Record<string, [string, string]> = {
        same: ["nil", "nil"], "diff-min": ["nil", "min"],
        "nil-vs-map": ["nil", "map2"], "same-map": ["map2", "map2"], "diff-map": ["map2", "map3"],
      };
      const [ka, kb] = pairs[r.arg.pair];
      got = mk(ka).Equal(mk(kb));
    } else throw new Error("unknown fn " + r.fn);
    assert.equal(JSON.stringify(canon(got)), JSON.stringify(canon(r.out)),
      `${r.fn} ${JSON.stringify(r.src)} ${JSON.stringify(r.arg)} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 52);
});
