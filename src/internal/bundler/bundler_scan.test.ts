// 第 90 批：bundle-scan 路径 8 函数逐字节（TLA 校验链 ×3 + source-index ×2 +
// resolve 失败提示 + plugin 消息日志 + source map 注释提取）。
// Go 探针 tools/go/tmpgen_bundle_{scan,diag}_test.bak →
//   testdata/bundle-scan-go.json / testdata/bundle-diag-go.json。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  iterativelyValidateTLA, recursivelyValidateTLA, reportInvalidTLA,
  allocateSourceIndex, allocateGlobSourceIndex,
  ResolveFailureErrorTextSuggestionNotes, logPluginMessages, extractSourceMapFromComment,
} from "./bundler.ts";
import { Index32, MakeIndex32, ImportKind } from "../ast/ast.ts";
import { ImportRecord } from "../js_ast/js_ast.ts";
import { Range, Loc, MsgData, Msg, MsgKind, NewDeferLog, DeferLogKind, MakeLineColumnTracker, Source, PrettyPaths, PathStyle } from "../logger/logger.ts";
import { JSRepr, InputFile } from "../graph/input.ts";
import { MockFS, MockUnix } from "../fs/fs_mock.ts";
import { SourceIndexCache } from "../cache/cache.ts";
import { NewResolver } from "../resolver/resolver.ts";

const scanRaw = new Uint8Array(readFileSync(new URL("../../../testdata/bundle-scan-go.json", import.meta.url)));
const diagRaw = new Uint8Array(readFileSync(new URL("../../../testdata/bundle-diag-go.json", import.meta.url)));
const SCAN_SHA = "bcd92c2b3b3b751e2886280904338e4df08a9d9bc0b93670832fddc280658cfd";
const DIAG_SHA = "6d18307ad6fcd95e17b0c2a39f1d06ef3bbd0029cd2cec6e6e75a9164294bea5";
const scan = JSON.parse(new TextDecoder().decode(scanRaw)) as { rows: { name: string; data: any }[] };
const diag = JSON.parse(new TextDecoder().decode(diagRaw)) as { rows: { name: string; data: any }[] };
const scanBy = Object.fromEntries(scan.rows.map((r) => [r.name, r.data]));
const diagBy = Object.fromEntries(diag.rows.map((r) => [r.name, r.data]));

test("bundle-scan 两夹具 sha256 钉死（11 + 22 行）", () => {
  assert.equal(createHash("sha256").update(scanRaw).digest("hex"), SCAN_SHA);
  assert.equal(createHash("sha256").update(diagRaw).digest("hex"), DIAG_SHA);
});

// ---------- 构造 Go scanner.results 的 TS 等价结构 ----------
function mkJSFile(srcPath: string, importer: string, imports: number[], kinds: number[], liveTLA: boolean): any {
  const repr = new JSRepr();
  repr.AST.ImportRecords = imports.map((idx, i) => {
    const rec = new ImportRecord();
    (rec as any).SourceIndex = MakeIndex32(idx);
    rec.Kind = kinds[i];
    if (kinds[i] === ImportKind.ImportStmt || kinds[i] === ImportKind.ImportRequire) {
      rec.Range = new Range(new Loc(i * 10), 5);
    }
    return rec;
  });
  if (liveTLA) repr.AST.LiveTopLevelAwaitKeyword = new Range(new Loc(0), 10);
  const pretty = new PrettyPaths(); pretty.Abs = srcPath; pretty.Rel = importer;
  const source = new Source();
  source.PrettyPaths = pretty;
  source.KeyPath = { Text: srcPath, Namespace: "file" } as any;
  source.Contents = new TextEncoder().encode("0123456789import './dep.js'; require('./cjs.js');");
  const input = new InputFile();
  (input as any).Repr = repr;
  input.Source = source;
  return {
    ok: true,
    file: { inputFile: input },
    tlaCheck: { parent: new Index32(), depth: new Index32(), pass: 0, importRecordIndex: 0 },
  };
}

