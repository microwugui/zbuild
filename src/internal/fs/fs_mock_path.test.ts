// 第 80 轮叶子优先规划：mockFS 路径方法（MockUnix，Go 探针固化）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mockFS } from "./fs_mock.ts";

const FIXTURE = new URL("../../../testdata/fs-mock-path-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "6c7858b79e91be386d4d98bbcd14cb0e1323a100bc398bd9a7ca9bcaae62e0a4";

interface Row { fn: string; arg: string; out: string; }

test("fs-mock-path fixture sha256 + 30 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "fs-mock-path fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const fs = new mockFS();
    fs.absWorkingDir = "/home/user"; fs.defaultVolume = "C";
    let got: string;
    switch (r.fn) {
      case "IsAbs": got = String(fs.IsAbs(r.arg)); break;
      case "Abs": { const v = fs.Abs(r.arg); got = v.value; break; }
      case "Dir": got = fs.Dir(r.arg); break;
      case "Base": got = fs.Base(r.arg); break;
      case "Ext": got = fs.Ext(r.arg); break;
      case "Join": { const v = fs.Join(JSON.parse(r.arg)); got = v; break; }
      case "Cwd": got = fs.Cwd(); break;
      case "Rel": {
        const sep = r.arg.indexOf("|");
        const v = fs.Rel(r.arg.slice(0, sep), r.arg.slice(sep + 1));
        got = `${v.value}|${v.ok}`;
        break;
      }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 30);
});
