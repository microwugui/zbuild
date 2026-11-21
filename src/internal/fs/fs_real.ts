// 1:1 移植自 esbuild internal/fs/fs_real.go（v0.28.2，commit f6058f83）
// 第 81 轮：realFS 路径方法簇（委托 goFilepath）；第 79 轮：补齐 RealFS / ReadDirectory /
// ReadFile / Len / Read / Close / OpenFile / ModKey / EvalSymlinks / readdir / canonicalizeError /
// kind / WatchData。真值表由 Go 包内探针固化在 testdata/fs-real-go.json（路径）与
// testdata/fs-real79-go.json（ReadDirectory/ReadFile/kind）。
import * as nodeFs from "node:fs";
import { goFilepath } from "./filepath.ts";
import { Entry, DirEntries, FileEntry, DirEntry, MakeEmptyDirEntries } from "./fs.ts";
import { BeforeFileOpen, AfterFileClose } from "./fs.ts";
import { ModKey } from "./modkey.ts";
import { modKey } from "./modkey_unix.ts";
import { checkIfWindows } from "./iswin.ts";
import { is_ERROR_INVALID_NAME } from "./error_other.ts";

/** Go: type realFS struct (fs_real.go:14) */
export class realFS {
  fp: goFilepath;
  entries = new Map<string, { entries: DirEntries; canonicalError: string; originalError: string }>();
  doNotCacheEntries = false;

  constructor(isWindows: boolean = false, cwd: string = "/") {
    this.fp = new goFilepath(isWindows);
    this.fp.cwd = cwd;
  }

  /** Go: func (fs *realFS) IsAbs(p string) bool (fs_real.go:307) */
  IsAbs(p: string): boolean { return this.fp.isAbs(p); }
  /** Go: func (fs *realFS) Abs(p string) (string, bool) (fs_real.go:311) */
  Abs(p: string): { value: string; ok: boolean } { const v = this.fp.abs(p); return { value: v.value, ok: v.err === null }; }
  /** Go: func (fs *realFS) Dir(p string) string (fs_real.go:316) */
  Dir(p: string): string { return this.fp.dir(p); }
  /** Go: func (fs *realFS) Base(p string) string (fs_real.go:320) */
  Base(p: string): string { return this.fp.base(p); }
  /** Go: func (fs *realFS) Ext(p string) string (fs_real.go:324) */
  Ext(p: string): string { return this.fp.ext(p); }
  /** Go: func (fs *realFS) Join(parts ...string) string (fs_real.go:328) */
  Join(parts: string[]): string { return this.fp.clean(this.fp.join(parts)); }
  /** Go: func (fs *realFS) Cwd() string (fs_real.go:332) */
  Cwd(): string { return this.fp.cwd; }
  /** Go: func (fs *realFS) Rel(base, target string) (string, bool) (fs_real.go:336) */
  Rel(base: string, target: string): { value: string; ok: boolean } {
    const v = this.fp.rel(base, target);
    return v.err === null ? { value: v.value, ok: true } : { value: "", ok: false };
  }
  /** Go: func (fs *realFS) EvalSymlinks(path string) (string, bool) (fs_real.go:343) */
  EvalSymlinks(path: string): { value: string; ok: boolean } {
    try { return { value: nodeFs.realpathSync(path), ok: true }; } catch { return { value: "", ok: false }; }
  }

  /** Go: func (fs *realFS) canonicalizeError(err error) error (fs_real.go:384) */
  canonicalizeError(err: string | null): string | null {
    if (err === null) return null;
    // Windows ERROR_INVALID_NAME -> ENOENT；ENOTDIR -> ENOENT
    if (this.fp.isWindows && is_ERROR_INVALID_NAME(err)) return "ENOENT";
    if (err === "ENOTDIR") return "ENOENT";
    return err;
  }

  /** Go: func (fs *realFS) readdir(dirname string) (entries, canonicalError, originalError) (fs_real.go:350) */
  readdir(dirname: string): { names: string[]; canonicalError: string | null; originalError: string | null } {
    BeforeFileOpen();
    try {
      const names = nodeFs.readdirSync(dirname);
      return { names, canonicalError: null, originalError: null };
    } catch (e: any) {
      const canonical = this.canonicalizeError(e?.code ?? "err");
      return { names: [], canonicalError: canonical, originalError: e?.code ?? "err" };
    } finally { AfterFileClose(); }
  }

