// 第 106 轮：printSummary 确定性路径（yarn/1 去耗时）逐字节等于 Go（3 场景）。
// Go 探针 tools/go/tmpgen_summary_test.go → testdata/print-summary-go.json。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { printSummary } from "./api_impl.ts";
import { stderr } from "../../internal/logger/logger.ts";
import type { OutputFile } from "./api_impl.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/print-summary-go.json", import.meta.url)));
const SHA = "961cbe83fcfe815a32a25ecb76a52ec77639849552e4e3c549feef8f2b2646d7";
const rows = JSON.parse(new TextDecoder().decode(raw)) as any[];

function run(idx: number): any {
  let files: OutputFile[] = [];
  if (idx === 1) files = [{ Path: "/tmp/out.js", Contents: new TextEncoder().encode("var x = 1;"), Hash: "" }];
  else if (idx === 2) files = [
    { Path: "/tmp/out.js", Contents: new TextEncoder().encode("var x = 1;"), Hash: "" },
    { Path: "/tmp/out.js.map", Contents: new TextEncoder().encode("{}"), Hash: "" },
  ];
  const out: number[] = [];
  const saved = stderr.WriteString;
  (stderr as any).WriteString = (b: Uint8Array) => { for (const x of b) out.push(x); };
  try {
    printSummary(1 /* ColorNever */, files, new Date(0), "/tmp", true /* yarnV1 */, stderr);
  } finally {
    (stderr as any).WriteString = saved;
  }
  return { name: rows[idx].name, stderr: new TextDecoder().decode(new Uint8Array(out)), withFiles: files.length > 0 };
}

test("print-summary 夹具 sha256（3 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("printSummary yarn/1 路径逐字节等于 Go（3 场景）", () => {
  assert.equal(rows.length, 3);
  for (let i = 0; i < rows.length; i++) {
    assert.deepEqual(run(i), rows[i], `scenario ${i}: ${rows[i].name}`);
  }
});
