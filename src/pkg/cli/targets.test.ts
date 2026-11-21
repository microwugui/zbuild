// 第 89 批：parseTargets 逐字节证据（Go 探针 targets-go.json，7 例）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseTargets } from "./cli_impl.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/targets-go.json", import.meta.url)));
const SHA = "4942db84b4472a37104de6f239744f06b21cc2b7f7c7d4d875c25784a0f03552";
const fx = JSON.parse(new TextDecoder().decode(raw)) as { rows: { name: string; data: any }[] };
const by = Object.fromEntries(fx.rows.map((r) => [r.name, r.data]));

test("targets 夹具 sha256", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("parseTargets 逐字节等于 Go（7 例）", () => {
  const cases: [string, string[]][] = [
    ["esnext", ["esnext"]], ["es2015-alias", ["es6"]], ["multi", ["es2020", "node18"]],
    ["engines", ["chrome90", "safari14"]], ["missing-version", ["chrome"]],
    ["invalid", ["bogus"]], ["case-insensitive", ["ES2022"]],
  ];
  for (const [n, targets] of cases) {
    const r = parseTargets(targets, "--target");
    assert.deepStrictEqual({
      target: r.target,
      engines: r.engines.map((e) => ({ name: e.name, version: e.version })),
      errText: r.err ? r.err.Text : "",
      errNote: r.err ? r.err.Note : "",
    }, by[n], "parseTargets:" + n);
  }
});
