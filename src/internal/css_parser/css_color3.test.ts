// 第 49 轮叶子优先规划：CSS 颜色/token/渐变助手（Go 探针固化，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { F64 } from "../helpers/float.ts";
import { Token } from "../css_ast/css_ast.ts";
import { hwb_to_rgb, rgb_to_hwb } from "./css_color_spaces.ts";
import { hueToRgb, packRGBA, parseColorByte, degreesForAngle, lowerAlphaPercentageToNumber } from "./css_decls_color.ts";
import { formatFloat, interpolateHues, premultiply, unpremultiply } from "./css_decls_gradient.ts";

const FIXTURE = new URL("../../../testdata/css-color3-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "489c4fd6b5c4645250c961bc9004cd89ad9e1295921b0511eddbec1f59358c08";

interface Row { fn: string; arg: string; out: string; }
const f12 = (v: number): string => Number.isNaN(v) ? "NaN" : v.toFixed(12);
const f3 = (t: [F64, F64, F64]): string => t.map((v) => f12(v.Value())).join(",");

test("css-color3 fixture sha256 + 74 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-color3 fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "hwb_to_rgb": {
        const [a, b, c] = r.arg.split(",").map(Number);
        got = f3(hwb_to_rgb(new F64(a), new F64(b), new F64(c)));
        break;
      }
      case "rgb_to_hwb": {
        const [a, b, c] = r.arg.split(",").map(Number);
        got = f3(rgb_to_hwb(new F64(a), new F64(b), new F64(c)));
        break;
      }
      case "hueToRgb": {
        const [a, b, c] = r.arg.split(",").map(Number);
        got = f12(hueToRgb(new F64(a), new F64(b), new F64(c)).Value());
        break;
      }
      case "packRGBA": {
        const [a, b, c, d] = r.arg.split(",").map(Number);
        got = String(packRGBA(new F64(a), new F64(b), new F64(c), d));
        break;
      }
      case "parseColorByte": {
        const [k, text, scale] = r.arg.split("|");
        const tk = new Token(); tk.Kind = Number(k); tk.Text = text;
        const v = parseColorByte(tk, Number(scale));
        got = `${v.value}|${v.ok}`;
        break;
      }
      case "degreesForAngle": {
        const [k, text, unit] = r.arg.split("|");
        const tk = new Token(); tk.Kind = Number(k); tk.Text = text; tk.UnitOffset = Number(unit);
        const v = degreesForAngle(tk);
        got = `${f12(v.value)}|${v.ok}`;
        break;
      }
      case "lowerAlphaPercentageToNumber": {
        const [k, text] = r.arg.split("|");
        const tk = new Token(); tk.Kind = Number(k); tk.Text = text;
        const v = lowerAlphaPercentageToNumber(tk);
        got = `${v.Kind}|${v.Text}`;
        break;
      }
      case "formatFloat": {
        const [v, d] = r.arg.split("|");
        got = formatFloat(new F64(Number(v)), Number(d));
        break;
      }
      case "interpolateHues": {
        const [a, b, t, m] = r.arg.split(",").map(Number);
        got = f12(interpolateHues(new F64(a), new F64(b), new F64(t), m).Value());
        break;
      }
      case "premultiply":
      case "unpremultiply": {
        const [a, b, c, alpha, cs] = r.arg.split(",").map(Number);
        const t = r.fn === "premultiply"
          ? premultiply(new F64(a), new F64(b), new F64(c), new F64(alpha), cs)
          : unpremultiply(new F64(a), new F64(b), new F64(c), new F64(alpha), cs);
        got = f3(t);
        break;
      }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 74);
});
