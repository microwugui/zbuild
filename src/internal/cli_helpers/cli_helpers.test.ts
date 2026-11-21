// 第 44 轮叶子优先规划：cli_helpers（Go 探针字节证据）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ParseLoader, MakeErrorWithNote } from "./cli_helpers.ts";

const FIXTURE = new URL("../../../testdata/cli-helpers-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "a156a27adf127a63847cfc2d6ba1989bb8b7407294f250c11edacd221f6f7cd1";

interface Row { fn: string; arg: string; out: string; }

test("cli_helpers：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "cli-helpers fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "ParseLoader": { const v = ParseLoader(r.arg); got = `${v.loader}|${v.err === null ? "nil" : v.err.Text}`; break; }
      case "MakeErrorWithNote": { const [t, n] = r.arg.split("|"); const e = MakeErrorWithNote(t, n); got = `${e.Text}|${e.Note}`; break; }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} ${r.arg}`);
  }
});
