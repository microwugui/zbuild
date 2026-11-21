// 第 91 批：runtime.Source（internal/runtime 底座）+ OptionsFromConfig + Options.Equal
// 逐字节（Go 探针 tmpgen_runtime_test.bak / tmpgen_ofc_test.bak）。
//   testdata/runtime-source-go.json   8 组 feature mask 全 Contents SHA
//   testdata/options-from-config-go.json 13 行投射 + Equal 结果
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Source } from "../runtime/runtime.ts";
import { JSFeature, Has as HasJS } from "../compat/compat.ts";
import { OptionsFromConfig, Equal, Options } from "./js_parser.ts";

const rtRaw = new Uint8Array(readFileSync(new URL("../../../testdata/runtime-source-go.json", import.meta.url)));
const ofcRaw = new Uint8Array(readFileSync(new URL("../../../testdata/options-from-config-go.json", import.meta.url)));
const RT_SHA = "4505f868907fbf6f9b92773beee6d30e821b6ad39952696eb3336f283a3a6c94";
const OFC_SHA = "1c6dbe53603a9aac4bf4f5193e728e4774044a291e80a9180b4941c67920708a";
const rtRows = JSON.parse(new TextDecoder().decode(rtRaw)) as any[];
const ofcFx = JSON.parse(new TextDecoder().decode(ofcRaw)) as { rows: { name: string; data: any }[] };
const ofcBy = Object.fromEntries(ofcFx.rows.map((r) => [r.name, r.data]));

const MASKS: Record<string, bigint> = {
  esnext: 0n,
  forof: JSFeature.ForOf,
  constlet: JSFeature.ConstAndLet,
  "forof-constlet": JSFeature.ForOf | JSFeature.ConstAndLet,
  objectext: JSFeature.ObjectExtensions,
  objaccessors: JSFeature.ObjectAccessors,
  "objext-accessors": JSFeature.ObjectExtensions | JSFeature.ObjectAccessors,
  "all-four": JSFeature.ForOf | JSFeature.ConstAndLet | JSFeature.ObjectExtensions | JSFeature.ObjectAccessors,
};

test("runtime.Source 两夹具 sha256 + 8 组 feature mask 全 Contents 逐字节", () => {
  assert.equal(createHash("sha256").update(rtRaw).digest("hex"), RT_SHA);
  assert.equal(createHash("sha256").update(ofcRaw).digest("hex"), OFC_SHA);
  for (const r of rtRows) {
    const s = Source(MASKS[r.name]);
    const sha = createHash("sha256").update(s.Contents).digest("hex");
    assert.deepEqual({
      sha, ident: s.IdentifierName, keyPath: s.KeyPath.Text,
      abs: s.PrettyPaths.Abs, rel: s.PrettyPaths.Rel, index: s.Index,
    }, { sha: r.sha, ident: r.ident, keyPath: r.keyPath, abs: r.abs, rel: r.rel, index: r.index }, `runtime.Source ${r.name}`);
  }
});

// 复现 Go 探针的 config.Options（TS duck-typed）
function baseCfg(): any {
  return {
    JSX: { Factory: ["React", "createElement"], Fragment: ["React", "Fragment"], ImportSource: "react",
      Parse: false, Preserve: false, AutomaticRuntime: false, Development: false, SideEffects: false },
    TS: { Parse: false, NoAmbiguousLessThan: false, Config: { ExperimentalDecorators: 0 } },
  };
}

function dumpOpts(o: Options): any {
  const m: any = {
    tsParse: o.ts.Parse, tsNoAmb: o.ts.NoAmbiguousLessThan,
    jsxParse: o.jsx.Parse, jsxPreserve: o.jsx.Preserve,
    jsxAuto: o.jsx.AutomaticRuntime, jsxDev: o.jsx.Development,
    jsxImportSource: o.jsx.ImportSource, jsxSideEffects: o.jsx.SideEffects,
    jsxFactory: (o.jsx as any).Factory, jsxFragment: (o.jsx as any).Fragment,
    unsupportedJS: Number(o.unsupportedJSFeatures),
    unsupportedJSOverrides: Number(o.unsupportedJSFeatureOverrides),
    unsupportedJSMask: Number(o.unsupportedJSFeatureOverridesMask),
    originalTargetEnv: o.originalTargetEnv,
    mode: o.mode, platform: o.platform, outputFormat: o.outputFormat,
    moduleType: o.moduleTypeData?.Type ?? 0,
    asciiOnly: o.asciiOnly, keepNames: o.keepNames,
    minifySyntax: o.minifySyntax, minifyIdentifiers: o.minifyIdentifiers,
    minifyWhitespace: o.minifyWhitespace,
    omitRuntime: o.omitRuntimeForTests, omitJSXRuntime: o.omitJSXRuntimeForTests,
    ignoreDCE: o.ignoreDCEAnnotations, treeShaking: o.treeShaking,
    dropDebugger: o.dropDebugger, mangleQuoted: o.mangleQuoted,
    logPathStyle: o.logPathStyle, codePathStyle: o.codePathStyle,
    dropLabels: o.dropLabels,
    mangleProps: o.mangleProps ? (o.mangleProps.source + "/" + o.mangleProps.flags) : null,
    reserveProps: o.reserveProps ? (o.reserveProps.source + "/" + o.reserveProps.flags) : null,
    definesIds: 0, definesDots: 0,
    tsAlwaysStrict: o.tsAlwaysStrict ? [o.tsAlwaysStrict.Name, o.tsAlwaysStrict.Value] : null,
    injectedFiles: (o.injectedFiles ?? []).map((f: any) => [f.DefineName, f.Source?.Contents, f.Exports?.length ?? 0, f.IsCopyLoader ?? false]),
  };
  return m;
}

