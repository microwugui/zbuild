// 1:1 移植自 esbuild internal/fs/fs_zip.go（v0.28.2，commit f6058f83）
// 第 63 轮：Yarn PnP 虚拟路径助手（testdata/fs-pure-go.json）。
// 第 79 轮：补 checkForZip / tryToReadZipArchive / ReadDirectory / ReadFile / OpenFile /
// ModKey / EvalSymlinks / kind / WatchData。Go archive/zip 的最小读取（central directory +
// store/deflate）用 node:fs + node:zlib 等价实现，逐字节校验见 testdata/fs-zip79-go.json。
import * as nodeFs from "node:fs";
import { inflateRawSync } from "node:zlib";
import { mockFS } from "./fs_mock.ts";
import { Entry, DirEntries, FileEntry, DirEntry, MakeEmptyDirEntries } from "./fs.ts";

/** Go: type compressedFile (fs_zip.go:40) —— 记录 central directory 的元信息，内容惰性解压 */
class compressedFile {
  name = "";
  method = 0;      // 0 store / 8 deflate
  compressedSize = 0;
  uncompressedSize = 0;
  localHeaderOffset = 0;
  wasRead = false;
  contents = "";
  err = "";
}

/** Go: type compressedDir (fs_zip.go:32) */
class compressedDir {
  entries = new Map<string, number>(); // name -> EntryKind
  path = "";
  dirEntries = new DirEntries();
}

/** Go: type zipFile (fs_zip.go:35) */
class zipFile {
  err = "";
  dirs = new Map<string, compressedDir>();
  files = new Map<string, compressedFile>();
}

