// 第 173 批：finalizeResolve + ResolveResult 底座，Go 探针 12 例逐字节固化。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NewDeferLog, DeferLogKind, Path as LoggerPath, PathFlags, Source } from "../logger/logger.ts";
import { MockFS, MockUnix } from "../fs/fs_mock.ts";
import { MakeEmptyDirEntries } from "../fs/fs.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import { dirInfo, packageJSON, SideEffectsData } from "./package_json.ts";
import { TSConfigJSON, TSAlwaysStrict } from "./tsconfig_json.ts";
import { TSConfigJSX, TSConfig, MaybeBool } from "../config/config.ts";
import { ResolveResult, finalizeResolve } from "./resolver.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/finalize2-go.json", import.meta.url)));
const SHA = "3458ea0e5f3bfaf8816b897d6bde4f9e0fd5fb2e8ca71275307b471f48cf7289";

test("finalize2 fixture sha256 + 12 例逐字节等于 Go（ResolveResult 底座）", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const a = r.arg;
    const notes: string[] = [];
    const log = NewDeferLog(DeferLogKind.DeferLogAll, null);
    const dl = {
      addNote: (s: string) => { notes.push(s); },
      increaseIndent: () => {},
      decreaseIndent: () => {},
    };
    const fsobj = MockFS({}, MockUnix, "/");
    const dirInfoCtx: any = {
      fsObj: fsobj, log, debugLogs: dl, platform: 1, mainFields: null,
      preserveSymlinks: false, dirCache: new Map(), pnpManifestWasChecked: true,
      readFile: (path: string) => ({ contents: "", err: "no such file or directory" }),
    };
    const cfg = CFG[a.name];
    if (cfg.withDirInfo) {
      const info = new dirInfo();
      info.absPath = "/proj";
      info.entries = MakeEmptyDirEntries("/proj");
      if (cfg.sideEffects || cfg.sideGlob || cfg.withSideData) {
        const pj = new packageJSON();
        pj.source = new Source();
        pj.source.KeyPath = new LoggerPath();
        pj.source.KeyPath.Text = "/proj/package.json";
        if (cfg.sideEffects) pj.sideEffectsMap = new Map(Object.entries(cfg.sideEffects).map(([k, v]) => [k, v as boolean]));
        if (cfg.sideGlob) pj.sideEffectsRegexps = cfg.sideGlob.map((g: string) => new RegExp(g));
        if (cfg.withSideData) { const sd = new SideEffectsData(); sd.Source = pj.source; pj.sideEffectsData = sd; }
        info.enclosingPackageJSON = pj;
      }
      if (cfg.withTSConfig) {
        const tsc = new TSConfigJSON();
        tsc.AbsPath = "/proj/tsconfig.json";
        tsc.JSXSettings = new TSConfigJSX();
        tsc.JSXSettings.JSXFactory = cfg.jsxFactory;
        tsc.JSXSettings.JSXFragmentFactory = cfg.jsxFragment;
        tsc.Settings = new TSConfig();
        tsc.Settings.ExperimentalDecorators = MaybeBool.True;
        tsc.TSAlwaysStrict = new TSAlwaysStrict(true);
        tsc.TSAlwaysStrict.Name = "alwaysStrict";
        info.enclosingTSConfigJSON = tsc;
      }
      dirInfoCtx.dirCache.set("/proj", info);
    }
    const result = new ResolveResult();
    result.PathPair.Primary = new LoggerPath();
    result.PathPair.Primary.Text = cfg.primary;
    result.PathPair.Primary.Namespace = cfg.primaryNS;
    if (cfg.primaryDisabled) result.PathPair.Primary.Flags = PathFlags.PathDisabled;
    result.PathPair.Secondary = new LoggerPath();
    result.PathPair.Secondary.Text = cfg.secondary;
    result.PathPair.Secondary.Namespace = cfg.secondaryNS;

    const ctx: any = {
      fsObj: fsobj, log, debugLogs: dl, kind: cfg.kind, preserveSymlinks: false,
      externalExact: cfg.externalExact || {}, externalPatterns: cfg.externalPatterns || [], dirInfoCtx,
    };
    finalizeResolve(ctx, result);

    const sideOut = result.PrimarySideEffectsData !== null && result.PrimarySideEffectsData.Source !== null
      ? result.PrimarySideEffectsData.Source.KeyPath.Text : null;
    const tsconfigOut = result.TSConfig !== null && result.TSConfig.ExperimentalDecorators === MaybeBool.True;
    const jsxFactory = result.TSConfigJSX.JSXFactory === null ? "" : result.TSConfigJSX.JSXFactory.join(".");
    const jsxFrag = result.TSConfigJSX.JSXFragmentFactory === null ? "" : result.TSConfigJSX.JSXFragmentFactory.join(".");
    const got = [
      result.PathPair.IsExternal, sideOut, result.ModuleTypeData.Type,
      tsconfigOut, result.TSAlwaysStrict !== null, jsxFactory, jsxFrag, notes,
    ];
    assert.deepEqual(got, r.out, `${a.name}\n got ${JSON.stringify(got)}\nwant ${JSON.stringify(r.out)}`);
  }
});

