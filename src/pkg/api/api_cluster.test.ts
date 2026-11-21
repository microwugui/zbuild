// 第 92 轮叶子优先规划：pkg/api validate 整簇（Go 探针固化，一次探针 3 函数）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mockFS } from "../../internal/fs/fs_mock.ts";
import { validateSupported, validateAlias, validateJSXExpr } from "./api_impl.ts";

const FIXTURE = new URL("../../../testdata/api-cluster-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "8546325eed65eeb987d4d66cca58655e4ae9922d1f5b506980557cfabd202b25";

interface Row { fn: string; arg: string; out: string; }

test("api-cluster fixture sha256 + 13 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "api-cluster fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  const mock = new mockFS();
  for (const r of rows) {
    let got: string;
    if (r.fn === "validateSupported") {
      const input = new Map<string, boolean>(Object.entries(JSON.parse(r.arg)));
      const v = validateSupported(input);
      got = `${v.js}|${v.jsMask}|${v.css}|${v.cssMask}`;
    } else if (r.fn === "validateAlias") {
      const input = new Map<string, string>(Object.entries(JSON.parse(r.arg)));
      const v = validateAlias(input, (p) => mock.IsAbs(p));
      got = [...v.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0).map(([k, val]) => `${k}=${val};`).join("");
    } else if (r.fn === "validateJSXExpr") {
      const p = r.arg.lastIndexOf("|");
      const v = validateJSXExpr(r.arg.slice(0, p), r.arg.slice(p + 1));
      got = v.constant ? "const" : v.parts.length > 0 ? "parts" : "none";
    } else throw new Error(`unknown ${r.fn}`);
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 13);
});
