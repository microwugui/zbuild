// 第 44 轮叶子优先规划：compat 语义化版本比较（Go 探针字节证据）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Semver, CompareSemver, splitOffNextPreReleasePart, preReleasePartToNumber, EngineString, ApplyOverrides, compareVersions, isVersionSupported, V, versionRange } from "./compat.ts";

const FIXTURE = new URL("../../../testdata/compat-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "b8c68b689a0ff47dffd6218c6a737f18c3b1ece1a5a2258e6b970dab9949aec8";

interface Row { fn: string; arg: string; out: string; }

const SEMVERS = [
  new Semver(), // 0: 1.2.3
  new Semver(), // 1: 1.2
  new Semver(), // 2: 1.2.3-alpha
  new Semver(), // 3: 1.2.4
  new Semver(), // 4: 2.0.0
  new Semver(), // 5: 1.2.3-beta
];
SEMVERS[0].Parts = [1, 2, 3];
SEMVERS[1].Parts = [1, 2];
SEMVERS[2].Parts = [1, 2, 3]; SEMVERS[2].PreRelease = "-alpha";
SEMVERS[3].Parts = [1, 2, 4];
SEMVERS[4].Parts = [2, 0, 0];
SEMVERS[5].Parts = [1, 2, 3]; SEMVERS[5].PreRelease = "-beta";

test("compat 语义化版本：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "compat fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "splitOffNextPreReleasePart": { const [h, t] = splitOffNextPreReleasePart(r.arg); got = `${h}|${t}`; break; }
      case "preReleasePartToNumber": { const v = preReleasePartToNumber(r.arg); got = `${v.value}|${v.ok}`; break; }
      case "CompareSemver": { const [i, j] = r.arg.split(",").map(Number); got = String(CompareSemver(SEMVERS[i], SEMVERS[j])); break; }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} ${r.arg}`);
  }
});

const F2 = new URL("../../../testdata/compat2-go.json", import.meta.url);
const b2 = new Uint8Array(readFileSync(F2));
const S2 = "bef6d77fc39371bab016136b81cc53ee09f1d940d84bc9e200c7e4ad6ea8a907";
interface Row2 { fn: string; arg: string; out: string; }

test("compat 引擎/覆盖助手：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(b2).digest("hex"), S2, "compat2 fixture sha256");
  const rows: Row2[] = JSON.parse(new TextDecoder().decode(b2));
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "ApplyOverrides": { const [f, o, m] = r.arg.split("|").map((x) => BigInt("0b" + x)); got = (ApplyOverrides(f, o, m)).toString(2); break; }
      case "SemverString": { const m = r.arg.match(/^\[([^\]]*)\](.*)$/)!; const parts = m[1] ? m[1].split(" ").map(Number) : []; const v = new Semver(); v.Parts = parts; v.PreRelease = m[2]; got = v.String(); break; }
      case "EngineString": got = EngineString(Number(r.arg)); break;
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} ${r.arg}`);
  }
});

const F3 = new URL("../../../testdata/compat3-go.json", import.meta.url);
const b3 = new Uint8Array(readFileSync(F3));
const S3 = "b62b1e417e69b980889e9be26b3946ecce2d3ea2f1ec6d7c8d3191340b50e779";
interface Row3 { fn: string; arg: string; out: string; }

test("compat 版本范围助手：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(b3).digest("hex"), S3, "compat3 fixture sha256");
  const rows: Row3[] = JSON.parse(new TextDecoder().decode(b3));
  const mkS = (parts: number[], pre: string = ""): Semver => { const s = new Semver(); s.Parts = parts; s.PreRelease = pre; return s; };
  const mkV = (major: number, minor: number = 0, patch: number = 0): V => { const v = new V(); v.major = major; v.minor = minor; v.patch = patch; return v; };
  const mkR = (start: V, end?: V): versionRange => { const r = new versionRange(); r.start = start; if (end) r.end = end; return r; };
  const svs: Semver[] = [mkS([1, 2, 3]), mkS([1, 2]), mkS([1, 2, 3], "-a"), mkS([2, 0, 0])];
  const ranges = [mkR(mkV(1)), mkR(mkV(2), mkV(3))];
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "compareVersions": { const [vs, j] = r.arg.split("|"); const [ma, mi, pa] = vs.split(".").map(Number); got = String(compareVersions(mkV(ma, mi, pa), svs[Number(j)])); break; }
      case "isVersionSupported": got = String(isVersionSupported(ranges, svs[Number(r.arg)])); break;
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} ${r.arg}`);
  }
});

import { SymbolFeature } from "./compat.ts";
const F4 = new URL("../../../testdata/compat-symbol-go.json", import.meta.url);
const b4 = new Uint8Array(readFileSync(F4));
const S4 = "cdd396d2a7dc96d129bfcc6964d03af10daf1f78ba1c65c1d8abfd4a3cd9926c";
test("compat SymbolFeature：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(b4).digest("hex"), S4, "compat-symbol fixture sha256");
  const rows: { kind: number; out: string }[] = JSON.parse(new TextDecoder().decode(b4));
  for (const r of rows) assert.equal(SymbolFeature(r.kind).toString(), r.out, `kind ${r.kind}`);
});
