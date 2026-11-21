// 第 50 轮叶子优先规划：css_parser 纯字符串/token 助手（Go 探针固化，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Token } from "../css_ast/css_ast.ts";
import { isFontSize } from "./css_decls_font.ts";
import { mangleNumber, shiftDot } from "./css_parser.ts";
import { parseInteger } from "./css_parser_selector.ts";
import { floatToStringForCalc } from "./css_reduce_calc.ts";

const FIXTURE = new URL("../../../testdata/css-parser-pure2-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "b48c27d21613bb9c04c6e9241509abdc2ec9893138cf1cee1733b3360a20cc7f";

interface Row { fn: string; arg: string; out: string; }

test("css-parser-pure2 fixture sha256 + 46 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-parser-pure2 fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "isFontSize": {
        const [k, text] = r.arg.split("|");
        const tk = new Token(); tk.Kind = Number(k); tk.Text = text;
        got = String(isFontSize(tk));
        break;
      }
      case "mangleNumber": {
        const v = mangleNumber(r.arg);
        got = `${v.value}|${v.changed}`;
        break;
      }
      case "shiftDot": {
        const [text, off] = r.arg.split("|");
        const v = shiftDot(text, Number(off));
        got = `${v.value}|${v.ok}`;
        break;
      }
      case "parseInteger": {
        const v = parseInteger(r.arg);
        got = `${v.value}|${v.ok}`;
        break;
      }
      case "floatToStringForCalc": {
        const a = r.arg === "nan" ? NaN : r.arg === "inf" ? Infinity : Number(r.arg);
        const v = floatToStringForCalc(a);
        got = `${v.value}|${v.ok}`;
        break;
      }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 46);
});
