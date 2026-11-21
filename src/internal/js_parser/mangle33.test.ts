// 第 33 轮：G-3 mangle 族的浅依赖函数 —— 直调执行覆盖 + 语义断言。
import test from "node:test";
import assert from "node:assert/strict";
import * as js_ast from "../js_ast/js_ast.ts";
import { Loc, Log, Path, Source } from "../logger/logger.ts";
import { newParser, Options, type parser } from "./js_parser.ts";
import { Lexer } from "../js_lexer/js_lexer.ts";

function makeParser(): parser {
  const log = new Log();
  const source = new Source();
  source.Index = 0;
  source.Contents = new Uint8Array(0);
  source.KeyPath = new Path();
  source.KeyPath.Text = "<stdin>";
  const options = new Options();
  return newParser(log, source, Lexer.NewLexer(log, source, options.ts), options);
}

const stmt = (data: js_ast.S, loc = 0): js_ast.Stmt => new js_ast.Stmt(data, new Loc(loc));
function initBlock(stmts: js_ast.Stmt[]): js_ast.SBlock {
  const b = new js_ast.SBlock();
  b.Stmts = stmts;
  return b;
}

test("G-33：appendIfOrLabelBodyPreservingScope 三种路径", () => {
  const p = makeParser();
  const block = stmt(initBlock([stmt(new js_ast.SEmpty())]));
  const out1 = p.appendIfOrLabelBodyPreservingScope([], block);
  assert.equal(out1.length, 1);
  assert.ok(out1[0].Data instanceof js_ast.SEmpty);
  const fn = new js_ast.SFunction();
  fn.Fn = new js_ast.Fn();
  const out2 = p.appendIfOrLabelBodyPreservingScope([], stmt(fn));
  assert.equal(out2.length, 1);
  const out3 = p.appendIfOrLabelBodyPreservingScope([], stmt(new js_ast.SExpr()));
  assert.equal(out3.length, 1);
  assert.ok(out3[0].Data instanceof js_ast.SExpr);
});

test("G-33：mangleFor 的 break 折叠", () => {
  const p = makeParser();
  const sfor = new js_ast.SFor();
  const iff = new js_ast.SIf();
  iff.Test = new js_ast.Expr(new js_ast.EBoolean(true), new Loc(0));
  iff.Yes = stmt(new js_ast.SBreak());
  sfor.Body = stmt(iff);
  sfor.TestOrNil = null;
  p.mangleFor(sfor);
  assert.ok(sfor.TestOrNil !== null && sfor.TestOrNil.Data !== null);
});

test("G-33：maybeTransposeIfExprChain 递归访问叶子", () => {
  const p = makeParser();
  const leaf = new js_ast.Expr(new js_ast.ENumber(1), new Loc(0));
  const iff = new js_ast.EIf();
  iff.Test = new js_ast.Expr(new js_ast.EBoolean(true), new Loc(0));
  iff.Yes = leaf;
  iff.No = new js_ast.Expr(new js_ast.ENumber(2), new Loc(0));
  let visited = 0;
  const out = p.maybeTransposeIfExprChain(new js_ast.Expr(iff, new Loc(0)), (e) => { visited++; return e; });
  assert.equal(visited, 2);
  assert.equal(out.Data, iff);
});

test("G-33：keepExprSymbolName / keepClassOrFnSymbolName 生成 __name 调用", () => {
  const p = makeParser();
  const value = new js_ast.Expr(new js_ast.ENumber(1), new Loc(0));
  const named = p.keepExprSymbolName(value, "x");
  assert.ok(named.Data instanceof js_ast.ECall);
  assert.equal((named.Data as js_ast.ECall).CanBeUnwrappedIfUnused, true);
  const st = p.keepClassOrFnSymbolName(new Loc(0), value, "C");
  assert.ok(st.Data instanceof js_ast.SExpr);
  assert.ok((st.Data as js_ast.SExpr).Value.Data instanceof js_ast.ECall);
});
