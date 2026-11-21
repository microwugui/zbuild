// 第 151 批：chunk 生成链纯助手底座 5 函数，Go 探针 13 例逐字节。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as ast from "../ast/ast.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import * as css_ast from "../css_ast/css_ast.ts";
import { Source, Path, Log, Loc, NewDeferLog, DeferLogKind } from "../logger/logger.ts";
import { InputFile, JSRepr } from "../graph/input.ts";
import { LinkerFile, LinkerGraph } from "../graph/graph.ts";
import { Joiner } from "../helpers/joiner.ts";
import { linkerContext, chunkInfo } from "./linker.ts";
import { requireOrImportMetaForSource, maybeAppendLegalComments, wrapRulesWithConditions,
  generateExtraDataForFileJS, maybeForbidArbitraryModuleNamespaceIdentifier } from "./linker.ts";
import { LegalComments } from "../config/config.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/gen-helpers-go.json", import.meta.url)));
const SHA = "a0e0bf3320c86ffeaced7f0fc5dd5368556575c75010fbe17e15cf2f54059395";
const enc = new TextEncoder();
const dec = new TextDecoder();

function ref(s: number, i: number): ast.Ref { return new ast.Ref(s, i); }
function mkFile(path: string, ns: string, contents = ""): LinkerFile {
  const f = new LinkerFile();
  f.InputFile = new InputFile();
  const src = new Source(); src.KeyPath = new Path(); src.KeyPath.Text = path; src.KeyPath.Namespace = ns;
  src.Contents = enc.encode(contents);
  f.InputFile.Source = src;
  return f;
}
function ctxWithFiles(n: number): linkerContext {
  const c = new linkerContext();
  c.graph = new LinkerGraph();
  c.graph.Files = new Array(n).fill(null).map(() => new LinkerFile());
  return c;
}
function cond(supports: string, layers: string, media: number): css_ast.ImportConditions {
  const c = new css_ast.ImportConditions();
  if (layers) { const t = new css_ast.Token(); t.Kind = 29; t.Text = layers; c.Layers = [t]; }
  if (supports) { const t = new css_ast.Token(); t.Kind = 29; t.Text = supports; c.Supports = [t]; }
  for (let i = 0; i < media; i++) { const mq = new css_ast.MediaQuery(); mq.Data = new css_ast.MQPlainOrBoolean(); (mq.Data as any).Name = "screen"; c.Queries.push(mq); }
  return c;
}
function tokDump(t: css_ast.Token): any { return [t.Kind, t.Text, t.Children ? t.Children.map(tokDump) : null]; }
function rulesDump(rs: css_ast.Rule[]): any {
  return rs.map((r) => {
    const d = r.Data as any;
    if (d instanceof css_ast.RKnownAt) return ["known", d.AtToken, d.Prelude.map(tokDump), rulesDump(d.Rules)];
    if (d instanceof css_ast.RAtMedia) return ["media", d.Queries.length, rulesDump(d.Rules)];
    if (d instanceof css_ast.RAtLayer) return ["layer", d.Names, rulesDump(d.Rules)];
    if (d instanceof css_ast.RAtImport) return ["import", d.ImportRecordIndex];
    return ["other"];
  });
}
const jstr = (j: Joiner): string => dec.decode(j.Done());

