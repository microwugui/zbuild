// 第 79 轮批量落地：internal/test 三函数 + fs 平台变体 + fs helpers + fs_mock 两法的差分测试。
//
// diff/diffRec/lcSubstr 期望值来自 Go 包内探针（调用真实 diff）→ testdata/test-diff-go.json
// （16 例 color true/false，含空串/删除/插入/公共子串）。SHA 钉死。
// modKey 期望值来自 Go 包内探针 TestTmpModKeyProbe → testdata/fs-modkey-go.json（SHA 钉死）。
// 平台变体与 fs helpers 是 Go 源码层面的常量/直接表达，真值表逐条对照 Go 源码（见各文件头注释）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, utimesSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import * as diffmod from "./diff.ts";
import { AssertEqual, AssertEqualWithDiff, SourceForTest } from "./util.ts";
import { CheckIfWindows as ciwOther } from "../fs/iswin_other.ts";
import { CheckIfWindows as ciwWin } from "../fs/iswin_windows.ts";
import { CheckIfWindows as ciwWasm } from "../fs/iswin_wasm.ts";
import { is_ERROR_INVALID_NAME as invNameOther } from "../fs/error_other.ts";
import { is_ERROR_INVALID_NAME as invNameWin } from "../fs/error_wasm+windows.ts";
import { modKey as modKeyUnix } from "../fs/modkey_unix.ts";
import { modKey as modKeyOther } from "../fs/modkey_other.ts";
import { BeforeFileOpen, AfterFileClose, openFileCount, MkdirAll, type MkdirFS } from "../fs/fs.ts";
import { MockFS, MockUnix } from "../fs/fs_mock.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/test-diff-go.json", import.meta.url)));
const SHA = "23693260c77086a2595ad6e0057ff9df6af6389116c62458221e58ce74a0f3ca";
interface DiffRow { old: string; new: string; color: boolean; out: string; }
const rows: DiffRow[] = JSON.parse(new TextDecoder().decode(raw));

test("test-diff fixture sha256 + diff/diffRec/lcSubstr 逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
  let bad = 0;
  for (const r of rows) {
    const got = diffmod.diff(r.old, r.new, r.color);
    if (got !== r.out) { bad++; if (bad <= 4) console.error("diff mismatch", JSON.stringify(r), "got", JSON.stringify(got)); }
  }
  assert.equal(bad, 0, `diff 应全部等于 Go，${bad} 例不符`);
  assert.deepEqual(diffmod.lcSubstr(["a", "b", "c"], ["a", "X", "c"]), [0, 0, 1]);
  assert.deepEqual(diffmod.lcSubstr(["a", "b", "c"], ["a", "b", "c"]), [0, 0, 3]);
  assert.deepEqual(diffmod.lcSubstr([], []), [0, 0, 0]);
});

test("internal/test util 三函数执行", () => {
  AssertEqual(1, 1);
  assert.throws(() => AssertEqual(1, 2));
  AssertEqualWithDiff("same", "same");
  assert.throws(() => AssertEqualWithDiff("a", "b"), (e: any) => String(e.message).includes("-b") && String(e.message).includes("+a"));
  const s = SourceForTest("hello");
  assert.equal(s.IdentifierName, "stdin");
  assert.equal(s.KeyPath.Text, "<stdin>");
  assert.equal(new TextDecoder().decode(s.Contents), "hello");
});

test("fs 平台变体 CheckIfWindows / is_ERROR_INVALID_NAME 逐条等于 Go 源码", () => {
  assert.equal(ciwOther(), false);
  assert.equal(ciwWin(), true);
  // iswin_wasm.go: os.Stat("C:\\") 存在与否；Node/Linux 上恒 false（无该路径）
  assert.equal(typeof ciwWasm(), "boolean");
  assert.equal(invNameOther(new Error("x")), false);
  assert.equal(invNameWin(123), true);
  assert.equal(invNameWin(2), false);
});

test("fs modKey 两变体：对齐 Go 探针 errKind（old-file/missing/dir）", () => {
  const rawMod = new Uint8Array(readFileSync(new URL("../../../testdata/fs-modkey-go.json", import.meta.url)));
  assert.equal(createHash("sha256").update(rawMod).digest("hex"), "c17e7af7484b5e90f93ae6655b219370feb41e8ea18a3ebe2c02c60309106b58");
  const goRows = JSON.parse(new TextDecoder().decode(rawMod)) as { case: string; errKind: string }[];
  const dir = mkdtempSync(join(tmpdir(), "mk79-"));
  const p = join(dir, "f.txt");
  writeFileSync(p, "hello");
  const old = new Date(1000000000 * 1000);
  utimesSync(p, old, old);
  const cases: [string, string][] = [["old-file", p], ["missing", join(dir, "missing")], ["dir", dir]];
  for (let i = 0; i < cases.length; i++) {
    const [name, path] = cases[i];
    const res = modKeyUnix(path);
    let kind = "none";
    if (res.err === "The modification key is unusable") kind = "unusable";
    else if (res.err !== "") kind = "stat-error";
    assert.equal(kind, goRows[i].errKind, `${name} errKind`);
    if (kind === "none") {
      assert.equal(Number(res.key.size), 5);
      assert.equal(Number(res.key.mtime_sec), 1000000000);
    }
  }
  assert.equal(modKeyOther(p).err, "");
  assert.equal(modKeyOther(join(dir, "missing")).err.startsWith("stat-error"), true);
});

test("fs helpers: BeforeFileOpen/AfterFileClose 闸门 + MkdirAll 递归建目录", () => {
  const before = openFileCount();
  BeforeFileOpen(); assert.equal(openFileCount(), before + 1);
  AfterFileClose(); assert.equal(openFileCount(), before);
  const mfs: MkdirFS = { Dir: (p) => p.replace(/\/[^\/]*$/, "") || "/", Join: (parts) => parts.join("/") };
  const dir = mkdtempSync(join(tmpdir(), "mkdir79-"));
  const target = join(dir, "a", "b", "c");
  assert.equal(MkdirAll(mfs, target, 0o755), null);
  assert.equal(existsSync(join(dir, "a", "b")), true);
  mkdirSync(join(dir, "exists"));
  assert.equal(MkdirAll(mfs, join(dir, "exists"), 0o755), null);
  writeFileSync(join(dir, "afile"), "x");
  assert.equal(MkdirAll(mfs, join(dir, "afile"), 0o755), "ENOTDIR");
});

test("fs_mock kind/WatchData 两法忠实 panic（Go: 'This should never be called'）", () => {
  const fs = MockFS({}, MockUnix, "/");
  assert.throws(() => fs.kind("/", "x"), /This should never be called/);
  assert.throws(() => fs.WatchData(), /This should never be called/);
});
