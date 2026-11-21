// 第 64 轮叶子优先规划：css_printer 纯打印助手（Go 探针固化，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Token } from "../css_ast/css_ast.ts";
import { bestQuoteCharForString, functionMultiLineCommaPeriod } from "./css_printer.ts";

const FIXTURE = new URL("../../../testdata/css-printer-pure-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "5751057aa2894bb6deb21704e0767d53094c556b4762401e5f752b965a7023ce";

interface Row { fn: string; arg: string; out: string; }

test("css-printer-pure fixture sha256 + 15 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-printer-pure fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "bestQuoteCharForString": {
        const [flag, text] = r.arg.split("|");
        got = String(bestQuoteCharForString(text, flag === "1"));
        break;
      }
      case "functionMultiLineCommaPeriod": {
        const inArg = JSON.parse(r.arg);
        const tk = new Token();
        tk.Kind = inArg.kind; tk.Text = inArg.text;
        tk.Children = inArg.children.map((k: number) => { const c = new Token(); c.Kind = k; return c; });
        got = String(functionMultiLineCommaPeriod(tk));
        break;
      }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 15);
});
