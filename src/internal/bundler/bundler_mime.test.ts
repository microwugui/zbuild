// 第 44 轮叶子优先规划：bundler MIME/扩展名映射（Go 探针字节证据）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { guessMimeType, DefaultExtensionToLoaderMap } from "./bundler.ts";

const FIXTURE = new URL("../../../testdata/bundler-mime-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "3642972b217a13c2529a5cc72a30e1e2e06148640b7e8298b694ebb18adcfe9f";

interface Row { fn: string; arg: string; out: string; }

test("bundler MIME/扩展名：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "bundler-mime fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  const loaderMap = DefaultExtensionToLoaderMap();
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "guessMimeType": got = guessMimeType(r.arg, ""); break;
      case "DefaultExtensionToLoaderMap": got = String(loaderMap.get(r.arg) ?? 0); break;
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} ${r.arg}`);
  }
});