test("OptionsFromConfig：6 组 config.Options 字段映射逐字节等于 Go", () => {
  const cases: Record<string, () => any> = {
    "default": () => baseCfg(),
    "esnext-three": () => { const c = baseCfg(); c.Platform = 1; c.OutputFormat = 3; c.Mode = 2; return c; },
    "features": () => { const c = baseCfg(); c.UnsupportedJSFeatures = JSFeature.ForOf | JSFeature.ConstAndLet;
      c.UnsupportedJSFeatureOverrides = JSFeature.ObjectAccessors;
      c.UnsupportedJSFeatureOverridesMask = JSFeature.ObjectAccessors | JSFeature.ObjectExtensions;
      c.OriginalTargetEnv = "es2015"; return c; },
    "flags": () => { const c = baseCfg(); Object.assign(c, { MinifySyntax: true, MinifyIdentifiers: true,
      MinifyWhitespace: true, KeepNames: true, TreeShaking: true, DropDebugger: true, MangleQuoted: true,
      IgnoreDCEAnnotations: true, ASCIIOnly: true, OmitRuntimeForTests: true, OmitJSXRuntimeForTests: true,
      LogPathStyle: 1, CodePathStyle: 1, DropLabels: ["a", "b"] }); return c; },
    "regexes": () => { const c = baseCfg(); c.MangleProps = /^_/; c.ReserveProps = /^__/; return c; },
    "injected": () => { const c = baseCfg(); c.InjectedFiles = [{ DefineName: "bar", Source: { Contents: "x" }, Exports: [] }]; return c; },
  };
  for (const [name, mk] of Object.entries(cases)) {
    const got = dumpOpts(OptionsFromConfig(mk()));
    const exp = { ...ofcBy["ofc:" + name] };
    // 正则：Go 探针 dump 的是 regexp.String()（如 "^_"），TS 用 source+"/"+flags（如 "^_/"）
    if (typeof exp.mangleProps === "string") exp.mangleProps = exp.mangleProps + "/";
    if (typeof exp.reserveProps === "string") exp.reserveProps = exp.reserveProps + "/";
    // Contents 在 Go 是 string，TS 是 Uint8Array→解码
    assert.deepEqual(got, exp, `OptionsFromConfig ${name}`);
  }
});

test("Options.Equal：7 组配对逐字节等于 Go", () => {
  const eqCases: Record<string, [any, any]> = {
    "identical": [baseCfg(), baseCfg()],
    "diff-minify": [baseCfg(), { ...baseCfg(), MinifySyntax: true }],
    "diff-features": [baseCfg(), { ...baseCfg(), UnsupportedJSFeatures: JSFeature.ForOf }],
    "same-regex-diff-inst": [{ ...baseCfg(), MangleProps: /^_/ }, { ...baseCfg(), MangleProps: /^_/ }],
    "diff-regex": [{ ...baseCfg(), MangleProps: /^_/ }, { ...baseCfg(), MangleProps: /^x/ }],
    "diff-jsx-factory": [baseCfg(), { ...baseCfg(), JSX: { ...baseCfg().JSX, Factory: ["h"] } }],
    "diff-droplabels": [baseCfg(), { ...baseCfg(), DropLabels: ["a"] }],
  };
  for (const [name, [a, b]] of Object.entries(eqCases)) {
    assert.equal(Equal(OptionsFromConfig(a), OptionsFromConfig(b)), ofcBy["equal:" + name], `Options.Equal ${name}`);
  }
});
