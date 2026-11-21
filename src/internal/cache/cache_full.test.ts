// 第 95 轮：cache 整片端口逐字节等于 Go（5 个未移植函数，单探针成片覆盖）。
// Go 探针 tools/go/tmpgen_cache_test.bak → testdata/cache-full-go.json（12 行）。
// 观测用跨语言稳定的「ok 序列」证明缓存按 contents 命中/失效（命中不重解析、改动则失效），
// 不依赖 parse 的 part/rule 内部数量（那是 parse 层职责，非 cache 契约）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { MakeCacheSet, SourceIndexNormal } from "./cache.ts";
import { JSCache, JSONCache, CSSCache } from "./cache_ast.ts";
import { FSCache } from "./cache_fs.ts";
import type { FSLike } from "./cache_fs.ts";
import { NewDeferLog, DeferLogKind, Source, Path } from "../logger/logger.ts";
import { OptionsFromConfig } from "../js_parser/js_parser.ts";
import { JSONOptions } from "../js_parser/json_parser.ts";
import { Options as CSSOptions } from "../css_parser/css_parser.ts";
import { ModKey } from "../fs/modkey.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/cache-full-go.json", import.meta.url)));
const SHA = "9864aa7213c30605edab72f8596f716e244a07dc42cf5b5efc8b3396b47122e2";
const rows = JSON.parse(new TextDecoder().decode(raw)) as { fn: string; arg: string; out: any }[];

function mkSource(text: string, key: string): Source {
  const s = new Source();
  s.Contents = new TextEncoder().encode(text);
  s.KeyPath = new Path(); s.KeyPath.Text = key; s.KeyPath.Namespace = "file";
  s.PrettyPaths.Abs = key; s.PrettyPaths.Rel = key;
  return s;
}
const D = () => NewDeferLog(DeferLogKind.DeferLogAll, null);

test("cache-full 夹具 sha256（12 行）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("MakeCacheSet + JSCache/JSONCache/CSSCache/FSCache 逐行等于 Go", () => {
  const out = new Map<string, any>();
  const put = (fn: string, arg: string, v: any) => out.set(fn + "|" + arg, v);

  // MakeCacheSet / SourceIndexCache
  const cs = MakeCacheSet();
  put("MakeCacheSet", "LenHint", cs.SourceIndexCache.LenHint());
  put("MakeCacheSet", "Get(a)", cs.SourceIndexCache.Get("a", SourceIndexNormal));
  put("MakeCacheSet", "Get(a again)", cs.SourceIndexCache.Get("a", SourceIndexNormal));

  // JSCache.Parse：ok 序列（有效→命中→无效→命中→恢复有效）
  {
    const c = new JSCache();
    const opts = OptionsFromConfig({ Mode: 2, OutputFormat: 3 });
    const good = mkSource("var x = 1;", "in.js");
    const bad = mkSource("var x = ", "in.js");
    put("JSCache.Parse", "ok seq", [
      c.Parse(D(), good, opts).ok, c.Parse(D(), good, opts).ok,
      c.Parse(D(), bad, opts).ok, c.Parse(D(), bad, opts).ok,
      c.Parse(D(), good, opts).ok,
    ]);
  }

  // JSONCache.Parse
  {
    const c = new JSONCache();
    const opts = new JSONOptions();
    const good = mkSource(`{"a":1}`, "in.json");
    const bad = mkSource(`{`, "in.json");
    put("JSONCache.Parse", "ok seq", [
      c.Parse(D(), good, opts).ok, c.Parse(D(), good, opts).ok,
      c.Parse(D(), bad, opts).ok, c.Parse(D(), bad, opts).ok,
      c.Parse(D(), good, opts).ok,
    ]);
  }

  // CSSCache.Parse：has-rules 序列（无 ok，用规则是否非空）
  {
    const c = new CSSCache();
    const opts = new CSSOptions();
    const good = mkSource("body { color: red; }", "in.css");
    const bad = mkSource("/* empty */", "in.css");
    put("CSSCache.Parse", "has-rules seq", [
      c.Parse(D(), good, opts).Rules.length > 0, c.Parse(D(), good, opts).Rules.length > 0,
      c.Parse(D(), bad, opts).Rules.length > 0, c.Parse(D(), bad, opts).Rules.length > 0,
      c.Parse(D(), good, opts).Rules.length > 0,
    ]);
  }

  // FSCache.ReadFile：miss → hit（不重读）→ 失效（重读）
  {
    const c = new FSCache();
    let contents = "hello";
    let modKeyErr = "";
    let readCalls = 0;
    const fs: FSLike = {
      ModKey: () => ({ key: new ModKey(), err: modKeyErr }),
      ReadFile: () => { readCalls++; return { contents, canonicalError: "", originalError: "" }; },
    };
    const r1 = c.ReadFile(fs, "x.txt");
    put("FSCache.ReadFile", "miss contents", r1.contents);
    put("FSCache.ReadFile", "miss readCalls", readCalls);
    const r2 = c.ReadFile(fs, "x.txt");
    put("FSCache.ReadFile", "hit contents", r2.contents);
    put("FSCache.ReadFile", "hit readCalls(still)", readCalls);
    contents = "world"; modKeyErr = "modkey unavailable";
    const r3 = c.ReadFile(fs, "x.txt");
    put("FSCache.ReadFile", "invalidate contents", r3.contents);
    put("FSCache.ReadFile", "invalidate readCalls", readCalls);
  }

  for (const r of rows) {
    assert.ok(out.has(r.fn + "|" + r.arg), `missing observation ${r.fn}|${r.arg}`);
    assert.deepEqual(out.get(r.fn + "|" + r.arg), r.out, `${r.fn} ${r.arg}`);
  }
  assert.equal(out.size, rows.length, "观测数应等于夹具行数");
});
