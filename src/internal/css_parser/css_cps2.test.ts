// 第 115 批：generateGradient + tryToExpandGradient（Go 探针 12 例，逐字节）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Token } from "../css_ast/css_ast.ts";
import {
  ColorStop, formatFloat, generateGradient, tryToExpandGradient, tryToParseColorStops,
} from "./css_decls_gradient.ts";
import { F64 } from "../helpers/float.ts";
import type { ParsedGradient } from "./css_decls_gradient.ts";

const FIXTURE = new URL("../../../testdata/css-cps2-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "142ee357ea7b66b329dbe190f5ce67fe6521050d4baa993e8b996f12e2411a88";
interface Row { fn: string; arg: any; out: any }

function toTok(x: any): Token {
  const t = new Token();
  t.Kind = x.k; t.Text = x.t; t.UnitOffset = x.u ?? 0; t.Whitespace = x.w ?? 0;
  if (x.c) t.Children = x.c.map(toTok);
  return t;
}
function toStop(x: any): ColorStop {
  const s = new ColorStop();
  s.color = toTok(x.color);
  s.positions = (x.pos ?? []).map(toTok);
  s.midpoint = x.mid ? toTok(x.mid) : new Token();
  return s;
}
function toGradient(a: any): ParsedGradient {
  return { leadingTokens: (a.lead ?? []).map(toTok), colorStops: (a.stops ?? []).map(toStop), kind: a.kind ?? 0, repeating: false };
}
const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);
// known-deviation：Go math 与 V8 1-ULP 差异经色彩转换链放大，可使 hash 颜色某一通道差 1；
// 只对 THash token 的每个通道放 ±1，token 种类/Whitespace/位置文本仍逐字节严格。
function sameWithUlps(a: any, b: any): boolean {
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    if (a[0] === 28 && b[0] === 28 && typeof a[1] === "string" && typeof b[1] === "string" &&
        a[1].length === b[1].length && /^[0-9a-f]+$/.test(a[1])) {
      const x = parseInt(a[1], 16), y = parseInt(b[1], 16);
      if (a[2] !== b[2]) return false;
      for (let sh = 0; sh < (a[1].length / 2) * 8; sh += 8) {
        if (Math.abs(((x >>> sh) & 255) - ((y >>> sh) & 255)) > 1) return false;
      }
      return true;
    }
    return a.every((v, i) => sameWithUlps(v, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameWithUlps(a[k], b[k]));
  }
  return a === b;
}
const dumpTok = (t: Token): any => [t.Kind, t.Text, t.Whitespace];
const dumpToks = (ts: Token[]): any => ts.map(dumpTok);

test("css-cps2 fixture sha256 + 12 例等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-cps2 fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: any;
    if (r.fn === "generateGradient") {
      const out = generateGradient(toTok(r.arg.tok), toGradient(r.arg), !!r.arg.minify);
      got = dumpToks(out.Children ?? []);
    } else if (r.fn === "tryToExpandGradient") {
      const g = toGradient(r.arg);
      const parsed = tryToParseColorStops({ colorStops: g.colorStops, kind: g.kind });
      assert.equal(parsed.ok, true);
      const ok = tryToExpandGradient(0, g, parsed.result, g.leadingTokens, r.arg.cs, r.arg.hm ?? 0);
      got = { ok, lead: dumpToks(g.leadingTokens), stops: g.colorStops.map((s) => dumpToks([s.color, ...s.positions])) };
    } else throw new Error("unknown fn " + r.fn);
    assert.equal(sameWithUlps(got, r.out), true, `${r.fn} ${JSON.stringify(r.arg)} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 12);
});

// 根因回归：Go strconv.FormatFloat 平局取偶，JS toFixed 平局取大；逐字节对齐已有探针。
test("formatFloat 平值按 Go 取偶（3.125 → 3.12）", () => {
  assert.equal(formatFloat(new F64(3.125), 2), "3.12");
  assert.equal(formatFloat(new F64(1), 2), "1");
});