function newTLAFiles(name: string): any[] {
  switch (name) {
    case "empty": return [];
    case "single-no-tla": return [mkJSFile("/p/a.js", "a.js", [], [], false)];
    case "single-tla": return [mkJSFile("/p/a.js", "a.js", [], [], true)];
    case "import-tla": return [mkJSFile("/p/a.js", "a.js", [1], [ImportKind.ImportStmt], false), mkJSFile("/p/b.js", "b.js", [], [], true)];
    case "require-tla": return [
      mkJSFile("/p/a.js", "a.js", [1, 2], [ImportKind.ImportStmt, ImportKind.ImportRequire], false),
      mkJSFile("/p/b.js", "b.js", [], [], true), mkJSFile("/p/c.js", "c.js", [], [], true),
    ];
    case "require-transitive-tla": return [
      mkJSFile("/p/a.js", "a.js", [1], [ImportKind.ImportStmt], false),
      mkJSFile("/p/b.js", "b.js", [2, 3], [ImportKind.ImportStmt, ImportKind.ImportRequire], false),
      mkJSFile("/p/c.js", "c.js", [], [], false), mkJSFile("/p/d.js", "d.js", [], [], true),
    ];
    case "dynamic-tla": return [mkJSFile("/p/a.js", "a.js", [1], [ImportKind.ImportDynamic], false), mkJSFile("/p/b.js", "b.js", [], [], true)];
    case "chain-tla": return [
      mkJSFile("/p/a.js", "a.js", [1], [ImportKind.ImportStmt], false),
      mkJSFile("/p/b.js", "b.js", [2], [ImportKind.ImportStmt], false),
      mkJSFile("/p/c.js", "c.js", [], [], true),
    ];
    case "cycle-tla": return [mkJSFile("/p/a.js", "a.js", [1], [ImportKind.ImportStmt], false), mkJSFile("/p/b.js", "b.js", [0], [ImportKind.ImportStmt], true)];
    case "mixed-kinds": return [
      mkJSFile("/p/a.js", "a.js", [1, 2], [ImportKind.ImportStmt, ImportKind.ImportRequire], false),
      mkJSFile("/p/b.js", "b.js", [], [], true),
      mkJSFile("/p/c.js", "c.js", [1], [ImportKind.ImportDynamic], false),
    ];
    default: throw new Error("unknown tla case " + name);
  }
}

function dumpTLA(c: any): any {
  return {
    parentValid: c.parent.IsValid(), parent: c.parent.GetIndex(),
    depthValid: c.depth.IsValid(), depth: c.depth.GetIndex(),
    pass: c.pass, importRecordIndex: c.importRecordIndex,
  };
}

test("iterativelyValidateTLA / reportInvalidTLA：10 例 TLA 图逐字节等于 Go", () => {
  for (const r of scan.rows) {
    if (!r.name.startsWith("tla:")) continue;
    const cname = r.name.slice(4);
    const files = newTLAFiles(cname);
    const log = NewDeferLog(DeferLogKind.DeferLogAll, null);
    const s: any = { results: files, log, options: { LogPathStyle: PathStyle.RelPath } };
    const hasTLA = iterativelyValidateTLA(s);
    const checks = s.results.map((fr: any) => dumpTLA(fr.tlaCheck));
    // reportInvalidTLA 用一份全新的 scanner（Go 探针同样重跑）
    const files2 = newTLAFiles(cname);
    const log2 = NewDeferLog(DeferLogKind.DeferLogAll, null);
    const s2: any = { results: files2, log: log2, options: { LogPathStyle: PathStyle.RelPath } };
    iterativelyValidateTLA(s2);
    reportInvalidTLA(s2);
    const errors = log2.Peek().map((m: Msg) => ({
      text: m.Data.Text, notes: m.Notes.map((n: MsgData) => n.Text),
    }));
    assert.deepEqual({ hasTLA, checks, errors }, r.data, `TLA case ${cname}`);
  }
});

