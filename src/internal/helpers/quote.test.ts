// 对应 esbuild internal/helpers/quote.go 的差分测试
// 期望值由 Go 参考实现生成：tools/gen_helpers_fixture.go

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { QuoteForJSON, QuoteSingle, canPrintWithoutEscape } from "./quote.ts";

interface QuoteCase {
  name: string;
  hex: string;
  single: string;
  singleAscii: string;
  json: string;
  jsonAscii: string;
}

const fx: { quotes: QuoteCase[] } = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../testdata/helpers.json"), "utf8"),
);

const fromHex = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const toHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

test("canPrintWithoutEscape", () => {
  assert.equal(canPrintWithoutEscape(0x41, true), true);
  assert.equal(canPrintWithoutEscape(0x1f, true), false);
  assert.equal(canPrintWithoutEscape(0x22, true), false); // "
  assert.equal(canPrintWithoutEscape(0x5c, true), false); // \
  assert.equal(canPrintWithoutEscape(0xe9, true), false);
  assert.equal(canPrintWithoutEscape(0xe9, false), true);
  assert.equal(canPrintWithoutEscape(0xfeff, false), false); // BOM
  assert.equal(canPrintWithoutEscape(0xd800, false), false); // 孤立代理
  assert.equal(canPrintWithoutEscape(0x1f600, false), true);
});

test("空串", () => {
  assert.equal(toHex(QuoteSingle(new Uint8Array(0), false)), "2727");
  assert.equal(toHex(QuoteForJSON(new Uint8Array(0), false)), "2222");
});

for (const c of fx.quotes) {
  test(`QuoteSingle 差分: ${c.name}`, () => {
    assert.equal(toHex(QuoteSingle(fromHex(c.hex), false)), c.single);
  });
  test(`QuoteSingle asciiOnly 差分: ${c.name}`, () => {
    assert.equal(toHex(QuoteSingle(fromHex(c.hex), true)), c.singleAscii);
  });
  test(`QuoteForJSON 差分: ${c.name}`, () => {
    assert.equal(toHex(QuoteForJSON(fromHex(c.hex), false)), c.json);
  });
  test(`QuoteForJSON asciiOnly 差分: ${c.name}`, () => {
    assert.equal(toHex(QuoteForJSON(fromHex(c.hex), true)), c.jsonAscii);
  });
}
