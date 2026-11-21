// 第 106 轮：rebuildImpl 确定性早退路径逐字节等于 Go（4 场景）。
// Go 探针 tools/go/tmpgen_rebuildimpl_test.go → testdata/rebuild-impl-go.json。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { rebuildImpl } from "./api_impl.ts";
import { Msg, MsgData, MsgKind } from "../../internal/logger/logger.ts";
import type { FileLike } from "../../internal/logger/logger.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/rebuild-impl-go.json", import.meta.url)));
const SHA = "740256c767a07c1d3920b3c050b9a1f0b5d4dceaf82f09a09b87023d2dcdc13b";
const rows = JSON.parse(new TextDecoder().decode(raw)) as any[];

function run(idx: number): any {
  const out: number[] = [];
  const file: FileLike = { WriteString: (b: Uint8Array) => { for (const x of b) out.push(x); } };
  let warnings: Msg[] | undefined;
  let mangle: Map<string, string | boolean | number> | null | undefined;
  if (idx === 1) { const m = new Msg(); m.Kind = MsgKind.Warning; m.Data.Text = "repeat-warn"; warnings = [m]; }
  else if (idx === 2) mangle = new Map([["foo", true as any]]);
  else if (idx === 3) mangle = new Map<string, string | boolean | number>([["foo", "a"], ["bar", false]]);
  const [state, hashes] = rebuildImpl({ logWarnings: warnings, mangleCache: mangle, write: false }, null, file);
  const errTexts = (state.result.Errors as any[]).map((e: any) => e.Text);
  return {
    name: rows[idx].name,
    errCount: errTexts.length,
    errTexts,
    files: (state.result.OutputFiles as any[]).map((f: any) => ({ path: f.Path, contents: new TextDecoder().decode(f.Contents), hash: f.Hash })),
    hashCount: hashes.size,
    stderr: new TextDecoder().decode(new Uint8Array(out)),
    warnRepeated: 0,
  };
}

test("rebuild-impl 夹具 sha256（4 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("rebuildImpl 早退路径逐字节等于 Go（4 场景）", () => {
  assert.equal(rows.length, 4);
  for (let i = 0; i < rows.length; i++) {
    assert.deepEqual(run(i), rows[i], `scenario ${i}: ${rows[i].name}`);
  }
});
