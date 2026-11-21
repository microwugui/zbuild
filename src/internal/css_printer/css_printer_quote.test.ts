// 第 74 轮叶子优先规划：css_printer 引号字符串助手（Go 探针固化，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Printer } from "./css_printer.ts";

const FIXTURE = new URL("../../../testdata/css-printer-quote-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "8df088745d820eec2afa4c3aadee4c31e7fe3a5ae3015d69892f17fae5a0190b";

interface Row { fn: string; arg: string; out: string; }

test("css-printer-quote fixture sha256 + 13 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-printer-quote fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const parts = r.arg.split("|");
    const p = new Printer();
    let got: string;
    if (r.fn === "printQuoted") {
      const text = Buffer.from(parts[0], "base64").toString("utf8");
      p.lineLimit = Number(parts[2]);
      if (parts[3] === "true") p.unsupportedFeatures = 1 << 6;
      p.asciiOnly = parts[4] === "true";
      p.printQuoted(text, Number(parts[1]));
      got = Buffer.from(p.css).toString("base64");
    } else if (r.fn === "printQuotedWithQuote") {
      const text = Buffer.from(parts[0], "base64").toString("utf8");
      p.printQuotedWithQuote(text, Number(parts[1]), Number(parts[2]));
      got = Buffer.from(p.css).toString("base64");
    } else throw new Error(`unknown ${r.fn}`);
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 13);
});
