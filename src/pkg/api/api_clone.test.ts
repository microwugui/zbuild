// 第 89 轮叶子优先规划：cloneMangleCache（Go 探针固化）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cloneMangleCache } from "./api_impl.ts";

const FIXTURE = new URL("../../../testdata/api-clone-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "59679f5d698f1cc07af93e3e67487a218787d80cd7ccfc516bb9d2d54be7e2fc";

interface Row { fn: string; arg: string; out: string; }

test("api-clone fixture sha256 + 5 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "api-clone fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let input: Map<string, string | boolean | number> | null;
    if (r.arg === "nil") input = null;
    else {
      const pairs: [string, string][] = JSON.parse(r.arg);
      input = new Map<string, string | boolean | number>();
      for (const [k, kind] of pairs) {
        if (kind === "false") input.set(k, false);
        else if (kind === "num") input.set(k, 42);
        else input.set(k, kind.slice(2));
      }
    }
    const result = cloneMangleCache(input);
    const got = result === null ? "nil"
      : [...result.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
          .map(([k, v]) => `${k}=${typeof v === "string" ? "s:" + v : v};`).join("");
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 5);
});
