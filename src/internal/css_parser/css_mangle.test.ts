// 第 70 轮叶子优先规划：css_parser mangle 助手（Go 探针固化，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Token } from "../css_ast/css_ast.ts";
import { mangleFontWeight } from "./css_decls_font_weight.ts";
import { mangleDimension } from "./css_parser.ts";

const FIXTURE = new URL("../../../testdata/css-mangle-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "e0048a514556bbbedba4b8a99f95efd9c40a92e6faa13f048301bb09f127efa0";

interface Row { fn: string; arg: string; out: string; }

test("css-mangle fixture sha256 + 15 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-mangle fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "mangleFontWeight": {
        const [k, text] = r.arg.split("|");
        const tk = new Token(); tk.Kind = Number(k); tk.Text = text;
        const v = mangleFontWeight(tk);
        got = `${v.Kind}|${v.Text}`;
        break;
      }
      case "mangleDimension": {
        const [value, unit] = r.arg.split("|");
        const v = mangleDimension(value, unit);
        got = `${v.value}|${v.unit}|${v.ok}`;
        break;
      }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 15);
});