const ROWS: { fn: string; arg: any; run: () => any }[] = [];
// requireOrImportMetaForSource x3
for (const wrap of [0, 2, 1]) {
  ROWS.push({ fn: "requireOrImportMetaForSource", arg: { wrap }, run: () => {
    const c = ctxWithFiles(1);
    const repr = new JSRepr(); repr.AST.WrapperRef = ref(0, 7); repr.AST.ExportsRef = ref(0, 9);
    repr.Meta.Wrap = wrap; repr.Meta.IsAsyncOrHasAsyncDependency = wrap === 1;
    (c.graph.Files[0].InputFile as any).Repr = repr;
    const m = requireOrImportMetaForSource(c, 0);
    return { wrapper: [m.WrapperRef.SourceIndex, m.WrapperRef.InnerIndex], exports: [m.ExportsRef.SourceIndex, m.ExportsRef.InnerIndex],
      validExports: (m.ExportsRef.SourceIndex !== 0 || m.ExportsRef.InnerIndex !== 0), async: m.IsWrapperAsync };
  }});
}
// maybeAppendLegalComments x4
for (const mode of [LegalComments.LegalCommentsNone, LegalComments.LegalCommentsEndOfFile,
  LegalComments.LegalCommentsLinkedWithComment, LegalComments.LegalCommentsExternalWithoutComment]) {
  ROWS.push({ fn: "maybeAppendLegalComments", arg: { mode }, run: () => {
    const c = ctxWithFiles(3);
    c.graph.Files[0].InputFile.Source = mkFile("/p/a.js", "file").InputFile.Source;
    c.graph.Files[1].InputFile.Source = mkFile("/p/node_modules/pkg/lib.js", "file").InputFile.Source;
    c.graph.Files[2].InputFile.Source = mkFile("dataurl:xxx", "dataurl").InputFile.Source;
    const list = [
      { sourceIndex: 0, comments: ["/*! first */", "// second"] },
      { sourceIndex: 1, comments: ["/*! pkg lic */"] },
      { sourceIndex: 2, comments: ["/*! dataurl */"] },
      { sourceIndex: 0, comments: ["/*! first */"] },
    ];
    const ch = new chunkInfo(); const j = new Joiner();
    maybeAppendLegalComments(c, mode, list, ch, j, "/script");
    return { joiner: jstr(j), external: dec.decode(ch.externalLegalComments) };
  }});
}
// wrapRulesWithConditions x2
ROWS.push({ fn: "wrapRulesWithConditions", arg: { case: "chain" }, run: () => {
  const rk = new css_ast.RAtLayer(); rk.Names = [["base"]];
  const base: css_ast.Rule[] = [new css_ast.Rule()]; base[0].Data = rk;
  const [rules, recs] = wrapRulesWithConditions(base, [], [cond("grid", "foo", 1), cond("", "", 0)], []);
  return { rules: rulesDump(rules), recCount: recs.length };
}});
ROWS.push({ fn: "wrapRulesWithConditions", arg: { case: "empty-layer" }, run: () => {
  const [rules, recs] = wrapRulesWithConditions([], [], [cond("", "empty", 0)], []);
  return { rules: rulesDump(rules), recCount: recs.length };
}});
// generateExtraDataForFileJS x1
ROWS.push({ fn: "generateExtraDataForFileJS", arg: {}, run: () => {
  const c = ctxWithFiles(1);
  const repr = new JSRepr(); repr.AST.Parts = [new js_ast.Part()]; repr.AST.ModuleScope = new js_ast.Scope();
  (c.graph.Files[0].InputFile as any).Repr = repr;
  return generateExtraDataForFileJS(c, 0);
}});
// maybeForbid x3
for (const alias of ["validName", "not valid", "123bad"]) {
  ROWS.push({ fn: "maybeForbidArbitraryModuleNamespaceIdentifier", arg: { alias }, run: () => {
    const c = ctxWithFiles(1);
    c.log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, new Map());
    c.options = { OriginalTargetEnv: "es2020" };
    c.graph.Files[0].InputFile.Source = mkFile("/p/a.js", "file", "x").InputFile.Source;
    maybeForbidArbitraryModuleNamespaceIdentifier(c, "import", 0, 0, alias);
    return (c.log!.Done()).map((m: any) => m.Data.Text);
  }});
}

test("gen-helpers fixture sha256 + 13 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(dec.decode(bytes));
  assert.equal(rows.length, ROWS.length);
  for (let i = 0; i < rows.length; i++) {
    assert.equal(ROWS[i].fn, rows[i].fn);
    assert.deepEqual(ROWS[i].arg, rows[i].arg, `arg@${i}`);
    assert.deepEqual(ROWS[i].run(), rows[i].out, `${rows[i].fn} ${JSON.stringify(rows[i].arg)} mismatch`);
  }
});
