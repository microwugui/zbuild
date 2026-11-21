// 第 92 批：parse-pass part 拆分底座（tree-shaking 下每顶层语句一 part）。
// Go 探针 tools/go/tmpgen_parts_test.bak → testdata/parse-parts-go.json（8 行逐字节）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Options as ParseOptions, Parse } from "./js_parser.ts";
import { Source } from "../runtime/runtime.ts";
import { Source as LoggerSource, Path, PrettyPaths, NewDeferLog, DeferLogKind } from "../logger/logger.ts";
import * as js_ast from "../js_ast/js_ast.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/parse-parts-go.json", import.meta.url)));
const SHA = "c6d268c7ecf7b35f1a977ad73eac20966acd2bfeb7beaae2253f7b533c7c9a45";
const fx = JSON.parse(new TextDecoder().decode(raw)) as { rows: { name: string; data: any }[] };
const by = Object.fromEntries(fx.rows.map((r) => [r.name, r.data]));

function stmtKind(s: js_ast.Stmt): string {
  const d = s.Data;
  if (d instanceof js_ast.SLocal) return "local:" + d.Decls.length;
  if (d instanceof js_ast.SImport) return "import";
  if (d instanceof js_ast.SExportClause) return "export-clause";
  if (d instanceof js_ast.SExportFrom) return "export-from";
  if (d instanceof js_ast.SExportStar) return "export-star";
  if (d instanceof js_ast.SExportEquals) return "export-equals";
  if (d instanceof js_ast.SExpr) return "expr";
  if (d instanceof js_ast.SFunction) return "function";
  if (d instanceof js_ast.SClass) return "class";
  if (d instanceof js_ast.SComment) return "comment";
  if (d instanceof js_ast.SEmpty) return "empty";
  if (d instanceof js_ast.SDirective) return "directive";
  if (d instanceof js_ast.SDebugger) return "debugger";
  if (d instanceof js_ast.SIf) return "if";
  if (d instanceof js_ast.SBlock) return "block";
  if (d instanceof js_ast.SReturn) return "return";
  if (d instanceof js_ast.SThrow) return "throw";
  if (d instanceof js_ast.SWhile) return "while";
  if (d instanceof js_ast.SDoWhile) return "do-while";
  if (d instanceof js_ast.SFor) return "for";
  if (d instanceof js_ast.SForIn) return "for-in";
  if (d instanceof js_ast.SForOf) return "for-of";
  if (d instanceof js_ast.STry) return "try";
  if (d instanceof js_ast.SSwitch) return "switch";
  if (d instanceof js_ast.SEnum) return "enum";
  if (d instanceof js_ast.SLabel) return "label";
  if (d instanceof js_ast.SLazyExport) return "lazy-export";
  return "other";
}

function dumpStructure(a: any): any {
  const partKinds: string[][] = [];
  for (const p of a.Parts) partKinds.push(p.Stmts.map(stmtKind));
  return { numParts: a.Parts.length, partKinds };
}

function testSource(contents: string): LoggerSource {
  const s = new LoggerSource();
  s.Contents = new TextEncoder().encode(contents);
  s.KeyPath = new Path(); s.KeyPath.Text = "<test>"; s.KeyPath.Namespace = "file";
  s.PrettyPaths = new PrettyPaths(); s.PrettyPaths.Abs = "<test>"; s.PrettyPaths.Rel = "<test>";
  return s;
}

function parse(src: LoggerSource, tree: boolean, format: number, mode: number): any {
  const o = new ParseOptions();
  o.treeShaking = tree;
  o.outputFormat = format;
  o.mode = mode;
  const r = Parse(NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null), src, o);
  return { ok: r.ok, ast: r.ok ? dumpStructure(r.ast) : null };
}

test("parse-parts 夹具 sha256（7 行）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("tree-shaking part 拆分：7 组源码结构逐字节等于 Go", () => {
  const cases: Record<string, string> = {
    "single-expr": "var x = 1;",
    "multi-decl": "var a = 1, b = 2, c = 3;",
    "three-stmts": "var a=1;\nlet b=2;\nconst c=3;",
    "import-export": "import x from 'm';\nexport var y = x;",
    "functions": "function f(){return 1}\nfunction g(){return 2}\nvar z=f()+g();",
    "mixed": "var a=1; if(a) b(); for(var i=0;i<2;i++){} debugger;",
  };
  const params: Record<string, [boolean, number, number]> = {
    "single-expr": [true, 0, 0], "multi-decl": [true, 0, 0], "three-stmts": [true, 0, 0],
    "import-export": [true, 3, 2], "functions": [true, 0, 0], "mixed": [true, 0, 0],
  };
  for (const [name, src] of Object.entries(cases)) {
    const [tree, fmt, mode] = params[name];
    assert.deepEqual(parse(testSource(src), tree, fmt, mode), by[name], `case ${name}`);
  }
  // runtime-esnext：Source(0) + treeShaking + ModeBundle
  assert.deepEqual(parse(Source(0n), true, 0, 2), by["runtime-esnext"], "runtime-esnext");
});
