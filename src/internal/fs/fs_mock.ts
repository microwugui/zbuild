// 1:1 移植自 esbuild internal/fs/fs_mock.go（v0.28.2，commit f6058f83）
// 第 44 轮叶子优先规划：mock FS 路径转换纯函数。字节证据由 Go 探针固化在
// testdata/fs-mock-go.json。
import { goFilepath } from "./filepath.ts";
import { DirEntries, Entry, InMemoryOpenedFile, DirEntry, FileEntry } from "./fs.ts";

export const MockUnix = 0;
export const MockWindows = 1;

/** Go: type mockFS struct (fs_mock.go:21) —— MockUnix 路径方法 */
export class mockFS {
  Kind: number = MockUnix;
  absWorkingDir: string = "";
  defaultVolume: string = "";
  private fp = new goFilepath(false);
  dirs: Map<string, DirEntries> = new Map();
  files: Map<string, string> = new Map();

  /** Go: func (fs *mockFS) IsAbs(p string) bool (fs_mock.go:146) */
  IsAbs(p: string): boolean { return this.fp.isAbs(p); }
  /** Go: func (fs *mockFS) Abs(p string) (string, bool) (fs_mock.go:153) */
  Abs(p: string): { value: string; ok: boolean } { return { value: this.fp.clean(this.fp.join(["/", p])), ok: true }; }
  /** Go: func (fs *mockFS) Dir(p string) string (fs_mock.go:168) */
  Dir(p: string): string { return this.fp.dir(p); }
  /** Go: func (fs *mockFS) Base(p string) string (fs_mock.go:183) */
  Base(p: string): string { return this.fp.base(p); }
  /** Go: func (fs *mockFS) Ext(p string) string (fs_mock.go:198) */
  Ext(p: string): string { return this.fp.ext(p); }
  /** Go: func (fs *mockFS) Join(parts ...string) string (fs_mock.go:206) */
  Join(parts: string[]): string { return this.fp.clean(this.fp.join(parts)); }
  /** Go: func (fs *mockFS) Cwd() string (fs_mock.go:229) */
  Cwd(): string { return this.absWorkingDir; }
  /** Go: func (fs *mockFS) Rel(base, target string) (string, bool) (fs_mock.go:240) */
  Rel(base: string, target: string): { value: string; ok: boolean } {
    base = this.fp.clean(base); target = this.fp.clean(target);
    if (base === target) return { value: ".", ok: true };
    if (base === ".") base = "";
    if ((base.length > 0 && base[0] === "/") !== (target.length > 0 && target[0] === "/")) return { value: "", ok: false };
    const v = this.fp.rel(base, target);
    return { value: v.value, ok: v.err === null };
  }
  /** Go: func (fs *mockFS) ReadDirectory(path string) (DirEntries, error, error) */
  ReadDirectory(path: string): { dir: DirEntries; err1: string; err2: string } { return readDirectory(this, path); }
  /** Go: func (fs *mockFS) ReadFile(path string) (string, error, error) */
  ReadFile(path: string): { text: string; err1: string; err2: string } { return readFile(this, path); }
  /** Go: func (fs *mockFS) OpenFile(path string) (OpenedFile, error, error) */
  OpenFile(path: string): { file: InMemoryOpenedFile | null; err1: string; err2: string } { return openFile(this, path); }
  /** Go: func (fs *mockFS) ModKey(path string) (ModKey, error) */
  ModKey(path: string): { err: string } { return modKey(this, path); }
  /** Go: func (fs *mockFS) EvalSymlinks(path string) (string, bool) */
  EvalSymlinks(path: string): { path: string; ok: boolean } { return evalSymlinks(this, path); }
  /** Go: func (fs *mockFS) kind(dir, base string) (symlink string, kind EntryKind) (fs_mock.go:319) */
  kind(_dir: string, _base: string): { symlink: string; kind: number } { throw new Error("This should never be called"); }
  /** Go: func (fs *mockFS) WatchData() WatchData (fs_mock.go:323) */
  WatchData(): unknown { throw new Error("This should never be called"); }
}

/** Go: func win2unix(p string) (result string, volume string) (fs_mock.go:124) */
export function win2unix(p: string): { result: string; volume: string } {
  let volume = "";
  if (p.length > 0 && p.slice(1).startsWith(":\\")) {
    const c = p[0];
    if ((c >= "A" && c <= "Z") || (c >= "a" && c <= "z")) {
      volume = p[0];
      p = p.slice(2);
    }
  }
  return { result: p.replaceAll("\\", "/"), volume };
}

