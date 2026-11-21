// 第 116 轮：ScanBundle 确定性 graph-scan 编排逐字节等于 Go（3 场景，注入 parse/resolve）。
// Go 探针 Go helper 与真实 ScanBundle 输出交叉验证一致；期望 testdata/scanbundle-go.json（SHA a0b5ab4c…）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ScanBundle, type ScanParseResult } from "./bundler.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/scanbundle-go.json", import.meta.url)));
const SHA = "656ad6db0ec38e3ca886a20daf4b361899e5bd533332953f32fb321ce0edb7a3";
const rows = JSON.parse(new TextDecoder().decode(raw)) as any[];

type TC = { name: string; files: Record<string, string>; entries: string[] };
const cases: TC[] = [
  { name: "single", files: { "/p/a.js": "var a=1;" }, entries: ["/p/a.js"] },
  { name: "two", files: { "/p/a.js": "var a=1;", "/p/b.js": "var b=2;" }, entries: ["/p/a.js", "/p/b.js"] },
  { name: "with-import", files: { "/p/a.js": "import {x} from './b.js'; console.log(x);", "/p/b.js": "export const x=1;" }, entries: ["/p/a.js"] },
];

function run(tc: TC): any {
  const parse = (path: string): ScanParseResult => {
    const content = tc.files[path] ?? "";
    const pr: ScanParseResult = { KeyPath: path, Loader: 10, Imports: [] };
    for (const line of content.split(";")) {
      const i = line.indexOf("from '");
      if (i >= 0) {
        const rest = line.slice(i + 6);
        const j = rest.indexOf("'");
        if (j >= 0) pr.Imports.push({ Path: rest.slice(0, j), Kind: "import-statement" });
      }
    }
    return pr;
  };
  const resolve = (imp: string): string => {
    if (imp.startsWith("./")) {
      const r = "/p/" + imp.slice(2);
      if (r in tc.files) return r;
    }
    return "";
  };
  const got = ScanBundle(tc.entries, parse, resolve);
  return {
    name: tc.name,
    files: got.files.map((f) => ({ keyPath: f.keyPath, namespace: f.namespace, loader: f.loader,
      imports: f.imports.map((im) => ({ path: im.path, kind: im.kind, sourceIdx: im.sourceIdx })) })),
    entries: got.entries.map((e) => ({ outputPath: "", sourceIndex: e.sourceIndex, auto: false })),
    errs: [],
  };
}

test("scanbundle 夹具 sha256（3 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("ScanBundle graph-scan 逐字节等于 Go", () => {
  for (let i = 0; i < rows.length; i++) assert.deepEqual(run(cases[i]), rows[i], `scenario ${i}: ${rows[i].name}`);
});
