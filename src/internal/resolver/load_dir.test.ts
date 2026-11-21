// 第 167 批：loadAsMainField + loadAsDirectory + loadAsFileOrDirectory，Go 探针 12 例逐字节固化。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NewDeferLog, DeferLogKind } from "../logger/logger.ts";
import { MockFS, MockUnix } from "../fs/fs_mock.ts";
import { dirInfo, packageJSON } from "./package_json.ts";
import { loadAsMainField, loadAsDirectory, loadAsFileOrDirectory, DebugMeta } from "./resolver.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/load-dir-go.json", import.meta.url)));
const SHA = "c58b9d44bcb6f20fb07143b14f053dfce2225175d95288b38585a51773d45c17";

const dumpDC = (dc: any): any => dc === null ? null : [dc.Dir, dc.Query, dc.Actual];
const dumpPair = (p: any, notes: string[], dmn: string[]): any => [[p.text, p.namespace, p.secondary, p.flags], p.ok, dumpDC(p.diffCase), notes, dmn];

function makeCtx(tree: Record<string, string>, platform: number, mainFields: string[] | null, kind: number): any {
  const notes: string[] = [];
  let indent = "";
  const dl = { addNote: (s: string) => { notes.push(indent + s); }, increaseIndent: () => { indent += "  "; }, decreaseIndent: () => { indent = indent.slice(2); } };
  const fsobj = MockFS(tree, MockUnix, "/");
  const log = NewDeferLog(DeferLogKind.DeferLogAll, null);
  const dirInfoCtx: any = { fsObj: fsobj, log, debugLogs: dl, platform, mainFields, preserveSymlinks: false, dirCache: new Map(), pnpManifestWasChecked: true,
    readFile: (path: string) => { const c = tree[path]; return c === undefined ? { contents: "", err: "no such file or directory" } : { contents: c, err: null }; } };
  const ctx: any = { fsObj: fsobj, log, debugLogs: dl, platform, extensionOrder: [".js", ".ts"], dirInfoCtx, mainFields,
    nodeModulesExtensionOrder: [], cssExtensionOrder: [], debugMeta: new DebugMeta(), kind };
  return { ctx, notes, fsobj, dm: ctx.debugMeta, getDmNotes: () => ctx.debugMeta.notes.map((n: any) => n.Text) };
}

function mkDi(fsobj: any, tree: Record<string, string>, path: string, mf: Record<string, any> | null, sourcePath: string): dirInfo {
  const di = new dirInfo(); di.absPath = path; di.entries = fsobj.ReadDirectory(path).dir;
  if (mf !== null) {
    const pj = new packageJSON();
    for (const [k, v] of Object.entries(mf)) {
      const mfObj: any = { relPath: "", keyLoc: { Start: 0 } };
      if (typeof v === "string") mfObj.relPath = v;
      else if (Array.isArray(v)) { mfObj.relPath = v[0]; mfObj.keyLoc = { Start: v[1] }; }
      pj.mainFields.set(k, mfObj);
    }
    pj.source.KeyPath.Text = sourcePath;
    di.packageJSON = pj;
  }
  return di;
}

test("load-dir fixture sha256 + 12 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const name = r.arg.name;
    if (r.fn === "loadAsMainField") {
      const cfg: Record<string, any> = {
        "main-only": { tree: { "/pkg/main.js": "" }, mf: { main: "main.js" }, platform: 1, mfOrder: null, kind: 1 },
        "module-auto-import": { tree: { "/pkg/mod.js": "", "/pkg/main.js": "" }, mf: { module: "mod.js", main: "main.js" }, platform: 1, mfOrder: null, kind: 1 },
        "module-auto-require": { tree: { "/pkg/mod.js": "", "/pkg/main.js": "" }, mf: { module: "mod.js", main: "main.js" }, platform: 1, mfOrder: null, kind: 2 },
        "custom-order": { tree: { "/pkg/feature.js": "", "/pkg/main.js": "" }, mf: { feature: "feature.js", main: "main.js" }, platform: 1, mfOrder: ["feature"], kind: 1 },
        "no-match": { tree: { "/pkg/x.js": "" }, mf: { main: "missing.js" }, platform: 1, mfOrder: null, kind: 1 },
        "no-pj": { tree: { "/pkg/x.js": "" }, mf: null, platform: 1, mfOrder: null, kind: 1 },
      }[name]!;
      const { ctx, notes, fsobj, getDmNotes } = makeCtx(cfg.tree, cfg.platform, cfg.mfOrder, cfg.kind);
      const di = mkDi(fsobj, cfg.tree, "/pkg", cfg.mf, "/pkg/package.json");
      const p = loadAsMainField(ctx, di, "/pkg", [".js", ".ts"]);
      assert.deepEqual(dumpPair(p, notes, getDmNotes()), r.out, `${name}\n got ${JSON.stringify(dumpPair(p, notes, getDmNotes()))}\nwant ${JSON.stringify(r.out)}`);
    } else if (r.fn === "loadAsDirectory") {
      const cfg: Record<string, any> = {
        "dir-main": { tree: { "/pkg/main.js": "" }, mf: { main: "main.js" } },
        "dir-index": { tree: { "/pkg/index.js": "" }, mf: null },
        "dir-empty": { tree: { "/pkg/other.js": "" }, mf: null },
      }[name]!;
      const { ctx, notes, fsobj, getDmNotes } = makeCtx(cfg.tree, 1, null, 1);
      const di = mkDi(fsobj, cfg.tree, "/pkg", cfg.mf, "/pkg/package.json");
      ctx.dirInfoCtx.dirCache.set("/pkg", di);
      const p = loadAsDirectory(ctx, "/pkg");
      assert.deepEqual(dumpPair(p, notes, getDmNotes()), r.out, `${name}\n got ${JSON.stringify(dumpPair(p, notes, getDmNotes()))}\nwant ${JSON.stringify(r.out)}`);
    } else if (r.fn === "loadAsFileOrDirectory") {
      const cfg: Record<string, any> = {
        "fod-file": { tree: { "/pkg/file.js": "" }, path: "/pkg/file" },
        "fod-dir": { tree: { "/pkg/index.js": "" }, path: "/pkg" },
        "fod-miss": { tree: { "/pkg/other.js": "" }, path: "/pkg/miss" },
      }[name]!;
      const { ctx, notes, getDmNotes } = makeCtx(cfg.tree, 1, null, 1);
      const p = loadAsFileOrDirectory(ctx, cfg.path);
      assert.deepEqual(dumpPair(p, notes, getDmNotes()), r.out, `${name}\n got ${JSON.stringify(dumpPair(p, notes, getDmNotes()))}\nwant ${JSON.stringify(r.out)}`);
    }
  }
});
