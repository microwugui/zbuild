// 第 88 批：applyOptionDefaults / fixInvalidUnsupportedJSFeatureOverrides 共享 Go 探针（7 行逐字节）。
// Go 探针 tools/go/tmpgen_opt_test.bak，fixture testdata/bundler-opt-go.json（sha256 36f08b50…）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { applyOptionDefaults, fixInvalidUnsupportedJSFeatureOverrides } from "./bundler.ts";
import { JSFeature } from "../compat/compat.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/bundler-opt-go.json", import.meta.url)));
const SHA = "36f08b503bb063125a8215f6ffd0b9b8a8aabb71a299368a454a0fb3a5161916";
const fx = JSON.parse(new TextDecoder().decode(raw)) as { rows: { name: string; out: string }[] };
const by = Object.fromEntries(fx.rows.map((r) => [r.name, r.out]));

// Go config.go:155: PlatformBrowser=0, PlatformNode=1
const PLATFORM_BROWSER = 0, PLATFORM_NODE = 1;

function freshOpts(platform: number, minify: boolean, jsOverride: bigint, jsMask: bigint, cssMask: number): any {
  return {
    Platform: platform,
    MinifyIdentifiers: minify,
    ExtensionToLoader: null, // Go nil
    OutputExtensionJS: "",
    OutputExtensionCSS: "",
    EntryPathTemplate: [],
    ChunkPathTemplate: [],
    AssetPathTemplate: [],
    ProfilerNames: false,
    UnsupportedJSFeatures: 0n,
    UnsupportedJSFeatureOverrides: jsOverride,
    UnsupportedJSFeatureOverridesMask: jsMask,
    UnsupportedCSSFeatures: 0,
    UnsupportedCSSFeatureOverridesMask: cssMask,
  };
}

// Go 探针 dumpOpts：map[string]interface{} json.Marshal（键按字母序），
// jsFeat/jsOverride/jsMask 为 fmt.Sprint(JSFeature) 字符串，cssFeat/cssMask/loader 为数字。
const tmpl = (ts: any[]) => ts.map((t) => `${t.Data}:${t.Placeholder};`).join("");
function dumpOpts(o: any): string {
  return JSON.stringify({
    assetT: tmpl(o.AssetPathTemplate),
    chunkT: tmpl(o.ChunkPathTemplate),
    cssExt: o.OutputExtensionCSS,
    cssFeat: o.UnsupportedCSSFeatures,
    cssMask: o.UnsupportedCSSFeatureOverridesMask,
    entryT: tmpl(o.EntryPathTemplate),
    jsExt: o.OutputExtensionJS,
    jsFeat: String(o.UnsupportedJSFeatures),
    jsMask: String(o.UnsupportedJSFeatureOverridesMask),
    jsOverride: String(o.UnsupportedJSFeatureOverrides),
    loader: o.ExtensionToLoader.size,
    profiler: o.ProfilerNames,
  });
}

test("bundler-opt 夹具 sha256", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("applyOptionDefaults 逐字节等于 Go（5 例）", () => {
  const A = 8n; // compat.AsyncAwait = 1<<3
  const cases: { name: string; platform: number; minify: boolean; ov: bigint; mask: bigint }[] = [
    { name: "defaults-browser", platform: PLATFORM_BROWSER, minify: false, ov: 0n, mask: 0n },
    { name: "defaults-node", platform: PLATFORM_NODE, minify: false, ov: 0n, mask: 0n },
    { name: "minify", platform: PLATFORM_BROWSER, minify: true, ov: 0n, mask: 0n },
    { name: "with-loader", platform: PLATFORM_BROWSER, minify: false, ov: 0n, mask: 0n },
    { name: "async-override", platform: PLATFORM_BROWSER, minify: false, ov: A, mask: A },
  ];
  for (const c of cases) {
    const o = freshOpts(c.platform, c.minify, c.ov, c.mask, 0);
    applyOptionDefaults(o);
    assert.equal(dumpOpts(o), by[c.name], "applyOptionDefaults:" + c.name);
  }
});

test("fixInvalidUnsupportedJSFeatureOverrides 逐字节等于 Go（2 例）", () => {
  const impl = JSFeature.AsyncAwait;      // 8
  const implied = JSFeature.TopLevelAwait; // 1<<57
  const fixCase = (override: bigint, mask: bigint) => {
    const o = freshOpts(PLATFORM_BROWSER, false, override, mask, 0);
    fixInvalidUnsupportedJSFeatureOverrides(o, impl, implied);
    return `${o.UnsupportedJSFeatures}|${o.UnsupportedJSFeatureOverrides}|${o.UnsupportedJSFeatureOverridesMask}`;
  };
  assert.equal(fixCase(0n, 0n), by["fix:fix-noop"], "fix:fix-noop");
  assert.equal(fixCase(impl, impl), by["fix:fix-trigger"], "fix:fix-trigger");
});
