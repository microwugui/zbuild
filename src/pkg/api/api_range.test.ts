// 第 68 轮叶子优先规划：parseRangeHeader（Go 探针固化，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseRangeHeader } from "./serve_other.ts";

const FIXTURE = new URL("../../../testdata/api-range-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "1f3a99599553958c475ad67647864abc9f468c631ce39e04ab1ee7b4a797abf7";

interface Row { r: string; len: number; out: string; }

test("api-range fixture sha256 + 14 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "api-range fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const v = parseRangeHeader(r.r, r.len);
    assert.equal(`${v.begin}|${v.end}|${v.ok}`, r.out, `${r.r} len=${r.len}`);
  }
  assert.equal(rows.length, 14);
});
