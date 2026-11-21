// 第 44 轮叶子优先规划：CSS 颜色空间底座真值表（Go 探针固化）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { F64 } from "../helpers/float.ts";
import { isPolar, multiplyMatrices, d65_to_d50, d50_to_d65, xyz_to_lab, lab_to_xyz, lab_to_lch, lch_to_lab, xyz_to_oklab, lin_srgb, gam_srgb, lin_p3, gam_p3, lin_prophoto, gam_prophoto, lin_a98rgb, gam_a98rgb, lin_2020, gam_2020, lin_srgb_to_xyz, xyz_to_lin_srgb, lin_p3_to_xyz, xyz_to_lin_p3, lin_prophoto_to_xyz, xyz_to_lin_prophoto, lin_a98rgb_to_xyz, xyz_to_lin_a98rgb, lin_2020_to_xyz, xyz_to_lin_2020 } from "./css_color_spaces.ts";

const FIXTURE = new URL("../../../testdata/css-colorspace-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "de18151689f427f45b5f16649c78551ff747ed08ec8409b5c92421437b107008";

interface Row { fn: string; arg: string; out: string; }

test("CSS 颜色空间底座：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-colorspace fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  const A = [0.4124, 0.3576, 0.1805, 0.2126, 0.7152, 0.0722, 0.0193, 0.1192, 0.9505];
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "isPolar": got = String(isPolar(Number(r.arg))); break;
      case "multiplyMatrices": {
        const [a, b, c] = r.arg.split(",").map(Number);
        const [x, y, z] = multiplyMatrices(A, new F64(a), new F64(b), new F64(c));
        got = [x.Value(), y.Value(), z.Value()].map((v) => v.toFixed(10)).join(",");
        break;
      }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} ${r.arg}`);
  }
});

const F5 = new URL("../../../testdata/css-colorspace5-go.json", import.meta.url);
const b5 = new Uint8Array(readFileSync(F5));
const S5 = "99c277ca89dea2c642ce1a8a2349cc2ff4f9310efb3be4a787ff29ecaeafe310";
interface Row5 { fn: string; arg: string; out: string; }

test("CSS gamma 转换：fixture sha256 + 48 例等于 Go", () => {
  assert.equal(createHash("sha256").update(b5).digest("hex"), S5, "css-colorspace5 fixture sha256");
  const rows: Row5[] = JSON.parse(new TextDecoder().decode(b5));
  const gammas: Record<string, (r: F64, g: F64, b: F64) => [F64, F64, F64]> = {
    lin_p3, gam_p3, lin_prophoto, gam_prophoto, lin_a98rgb, gam_a98rgb, lin_2020, gam_2020,
  };
  const fmt3 = (t: [F64, F64, F64]) => t.map((v) => v.Value().toFixed(12)).join(",");
  for (const r of rows) {
    const v = Number(r.arg);
    assert.equal(fmt3(gammas[r.fn](new F64(v), new F64(v), new F64(v))), r.out, `${r.fn} ${r.arg}`);
  }
});

const F3 = new URL("../../../testdata/css-colorspace3-go.json", import.meta.url);
const b3 = new Uint8Array(readFileSync(F3));
const S3 = "2220dd6b137ab8dd4b3e258e2880b5f6afb4e30264060686bc11ed5e0a1c9ee1";
interface Row3 { fn: string; arg: string; out: string; }

test("CSS 颜色空间转换 2：fixture sha256 + 12 例等于 Go", () => {
  assert.equal(createHash("sha256").update(b3).digest("hex"), S3, "css-colorspace3 fixture sha256");
  const rows: Row3[] = JSON.parse(new TextDecoder().decode(b3));
  const fmt3 = (t: [F64, F64, F64]) => t.map((v) => v.Value().toFixed(12)).join(",");
  for (const r of rows) {
    const [a, b, c] = r.arg.replace(/[\[\]]/g, "").split(" ").filter(Boolean).map(Number);
    let got: string;
    switch (r.fn) {
      case "lab_to_lch": got = fmt3(lab_to_lch(new F64(a), new F64(b), new F64(c))); break;
      case "lch_to_lab": got = fmt3(lch_to_lab(new F64(a), new F64(b), new F64(c))); break;
      case "xyz_to_oklab": got = fmt3(xyz_to_oklab(new F64(a / 100), new F64(b / 100), new F64(c / 100))); break;
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} ${r.arg}`);
  }
});

