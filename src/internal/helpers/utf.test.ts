// 对应 esbuild internal/helpers/utf.go 的差分测试
// 期望值由 Go 参考实现生成：tools/gen_helpers_fixture.go

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ContainsNonBMPCodePoint,
  ContainsNonBMPCodePointUTF16,
  DecodeWTF8Rune,
  StringToUTF16,
  UTF16EqualsString,
  UTF16EqualsUTF16,
  UTF16ToString,
  UTF16ToStringWithValidation,
  encodeWTF8Rune,
} from "./utf.ts";

interface UTF16Case {
  name: string;
  hex: string;
  utf16: number[];
  back: string;
  validBack: string;
  hasNonBmp: boolean;
  valid: boolean;
  badRune: number;
  equalsString: boolean;
  synthetic?: boolean;
}
interface DecodeCase {
  name: string;
  hex: string;
  at: number;
  r: number;
  width: number;
}

const fx: { utf16: UTF16Case[]; decodes: DecodeCase[] } = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../testdata/helpers.json"), "utf8"),
);

const fromHex = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const toHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

test("encodeWTF8Rune 写入并回读", () => {
  const buf = new Uint8Array(4);
  for (const [r, n] of [[0x41, 1], [0xe9, 2], [0x65e5, 3], [0x1f600, 4], [0xd800, 3]] as const) {
    assert.equal(encodeWTF8Rune(buf, 0, r), n);
    const d = DecodeWTF8Rune(buf, 0);
    assert.equal(d.r, r);
    assert.equal(d.width, n);
  }
  // 超出 Unicode 范围 → RuneError 的三字节编码
  assert.equal(encodeWTF8Rune(buf, 0, 0x110000), 3);
  assert.equal(DecodeWTF8Rune(buf, 0).r, 0xfffd);
});

test("DecodeWTF8Rune 空输入", () => {
  const d = DecodeWTF8Rune(new Uint8Array(0), 0);
  assert.equal(d.r, 0xfffd);
  assert.equal(d.width, 0);
});

test("UTF16EqualsUTF16", () => {
  assert.equal(UTF16EqualsUTF16([1, 2, 3], [1, 2, 3]), true);
  assert.equal(UTF16EqualsUTF16([1, 2, 3], [1, 2]), false);
  assert.equal(UTF16EqualsUTF16([1, 2, 3], [1, 2, 4]), false);
});

test("UTF16EqualsString 负例", () => {
  assert.equal(UTF16EqualsString([0x61], fromHex("6162")), false);
  assert.equal(UTF16EqualsString([0x61], fromHex("62")), false);
});

test("ContainsNonBMPCodePointUTF16 空与边界", () => {
  assert.equal(ContainsNonBMPCodePointUTF16([]), false);
  assert.equal(ContainsNonBMPCodePointUTF16([0xd800]), false);
  assert.equal(ContainsNonBMPCodePointUTF16([0xd800, 0xdc00]), true);
});

for (const c of fx.utf16) {
  if (!c.synthetic) {
    test(`StringToUTF16 差分: ${c.name}`, () => {
      assert.deepEqual(StringToUTF16(fromHex(c.hex)), c.utf16);
    });

    test(`ContainsNonBMPCodePoint 差分: ${c.name}`, () => {
      assert.equal(ContainsNonBMPCodePoint(fromHex(c.hex)), c.hasNonBmp);
    });

    test(`UTF16EqualsString 差分: ${c.name}`, () => {
      assert.equal(UTF16EqualsString(c.utf16, fromHex(c.hex)), c.equalsString);
    });
  }

  test(`UTF16ToString 差分: ${c.name}`, () => {
    assert.equal(toHex(UTF16ToString(c.utf16)), c.back);
  });

  test(`UTF16ToStringWithValidation 差分: ${c.name}`, () => {
    const r = UTF16ToStringWithValidation(c.utf16);
    assert.equal(r.ok, c.valid);
    assert.equal(r.bad, c.badRune);
    assert.equal(toHex(r.value), c.validBack);
  });
}

for (const c of fx.decodes) {
  test(`DecodeWTF8Rune 差分: ${c.name}@${c.at}`, () => {
    const d = DecodeWTF8Rune(fromHex(c.hex), c.at);
    assert.equal(d.r, c.r);
    assert.equal(d.width, c.width);
  });
}
