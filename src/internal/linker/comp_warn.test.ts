// 第 111 轮：linkerContext.validateComposesFromProperties 逐字节等于 Go（2 场景，graph fixture）。
// Go 期望来自 tools/go/tmpgen_compwarn_test.go。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as ast from "../ast/ast.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import { Source, Loc, NewDeferLog, DeferLogKind } from "../logger/logger.ts";
import { LinkerGraph, LinkerFile } from "../graph/graph.ts";
import { InputFile, CSSRepr } from "../graph/input.ts";
import * as css_ast from "../css_ast/css_ast.ts";
import { linkerContext, validateComposesFromProperties } from "./linker.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/compwarn-go.json", import.meta.url)));
const SHA = "d4f70ceb2cf21db2eac4cd2325eab385566cb0000aa931a047567732dc8fbd57";
const rows = JSON.parse(new TextDecoder().decode(raw)) as { name: string; msgs: { kind: number; text: string; notes: string[] }[] }[];

function refKey(r: ast.Ref): string { return `${r.SourceIndex}:${r.InnerIndex}`; }
function symbol(name: string): ast.Symbol { const s = new ast.Symbol(); s.OriginalName = name; s.Link = ast.InvalidRef; return s; }
function mkFile(contents: string, srcIndex: number): { file: LinkerFile; a: any } {
  const f = new LinkerFile();
  f.InputFile = new InputFile();
  const src = new Source();
  (src as any).Index = srcIndex;
  (src as any).Contents = new TextEncoder().encode(contents);
  src.KeyPath.Text = "file.css";
  f.InputFile.Source = src;
  const repr = new CSSRepr();
  f.InputFile.Repr = repr;
  return { file: f, a: repr.AST };
}
function msgs(c: linkerContext): any[] {
  return (c.log as any).Peek().map((m: any) => ({ kind: m.Kind, text: m.Data.Text, notes: m.Notes.map((n: any) => n.Text) }));
}

function run(idx: number): any[] {
  const c = new linkerContext();
  c.graph = new LinkerGraph();
  c.log = NewDeferLog(DeferLogKind.DeferLogAll, new Map());
  const sm = ast.NewSymbolMap(1);
  if (idx === 0) {
    const { file: f0, a: a0 } = mkFile(".a { composes: b from \"./other.css\", c; }\n", 0);
    const { file: f1, a: a1 } = mkFile(".b { color: red }\n", 1);
    c.graph.Files = [f0, f1];
    sm.SymbolsForSource = [[symbol("a")], [symbol("b")]];
    c.graph.Symbols = sm;
    const refA = new ast.Ref(0, 0), refB = new ast.Ref(1, 0);
    a0.LocalSymbols = [{ Loc: new Loc(1), Ref: refA }];
    const rec0 = new js_ast.ImportRecord(); rec0.SourceIndex = 1;
    a0.ImportRecords = [rec0];
    const compA = new css_ast.Composes();
    compA.ImportedNames = [{ Alias: "b", ImportRecordIndex: 0, AliasLoc: 20 as any }];
    compA.Properties = new Map([["color", 5]]);
    a0.Composes = new Map([[refKey(refA), compA]]);
    a1.LocalScope = new Map([["b", { Loc: new Loc(1), Ref: refB }]]);
    const compB = new css_ast.Composes();
    compB.Properties = new Map([["color", 6]]);
    a1.Composes = new Map([[refKey(refB), compB]]);
    validateComposesFromProperties(c, f0, f0.InputFile.Repr as CSSRepr);
  } else {
    const { file: f0, a: a0 } = mkFile(".a { color: red }\n", 0);
    c.graph.Files = [f0];
    sm.SymbolsForSource = [[symbol("a")]];
    c.graph.Symbols = sm;
    const refA = new ast.Ref(0, 0);
    a0.LocalSymbols = [{ Loc: new Loc(1), Ref: refA }];
    const compA = new css_ast.Composes();
    compA.Properties = new Map([["color", 6]]);
    a0.Composes = new Map([[refKey(refA), compA]]);
    validateComposesFromProperties(c, f0, f0.InputFile.Repr as CSSRepr);
  }
  return msgs(c);
}

test("compwarn 夹具 sha256（2 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("validateComposesFromProperties 逐字节等于 Go", () => {
  assert.equal(rows.length, 2);
  for (let i = 0; i < rows.length; i++) {
    assert.deepEqual(run(i), rows[i].msgs, `scenario ${i}: ${rows[i].name}`);
  }
});