const F6 = new URL("../../../testdata/css-matrix-go.json", import.meta.url);
const b6 = new Uint8Array(readFileSync(F6));
const S6 = "0455b179fe3b1287356a060b6d2046c5b4d149e99dc4e3d5f41ad4125e923528";
interface Row6 { fn: string; out: string; }

test("CSS 矩阵转换：fixture sha256 + 10 例等于 Go", () => {
  assert.equal(createHash("sha256").update(b6).digest("hex"), S6, "css-matrix fixture sha256");
  const rows: Row6[] = JSON.parse(new TextDecoder().decode(b6));
  const mx: Record<string, (r: F64, g: F64, b: F64) => [F64, F64, F64]> = {
    lin_srgb_to_xyz, xyz_to_lin_srgb, lin_p3_to_xyz, xyz_to_lin_p3, lin_prophoto_to_xyz,
    xyz_to_lin_prophoto, lin_a98rgb_to_xyz, xyz_to_lin_a98rgb, lin_2020_to_xyz, xyz_to_lin_2020,
  };
  const fmt3 = (t: [F64, F64, F64]) => t.map((v) => v.Value().toFixed(12)).join(",");
  for (const r of rows) {
    assert.equal(fmt3(mx[r.fn](new F64(0.3), new F64(0.5), new F64(0.7))), r.out, r.fn);
  }
});

const F4 = new URL("../../../testdata/css-colorspace4-go.json", import.meta.url);
const b4 = new Uint8Array(readFileSync(F4));
const S4 = "5e3a4e8c64fe79c736a83b21303029aed56ce45be0364f34a6cc1b095d8f1f6c";
interface Row4 { fn: string; arg: string; out: string; }

test("CSS sRGB 转换：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(b4).digest("hex"), S4, "css-colorspace4 fixture sha256");
  const rows: Row4[] = JSON.parse(new TextDecoder().decode(b4));
  const fmt3 = (t: [F64, F64, F64]) => t.map((v) => v.Value().toFixed(12)).join(",");
  for (const r of rows) {
    const v = new F64(Number(r.arg));
    const got = r.fn === "lin_srgb" ? fmt3(lin_srgb(v, v, v)) : fmt3(gam_srgb(v, v, v));
    assert.equal(got, r.out, `${r.fn} ${r.arg}`);
  }
});

const F2 = new URL("../../../testdata/css-colorspace2-go.json", import.meta.url);
const b2 = new Uint8Array(readFileSync(F2));
const S2 = "a2c79758e07ea03dbe58226d2b829303baaf7cc2220200213aa826baa0e62e55";
interface Row2 { fn: string; arg: string; out: string; }

test("CSS 颜色空间转换：fixture sha256 + 12 例等于 Go", () => {
  assert.equal(createHash("sha256").update(b2).digest("hex"), S2, "css-colorspace2 fixture sha256");
  const rows: Row2[] = JSON.parse(new TextDecoder().decode(b2));
  const fmt3 = (t: [F64, F64, F64]) => t.map((v) => v.Value().toFixed(10)).join(",");
  for (const r of rows) {
    const [a, b, c] = r.arg.replace(/[\[\]]/g, "").split(" ").filter(Boolean).map(Number);
    let got: string;
    switch (r.fn) {
      case "d65_to_d50": got = fmt3(d65_to_d50(new F64(a), new F64(b), new F64(c))); break;
      case "d50_to_d65": got = fmt3(d50_to_d65(new F64(a), new F64(b), new F64(c))); break;
      case "xyz_to_lab": got = fmt3(xyz_to_lab(new F64(a), new F64(b), new F64(c))); break;
      case "lab_to_xyz": got = fmt3(lab_to_xyz(new F64(a), new F64(b), new F64(c))); break;
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} ${r.arg}`);
  }
});
