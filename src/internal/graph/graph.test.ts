// 第 44 轮叶子优先规划：graph 入口判定（Go 探针字节证据）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { LinkerFile } from "./graph.ts";

const FIXTURE = new URL("../../../testdata/graph-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "d15dc9bfecbf77df010ae33afc3b9eb9ef769881273a6ddd984874d6db351d7f";

interface Row { fn: string; kind: number; out: string; }

test("graph 入口判定：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "graph fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const f = new LinkerFile(); f.entryPointKind = r.kind;
    const got = r.fn === "IsEntryPoint" ? f.IsEntryPoint() : f.IsUserSpecifiedEntryPoint();
    assert.equal(String(got), r.out, `${r.fn} ${r.kind}`);
  }
});
