// 第 138 批：mappingArray.Len/Swap/Less（Go 探针 18 例逐字节）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Mapping } from "../sourcemap/sourcemap.ts";
import { mappingArray } from "./sourcemap_parser.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/mapping-array-go.json", import.meta.url)));
const SHA = "89a3f5cd0fb229b11eb2fe061f52cd4839772d5ebb13704d7aaa6e0985fd2aec";
const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);

test("mapping-array fixture sha256 + 18 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  const mk = (a: number[][]): mappingArray => new mappingArray(a.map((x) => {
    const m = new Mapping(); m.GeneratedLine = x[0]; m.GeneratedColumn = x[1]; m.SourceIndex = x[2]; return m;
  }));
  for (const r of rows) {
    const ma = mk(r.arr);
    let got: any;
    if (r.fn === "Len") got = ma.Len();
    else if (r.fn === "Swap") { ma.Swap(r.i, r.j); got = ma.items.map((m) => [m.GeneratedLine, m.GeneratedColumn, m.SourceIndex]); }
    else if (r.fn === "Less") got = ma.Less(r.i, r.j);
    else throw new Error("unknown " + r.fn);
    assert.equal(JSON.stringify(canon(got)), JSON.stringify(canon(r.out)), r.fn + " " + JSON.stringify(r.arr) + " " + r.i + "," + r.j);
  }
  assert.equal(rows.length, 18);
});
