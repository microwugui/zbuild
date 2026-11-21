// 第 120 轮：parseFile stdin 缝确定性投影逐字节等于 Go（3 场景，SHA 992e3844…）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseFile } from "./bundler.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/parsefile-go.json", import.meta.url)));
const SHA = "992e3844152d0d07d36ebde8e811abb60ea611908227606aae6bce87d46fd9ec";
const rows = JSON.parse(new TextDecoder().decode(raw)) as any[];

const cases = [
  { name: "js-var", contents: "var x = 1;", loader: 10 },
  { name: "js-fn", contents: "function f() { return 2; }", loader: 10 },
  { name: "json", contents: '{"a":1}', loader: 11 },
];

function run(tc: typeof cases[number]): any {
  const r = parseFile(tc.contents, tc.loader);
  return { name: tc.name, ok: r.ok, loader: r.loader, sideKind: r.sideKind,
    numParts: r.numParts, stmtKinds: r.stmtKinds, numImports: r.numImports };
}

test("parsefile 夹具 sha256（3 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("parseFile stdin 缝逐字节等于 Go", () => {
  for (let i = 0; i < rows.length; i++) assert.deepEqual(run(cases[i]), rows[i], `case ${i}: ${rows[i].name}`);
});