/** Go: func unix2win(p string, volume string, defaultVolume string) string (fs_mock.go:135) */
export function unix2win(p: string, volume: string, defaultVolume: string): string {
  p = p.replaceAll("/", "\\");
  if (p.startsWith("\\")) {
    if (volume === "") volume = defaultVolume;
    p = volume + ":" + p;
  }
  return p;
}

/** Go: func splitOnSlash(path string) (string, string) (fs_mock.go:233) */
export function splitOnSlash(path: string): [string, string] {
  const slash = path.indexOf("/");
  if (slash !== -1) return [path.slice(0, slash), path.slice(slash + 1)];
  return [path, ""];
}


// ============================================================================
// 第 126 批：MockFS 构造 + 6 个可观测方法（Go 探针 42 例，fs-batch-go.json）。
// ============================================================================
/** Go: func MockFS(input map[string]string, kind MockKind, absWorkingDir string) FS (fs_mock.go:29) */
export function MockFS(input: Map<string, string> | Record<string, string>, kind: number, absWorkingDir: string): mockFS {
  const dirs = new Map<string, DirEntries>();
  const files = new Map<string, string>();
  const fp = new goFilepath(kind === 1);
  let defaultVolume = "";
  if (kind === 1) defaultVolume = win2unix(absWorkingDir).volume;
  const entries: [string, string][] = input instanceof Map ? [...input] : Object.entries(input);
  for (const [kOriginal, v] of entries) {
    let k = kOriginal, volume = "";
    files.set(kOriginal, v);
    if (kind === 1) { const w = win2unix(k); k = w.result; volume = w.volume; }
    const original = k;
    for (;;) {
      const kDir = fp.dir(k);
      let key = kDir;
      if (kind === 1) key = unix2win(key, volume, defaultVolume);
      let dir = dirs.get(key);
      if (dir === undefined) { dir = new DirEntries(); dir.dir = key; dir.data = new Map(); dirs.set(key, dir); }
      if (kDir === k) break;
      const base = fp.base(k);
      if (k === original) { const e = new Entry(); e.base = base; e.kind = FileEntry; dir.data!.set(base.toLowerCase(), e); }
      else { const e = new Entry(); e.base = base; e.kind = DirEntry; dir.data!.set(base.toLowerCase(), e); }
      k = kDir;
    }
  }
  const fs = new mockFS();
  fs.Kind = kind; fs.absWorkingDir = absWorkingDir; fs.defaultVolume = defaultVolume;
  fs.dirs = dirs; fs.files = files;
  return fs;
}

/** Go: func (fs *mockFS) ReadDirectory(path string) (DirEntries, error, error) (fs_mock.go:74) */
export function readDirectory(fs: mockFS, path: string): { dir: DirEntries; err1: string; err2: string } {
  const noent = "no such file or directory";
  if (fs.Kind === 1) path = path.replaceAll("/", "\\");
  const slash = fs.Kind === 1 ? "\\" : "/";
  const firstSlash = path.indexOf(slash);
  for (;;) {
    const i = path.lastIndexOf(slash);
    if (i !== path.length - 1 || i <= firstSlash) break;
    path = path.slice(0, i);
  }
  const dir = fs.dirs.get(path);
  if (dir !== undefined) return { dir, err1: "", err2: "" };
  return { dir: new DirEntries(), err1: noent, err2: noent };
}

/** Go: func (fs *mockFS) ReadFile(path string) (string, error, error) (fs_mock.go:100) */
export function readFile(fs: mockFS, path: string): { text: string; err1: string; err2: string } {
  const noent = "no such file or directory";
  if (fs.Kind === 1) path = path.replaceAll("/", "\\");
  const text = fs.files.get(path);
  if (text !== undefined) return { text, err1: "", err2: "" };
  return { text: "", err1: noent, err2: noent };
}

/** Go: func (fs *mockFS) OpenFile(path string) (OpenedFile, error, error) (fs_mock.go:110) */
export function openFile(fs: mockFS, path: string): { file: InMemoryOpenedFile | null; err1: string; err2: string } {
  const noent = "no such file or directory";
  if (fs.Kind === 1) path = path.replaceAll("/", "\\");
  const text = fs.files.get(path);
  if (text !== undefined) { const f = new InMemoryOpenedFile(); f.Contents = new TextEncoder().encode(text); return { file: f, err1: "", err2: "" }; }
  return { file: null, err1: noent, err2: noent };
}

/** Go: func (fs *mockFS) ModKey(path string) (ModKey, error) (fs_mock.go:120) */
export function modKey(_fs: mockFS, _path: string): { err: string } {
  return { err: "This is not available during tests" };
}

/** Go: func (fs *mockFS) EvalSymlinks(path string) (string, bool) (fs_mock.go:315) */
export function evalSymlinks(_fs: mockFS, _path: string): { path: string; ok: boolean } {
  return { path: "", ok: false };
}
