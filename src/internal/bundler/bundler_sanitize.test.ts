// 第 66 轮叶子优先规划：bundler 虚拟模块路径净化（Go 探针固化，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { sanitizeFilePathForVirtualModulePath } from "./bundler.ts";

const FIXTURE = new URL("../../../testdata/bundler-sanitize-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "f95565767204e55581568a1a0a877a098f57eee1fbdb7026b789fe1ea2e09479";

interface Row { arg: string; out: string; }

test("bundler-sanitize fixture sha256 + 17 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "bundler-sanitize fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    assert.equal(sanitizeFilePathForVirtualModulePath(r.arg), r.out, JSON.stringify(r.arg));
  }
  assert.equal(rows.length, 17);
});
