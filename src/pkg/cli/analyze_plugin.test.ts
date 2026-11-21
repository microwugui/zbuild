// 第 105 轮：addAnalyzePlugin 逐字节等于 Go（4 场景）。
// Go 探针 tools/go/tmpgen_analyze_test.go → testdata/analyze-plugin-go.json。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { addAnalyzePlugin } from "./cli_impl.ts";
import type { BuildOptionsInput, PluginBuild } from "../api/api_impl.ts";
import type { FileLike } from "../../internal/logger/logger.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/analyze-plugin-go.json", import.meta.url)));
const SHA = "bc631783c57c8b23e1ce20aa3e56982b305b9cb7b8f95ecd48d23805f8ba29a5";
const rows = JSON.parse(new TextDecoder().decode(raw)) as any[];

const mf = `{"outputs":{"out.js":{"entryPoint":"a.js","bytes":10,"inputs":{"a.js":{"bytesInOutput":10}}}}}`;

function run(idx: number): any {
  const opts: BuildOptionsInput = {};
  const mode = [1, 2, 0, 1][idx];
  const args = [[], [], [], ["--color=false"]][idx];
  const metafile = idx === 2 ? "" : mf;
  addAnalyzePlugin(opts, mode, args);
  const out: number[] = [];
  const file: FileLike = { WriteString: (b: Uint8Array) => { for (const x of b) out.push(x); } };
  // invoke Setup -> OnEnd with fixed result (capture stderr via injected file)
  const plugin = opts.Plugins![0];
  let endFn: ((r: any) => any) | null = null;
  plugin.Setup({
    InitialOptions: opts, Resolve: (() => ({})) as any,
    OnStart: (() => {}) as any, OnResolve: (() => {}) as any, OnLoad: (() => {}) as any, OnDispose: (() => {}) as any,
    OnEnd: (fn: any) => { endFn = fn; },
  } as PluginBuild);
  // re-run addAnalyzePlugin with injected file so OnEnd uses our capture
  const opts2: BuildOptionsInput = {};
  addAnalyzePlugin(opts2, mode, args, file);
  let endFn2: ((r: any) => any) | null = null;
  opts2.Plugins![0].Setup({
    InitialOptions: opts2, Resolve: (() => ({})) as any,
    OnStart: (() => {}) as any, OnResolve: (() => {}) as any, OnLoad: (() => {}) as any, OnDispose: (() => {}) as any,
    OnEnd: (fn: any) => { endFn2 = fn; },
  } as PluginBuild);
  if (endFn2) endFn2({ Metafile: metafile });
  return {
    name: rows[idx].name,
    numPlugins: opts.Plugins!.length,
    pluginName: plugin.Name,
    metafile: opts.Metafile === true,
    stderr: new TextDecoder().decode(new Uint8Array(out)),
  };
}

test("analyze-plugin 夹具 sha256（4 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("addAnalyzePlugin append + Metafile + OnEnd 输出逐字节等于 Go（4 场景）", () => {
  assert.equal(rows.length, 4);
  for (let i = 0; i < rows.length; i++) {
    assert.deepEqual(run(i), rows[i], `scenario ${i}: ${rows[i].name}`);
  }
});
