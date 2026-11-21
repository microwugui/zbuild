// 第 69 轮叶子优先规划：compat 表助手簇（Go 探针固化，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Has as CSSHas, ApplyOverrides as CSSApplyOverrides } from "./css_table.ts";
import { IsBrowser, String as EngineStr, Has as JSHas, ApplyOverrides as JSApplyOverrides } from "./js_table.ts";

const FIXTURE = new URL("../../../testdata/compat-cluster-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "8ea895638079a477384d2ca7b3082f1ff5925adeb2abfcc092bbc3037cff72c0";

interface Row { fn: string; arg: string; out: string; }
const nums = (s: string): number[] => s.split("|").map(Number);
const bigs = (s: string): bigint[] => s.split("|").map((x) => BigInt(x));

test("compat-cluster fixture sha256 + 41 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "compat-cluster fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "CSSFeature.Has": { const [a, b] = nums(r.arg); got = String(CSSHas(a, b)); break; }
      case "CSSFeature.ApplyOverrides": { const [a, b, c] = nums(r.arg); got = String(CSSApplyOverrides(a, b, c)); break; }
      case "Engine.IsBrowser": got = String(IsBrowser(Number(r.arg))); break;
      case "Engine.String": got = EngineStr(Number(r.arg)); break;
      case "JSFeature.Has": { const [a, b] = bigs(r.arg); got = String(JSHas(a, b)); break; }
      case "JSFeature.ApplyOverrides": { const [a, b, c] = bigs(r.arg); got = JSApplyOverrides(a, b, c).toString(); break; }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 41);
});
