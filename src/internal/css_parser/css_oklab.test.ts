// 第 44 轮叶子优先规划：CSS OKLab 助手（Go 探针字节证据）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { F64 } from "../helpers/float.ts";
import { oklab_to_xyz, oklab_to_oklch, oklch_to_oklab, delta_eok } from "./css_color_spaces.ts";

const FIXTURE = new URL("../../../testdata/css-oklab-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "a8f1569fb27805e9be096d9c5f86a7c076745bdaba6864f9580adcc6c5392b86";

interface Row { fn: string; out: string; }

test("CSS OKLab 助手：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-oklab fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  const l = new F64(0.4), a = new F64(0.2), b = new F64(0.1);
  const fmt3 = (t: [F64, F64, F64]) => t.map((v) => v.Value().toFixed(12)).join(",");
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "oklab_to_xyz": got = fmt3(oklab_to_xyz(l, a, b)); break;
      case "oklab_to_oklch": got = fmt3(oklab_to_oklch(l, a, b)); break;
      case "oklch_to_oklab": got = fmt3(oklch_to_oklab(l, a, b)); break;
      case "delta_eok": got = delta_eok(new F64(50), new F64(20), new F64(30), new F64(60), new F64(10), new F64(40)).Value().toFixed(12); break;
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, r.fn);
  }
});
