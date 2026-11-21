// ExprToConstValue / ConstValueToExpr 逐函数差分测试（第 78 轮）。
//
// 期望值来自 Go 实测：/root/esbuild/tmpgen_constval 生成 5011 例（12 个手选边界 +
// 4000 随机 double + 1000 nice 十进制），每例记录 Go 的 strconv.FormatFloat(v,'g',-1,64)
// 结果、asIntEq（v==float64(int64(v))）、以及 ExprToConstValue 的 inline 判定。
// 夹具 testdata/js_ast-constval-go.json 的 sha256 钉死，不可手改。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as js_ast from "./js_ast.ts";
import { Loc } from "../logger/logger.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/js_ast-constval-go.json", import.meta.url)));
const SHA = "8aafcad9831a90d91c135b13f31bb501969ae7ede5f79455e3eed8bc340efcfa";
interface Row { gStr: string; asInt: boolean; gLen: number; inline: boolean; }
const rows: Row[] = JSON.parse(new TextDecoder().decode(raw));

test("js_ast constval fixture sha256 + ExprToConstValue ENumber inline 判定 5011 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
  assert.ok(rows.length >= 5000, "fixture 至少 5000 例");
  let bad = 0;
  for (const r of rows) {
    const v = Number(r.gStr); // Go 的 gStr 是 round-trip 最短表示，Number() 还原同一 double
    const cv = js_ast.ExprToConstValue(new js_ast.Expr(new js_ast.ENumber(v)));
    const inline = cv.Kind === js_ast.ConstValueKind.ConstValueNumber;
    if (inline !== r.inline) {
      bad++;
      if (bad <= 5) console.error("mismatch", r.gStr, "go inline", r.inline, "ts", inline);
    }
  }
  assert.equal(bad, 0, `inline 判定应全部等于 Go，实际 ${bad} 例不符`);
});

test("ExprToConstValue 非 number 分支 + ConstValueToExpr 往返", () => {
  assert.equal(js_ast.ExprToConstValue(new js_ast.Expr(new js_ast.ENull())).Kind, js_ast.ConstValueKind.ConstValueNull);
  assert.equal(js_ast.ExprToConstValue(new js_ast.Expr(new js_ast.EUndefined())).Kind, js_ast.ConstValueKind.ConstValueUndefined);
  assert.equal(js_ast.ExprToConstValue(new js_ast.Expr(new js_ast.EBoolean(true))).Kind, js_ast.ConstValueKind.ConstValueTrue);
  assert.equal(js_ast.ExprToConstValue(new js_ast.Expr(new js_ast.EBoolean(false))).Kind, js_ast.ConstValueKind.ConstValueFalse);
  const small = new js_ast.EString(new Uint16Array([97, 98, 99])); // "abc" 3 码元 → 内联
  assert.equal(js_ast.ExprToConstValue(new js_ast.Expr(small)).Kind, js_ast.ConstValueKind.ConstValueString);
  const big = new js_ast.EString(new Uint16Array([97, 98, 99, 100])); // "abcd" 4 码元 → 不内联
  assert.equal(js_ast.ExprToConstValue(new js_ast.Expr(big)).Kind, js_ast.ConstValueKind.ConstValueNone);
  assert.equal(js_ast.ExprToConstValue(new js_ast.Expr(new js_ast.EBigInt("123"))).Kind, js_ast.ConstValueKind.ConstValueNone);

  const loc = new Loc(7);
  const cases: [number, js_ast.E][] = [
    [js_ast.ConstValueKind.ConstValueNull, new js_ast.ENull()],
    [js_ast.ConstValueKind.ConstValueUndefined, new js_ast.EUndefined()],
    [js_ast.ConstValueKind.ConstValueTrue, new js_ast.EBoolean(true)],
    [js_ast.ConstValueKind.ConstValueFalse, new js_ast.EBoolean(false)],
  ];
  for (const [kind, expected] of cases) {
    const cv = new js_ast.ConstValue(); cv.Kind = kind;
    const expr = js_ast.ConstValueToExpr(loc, cv);
    assert.equal(expr.Data!.constructor.name, expected.constructor.name);
    assert.equal(expr.Loc.Start, 7);
  }
  const numCv = new js_ast.ConstValue(); numCv.Kind = js_ast.ConstValueKind.ConstValueNumber; numCv.Number = 1.5;
  const numExpr = js_ast.ConstValueToExpr(loc, numCv);
  assert.ok(numExpr.Data instanceof js_ast.ENumber && numExpr.Data.Value === 1.5);
  const strCv = new js_ast.ConstValue(); strCv.Kind = js_ast.ConstValueKind.ConstValueString; strCv.String = new Uint16Array([120]);
  const strExpr = js_ast.ConstValueToExpr(loc, strCv);
  assert.ok(strExpr.Data instanceof js_ast.EString && strExpr.Data.Value.length === 1 && strExpr.Data.Value[0] === 120);
  assert.throws(() => js_ast.ConstValueToExpr(loc, new js_ast.ConstValue()), /invalid constant value/);
});

test("goFormatFloatG 边界：1e20 Go '1e+20'(5) 而 JS toString 21 位", () => {
  const cv = js_ast.ExprToConstValue(new js_ast.Expr(new js_ast.ENumber(1e20)));
  assert.equal(cv.Kind, js_ast.ConstValueKind.ConstValueNumber);
});
