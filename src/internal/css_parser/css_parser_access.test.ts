// 第 99 轮叶子优先规划：css_parser token 访问器簇（5 方法一次探针，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Source } from "../logger/logger.ts";
import { Tokenize } from "../css_lexer/css_lexer.ts";
import type { Token } from "../css_lexer/css_lexer.ts";
import { CSSParser } from "./css_parser.ts";

const FIXTURE = new URL("../../../testdata/css-parser-access-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "ee06ea0933cc340e7d34527a3ce650fe42fde4038167617efda5875931123f31";

interface Row { fn: string; arg: string; out: string; }
const dumpTok = (t: Token): string => `${t.kind}:${t.rangeLoc}:${t.rangeLen}`;

test("css-parser-access fixture sha256 + 21 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-parser-access fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  const src = new Source(); src.Contents = new TextEncoder().encode("a b c");
  const { tokens } = Tokenize(src);
  const mk = (): CSSParser => { const p = new CSSParser(); p.tokens = tokens; p.source = src; return p; };
  for (const r of rows) {
    let got: string;
    const n = Number(r.arg);
    if (r.fn === "current") { const p = mk(); p.index = n; got = dumpTok(p.current()); }
    else if (r.fn === "next") { const p = mk(); p.index = n; got = dumpTok(p.next()); }
    else if (r.fn === "at") got = dumpTok(mk().at(n));
    else if (r.fn === "raw") { const p = mk(); p.index = n; got = p.raw(); }
    else if (r.fn === "advance") { const p = mk(); for (let i = 0; i < n; i++) p.advance(); got = String(p.index); }
    else throw new Error(`unknown ${r.fn}`);
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 21);
});
