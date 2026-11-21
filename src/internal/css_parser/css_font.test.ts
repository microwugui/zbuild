// 第 105 批：font-family mangle 链（Go 探针 13 例，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Token } from "../css_ast/css_ast.ts";
import { mangleFontFamily } from "./css_decls_font_family.ts";
import { turnPercentIntoNumberIfShorter } from "./css_decls_transform.ts";

const FIXTURE = new URL("../../../testdata/css-font-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "2f649cb81fc60286527753bbb5ef489178b32a0f882f5ed23adcf2d473a4e5bf";
interface Row { fn: string; toks: any[]; minify: boolean; out: [any[], boolean] }
function toToks(a: any[]): Token[] { return a.map((x) => { const t = new Token(); t.Kind = x.k; t.Text = x.t; t.Whitespace = x.w ?? 0; t.Loc = x.loc ?? 0; return t; }); }
function dumpToks(ts: Token[]): any[] { return ts.map((t) => [t.Kind, t.Text, t.Whitespace, t.Loc]); }

test("css-font fixture sha256 + 13 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-font fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const [result, ok] = mangleFontFamily(toToks(r.toks), r.minify);
    const got: [any[], boolean] = [result === null ? [] : dumpToks(result), ok];
    assert.equal(JSON.stringify(got), JSON.stringify(r.out), `${r.fn} ${JSON.stringify(r.toks)} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 13);
});

const FIXTURE2 = new URL("../../../testdata/css-font2-go.json", import.meta.url);
const bytes2 = new Uint8Array(readFileSync(FIXTURE2));
const SHA2 = "1fea9b956e643b54419f23edbc7045651cbbc4ec44b0f58e01d011ecee328cb7";
interface Row2 { fn: string; tok: any; out: [number, string] }

test("css-font2 fixture sha256 + 6 例 turnPercentIntoNumberIfShorter 逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes2).digest("hex"), SHA2, "css-font2 fixture sha256");
  const rows: Row2[] = JSON.parse(new TextDecoder().decode(bytes2));
  for (const r of rows) {
    const t = new Token(); t.Kind = r.tok.k; t.Text = r.tok.t;
    turnPercentIntoNumberIfShorter(t);
    assert.equal(JSON.stringify([t.Kind, t.Text]), JSON.stringify(r.out), `${JSON.stringify(r.tok)} => ${JSON.stringify([t.Kind,t.Text])} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 6);
});
