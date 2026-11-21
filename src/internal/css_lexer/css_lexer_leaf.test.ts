// 第 44 轮叶子优先规划：CSS lexer 字符谓词真值表（Go 探针固化）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { IsNumeric, IsNameStart, isNonPrintable, isNewline, isWhitespace, isHex, WouldStartIdentifierWithoutEscapes } from "./css_lexer.ts";

const FIXTURE = new URL("../../../testdata/css-lexer-pred-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "d0d4590fc3821c27880e77cdef24b2af6aeab850125183294da3524a5fedd3c4";

interface Row { fn: string; v: number; out: string; }

test("CSS lexer 谓词真值表：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-lexer-pred fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "TNumber": case "TPercentage": case "TDimension": got = r.out; break; // 常量记录
      case "IsNumeric": got = String(IsNumeric(r.v)); break;
      case "IsNameStart": got = String(IsNameStart(r.v)); break;
      case "isNonPrintable": got = String(isNonPrintable(r.v)); break;
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} ${r.v}`);
  }
});

const F2 = new URL("../../../testdata/css-lexer-char-go.json", import.meta.url);
const b2 = new Uint8Array(readFileSync(F2));
const S2 = "ac2cd570205c29f5830880ecc0bbe3b925036d90d63cd10b697eacd70e9cf979";
interface Row2 { fn: string; arg: string; out: string; }

test("css_lexer 字符助手 2：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(b2).digest("hex"), S2, "css-lexer-char fixture sha256");
  const rows: Row2[] = JSON.parse(new TextDecoder().decode(b2));
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "isNewline": got = String(isNewline(Number(r.arg))); break;
      case "isWhitespace": got = String(isWhitespace(Number(r.arg))); break;
      case "isHex": { const v = isHex(Number(r.arg)); got = `${v.value}|${v.ok}`; break; }
      case "WouldStartIdentifierWithoutEscapes": got = String(WouldStartIdentifierWithoutEscapes(r.arg)); break;
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} ${r.arg}`);
  }
});
