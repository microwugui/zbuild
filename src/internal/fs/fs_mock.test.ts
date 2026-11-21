// 第 44 轮叶子优先规划：fs_mock 路径转换（Go 探针字节证据）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { win2unix, unix2win, splitOnSlash } from "./fs_mock.ts";

const FIXTURE = new URL("../../../testdata/fs-mock-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "5afdadf7085c20af39ad171f1e1ede6bb92f7f31f564f010db3e9e7feebd0ae8";

interface Row { fn: string; arg: string; out: string; }

test("fs_mock 路径转换：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "fs-mock fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "win2unix": { const v = win2unix(r.arg); got = `${v.result}|${v.volume}`; break; }
      case "unix2win": { const [p, vol, def] = r.arg.replace(/[\[\]]/g, "").split(" "); got = unix2win(p, vol, def); break; }
      case "splitOnSlash": { const [a, b] = splitOnSlash(r.arg); got = `${a}|${b}`; break; }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} ${r.arg}`);
  }
});
