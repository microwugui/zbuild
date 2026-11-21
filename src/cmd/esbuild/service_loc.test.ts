// 第 67 轮叶子优先规划：cmd/esbuild service 位置/输出编解码（Go 探针固化，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { encodeLocation, decodeLocation, decodeLocationToPrivate, encodeOutputFiles } from "./service.ts";
import type { Location } from "./service.ts";

const FIXTURE = new URL("../../../testdata/service-loc-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "013a9848d4a2bf76e484d70c2ef87a75d145ed0d0d2e690b51c869d31b623570";

interface Row { fn: string; arg: string; out: string; }
const LOC_A = { file: "a.js", namespace: "", line: 1, column: 0, length: 5, lineText: "x", suggestion: "" };
const LOC_B = { file: "b.css", namespace: "ns", line: 3, column: 7, length: 0, lineText: "abc", suggestion: "try" };
const decodeArg = (arg: string): Record<string, unknown> | null => arg === "null" ? null : arg === "a" ? LOC_A : LOC_B;

test("service-loc fixture sha256 + 10 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "service-loc fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "encodeLocation": {
        const loc: Location | null = r.arg === "null" ? null : JSON.parse(r.arg);
        got = JSON.stringify(encodeLocation(loc));
        break;
      }
      case "decodeLocation": {
        got = JSON.stringify(decodeLocation(decodeArg(r.arg)));
        break;
      }
      case "decodeLocationToPrivate": {
        got = JSON.stringify(decodeLocationToPrivate(decodeArg(r.arg)));
        break;
      }
      case "encodeOutputFiles": {
        const v = JSON.parse(r.arg);
        got = JSON.stringify(encodeOutputFiles(v));
        break;
      }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 10);
});
