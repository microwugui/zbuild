// 第 125 批：selector 主链 4 函数（Go 探针 114 例，逐字节 IR）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Tokenize } from "../css_lexer/css_lexer.ts";
import { Source, Loc, NewDeferLog, DeferLogKind, MakeLineColumnTracker } from "../logger/logger.ts";
import {
  CompoundSelector, ComplexSelector, NamespacedName, SubclassSelector, SSHash, SSClass,
  SSPseudoClass, SSPseudoClassWithSelectorList, SSAttribute,
} from "../css_ast/css_ast.ts";
import { CSSParser } from "./css_parser.ts";
import { parseCompoundSelector, parseComplexSelector, parseSelectorList } from "./css_parser_selector.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/css-chain-go.json", import.meta.url)));
const SHA = "b4a4fc10938a31e4dd3e9f69e0bc15872316ab61481951c4eec20dd278a15bdf";
const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);
function mkParser(src: string, minify: boolean): CSSParser {
  const log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null);
  const source = new Source(); source.Contents = new TextEncoder().encode(src);
  const p = new CSSParser();
  p.tokens = Tokenize(source).tokens; p.source = source; p.log = log;
  p.tracker = MakeLineColumnTracker(source); p.prevError = new Loc(0);
  p.options.minifySyntax = minify; p.symbolMode = 1;
  return p;
}
function dSS(ss: any): any {
  if (ss instanceof SSHash) return { t: "hash", ref: ss.Name.Ref.InnerIndex };
  if (ss instanceof SSClass) return { t: "class", ref: ss.Name.Ref.InnerIndex };
  if (ss instanceof SSPseudoClass) return { t: "pseudo", name: ss.Name, element: ss.IsElement, args: ss.Args.length };
  if (ss instanceof SSPseudoClassWithSelectorList) return { t: "plist", kind: ss.Kind, a: ss.Index.A, b: ss.Index.B, selectors: dComplexes(ss.Selectors) };
  if (ss instanceof SSAttribute) return { t: "attr", name: ss.NamespacedName.Name.Text, op: ss.MatcherOp, val: ss.MatcherValue, mod: ss.MatcherModifier };
  return { t: "unknown" };
}
function dCompound(s: CompoundSelector): any {
  const type = s.TypeSelector === null ? null : (() => {
    const n = s.TypeSelector as NamespacedName;
    return { prefix: n.NamespacePrefix === null ? null : n.NamespacePrefix.Text, name: n.Name.Text, kind: n.Name.Kind };
  })();
  return { type, subs: (s.SubclassSelectors as SubclassSelector[]).map((ss) => dSS(ss.Data)),
    nesting: s.NestingSelectorLocs, combinator: s.Combinator, combinatorLoc: s.CombinatorLoc };
}
function dComplexes(list: ComplexSelector[]): any[] { return list.map((c) => c.Selectors.map(dCompound)); }

test("css-chain fixture sha256 + 114 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const p = mkParser(r.src, !!r.minify);
    let result: { list: ComplexSelector[]; ok: boolean };
    switch (r.fn) {
      case "parseSelectorList": result = parseSelectorList(p, {}); break;
      case "parseComplexSelector": {
        const v = parseComplexSelector(p, { isFirst: true });
        result = { list: [v.result], ok: v.ok };
        break;
      }
      case "parseCompoundSelector": {
        const v = parseCompoundSelector(p, { isFirst: true });
        const c = new ComplexSelector(); c.Selectors = [v.sel];
        result = { list: [c], ok: v.ok };
        break;
      }
      default: throw new Error("unknown " + r.fn);
    }
    const got = {
      out: { ok: result.ok, list: dComplexes(result.list) },
      index: p.index, nesting: p.nestingIsPresent,
      syms: p.symbols.length === 0 ? null : p.symbols.map((s: any) => `${s.OriginalName}|${s.Kind}`),
      msgs: p.log.Done().map((m: any) => `${m.Kind}|${m.Data.Text}`),
    };
    assert.equal(JSON.stringify(canon(got)), JSON.stringify(canon(r.out)), `${r.fn} ${r.src} minify=${r.minify} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 114);
});
