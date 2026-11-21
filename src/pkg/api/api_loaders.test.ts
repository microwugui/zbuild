// 第 88 轮叶子优先规划：validateLoaders（Go 探针固化）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { validateLoaders } from "./api_impl.ts";

const FIXTURE = new URL("../../../testdata/api-loaders-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "95c4aafdc68af07f54179691c5d5a7e788d12b3b843787557310d1a0e931465a";

interface Row { fn: string; arg: string; out: string; }

test("api-loaders fixture sha256 + 4 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "api-loaders fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const input = new Map<string, number>(Object.entries(JSON.parse(r.arg)));
    const result = validateLoaders(input);
    const got = [...result.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
      .map(([k, v]) => `${k}=${v};`).join("");
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 4);
});
