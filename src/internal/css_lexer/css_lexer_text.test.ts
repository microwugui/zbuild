// 第 84 轮叶子优先规划：css_lexer DecodedText + consumeString（Go 探针固化）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Token, Lexer } from "./css_lexer.ts";

const FIXTURE = new URL("../../../testdata/css-lexer-text-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "10e581f1973e7cd089b2ca5634d04d84aed37d35fce0df4577ecc02b8d416772";

interface Row { fn: string; arg: string; out: string; }

test("css-lexer-text fixture sha256 + 12 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-lexer-text fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    if (r.fn === "DecodedText") {
      const parts = r.arg.split("|");
      const contents = new Uint8Array(Buffer.from(parts[1], "base64"));
      const tk = new Token();
      tk.kind = Number(parts[0]); tk.rangeLoc = Number(parts[2]); tk.rangeLen = Number(parts[3]);
      got = Buffer.from(tk.DecodedText(contents), "utf8").toString("base64");
    } else if (r.fn === "consumeString") {
      const contents = Buffer.from(r.arg, "base64");
      const l = new Lexer(); l.contents = new Uint8Array(contents);
      l.step();
      got = `${l.consumeString()}|${l.current}`;
    } else throw new Error(`unknown ${r.fn}`);
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 12);
});
