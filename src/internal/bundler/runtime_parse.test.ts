// 第 120 轮：parseRuntime 确定性 1:1 投影逐字节等于 Go（source hash + parts/stmt 结构，3 配置）。
// 符号表 Go344/TS233（unbound 全局）差异属 parser 骨架限制，不在本缝覆盖，诚实标注。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseRuntime } from "./bundler.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/runtime-parse-go.json", import.meta.url)));
const SHA = "1431fef748a3b93ecf9a87f4280df9524676ca162fef2f950280ceac17c16297";
const rows = JSON.parse(new TextDecoder().decode(raw)) as any[];

type TC = { name: string; feat: bigint; ms: boolean; mi: boolean };
const cases: TC[] = [
  { name: "default", feat: 0n, ms: false, mi: false },
  { name: "es2015", feat: BigInt("0x165fe46fc5c5ffb9"), ms: false, mi: false },
  { name: "minify", feat: 0n, ms: true, mi: true },
];

function run(tc: TC): any {
  const r = parseRuntime(tc.feat, tc.ms, tc.mi);
  return { name: tc.name, sourceLen: r.sourceLen, sourceSha: r.sourceSha, ok: r.ok,
    numParts: r.numParts, stmtKinds: r.stmtKinds, numImports: r.numImports };
}

test("runtime-parse 夹具 sha256（3 配置）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("parseRuntime 确定性投影逐字节等于 Go", () => {
  for (let i = 0; i < rows.length; i++) assert.deepEqual(run(cases[i]), rows[i], `case ${i}: ${rows[i].name}`);
});
