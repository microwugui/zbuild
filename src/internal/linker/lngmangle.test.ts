// 第 178 批：mangleProps / mangleLocalCSS，Go 探针 5 例逐字节固化。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as ast from "../ast/ast.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import * as css_ast from "../css_ast/css_ast.ts";
import * as graph from "../graph/graph.ts";
import { JSRepr, CSSRepr, InputFile, EntryPoint, ExportData, ImportData } from "../graph/input.ts";
import { NewDeferLog, DeferLogKind } from "../logger/logger.ts";
import { linkerContext } from "./linker.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/lngmangle-go.json", import.meta.url)));
const SHA = "173b4fd6a2d035063d517483a3ca2b60d9ea3436d2547b1e67338c86e3eb0c36";

function build(n: number): linkerContext {
  const c = new linkerContext();
  const inputs: InputFile[] = [];
  for (let si = 0; si < n; si++) {
    const f = new InputFile();
    f.Source.IdentifierName = `f${si}`;
    inputs.push(f);
  }
  const reachable = inputs.map((_, i) => i);
  c.graph = graph.CloneLinkerGraph(inputs, reachable, [], false);
  c.graph.Symbols.SymbolsForSource[0] = [sym("runtime")];
  c.options = {};
  c.log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null);
  return c;
}
function sym(name: string, opts: { count?: number; kind?: number } = {}): ast.Symbol {
  const s = new ast.Symbol();
  s.OriginalName = name; s.Link = ast.InvalidRef;
  if (opts.count !== undefined) s.UseCountEstimate = opts.count;
  if (opts.kind !== undefined) s.Kind = opts.kind;
  return s;
}
function dumpMangled(c: linkerContext): any[] {
  const m = c.mangledProps as Map<string, string>;
  return [...m.keys()].sort().map((k) => [k, m.get(k)]);
}
function dumpCache(cache: Map<string, any> | Set<string>): any {
  const o: Record<string, any> = {};
  if (cache instanceof Set) { for (const k of [...cache].sort()) o[k] = true; return o; }
  for (const k of [...cache.keys()].sort()) o[k] = cache.get(k);
  return o;
}

test("lngmangle fixture sha256 + 5 例逐字节等于 Go（mangleProps/mangleLocalCSS）", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const a = r.arg;
    let got: any;
    if (r.fn === "mangleProps") {
      const c = build(2);
      if (a.name === "basic") {
        c.graph.Symbols.SymbolsForSource[1] = [sym("runtime"), sym("foo", { count: 5 }), sym("bar", { count: 3 })];
        const repr = new JSRepr();
        repr.AST.MangledProps = new Map([["foo", new ast.Ref(1, 1)], ["bar", new ast.Ref(1, 2)]]);
        repr.AST.ReservedProps = new Set(["baz"]);
        c.graph.Files[1].InputFile.Repr = repr;
        const cache = new Map<string, any>([["keep", false]]);
        c.mangleProps(cache);
        got = [dumpMangled(c), dumpCache(cache)];
      } else if (a.name === "cache-pin") {
        c.graph.Symbols.SymbolsForSource[1] = [sym("runtime"), sym("foo", { count: 9 })];
        const repr = new JSRepr();
        repr.AST.MangledProps = new Map([["foo", new ast.Ref(1, 1)]]);
        c.graph.Files[1].InputFile.Repr = repr;
        const cache = new Map<string, any>([["foo", "X"]]);
        c.mangleProps(cache);
        got = [dumpMangled(c), dumpCache(cache)];
      } else {
        c.graph.Symbols.SymbolsForSource[1] = [sym("runtime"), sym("default", { count: 2 })];
        const repr = new JSRepr();
        repr.AST.MangledProps = new Map([["default", new ast.Ref(1, 1)]]);
        c.graph.Files[1].InputFile.Repr = repr;
        const cache = new Map<string, any>();
        c.mangleProps(cache);
        got = [dumpMangled(c), dumpCache(cache)];
      }
    } else if (r.fn === "mangleLocalCSS") {
      const c = build(2);
      c.mangledProps = new Map();
      if (a.name === "nonmin") {
        c.options.MinifyIdentifiers = false;
        c.graph.Symbols.SymbolsForSource[1] = [
          sym("runtime"), sym("g", { kind: ast.SymbolKind.SymbolGlobalCSS }),
          sym("a", { kind: ast.SymbolKind.SymbolLocalCSS }), sym("b", { kind: ast.SymbolKind.SymbolLocalCSS }),
        ];
        c.graph.Files[1].InputFile.Repr = new CSSRepr();
        const used = new Set(["a_f0"]);
        c.mangleLocalCSS(used);
        got = [dumpMangled(c), dumpCache(used)];
      } else {
        c.options.MinifyIdentifiers = true;
        c.graph.Symbols.SymbolsForSource[1] = [
          sym("runtime"), sym("a", { kind: ast.SymbolKind.SymbolLocalCSS }), sym("b", { kind: ast.SymbolKind.SymbolLocalCSS }),
        ];
        c.graph.Files[1].InputFile.Repr = new CSSRepr();
        const used = new Set<string>();
        c.mangleLocalCSS(used);
        got = [dumpMangled(c), dumpCache(used)];
      }
    } else throw new Error(`unknown fn ${r.fn}`);
    assert.deepEqual(got, r.out, `${r.fn}/${a.name}\n got ${JSON.stringify(got)}\nwant ${JSON.stringify(r.out)}`);
  }
});
