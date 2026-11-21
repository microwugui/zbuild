// 第 105 轮：internalContext 生命周期状态机逐字节等于 Go（4 场景）。
// Go 探针 tools/go/tmpgen_ctxstate_test.go → testdata/ctx-state-go.json。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { BuildContext } from "./api_impl.ts";
import type { BuildResult } from "./api_impl.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/ctx-state-go.json", import.meta.url)));
const SHA = "22f8bc8de62cf35ab05a664a9279d3e1d8dd68c515aabf0909d34d6acc1f3cad";
const rows = JSON.parse(new TextDecoder().decode(raw)) as any[];

const mkResult = (): BuildResult => ({ Errors: [], Warnings: [], OutputFiles: [{ Path: "<stdout>", Contents: new TextEncoder().encode("var x = 1;\n"), Hash: "abc123" }], Metafile: "", MangleCache: null });
const dump = (name: string, ctx: BuildContext, resFiles: { path: string; contents: string; hash: string }[]): any => ({
  name,
  didDispose: ctx.didDispose,
  activeNil: ctx.activeBuild === null,
  recentNil: ctx.recentBuild === null,
  resultFiles: resFiles,
});
const files = (r: BuildResult) => r.OutputFiles.map((f) => ({ path: f.Path, contents: new TextDecoder().decode(f.Contents), hash: f.Hash }));

function run(idx: number): any {
  const ctx = new BuildContext({});
  if (idx === 0) {
    ctx.Cancel();
    return dump(rows[idx].name, ctx, []);
  } else if (idx === 1) {
    ctx.didDispose = true;
    ctx.Cancel(); ctx.Dispose();
    return dump(rows[idx].name, ctx, []);
  } else if (idx === 2) {
    ctx.recentBuild = mkResult();
    const res = ctx.activeBuildOrRecentBuildOrRebuild();
    return dump(rows[idx].name, ctx, files(res));
  } else if (idx === 3) {
    ctx.recentBuild = mkResult();
    ctx.Dispose();
    return dump(rows[idx].name, ctx, []);
  } else {
    ctx.didDispose = true;
    const st = ctx.rebuild();
    return dump(rows[idx].name, ctx, files(st.result));
  }
}

test("ctx-state 夹具 sha256（4 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("Cancel/Dispose/activeBuildOrRecentBuildOrRebuild 状态机逐字节等于 Go（4 场景）", () => {
  assert.equal(rows.length, 5);
  for (let i = 0; i < rows.length; i++) {
    assert.deepEqual(run(i), rows[i], `scenario ${i}: ${rows[i].name}`);
  }
});