test("allocateSourceIndex / allocateGlobSourceIndex：复用/递增/glob 独立空间逐字节", () => {
  const r = scanBy["alloc:source-index"];
  const s: any = { caches: { SourceIndexCache: new SourceIndexCache() }, results: [] };
  const seq: any[] = [];
  const alloc = (pathText: string, kind: number) => {
    const idx = allocateSourceIndex(s, pathText, kind);
    seq.push({ path: pathText, kind, idx, resultsLen: s.results.length });
  };
  alloc("/p/a.js", 0); alloc("/p/a.js", 0); alloc("/p/b.js", 0); alloc("/p/a.js", 1);
  const gidx1 = allocateGlobSourceIndex(s, 1, 0);
  const gidx2 = allocateGlobSourceIndex(s, 1, 0);
  const gidx3 = allocateGlobSourceIndex(s, 1, 1);
  assert.deepEqual({ seq, glob: [gidx1, gidx2, gidx3], resultsLen: s.results.length }, r);
});

// ---------- diag fixture helpers ----------
const realFS = MockFS({
  "/p/node_modules/some-pkg/package.json": `{"name":"some-pkg"}`,
  "/p/foo.js": "var foo = 1;",
  "/p/foo.js.map": `{"version":3,"sources":["foo.js"]}`,
}, MockUnix, "/p");
const opts: any = { Platform: 0, LogPathStyle: PathStyle.RelPath };
const resolverLog = NewDeferLog(DeferLogKind.DeferLogAll, null);
const resolverAny: any = NewResolver(0, realFS as any, resolverLog, opts);
const res = {
  probeResolvePackageAsRelative: (sourceDir: string, importPath: string, kind: number) =>
    resolverAny.probeResolvePackageAsRelative ? resolverAny.probeResolvePackageAsRelative(sourceDir, importPath, kind) : null,
};

test("ResolveFailureErrorTextSuggestionNotes：8 例提示/建议/notes 逐字节等于 Go", () => {
  const mkPP = (rel: string, abs: string) => { const p = new PrettyPaths(); p.Rel = rel; p.Abs = abs; return p; };
  const cases: Record<string, any> = {
    "plain-pkg": ["some-pkg", ImportKind.ImportStmt, "", "/p", 0, new PrettyPaths(), "", PathStyle.RelPath],
    "require-pkg": ["some-pkg", ImportKind.ImportRequire, "", "/p", 0, new PrettyPaths(), "", PathStyle.RelPath],
    "dynamic-pkg": ["some-pkg", ImportKind.ImportDynamic, "", "/p", 0, new PrettyPaths(), "", PathStyle.RelPath],
    "node-builtin": ["node:fs", ImportKind.ImportStmt, "", "/p", 0, new PrettyPaths(), "", PathStyle.RelPath],
    "node-builtin-no-prefix": ["fs", ImportKind.ImportStmt, "", "/p", 0, new PrettyPaths(), "", PathStyle.RelPath],
    "external-rel": ["./missing.js", ImportKind.ImportStmt, "", "/p", 0, new PrettyPaths(), "", PathStyle.RelPath],
    "alias-remap": ["alias-name", ImportKind.ImportStmt, "", "/p", 0, new PrettyPaths(), "real-pkg", PathStyle.RelPath],
    "plugin-no-dir": ["some-pkg", ImportKind.ImportStmt, "my-plugin", "", 0, mkPP("src/main.js", "/p/src/main.js"), "", PathStyle.RelPath],
  };
  for (const [cname, a] of Object.entries(cases)) {
    const [path, kind, plugin, dir, platform, origin, modified, style] = a;
    const [text, suggestion, notes] = ResolveFailureErrorTextSuggestionNotes(
      res, path, kind, plugin, realFS, dir, platform, origin, modified, style, 0);
    assert.deepEqual({ text, suggestion, notes }, diagBy["resolve:" + cname], `resolve case ${cname}`);
  }
});

