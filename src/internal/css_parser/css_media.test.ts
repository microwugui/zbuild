// 第 118 批：media 解析链 7 函数（Go 探针 23 例逐字节）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Tokenize } from "../css_lexer/css_lexer.ts";
import { Source, Loc, NewDeferLog, DeferLogKind, MakeLineColumnTracker } from "../logger/logger.ts";
import { MediaQuery, MQPlainOrBoolean, MQNot, MQRange, MQType, MQBinary, MQArbitraryTokens, Token as ASTToken } from "../css_ast/css_ast.ts";
import type { MediaQueryData } from "../css_ast/css_ast.ts";
import { CSSParser } from "./css_parser.ts";
import { looksLikeMediaCondition, parseMediaQuery, parseMediaCondition, parseMediaInParens, appendMediaTerm, maybeSimplifyMediaNot, parseMediaQueryListUntil } from "./css_parser_media.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/css-media-go.json", import.meta.url)));
const SHA = "71d011f1863dd5de0e42ba485b61bbb1f86de6632df395e7cc0cf133832e2f7a";
const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);
function mkParser(src: string, minify: boolean): CSSParser {
  const log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null);
  const source = new Source(); source.Contents = new TextEncoder().encode(src);
  const p = new CSSParser();
  p.tokens = Tokenize(source).tokens; p.source = source; p.log = log;
  p.tracker = MakeLineColumnTracker(source); p.prevError = new Loc(0);
  p.options.minifySyntax = minify;
  return p;
}
const dTok = (t: any): any => [t.Kind, t.Text, t.Whitespace, t.Loc];
const dToks = (ts: any[]): any => ts.map(dTok);
function dQ(q: MediaQuery): any {
  const d: MediaQueryData | null = q.Data;
  if (d === null) return null;
  if (d instanceof MQPlainOrBoolean) return { t: "plain", loc: q.Loc, name: d.Name, val: dToks(d.ValueOrNil) };
  if (d instanceof MQNot) return { t: "not", loc: q.Loc, inner: dQ(d.Inner) };
  if (d instanceof MQRange) return { t: "range", loc: q.Loc, name: d.Name, nameLoc: d.NameLoc, beforeCmp: d.BeforeCmp, before: dToks(d.Before), afterCmp: d.AfterCmp, after: dToks(d.After) };
  if (d instanceof MQType) return { t: "type", loc: q.Loc, op: d.Op, name: d.Type, and: d.AndOrNull.Data === null ? null : dQ(d.AndOrNull) };
  if (d instanceof MQBinary) return { t: "binary", loc: q.Loc, op: d.Op, terms: d.Terms.map(dQ) };
  if (d instanceof MQArbitraryTokens) return { t: "arbitrary", loc: q.Loc, toks: dToks(d.Tokens) };
  return { t: "unknown" };
}


function dQm(q: MediaQuery): any {
  const d: MediaQueryData | null = q.Data;
  if (d instanceof MQPlainOrBoolean) return { t: "plain", loc: q.Loc, name: d.Name, val: [] };
  if (d instanceof MQNot) return { t: "not", loc: q.Loc, inner: dQm(d.Inner) };
  if (d instanceof MQRange) return { t: "range", loc: q.Loc, name: d.Name, nameLoc: d.NameLoc, beforeCmp: d.BeforeCmp, before: [], afterCmp: d.AfterCmp, after: d.After.map((t: any) => ["TDIM", t.Text]) };
  if (d instanceof MQBinary) return { t: "binary", loc: q.Loc, op: d.Op, terms: d.Terms.map(dQm) };
  return dQ(q);
}
function extraQuery(mode: string): MediaQuery {
  const plain = (name: string): MediaQuery => { const q = new MediaQuery(); const d = new MQPlainOrBoolean(); d.Name = name; q.Data = d; return q; };
  const notOf = (q: MediaQuery): MediaQuery => { const outer = new MediaQuery(); const n = new MQNot(); n.Inner = q; outer.Data = n; return outer; };
  if (mode === "not") return notOf(plain("a"));
  if (mode === "binary") {
    const b = new MQBinary(); b.Op = 0;
    b.Terms = [notOf(notOf(plain("a"))), notOf(notOf(plain("b")))];
    const q = new MediaQuery(); q.Data = b; return q;
  }
  const range = new MQRange(); range.Name = "width"; range.AfterCmp = 2;
  const t = new ASTToken(); t.Kind = 26; t.Text = "100px"; range.After = [t];
  const q = new MediaQuery(); q.Data = range; return q;
}

test("css-media fixture sha256 + 29 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const p = mkParser(r.src, !!r.minify);
    let out: any;
    switch (r.fn) {
      case "looksLikeMediaCondition": out = looksLikeMediaCondition(p); break;
      case "parseMediaQuery": { const v = parseMediaQuery(p); out = { ok: v.ok, q: v.ok ? dQ(v.query) : null }; break; }
      case "parseMediaCondition": { const v = parseMediaCondition(p, r.or ?? 0); out = { ok: v.ok, q: v.ok ? dQ(v.query) : null }; break; }
      case "parseMediaInParens": { const v = parseMediaInParens(p); out = { ok: v.ok, q: v.ok ? dQ(v.query) : null }; break; }
      case "parseMediaQueryListUntil": out = parseMediaQueryListUntil(p, (k) => k === 0).map(dQ); break;
      case "appendMediaTerm": {
        const v = parseMediaCondition(p, 0);
        const terms = appendMediaTerm(p, [], v.query, 0);
        out = { terms: terms.map(dQ) };
        break;
      }
      case "maybeSimplifyMediaNot": {
        const inner = r.mode ? extraQuery(r.mode) : parseMediaCondition(p, 0).query;
        out = r.mode ? dQm(maybeSimplifyMediaNot(p, 0, inner)) : dQ(maybeSimplifyMediaNot(p, 0, inner));
        break;
      }
      default: throw new Error("unknown " + r.fn);
    }
    const got = r.out.index === undefined ? out : { index: p.index, out };
    assert.equal(JSON.stringify(canon(got)), JSON.stringify(canon(r.out)), `${r.fn} ${r.src} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 29);
});
