// 第 94 轮叶子优先规划：pkg/cli 纯助手簇（3 函数一次探针，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isArgForBuild, printMangleCache, splitWithEmptyCheck } from "./cli_impl.ts";

const FIXTURE = new URL("../../../testdata/cli-cluster-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "085f3c4a3e2f72c8d89abab68ef697b3b7d30a8d802a6eda43ca8a1a7e6498d2";

interface Row { fn: string; arg: string; out: string; }

test("cli-cluster fixture sha256 + 16 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "cli-cluster fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    if (r.fn === "isArgForBuild") got = String(isArgForBuild(r.arg));
    else if (r.fn === "splitWithEmptyCheck") got = JSON.stringify(splitWithEmptyCheck(r.arg, ","));
    else if (r.fn === "printMangleCache") {
      const inp = JSON.parse(r.arg);
      const cache = new Map<string, string | boolean | number>(Object.entries(inp.cache));
      const out = printMangleCache(cache, inp.order, inp.ascii);
      got = new TextDecoder().decode(out);
    } else throw new Error(`unknown ${r.fn}`);
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 16);
});
