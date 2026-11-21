// 第 79 轮叶子优先规划：goFilepath join/rel/abs（Go 探针固化）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { goFilepath } from "./filepath.ts";

const FIXTURE = new URL("../../../testdata/fs-path2-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "ff090d2ab8b67ca0f30ac1475db42219d97fe4a79c69ce9d14c8f1bd9a7b3b8f";

interface Row { fn: string; win: number; arg: string; out: string; }

test("fs-path2 fixture sha256 + 30 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "fs-path2 fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const fp = new goFilepath(r.win === 1);
    fp.cwd = "/home/user";
    let got: string;
    switch (r.fn) {
      case "join": got = fp.join(JSON.parse(r.arg)); break;
      case "rel": {
        const sep = r.arg.indexOf("|");
        const v = fp.rel(r.arg.slice(0, sep), r.arg.slice(sep + 1));
        got = v.err !== null ? "ERR" : v.value;
        break;
      }
      case "abs": {
        const v = fp.abs(r.arg);
        got = `${v.value}|${v.err === null}`;
        break;
      }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} win=${r.win} (${r.arg})`);
  }
  assert.equal(rows.length, 30);
  // isUNC: 直接覆盖（join 的 Windows UNC 防护路径会调用）
  const fpw = new goFilepath(true);
  assert.equal(fpw.isUNC("\\\\host\\share\\x"), true);
  assert.equal(fpw.isUNC("C:\\foo"), false);
  assert.equal(new goFilepath(false).isUNC("//host/share"), false);
});
