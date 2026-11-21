// 第 80 轮：css_ast 两个 String 方法落地差分测试。Go 探针实测 → testdata/css-ast-string-go.json（SHA 钉死）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { String as pseudoClassString } from "./css_ast.ts";
import { mqCmpString } from "./css_ast.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/css-ast-string-go.json", import.meta.url)));
const SHA = "27484dd93c45249bc7e4e2ecd508c670ee3f083fd4e09ffe23ec7b0bf77c5dfa";
interface Truth { mq: string[]; pc: string[]; }
const truth: Truth = JSON.parse(new TextDecoder().decode(raw));

test("css-ast String fixture sha256 + MQCmp.String / PseudoClassKind.String 逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
  for (let i = 0; i < truth.mq.length; i++) assert.equal(mqCmpString(i), truth.mq[i], `MQCmp ${i}`);
  for (let i = 0; i < truth.pc.length; i++) assert.equal(pseudoClassString(i), truth.pc[i], `PseudoClass ${i}`);
  assert.throws(() => pseudoClassString(99), /Internal error/);
});
