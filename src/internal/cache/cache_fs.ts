// 1:1 移植自 esbuild internal/cache/cache_fs.go（v0.28.2，commit f6058f83）
// 第 95 轮成片端口：FSCache.ReadFile。命中/未命中/失效语义由 Go 探针
// tools/go/tmpgen_cache_test.bak → testdata/cache-full-go.json（SHA 94dff67c…）固化。
// 依赖通过注入的 FSLike 提供（Go fs.FS 的 ModKey/ReadFile 两方法子集），非桩。
import { ModKey } from "../fs/modkey.ts";

/** Go fs.FS 的 ModKey/ReadFile 子集（注入，避免绑定完整 FS 实现）。 */
export interface FSLike {
  ModKey(path: string): { key: ModKey; err: string };
  ReadFile(path: string): { contents: string; canonicalError: string; originalError: string };
}

/** Go: fsEntry (cache_fs.go) */
interface fsEntry {
  contents: string;
  modKey: ModKey;
  isModKeyUsable: boolean;
}

function modKeyEqual(a: ModKey, b: ModKey): boolean {
  return a.inode === b.inode && a.size === b.size && a.mtime_sec === b.mtime_sec &&
    a.mtime_nsec === b.mtime_nsec && a.mode === b.mode && a.uid === b.uid;
}

/** Go: type FSCache struct (cache_fs.go:15) */
export class FSCache {
  entries: Map<string, fsEntry> = new Map();

  /** Go: func (c *FSCache) ReadFile (cache_fs.go:25) */
  ReadFile(fs: FSLike, path: string): { contents: string; canonicalError: string; originalError: string } {
    const entry = this.entries.get(path);
    const mk = fs.ModKey(path);
    const modKeyErr = mk.err;
    // If the file's modification key hasn't changed since it was cached, skip reading.
    if (entry !== undefined && entry.isModKeyUsable && modKeyErr === "" && modKeyEqual(entry.modKey, mk.key)) {
      return { contents: entry.contents, canonicalError: "", originalError: "" };
    }
    const r = fs.ReadFile(path);
    if (r.canonicalError !== "") return { contents: "", canonicalError: r.canonicalError, originalError: r.originalError };
    this.entries.set(path, { contents: r.contents, modKey: mk.key, isModKeyUsable: modKeyErr === "" });
    return { contents: r.contents, canonicalError: "", originalError: "" };
  }
}
