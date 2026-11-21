// 第 103 轮：parseMangleCache 逐字节等于 Go（5 例）。
// Go 探针 tools/go/tmpgen_mangle_parse_test.bak → testdata/mangle-parse-go.json。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseMangleCache } from "./mangle_cache.ts";
import type { MangleFS } from "./mangle_cache.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/mangle-parse-go.json", import.meta.url)));
const SHA = "db93ece2482392c07557957e2b2f8501ff24a41485565cca5f1eb5e0528009eb";
const rows = JSON.parse(new TextDecoder().decode(raw)) as { name: string; cache: any; order: string[] | null; err: string }[];
const by = Object.fromEntries(rows.map((r) => [r.name, r]));
const enc = new TextEncoder();

const files: Record<string, string> = {
  "/valid.json": `{"foo":"a","bar":"b"}`,
  "/false.json": `{"foo":false,"bar":"x"}`,
  "/badval.json": `{"foo":true}`,
  "/nonobj.json": `[1,2,3]`,
};
const mfs: MangleFS = {
  Cwd: () => "/",
  Rel: (base, target) => [target.replace(/^\//, ""), true],
  ReadFile: (path) => {
    const body = files[path];
    if (body === undefined) return { contents: new Uint8Array(0), err: "ENOENT", originalError: "no such file or directory" };
    return { contents: enc.encode(body), err: "", originalError: "" };
  },
};

test("mangle-parse 夹具 sha256（5 例）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("parseMangleCache 逐字节等于 Go（合法/缺失/false/错误）", () => {
  for (const [name, path] of [
    ["missing", "/nope.json"], ["valid", "/valid.json"], ["false", "/false.json"],
    ["badval", "/badval.json"], ["nonobj", "/nonobj.json"],
  ] as [string, string][]) {
    let err = "";
    const r = parseMangleCache(mfs, path, (s) => { err += s; });
    const cacheObj: any = r.cache === null ? null : Object.fromEntries(r.cache);
    assert.deepEqual(cacheObj, by[name].cache, `${name}: cache`);
    assert.deepEqual(r.order, by[name].order, `${name}: order`);
    if (by[name].err !== "") assert.equal(err, by[name].err, `${name}: err`);
  }
});