// 与 Go 探针 tmpgen_finalize2_test.go 的 cases 一一对应。kind: ImportStmt=1, ImportEntryPoint=0。
const CFG: Record<string, any> = {
  "external-exact": { primary: "/proj/a.js", secondary: "", primaryNS: "file", secondaryNS: "file", kind: 1, externalExact: { "/proj/a.js": true } },
  "external-pattern": { primary: "/proj/vendor/x.js", secondary: "", primaryNS: "file", secondaryNS: "file", kind: 1, externalPatterns: [{ Prefix: "/proj/vendor/", Suffix: "" }] },
  "entry-point-not-external": { primary: "/proj/a.js", secondary: "", primaryNS: "file", secondaryNS: "file", kind: 0, externalExact: { "/proj/a.js": true } },
  "no-dirinfo": { primary: "/proj/a.js", secondary: "", primaryNS: "file", secondaryNS: "file", kind: 1 },
  "namespace-skip": { primary: "/proj/a.js", secondary: "", primaryNS: "ns", secondaryNS: "file", kind: 1, withDirInfo: true },
  "sideeffects-false": { primary: "/proj/a.js", secondary: "", primaryNS: "file", secondaryNS: "file", kind: 1, withDirInfo: true, sideEffects: { "/proj/a.js": false }, withSideData: true },
  "sideeffects-true": { primary: "/proj/a.js", secondary: "", primaryNS: "file", secondaryNS: "file", kind: 1, withDirInfo: true, sideEffects: { "/proj/a.js": true }, withSideData: true },
  "sideeffects-glob-hit": { primary: "/proj/a.js", secondary: "", primaryNS: "file", secondaryNS: "file", kind: 1, withDirInfo: true, sideEffects: {}, sideGlob: ["\\.js$"], withSideData: true },
  "sideeffects-glob-miss": { primary: "/proj/a.js", secondary: "", primaryNS: "file", secondaryNS: "file", kind: 1, withDirInfo: true, sideEffects: {}, sideGlob: ["^zzz"], withSideData: true },
  "tsconfig-copy": { primary: "/proj/a.js", secondary: "", primaryNS: "file", secondaryNS: "file", kind: 1, withDirInfo: true, withTSConfig: true, jsxFactory: ["React", "createElement"], jsxFragment: ["React", "Fragment"] },
  "secondary-both": { primary: "/proj/a.js", secondary: "/proj/b.js", primaryNS: "file", secondaryNS: "file", kind: 1, withDirInfo: true, sideEffects: { "/proj/a.js": false }, withSideData: true },
  "primary-disabled": { primary: "/proj/a.js", secondary: "", primaryNS: "file", secondaryNS: "file", kind: 1, primaryDisabled: true, withDirInfo: true, sideEffects: { "/proj/a.js": false }, withSideData: true },
};