  /** Go: func (fs *realFS) ReadDirectory(dir string) (DirEntries, error, error) (fs_real.go:130) */
  ReadDirectory(dir: string): { dir: DirEntries; err1: string | null; err2: string | null } {
    if (!this.doNotCacheEntries) {
      const cached = this.entries.get(dir);
      if (cached) return { dir: cached.entries, err1: cached.canonicalError, err2: cached.originalError };
    }
    const { names, canonicalError, originalError } = this.readdir(dir);
    const entries = MakeEmptyDirEntries(dir);
    if (canonicalError === null) {
      for (const name of names) {
        const e = new Entry(); e.dir = dir; e.base = name;
        entries.data!.set(name.toLowerCase(), e);
      }
    } else entries.data = null;
    const stored = { entries, canonicalError, originalError };
    if (!this.doNotCacheEntries) this.entries.set(dir, stored);
    return { dir: entries, err1: canonicalError, err2: originalError };
  }

  /** Go: func (fs *realFS) ReadFile(path string) (contents, canonicalError, originalError) (fs_real.go:199) */
  ReadFile(path: string): { text: string; err1: string | null; err2: string | null } {
    BeforeFileOpen();
    try {
      const buf = nodeFs.readFileSync(path);
      return { text: new TextDecoder().decode(buf), err1: null, err2: null };
    } catch (e: any) {
      const code = e?.code ?? "err";
      return { text: "", err1: this.canonicalizeError(code), err2: code };
    } finally { AfterFileClose(); }
  }

  /** Go: func (fs *realFS) OpenFile(path string) (OpenedFile, error, error) (fs_real.go:261) */
  OpenFile(path: string): { file: realOpenedFile | null; err1: string | null; err2: string | null } {
    BeforeFileOpen();
    try {
      const fd = nodeFs.openSync(path, "r");
      const len = nodeFs.fstatSync(fd).size;
      return { file: new realOpenedFile(fd, len), err1: null, err2: null };
    } catch (e: any) {
      const code = e?.code ?? "err";
      return { file: null, err1: this.canonicalizeError(code), err2: code };
    } finally { AfterFileClose(); }
  }

  /** Go: func (fs *realFS) ModKey(path string) (ModKey, error) (fs_real.go:279) */
  ModKey(path: string): { key: ModKey; err: string } { return modKey(path); }

  /** Go: func (fs *realFS) kind(dir, base string) (symlink string, kind EntryKind) (fs_real.go:409) */
  kind(dir: string, base: string): { symlink: string; kind: number } {
    const entryPath = this.fp.join([dir, base]);
    BeforeFileOpen();
    let st;
    try { st = nodeFs.lstatSync(entryPath); }
    catch { return { symlink: "", kind: 0 }; }
    finally { AfterFileClose(); }
    let isDir = st.isDirectory();
    let symlink = "";
    if (st.isSymbolicLink()) {
      try {
        const link = nodeFs.realpathSync(entryPath);
        const st2 = nodeFs.lstatSync(link);
        if (st2.isSymbolicLink()) return { symlink: "", kind: 0 };
        isDir = st2.isDirectory();
        symlink = link;
      } catch { return { symlink: "", kind: 0 }; }
    }
    return { symlink, kind: isDir ? DirEntry : FileEntry };
  }

  /** Go: func (fs *realFS) WatchData() WatchData (fs_real.go:449) —— 无 watch 数据时返回空表 */
  WatchData(): Map<string, () => string> { return new Map(); }
}

/** Go: type realOpenedFile struct (fs_real.go:225) */
export class realOpenedFile {
  handle: number;
  len: number;
  constructor(handle: number, len: number) { this.handle = handle; this.len = len; }
  /** Go: func (f *realOpenedFile) Len() int (fs_real.go:233) */
  Len(): number { return this.len; }
  /** Go: func (f *realOpenedFile) Read(start, end int) ([]byte, error) (fs_real.go:237) */
  Read(start: number, end: number): { value: Uint8Array; err: string | null } {
    try {
      const buf = Buffer.alloc(end - start);
      nodeFs.readSync(this.handle, buf, 0, end - start, start);
      return { value: new Uint8Array(buf), err: null };
    } catch (e: any) { return { value: new Uint8Array(0), err: e?.code ?? "err" }; }
  }
  /** Go: func (f *realOpenedFile) Close() error (fs_real.go:257) */
  Close(): string | null { try { nodeFs.closeSync(this.handle); return null; } catch (e: any) { return e?.code ?? "err"; } }
}

/** Go: func RealFS(options RealFSOptions) (FS, error) (fs_real.go:65) */
export function RealFS(options: { AbsWorkingDir?: string; WantWatchData?: boolean; DoNotCache?: boolean }): { fs: realFS | null; err: string | null } {
  const isWin = checkIfWindows();
  let cwd = options.AbsWorkingDir ?? "";
  if (cwd === "") {
    try { cwd = nodeFs.realpathSync(process.cwd()); }
    catch { cwd = isWin ? "C:\\" : "/"; }
  }
  const fp = new goFilepath(isWin);
  fp.cwd = cwd;
  const fs = new realFS(isWin, cwd);
  fs.fp = fp;
  fs.doNotCacheEntries = options.DoNotCache ?? false;
  return { fs, err: null };
}
