// 第 44 轮叶子优先规划：bundler 纯助手（Go 探针字节证据）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isASCIIOnly, canonicalFileSystemPathForWindows, HashForFileName } from "./bundler.ts";

const FIXTURE = new URL("../../../testdata/bundler-pure-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "b0f5f8a6d776895fb37733bbeea24db9aebd78c2ea48c9fbef0c9d9037917fdf";

interface Row { fn: string; arg: string; out: string; }

test("bundler 纯助手：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "bundler-pure fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "isASCIIOnly": got = String(isASCIIOnly(r.arg)); break;
      case "canonicalFileSystemPathForWindows": got = canonicalFileSystemPathForWindows(r.arg); break;
      case "HashForFileName": {
        const bs = r.arg.replace(/[\[\]]/g, "").split(" ").filter(Boolean).map(Number);
        got = HashForFileName(new Uint8Array(bs)); break;
      }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} ${r.arg}`);
  }
});
