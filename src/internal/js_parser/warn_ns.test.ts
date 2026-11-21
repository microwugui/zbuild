// 第 107 轮：parser.warnAboutImportNamespaceCall 逐字节等于 Go（5 场景状态机）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parser, Options } from "./js_parser.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import { Ref, Symbol, SymbolKind } from "../ast/ast.ts";
import { Source, Loc, NewDeferLog, DeferLogKind, MakeLineColumnTracker } from "../logger/logger.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/warn-ns-go.json", import.meta.url)));
const SHA = "8be2a46cf61c3527bc734cb9c15abd041b1a1ce47b732312afa6cd9e26d3e88e";
const rows = JSON.parse(new TextDecoder().decode(raw)) as any[];

function run(idx: number): any {
  const log = NewDeferLog(DeferLogKind.DeferLogAll, null);
  const src = new Source();
  src.Contents = new TextEncoder().encode("import * as ns from 'x'; ns(); new ns();");
  src.KeyPath.Text = "main.js"; src.KeyPath.Namespace = "file";
  src.PrettyPaths.Rel = "main.js"; src.PrettyPaths.Abs = "/p/main.js";
  const p = Object.create(parser.prototype) as parser;
  (p as any).source = src;
  (p as any).log = log;
  (p as any).tracker = MakeLineColumnTracker(src);
  const sym = new Symbol(); sym.Kind = SymbolKind.SymbolOther; sym.OriginalName = "ns";
  (p as any).symbols = [sym];
  (p as any).moduleScope = new js_ast.Scope();
  const o = new Options();
  o.outputFormat = idx === 0 ? 0 : 3; // FormatPreserve / ESModule
  (p as any).options = o;
  const ref = new Ref(1, 0);
  (p as any).importItemsForNamespace = new Map([[ "1:0", { entries: new Map([["foo", {}]]) } ]]);
  (p as any).importNamespaceCCMap = null;
  const kind = idx === 0 ? 0 : idx === 1 ? 0 : idx === 2 ? 1 : idx === 3 ? 2 : 0;
  if (idx === 4) (p as any).importNamespaceCCMap = new Map([["1:0|0", true]]);
  const target = new js_ast.Expr(new js_ast.EIdentifier(ref), new Loc(29));
  p.warnAboutImportNamespaceCall(target, kind);
  const msgs = log.Done().map((m) => ({ id: m.ID, kind: m.Kind, text: m.Data.Text, notes: m.Notes.map((n) => n.Text) }));
  return { name: rows[idx].name, msgs, mapSize: ((p as any).importNamespaceCCMap as Map<any, any> | null)?.size ?? 0 };
}

test("warn-ns 夹具 sha256（5 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("warnAboutImportNamespaceCall 逐字节等于 Go（5 场景）", () => {
  assert.equal(rows.length, 5);
  for (let i = 0; i < rows.length; i++) assert.deepEqual(run(i), rows[i], `scenario ${i}: ${rows[i].name}`);
});
