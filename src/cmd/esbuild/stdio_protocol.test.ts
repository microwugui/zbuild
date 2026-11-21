// 第 44 轮叶子优先规划：stdio 二进制协议原语（Go 探针字节证据）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readUint32, writeUint32, readLengthPrefixedSlice } from "./stdio_protocol.ts";

const FIXTURE = new URL("../../../testdata/stdio-protocol-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "fb0faba54a732fc19a9eaa0dd4571fa392aa2b3138f448d187648f1aa3cf2648";

interface Row { fn: string; in: string; val: number; out: string; left: string; ok: boolean; }
const dec = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const enc = (b: Uint8Array) => Buffer.from(b).toString("base64");

test("stdio 协议原语：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "stdio-protocol fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let out = "", left = "", ok = false;
    switch (r.fn) {
      case "readUint32": { const v = readUint32(dec(r.in)); out = String(v.value); left = enc(v.leftOver); ok = v.ok; break; }
      case "writeUint32": { out = enc(writeUint32(new Uint8Array(0), r.val)); ok = true; break; }
      case "readLengthPrefixedSlice": { const v = readLengthPrefixedSlice(dec(r.in)); out = enc(v.slice); left = enc(v.leftOver); ok = v.ok; break; }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(out, r.out, `${r.fn} out ${r.in}`);
    assert.equal(left, r.left, `${r.fn} left ${r.in}`);
    assert.equal(ok, r.ok, `${r.fn} ok ${r.in}`);
  }
});
