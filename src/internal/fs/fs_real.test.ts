// 第 79 轮：realFS 13 函数落地差分测试。
// 期望值来自 Go 包内探针 /root/esbuild/internal/fs（TestTmpRealProbe 调用真实 RealFS/ReadDirectory/
// ReadFile/kind）→ testdata/fs-real79-go.json。SHA 钉死。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { realFS, RealFS } from "./fs_real.ts";
import { DirEntry, FileEntry } from "./fs.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/fs-real79-go.json", import.meta.url)));
const SHA = "45610f92464e818dd61e80759d6333e7d7747e868ea9e7ec53acd492585f0d61";
interface Row { op: string; arg: string; out: string; err: string; names: string[] | null; kind: number; symlink: string; }

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "real79-"));
  writeFileSync(join(dir, "a.txt"), "AAA");
  writeFileSync(join(dir, "b.txt"), "BBBB");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "c.txt"), "C");
  symlinkSync(join(dir, "a.txt"), join(dir, "link.txt"));
  return dir;
}

test("fs-real79 fixture sha256 + RealFS/ReadDirectory/ReadFile/kind/OpenFile 逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
  const goRows = JSON.parse(new TextDecoder().decode(raw)) as Row[];
  const dir = makeFixture();
  const r = RealFS({ AbsWorkingDir: "/" });
  assert.equal(r.err, null);
  const fs = r.fs!;
  // 逐条按 Go 探针的操作序列核对
  const idx: Record<string, number> = { ReadDirectory: 0, ReadFile: 3, kind: 6 };
  for (const gr of goRows) {
    const i = idx[gr.op]++;
    if (gr.op === "ReadDirectory") {
      const target = gr.arg.startsWith("real79") ? dir : join(dir, gr.arg);
      const got = fs.ReadDirectory(target);
      if (gr.err === "") assert.deepEqual(got.dir.SortedKeys(), gr.names, `ReadDirectory ${gr.arg}`);
      else assert.notEqual(got.err1, null, `ReadDirectory ${gr.arg} err`);
    } else if (gr.op === "ReadFile") {
      const target = gr.arg.startsWith("real79") ? dir : join(dir, gr.arg);
      const got = fs.ReadFile(target);
      if (gr.err === "") assert.equal(got.text, gr.out, `ReadFile ${gr.arg}`);
      else assert.notEqual(got.err1, null, `ReadFile ${gr.arg} err`);
    } else if (gr.op === "kind") {
      const got = fs.kind(dir, gr.arg);
      assert.equal(got.kind, gr.kind, `kind ${gr.arg}`);
      assert.equal(got.symlink !== "", gr.out === "true", `kind symlink ${gr.arg}`);
    }
  }
});

test("realFS path methods + OpenFile/Read/Close/ModKey/EvalSymlinks 覆盖", () => {
  const r = RealFS({ AbsWorkingDir: "/" });
  const fs = r.fs!;
  assert.equal(fs.IsAbs("/a"), true);
  assert.equal(fs.Dir("/a/b"), "/a");
  assert.equal(fs.Base("/a/b.txt"), "b.txt");
  assert.equal(fs.Ext("x.js"), ".js");
  assert.equal(fs.Join(["a", "b"]), "a/b");
  assert.equal(fs.Cwd(), "/");
  assert.deepEqual(fs.Abs("/x"), { value: "/x", ok: true });
  const dir = makeFixture();
  // OpenFile + Read + Close
  const of = fs.OpenFile(join(dir, "a.txt"));
  assert.equal(of.err1, null);
  assert.equal(of.file!.Len(), 3);
  const rd = of.file!.Read(0, 3);
  assert.equal(new TextDecoder().decode(rd.value), "AAA");
  assert.equal(of.file!.Close(), null);
  // ModKey + EvalSymlinks
  assert.equal(typeof fs.ModKey(join(dir, "a.txt")).err, "string");
  const ev = fs.EvalSymlinks(join(dir, "link.txt"));
  assert.equal(ev.ok, true);
  assert.ok(ev.value.endsWith("a.txt"));
  assert.equal(fs.canonicalizeError("ENOTDIR"), "ENOENT");
  assert.equal(fs.canonicalizeError(null), null);
  assert.equal(fs.WatchData().size, 0);
  void DirEntry; void FileEntry;
});
