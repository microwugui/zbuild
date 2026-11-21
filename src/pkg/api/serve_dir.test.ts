// 第 86 轮：respondWithDirList 共享 Go 探针（一次 5 例逐字节）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { respondWithDirList } from "./serve_other.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/api-serve-go.json", import.meta.url)));
const SHA = "7e213bfa3edb4b7c9a97d209eb7e12637d8da2f9fa9f6cc8e07738d8c13c761e";
const fx = JSON.parse(new TextDecoder().decode(raw)) as { rows: { name: string; hex: string }[] };
const cases: Record<string, [string, string[], string[]]> = {
  "root-empty": ["", [], []],
  "root-items": ["", ["css", "js"], ["index.html", "a&b.txt"]],
  "subdir": ["assets", ["img"], ["app.js"]],
  "deep": ["a/b", ["c"], ["<x>.js"]],
  "html-escape": ["x&y", ['d"e'], ["f<g>"]],
};

test("api-serve 夹具 sha256", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("respondWithDirList 逐字节等于 Go（5 例）", () => {
  for (const r of fx.rows) {
    const [q, dirs, files] = cases[r.name];
    const got = respondWithDirList(q, new Map(dirs.map((x) => [x, true])), new Map(files.map((x) => [x, true])));
    assert.equal(Buffer.from(got).toString("hex"), r.hex, r.name);
  }
});
