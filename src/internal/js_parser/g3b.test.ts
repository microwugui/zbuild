// 第 35 轮 G-3 IIFE：maybeInlineIIFE 通道③字节差分。
// Go 字节证据钉在 testdata/js_parser/g3b-iife-go.json（AST 直构，Go 实测结果）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as js_ast from "../js_ast/js_ast.ts";
import { Loc, Log, Path, Source } from "../logger/logger.ts";
import { Lexer } from "../js_lexer/js_lexer.ts";
import { newParser, Options, type parser } from "./js_parser.ts";

const FIXTURE = new URL("../../../testdata/js_parser/g3b-iife-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "d72f6b3610fb38af5ed5e3eb95dfbe9f9556899ca870b5469e0e97b8fbe10999";
interface Row { input: string; inlined: boolean; removable: boolean; resultKind: string; }
const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));

const L = new Loc(0);
const ex = (d: js_ast.E): js_ast.Expr => new js_ast.Expr(d, L);
function makeParser(): parser {
  const source = new Source();
  source.Index = 0;
  source.Contents = new Uint8Array(0);
  source.KeyPath = new Path();
  source.KeyPath.Text = "<stdin>";
  const log = new Log();
  const options = new Options();
  return newParser(log, source, Lexer.NewLexer(log, source, options.ts), options);
}
const byName = (n: string) => rows.find((r) => r.input === n)!;
const arrowCall = (...stmts: js_ast.Stmt[]): js_ast.ECall => {
  const a = new js_ast.EArrow();
  a.Body.Block.Stmts = stmts;
  const call = new js_ast.ECall();
  call.Target = ex(a);
  return call;
};

test("G-3b Go 字节证据：fixture sha256 + maybeInlineIIFE 逐项一致", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "g3b fixture sha256");
  const p = makeParser();

  const retStmt = new js_ast.SReturn(); retStmt.ValueOrNil = ex(new js_ast.ENumber(123));
  const exprStmt = new js_ast.SExpr(); exprStmt.Value = ex(new js_ast.EIdentifier());
  const emptyExprStmt1 = new js_ast.SExpr(); emptyExprStmt1.Value = ex(new js_ast.ENumber());
  const emptyExprStmt2 = new js_ast.SExpr(); emptyExprStmt2.Value = ex(new js_ast.ENumber());
  const cases: Record<string, js_ast.ECall> = {
    "empty-body": arrowCall(),
    "return-123": arrowCall(new js_ast.Stmt(retStmt, L)),
    "expr-x": arrowCall(new js_ast.Stmt(exprStmt, L)),
    "two-stmts": arrowCall(new js_ast.Stmt(emptyExprStmt1, L), new js_ast.Stmt(emptyExprStmt2, L)),
  };
  const withArg = arrowCall(); withArg.Args = [ex(new js_ast.ENumber())];
  cases["with-arg"] = withArg;

  for (const [name, c] of Object.entries(cases)) {
    const res = p.maybeInlineIIFE(L, c);
    assert.equal(res.ok, byName(name).inlined, `iife ${name} inlined`);
    if (res.ok) {
      const kind = res.expr.Data instanceof js_ast.EUndefined ? "undefined" :
        res.expr.Data instanceof js_ast.ENumber ? "number" :
        res.expr.Data instanceof js_ast.EUnary ? "unary-void" :
        res.expr.Data instanceof js_ast.EIdentifier ? "identifier" : "other";
      assert.equal(kind, byName(name).resultKind, `iife ${name} resultKind`);
    }
  }

  const noArgs = new js_ast.FnBody();
  assert.equal(p.iifeCanBeRemovedIfUnused([], noArgs), byName("no-args-empty").removable);
  const simpleArgs: js_ast.Arg[] = [new js_ast.Arg()];
  simpleArgs[0].Binding.Data = new js_ast.BIdentifier();
  assert.equal(p.iifeCanBeRemovedIfUnused(simpleArgs, noArgs), byName("simple-arg").removable);
  const destructureArgs: js_ast.Arg[] = [new js_ast.Arg()];
  destructureArgs[0].Binding.Data = new js_ast.BArray() as never;
  assert.equal(p.iifeCanBeRemovedIfUnused(destructureArgs, noArgs), byName("destructure-arg").removable);
});
