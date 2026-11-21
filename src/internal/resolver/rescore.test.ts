// 第 174 批：resolver 递归核心四函数，Go 探针 20 例逐字节固化。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NewDeferLog, DeferLogKind, PathFlags } from "../logger/logger.ts";
import { MockFS, MockUnix } from "../fs/fs_mock.ts";
import { DifferentCase, DirEntry } from "../fs/fs.ts";
import { ImportKind } from "../ast/ast.ts";
import {
  ResolveResult, DebugMeta,
  resolveWithoutRemapping, loadNodeModules, loadPackageImports, resolveWithoutSymlinks,
} from "./resolver.ts";
import type { CorePairResult } from "./resolver.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/rescore-go.json", import.meta.url)));
const SHA = "ba255c0ac6801a5fd0d823c62e7928c3fc93d4404e50547c5f17b352f356877d";

const baseTree: Record<string, string> = {
  "/proj/package.json": `{"name":"root","imports":{"#dep":"./src/dep.js","#pkg":"dep"}}`,
  "/proj/src/dep.js": "",
  "/proj/src/a.js": "",
  "/proj/node_modules/dep/package.json": `{"name":"dep","main":"main.js"}`,
  "/proj/node_modules/dep/main.js": "",
  "/proj/node_modules/dep/sub.js": "",
  "/proj/node_modules/other/index.js": "",
};

function dumpPair(text: string, namespace: string, flags: number, secondary: string | null, external: boolean): any {
  return [[text, namespace, flags, ""], secondary ? [secondary, "file", 0, ""] : null, external];
}
function dumpCore(t: CorePairResult, notes: string[]): any {
  return [dumpPair(t.pair.text, t.pair.namespace, t.pair.flags, t.pair.secondary !== "" ? t.pair.secondary : null, false),
    t.ok, t.diffCase ? [t.diffCase.Dir, t.diffCase.Query, t.diffCase.Actual] : null,
    t.side && t.side.Source ? t.side.Source.KeyPath.Text : null, notes];
}
function dumpResult(r: ResolveResult | null, notes: string[]): any {
  if (r === null) return [null, notes];
  const pp = r.PathPair;
  const res = [dumpPair(pp.Primary.Text, pp.Primary.Namespace, pp.Primary.Flags, pp.HasSecondary() ? pp.Secondary.Text : null, pp.IsExternal),
    r.DifferentCase ? [r.DifferentCase.Dir, r.DifferentCase.Query, r.DifferentCase.Actual] : null,
    r.PrimarySideEffectsData && r.PrimarySideEffectsData.Source ? r.PrimarySideEffectsData.Source.KeyPath.Text : null,
    r.ModuleTypeData.Type];
  return [res, notes];
}

test("rescore fixture sha256 + 20 例逐字节等于 Go（resolver 递归核心）", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const notes: string[] = [];
    const log = NewDeferLog(DeferLogKind.DeferLogAll, null);
    (log as any).Level = 2; // LevelDebug → 触发 debugLogs 创建路径（TS 侧总是显式传 note sink）
    const dl = {
      what: "", indent: "",
      addNote(s: string) { this.notes.push(this.indent !== "" ? this.indent + s : s); },
      increaseIndent() { this.indent += "  "; },
      decreaseIndent() { this.indent = this.indent.slice(2); },
      notes,
    };
    const fsobj = MockFS({ ...baseTree }, MockUnix, "/");
    const dirCache = new Map<string, any>();
    const readFile = (path: string) => {
      const c = (baseTree as any)[path];
      return c === undefined ? { contents: "", err: "no such file or directory" } : { contents: c, err: null };
    };
    const diCtx: any = {
      fsObj: fsobj, log, debugLogs: dl, platform: 1, mainFields: ["main"],
      preserveSymlinks: false, dirCache, pnpManifestWasChecked: true, readFile,
    };
    const ctx: any = {
      fsObj: fsobj, log, debugLogs: dl, platform: 1, extensionOrder: [".js"],
      // Go NewResolver 在 ExtensionToLoader=nil 时 split=0 → nodeModulesExtensionOrder 为空（探针同口径）
      dirInfoCtx: diCtx, mainFields: ["main"], nodeModulesExtensionOrder: [], cssExtensionOrder: [],
      debugMeta: new DebugMeta(), kind: r.arg.kind ?? ImportKind.ImportStmt,
      esmConditionsDefault: { default: true, node: true },
      esmConditionsImport: { default: true, node: true, import: true },
      esmConditionsRequire: { default: true, node: true, require: true },
      externalExact: {}, externalPatterns: [], externalPackages: false, absNodePaths: [],
      pnpManifest: null, tsConfigOverride: null,
    };
    let got: any;
    const a = r.arg;
    if (r.fn === "resolveWithoutRemapping") {
      const dinfo = diCacheGet(diCtx, diCtx, a.dir);
      got = dumpCore(resolveWithoutRemapping(ctx, dinfo, a.importPath), notes);
    } else if (r.fn === "loadNodeModules") {
      const dinfo = diCacheGet(diCtx, diCtx, a.dir);
      got = dumpCore(loadNodeModules(ctx, a.importPath, dinfo, a.forbid), notes);
    } else if (r.fn === "loadPackageImports") {
      const dinfo = diCacheGet(diCtx, diCtx, "/proj/src");
      let pkg: any = dinfo;
      while (pkg !== null && pkg.packageJSON === null) pkg = pkg.parent;
      got = dumpCore(loadPackageImports(ctx, a.importPath, pkg), notes);
    } else if (r.fn === "resolveWithoutSymlinks") {
      const dinfo = diCacheGet(diCtx, diCtx, a.dir);
      got = dumpResult(resolveWithoutSymlinks(ctx, a.dir, dinfo, a.importPath), notes);
    } else {
      throw new Error(`unknown fn ${r.fn}`);
    }
    assert.deepEqual(got, r.out, `${r.fn}/${a.name}\n got ${JSON.stringify(got)}\nwant ${JSON.stringify(r.out)}`);
  }
});

// dirInfoCached 的 TS 包装（测试里直接用，需和 prod 同一缓存）
import { dirInfoCached } from "./resolver.ts";
function diCacheGet(diCtx: any, _ctx: any, path: string): any {
  return dirInfoCached(diCtx, path);
}
