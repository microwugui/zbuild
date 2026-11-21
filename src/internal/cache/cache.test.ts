// 第 44 轮叶子优先规划：cache SourceIndexCache（Go 探针字节证据）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { SourceIndexCache, SourceIndexNormal } from "./cache.ts";

const FIXTURE = new URL("../../../testdata/cache-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "704516e72c962334d0bfa35698494b00f67d3fc85b7f147b25a66f43907f67aa";

interface Row { fn: string; arg: string; out: string; }

test("cache SourceIndexCache：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "cache fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  const c = new SourceIndexCache();
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "LenHint": got = String(c.LenHint()); break;
      case "Get": got = String(c.Get(r.arg === "a.js again" ? "a.js" : r.arg, SourceIndexNormal)); break;
      case "GetGlob": { const m = r.arg.match(/(\d+),(\d+)/)!; got = String(c.GetGlob(Number(m[1]), Number(m[2]))); break; }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} ${r.arg}`);
  }
});
