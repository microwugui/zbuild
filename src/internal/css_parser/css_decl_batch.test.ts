// 第 128 批：parseDeclaration（Go 探针 26 例，逐字节）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Tokenize } from "../css_lexer/css_lexer.ts";
import { Source, Loc, NewDeferLog, DeferLogKind, MakeLineColumnTracker } from "../logger/logger.ts";
import { RDeclaration, RBadDeclaration } from "../css_ast/css_ast.ts";
import { CSSParser, parseDeclaration } from "./css_parser.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/decl-batch-go.json", import.meta.url)));
const SHA = "399a8abb718804506d1a27e078c92fb2e8fc2db7383c88ba2a0f82866d0dd699";
const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);

test("decl-batch fixture sha256 + 26 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  const dec = new TextDecoder();
  for (const r of rows) {
    const log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null);
    const source = new Source(); source.Contents = new TextEncoder().encode(r.src);
    const p = new CSSParser();
    p.tokens = Tokenize(source).tokens; p.source = source; p.log = log;
    p.tracker = MakeLineColumnTracker(source); p.prevError = new Loc(0);
    p.options.minifySyntax = !!r.minify; p.options.minifyWhitespace = !!r.minify;
    const rule = parseDeclaration(p);
    const d = rule.Data;
    let out: any;
    if (d instanceof RDeclaration) out = { t: "decl", key: d.Key, text: d.KeyText, val: d.Value.map((t: any) => [t.Kind, t.Text, t.Whitespace]), important: d.Important };
    else if (d instanceof RBadDeclaration) out = { t: "bad", val: d.Tokens.map((t: any) => [t.Kind, t.Text, t.Whitespace]) };
    else out = { t: "other" };
    const got = { rule: out, index: p.index, msgs: log.Done().map((m: any) => `${m.Kind}|${m.Data.Text}`) };
    assert.equal(JSON.stringify(canon(got)), JSON.stringify(canon(r.out)), `${r.src} minify=${r.minify} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 26);
});
