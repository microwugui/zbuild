// 第 63 轮叶子优先规划：fs 纯路径助手整簇（一次 Go 探针、5 函数、逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isSlash, isReservedName, goFilepath } from "./filepath.ts";
import { ParseYarnPnPVirtualPath, mangleYarnPnPVirtualPath } from "./fs_zip.ts";

const FIXTURE = new URL("../../../testdata/fs-pure-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "4f2596d08ed7d67009cc54ca23b79041e3081cca2b01af23bb8f73800ba0c593";

interface Row { fn: string; arg: string; out: string; }

test("fs-pure fixture sha256 + 31 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "fs-pure fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "isSlash":
        got = String(isSlash(Number(r.arg)));
        break;
      case "isReservedName":
        got = String(isReservedName(r.arg));
        break;
      case "ext": {
        const p = r.arg.indexOf("|");
        const fp = new goFilepath(r.arg.slice(0, p) === "1");
        got = fp.ext(r.arg.slice(p + 1));
        break;
      }
      case "ParseYarnPnPVirtualPath": {
        const v = ParseYarnPnPVirtualPath(r.arg);
        got = `${v.prefix}|${v.suffix}|${v.ok}`;
        break;
      }
      case "mangleYarnPnPVirtualPath":
        got = mangleYarnPnPVirtualPath(r.arg);
        break;
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 31);
});
