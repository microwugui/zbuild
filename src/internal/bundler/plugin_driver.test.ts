// 第 106 轮：RunOnResolvePlugins / runOnLoadPlugins 整族逐字节等于 Go（8 场景）。
// Go 探针 tools/go/tmpgen_plugin_driver_test.go → testdata/bundler-plugin-driver-go.json。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { RunOnResolvePlugins, runOnLoadPlugins } from "./bundler.ts";
import { MockFS, MockUnix } from "../fs/fs_mock.ts";
import { FSCache } from "../cache/cache_fs.ts";
import type { FSLike } from "../cache/cache_fs.ts";
import { ModKey } from "../fs/modkey.ts";
import { NewDeferLog, DeferLogKind, Source, Range } from "../logger/logger.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/bundler-plugin-driver-go.json", import.meta.url)));
const SHA = "207d2992d65cbd881ce508a8ddf86b8842bafbc0da379adcd44f162f87b20aa8";
const rows = JSON.parse(new TextDecoder().decode(raw)) as any[];

function fsLike(mfs: any): FSLike {
  return {
    ModKey: (p: string) => ({ key: (mfs.ModKey(p) as any).key ?? new ModKey(), err: mfs.ModKey(p).err }),
    ReadFile: (p: string) => { const r = mfs.ReadFile(p); return { contents: r.text, canonicalError: r.err1, originalError: r.err2 }; },
  };
}
const msg = (text: string, kind = 0) => ({ ID: 0, PluginName: "", Text: text, Kind: kind, Data: { Text: text, Location: null }, Notes: [] });
const re = (s: string) => new RegExp(s);
const pd = (v: string) => v;

function resolveScenario(idx: number, log: any, logMsgs: any[]) {
  const mfs = MockFS({ "/p/a.js": "var a = 1;", "/p/b.js": "var b = 2;" }, MockUnix, "/");
  const fsObj: any = {
    IsAbs: (p: string) => mfs.IsAbs(p),
    Dir: (p: string) => mfs.Dir(p),
    ReadDirectory: (p: string) => mfs.ReadDirectory(p),
    ModKey: (p: string) => ({ key: (mfs.ModKey(p) as any).key ?? new ModKey(), err: mfs.ModKey(p).err }),
    ReadFile: (p: string) => { const r = mfs.ReadFile(p); return { contents: r.text, canonicalError: r.err1, originalError: r.err2 }; },
  };
  const fsc = new FSCache();
  const importer = { Text: "/p/main.js", Namespace: "file", IgnoredSuffix: "" };
  const importSource = new Source(); importSource.KeyPath = importer as any; importSource.Contents = new TextEncoder().encode("import 'x'");
  const res = { Resolve: () => [null, { notes: [] }] as any };
  let plugins: any[] = [];
  if (idx === 0) plugins = [{ Name: "rp", OnStart: [], OnResolve: [{ Filter: re(".*"), Namespace: "file", Callback: () => ({ Path: { Text: "/abs/out.js", Namespace: "custom" }, PluginData: "pd", IsSideEffectFree: true }) }], OnLoad: [] }];
  else if (idx === 1) plugins = [{ Name: "rp", OnStart: [], OnResolve: [{ Filter: re(".*"), Namespace: "", Callback: () => ({ External: true, PluginData: "ext" }) }], OnLoad: [] }];
  else if (idx === 2) plugins = [{ Name: "rp", OnStart: [], OnResolve: [{ Filter: re(".*"), Namespace: "", Callback: () => ({ Msgs: [msg("resolve fail")] }) }], OnLoad: [] }];
  else if (idx === 3) plugins = [{ Name: "rp", OnStart: [], OnResolve: [{ Filter: re(".*"), Namespace: "", Callback: () => ({ Path: { Text: "relative.js", Namespace: "file" } }) }], OnLoad: [] }];
  const [result, stopped] = RunOnResolvePlugins(plugins as any, res as any, log, fsObj, fsc, importSource, new Range(), importer, "pkg", null, 1, "/p", null, 0);
  if (result === null) return { nil: true, stopped, path: "", pathNS: "", external: false, sef: false, pluginData: "", msgs: null };
  return {
    nil: false, stopped, path: result.PathPair.Primary.Text, pathNS: result.PathPair.Primary.Namespace,
    external: result.PathPair.IsExternal, sef: result.PrimarySideEffectsData !== null,
    pluginData: pd(result.PluginData as string ?? ""), msgs: null,
  };
}

