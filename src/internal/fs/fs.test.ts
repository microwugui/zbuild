// 第 44 轮叶子优先规划：fs 目录/文件助手（Go 探针字节证据）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { MakeEmptyDirEntries, InMemoryOpenedFile, Entry } from "./fs.ts";

const FIXTURE = new URL("../../../testdata/fs-dir-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "58126abde6ed1fcf06c80f0067083e5c33f63e70ffc62f2c978dd6ebd5debdb2";

interface Row { fn: string; arg: string; out: string; }

test("fs 目录/文件助手：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "fs-dir fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  const empty = MakeEmptyDirEntries("some/dir");
  const two = MakeEmptyDirEntries("some/dir");
  two.data!.set("a", new Entry()); two.data!.set("b", new Entry());
  const f = new InMemoryOpenedFile();
  f.Contents = new TextEncoder().encode("hello world");
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "PeekEntryCount": got = String((r.arg === "empty" ? empty : two).PeekEntryCount()); break;
      case "Read": { const [s, e] = r.arg.split(",").map(Number); const v = f.Read(s, e); got = `${new TextDecoder().decode(v.value)}|${v.err === null ? "<nil>" : v.err}`; break; }
      case "Close": got = f.Close() === null ? "<nil>" : f.Close()!; break;
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} ${r.arg}`);
  }
});
