// 第 106 轮 setWatchData（4 场景）+ 第 107 轮 tryToFindDirtyPath（预置 itemsToScan 绕开 rand，6 场景）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { watcher } from "./watcher.ts";
import type { WatchData } from "./watcher.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/watcher-state-go.json", import.meta.url)));
const SHA = "7617d3d23ab2dd0cd47d343270addc3ce0d453b33c01d86ce5e0f4fea2021c15";
const rows = JSON.parse(new TextDecoder().decode(raw)) as any[];

const fn = () => "";
function run(idx: number): any {
  const w = new watcher();
  const recent = [[], ["a.js", "gone.js", "b.js"], ["x.js", "y.js"], ["a.js"]][idx];
  const paths = [["a.js", "b.js"], ["a.js", "b.js"], ["a.js"], []][idx];
  w.recentItems = [...recent];
  w.itemsToScan = ["old1", "old2"];
  const wd: WatchData = { Paths: new Map(paths.map((p) => [p, fn])) };
  w.setWatchData(wd);
  const keys = [...w.data.Paths.keys()].sort();
  return { name: rows[idx].name, dataPaths: keys, recentItems: w.recentItems, itemsToScan: w.itemsToScan.length };
}

test("watcher-state 夹具 sha256（4 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("setWatchData 状态机逐字节等于 Go（4 场景）", () => {
  assert.equal(rows.length, 4);
  for (let i = 0; i < rows.length; i++) assert.deepEqual(run(i), rows[i], `scenario ${i}: ${rows[i].name}`);
});

// ── 第 107 轮：tryToFindDirtyPath（SHA 87db84eb…，6 场景）──────────────────
const dirtyRaw = new Uint8Array(readFileSync(new URL("../../../testdata/watch-dirty-go.json", import.meta.url)));
const dirtySHA = "87db84eb7e30ce373d02221220191c22dd959463be876e50272eb53393060488";
const dirtyRows = JSON.parse(new TextDecoder().decode(dirtyRaw)) as any[];

const mkPaths = () => new Map<string, () => string>([
  ["a", () => ""], ["b", () => "b"], ["c", () => "C"], ["d", () => ""],
]);

function runDirty(idx: number): any {
  const w = new watcher();
  w.data = { Paths: mkPaths() };
  const setup = [
    { recent: ["a", "b"], scan: ["c"], per: 1 },
    { recent: ["a"], scan: ["a", "b", "c"], per: 1 },
    { recent: [], scan: ["c"], per: 1 },
    { recent: ["a", "d"], scan: ["a", "d"], per: 2 },
    { recent: ["a", "c", "d"], scan: ["d"], per: 1 },
    { recent: [], scan: ["a", "b"], per: 99 },
  ][idx];
  w.recentItems = [...setup.recent];
  w.itemsToScan = [...setup.scan];
  w.itemsPerIteration = setup.per;
  const dirty = w.tryToFindDirtyPath();
  return { name: dirtyRows[idx].name, dirty, recentItems: w.recentItems, itemsToScan: w.itemsToScan, itemsPerIter: w.itemsPerIteration };
}

test("watch-dirty 夹具 sha256（6 场景）", () => {
  assert.equal(createHash("sha256").update(dirtyRaw).digest("hex"), dirtySHA);
});

test("tryToFindDirtyPath 确定性路径逐字节等于 Go（6 场景）", () => {
  assert.equal(dirtyRows.length, 6);
  for (let i = 0; i < dirtyRows.length; i++) assert.deepEqual(runDirty(i), dirtyRows[i], `scenario ${i}: ${dirtyRows[i].name}`);
});

