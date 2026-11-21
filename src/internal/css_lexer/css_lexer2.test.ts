// 第 97 轮叶子优先规划：css_lexer wouldStartIdentifier + consumeURL + String。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Lexer, String as TString } from "./css_lexer.ts";

const FIXTURE = new URL("../../../testdata/css-lexer2-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "e905d599174f5fb8d547462fcc4ec8d26c7dd71499447a3075f57d7a51325e60";

interface Row { fn: string; arg: string; out: string; }

test("css-lexer2 fixture sha256 + 16 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-lexer2 fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    if (r.fn === "String") got = TString(Number(r.arg));
    else if (r.fn === "wouldStartIdentifier") {
      const p = r.arg.split("|");
      const l = new Lexer(); l.contents = new Uint8Array(Buffer.from(p[0], "base64"));
      l.current = Number(p[1]); l.codePoint = Number(p[2]);
      got = String(l.wouldStartIdentifier());
    } else if (r.fn === "consumeURL") {
      const l = new Lexer(); l.contents = new Uint8Array(Buffer.from(r.arg, "base64"));
      l.step();
      got = `${l.consumeURL()}|${l.current}`;
    } else throw new Error(`unknown ${r.fn}`);
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 16);
});
