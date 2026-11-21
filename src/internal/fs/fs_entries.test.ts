// 第 77 轮叶子优先规划：fs DirEntries / InMemoryOpenedFile 助手（Go 探针固化，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DirEntries, Entry, InMemoryOpenedFile } from "./fs.ts";

const FIXTURE = new URL("../../../testdata/fs-entries-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "816bfc9bb2b6b2407f0a5ed0f9efb6aa61a889468ad3716b484855036b3cb79c";

interface Row { fn: string; arg: string; out: string; }
const splitSemi = (s: string): string[] => s === "" ? [] : s.split(";");

test("fs-entries fixture sha256 + 15 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "fs-entries fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    if (r.fn === "DirEntries.Get") {
      const sep = r.arg.indexOf("|");
      const query = r.arg.slice(0, sep);
      const e = new DirEntries(); e.data = new Map();
      for (const k of splitSemi(r.arg.slice(sep + 1))) { const en = new Entry(); en.base = k; e.data.set(k, en); }
      const v = e.Get(query);
      if (v.entry === null) got = "nil";
      else if (v.differentCase !== null) got = `${v.entry.base}|${v.differentCase.Actual}`;
      else got = v.entry.base;
    } else if (r.fn === "DirEntries.SortedKeys") {
      const e = new DirEntries(); e.data = new Map();
      for (const k of splitSemi(r.arg)) { const en = new Entry(); en.base = k; e.data.set(k, en); }
      got = e.SortedKeys().join(",");
    } else if (r.fn === "InMemoryOpenedFile.Len") {
      const f = new InMemoryOpenedFile(); f.Contents = new Uint8Array(Number(r.arg));
      got = String(f.Len());
    } else throw new Error(`unknown ${r.fn}`);
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 15);
});
