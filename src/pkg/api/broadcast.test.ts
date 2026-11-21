// 第 112 批：apiHandler.broadcastBuildResult 逐字节等于 Go（6 场景）。
// Go 期望来自 tools/go/tmpgen_broadcast_test.go。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { apiHandler } from "./serve_other.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/broadcast-go.json", import.meta.url)));
const SHA = "4e69b114eb411711a28ab51b9c309577fb466532d84b55adc4919a618d5a0f94";
type Row = { name: string; events: ({ event: string; data: string } | null)[][]; newHashes: Record<string, string> };
const rows = JSON.parse(new TextDecoder().decode(raw)) as Row[];

function run(idx: number): any {
  const c = idx;
  const oldHashes: Record<string, string> = [
    {}, { "/out/a.js": "h1" }, { "/out/a.js": "h1" },
    { "/out/b.js": "x", "/out/c.js": "y" }, { "/out/a.js": "h1" }, { "/out/a.js": "h1" },
  ][c] ?? {};
  const newHashesMap: Record<string, string> = [
    { "/out/a.js": "h1" }, { "/out/a.js": "h2" }, {},
    { "/out/a.js": "n", "/out/b.js": "z" }, { "/out/a.js": "h2" }, { "/out/a.js": "h1" },
  ][c];
  const hasErrors = c === 4;
  const absOut = "/out";
  const prefix = c === 3 ? "dist" : "";
  const publicPath = c === 3 ? "/static" : "";
  const nstreams = c === 3 ? 2 : 1;
  const h = new apiHandler();
  h.absOutputDir = absOut;
  h.outdirPathPrefix = prefix;
  h.publicPath = publicPath;
  for (const [k, v] of Object.entries(oldHashes)) h.currentHashes.set(k, v);
  const streams: ({ event: string; data: string }[])[] = [];
  for (let i = 0; i < nstreams; i++) {
    const evs: { event: string; data: string }[] = [];
    streams.push(evs);
    h.activeStreams.push((ev) => evs.push(ev));
  }
  const newMap = new Map(Object.entries(newHashesMap));
  h.broadcastBuildResult({ Errors: hasErrors ? [{}] : [] }, newMap);
  const newOut: Record<string, string> = {};
  for (const [k, v] of h.currentHashes) newOut[k] = v;
  return {
    name: rows[idx].name,
    events: streams.map((evs) => evs.length ? evs : null),
    newHashes: newOut,
  };
}

test("broadcast 夹具 sha256（6 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("broadcastBuildResult 逐字节等于 Go", () => {
  assert.equal(rows.length, 6);
  for (let i = 0; i < rows.length; i++) {
    assert.deepEqual(run(i), rows[i], `scenario ${i}: ${rows[i].name}`);
  }
});
