// 第 35 轮 K-2：ts_parser.go type-skipper 全族，通道② 字节差分。
// Go 字节证据钉在 testdata/js_parser/k2-typeskip-go.json（38 条 TS 类型片段：
// 每条是 skipTypeScriptType(LLowest) 消费后 lexer 停止的 token + 字节偏移）。
// 本测试用同样的 lexer 起点跑 TS 版 skipTypeScriptType，逐字节比对消费终点。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Log, Path, Source } from "../logger/logger.ts";
import { Lexer } from "../js_lexer/js_lexer.ts";
import { newParser, Options, type parser } from "./js_parser.ts";
import {
  skipTypeScriptType, skipTypeScriptTypeWithFlags, skipTypeScriptObjectType,
  skipTypeScriptTypeParameters, skipTypeScriptTypeArguments, skipTypeScriptReturnType,
  skipTypeScriptBinding, skipTypeScriptFnArgs, skipTypeScriptParenOrFnType,
  trySkipTypeArgumentsInExpressionWithBacktracking,
  trySkipTypeScriptTypeParametersThenOpenParenWithBacktracking,
  trySkipTypeScriptArrowReturnTypeWithBacktracking,
  trySkipTypeScriptArrowArgsWithBacktracking,
  trySkipTypeScriptConstraintOfInferTypeWithBacktracking,
  isTypeScriptArrowReturnTypeAfterQuestionAndBeforeColon,
  skipTypeScriptTypeArgumentsOpts, skipTypeParamsResult, has,
  isReturnTypeFlag, isIndexSignatureFlag, allowTupleLabelsFlag, disallowConditionalTypesFlag,
} from "./ts_parser.ts";

const FIXTURE = new URL("../../../testdata/js_parser/k2-typeskip-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "5b9f4e378e974b9935309be4d848e12407aa8ac4707aed438111851f46814d01";

interface Row { input: string; tokens: number[]; locs: number[]; finalTok: number; finalStart: number; }
const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));

function makeParser(contents: string): parser {
  const source = new Source();
  source.Index = 0;
  source.Contents = new TextEncoder().encode(contents);
  source.KeyPath = new Path();
  source.KeyPath.Text = "<stdin>";
  const options = new Options();
  options.ts.Parse = true;
  const log = new Log();
  return newParser(log, source, Lexer.NewLexer(log, source, options.ts), options);
}

test("K-2 Go 字节证据：fixture sha256 + 38 条 TS 类型片段消费终点逐字节一致", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "k2 fixture sha256");
  assert.equal(rows.length, 38);
  for (const row of rows) {
    const p = makeParser(row.input);
    // NewLexer 已定位到第一个 token（与 Go probe 一致，不再 Next）
    skipTypeScriptType(p, 0); // js_ast.L.LLowest
    const tok = p.lexer.Token as number;
    const start = p.lexer.Loc().Start;
    assert.equal(tok, row.finalTok, `${JSON.stringify(row.input)} finalTok`);
    assert.equal(start, row.finalStart, `${JSON.stringify(row.input)} finalStart(consumed bytes)`);
  }
});

test("K-2 直调：skipTypeScriptTypeWithFlags / ObjectType / TypeParameters / TypeArguments 全部执行", () => {
  {
    const p = makeParser("A | B & C");
    skipTypeScriptTypeWithFlags(p, 0, 0);
    assert.equal(p.lexer.Token as number, 0 /* TEndOfFile */);
  }
  {
    const p = makeParser("{ a: number; b?: string }");
    skipTypeScriptObjectType(p);
    assert.equal(p.lexer.Token as number, 0);
  }
  {
    const p = makeParser("<T extends string = 'x'>");
    const r = skipTypeScriptTypeParameters(p, 0);
    assert.equal(r, skipTypeParamsResult.definitelyTypeParameters);
    assert.equal(p.lexer.Token as number, 0);
  }
  {
    const p = makeParser("<number, string>");
    const ok = skipTypeScriptTypeArguments(p, new skipTypeScriptTypeArgumentsOpts());
    assert.equal(ok, true);
    assert.equal(p.lexer.Token as number, 0);
  }
  {
    const p = makeParser("A | B");
    skipTypeScriptReturnType(p);
    assert.equal(p.lexer.Token as number, 0);
  }
});

test("K-2 直调：skipTypeScriptBinding / FnArgs / ParenOrFnType", () => {
  // Go skipTypeScriptBinding 支持 identifier/this/array/object（object 的 key 只能是 identifier/string/number）
  {
    const p = makeParser("{ a: x, b: y, ...rest }");
    skipTypeScriptBinding(p);
    assert.equal(p.lexer.Token as number, 0);
  }
  {
    const p = makeParser("[a, b, ...rest]");
    skipTypeScriptBinding(p);
    assert.equal(p.lexer.Token as number, 0);
  }
  {
    const p = makeParser("(a: number, b?: string, ...rest: any[])");
    skipTypeScriptFnArgs(p);
    assert.equal(p.lexer.Token as number, 0);
  }
  {
    const p = makeParser("(a: number) => string");
    skipTypeScriptParenOrFnType(p);
    assert.equal(p.lexer.Token as number, 0);
  }
});

test("K-2 直调：5 个 backtracking helper 全部执行（成功 + panic 回滚两条路径）", () => {
  {
    const p = makeParser("<number>(x)");
    assert.equal(trySkipTypeArgumentsInExpressionWithBacktracking(p), true);
    assert.equal(p.lexer.Token as number, 42 /* TOpenParen */);
  }
  {
    const p = makeParser("<= x");
    const before = p.lexer.Loc().Start;
    const ok = trySkipTypeArgumentsInExpressionWithBacktracking(p);
    // panic 回滚：Go 无名返回值 → false
    assert.equal(ok, false);
    assert.ok(p.lexer.Loc().Start <= before + 1);
  }
  {
    const p = makeParser("<T>(x)");
    const r = trySkipTypeScriptTypeParametersThenOpenParenWithBacktracking(p);
    assert.equal(r, skipTypeParamsResult.couldBeTypeCast);
    assert.equal(p.lexer.Token as number, 42 /* TOpenParen */);
  }
  {
    const p = makeParser(": number =>");
    assert.equal(trySkipTypeScriptArrowReturnTypeWithBacktracking(p), true);
  }
  {
    const p = makeParser("(a: number) =>");
    assert.equal(trySkipTypeScriptArrowArgsWithBacktracking(p), true);
  }
  {
    const p = makeParser("extends string");
    assert.equal(trySkipTypeScriptConstraintOfInferTypeWithBacktracking(p, 0), true);
  }
  {
    // flags=0 时尾部 `?` 会触发 Go 的 Unexpected() → panic → 无名返回 false
    const p = makeParser("extends string ?");
    assert.equal(trySkipTypeScriptConstraintOfInferTypeWithBacktracking(p, 0), false);
  }
});

test("K-2 直调：isTypeScriptArrowReturnTypeAfterQuestionAndBeforeColon（hack）", () => {
  const p = makeParser(": number => x :");
  const r = isTypeScriptArrowReturnTypeAfterQuestionAndBeforeColon(p, 0);
  assert.equal(typeof r, "boolean");
});

test("K-2：skipTypeFlags.has 各处常量", () => {
  assert.equal(has(isReturnTypeFlag, isReturnTypeFlag), true);
  assert.equal(has(isIndexSignatureFlag, allowTupleLabelsFlag), false);
  assert.equal(has(disallowConditionalTypesFlag | allowTupleLabelsFlag, disallowConditionalTypesFlag), true);
});
