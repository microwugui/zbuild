// 第 100 轮叶子优先规划：css_parser decoded/peek/eat/convertTokens（4 方法一次探针）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Source } from "../logger/logger.ts";
import { Tokenize, Token } from "../css_lexer/css_lexer.ts";
import { CSSParser } from "./css_parser.ts";

const FIXTURE = new URL("../../../testdata/css-parser-tokens-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "81ce43518fc5efc7460718806d36e1bb1dde1c6414d4550c14f75b316f667131";

interface Row { fn: string; arg: string; out: string; }

test("css-parser-tokens fixture sha256 + 15 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-parser-tokens fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    if (r.fn === "decoded") {
      const src = new Source(); src.Contents = new TextEncoder().encode(`a\\62 c`);
      const p = new CSSParser(); p.tokens = Tokenize(src).tokens; p.source = src; p.index = Number(r.arg);
      got = p.decoded();
    } else if (r.fn === "peek") {
      const src = new Source(); src.Contents = new TextEncoder().encode("a b");
      const p = new CSSParser(); p.tokens = Tokenize(src).tokens; p.source = src; p.index = 0;
      got = String(p.peek(Number(r.arg)));
    } else if (r.fn === "eat") {
      const [kind, times] = r.arg.split("|").map(Number);
      const src = new Source(); src.Contents = new TextEncoder().encode("a b");
      const p = new CSSParser(); p.tokens = Tokenize(src).tokens; p.source = src; p.index = 0;
      let res = false; for (let i = 0; i < times; i++) res = p.eat(kind);
      got = `${res}|${p.index}`;
    } else if (r.fn === "convertTokens") {
      const pairs: [number, string][] = JSON.parse(r.arg);
      const contents = pairs.map((p) => p[1]).join("");
      const src = new Source(); src.Contents = new TextEncoder().encode(contents);
      let off = 0;
      const toks = pairs.map(([kind, text]) => { const t = new Token(); t.kind = kind; t.rangeLoc = off; t.rangeLen = text.length; off += text.length; return t; });
      const p = new CSSParser(); p.source = src;
      got = p.convertTokens(toks).map((t) => `${t.Kind}:${t.Text}:${t.Whitespace};`).join("");
    } else throw new Error(`unknown ${r.fn}`);
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 15);
});
