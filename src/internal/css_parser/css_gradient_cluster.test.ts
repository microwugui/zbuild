// 第 59 轮叶子优先规划：css_parser 颜色/渐变整簇（一次 Go 探针、8 函数、逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { F64 } from "../helpers/float.ts";
import { Token } from "../css_ast/css_ast.ts";
import { hslToRgb, parseAlphaByte, tryToConvertToHexWithoutClipping } from "./css_decls_color.ts";
import { makeDimensionOrPercentToken, interpolateColors, interpolatePositions, tryToParseValue, removeColorInterpolation } from "./css_decls_gradient.ts";

const FIXTURE = new URL("../../../testdata/css-gradient-cluster-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "6c0aedc2b290b9a81db67fff661830910f5af2e4299061272fa14c95a5058284";

interface Row { fn: string; arg: string; out: string; }
const f12 = (v: number): string => Number.isNaN(v) ? "NaN" : v.toFixed(12);
const f3 = (t: [F64, F64, F64]): string => t.map((v) => f12(v.Value())).join(",");
interface TokIn { kind: number; text?: string; ws?: number; loc?: number; unit?: number; }
function mkTok(x: TokIn): Token {
  const t = new Token();
  t.Kind = x.kind; t.Text = x.text ?? ""; t.Whitespace = x.ws ?? 0; t.Loc = x.loc ?? 0;
  if (x.unit !== undefined) t.UnitOffset = x.unit;
  return t;
}

test("css-gradient-cluster fixture sha256 + 35 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-gradient-cluster fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "hslToRgb": {
        const [h, s, l] = r.arg.split(",").map(Number);
        got = f3(hslToRgb(new F64(h), new F64(s), new F64(l)));
        break;
      }
      case "parseAlphaByte": {
        const [k, text, uo] = r.arg.split("|");
        const tk = mkTok({ kind: Number(k), text, unit: Number(uo) });
        const v = parseAlphaByte(tk);
        got = `${v.value}|${v.ok}`;
        break;
      }
      case "tryToConvertToHexWithoutClipping": {
        const [x, y, z, a] = r.arg.split(",").map(Number);
        const v = tryToConvertToHexWithoutClipping(new F64(x), new F64(y), new F64(z), a);
        got = `${v.value}|${v.ok}`;
        break;
      }
      case "makeDimensionOrPercentToken": {
        const [loc, value, unit] = r.arg.split("|");
        const tk = makeDimensionOrPercentToken(Number(loc), new F64(Number(value)), unit);
        got = `${tk.Kind}|${tk.Text}|${tk.UnitOffset}|${tk.Loc}`;
        break;
      }
      case "interpolateColors": {
        const [a0, a1, a2, b0, b1, b2, cs, hm, t] = r.arg.split(",").map(Number);
        got = f3(interpolateColors(new F64(a0), new F64(a1), new F64(a2), new F64(b0), new F64(b1), new F64(b2), cs, hm, new F64(t)));
        break;
      }
      case "interpolatePositions": {
        const inArg = JSON.parse(r.arg);
        const a = inArg.a.map((x: { unit: string; value: number }) => ({ unit: x.unit, value: new F64(x.value) }));
        const b = inArg.b.map((x: { unit: string; value: number }) => ({ unit: x.unit, value: new F64(x.value) }));
        got = interpolatePositions(a, b, new F64(inArg.t)).map((x) => `${x.unit}=${f12(x.value.Value())}`).join(";");
        break;
      }
      case "tryToParseValue": {
        const [k, text, uo, gk] = r.arg.split("|");
        const tk = mkTok({ kind: Number(k), text, unit: Number(uo) });
        const v = tryToParseValue(tk, Number(gk));
        got = `${v.result.unit}|${f12(v.result.value.Value())}|${v.ok}`;
        break;
      }
      case "removeColorInterpolation": {
        const ins: TokIn[] = JSON.parse(r.arg);
        const v = removeColorInterpolation(ins.map(mkTok));
        got = v.remaining.map((t) => `${t.Kind}:${t.Text}:${t.Whitespace}`).join(";") + `|${v.space}|${v.method}|${v.ok}`;
        break;
      }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 35);
});
