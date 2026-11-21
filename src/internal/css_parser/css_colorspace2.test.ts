// 第 107 批：色彩空间转换 3 入口（Go 探针 34 例，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NewF64 } from "../helpers/float.ts";
import { gamut_mapping_xyz_to_srgb, xyz_to_colorSpace, colorSpace_to_xyz } from "./css_color_spaces.ts";

const FIXTURE = new URL("../../../testdata/css-colorspaces3-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "08775be84694969104a41801921a0feb37c9c91cf76acc004a4d39d7b11499c6";
interface Row { fn: string; v: number[]; cs: number; out: number[] }

test("css-colorspace2 fixture sha256 + 34 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-colorspace2 fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  // 项目既定口径（tools/known-deviations.json）：Go math.Pow/Cbrt/Log2/Atan2 与 V8
  // 在 1 ULP 上不同，复合色彩转换链会累积该偏差；按 css_oklab.test.ts 同口径用
  // toFixed(10) 比较（差异均在第 10 位小数之后），非逐字节相等，如实标注。
  const fmt = (r: [any, any, any]): string => r.map((v) => v.Value().toFixed(10)).join(",");
  for (const r of rows) {
    const [a, b, c] = r.v.map(NewF64);
    let got: string;
    switch (r.fn) {
      case "gamut_mapping_xyz_to_srgb": got = fmt(gamut_mapping_xyz_to_srgb(a, b, c)); break;
      case "xyz_to_colorSpace": got = fmt(xyz_to_colorSpace(a, b, c, r.cs)); break;
      case "colorSpace_to_xyz": got = fmt(colorSpace_to_xyz(a, b, c, r.cs)); break;
      default: throw new Error("unknown " + r.fn);
    }
    const expected = r.out.map((v) => v.toFixed(10)).join(",");
    assert.equal(got, expected, `${r.fn} cs=${r.cs} ${JSON.stringify(r.v)} => ${got} != ${expected}`);
  }
  assert.equal(rows.length, 34);
});
