// 第 124 批：selector 叶子 5 函数（Go 探针 23 例，逐字节）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Tokenize } from "../css_lexer/css_lexer.ts";
import { Source, Loc, NewDeferLog, DeferLogKind, MakeLineColumnTracker } from "../logger/logger.ts";
import { CSSParser } from "./css_parser.ts";
import { nameToken, parseCombinator, parseAnyValue, parseAttributeSelector, parseNthIndex } from "./css_parser_selector.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/css-sel-leaf-go.json", import.meta.url)));
const SHA = "93a4633146c9fd4343f28af2068f1ee7b2c4dba4844f080302497f1ca4d2aaba";
const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);
function mk(src: string): CSSParser {
  const log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null);
  const source = new Source(); source.Contents = new TextEncoder().encode(src);
  const p = new CSSParser();
  p.tokens = Tokenize(source).tokens; p.source = source; p.log = log;
  p.tracker = MakeLineColumnTracker(source); p.prevError = new Loc(0);
  return p;
}

test("css-sel-leaf fixture sha256 + 23 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const p = mk(r.src);
    let got: any;
    switch (r.fn) {
      case "nameToken": { const t = nameToken(p); got = { kind: t.Kind, text: t.Text, loc: t.Range.Loc.Start, len: t.Range.Len }; break; }
      case "parseCombinator": { const c = parseCombinator(p); got = { loc: c.Loc, byte: c.Byte, index: p.index }; break; }
      case "parseAnyValue": {
        const ts = parseAnyValue(p);
        got = { tokens: ts.map((t: any) => [t.kind, t.DecodedText(p.source.Contents), t.rangeLoc]), index: p.index, errs: p.log.Done().length };
        break;
      }
      case "parseAttributeSelector": {
        const { attr, range } = parseAttributeSelector(p);
        got = {
          prefix: attr.NamespacedName.NamespacePrefix === null ? null : [attr.NamespacedName.NamespacePrefix.Text, attr.NamespacedName.NamespacePrefix.Kind],
          name: attr.NamespacedName.Name.Text, nameKind: attr.NamespacedName.Name.Kind,
          op: attr.MatcherOp, value: attr.MatcherValue, mod: attr.MatcherModifier,
          loc: range.Loc.Start, len: range.Len, index: p.index,
        };
        break;
      }
      case "parseNthIndex": { const v = parseNthIndex(p); got = { a: v.index.A, b: v.index.B, ok: v.ok, index: p.index }; break; }
      default: throw new Error("unknown " + r.fn);
    }
    assert.equal(JSON.stringify(canon(got)), JSON.stringify(canon(r.out)), `${r.fn} ${r.src} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 23);
});
