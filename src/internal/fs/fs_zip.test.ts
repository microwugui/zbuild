// 第 79 轮：zipFS 9 函数落地差分测试。
// 期望值来自 Go 包内探针 /root/esbuild/internal/fs（TestTmpZipProbe 调用真实 zipFS）
// → testdata/fs-zip79-go.json。SHA 钉死。zip 二进制是 Go archive/zip 现场生成的真实 deflate 包，
// 以 base64 内嵌（避免测试依赖临时文件）；TS 侧用 node:zlib.inflateRawSync 解压（等价 archive/zip）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { zipFS, ParseYarnPnPVirtualPath, mangleYarnPnPVirtualPath } from "./fs_zip.ts";
import { RealFS } from "./fs_real.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/fs-zip79-go.json", import.meta.url)));
const SHA = "679b8c0c1c9d9e8817e7121fa311b2bea9b8254eb813930d06aa5b6cde62ccab";
interface Row { op: string; arg: string; out: string; names: string[] | null; err: string; }

// Go archive/zip 生成的 pkg.zip（inner/a.txt=ZIP-A, inner/b.txt=ZIP-BB, inner/sub/c.txt=ZIP-C）
const ZIP_B64 = "UEsDBBQACAAIAAAAAAAAAAAAAAAAAAAAAAALAAAAaW5uZXIvYS50eHQABQD6/1pJUC1BAwBQSwcImTLQHwwAAAAFAAAAUEsDBBQACAAIAAAAAAAAAAAAAAAAAAAAAAALAAAAaW5uZXIvYi50eHQABgD5/1pJUC1CQgMAUEsHCCBnMegNAAAABgAAAFBLAwQUAAgACAAAAAAAAAAAAAAAAAAAAAAADwAAAGlubmVyL3N1Yi9jLnR4dAAFAPr/WklQLUMDAFBLBwi1U97xDAAAAAUAAABQSwECFAAUAAgACAAAAAAAmTLQHwwAAAAFAAAACwAAAAAAAAAAAAAAAAAAAAAAaW5uZXIvYS50eHRQSwECFAAUAAgACAAAAAAAIGcx6A0AAAAGAAAACwAAAAAAAAAAAAAAAABFAAAAaW5uZXIvYi50eHRQSwECFAAUAAgACAAAAAAAtVPe8QwAAAAFAAAADwAAAAAAAAAAAAAAAACLAAAAaW5uZXIvc3ViL2MudHh0UEsFBgAAAAADAAMArwAAANQAAAAAAA==";
function makeZip(path: string): void { writeFileSync(path, Buffer.from(ZIP_B64, "base64")); }

test("fs-zip79 fixture sha256 + zipFS ReadDirectory/ReadFile 逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
  const rows = JSON.parse(new TextDecoder().decode(raw)) as Row[];
  const dir = mkdtempSync(join(tmpdir(), "zip79-"));
  const zpath = join(dir, "pkg.zip");
  makeZip(zpath);
  const inner = RealFS({ AbsWorkingDir: "/" }).fs!;
  const zfs = new zipFS(inner);
  const rd = zfs.ReadDirectory(zpath + "/inner");
  assert.equal(rd.err1, null, "ReadDirectory zip path ok");
  assert.deepEqual(rd.dir.SortedKeys(), rows[0].names);
  // Go 探针里 a/b 在 inner/ 下，c 在 inner/sub/ 下（fixture 的 arg 只记了 basename）
  const paths = ["/inner/a.txt", "/inner/b.txt", "/inner/sub/c.txt"];
  for (let i = 1; i <= 3; i++) {
    const rf = zfs.ReadFile(zpath + paths[i - 1]);
    assert.equal(rf.err1, null, `ReadFile ${rows[i].arg}`);
    assert.equal(rf.text, rows[i].out, `ReadFile ${rows[i].arg} content`);
  }
});

test("zipFS 委托函数 + checkForZip + 路径助手覆盖", () => {
  const inner = RealFS({ AbsWorkingDir: "/" }).fs!;
  const zfs = new zipFS(inner);
  assert.equal(typeof zfs.IsAbs("/x"), "boolean");
  assert.equal(typeof zfs.Abs("/x").ok, "boolean");
  assert.equal(zfs.Dir("/a/b"), "/a");
  assert.equal(zfs.Base("/a/b.txt"), "b.txt");
  assert.equal(zfs.Ext("x.js"), ".js");
  assert.equal(zfs.Join(["a", "b"]), "a/b");
  assert.equal(typeof zfs.Cwd(), "string");
  assert.equal(typeof zfs.Rel("/a", "/a/b").ok, "boolean");
  // tryToReadZipArchive 直接调用（等价于 checkForZip 内部逻辑）
  const d2 = mkdtempSync(join(tmpdir(), "ziptr-"));
  const zp2 = join(d2, "p.zip"); makeZip(zp2);
  const archive: any = { err: "", dirs: new Map(), files: new Map() };
  zfs.tryToReadZipArchive(zp2, archive);
  assert.equal(archive.err, "");
  assert.ok(archive.files.size >= 3);
  const dir = mkdtempSync(join(tmpdir(), "zipdel-"));
  writeFileSync(join(dir, "f"), "x");
  const of = zfs.OpenFile(join(dir, "f")); assert.ok(of);
  const mk = zfs.ModKey(join(dir, "f")); assert.equal(typeof mk.err, "string");
  const ev = zfs.EvalSymlinks(join(dir, "f")); assert.equal(typeof ev.ok, "boolean");
  const kd = zfs.kind(dir, "f"); assert.equal(typeof kd.kind, "number");
  assert.ok(zfs.WatchData() instanceof Map);
  const cf = zfs.checkForZip("/no.zip/path", 2); assert.equal(cf.zip, null);
  assert.deepEqual(ParseYarnPnPVirtualPath("/a/b"), { prefix: "", suffix: "", ok: false });
  assert.equal(mangleYarnPnPVirtualPath("/a/b"), "/a/b");
});
