// 第 134 批：lowerAndMinifyGradient（Go 探针 60 例，逐字节）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Tokenize } from "../css_lexer/css_lexer.ts";
import { Source, Loc, NewDeferLog, DeferLogKind, MakeLineColumnTracker } from "../logger/logger.ts";
import { CSSParser } from "./css_parser.ts";
import { lowerAndMinifyGradient } from "./css_decls_gradient.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/grad-lower-go.json", import.meta.url)));
const SHA = "4b7f8ec704d09801f4fc54444db81730edc8b707a080c8c40634a6442e595835";
const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);

test("grad-lower fixture sha256 + 60 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null);
    const source = new Source(); source.Contents = new TextEncoder().encode(r.src);
    const p = new CSSParser(); p.tokens = Tokenize(source).tokens; p.source = source; p.log = log;
    p.tracker = MakeLineColumnTracker(source); p.prevError = new Loc(0);
    p.options.unsupportedCSSFeatures = r.feature;
    p.options.minifySyntax = r.minify; p.options.minifyWhitespace = r.minify;
    const tok = p.convertTokens(p.tokens)[0];
    const clip = { value: false };
    const out = lowerAndMinifyGradient(p, tok, clip);
    const got = { kind: out.Kind, text: out.Text, children: (out.Children ?? []).map((c: any) => c.Text), clip: clip.value };
    assert.equal(JSON.stringify(canon(got)), JSON.stringify(canon(r.out)), `${r.src} f=${r.feature} m=${r.minify} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 60);
});
