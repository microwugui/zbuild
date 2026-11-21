// 1:1 移植自 esbuild pkg/cli/mangle_cache.go（v0.28.2，commit f6058f83）
// 第 89 批：printMangleCache 纯打印器。Go 探针 testdata/mangle-go.json 逐字节固化。
import { Joiner } from "../../internal/helpers/joiner.ts";
import { QuoteForJSON } from "../../internal/helpers/quote.ts";
import { ParseJSON, JSONOptions } from "../../internal/js_parser/json_parser.ts";
import { NewDeferLog, DeferLogKind, Source, Path, PrettyPaths, OutputOptions, TerminalInfo, AddError, MakeLineColumnTracker, MsgKind } from "../../internal/logger/logger.ts";
import { RangeOfIdentifier } from "../../internal/js_lexer/js_lexer.ts";
import * as js_ast from "../../internal/js_ast/js_ast.ts";
import { UTF16ToString } from "../../internal/helpers/utf.ts";

/** Go: fs.FS 的 ReadFile/Rel/Cwd 子集（parseMangleCache 用）+ 错误渲染回调 */
export interface MangleFS {
  ReadFile(path: string): { contents: Uint8Array; err: string; originalError: string };
  Rel(base: string, target: string): [string, boolean];
  Cwd(): string;
}

/** Go: func parseMangleCache(osArgs, fs, absPath) (map, order) (mangle_cache.go:23) */
export function parseMangleCache(fsObj: MangleFS, absPath: string, writeErr: (s: string) => void): { cache: Map<string, string | boolean> | null; order: string[] | null } {
  const log = NewDeferLog(DeferLogKind.DeferLogAll, null);
  let prettyPath = absPath;
  const [rel, ok] = fsObj.Rel(fsObj.Cwd(), absPath);
  if (ok) prettyPath = rel;
  prettyPath = prettyPath.replaceAll("\\", "/");
  const rf = fsObj.ReadFile(absPath);
  const flushErr = () => {
    const oo = new OutputOptions(); oo.IncludeSource = true;
    const ti = new TerminalInfo();
    const msgs = log.Done();
    let s = "";
    let nErr = 0, nWarn = 0;
    for (const m of msgs) {
      s += new TextDecoder().decode(m.String(oo, ti));
      if (m.Kind === MsgKind.Error) nErr++; else if (m.Kind === MsgKind.Warning) nWarn++;
    }
    // Go NewStderrLog.Done() 末尾输出 `N error(s)` / `N warning(s)` 汇总
    if (nErr > 0) s += `${nErr} error${nErr === 1 ? "" : "s"}\n`;
    if (nWarn > 0) s += `${nWarn} warning${nWarn === 1 ? "" : "s"}\n`;
    if (s !== "") writeErr(s);
  };
  // ENOENT 用空 map（err 字符串含 "no such file" 时视为缺失）
  if (rf.err !== "") {
    if (/no such file|ENOENT/i.test(rf.originalError) || /no such file|ENOENT/i.test(rf.err)) return { cache: new Map(), order: [] };
    AddError(log, null, { Loc: { Start: 0 }, Len: 0 } as any, `Failed to read from mangle cache file ${JSON.stringify(prettyPath)}: ${rf.originalError}`);
    flushErr();
    return { cache: null, order: null };
  }
  const keyPath = new Path(); keyPath.Text = absPath; keyPath.Namespace = "file";
  const source = new Source();
  source.KeyPath = keyPath; source.Contents = rf.contents;
  source.PrettyPaths = new PrettyPaths(); source.PrettyPaths.Abs = absPath; source.PrettyPaths.Rel = prettyPath;
  const tracker = MakeLineColumnTracker(source);
  const result = ParseJSON(log, source, new JSONOptions());
  if (!result.ok || log.HasErrors()) { flushErr(); return { cache: null, order: null }; }
  const root = result.expr.Data;
  if (!(root instanceof js_ast.EObject)) {
    AddError(log, tracker, { Loc: result.expr.Loc, Len: 0 } as any, "Expected a top-level object in mangle cache file");
    flushErr();
    return { cache: null, order: null };
  }
  const cache = new Map<string, string | boolean>();
  const order: string[] = [];
  for (const prop of root.Properties) {
    const key = dec.decode(UTF16ToString((prop.Key.Data as js_ast.EString).Value));
    order.push(key);
    const v = prop.ValueOrNil.Data;
    if (v instanceof js_ast.EBoolean) {
      if (v.Value) { AddError(log, tracker, RangeOfIdentifier(source, prop.ValueOrNil.Loc), `Expected ${JSON.stringify(key)} in mangle cache file to map to either a string or false`); }
      else cache.set(key, false);
    } else if (v instanceof js_ast.EString) cache.set(key, dec.decode(UTF16ToString(v.Value)));
    else AddError(log, tracker, RangeOfIdentifier(source, prop.ValueOrNil.Loc), `Expected ${JSON.stringify(key)} in mangle cache file to map to either a string or false`);
  }
  if (log.HasErrors()) { flushErr(); return { cache: null, order: null }; }
  return { cache, order };
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const S = (s: string) => enc.encode(s);

/** Go: func printMangleCache(mangleCache map[string]interface{}, originalOrder []string, asciiOnly bool) []byte (mangle_cache.go:100) */
export function printMangleCache(mangleCache: Map<string, string | boolean>, originalOrder: string[], asciiOnly: boolean): Uint8Array {
  const j = new Joiner();
  j.AddString(S("{"));
  let order = originalOrder;
  if (mangleCache.size > order.length) {
    if (isSortedStr(originalOrder)) {
      order = [...mangleCache.keys()].sort();
    } else {
      const originalKeys = new Set(originalOrder);
      order = [...originalOrder];
      for (const key of mangleCache.keys()) if (!originalKeys.has(key)) order.push(key);
      const tail = order.slice(originalOrder.length).sort();
      order = [...order.slice(0, originalOrder.length), ...tail];
    }
  }
  for (let i = 0; i < order.length; i++) {
    const key = order[i];
    if (i > 0) j.AddString(S(",\n  "));
    else j.AddString(S("\n  "));
    j.AddBytes(QuoteForJSON(S(key), asciiOnly));
    const value = mangleCache.get(key);
    if (value !== false) {
      j.AddString(S(": "));
      j.AddBytes(QuoteForJSON(S(String(value)), asciiOnly));
    } else {
      j.AddString(S(": false"));
    }
  }
  if (order.length > 0) j.AddString(S("\n"));
  j.AddString(S("}\n"));
  return j.Done();
}

function isSortedStr(a: string[]): boolean {
  for (let i = 1; i < a.length; i++) if (a[i - 1] > a[i]) return false;
  return true;
}
