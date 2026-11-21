// 第 71 轮叶子优先规划：css_printer 输出助手状态簇（Go 探针固化，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NthIndex } from "../css_ast/css_ast.ts";
import { Printer } from "./css_printer.ts";

const FIXTURE = new URL("../../../testdata/css-printer-state-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "219779b2fc526ba34d019dc5982b55203a53ae57de5cafb73a9558bea418e1d7";

interface Row { fn: string; arg: string; out: string; }

test("css-printer-state fixture sha256 + 21 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-printer-state fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "print": {
        const p = new Printer();
        p.print(Buffer.from(r.arg, "base64").toString("utf8"));
        got = Buffer.from(p.css).toString("base64");
        break;
      }
      case "printIndent": {
        const [indent, limit] = r.arg.split("|").map(Number);
        const p = new Printer(); p.lineLimit = limit;
        p.printIndent(indent);
        got = Buffer.from(p.css).toString("base64");
        break;
      }
      case "printNthIndex": {
        const sep = r.arg.indexOf("|");
        const idx = new NthIndex();
        idx.A = r.arg.slice(0, sep); idx.B = r.arg.slice(sep + 1);
        const p = new Printer();
        p.printNthIndex(idx);
        got = Buffer.from(p.css).toString("utf8");
        break;
      }
      case "currentLineLength": {
        const p = new Printer();
        const sep = r.arg.lastIndexOf("|");
        p.css = Array.from(Buffer.from(r.arg.slice(0, sep), "base64"));
        p.oldLineEnd = Number(r.arg.slice(sep + 1));
        got = `${p.currentLineLength()}|${p.oldLineStart}`;
        break;
      }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 21);
});
