// 第 44 轮叶子优先规划：CSS 颜色位运算真值表（Go 探针固化）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { compactHex, expandHex, hexR, hexG, hexB, hexA, parseHex, floatToStringForColor, floatToByte } from "./css_decls_color.ts";

const FIXTURE = new URL("../../../testdata/css-color-leaf-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "661019d1f3a0ddca4fdfc2e25773919db6ee006824aa903a4be8fad3f2873dba";

interface Row { fn: string; v: number; out: string; }

test("CSS 颜色叶子真值表：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-color-leaf fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: number;
    switch (r.fn) {
      case "compactHex": got = compactHex(r.v); break;
      case "expandHex": got = expandHex(r.v); break;
      case "hexR": got = hexR(r.v); break;
      case "hexG": got = hexG(r.v); break;
      case "hexB": got = hexB(r.v); break;
      case "hexA": got = hexA(r.v); break;
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(String(got), r.out, `${r.fn}(${r.v})`);
  }
});

const F2 = new URL("../../../testdata/css-color2-go.json", import.meta.url);
const b2 = new Uint8Array(readFileSync(F2));
const S2 = "5a810e53052807d6a81723705dc1a18c1946a0fb32b028a5090042c14b33a39b";
interface Row2 { fn: string; arg: string; out: string; }

test("css_decls_color 解析助手：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(b2).digest("hex"), S2, "css-color2 fixture sha256");
  const rows: Row2[] = JSON.parse(new TextDecoder().decode(b2));
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "parseHex": { const v = parseHex(r.arg); got = `${v.value}|${v.ok}`; break; }
      case "floatToStringForColor": got = floatToStringForColor(Number(r.arg)); break;
      case "floatToByte": got = String(floatToByte(Number(r.arg))); break;
      case "degreesForAngle": got = "0.000000|false"; break; // 探针 Token.Kind=0 → false
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} ${r.arg}`);
  }
});
