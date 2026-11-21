// 第 119 轮：runService stdin 帧循环逐字节等于 Go（4 场景，SHA 95834465…）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runService } from "./service.ts";
import { encodePacket } from "./stdio_protocol.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/service-loop-go.json", import.meta.url)));
const SHA = "958344658fb83c7bb5556f184237792050f86c36faf8baea6d8432760c748859";
const rows = JSON.parse(new TextDecoder().decode(raw)) as any[];

const mkPacket = (id: number): Uint8Array => encodePacket({ id, isRequest: true, value: { command: "ping" } });
const cases: { name: string; stdin: Uint8Array }[] = [
  { name: "empty", stdin: new Uint8Array(0) },
  { name: "one-packet", stdin: mkPacket(1) },
  { name: "two-packets", stdin: (() => { const a = mkPacket(1), b = mkPacket(2); const n = new Uint8Array(a.length + b.length); n.set(a); n.set(b, a.length); return n; })() },
  { name: "partial", stdin: mkPacket(1).slice(0, mkPacket(1).length - 2) },
];

function run(stdin: Uint8Array): any {
  const dispatch = () => encodePacket({ id: 1, isRequest: false, value: {} });
  const { stdout, packets } = runService(stdin, dispatch);
  return { stdout: Buffer.from(stdout).toString("base64"), packets };
}

test("service-loop 夹具 sha256（4 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("runService 帧循环逐字节等于 Go", () => {
  for (let i = 0; i < rows.length; i++) {
    const got = run(cases[i].stdin);
    assert.deepEqual({ stdout: got.stdout, packets: got.packets }, { stdout: rows[i].stdout, packets: rows[i].packets }, `case ${i}: ${rows[i].name}`);
  }
});
