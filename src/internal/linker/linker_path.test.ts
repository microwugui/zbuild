// 第 58 轮叶子优先规划：linker publicPath 拼接（Go 探针固化，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { joinWithPublicPath } from "./linker.ts";

const FIXTURE = new URL("../../../testdata/linker-path-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "0991ebd904ffd0a88eec340039d8fe159eaa1c762d9862d089cc78fb771a0840";

interface Row { public: string; rel: string; out: string; }

test("linker-path fixture sha256 + 12 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "linker-path fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    assert.equal(joinWithPublicPath(r.public, r.rel), r.out, `(${r.public},${r.rel})`);
  }
  assert.equal(rows.length, 12);
});
