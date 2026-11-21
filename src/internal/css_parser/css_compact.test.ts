// 第 108 批：compactTokenQuad / commaToken（Go 探针 7 例，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Token } from "../css_ast/css_ast.ts";
import { compactTokenQuad, commaToken } from "./css_decls.ts";

const FIXTURE = new URL("../../../testdata/css-compact-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "d0388e8301161f37191e99e02279bc8881e27ff467ad62c3337c65de60d1fab3";
interface Row { fn: string; toks: any[]; minify: boolean; loc: number; out: any[] }
function toTok(x: any): Token { const t = new Token(); t.Kind = x.k; t.Text = x.t; t.Whitespace = x.w ?? 0; t.Loc = x.loc ?? 0; return t; }
function dumpToks(ts: Token[]): any[] { return ts.map((t) => [t.Kind, t.Text, t.Whitespace, t.Loc]); }

test("css-compact fixture sha256 + 7 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-compact fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: any[];
    if (r.fn === "compactTokenQuad") {
      const [a, b, c, d] = r.toks.map(toTok);
      got = dumpToks(compactTokenQuad(a, b, c, d, r.minify));
    } else if (r.fn === "commaToken") {
      const t = commaToken(r.loc, r.minify);
      got = [t.Kind, t.Text, t.Whitespace, t.Loc];
    } else throw new Error("unknown " + r.fn);
    assert.equal(JSON.stringify(got), JSON.stringify(r.out), `${r.fn} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 7);
});
