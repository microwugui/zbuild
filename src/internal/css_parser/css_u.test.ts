// 第 119 批：parseURLOrString / expectURLOrString / symbolForName / recordAtLayerRule /
// expectValidLayerNameIdent（Go 探针 15 例，逐字节）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Tokenize } from "../css_lexer/css_lexer.ts";
import { Source, Loc, NewDeferLog, DeferLogKind, MakeLineColumnTracker } from "../logger/logger.ts";
import { CSSParser } from "./css_parser.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/css-u-go.json", import.meta.url)));
const SHA = "be3792134874f4d359b89aedbf88eba069f97447809d3c5e9797a4df4453a4f4";
const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);

test("css-u fixture sha256 + 15 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null);
    const source = new Source();
    source.Contents = new TextEncoder().encode(r.src ?? "");
    if (r.fn === "symbolForName") source.Index = 7;
    const p = new CSSParser();
    p.tokens = Tokenize(source).tokens; p.source = source; p.log = log;
    p.tracker = MakeLineColumnTracker(source); p.prevError = new Loc(0);
    let out: any, msgs: any[] = [];
    switch (r.fn) {
      case "parseURLOrString": {
        const v = p.parseURLOrString();
        out = { text: v.text, start: v.range.Loc.Start, len: v.range.Len, ok: v.ok, index: p.index };
        break;
      }
      case "expectURLOrString": {
        const v = p.expectURLOrString();
        out = { text: v.url, start: v.range.Loc.Start, len: v.range.Len, ok: v.ok, index: p.index };
        break;
      }
      case "expectValidLayerNameIdent": {
        const v = p.expectValidLayerNameIdent();
        out = { text: v.text, ok: v.ok, index: p.index };
        break;
      }
      case "symbolForName": {
        p.makeLocalSymbols = r.mode === "local";
        const refs = ["a", "b", "a"].map((n) => {
          const ref = p.symbolForName(3, n);
          return { loc: ref.Loc.Start, src: ref.Ref.SourceIndex, inner: ref.Ref.InnerIndex };
        });
        out = { refs, syms: p.symbols.map((s: any) => ({ name: s.OriginalName, kind: s.Kind, use: s.UseCountEstimate })), locals: p.localSymbols.length };
        break;
      }
      case "recordAtLayerRule": {
        p.anonLayerCount = r.anon ?? 0;
        p.enclosingLayer = r.enclose ?? [];
        p.recordAtLayerRule([r.layers ?? []]);
        out = { post: p.layersPostImport };
        break;
      }
      default: throw new Error("unknown " + r.fn);
    }
    msgs = log.Done().map((m: any) => ({
      text: m.Data.Text, kind: m.Kind, line: m.Data.Location?.Line ?? 0,
      col: m.Data.Location?.Column ?? 0, len: m.Data.Location?.Length ?? 0,
    }));
    const expected = (r.out.out !== undefined || r.out.msgs !== undefined) ? r.out : { out: r.out, msgs: [] };
    assert.equal(JSON.stringify(canon({ out, msgs })), JSON.stringify(canon(expected)), `${r.fn} ${r.src} => ${JSON.stringify({ out, msgs })} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 15);
});
