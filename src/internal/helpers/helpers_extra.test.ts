// helpers 第二批（strings/float/comment/bitset/joiner/typos/hash）的差分测试
// 期望值由 Go 参考实现生成：tools/gen_helpers2_fixture.go
//
// 两条比对约定（都在这里显式实现，不藏在断言里）：
//   1. 浮点按 IEEE-754 位模式比对；NaN 只比较「是 NaN」，因为 Go 与 V8 的
//      NaN 载荷不同（0x7FF8000000000001 vs ...0000），而 esbuild 输出只关心 NaN 性。
//   2. Go 的 nil slice 经 JSON 变成 null，这里统一归一化为空数组。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { NewBitSet } from "./bitset.ts";
import { EscapeClosingTag } from "./comment.ts";
import { F64, Lerp, Max2, Max3, Min2, Min3, NewF64 } from "./float.ts";
import { HashCombine, HashCombineString } from "./hash.ts";
import { Joiner } from "./joiner.ts";
import { PrettyPrintedStack } from "./stack.ts";
import { StringArrayArraysEqual, StringArrayToQuotedCommaSeparatedString, StringArraysEqual } from "./strings.ts";
import { MakeTypoDetector } from "./typos.ts";

const arr = <T>(x: T[] | null | undefined): T[] => x ?? [];

interface FX {
  floatUnary: Record<string, string>[];
  floatBinary: Record<string, string>[];
  hash: { seed: number; hash: number; out: number }[];
  hashString: { seed: number; text: string; out: number }[];
  escape: { text: string; slashTag: string; out: string }[];
  bitset: { count: number; set: number[] | null; hasTrue: number[] | null; hasFalse: number[] | null; entries: string }[];
  joiner: { strings: string[] | null; bytes: string[] | null; length: number; last: number; done: string; hasStr: boolean; hasByte: boolean; ensureNewline?: boolean }[];
  typo: { valid: string[]; queries: string[]; results: string[]; oks: boolean[] };
  strings: { a?: string[] | null; b?: string[] | null; eq?: boolean; aa?: string[][] | null; bb?: string[][] | null; aaEq?: boolean; joined: string }[];
}

const fx: FX = JSON.parse(readFileSync(join(import.meta.dirname, "../../../testdata/helpers2.json"), "utf8"));

