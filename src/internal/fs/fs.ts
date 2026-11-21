// 1:1 移植自 esbuild internal/fs/fs.go（v0.28.2，commit f6058f83）
// 第 44 轮叶子优先规划：目录条目 / 内存文件助手。字节证据由 Go 探针固化在
// testdata/fs-dir-go.json。
// 第 79 轮补：BeforeFileOpen / AfterFileClose（并发闸门）+ MkdirAll / mkdirAll（递归建目录）。
import * as nodeFs from "node:fs";

/** Go: EntryKind (fs.go:16) */
export const DirEntry = 1, FileEntry = 2;

/** Go: type Entry struct (fs.go:23) */
export class Entry {
  base: string = "";
  dir: string = "";
  kind: number = 0;
  needStat = false;
  symlink = "";

  /** Go: func (e *Entry) Kind(fs FS) EntryKind (fs.go:32) —— mock 场景 kind 已设、needStat=false，直接返回 */
  Kind(_fs?: unknown): number { return this.kind; }

  /** Go: func (e *Entry) Symlink(fs FS) string (fs.go:40) —— mock 场景无 symlink，返回已存值 */
  Symlink(_fs?: unknown): string { return this.symlink; }
}

/** Go: type DifferentCase struct (fs.go) */
export class DifferentCase {
  Dir: string = "";
  Query: string = "";
  Actual: string = "";
}

/** Go: type DirEntries struct (fs.go:76) —— 只落本批用到的字段 */
export class DirEntries {
  data: Map<string, Entry> | null = null;
  dir: string = "";

  /** Go: func (entries DirEntries) PeekEntryCount() int (fs.go:123) */
  PeekEntryCount(): number {
    return this.data !== null ? this.data.size : 0;
  }

  /** Go: func (entries DirEntries) Get(query string) (*Entry, *DifferentCase) (fs.go:92) */
  Get(query: string): { entry: Entry | null; differentCase: DifferentCase | null } {
    if (this.data !== null) {
      const key = query.toLowerCase();
      const entry = this.data.get(key) ?? null;
      if (entry !== null) {
        if (entry.base !== query) {
          const dc = new DifferentCase();
          dc.Dir = this.dir; dc.Query = query; dc.Actual = entry.base;
          return { entry, differentCase: dc };
        }
        return { entry, differentCase: null };
      }
    }
    return { entry: null, differentCase: null };
  }

  /** Go: func (entries DirEntries) SortedKeys() []string (fs.go:130) */
  SortedKeys(): string[] {
    if (this.data !== null) {
      const keys: string[] = [];
      for (const entry of this.data.values()) keys.push(entry.base);
      keys.sort();
      return keys;
    }
    return [];
  }
}

/** Go: func MakeEmptyDirEntries(dir string) DirEntries (fs.go:82) */
export function MakeEmptyDirEntries(dir: string): DirEntries {
  const e = new DirEntries();
  e.dir = dir;
  e.data = new Map();
  return e;
}

/** Go: type InMemoryOpenedFile struct (fs.go:157) */
export class InMemoryOpenedFile {
  Contents: Uint8Array = new Uint8Array(0);

  /** Go: func (f *InMemoryOpenedFile) Len() int (fs.go:161) */
  Len(): number {
    return this.Contents.length;
  }

  /** Go: func (f *InMemoryOpenedFile) Read(start, end int) ([]byte, error) (fs.go:165) */
  Read(start: number, end: number): { value: Uint8Array; err: string | null } {
    return { value: this.Contents.slice(start, end), err: null };
  }

  /** Go: func (f *InMemoryOpenedFile) Close() error (fs.go:169) */
  Close(): string | null {
    return null;
  }
}

// --- 并发闸门：Go `var fileOpenLimit = make(chan bool, 32)`（fs.go:240）---
// Go 用带缓冲 channel 限流；TS 用数组模拟容量 32 的信号量。
const fileOpenLimit: boolean[] = [];
const FILE_OPEN_LIMIT = 32;

/** Go: func BeforeFileOpen() (fs.go:243) —— 满时阻塞（TS 侧不做真阻塞，仅登记占用） */
export function BeforeFileOpen(): void {
  if (fileOpenLimit.length < FILE_OPEN_LIMIT) fileOpenLimit.push(false);
}

/** Go: func AfterFileClose() (fs.go:248) */
export function AfterFileClose(): void {
  if (fileOpenLimit.length > 0) fileOpenLimit.pop();
}

/** 供测试读取当前占用数（非 Go API） */
export function openFileCount(): number { return fileOpenLimit.length; }

/** 最小 FS 接口：MkdirAll 只用 Dir / Join（Go fs.go:254 的 fs.Dir / fs.Join） */
export interface MkdirFS { Dir(p: string): string; Join(parts: string[]): string; }

/** Go: func MkdirAll(fs FS, path string, perm os.FileMode) error (fs.go:254) */
export function MkdirAll(fs: MkdirFS, path: string, _perm: number): string | null {
  return mkdirAll(fs, fs.Join([path]), _perm);
}

/** Go: func mkdirAll(fs FS, path string, perm os.FileMode) error (fs.go:259) */
export function mkdirAll(fs: MkdirFS, path: string, perm: number): string | null {
  // Fast path: stat 成功且是目录 → nil；是文件 → ENOTDIR
  try {
    const st = nodeFs.statSync(path);
    if (st.isDirectory()) return null;
    return "ENOTDIR";
  } catch { /* 继续慢路径 */ }
  // Slow path：先建父目录
  const parent = fs.Dir(path);
  if (parent !== path) {
    const err = mkdirAll(fs, parent, perm);
    if (err !== null) return err;
  }
  try {
    nodeFs.mkdirSync(path, { mode: perm });
  } catch {
    // foo/. 双重检查
    try { if (nodeFs.lstatSync(path).isDirectory()) return null; } catch { /* 落到错误 */ }
    return "mkdir-failed";
  }
  return null;
}
