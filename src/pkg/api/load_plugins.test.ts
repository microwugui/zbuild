// 第 105 轮：loadPlugins 整链逐字节等于 Go（4 场景）。
// Go 探针 tools/go/tmpgen_loadplugins_test.go → testdata/load-plugins-go.json。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NewDeferLog, DeferLogKind } from "../../internal/logger/logger.ts";
import { MockFS, MockUnix } from "../../internal/fs/fs_mock.ts";
import { loadPlugins } from "./api_impl.ts";
import type { BuildOptionsInput, PluginBuild } from "./api_impl.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/load-plugins-go.json", import.meta.url)));
const SHA = "72570b3a042bb6822fbf788edff25646fe74ec0b08c75d7655984c6b8d582547";
const rows = JSON.parse(new TextDecoder().decode(raw)) as any[];

const noopStart = () => ({ r: {} as any });
const noopResolve = () => ({ r: {} as any });
const noopLoad = () => ({ r: {} as any });
const noopEnd = () => ({ r: {} as any });
const noopDispose = () => {};

function run(idx: number): any {
  const log = NewDeferLog(DeferLogKind.DeferLogAll, null);
  const fsObj = MockFS({}, MockUnix, "/");
  let opts: BuildOptionsInput;
  if (idx === 0) {
    opts = { Plugins: [
      { Name: "alpha", Setup(b: PluginBuild) {
        b.OnStart(noopStart as any); b.OnResolve({ Filter: "\\.js$", Namespace: "" } as any, noopResolve as any);
        b.OnLoad({ Filter: "\\.ts$", Namespace: "" } as any, noopLoad as any);
        b.OnEnd(noopEnd as any); b.OnDispose(noopDispose); b.InitialOptions.MinifyWhitespace = true;
      } },
      { Name: "beta", Setup(b: PluginBuild) { b.OnEnd(noopEnd as any); } },
    ] };
  } else if (idx === 1) {
    opts = { Plugins: [
      { Name: "", Setup: () => {} },
      { Name: "ok", Setup(b: PluginBuild) { b.OnStart(noopStart as any); } },
    ] };
  } else if (idx === 2) {
    opts = {};
  } else {
    opts = { Plugins: [
      { Name: "p", Setup(b: PluginBuild) {
        b.OnResolve({ Filter: "a", Namespace: "" } as any, noopResolve as any);
        b.OnResolve({ Filter: "b", Namespace: "" } as any, noopResolve as any);
        b.OnDispose(noopDispose);
      } },
    ] };
  }
  const r = loadPlugins(opts, fsObj, log, {});
  r.finalizeBuildOptions({}); // set plugins into config.Options
  return {
    name: rows[idx].name,
    numPlugins: r.plugins.length,
    pluginNames: r.plugins.map((p) => p.Name),
    onStartCounts: r.plugins.map((p) => p.OnStart.length),
    onResolveCounts: r.plugins.map((p) => p.OnResolve.length),
    onLoadCounts: r.plugins.map((p) => p.OnLoad.length),
    onEndCallbacks: r.onEndCallbacks.length,
    onEndNames: r.onEndCallbacks.map((e) => e.pluginName),
    onDisposeCallbacks: r.onDisposeCallbacks.length,
    finalMinifyWS: (opts.MinifyWhitespace === true),
    msgs: log.Done().map((m) => ({ text: m.Data.Text, kind: m.Kind })),
  };
}

test("load-plugins 夹具 sha256（4 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("loadPlugins Setup 注册 + 缺名报错逐字节等于 Go（4 场景）", () => {
  assert.equal(rows.length, 4);
  for (let i = 0; i < rows.length; i++) {
    assert.deepEqual(run(i), rows[i], `scenario ${i}: ${rows[i].name}`);
  }
});
