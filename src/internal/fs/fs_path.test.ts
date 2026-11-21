// 第 78 轮叶子优先规划：goFilepath 路径助手簇（clean/base/dir/isAbs，Go 探针固化）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { goFilepath } from "./filepath.ts";

const FIXTURE = new URL("../../../testdata/fs-path-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "7c01206b881e04ea4bb452c1ed337523c0a7ddd5e78a27e68a795a2f7aef9c58";

interface Row { fn: string; win: number; arg: string; out: string; }

test("fs-path fixture sha256 + 56 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "fs-path fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const fp = new goFilepath(r.win === 1);
    let got: string;
    switch (r.fn) {
      case "clean": got = fp.clean(r.arg); break;
      case "base": got = fp.base(r.arg); break;
      case "dir": got = fp.dir(r.arg); break;
      case "isAbs": got = String(fp.isAbs(r.arg)); break;
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} win=${r.win} (${r.arg})`);
  }
  assert.equal(rows.length, 56);
});
