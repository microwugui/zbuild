// 第 86 轮叶子优先规划：pkg/api 位置转换助手（Go 探针固化）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { MsgLocation, PrettyPaths } from "../../internal/logger/logger.ts";
import { convertLocationToPublic, convertLocationToInternal } from "./api_impl.ts";
import type { Location } from "./api_impl.ts";

const FIXTURE = new URL("../../../testdata/api-convert-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "7fe22dbe6565b496fbc20addffe230711e2ec105b513cdf4a952cec2f24a024d";

interface Row { fn: string; arg: string; out: string; }

function fixedLoc(): MsgLocation {
  const l = new MsgLocation();
  l.File = new PrettyPaths(); l.File.Abs = "/abs/foo.js"; l.File.Rel = "foo.js";
  l.Namespace = "file"; l.LineText = new TextEncoder().encode("hello");
  l.Suggestion = "try x"; l.Line = 3; l.Column = 7; l.Length = 5;
  return l;
}

test("api-convert fixture sha256 + 6 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "api-convert fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    if (r.fn === "convertLocationToPublic") {
      const loc = r.arg === "nil" ? null : fixedLoc();
      const v = convertLocationToPublic(loc, r.arg === "nil" ? 0 : Number(r.arg));
      got = v === null ? "null" : JSON.stringify({
        File: v.File, Namespace: v.Namespace, Line: v.Line, Column: v.Column,
        Length: v.Length, LineText: new TextDecoder().decode(new TextEncoder().encode(v.LineText)), Suggestion: v.Suggestion,
      });
    } else if (r.fn === "convertLocationToInternal") {
      const loc: Location | null = r.arg === "null" ? null : JSON.parse(r.arg);
      const v = convertLocationToInternal(loc);
      got = v === null ? "null" : JSON.stringify({
        File: { Abs: v.File.Abs, Rel: v.File.Rel }, Namespace: v.Namespace,
        LineText: new TextDecoder().decode(v.LineText), Suggestion: v.Suggestion,
        Line: v.Line, Column: v.Column, Length: v.Length,
      });
    } else throw new Error(`unknown ${r.fn}`);
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 6);
});
