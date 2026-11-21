// 第 161 批：checkBrowserMap，Go 探针 11 例逐字节固化（dirInfo + packageJSON.browserMap 底座）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { realFS } from "../fs/fs_real.ts";
import { checkBrowserMap, dirInfo, packageJSON, absolutePathKind, packagePathKind } from "./package_json.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/browser-map-go.json", import.meta.url)));
const SHA = "9f6a0a9a509a5a67f52d66aeb801c0ea84b92e63fa88df33f9e3a4ce9dcf4f7b";

test("browser-map fixture sha256 + 11 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const a = r.arg;
    const notes: string[] = [];
    const dl = { addNote: (s: string) => { notes.push(s); } };
    let scope: dirInfo | null = null;
    if (a.hasScope) {
      const pj = new packageJSON();
      pj.source.KeyPath.Text = a.scopeAbs + "/package.json";
      pj.browserMap = new Map<string, string | null>();
      for (const [k, v] of Object.entries(a.browserMap ?? {})) pj.browserMap.set(k, v as string | null);
      scope = new dirInfo();
      scope.absPath = a.scopeAbs;
      scope.packageJSON = pj;
    }
    const dir = new dirInfo();
    dir.absPath = a.dirAbs;
    dir.enclosingBrowserScope = scope;
    dir.isNodeModules = a.parentNodeModules;
    if (scope !== null) dir.parent = scope;
    const ctx: any = {
      platform: a.platform,
      extensionOrder: a.extOrder ?? [],
      fsObj: new realFS(false, "/"),
      debugLogs: dl,
    };
    const got = checkBrowserMap(ctx, dir, a.inputPath, a.kind);
    assert.deepEqual([got.remapped, got.ok, notes], r.out, `case: ${a.name}\n got: ${JSON.stringify([got.remapped, got.ok, notes])}\nwant: ${JSON.stringify(r.out)}`);
  }
});
