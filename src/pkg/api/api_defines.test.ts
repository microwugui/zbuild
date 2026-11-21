// 第 87 轮：validateDefines 大探针（一次 9 例，testdata/api-big-go.json）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { validateDefines, describeDefineExpr, validateFeatures, Target, EngineName } from "./api_impl.ts";
import { ConfigPlatform } from "./api_impl.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/api-big-go.json", import.meta.url)));
const SHA = "fb83e3f01edeef022b62f436656b278495303b9f25e118208e488ac90099fc75";
const fx = JSON.parse(new TextDecoder().decode(raw)) as { rows: { name: string; data: any }[] };

// 与 Go 探针相同的用例输入
const cases: Record<string, any> = {
  empty: { defines: {}, pureFns: [], platform: ConfigPlatform.PlatformBrowser, build: true, minify: false, drop: 0 },
  simple: { defines: { FOO: "1", "process.env.NODE_ENV": '"dev"' }, pureFns: [], platform: ConfigPlatform.PlatformBrowser, build: true, minify: false, drop: 0 },
  "nodeenv-minify": { defines: {}, pureFns: [], platform: ConfigPlatform.PlatformBrowser, build: true, minify: true, drop: 0 },
  "nodeenv-node": { defines: {}, pureFns: [], platform: ConfigPlatform.PlatformNode, build: true, minify: false, drop: 0 },
  pure: { defines: {}, pureFns: ["Object.assign"], platform: ConfigPlatform.PlatformBrowser, build: true, minify: false, drop: 0 },
  "drop-console": { defines: {}, pureFns: [], platform: ConfigPlatform.PlatformBrowser, build: true, minify: false, drop: 1 },
  "identifier-value": { defines: { X: "some.identifier" }, pureFns: [], platform: ConfigPlatform.PlatformNeutral, build: false, minify: false, drop: 0 },
  "invalid-value": { defines: { Y: "a + b" }, pureFns: [], platform: ConfigPlatform.PlatformBrowser, build: true, minify: false, drop: 0 },
  "bad-name": { defines: { "bad-name!": "1" }, pureFns: [], platform: ConfigPlatform.PlatformBrowser, build: true, minify: false, drop: 0 },
};

test("api-big 夹具 sha256", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

const featureCases: Record<string, any> = {
  default: { target: Target.DefaultTarget, engines: [] },
  esnext: { target: Target.ESNext, engines: [] },
  es2015: { target: Target.ES2015, engines: [] },
  chrome90: { target: Target.DefaultTarget, engines: [{ Name: EngineName.EngineChrome, Version: "90" }] },
  safari14: { target: Target.DefaultTarget, engines: [{ Name: EngineName.EngineSafari, Version: "14" }] },
  firefox88: { target: Target.DefaultTarget, engines: [{ Name: EngineName.EngineFirefox, Version: "88" }] },
  badversion: { target: Target.DefaultTarget, engines: [{ Name: EngineName.EngineChrome, Version: "abc" }] },
  mixed: { target: Target.ES2020, engines: [{ Name: EngineName.EngineChrome, Version: "90" }, { Name: EngineName.EngineSafari, Version: "14" }] },
};

test("validateDefines 逐字节等于 Go（9 例共享大探针）", () => {
  for (const r of fx.rows) {
    if (!r.name.startsWith("validateDefines:")) continue;
    const name = r.name.slice("validateDefines:".length);
    const c = cases[name];
    const { processed, injected, errors } = validateDefines(
      null as any, new Map(Object.entries(c.defines)), c.pureFns, c.platform, c.build, c.minify, c.drop,
    );
    const ids: Record<string, string> = {};
    for (const [k, d] of processed.IdentifierDefines) ids[k] = d.KeyParts.join(".") + "|" + d.Flags + "|" + describeDefineExpr(d.DefineExpr);
    const dots: Record<string, string[]> = {};
    for (const [tail, arr] of processed.DotDefines) dots[tail] = arr.map((d: any) => d.KeyParts.join(".") + "|" + d.Flags + "|" + describeDefineExpr(d.DefineExpr)).sort();
    assert.deepEqual(ids, r.data.ids, `${name} ids`);
    assert.deepEqual(dots, r.data.dots, `${name} dots`);
    assert.deepEqual(injected.map((i) => i.Name + ":" + i.SourceContents), r.data.injected, `${name} injected`);
    assert.deepEqual(errors, r.data.errors, `${name} errors`);
  }
});

test("validateFeatures + CSSPrefixData 逐字节等于 Go（8 例共享大探针）", () => {
  for (const r of fx.rows) {
    if (!r.name.startsWith("validateFeatures:")) continue;
    const name = r.name.slice("validateFeatures:".length);
    const c = featureCases[name];
    const errors: string[] = [];
    const got = validateFeatures(c.target, c.engines, errors);
    assert.equal(got.js.toString(), r.data.js, `${name} js`);
    assert.equal(String(got.css), r.data.css, `${name} css`);
    const prefixes = [...got.prefixes.entries()].map(([d, p]) => d + ":" + p).sort();
    assert.deepEqual(prefixes, r.data.prefixes, `${name} prefixes`);
    assert.equal(got.targetEnv, r.data.targetEnv, `${name} targetEnv`);
    assert.deepEqual(errors, r.data.errors, `${name} errors`);
  }
});
