// 第 165 批：dirInfoCached + dirInfoUncached，Go 探针 11 例逐字节固化（dirInfo 深簇底座）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NewDeferLog, DeferLogKind } from "../logger/logger.ts";
import { MockFS, MockUnix } from "../fs/fs_mock.ts";
import { dirInfo, packageJSON } from "./package_json.ts";
import { dirInfoCached, dirInfoUncached } from "./resolver.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/dirinfo-go.json", import.meta.url)));
const SHA = "3068606c0db76539ff2d914c68f5af0bf616793b3c6376cd51e7822a94d04329";

const treeA: Record<string, string> = {
  "/proj/package.json": `{"name":"root","browser":{"./a":"./b"},"main":"index.js"}`,
  "/proj/src/util.js": "",
  "/proj/node_modules/pkg/package.json": `{"name":"pkg","main":"main.js"}`,
  "/proj/node_modules/pkg/index.js": "",
};
const treeB: Record<string, string> = {
  "/app/package.json": `{"name":"app"}`,
  "/app/lib/a.js": "",
};

function dumpPj(pj: packageJSON | null): any {
  if (pj === null) return null;
  return { name: pj.name, mainFields: [...pj.mainFields.keys()].sort(), hasBrowserMap: pj.browserMap !== null };
}
function dumpDI(info: dirInfo | null): any {
  if (info === null) return null;
  return {
    absPath: info.absPath,
    parentAbs: info.parent ? info.parent.absPath : "",
    scopeAbs: info.enclosingBrowserScope ? info.enclosingBrowserScope.absPath : "",
    absRealPath: info.absRealPath,
    packageJSON: dumpPj(info.packageJSON),
    enclosingPj: info.enclosingPackageJSON ? info.enclosingPackageJSON.source.KeyPath.Text : "",
    pnpManifestAbsPath: info.pnpManifestAbsPath,
    isNodeModules: info.isNodeModules,
    hasNodeModules: info.hasNodeModules,
    isInsideNodeModules: info.isInsideNodeModules,
    entryCount: info.entries.PeekEntryCount(),
  };
}

test("dirinfo fixture sha256 + 11 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const a = r.arg;
    const tree = a.case.startsWith("A") ? treeA : treeB;
    const notes: string[] = [];
    let indent = "";
    const dl = {
      addNote: (s: string) => { notes.push(indent + s); },
      increaseIndent: () => { indent += "  "; },
      decreaseIndent: () => { indent = indent.slice(2); },
    };
    const fsobj = MockFS(tree, MockUnix, "/");
    const ctx: any = {
      fsObj: fsobj,
      log: NewDeferLog(DeferLogKind.DeferLogAll, null),
      debugLogs: dl,
      platform: 1, // PlatformNode
      mainFields: null,
      preserveSymlinks: false,
      dirCache: new Map<string, dirInfo | null>(),
      pnpManifestWasChecked: true,
      readFile: (path: string) => {
        const c = tree[path];
        return c === undefined ? { contents: "", err: "no such file or directory" } : { contents: c, err: null };
      },
    };
    const info = a.fn === "dirInfoCached" ? dirInfoCached(ctx, a.path) : dirInfoUncached(ctx, a.path);
    assert.deepEqual([dumpDI(info), notes], r.out,
      `${a.case} ${a.fn} ${a.path}\n got ${JSON.stringify([dumpDI(info), notes])}\nwant ${JSON.stringify(r.out)}`);
  }
});
