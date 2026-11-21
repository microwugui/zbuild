// 第 89 批：printMangleCache 逐字节证据（Go 探针 testdata/mangle-go.json，7 例）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { printMangleCache } from "./mangle_cache.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/mangle-go.json", import.meta.url)));
const SHA = "fde18157b2ebe8bdbcbb613cb99d440e35d141d8c93f8af1a5c15ad51e39a7ac";
const fx = JSON.parse(new TextDecoder().decode(raw)) as { rows: { name: string; data: { out: string } }[] };
const by = Object.fromEntries(fx.rows.map((r) => [r.name, r.data.out]));

test("mangle 夹具 sha256", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("printMangleCache 逐字节等于 Go（7 例）", () => {
  const cases: [string, Map<string, string | boolean>, string[], boolean][] = [
    ["empty", new Map(), [], false],
    ["one-str", new Map([["foo", "bar"]]), [], false],
    ["with-false", new Map<string, string | boolean>([["foo", false], ["bar", "baz"]]), [], false],
    ["preserve-order", new Map([["z", "1"], ["a", "2"]]), ["z", "a"], false],
    ["new-keys-sorted", new Map([["z", "1"], ["a", "2"], ["m", "3"]]), ["z"], false],
    ["ascii", new Map([["café", "naïve"]]), [], true],
    ["escapes", new Map([["a\"b", "x\\y\nz"]]), [], false],
  ];
  for (const [n, cache, order, ascii] of cases) {
    const out = new TextDecoder().decode(printMangleCache(cache, order, ascii));
    assert.equal(out, by[n], "printMangleCache:" + n);
  }
});
