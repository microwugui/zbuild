// 第 135 批：processDeclarations 本体（Go 探针 120 例，逐字节）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Tokenize } from "../css_lexer/css_lexer.ts";
import { Source, Loc, NewDeferLog, DeferLogKind, MakeLineColumnTracker } from "../logger/logger.ts";
import { RDeclaration, Rule } from "../css_ast/css_ast.ts";
import { CSSParser, parseDeclaration } from "./css_parser.ts";
import { processDeclarations } from "./css_decls.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/main-chain-go.json", import.meta.url)));
const SHA = "cd642598d8509e57704f42cd89d5a876d6a002a43d227abacb09cc201c8995d3";
const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);
const dump = (rules: Rule[]): any[] => rules.map((r) => {
  const d = r.Data;
  if (d instanceof RDeclaration) return { t: "decl", k: d.KeyText, v: d.Value.map((t: any) => t.Text), imp: d.Important };
  return { t: "other" };
});

test("processDeclarations fixture sha256 + 120 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null);
    const source = new Source(); source.Contents = new TextEncoder().encode(r.src);
    const p = new CSSParser(); p.tokens = Tokenize(source).tokens; p.source = source; p.log = log;
    p.tracker = MakeLineColumnTracker(source); p.prevError = new Loc(0);
    p.options.unsupportedCSSFeatures = r.feature;
    p.options.minifySyntax = r.minify; p.options.minifyWhitespace = r.minify;
    const decls: Rule[] = [];
    while (p.index < p.tokens.length) {
      const before = p.index;
      decls.push(parseDeclaration(p));
      if (p.index === before) break;
    }
    const got = { rules: dump(processDeclarations(p, decls, null)), msgs: log.Done().map((m: any) => m.Data.Text) };
    assert.equal(JSON.stringify(canon(got)), JSON.stringify(canon(r.out)), `${r.src} f=${r.feature} m=${r.minify} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 120);
});
