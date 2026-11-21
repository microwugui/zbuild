// 1:1 移植自 esbuild internal/cache/cache.go（v0.28.2，commit f6058f83）
// 第 44 轮叶子优先规划：SourceIndexCache 索引分配。字节证据由 Go 探针固化在
// testdata/cache-go.json。第 95 轮补 MakeCacheSet（整片 cache 端口的装配入口）。
import { FSCache } from "./cache_fs.ts";
import { CSSCache, JSONCache, JSCache } from "./cache_ast.ts";

/** Go: SourceIndexKind (cache.go) */
export const SourceIndexNormal = 0;
export const SourceIndexJSStubForCSS = 1;

/** Go: type CacheSet struct (cache.go:33) —— 五个 cache 的装配集合 */
export class CacheSet {
  FSCache: FSCache = new FSCache();
  CSSCache: CSSCache = new CSSCache();
  JSONCache: JSONCache = new JSONCache();
  JSCache: JSCache = new JSCache();
  SourceIndexCache: SourceIndexCache = new SourceIndexCache();
}

/** Go: func MakeCacheSet() *CacheSet (cache.go:41) */
export function MakeCacheSet(): CacheSet { return new CacheSet(); }

/** Go: type sourceIndexKey struct (cache.go) */
class sourceIndexKey {
  text: string;
  kind: number;
  constructor(text: string, kind: number) { this.text = text; this.kind = kind; }
  key(): string { return `${this.kind}\0${this.text}`; }
}

/** Go: type SourceIndexCache struct (cache.go:75) —— 只落本批用到的字段（TS 单线程无 mutex） */
export class SourceIndexCache {
  globEntries: Map<bigint, number> = new Map();
  entries: Map<string, number> = new Map();
  nextSourceIndex: number = 1; // runtime.SourceIndex(0) + 1

  /** Go: func (c *SourceIndexCache) LenHint() uint32 (cache.go:82) */
  LenHint(): number {
    return (this.nextSourceIndex + 16) >>> 0;
  }

  /** Go: func (c *SourceIndexCache) Get(path logger.Path, kind SourceIndexKind) uint32 (cache.go:91) */
  Get(pathText: string, kind: number): number {
    const key = new sourceIndexKey(pathText, kind).key();
    const existing = this.entries.get(key);
    if (existing !== undefined) return existing;
    const sourceIndex = this.nextSourceIndex++;
    this.entries.set(key, sourceIndex);
    return sourceIndex >>> 0;
  }

  /** Go: func (c *SourceIndexCache) GetGlob(parentSourceIndex uint32, globIndex uint32) uint32 (cache.go:104) */
  GetGlob(parentSourceIndex: number, globIndex: number): number {
    const key = (BigInt(parentSourceIndex) << 32n) | BigInt(globIndex);
    const existing = this.globEntries.get(key);
    if (existing !== undefined) return existing;
    const sourceIndex = this.nextSourceIndex++;
    this.globEntries.set(key, sourceIndex);
    return sourceIndex >>> 0;
  }
}
