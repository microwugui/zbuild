// 第 171 批：esmResolveAlgorithm，Go 探针 6 例逐字节固化（ESM 解析算法协调层）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NewDeferLog, DeferLogKind, Source, Path } from "../logger/logger.ts";
import { MockFS, MockUnix } from "../fs/fs_mock.ts";
import { ParseJSON, JSONOptions } from "../js_parser/json_parser.ts";
import { packageJSON, parseImportsExportsMap } from "./package_json.ts";
import { DebugMeta, esmResolveAlgorithm, finalizeImportsExportsNormal, getProperty } from "./resolver.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/esmalgo-go.json", import.meta.url)));
const SHA = "4321fff872241bfe826feb8b1b0972d91be50f88645575f5f666b70d230a7afa";

const cfgMap: Record<string, any> = {
  "exact-import": { exports: { "./foo": "./foo.js" }, sub: "./foo", kind: 1, tree: { "/pkg/foo.js": "" } },
  "exact-require": { exports: { "./foo": { import: "./foo.mjs", require: "./foo.cjs" } }, sub: "./foo", kind: 2, tree: { "/pkg/foo.cjs": "" } },
  "wildcard-import": { exports: { "./*": "./*.js" }, sub: "./bar", kind: 3, tree: { "/pkg/bar.js": "" } },
  "main-import": { exports: { ".": "./index.js" }, sub: ".", kind: 1, tree: { "/pkg/index.js": "" } },
  "not-exported": { exports: { "./foo": "./foo.js" }, sub: "./bar", kind: 1, tree: { "/pkg/bar.js": "" } },
  "null-disabled": { exports: { "./foo": null }, sub: "./foo", kind: 1, tree: {} },
};

test("esmalgo fixture sha256 + 6 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const c = cfgMap[r.arg.name];
    const notes: string[] = [];
    let indent = "";
    const dl = { addNote: (s: string) => { notes.push(indent + s); }, increaseIndent: () => { indent += "  "; }, decreaseIndent: () => { indent = indent.slice(2); } };
    const fsobj = MockFS(c.tree, MockUnix, "/");
    const log = NewDeferLog(DeferLogKind.DeferLogAll, null);
    const dirInfoCtx: any = { fsObj: fsobj, log, debugLogs: dl, platform: 1, mainFields: null, preserveSymlinks: false, dirCache: new Map(), pnpManifestWasChecked: true,
      readFile: (path: string) => { const t = c.tree[path]; return t === undefined ? { contents: "", err: "no such file or directory" } : { contents: t, err: null }; } };
    const dm = new DebugMeta();
    const ctx: any = { fsObj: fsobj, log, debugLogs: dl, platform: 1, extensionOrder: [".js"], dirInfoCtx, mainFields: null,
      nodeModulesExtensionOrder: [], cssExtensionOrder: [], debugMeta: dm, kind: c.kind,
      esmConditionsDefault: { default: true }, esmConditionsImport: { import: true }, esmConditionsRequire: { require: true } };
    // 构造 exportsMap：ParseJSON(整个 package.json) → getProperty(exports) → parseImportsExportsMap
    const src = new Source(); src.KeyPath = new Path(); src.KeyPath.Text = "/pkg/package.json";
    const contents = JSON.stringify({ exports: c.exports });
    src.Contents = new TextEncoder().encode(contents);
    const parsed = ParseJSON(log, src, new JSONOptions());
    const exportsJSON = getProperty(parsed.expr, "exports");
    const exportsMap = parseImportsExportsMap(src, log, exportsJSON.value, "exports", exportsJSON.loc);
    const pj = new packageJSON(); pj.exportsMap = exportsMap;
    pj.source = new Source(); pj.source.KeyPath = new Path(); pj.source.KeyPath.Text = "/pkg/package.json";
    pj.source.Contents = new TextEncoder().encode("abcdefghijklmnopqrstuvwxyz\nline2");
    const p = esmResolveAlgorithm(ctx, finalizeImportsExportsNormal, "mypkg", c.sub, pj, "/pkg", "/abs/import.js");
    const dmOut = [dm.notes.map((n: any) => n.Text), dm.suggestionText, dm.suggestionMessage, dm.suggestionRange];
    const got = [[p.text, p.namespace, p.secondary, p.flags], p.ok, p.diffCase === null ? null : [p.diffCase.Dir, p.diffCase.Query, p.diffCase.Actual], dmOut];
    assert.deepEqual(got, r.out, `${r.arg.name}\n got ${JSON.stringify(got)}\nwant ${JSON.stringify(r.out)}`);
  }
});