/** 读 ZIP central directory，构建 dirs/files 索引（等价 archive/zip 的 reader.File 遍历）。 */
function readZipCentralDirectory(zipPath: string, archive: zipFile): void {
  let buf: Buffer;
  try { buf = nodeFs.readFileSync(zipPath); }
  catch (e: any) { archive.err = e?.code ?? "err"; return; }
  // 找 EOCD (0x06054b50)，从尾部回扫
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) { archive.err = "zip: not a valid zip file"; return; }
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const seeds: string[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    const isDir = name.endsWith("/");
    const baseNameNoSlash = isDir ? name.slice(0, -1) : name;
    let dirPath = "";
    const slash = baseNameNoSlash.lastIndexOf("/");
    let baseName = baseNameNoSlash;
    if (slash !== -1) { dirPath = baseNameNoSlash.slice(0, slash); baseName = baseNameNoSlash.slice(slash + 1); }
    const lowerDir = dirPath.toLowerCase();
    if (isDir) {
      if (!archive.dirs.has(lowerDir)) {
        const d = new compressedDir(); d.path = dirPath;
        archive.dirs.set(lowerDir, d); archive.dirs.set(lowerDir + "/", d); seeds.push(lowerDir);
      }
    } else {
      const cf = new compressedFile(); cf.name = name; cf.method = method;
      cf.compressedSize = compSize; cf.uncompressedSize = uncompSize; cf.localHeaderOffset = localOff;
      archive.files.set(name.toLowerCase(), cf);
      let d = archive.dirs.get(lowerDir);
      if (!d) { d = new compressedDir(); d.path = dirPath; archive.dirs.set(lowerDir, d); archive.dirs.set(lowerDir + "/", d); seeds.push(lowerDir); }
      d.entries.set(baseName, FileEntry);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  // 填充父目录条目
  for (let baseName of seeds) {
    while (baseName !== "") {
      let dirPath = "";
      const slash = baseName.lastIndexOf("/");
      if (slash !== -1) { dirPath = baseName.slice(0, slash); baseName = baseName.slice(slash + 1); }
      const lowerDir = dirPath.toLowerCase();
      let d = archive.dirs.get(lowerDir);
      if (!d) { d = new compressedDir(); d.path = dirPath; archive.dirs.set(lowerDir, d); archive.dirs.set(lowerDir + "/", d); }
      d.entries.set(baseName, DirEntry);
      baseName = dirPath;
    }
  }
}

/** 惰性解压一个 central-directory 文件条目。 */
function readCompressedFile(archive: zipFile, cf: compressedFile, zipPath: string): void {
  if (cf.wasRead) return;
  cf.wasRead = true;
  try {
    const buf = nodeFs.readFileSync(zipPath);
    const nameLen = buf.readUInt16LE(cf.localHeaderOffset + 26);
    const extraLen = buf.readUInt16LE(cf.localHeaderOffset + 28);
    const dataOff = cf.localHeaderOffset + 30 + nameLen + extraLen;
    const comp = buf.subarray(dataOff, dataOff + cf.compressedSize);
    const raw = cf.method === 8 ? inflateRawSync(comp) : Buffer.from(comp);
    cf.contents = raw.toString("utf8");
  } catch (e: any) { cf.err = e?.code ?? "err"; }
}

/** Go: type zipFS struct (fs_zip.go:29) */
export class zipFS {
  inner: any;
  zipFiles = new Map<string, zipFile>();
  constructor(inner: mockFS | any) { this.inner = inner; }

  /** Go: func (fs *zipFS) checkForZip(path string, kind EntryKind) (*zipFile, string) (fs_zip.go:64) */
  checkForZip(path: string, kind: number): { zip: zipFile | null; pathTail: string } {
    path = path.replace(/\\/g, "/");
    let zipPath = "", pathTail = "";
    const i = path.indexOf(".zip/");
    if (i !== -1) { zipPath = path.slice(0, i + ".zip".length); pathTail = path.slice(i + ".zip/".length); }
    else if (kind === DirEntry && path.endsWith(".zip")) { zipPath = path; }
    else return { zip: null, pathTail: "" };
    let archive = this.zipFiles.get(zipPath);
    if (!archive) {
      archive = new zipFile();
      this.zipFiles.set(zipPath, archive);
      readZipCentralDirectory(zipPath, archive); // Go: tryToReadZipArchive
    }
    if (archive.err !== "") return { zip: null, pathTail: "" };
    return { zip: archive, pathTail };
  }

  /** Go: func tryToReadZipArchive(zipPath string, archive *zipFile) (fs_zip.go:102) —— 由 checkForZip 内联调用 */
  tryToReadZipArchive(zipPath: string, archive: zipFile): void { readZipCentralDirectory(zipPath, archive); }

  /** Go: func (fs *zipFS) ReadDirectory(path string) (DirEntries, error, error) (fs_zip.go:185) */
  ReadDirectory(path: string): { dir: DirEntries; err1: string | null; err2: string | null } {
    path = mangleYarnPnPVirtualPath(path);
    const got = this.inner.ReadDirectory(path);
    if (got.err1 !== "ENOENT" && got.err1 !== "ENOTDIR" && got.err1 !== "EINVAL") return { dir: got.dir, err1: got.err1, err2: got.err2 };
    const { zip, pathTail } = this.checkForZip(path, DirEntry);
    if (!zip) return { dir: got.dir, err1: got.err1, err2: got.err2 };
    const d = zip.dirs.get(pathTail.toLowerCase());
    if (!d) return { dir: new DirEntries(), err1: "ENOENT", err2: "ENOENT" };
    if (d.dirEntries.data !== null) return { dir: d.dirEntries, err1: null, err2: null };
    d.dirEntries = MakeEmptyDirEntries(path);
    for (const [name, kind] of d.entries) {
      const e = new Entry(); e.dir = path; e.base = name; e.kind = kind;
      d.dirEntries.data!.set(name.toLowerCase(), e);
    }
    return { dir: d.dirEntries, err1: null, err2: null };
  }

  /** Go: func (fs *zipFS) ReadFile(path string) (contents string, error, error) (fs_zip.go:229) */
  ReadFile(path: string): { text: string; err1: string | null; err2: string | null } {
    path = mangleYarnPnPVirtualPath(path);
    const got = this.inner.ReadFile(path);
    if (got.err1 !== "ENOENT") return { text: got.text, err1: got.err1, err2: got.err2 };
    // 找 zipPath（checkForZip 用 FileEntry）
    const { zip, pathTail } = this.checkForZip(path, FileEntry);
    if (!zip) return { text: got.text, err1: got.err1, err2: got.err2 };
    const cf = zip.files.get(pathTail.toLowerCase());
    if (!cf) return { text: "", err1: "ENOENT", err2: "ENOENT" };
    // 从 archive path 取回 zip 文件路径（存于 checkForZip 时的 key）
    let zipPath = path.replace(/\\/g, "/"); const zi = zipPath.indexOf(".zip/");
    if (zi !== -1) zipPath = zipPath.slice(0, zi + 4);
    readCompressedFile(zip, cf, zipPath);
    if (cf.err !== "") return { text: "", err1: cf.err, err2: cf.err };
    return { text: cf.contents, err1: null, err2: null };
  }

  /** Go: func (fs *zipFS) OpenFile / ModKey / EvalSymlinks / kind / WatchData —— 纯委托 inner */
  OpenFile(path: string): any { return this.inner.OpenFile(mangleYarnPnPVirtualPath(path)); }
  ModKey(path: string): any { return this.inner.ModKey(mangleYarnPnPVirtualPath(path)); }
  /** Go: func (fs *zipFS) EvalSymlinks(path string) (string, bool) (fs_zip.go:325) —— 委托 inner */
  EvalSymlinks(path: string): { path: string; ok: boolean } { return this.inner.EvalSymlinks(path); }
  kind(dir: string, base: string): { symlink: string; kind: number } { return this.inner.kind(dir, base); }
  WatchData(): unknown { return this.inner.WatchData(); }

  IsAbs(path: string): boolean { return this.inner.IsAbs(path); }
  Abs(path: string): { value: string; ok: boolean } { return this.inner.Abs(path); }
  /** Go: func (fs *zipFS) Dir(path string) string (fs_zip.go:298) */
  Dir(path: string): string {
    const v = ParseYarnPnPVirtualPath(path);
    if (v.ok && v.suffix === "") return v.prefix;
    return this.inner.Dir(path);
  }
  Base(path: string): string { return this.inner.Base(path); }
  Ext(path: string): string { return this.inner.Ext(path); }
  Join(parts: string[]): string { return this.inner.Join(parts); }
  Cwd(): string { return this.inner.Cwd(); }
  Rel(base: string, target: string): { value: string; ok: boolean } { return this.inner.Rel(base, target); }
}

/** Go: func ParseYarnPnPVirtualPath(path string) (string, string, bool) (fs_zip.go:337) */
export function ParseYarnPnPVirtualPath(path: string): { prefix: string; suffix: string; ok: boolean } {
  let i = 0;
  for (;;) {
    const start = i;
    let slash = -1;
    for (let k = i; k < path.length; k++) {
      if (path[k] === "/" || path[k] === "\\") { slash = k - i; break; }
    }
    if (slash === -1) break;
    i += slash + 1;

    const segment = path.slice(start, i - 1);
    if (segment === "__virtual__" || segment === "$$virtual") {
      let slash2 = -1;
      for (let k = i; k < path.length; k++) {
        if (path[k] === "/" || path[k] === "\\") { slash2 = k - i; break; }
      }
      if (slash2 !== -1) {
        let count = "";
        let suffix = "";
        const j = i + slash2 + 1;
        let slash3 = -1;
        for (let k = j; k < path.length; k++) {
          if (path[k] === "/" || path[k] === "\\") { slash3 = k - j; break; }
        }
        if (slash3 !== -1) {
          count = path.slice(j, j + slash3);
          suffix = path.slice(j + slash3);
        } else {
          count = path.slice(j);
        }

        if (/^-?\d+$/.test(count)) {
          let n = parseInt(count, 10);
          let prefix = path.slice(0, start);
          while (n > 0 && (prefix.endsWith("/") || prefix.endsWith("\\"))) {
            let last = -1;
            for (let k = 0; k < prefix.length - 1; k++) {
              if (prefix[k] === "/" || prefix[k] === "\\") last = k;
            }
            if (last === -1) break;
            prefix = prefix.slice(0, last + 1);
            n--;
          }
          const firstSlash = prefix.search(/[\\/]/);
          const lastSlash = Math.max(prefix.lastIndexOf("/"), prefix.lastIndexOf("\\"));
          if (suffix === "" && firstSlash !== lastSlash) {
            prefix = prefix.slice(0, -1);
          } else if (prefix === "") {
            prefix = ".";
          } else if (suffix.startsWith("/") || suffix.startsWith("\\")) {
            suffix = suffix.slice(1);
          }
          return { prefix, suffix, ok: true };
        }
      }
    }
  }
  return { prefix: "", suffix: "", ok: false };
}

/** Go: func mangleYarnPnPVirtualPath(path string) string (fs_zip.go:400) */
export function mangleYarnPnPVirtualPath(path: string): string {
  const { prefix, suffix, ok } = ParseYarnPnPVirtualPath(path);
  if (ok) return prefix + suffix;
  return path;
}