function loadScenario(idx: number, log: any, logMsgs: any[]) {
  const mfs = MockFS({ "/p/a.js": "var a = 1;", "/p/b.js": "var b = 2;" }, MockUnix, "/");
  const fsObj: any = {
    IsAbs: (p: string) => mfs.IsAbs(p),
    Dir: (p: string) => mfs.Dir(p),
    ReadDirectory: (p: string) => mfs.ReadDirectory(p),
    ModKey: (p: string) => ({ key: (mfs.ModKey(p) as any).key ?? new ModKey(), err: mfs.ModKey(p).err }),
    ReadFile: (p: string) => { const r = mfs.ReadFile(p); return { contents: r.text, canonicalError: r.err1, originalError: r.err2 }; },
  };
  const fsc = new FSCache();
  let keyPath = { Text: "/p/x.js", Namespace: "file", IgnoredSuffix: "", Flags: 0, IsDisabled() { return (this.Flags & 1) !== 0; } };
  let plugins: any[] = [];
  if (idx === 4) plugins = [{ Name: "lp", OnStart: [], OnResolve: [], OnLoad: [{ Filter: re(".*"), Namespace: "", Callback: () => ({ Contents: "loaded!", Loader: 16, PluginData: "ld", AbsResolveDir: "/r" }) }] }];
  else if (idx === 5) { plugins = [{ Name: "lp", OnStart: [], OnResolve: [], OnLoad: [{ Filter: re("nop"), Namespace: "", Callback: () => ({}) }] }]; keyPath = { ...keyPath, Text: "/p/a.js" }; }
  else if (idx === 6) { plugins = []; keyPath = { ...keyPath, Text: "x", Namespace: "disabled", Flags: 0 }; }
  else if (idx === 7) plugins = [{ Name: "lp", OnStart: [], OnResolve: [], OnLoad: [{ Filter: re(".*"), Namespace: "", Callback: () => ({ Msgs: [msg("load fail")] }) }] }];
  const source: any = { KeyPath: keyPath, Contents: new TextEncoder().encode("orig") };
  const [r, ok] = runOnLoadPlugins(plugins as any, fsObj, fsc, log, source, null, new Range(), null, false, 0);
  return { ok, loader: r.loader, absResolveDir: r.absResolveDir, pluginName: r.pluginName, contents: new TextDecoder().decode(source.Contents), pluginData: pd(r.pluginData as string ?? ""), msgs: null };
}

function run(idx: number): any {
  const log = NewDeferLog(DeferLogKind.DeferLogAll, null) as any;
  const row = { name: rows[idx].name, resolve: {} as any, load: {} as any, logMsgs: [] as any[] };
  if (idx <= 3) {
    row.resolve = resolveScenario(idx, log, []);
    row.load = { ok: false, loader: 0, absResolveDir: "", pluginName: "", contents: "", pluginData: "", msgs: null };
  } else {
    row.load = loadScenario(idx, log, []);
    row.resolve = { nil: false, stopped: false, path: "", pathNS: "", external: false, sef: false, pluginData: "", msgs: null };
  }
  row.logMsgs = log.Done().map((m: any) => ({ text: m.Data?.Text ?? "", kind: m.Kind }));
  return row;
}

test("bundler-plugin-driver 夹具 sha256（8 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("RunOnResolvePlugins / runOnLoadPlugins 逐字节等于 Go（8 场景）", () => {
  assert.equal(rows.length, 8);
  for (let i = 0; i < rows.length; i++) {
    assert.deepEqual(run(i), rows[i], `scenario ${i}: ${rows[i].name}`);
  }
});
