// 第 82 轮：css_printer 整条 Print 链差分（Go 探针固化 testdata/css-print-go.json）。
// 构造与 Go 探针 tmpgen_print_test.go 完全相同的 AST，逐例比对打印字节。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { CSSAST, Rule, Token, T, RAtCharset, RAtImport, RAtKeyframes, RKnownAt, RUnknownAt, RSelector, RDeclaration, RComment, RAtLayer, RAtMedia, MediaQuery, MQPlainOrBoolean, ComplexSelector, CompoundSelector, NamespacedName, NameToken, SubclassSelector, SSClass, SSHash, SSAttribute, SSPseudoClass } from "../css_ast/css_ast.ts";
import { SymbolMap, Symbol, InvalidRef, Ref, LocRef } from "../ast/ast.ts";
import { Loc } from "../logger/logger.ts";
import { Print } from "./css_printer.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/css-print-go.json", import.meta.url)));
const SHA = "4e9256a55d273d96053931a1418dc40a70babdd65589eaefd5df0f28b6f44147";

const tok = (kind: number, text: string): Token => {
  const t = new Token(); t.Kind = kind; t.Text = text;
  if (kind === T.TDimension) t.UnitOffset = text.length - 2;
  if (kind === T.TPercentage) t.UnitOffset = text.length - 1;
  return t;
};
const tokWs = (kind: number, text: string, ws: number): Token => { const t = tok(kind, text); t.Whitespace = ws; return t; };
const ident = (text: string): Token => tok(T.TIdent, text);
const decl = (key: string, val: Token[], important: boolean): Rule => {
  const r = new Rule(); const d = new RDeclaration();
  d.KeyText = key; d.Value = val; d.Important = important; r.Data = d; return r;
};
const cp = (text: string): CompoundSelector => {
  const c = new CompoundSelector(); const n = new NamespacedName(); const nt = new NameToken();
  nt.Text = text; nt.Kind = T.TIdent; n.Name = nt; c.TypeSelector = n; return c;
};
const syms = new SymbolMap([[0, 1, 2].map((i) => {
  const s = new Symbol(); s.OriginalName = ["cls", "id", "keyframe"][i]; s.Link = InvalidRef; return s;
})]);

const rules1 = [decl("color", [ident("red")], false), decl("width", [tok(T.TDimension, "10px")], true), decl("margin", [tok(T.TNumber, "0")], false)];
const selRule = new Rule();
{
  const s = new RSelector();
  const c = new ComplexSelector(); c.Selectors = [cp("div"), cp("span")]; s.Selectors = [c];
  s.Rules = [decl("color", [ident("blue")], false)]; selRule.Data = s;
}
const fn = tok(T.TFunction, "rgb(");
fn.Children = [tok(T.TNumber, "1"), tokWs(T.TComma, ",", 2), tok(T.TNumber, "2")];
const supports = new Rule(); { const d = new RKnownAt(); d.AtToken = "supports"; d.Rules = [decl("display", [ident("grid")], false)]; supports.Data = d; }
const unk = new Rule(); { const d = new RUnknownAt(); d.AtToken = "foo"; d.Prelude = [ident("bar")]; unk.Data = d; }
const layer = new Rule(); { const d = new RAtLayer(); d.Names = [["a", "b"]]; layer.Data = d; }
const media = new Rule();
{
  const d = new RAtMedia(); const q = new MediaQuery(); const pq = new MQPlainOrBoolean();
  pq.Name = "color"; pq.ValueOrNil = [ident("red")]; q.Data = pq; d.Queries = [q];
  d.Rules = [decl("x", [ident("y")], false)]; media.Data = d;
}
const comm = new Rule(); { const d = new RComment(); d.Text = "hello"; comm.Data = d; }
const cls = new CompoundSelector();
{
  const c1 = new SubclassSelector(new SSClass()); (c1.Data as SSClass).Name = new LocRef(new Loc(0), new Ref(0, 0));
  const c2 = new SubclassSelector(new SSPseudoClass()); (c2.Data as SSPseudoClass).Name = "before"; (c2.Data as SSPseudoClass).IsElement = true;
  cls.SubclassSelectors = [c1, c2];
}
const selRule2 = new Rule();
{
  const s = new RSelector(); const c = new ComplexSelector(); c.Selectors = [cls]; s.Selectors = [c];
  s.Rules = [decl("content", [tok(T.TString, "x")], false)]; selRule2.Data = s;
}
const hcls = new CompoundSelector();
{
  const h = new SubclassSelector(new SSHash()); (h.Data as any).Name = new LocRef(new Loc(0), new Ref(0, 1));
  const at = new SubclassSelector(new SSAttribute());
  const n = new NamespacedName(); const nt = new NameToken(); nt.Text = "foo"; nt.Kind = T.TIdent; n.Name = nt;
  (at.Data as SSAttribute).NamespacedName = n; (at.Data as SSAttribute).MatcherOp = "=";
  hcls.SubclassSelectors = [h, at];
}
const selRule3 = new Rule();
{
  const s = new RSelector(); const c = new ComplexSelector(); c.Selectors = [hcls]; s.Selectors = [c];
  s.Rules = [decl("a", [ident("b")], false)]; selRule3.Data = s;
}
const imp = new Rule(); { const d = new RAtImport(); d.ImportRecordIndex = 0; imp.Data = d; }

const CASES: Record<string, { rules: Rule[]; minify: boolean; records?: any[]; meta?: boolean }> = {
  decls: { rules: rules1, minify: false }, "decls-min": { rules: rules1, minify: true },
  selector: { rules: [selRule], minify: false }, "selector-min": { rules: [selRule], minify: true },
  charset: { rules: [new Rule()], minify: false },
  function: { rules: [decl("color", [fn], false)], minify: false },
  knownat: { rules: [supports], minify: false }, unknownat: { rules: [unk], minify: false },
  layer: { rules: [layer], minify: false }, media: { rules: [media], minify: false },
  comment: { rules: [comm], minify: false }, pseudo: { rules: [selRule2], minify: false },
  hashattr: { rules: [selRule3], minify: false },
  "import-meta": { rules: [imp], minify: false, records: [{ Path: { Text: "x.css" }, Flags: 0 }], meta: true },
};
// charset case special
{
  const c = new RAtCharset(); c.Encoding = "UTF-8"; const r = new Rule(); r.Data = c; CASES.charset.rules = [r];
}

type Row = { name: string; minify: boolean; css: string };
const rows: Row[] = JSON.parse(new TextDecoder().decode(raw));

test("css-print fixture sha256 + 14 组 CSS 打印逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA, "css-print fixture sha256");
  for (const r of rows) {
    const c = CASES[r.name];
    assert.ok(c, `case ${r.name} exists`);
    const tree = new CSSAST();
    tree.Rules = c.rules;
    tree.ImportRecords = c.records ?? [];
    const out = Print(tree, syms, { minifyWhitespace: r.minify, needsMetafile: !!c.meta });
    const got = Buffer.from(out.CSS).toString("base64");
    assert.equal(got, r.css, `Print(${r.name})`);
  }
  assert.equal(rows.length, 14);
});
