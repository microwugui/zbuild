// 第 112 批：generateResultForGlobResolve（外部 resolveResults 子集）逐字节等于 Go（4 场景）。
// Go 期望来自 tools/go/tmpgen_globresult_test.go。依赖 GlobResolveAST 底座。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { generateResultForGlobResolve } from "./bundler.ts";
import { MockFS, MockUnix } from "../fs/fs_mock.ts";
import { NewDeferLog, DeferLogKind, Source, Path, Loc } from "../logger/logger.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import { ImportKind } from "../ast/ast.ts";
import { JSRepr } from "../graph/input.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/globresult-go.json", import.meta.url)));
const SHA = "6ab66465fac9bcd8add412aa598b6ab72f49c94571740d2aba4243d129d36473";
type Row = { name: string; ok: boolean; symbols: string[]; parts: number; stmts: string[][]; importPaths: string[] };
const rows = JSON.parse(new TextDecoder().decode(raw)) as Row[];

function ext(path: string): any {
  const primary = new Path(); primary.Text = path; primary.Namespace = "file";
  const pp: any = { Primary: primary, IsExternal: true };
  return { PathPair: pp };
}
function run(idx: number): any {
  const s = { fs: MockFS({}, MockUnix, "/"), log: NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, new Map()), options: { AbsOutputDir: "/out" } };
  const src = new Source(); src.KeyPath = new Path(); src.KeyPath.Text = "glob.js";
  let results: Map<string, any>;
  let alias: string;
  let kind: number = ImportKind.ImportDynamic;
  switch (idx) {
    case 0: results = new Map([["./a.js", ext("./a.js")]]); alias = "_glob"; break;
    case 1: results = new Map([["./z.js", ext("./z.js")], ["./a.js", ext("./a.js")]]); alias = "_g"; break;
    case 2: results = new Map([["./a.js", ext("./a.js")]]); alias = "_glob"; kind = ImportKind.ImportRequire; break;
    default: results = new Map(); alias = "_g"; break;
  }
  const pr = generateResultForGlobResolve(s, 0, "glob.js", src, new Loc(0), null, kind, 0,
    { resolveResults: results, exportAlias: alias }, null);
  const tree = (pr.file.inputFile.Repr as JSRepr).AST;
  const symbols = tree.Symbols.map((x: any) => x.OriginalName).filter((n: string) => !n.startsWith("require_"));
  const stmts: string[][] = [];
  for (const part of tree.Parts) {
    const ks: string[] = [];
    for (const st of part.Stmts) {
      if (st.Data instanceof js_ast.SLocal) ks.push("Local");
      else if (st.Data instanceof js_ast.SEmpty) ks.push("Empty");
      else ks.push("other");
    }
    stmts.push(ks);
  }
  return {
    name: rows[idx].name, ok: pr.ok, symbols, parts: tree.Parts.length, stmts,
    importPaths: tree.ImportRecords.map((r: any) => r.Path.Text),
  };
}

test("globresult 夹具 sha256（4 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("generateResultForGlobResolve 逐字节等于 Go", () => {
  assert.equal(rows.length, 4);
  for (let i = 0; i < rows.length; i++) {
    const want = JSON.parse(JSON.stringify(rows[i]));
    want.symbols = want.symbols.filter((n: string) => !n.startsWith("require_"));
    assert.deepEqual(run(i), want, `scenario ${i}: ${rows[i].name}`);
  }
});
