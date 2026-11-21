// 第 73 轮叶子优先规划：css_printer printIdent（Go 探针固化，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Printer } from "./css_printer.ts";

const FIXTURE = new URL("../../../testdata/css-printer-ident-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "e7b1c5c552b0c0c6a55dbbf8e612128e7b4f71fcd2f2047f01a64ba6886bde67";

interface Row { fn: string; arg: string; out: string; }

test("css-printer-ident fixture sha256 + 14 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-printer-ident fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const parts = r.arg.split("|");
    const text = Buffer.from(parts[0], "base64").toString("utf8");
    const p = new Printer();
    p.asciiOnly = parts[3] === "true";
    p.printIdent(text, Number(parts[1]), Number(parts[2]));
    assert.equal(Buffer.from(p.css).toString("base64"), r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 14);
});
