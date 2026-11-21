// 第 89 批：newBuildOptions / newTransformOptions / filterAnalyzeFlags（Go 探针 cli-pure-go.json，7 例）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { newBuildOptions, newTransformOptions, filterAnalyzeFlags } from "./cli_impl.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/cli-pure-go.json", import.meta.url)));
const SHA = "e591082561876e9982db840dd81e63afaaac8090abd6db0ce34ab9ce8b7d8c8e";
const fx = JSON.parse(new TextDecoder().decode(raw)) as { rows: { name: string; data: any }[] };
const by = Object.fromEntries(fx.rows.map((r) => [r.name, r.data]));

test("cli-pure 夹具 sha256", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("newBuildOptions / newTransformOptions 逐字节等于 Go", () => {
  const bo: any = newBuildOptions();
  assert.deepStrictEqual({
    banner: bo.Banner.size, define: bo.Define.size, footer: bo.Footer.size,
    loader: bo.Loader.size, logOverride: bo.LogOverride.size, supported: bo.Supported.size,
  }, by["newBuildOptions"]);
  const to: any = newTransformOptions();
  assert.deepStrictEqual({
    define: to.Define.size, logOverride: to.LogOverride.size, supported: to.Supported.size,
  }, by["newTransformOptions"]);
});

test("filterAnalyzeFlags 逐字节等于 Go（5 例）", () => {
  const cases: [string, string[]][] = [
    ["none", ["--bundle", "a.js", "--outfile=out.js"]],
    ["analyze", ["--bundle", "--analyze", "a.js"]],
    ["verbose", ["--analyze=verbose", "a.js", "--bundle"]],
    ["no-build", ["--analyze", "a.js"]],
    ["mixed", ["--bundle", "--analyze", "a.js", "--analyze=verbose", "b.js"]],
  ];
  for (const [n, args] of cases) {
    assert.deepStrictEqual(filterAnalyzeFlags([...args]), by["filterAnalyzeFlags:" + n], "filterAnalyzeFlags:" + n);
  }
});
