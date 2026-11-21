// 第 35 轮 G-3 纯谓词：isSafeForConstLocalPrefix / tryToInlineCaseBody。
// Go 字节证据钉在 testdata/js_parser/g3-predicates-go.json（AST 直构，Go 实测结果）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as js_ast from "../js_ast/js_ast.ts";
import { Loc, Log, Path, Source } from "../logger/logger.ts";
import { Lexer } from "../js_lexer/js_lexer.ts";
import { newParser, Options, type parser } from "./js_parser.ts";

const FIXTURE = new URL("../../../testdata/js_parser/g3-predicates-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "656c43100da8c9fa6c5fe106093bc36f1cafc0992f0c0430547f86f240aa6201";
interface Row { input: string; safe: boolean; inlined: boolean; stmtCount: number; }
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

test("G-3 Go 字节证据：fixture sha256 + 谓词结果逐项一致", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "g3 fixture sha256");
  const p = makeParser();
  const byName = (n: string) => rows.find((r) => r.input === n)!;

  // isSafeForConstLocalPrefix
  const safeExprs: Record<string, js_ast.E> = {
    null: new js_ast.ENull(), undefined: new js_ast.EUndefined(), bool: new js_ast.EBoolean(),
    num: new js_ast.ENumber(), bigint: new js_ast.EBigInt(), string: new js_ast.EString(),
    func: new js_ast.EFunction(), arrow: new js_ast.EArrow(),
    identifier: new js_ast.EIdentifier(), call: new js_ast.ECall(),
  };
  const arr = new js_ast.EArray(); arr.Items = [ex(new js_ast.EIdentifier())];
  safeExprs["array-empty"] = arr;
  const obj = new js_ast.EObject();
  const prop = new js_ast.Property(); prop.ValueOrNil = ex(new js_ast.ENumber()); obj.Properties = [prop];
  safeExprs["object-empty"] = obj;

  for (const [name, e] of Object.entries(safeExprs)) {
    assert.equal(p.isSafeForConstLocalPrefix(ex(e)), byName(name).safe, `safe ${name}`);
  }

  // tryToInlineCaseBody
  const letStmt = new js_ast.SLocal(); letStmt.Kind = js_ast.LocalKind.LocalLet;
  const varStmt = new js_ast.SLocal(); varStmt.Kind = js_ast.LocalKind.LocalVar;
  const stmtCases: Record<string, js_ast.S> = {
    expr: new js_ast.SExpr(), return: new js_ast.SReturn(), break: new js_ast.SBreak(),
    let: letStmt, var: varStmt, for: new js_ast.SFor(),
  };
  for (const [name, s] of Object.entries(stmtCases)) {
    const res = p.tryToInlineCaseBody(L, [new js_ast.Stmt(s, L)], L);
    assert.equal(res.ok, byName(name).inlined, `inline ${name} ok`);
    assert.equal(res.stmts.length, byName(name).stmtCount, `inline ${name} count`);
  }
});