const dv = new DataView(new ArrayBuffer(8));
function bits(x: number): string {
  dv.setFloat64(0, x, false);
  let s = "";
  for (const v of new Uint8Array(dv.buffer)) s += v.toString(16).padStart(2, "0");
  return s;
}
function fromBits(hex: string): number {
  const bytes = new Uint8Array(8);
  for (let i = 0; i < 8; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const view = new DataView(bytes.buffer);
  return view.getFloat64(0, false);
}
function sameBits(a: number, expectHex: string): boolean {
  if (Number.isNaN(a)) return expectHex === "7ff8000000000000" || expectHex === "fff8000000000000" ||
    (parseInt(expectHex.slice(0, 3), 16) & 0x7ff) === 0x7ff && (parseInt(expectHex.slice(3), 16) !== 0);
  return bits(a) === expectHex;
}
const fromHex = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const toHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/* ---------------- F64 ---------------- */

for (const c of fx.floatUnary) {
  const a = new F64(fromBits(c.x));
  const checks: [string, number][] = [
    ["value", a.Value()], ["neg", a.Neg().Value()], ["abs", a.Abs().Value()],
    ["sin", a.Sin().Value()], ["cos", a.Cos().Value()], ["log2", a.Log2().Value()],
    ["round", a.Round().Value()], ["floor", a.Floor().Value()], ["ceil", a.Ceil().Value()],
    ["sq", a.Squared().Value()], ["cube", a.Cubed().Value()],
    ["sqrt", a.Sqrt().Value()], ["cbrt", a.Cbrt().Value()],
    ["addConst", a.AddConst(2.5).Value()], ["subConst", a.SubConst(2.5).Value()],
    ["mulConst", a.MulConst(-1.25).Value()], ["divConst", a.DivConst(3).Value()],
    ["powConst", a.PowConst(3).Value()],
  ];
  for (const [k, v] of checks) {
    test(`F64.${k} bits=${c.x}`, () => {
      assert.ok(sameBits(v, c[k]), `${k}: ${bits(v)} != ${c[k]}`);
    });
  }
  test(`F64.isNaN bits=${c.x}`, () => {
    assert.equal(String(a.IsNaN()), c.isNaN);
  });
}

for (const c of fx.floatBinary) {
  const a = new F64(fromBits(c.a)), b = new F64(fromBits(c.b));
  const checks: [string, number][] = [
    ["add", a.Add(b).Value()], ["sub", a.Sub(b).Value()], ["mul", a.Mul(b).Value()],
    ["div", a.Div(b).Value()], ["pow", a.Pow(b).Value()], ["atan2", a.Atan2(b).Value()],
    ["sign", a.WithSignFrom(b).Value()],
    ["min2", Min2(a, b).Value()], ["max2", Max2(a, b).Value()],
    ["min3", Min3(a, b, NewF64(-7)).Value()], ["max3", Max3(a, b, NewF64(-7)).Value()],
    ["lerp", Lerp(a, b, NewF64(0.25)).Value()],
  ];
  for (const [k, v] of checks) {
    test(`F64.${k} ${c.a}/${c.b}`, () => {
      assert.ok(sameBits(v, c[k]), `${k}: ${bits(v)} != ${c[k]}`);
    });
  }
}

/* ---------------- hash ---------------- */

for (const c of fx.hash) {
  test(`HashCombine ${c.seed}/${c.hash}`, () => assert.equal(HashCombine(c.seed, c.hash), c.out));
}
for (const c of fx.hashString) {
  test(`HashCombineString ${c.text}`, () =>
    assert.equal(HashCombineString(c.seed, new TextEncoder().encode(c.text)), c.out));
}

/* ---------------- EscapeClosingTag ---------------- */

for (const [i, c] of fx.escape.entries()) {
  test(`EscapeClosingTag #${i}`, () => {
    const out = EscapeClosingTag(new TextEncoder().encode(c.text), new TextEncoder().encode(c.slashTag));
    assert.equal(new TextDecoder().decode(out), c.out);
  });
}

/* ---------------- BitSet ---------------- */

for (const c of fx.bitset) {
  test(`BitSet count=${c.count}`, () => {
    const bs = NewBitSet(c.count);
    for (const b of arr(c.set)) bs.SetBit(b);
    for (const b of arr(c.hasTrue)) assert.equal(bs.HasBit(b), true);
    for (const b of arr(c.hasFalse)) assert.equal(bs.HasBit(b), false);
    assert.equal(toHex(bs.String()), c.entries);
    const other = NewBitSet(c.count);
    for (const b of arr(c.set)) other.SetBit(b);
    assert.equal(bs.Equals(other), true);
    assert.equal(bs.Equals(NewBitSet(c.count)), arr(c.set).length === 0);
  });
}

/* ---------------- Joiner ---------------- */

for (const [i, c] of fx.joiner.entries()) {
  test(`Joiner #${i}`, () => {
    const j = new Joiner();
    for (const s of arr(c.strings)) j.AddString(new TextEncoder().encode(s));
    for (const b of arr(c.bytes)) j.AddBytes(fromHex(b));
    // 夹具显式记录「生成时又调了两次 EnsureNewlineAtEnd」（Go 生成器里的调用序列）
    if (c.ensureNewline) {
      j.EnsureNewlineAtEnd();
      j.EnsureNewlineAtEnd();
    }
    assert.equal(j.Length(), c.length);
    assert.equal(j.LastByte(), c.last);
    assert.equal(toHex(j.Done()), c.done);
    assert.equal(j.Contains(new TextEncoder().encode("bc"), new Uint8Array(0)), c.hasStr);
    assert.equal(j.Contains(new TextEncoder().encode(""), new Uint8Array([3])), c.hasByte);
  });
}

test("Joiner EnsureNewlineAtEnd", () => {
  const j = new Joiner();
  j.AddString(new TextEncoder().encode("abc"));
  j.EnsureNewlineAtEnd();
  j.EnsureNewlineAtEnd();
  assert.equal(new TextDecoder().decode(j.Done()), "abc\n");
  assert.equal(j.Length(), 4);
});

/* ---------------- TypoDetector ---------------- */

test("TypoDetector", () => {
  const det = MakeTypoDetector(fx.typo.valid);
  for (let i = 0; i < fx.typo.queries.length; i++) {
    const r = det.MaybeCorrectTypo(fx.typo.queries[i]);
    assert.equal(r.value, fx.typo.results[i], `query=${fx.typo.queries[i]}`);
    assert.equal(r.ok, fx.typo.oks[i], `query=${fx.typo.queries[i]}`);
  }
});

/* ---------------- strings ---------------- */

for (const [i, c] of fx.strings.entries()) {
  test(`StringArrayToQuotedCommaSeparatedString #${i}`, () => {
    assert.equal(StringArrayToQuotedCommaSeparatedString(arr(c.a)), c.joined);
  });
  if (c.b != null) {
    test(`StringArraysEqual #${i}`, () => {
      assert.equal(StringArraysEqual(arr(c.a), arr(c.b)), c.eq);
    });
  }
  if (c.aa != null && c.bb != null) {
    test(`StringArrayArraysEqual #${i}`, () => {
      assert.equal(StringArrayArraysEqual(arr(c.aa), arr(c.bb)), c.aaEq);
    });
  }
}

/* ---------------- Stack ---------------- */

test("PrettyPrintedStack 形态", () => {
  const s = PrettyPrintedStack();
  assert.equal(typeof s, "string");
  assert.ok(s.length > 0);
  assert.ok(!s.includes("\t"));
});

/* ---------------- 三条已修缺陷的最小复现（根因锁定，不是只靠夹具） ---------------- */

// 根因：Go 是 `correct[:i]+correct[i+RuneLen(ch):]`，删的是**第 i 个码点**；
// 旧实现用 String.replace(ch, "")，删的是首个出现处 —— "esnext" 有两个 'e'，
// 于是变体表里永远没有 "esnxt"。期望值 "esnxt"→"esnext" 是夹具（Go 生成）里的实测值。
test("TypoDetector: 按码点下标逐个删（esnext 少第二个 e 也要能纠）", () => {
  const det = MakeTypoDetector(["esnext"]);
  assert.deepEqual(det.MaybeCorrectTypo("esnxt"), { value: "esnext", ok: true });
  // 夹具里 query="esnext" 的 Go 实测结果是 ("esnext", true)：删掉第二个 e 得到的 "esnxt"
  // 正在变体表里，所以正确单词也会被「纠正」成自己（Go 行为，调用方只对未知词调用）。
  assert.deepEqual(det.MaybeCorrectTypo("esnext"), { value: "esnext", ok: true });
});

// 根因：Go 的 nil slice 长度是 0（len(nil)==0），JSON 夹具里就是 null；
// 旧实现直接读 .length → TypeError。夹具 strings[2] = {aa:[null], bb:[null], aaEq:true} 是 Go 实测。
test("StringArraysEqual/StringArrayArraysEqual: null 当空 slice（Go nil slice 语义）", () => {
  assert.equal(StringArraysEqual(null, null), true);
  assert.equal(StringArraysEqual(null, []), true);
  assert.equal(StringArraysEqual(null, ["a"]), false);
  assert.equal(StringArrayArraysEqual([null], [null]), true);
  assert.equal(StringArrayArraysEqual([null], [[]]), true);
});

// 根因：Go 的 Contains(s, b) 是「任一 string 项包含 s 或任一 bytes 项包含 b」，
// 而 strings.Contains(item, "") 恒为 true —— 所以只要有 string 项，Contains("", …) 就是 true。
// 旧夹具把这一位写成了零值 false（不是实测），本轮已在生成器里改成实测。
test("Joiner.Contains: 空 needle 在非空 string 项上恒真（Go: strings.Contains 语义）", () => {
  const j = new Joiner();
  j.AddString(new TextEncoder().encode("abc"));
  assert.equal(j.Contains(new Uint8Array(0), new Uint8Array([3])), true);
  assert.equal(j.Contains(new TextEncoder().encode("bc"), new Uint8Array(0)), true);
});
