// 第 44 轮叶子优先规划：linker moveBeforeExport（Go 探针字节证据）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { moveBeforeExport, generateExtraDataForFileJS } from "./debug.ts";

const FIXTURE = new URL("../../../testdata/linker-debug-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "4722d6f9ed6192ea671f0266f1e2c9deca2c49d80619f43c19f15b2aad788d98";

interface Row { s: string; i: number; out: number; }

test("linker moveBeforeExport：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "linker-debug fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) assert.equal(moveBeforeExport(r.s, r.i), r.out, `${JSON.stringify(r.s)}@${r.i}`);
});


// 第 104 轮：generateExtraDataForFileJS 逐字节等于 Go（debugVerboseMetafile=false 恒空）。
const EXTRA = new URL("../../../testdata/linker-extra-data-go.json", import.meta.url);
const exBytes = new Uint8Array(readFileSync(EXTRA));
const exSHA = "57c337bee3096af9fbd6131d64ce8bfd0757134768dc60d6fd1e559715764494";

test("generateExtraDataForFileJS 逐字节等于 Go（3 例恒空）", () => {
  assert.equal(createHash("sha256").update(exBytes).digest("hex"), exSHA);
  const rows = JSON.parse(new TextDecoder().decode(exBytes)) as { name: string; out: string }[];
  const idx = [0, 7, 4294967295];
  rows.forEach((r, i) => assert.equal(generateExtraDataForFileJS({}, idx[i]), r.out, r.name));
});
