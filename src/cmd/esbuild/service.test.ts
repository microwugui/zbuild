// 第 44 轮叶子优先规划：service 编解码（Go 探针字节证据）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolveKindToString, stringToResolveKind, encodeStringArray, decodeStringArray } from "./service.ts";

const FIXTURE = new URL("../../../testdata/service-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "8b791dadae3752ffdf753a9f788f05775b9c6d1c8ef8f8a8d05e1e6f660fb1af";

interface Row { fn: string; arg: string; out: string; }

test("service 编解码：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "service fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "resolveKindToString": got = resolveKindToString(Number(r.arg)); break;
      case "stringToResolveKind": { const v = stringToResolveKind(r.arg); got = `${v.value}|${v.ok}`; break; }
      case "encodeStringArray": case "decodeStringArray": got = JSON.stringify(r.arg); break;
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} ${r.arg}`);
  }
  assert.deepEqual(encodeStringArray(["a", "b"]), ["a", "b"]);
  assert.deepEqual(decodeStringArray(["x"]), ["x"]);
});
