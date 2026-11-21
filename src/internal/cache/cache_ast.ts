// 1:1 移植自 esbuild internal/cache/cache_ast.go（v0.28.2，commit f6058f83）
// 第 95 轮成片端口：CSSCache/JSONCache/JSCache 三个 Parse。缓存命中/未命中语义由 Go 探针
// tools/go/tmpgen_cache_test.bak → testdata/cache-full-go.json（SHA 94dff67c…）逐字节固化。
// TS 单线程无 mutex（Go 的 mutex 在此无对应物，逻辑等价）。
import { Log, Source, Path, NewDeferLog, DeferLogKind, Msg } from "../logger/logger.ts";
import { Options as CSSOptions, Parse as ParseCSS } from "../css_parser/css_parser.ts";
import { CSSAST } from "../css_ast/css_ast.ts";
import { Options as JSOptions, Parse as ParseJS, Equal as JSOptionsEqual } from "../js_parser/js_parser.ts";
import { JSONOptions, ParseJSON } from "../js_parser/json_parser.ts";
import { Expr } from "../js_ast/js_ast.ts";

/** Go: func (s *Source) 相等判定 —— Go 用 `entry.source == source`（struct 逐字段）。 */
function sourceEqual(a: Source, b: Source): boolean {
  if (a.Contents.length !== b.Contents.length) return false;
  for (let i = 0; i < a.Contents.length; i++) if (a.Contents[i] !== b.Contents[i]) return false;
  return a.KeyPath.Text === b.KeyPath.Text && a.KeyPath.Namespace === b.KeyPath.Namespace &&
    a.IdentifierName === b.IdentifierName;
}

/** Go: jsonCacheEntry (cache_ast.go) */
interface jsonCacheEntry {
  expr: Expr; msgs: Msg[]; source: Source; options: JSONOptions; ok: boolean;
}
function jsonOptionsEqual(a: JSONOptions, b: JSONOptions): boolean {
  return a.UnsupportedJSFeatures === b.UnsupportedJSFeatures && a.Flavor === b.Flavor &&
    a.ErrorSuffix === b.ErrorSuffix && a.IsForDefine === b.IsForDefine;
}

/** Go: type JSONCache struct (cache_ast.go:96) */
export class JSONCache {
  entries: Map<string, jsonCacheEntry> = new Map();

  /** Go: func (c *JSONCache) Parse (cache_ast.go:96) */
  Parse(log: Log, source: Source, options: JSONOptions): { expr: Expr; ok: boolean } {
    const key = source.KeyPath.Namespace + "\0" + source.KeyPath.Text;
    const entry = this.entries.get(key);
    // Cache hit
    if (entry !== undefined && sourceEqual(entry.source, source) && jsonOptionsEqual(entry.options, options)) {
      for (const msg of entry.msgs) log.AddMsg(msg);
      return { expr: entry.expr, ok: entry.ok };
    }
    // Cache miss
    const tempLog = NewDeferLog(DeferLogKind.DeferLogAll, log.Overrides);
    const { expr, ok } = ParseJSON(tempLog, source, options);
    const msgs = tempLog.Done();
    for (const msg of msgs) log.AddMsg(msg);
    this.entries.set(key, { expr, ok, source, options, msgs });
    return { expr, ok };
  }
}

/** Go: jsCacheEntry (cache_ast.go) */
interface jsCacheEntry {
  source: Source; msgs: Msg[]; options: JSOptions; ast: any; ok: boolean;
}

/** Go: type JSCache struct (cache_ast.go:152) */
export class JSCache {
  entries: Map<string, jsCacheEntry> = new Map();

  /** Go: func (c *JSCache) Parse (cache_ast.go:152) */
  Parse(log: Log, source: Source, options: JSOptions): { ast: any; ok: boolean } {
    const key = source.KeyPath.Namespace + "\0" + source.KeyPath.Text;
    const entry = this.entries.get(key);
    // Cache hit
    if (entry !== undefined && sourceEqual(entry.source, source) && JSOptionsEqual(entry.options, options)) {
      for (const msg of entry.msgs) log.AddMsg(msg);
      return { ast: entry.ast, ok: entry.ok };
    }
    // Cache miss
    const tempLog = NewDeferLog(DeferLogKind.DeferLogAll, log.Overrides);
    const r = ParseJS(tempLog, source, options);
    const msgs = tempLog.Done();
    for (const msg of msgs) log.AddMsg(msg);
    this.entries.set(key, { ast: r.ast, ok: r.ok, source, options, msgs });
    return { ast: r.ast, ok: r.ok };
  }
}

/** Go: cssCacheEntry (cache_ast.go) */
interface cssCacheEntry {
  source: Source; msgs: Msg[]; ast: CSSAST; options: CSSOptions;
}

/** Go: type CSSCache struct (cache_ast.go:41) */
export class CSSCache {
  entries: Map<string, cssCacheEntry> = new Map();

  /** Go: func (c *CSSCache) Parse (cache_ast.go:41) */
  Parse(log: Log, source: Source, options: CSSOptions): CSSAST {
    const key = source.KeyPath.Namespace + "\0" + source.KeyPath.Text;
    const entry = this.entries.get(key);
    // Cache hit
    if (entry !== undefined && sourceEqual(entry.source, source) && entry.options.Equal(options)) {
      for (const msg of entry.msgs) log.AddMsg(msg);
      return entry.ast;
    }
    // Cache miss
    const tempLog = NewDeferLog(DeferLogKind.DeferLogAll, log.Overrides);
    const ast = ParseCSS(tempLog, source, options);
    const msgs = tempLog.Done();
    for (const msg of msgs) log.AddMsg(msg);
    this.entries.set(key, { source, options, ast, msgs });
    return ast;
  }
}
