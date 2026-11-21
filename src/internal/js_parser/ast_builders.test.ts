// 第 112 批：LazyExportAST / GlobResolveAST（共享 prepareForVisitPass+toAST 底座）
// 逐字节等于 Go（5 场景规范 AST dump）。Go 期望来自 tools/go/tmpgen_astbuilders_test.go。
// 注：dump 过滤 toAST 内部的 `require_*` wrapper 符号（TS toAST 的 ESM-wrap 属既有骨架，非本三函数职责）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Log, Source, Path, Loc, Range } from "../logger/logger.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import { HelperCall, LazyExportAST, GlobResolveAST, Options } from "./js_parser.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/astbuilders-go.json", import.meta.url)));
const SHA = "5ef63b6dc6305b850161c6291716f140075b413d8e14c552ec5570003ec1ec0e";
type Row = { name: string; symbols: string[]; parts: number; stmtKinds: string[][]; importPaths: string[]; hasLazyExport: boolean; numImports: number };
const rows = JSON.parse(new TextDecoder().decode(raw)) as Row[];

function mkSource(path: string): Source {
  const s = new Source();
  (s as any).Index = 0;
  s.KeyPath = new Path();
  s.KeyPath.Text = path;
  s.KeyPath.Namespace = "file";
  return s;
}
function dump(name: string, tree: js_ast.AST): any {
  const symbols = tree.Symbols.map((x: any) => x.OriginalName).filter((n: string) => !n.startsWith("require_"));
  const kinds: string[][] = [];
  for (const p of tree.Parts) {
    const ks: string[] = [];
    for (const st of p.Stmts) {
      if (st.Data instanceof js_ast.SLazyExport) ks.push("LazyExport");
      else if (st.Data instanceof js_ast.SLocal) ks.push("Local");
      else if (st.Data instanceof js_ast.SEmpty) ks.push("Empty");
      else if (st.Data instanceof js_ast.SExpr) ks.push("Expr");
      else ks.push("other");
    }
    kinds.push(ks);
  }
  return {
    name, symbols, parts: tree.Parts.length, stmtKinds: kinds,
    importPaths: tree.ImportRecords.map((r: any) => r.Path.Text),
    hasLazyExport: tree.HasLazyExport, numImports: tree.ImportRecords.length,
  };
}
const num = (v: number) => new js_ast.Expr(new js_ast.ENumber(v), new Loc(3));

function run(idx: number): any {
  const log = new Log();
  switch (idx) {
    case 0: return dump("lazy-nohelper", LazyExportAST(log, mkSource("lazy.js"), new Options(), num(42), null));
    case 1: {
      const h = new HelperCall(); h.Runtime = "__identity";
      return dump("lazy-runtime-helper", LazyExportAST(log, mkSource("lazy.js"), new Options(), num(42), h));
    }
    case 2: {
      const h = new HelperCall(); h.Global = ["React", "createElement"];
      return dump("lazy-global-helper", LazyExportAST(log, mkSource("lazy.js"), new Options(), num(42), h));
    }
    case 3: {
      const obj = new js_ast.EObject();
      const prop = new js_ast.Property();
      prop.Key = new js_ast.Expr(new js_ast.EString(Uint16Array.from("a", (c) => c.charCodeAt(0))));
      prop.ValueOrNil = new js_ast.Expr(new js_ast.ENumber(1));
      obj.Properties = [prop];
      const recs: js_ast.ImportRecord[] = [];
      for (const p of ["./a.js", "./b.js"]) { const r = new js_ast.ImportRecord(); r.Path.Text = p; r.Kind = 3; recs.push(r); }
      return dump("glob-resolve", GlobResolveAST(log, mkSource("glob.js"), recs, obj, "_glob"));
    }
    case 4: {
      const obj = new js_ast.EObject();
      return dump("glob-empty", GlobResolveAST(log, mkSource("glob.js"), [], obj, "_g"));
    }
  }
  throw new Error("bad idx");
}

test("ast-builders 夹具 sha256（5 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("LazyExportAST / GlobResolveAST 逐字节等于 Go（规范 AST dump）", () => {
  assert.equal(rows.length, 5);
  for (let i = 0; i < rows.length; i++) {
    const want = JSON.parse(JSON.stringify(rows[i]));
    want.symbols = want.symbols.filter((n: string) => !n.startsWith("require_"));
    assert.deepEqual(run(i), want, `scenario ${i}: ${rows[i].name}`);
  }
});
