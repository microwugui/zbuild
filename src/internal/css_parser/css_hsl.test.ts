// 第 44 轮叶子优先规划：CSS HSL/RGB 转换（Go 探针字节证据）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { F64 } from "../helpers/float.ts";
import { hsl_to_rgb, rgb_to_hsl } from "./css_color_spaces.ts";

const FIXTURE = new URL("../../../testdata/css-hsl-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "9d73a48140372b2e3a72f62ab9109a5cdeb4d51cfd20221d3aface36bce5d71f";

interface Row { fn: string; v: string; out: string; }
const fmt3 = (t: [F64, F64, F64]) => t.map((v) => Number.isNaN(v.Value()) ? "NaN" : v.Value().toFixed(12)).join(",");

test("CSS HSL/RGB 转换：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-hsl fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const v = r.v.replace(/[\[\]]/g, "").split(" ").filter(Boolean).map(Number);
    const got = r.fn === "hsl_to_rgb"
      ? fmt3(hsl_to_rgb(new F64(v[0]), new F64(v[1]), new F64(v[2])))
      : fmt3(rgb_to_hsl(new F64(v[0]), new F64(v[1]), new F64(v[2])));
    assert.equal(got, r.out, `${r.fn} ${r.v}`);
  }
});
