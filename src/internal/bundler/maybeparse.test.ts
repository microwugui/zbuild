// 第 120 轮：maybeParseFile 确定性状态缝逐字节等于 Go（4 场景，SHA f5a8f4e7…）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { maybeParseFile } from "./bundler.ts";
import { MakeCacheSet } from "../cache/cache.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/maybeparse-go.json", import.meta.url)));
const SHA = "f5a8f4e74c1f6b9caf9ad53ebd8dc5ac94eeb41cfdb3fbe570a81cd172cd5de5";
const rows = JSON.parse(new TextDecoder().decode(raw)) as any[];

type TC = { name: string; paths: string[]; preseed: string[]; preseedIdx: number[]; expectVisited: string[] };
const cases: TC[] = [
  { name: "visited-hit", paths: ["/p/a.js"], preseed: ["/p/a.js"], preseedIdx: [7], expectVisited: ["/p/a.js"] },
  { name: "new-path", paths: ["/p/b.js"], preseed: [], preseedIdx: [], expectVisited: ["/p/b.js"] },
  { name: "dedup", paths: ["/p/a.js", "/p/a.js", "/p/b.js"], preseed: [], preseedIdx: [], expectVisited: ["/p/a.js", "/p/b.js"] },
  { name: "namespace-canonical", paths: ["/p/../p/a.js"], preseed: ["/p/a.js"], preseedIdx: [5], expectVisited: ["/p/../p/a.js", "/p/a.js"] },
];

function run(tc: TC): any {
  const caches = MakeCacheSet();
  const s: any = { caches, visited: new Map<string, number>(), results: [], remaining: 0 };
  for (let i = 0; i < tc.preseed.length; i++) s.visited.set("file\u0000" + tc.preseed[i], tc.preseedIdx[i]);
  const returned: number[] = [];
  for (const p of tc.paths) returned.push(maybeParseFile(s, { Text: p, Namespace: "file" }));
  // drain (no-op onParse in TS matches Go drain-only)
  s.remaining = 0;
  const visited = [...s.visited.values?.() ?? []];
  // derive visited key texts (remove "file\0" prefix), sorted like Go
  const keys = [...s.visited.keys()].map((k) => k.split("\u0000")[1]).sort();
  return { name: tc.name, returned, visited: keys, remaining: s.remaining };
}

test("maybeparse 夹具 sha256（4 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("maybeParseFile 状态缝逐字节等于 Go", () => {
  for (let i = 0; i < rows.length; i++) assert.deepEqual(run(cases[i]), rows[i], `case ${i}: ${rows[i].name}`);
});
