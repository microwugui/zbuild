// 第 170 批：finalizeImportsExportsResult，Go 探针 9 例逐字节固化（ESM exports 解析核心深簇）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NewDeferLog, DeferLogKind, Source, Path } from "../logger/logger.ts";
import { MockFS, MockUnix } from "../fs/fs_mock.ts";
import { pjMap, pjStatus, pjDebug, packageJSON, pjEntryFull, pjKind } from "./package_json.ts";
import { finalizeImportsExportsResult, DebugMeta, finalizeImportsExportsNormal, finalizeImportsExportsYarnPnPTSConfigExtends } from "./resolver.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/finalize-go.json", import.meta.url)));
const SHA = "8a4a698df80b81c854958dedd62f91aa9781cc9951d4537529911cfb5478400c";

const cfgMap: Record<string, any> = {
  "exact-file": { resolvedPath: "/foo.js", status: pjStatus.pjStatusExact, kind: finalizeImportsExportsNormal, tree: { "/pkg/foo.js": "" }, invalid: "" },
  "exact-missing": { resolvedPath: "/missing.js", status: pjStatus.pjStatusExact, kind: finalizeImportsExportsNormal, tree: { "/pkg/other.js": "" }, invalid: "" },
  "exact-rewrite-js-ts": { resolvedPath: "/foo.js", status: pjStatus.pjStatusExact, kind: finalizeImportsExportsNormal, tree: { "/pkg/foo.ts": "" }, invalid: "" },
  "exact-star-missing-ext": { resolvedPath: "/foo", status: pjStatus.pjStatusExactEndsWithStar, kind: finalizeImportsExportsNormal, tree: { "/pkg/foo.js": "" }, invalid: "" },
  "exact-dir": { resolvedPath: "/sub", status: pjStatus.pjStatusExact, kind: finalizeImportsExportsNormal, tree: { "/pkg/sub/index.js": "" }, invalid: "" },
  "yarnpnp-shortcut": { resolvedPath: "/foo.js", status: pjStatus.pjStatusExact, kind: finalizeImportsExportsYarnPnPTSConfigExtends, tree: {}, invalid: "" },
  "inexact-file": { resolvedPath: "/foo", status: pjStatus.pjStatusInexact, kind: finalizeImportsExportsNormal, tree: { "/pkg/foo.js": "" }, invalid: "" },
  "inexact-miss": { resolvedPath: "/nope", status: pjStatus.pjStatusInexact, kind: finalizeImportsExportsNormal, tree: { "/pkg/foo.js": "" }, invalid: "" },
  "invalid-module": { resolvedPath: "./foo.js", status: pjStatus.pjStatusInvalidModuleSpecifier, kind: finalizeImportsExportsNormal, tree: {}, invalid: " because of something" },
};

test("finalize fixture sha256 + 9 例逐字节等于 Go", () => {
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
    const ctx: any = { fsObj: fsobj, log, debugLogs: dl, platform: 1, extensionOrder: [".js", ".ts"], dirInfoCtx, mainFields: null,
      nodeModulesExtensionOrder: [], cssExtensionOrder: [], debugMeta: dm, kind: 1 };
    const pj = new packageJSON(); pj.source = new Source(); pj.source.KeyPath = new Path(); pj.source.KeyPath.Text = "/pkg/package.json";
    pj.source.Contents = new TextEncoder().encode("abcdefghijklmnopqrstuvwxyz0123456789\nsecond line\nthird line");
    const pm = new pjMap(); pm.propertyKey = "exports"; pm.propertyKeyLoc = { Start: 1 };
    pm.root = new pjEntryFull(); pm.root.kind = pjKind.pjObject; pm.root.firstToken = { Loc: { Start: 0 }, Len: 1 };
    const dbg = new pjDebug(); dbg.invalidBecause = c.invalid; dbg.token = { Loc: { Start: 2 }, Len: 5 };
    const p = finalizeImportsExportsResult(ctx, c.kind, "/pkg", { import: true }, pm, pj, c.resolvedPath, c.status, dbg, "mypkg", "./sub", "/abs/import.js");
    const dmOut = [dm.notes.map((n: any) => n.Text), dm.suggestionText, dm.suggestionMessage, dm.suggestionRange];
    const got = [[p.text, p.namespace, p.secondary, p.flags], p.ok, p.diffCase === null ? null : [p.diffCase.Dir, p.diffCase.Query, p.diffCase.Actual], dmOut];
    assert.deepEqual(got, r.out, `${r.arg.name}\n got ${JSON.stringify(got)}\nwant ${JSON.stringify(r.out)}`);
  }
});
