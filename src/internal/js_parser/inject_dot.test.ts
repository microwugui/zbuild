// 第 107 轮：parser.instantiateInjectDotName 逐字节等于 Go（4 场景）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parser } from "./js_parser.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import { Ref, Symbol, SymbolKind } from "../ast/ast.ts";
import { Source, Loc, NewDeferLog, DeferLogKind } from "../logger/logger.ts";
import { Options } from "./js_parser.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/inject-dot-go.json", import.meta.url)));
const SHA = "0b70766dbc124e59b9a0f8a89dbc9c0034ef88aa9d9197a14723f2f5cf027eb5";
const rows = JSON.parse(new TextDecoder().decode(raw)) as any[];

function run(idx: number): any {
  const log = NewDeferLog(DeferLogKind.DeferLogAll, null);
  const src = new Source();
  src.Contents = new TextEncoder().encode("foo.bar");
  src.KeyPath.Text = "main.js"; src.KeyPath.Namespace = "file";
  src.PrettyPaths.Rel = "main.js"; src.PrettyPaths.Abs = "/p/main.js";
  const ref = new Ref(1, 0);
  const p = Object.create(parser.prototype) as parser;
  (p as any).source = src;
  (p as any).log = log;
  (p as any).options = new Options();
  const sym = new Symbol(); sym.Kind = SymbolKind.SymbolOther; sym.OriginalName = "foo";
  (p as any).symbols = [sym];
  (p as any).currentPart = new js_ast.Part();
  (p as any).injectedDefineSymbols = [ref];
  (p as any).injectedSymbolSources = new Map();
  (p as any).tracker = (MakeTracker as any)(src);
  if (idx === 2 || idx === 3) {
    const other = new Source();
    other.Contents = new TextEncoder().encode("export const foo = 1");
    other.KeyPath.Text = "inject.js"; other.KeyPath.Namespace = "file";
    other.PrettyPaths.Rel = "inject.js"; other.PrettyPaths.Abs = "/p/inject.js";
    (p as any).injectedSymbolSources.set("1:0", { source: other, loc: new Loc(13) });
  }
  const assign = idx === 0 ? 0 : idx === 1 ? 1 : idx === 2 ? 1 : 2;
  const expr = p.instantiateInjectDotName(new Loc(0), { parts: ["foo", "bar"], injectedDefineIndex: 0 }, assign);
  const msgs = log.Done().map((m) => ({ text: m.Data.Text, kind: m.Kind, notes: m.Notes.map((n) => n.Text) }));
  return {
    name: rows[idx].name,
    exprRef: `${(expr.Data as js_ast.EIdentifier).Ref.SourceIndex}:${(expr.Data as js_ast.EIdentifier).Ref.InnerIndex}`,
    exprLoc: expr.Loc.Start,
    useCount: sym.UseCountEstimate,
    msgs,
  };
}
// lazy require to avoid import cycle fuss
import { MakeLineColumnTracker as MakeTracker } from "../logger/logger.ts";

test("inject-dot 夹具 sha256（4 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("instantiateInjectDotName 逐字节等于 Go（4 场景）", () => {
  assert.equal(rows.length, 4);
  for (let i = 0; i < rows.length; i++) assert.deepEqual(run(i), rows[i], `scenario ${i}: ${rows[i].name}`);
});
