// 第 119 轮：main os.Args 预扫描逐字节等于 Go（9 参数集，SHA 38eec378…）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { main } from "./main.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/main-scan-go.json", import.meta.url)));
const SHA = "38eec37820a5678f0f200905f3c5575fb0d9a7d1f6cf1b431ca3de4c09d2a9e8";
const rows = JSON.parse(new TextDecoder().decode(raw)) as any[];

const cases: string[][] = [
  ["a.js"],
  ["--help"],
  ["--version"],
  ["--service=0.28.2", "--ping"],
  ["--service=0.99.0"],
  ["--heap=/tmp/h", "--trace=/tmp/t", "--cpuprofile=/tmp/c", "--timing", "a.js"],
  ["--watch=forever", "a.js"],
  ["--serve=8000", "a.js"],
  ["--watch", "--serve", "a.js", "--minify"],
];

function toRow(s: ReturnType<typeof main>): any {
  return {
    heapFile: s.heapFile, traceFile: s.traceFile, cpuProfile: s.cpuProfile,
    isRunningService: s.isRunningService, sendPings: s.sendPings,
    isWatch: s.isWatch, isWatchForever: s.isWatchForever, isServe: s.isServe,
    useTimer: s.useTimer, args: s.args, earlyAction: s.earlyAction,
  };
}

test("main-scan 夹具 sha256（9 参数集）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("main os.Args 预扫描逐字节等于 Go", () => {
  assert.equal(rows.length, cases.length);
  for (let i = 0; i < rows.length; i++) assert.deepEqual(toRow(main(cases[i])), rows[i], `case ${i}: ${cases[i].join(" ")}`);
});
