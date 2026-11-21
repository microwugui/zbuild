// 第 106 轮：goFilepath.evalSymlinks 逐字节等于 Go（5 场景，真实 OS symlink）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { goFilepath, evalSymlinks } from "./filepath.ts";
import type { SymlinkFS } from "./filepath.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/eval-symlinks-go.json", import.meta.url)));
const SHA = "7e64bb5e714fe4e5b879157744f40a281cc1fe1d7e23b724d89a104c2c4365c0";
const rows = JSON.parse(new TextDecoder().decode(raw)) as any[];

const sfs: SymlinkFS = {
  lstat(p: string) {
    try { const s = nodeFs.lstatSync(p); return { isSymlink: s.isSymbolicLink(), isDir: s.isDirectory(), err: false }; }
    catch { return { isSymlink: false, isDir: false, err: true }; }
  },
  readlink(p: string) {
    try { return { target: nodeFs.readlinkSync(p), err: false }; }
    catch { return { target: "", err: true }; }
  },
};

test("eval-symlinks 夹具 sha256（5 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("evalSymlinks 逐字节等于 Go（5 场景）", () => {
  const base = nodeFs.mkdtempSync("/tmp/symtest-");
  try {
    nodeFs.mkdirSync(nodePath.join(base, "real"), { recursive: true });
    nodeFs.writeFileSync(nodePath.join(base, "real", "a.js"), "x");
    nodeFs.symlinkSync(nodePath.join(base, "real"), nodePath.join(base, "link"));
    nodeFs.symlinkSync(nodePath.join(base, "nope"), nodePath.join(base, "broken"));
    const fp = new goFilepath(false, 0x2f);
    fp.cwd = base;
    const paths = [
      nodePath.join(base, "real", "a.js"),
      nodePath.join(base, "link", "a.js"),
      nodePath.join(base, "real", "..", "real", "a.js"),
      nodePath.join(base, "missing.js"),
      nodePath.join(base, "broken"),
    ];
    assert.equal(rows.length, 5);
    for (let i = 0; i < rows.length; i++) {
      const r = evalSymlinks(fp, paths[i], sfs);
      const rel = r.ok ? nodePath.relative(base, r.path).split(nodePath.sep).join("/") : "";
      const got = { name: rows[i].name, rel, err: r.ok ? "" : "err" };
      assert.deepEqual(got, rows[i], `scenario ${i}: ${rows[i].name}`);
    }
  } finally {
    nodeFs.rmSync(base, { recursive: true, force: true });
  }
});
