// 第 44 轮叶子优先规划：CSS Token 助手（Go 探针字节证据）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Token, T, TokensAreCommaSeparated, HashTokens, tokensContainAmpersandRecursive } from "./css_ast.ts";

const FIXTURE = new URL("../../../testdata/css-token-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "32971e965f0a584e44b865a3ba0775974bc0f824d87a4fe84c45c9d3be06a58a";

interface Row { fn: string; arg: string; out: string; }

test("CSS Token 助手：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-token fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "TComma": got = String(T.TComma); break;
      case "TokensAreCommaSeparated": {
        const kinds = r.arg.replace(/[\[\]]/g, "").split(" ").filter(Boolean);
        const toks = kinds.map((k) => { const t = new Token(); t.Kind = k.includes(",") ? T.TComma : 29; return t; });
        got = String(TokensAreCommaSeparated(toks)); break;
      }
      case "TurnLengthOrPercentageIntoNumberIfZero": {
        const t = new Token(); t.Text = r.arg;
        t.Kind = r.arg.endsWith("%") ? T.TPercentage : T.TDimension;
        // UnitOffset = 第一个非数字字符的位置（数字/单位分界）
        let off = 0; while (off < r.arg.length && r.arg[off] >= "0" && r.arg[off] <= "9") off++;
        t.UnitOffset = off;
        const c = t.TurnLengthOrPercentageIntoNumberIfZero();
        got = `${c}|${t.Kind}|${t.Text}`; break;
      }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} ${r.arg}`);
  }
});

const F2 = new URL("../../../testdata/css-hash-go.json", import.meta.url);
const b2 = new Uint8Array(readFileSync(F2));
const S2 = "c12e44546b2b22ff23584eb7f174f0f8750e02fbe472a374534a91d6be7509d7";
interface Row2 { fn: string; kinds: string; out: string; }

test("css_ast HashTokens：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(b2).digest("hex"), S2, "css-hash fixture sha256");
  const rows: Row2[] = JSON.parse(new TextDecoder().decode(b2));
  const KIND: Record<string, number> = { identifier: 29, number: 30, URL: 37 };
  for (const r of rows) {
    let kinds: string[];
    if (r.kinds === "[URL token]") kinds = ["URL token"];
    else kinds = r.kinds.startsWith("[") ? r.kinds.slice(1, -1).split(" ").filter(Boolean) : [];
    const toks = kinds.map((k, i) => { const t = new Token(); t.Kind = k === "URL token" ? T.TURL : (KIND[k] ?? 29); t.Text = `tok${i}`; return t; });
    assert.equal(String(HashTokens(0, toks)), r.out, r.kinds);
  }
});

const F3 = new URL("../../../testdata/css-amp-go.json", import.meta.url);
const b3 = new Uint8Array(readFileSync(F3));
const S3 = "adce9428762257bcd08fc69354dc5a4c5ecd3a6ca422d837d1ff395bc0fdf8b4";
test("css_ast ampersand：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(b3).digest("hex"), S3, "css-amp fixture sha256");
  const rows: { case: string; out: string }[] = JSON.parse(new TextDecoder().decode(b3));
  const mk = (kind: number, children?: Token[]): Token => { const t = new Token(); t.Kind = kind; if (children) t.Children = children; return t; };
  const cases: Record<string, Token[]> = {
    empty: [],
    ident: [mk(29)],
    amp: [mk(T.TDelimAmpersand)],
    nested: [mk(29, [mk(29), mk(T.TDelimAmpersand)])],
    "nested-no": [mk(29, [mk(29)])],
  };
  for (const r of rows) assert.equal(String(tokensContainAmpersandRecursive(cases[r.case])), r.out, r.case);
});
