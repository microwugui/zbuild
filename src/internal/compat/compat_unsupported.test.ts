// 第 90 轮叶子优先规划：UnsupportedJSFeatures / UnsupportedCSSFeatures（Go 探针固化）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Semver } from "./compat.ts";
import { UnsupportedJSFeatures } from "./js_table.ts";
import { UnsupportedCSSFeatures } from "./css_table.ts";

const FIXTURE = new URL("../../../testdata/compat-unsupported-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "255e3f283f5137e0cba930450edd6196ee4bae15bcd710ca301a80cb4f114d03";

interface Row { fn: string; arg: string; out: string; }

test("compat-unsupported fixture sha256 + 10 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "compat-unsupported fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const constraints = new Map<number, Semver>();
    if (r.arg !== "") {
      for (const entry of r.arg.split(";")) {
        if (!entry) continue;
        const [eng, ver] = entry.split(":");
        const sv = new Semver(); sv.Parts = ver.split(".").map(Number);
        constraints.set(Number(eng), sv);
      }
    }
    const got = r.fn === "UnsupportedJSFeatures"
      ? UnsupportedJSFeatures(constraints).toString()
      : String(UnsupportedCSSFeatures(constraints));
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 10);
});
