// 第 105 轮：pluginImpl.onStart/onResolve/onLoad 整族注册状态机逐字节等于 Go（4 场景）。
// Go 探针 tools/go/tmpgen_pluginreg_test.go → testdata/plugin-reg-go.json。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NewDeferLog, DeferLogKind, Path, MsgKind } from "../../internal/logger/logger.ts";
import { MockFS, MockUnix } from "../../internal/fs/fs_mock.ts";
import { pluginImpl } from "./api_impl.ts";
import type { OnStartResult, OnResolveResult, OnLoadResult } from "./api_impl.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/plugin-reg-go.json", import.meta.url)));
const SHA = "a85e150bb16c0111592062b049f26d30a3c71cd8768b40e15248d69ce2a2bec6";
const rows = JSON.parse(new TextDecoder().decode(raw)) as any[];

const msgsOf = (ms: any[]) => ms.map((m) => ({ text: m.Data.Text, kind: m.Kind }));
const resOf = (r: any) => ({
  pluginName: r.PluginName ?? "", path: r.Path?.Text ?? "", pathNS: r.Path?.Namespace ?? "",
  external: r.External === true, sef: r.IsSideEffectFree === true,
  absResolveDir: r.AbsResolveDir ?? "", loader: r.Loader ?? 0, contents: r.Contents ?? "",
  msgs: msgsOf(r.Msgs ?? []),
});

// 与 Go 探针同形态的回调（返回 {r, err}）
const msg = (text: string) => ({ ID: "", PluginName: "", Text: text, Location: null, Notes: [], Detail: null });
const startCB = () => ({ r: { Warnings: [msg("start-warn")], Errors: [] } as OnStartResult });
const resolveCB = (a: any) => ({ r: {
  PluginName: "rp", Path: a.Path, Namespace: "outns", External: false, SideEffects: 1,
  WatchFiles: ["w.js"], Warnings: [msg("resolve-warn:" + a.Path)], Errors: [],
} as OnResolveResult });
const loadCB = (a: any) => ({ r: {
  PluginName: "lp", Contents: "loaded:" + a.Path, ResolveDir: "/r", Loader: 15,
  WatchDirs: ["d"], Errors: [msg("load-err:" + a.Path)], Warnings: [],
} as OnLoadResult });

function run(idx: number): any {
  const log = NewDeferLog(DeferLogKind.DeferLogAll, null);
  const fsObj = MockFS({}, MockUnix, "/");
  const name = ["demo", "multi", "bad", "flags"][idx];
  const impl = new pluginImpl(log, fsObj, name);
  if (idx === 0) {
    impl.onStart(startCB);
    impl.onResolve({ Filter: ".*\\.js$", Namespace: "file" } as any, resolveCB as any);
    impl.onLoad({ Filter: ".*\\.ts$", Namespace: "" } as any, loadCB as any);
  } else if (idx === 1) {
    impl.onResolve({ Filter: "a", Namespace: "ns1" } as any, resolveCB as any);
    impl.onResolve({ Filter: "b", Namespace: "" } as any, resolveCB as any);
    impl.onLoad({ Filter: "c", Namespace: "ns2" } as any, loadCB as any);
    impl.onStart(startCB); impl.onStart(startCB);
  } else if (idx === 2) {
    impl.onResolve({ Filter: "", Namespace: "" } as any, resolveCB as any);
    impl.onResolve({ Filter: "(", Namespace: "" } as any, resolveCB as any);
    impl.onLoad({ Filter: "", Namespace: "" } as any, loadCB as any);
    impl.onStart(startCB);
  } else {
    impl.onResolve({ Filter: "(?i)\\.JS$", Namespace: "" } as any, () => ({ r: {} as OnResolveResult, err: new Error("closed") }));
    impl.onLoad({ Filter: "(?s)^x.*y$", Namespace: "n" } as any, loadCB as any);
  }
  const p = impl.plugin;
  const out: any = {
    name: p.Name,
    onStart: p.OnStart.map((s) => s.Name),
    onResolve: p.OnResolve.map((x) => ({ name: x.Name, ns: x.Namespace, filter: x.FilterSource ?? "" })),
    onLoad: p.OnLoad.map((x) => ({ name: x.Name, ns: x.Namespace, filter: x.FilterSource ?? "" })),
    msgs: log.Done().map((m) => ({ text: m.Data.Text, kind: m.Kind })),
  };
  out.startResult = p.OnStart.length ? resOf(p.OnStart[0].Callback()) : { pluginName: "", path: "", pathNS: "", external: false, sef: false, absResolveDir: "", loader: 0, contents: "", msgs: null };
  const importer = new Path(); importer.Text = "imp.js"; importer.Namespace = "file";
  out.resolveResults = p.OnResolve.length ? p.OnResolve.map((x) => resOf(x.Callback({ Path: "a.js", ResolveDir: "/r", PluginData: null, Importer: importer, Kind: 1, With: null }))) : null;
  const pth = new Path(); pth.Text = "a.js"; pth.Namespace = "file";
  out.loadResults = p.OnLoad.length ? p.OnLoad.map((x) => resOf(x.Callback({ PluginData: null, Path: pth }))) : null;
  return out;
}

test("plugin-reg 夹具 sha256（4 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("onStart/onResolve/onLoad 注册 + 回调转换逐字节等于 Go（4 场景）", () => {
  assert.equal(rows.length, 4);
  for (let i = 0; i < rows.length; i++) {
    assert.deepEqual(run(i), rows[i], `scenario ${i}: ${rows[i].name}`);
  }
});
