// 第 169 批：matchTSConfigPaths，Go 探针 8 例逐字节固化（tsconfig paths 映射）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NewDeferLog, DeferLogKind, Source, Path } from "../logger/logger.ts";
import { MockFS, MockUnix } from "../fs/fs_mock.ts";
import { TSConfigJSON, TSConfigPaths, TSConfigPath } from "./tsconfig_json.ts";
import { matchTSConfigPaths, DebugMeta } from "./resolver.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/tspath-go.json", import.meta.url)));
const SHA = "8cc4006fd22475b6f4e683e503f203f699bc5ef35b3cdcb3edeb00048f3cdd46";

const cfgMap: Record<string, any> = {
  exact: { input: "@/foo", baseURL: "/proj/src", bfp: "/proj/src", paths: { "@/foo": ["./foo.ts"] }, tree: { "/proj/src/foo.ts": "" } },
  "exact-miss": { input: "@/foo", baseURL: "/proj/src", bfp: "/proj/src", paths: { "@/foo": ["./missing.ts"] }, tree: { "/proj/src/other.ts": "" } },
  wildcard: { input: "@/bar/baz", baseURL: "/proj/src", bfp: "/proj/src", paths: { "@/*": ["/*.ts"] }, tree: { "/proj/src/bar/baz.ts": "" } },
  "wildcard-longest": { input: "@/bar/baz", baseURL: "/proj/src", bfp: "/proj/src", paths: { "@/*": ["/*-short.ts"], "@/bar/*": ["/bar/*.ts"] }, tree: { "/proj/src/bar/baz.ts": "" } },
  "dts-ignored": { input: "@/foo", baseURL: "/proj/src", bfp: "/proj/src", paths: { "@/foo": ["./foo.d.ts", "./foo.js"] }, tree: { "/proj/src/foo.js": "" } },
  "abs-baseurl": { input: "@/foo", baseURL: "/proj/src", bfp: "", paths: { "@/foo": ["/abs/foo.ts"] }, tree: { "/abs/foo.ts": "" } },
  "implicit-baseurl": { input: "@/foo", baseURL: null, bfp: "/proj/src", paths: { "@/foo": ["./foo.ts"] }, tree: { "/proj/src/foo.ts": "" } },
  "no-match": { input: "@/foo", baseURL: "/proj/src", bfp: "/proj/src", paths: { "@/other": ["./other.ts"] }, tree: { "/proj/src/foo.ts": "" } },
};

test("tspath fixture sha256 + 8 例逐字节等于 Go", () => {
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
    const ctx: any = { fsObj: fsobj, log, debugLogs: dl, platform: 1, extensionOrder: [".ts", ".js"], dirInfoCtx, mainFields: null,
      nodeModulesExtensionOrder: [], cssExtensionOrder: [], debugMeta: new DebugMeta(), kind: 1 };
    const cfg = new TSConfigJSON(); cfg.AbsPath = "/proj/tsconfig.json"; cfg.BaseURL = c.baseURL; cfg.BaseURLForPaths = c.bfp;
    cfg.Paths = new TSConfigPaths(); cfg.Paths.Source = new Source(); cfg.Paths.Source.KeyPath = new Path(); cfg.Paths.Source.KeyPath.Text = "/proj/tsconfig.json";
    for (const [k, arr] of Object.entries(c.paths)) cfg.Paths.Map.set(k, (arr as string[]).map((t) => new TSConfigPath(t, 0)));
    const p = matchTSConfigPaths(ctx, cfg, c.input);
    const got = [p.text, p.namespace, p.secondary, p.flags, p.ok, p.diffCase === null ? null : [p.diffCase.Dir, p.diffCase.Query, p.diffCase.Actual], notes];
    assert.deepEqual(got, r.out, `${r.arg.name}\n got ${JSON.stringify(got)}\nwant ${JSON.stringify(r.out)}`);
  }
});
