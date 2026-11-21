// 第 139 批：Format.String / DefineFlags.Has / mergeDefineData（Go 探针 14 例逐字节）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { String as FormatString, mergeDefineData } from "./config.ts";
import { Has } from "./globals.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/config-trio-go.json", import.meta.url)));
const SHA = "233e391f4ff5bead55aa749f285b175ebfa0487f9a7cd4125c1c15af71012db6";

test("config-trio fixture sha256 + 14 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: any;
    if (r.fn === "String") got = FormatString(r.arg);
    else if (r.fn === "Has") got = Has(r.arg[0], r.arg[1]);
    else if (r.fn === "mergeDefineData") {
      const res = mergeDefineData({ Flags: r.arg[0], KeyParts: ["a"] }, { Flags: r.arg[1], KeyParts: ["b"] });
      got = [res.Flags, res.KeyParts];
    } else throw new Error("unknown " + r.fn);
    assert.equal(JSON.stringify(got), JSON.stringify(r.out), r.fn + " " + JSON.stringify(r.arg));
  }
  assert.equal(rows.length, 14);
});