test("logPluginMessages：6 例日志逐字节等于 Go", () => {
  const mkMsg = (o: any) => {
    const m = new Msg();
    m.Kind = o.kind; if (o.plugin !== undefined) m.PluginName = o.plugin;
    const d = new MsgData(); d.Text = o.text;
    m.Data = d;
    if (o.notes) m.Notes = o.notes.map((t: string) => { const n = new MsgData(); n.Text = t; return n; });
    return m;
  };
  const cases: Record<string, any> = {
    "empty": { msgs: [], thrown: null, hasImport: false },
    "one-error": { msgs: [mkMsg({ kind: MsgKind.Error, text: "build failed" })], thrown: null, hasImport: false },
    "warning-with-note": { msgs: [mkMsg({ kind: MsgKind.Warning, text: "a warning", notes: ["note text"] })], thrown: null, hasImport: false },
    "default-plugin-name": { msgs: [mkMsg({ kind: MsgKind.Error, text: "no name", plugin: "" })], thrown: null, hasImport: false },
    "thrown": { msgs: [], thrown: new Error("plugin crashed"), hasImport: false },
    "with-import-source": { msgs: [mkMsg({ kind: MsgKind.Error, text: "load error" })], thrown: null, hasImport: true },
  };
  for (const [cname, c] of Object.entries(cases)) {
    const log = NewDeferLog(DeferLogKind.DeferLogAll, null);
    let importSource: Source | null = null;
    let importRange = new Range(new Loc(0), 0);
    if (c.hasImport) {
      const s = new Source();
      s.Contents = new TextEncoder().encode("import './x.js';");
      s.KeyPath = { Text: "/p/src/main.js", Namespace: "file" } as any;
      const p = new PrettyPaths(); p.Rel = "src/main.js"; p.Abs = "/p/src/main.js";
      s.PrettyPaths = p;
      importSource = s;
      importRange = new Range(new Loc(0), 16);
    }
    const didErr = logPluginMessages(realFS, log, "test-plugin", c.msgs, c.thrown, importSource, importRange);
    const msgs = log.Peek().map((m: Msg) => ({ kind: m.Kind, text: m.Data.Text, notes: m.Notes.map((n: MsgData) => n.Text) }));
    assert.deepEqual({ didLogError: didErr, msgs }, diagBy["logplugin:" + cname], `logplugin case ${cname}`);
  }
});

test("extractSourceMapFromComment：8 例路径/内容/日志逐字节等于 Go", () => {
  const cases: Record<string, [string, string]> = {
    "data-percent": [`data:application/json;charset=utf-8,%7B%22version%22:3%7D`, "/p"],
    "data-base64": [`data:application/json;base64,eyJ2ZXJzaW9uIjozfQ==`, "/p"],
    "data-bad-base64": [`data:application/json;base64,!!!!`, "/p"],
    "http-scheme": [`http://example.com/foo.js.map`, "/p"],
    "file-host": [`file://remotehost/foo.js.map`, "/p"],
    "relative-no-dir": [`./foo.js.map`, ""],
    "relative-file": [`./foo.js.map`, "/p"],
    "missing-file": [`./nope.js.map`, "/p"],
  };
  const fsCache = {
    ReadFile: (fsObj: any, path: string) => {
      const r = fsObj.ReadFile(path);
      return { text: r.text, err1: r.err1, err2: r.err2 };
    },
  };
  for (const [cname, [comment, dir]] of Object.entries(cases)) {
    const log = NewDeferLog(DeferLogKind.DeferLogAll, null);
    const src = new Source();
    src.Contents = new TextEncoder().encode("var x=1;\n//# sourceMappingURL=foo");
    src.KeyPath = { Text: "/p/main.js", Namespace: "file" } as any;
    const p = new PrettyPaths(); p.Rel = "main.js"; p.Abs = "/p/main.js";
    src.PrettyPaths = p;
    const tracker = MakeLineColumnTracker(src);
    const span = { Text: comment, Range: new Range(new Loc(9), comment.length) };
    const [path, contents] = extractSourceMapFromComment(log, realFS, fsCache, src, tracker, span, dir, PathStyle.RelPath);
    const msgs = log.Peek().map((m: Msg) => ({ kind: m.Kind, text: m.Data.Text, notes: m.Notes.map((n: MsgData) => n.Text) }));
    assert.deepEqual({
      path: { text: path.Text, namespace: path.Namespace, ignoredSuffix: path.IgnoredSuffix },
      contents, msgs,
    }, diagBy["extract:" + cname], `extract case ${cname}`);
  }
});
