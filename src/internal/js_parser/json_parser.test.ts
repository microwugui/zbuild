// json_parser.go 的 Go 实测差分测试（第 21 轮）
//
// 期望值来源（全部 Go 实测，不是手写）：
//   1. testdata/js_parser/json.json —— `tools/gen_js_parser_json_fixture.go`
//      （`cd /root/esbuild && go run ./tmpgenjson > /root/port/testdata/js_parser/json.json`）
//      逐例给出 ParseDefineExpr / ParseJSON(IsForDefine:true/false) 的结果、诊断文案，
//      以及可打印值经 js_printer.Print 得到的**逐字节**输出（与 TS 侧同构：
//      AST{Parts:[{Stmts:[SExpr]}]} + NoOpRenamer + FormatESModule）；
//   2. testdata/js_parser/is-valid-json.json —— 包内临时 `_test.go`
//      （`TestTmpIsValidJSON`，因 isValidJSON 未导出；文件已删除，源见 PLAN「第 21 次推进」§6，
//      跑法 `cd /root/esbuild && go test ./internal/js_parser -run TestTmpIsValidJSON -count=1 -v`）。
//
// 两份夹具的 sha256 都钉死在下方；不一致即说明夹具被改过（而不是测试通过）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { Log, MsgKind, Path as LogPath, Source, type Msg } from "../logger/logger.ts";
import { init } from "../helpers/init.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import { Format, Options as PrintOptions, Print } from "../js_printer/js_printer.ts";
import { JSONOptions, ParseJSON, isValidJSON } from "./json_parser.ts";
import { ParseDefineExpr } from "./js_parser.ts";

const JSON_PIN_SHA256 = "9e3fd304daf0c4405d49152ccffe5c66be530b5d6c8e7c696c1027cde8d62a54";
const IS_VALID_PIN_SHA256 = "bb0e92859f5f9bbc1972802c689d01e49317131619ede964c77bebf6441544b7";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface MsgOut {
  kind: number;
  text: string;
  notes?: string[];
}

interface JsonCase {
  text: string;
  parts?: string[];
  constant?: string;
  compound?: boolean;
  valueOut?: string;
  valueOk?: boolean;
  jsonOk: boolean;
  jsonOut?: string;
  jsonOutOk?: boolean;
  jsonMsgs?: MsgOut[];
  notDefineOk: boolean;
  notDefineMsgs?: MsgOut[];
}

const cases: JsonCase[] = JSON.parse(
  readFileSync(new URL("../../../testdata/js_parser/json.json", import.meta.url), "utf8"),
);
const validCases: { text: string; ok: boolean; okIsValid: boolean }[] = JSON.parse(
  readFileSync(new URL("../../../testdata/js_parser/is-valid-json.json", import.meta.url), "utf8"),
);

/** Go 侧同构：把单个 E 包进 AST 并逐字节打印 */
function printValue(data: js_ast.E): string {
  const tree = new js_ast.AST();
  const part = new js_ast.Part();
  part.Stmts = [new js_ast.Stmt(init(new js_ast.SExpr(), { Value: new js_ast.Expr(data) }))];
  tree.Parts = [part];
  const options = new PrintOptions();
  options.OutputFormat = Format.FormatESModule;
  return decoder.decode(Print(tree, [], { NameForSymbol: () => "" }, options).JS);
}

function makeSource(text: string): Source {
  const source = new Source();
  source.Contents = encoder.encode(text);
  source.KeyPath = new LogPath();
  return source;
}

function runParseJSON(text: string, isForDefine: boolean): { expr: js_ast.Expr; ok: boolean; msgs: MsgOut[] } {
  const log = new Log();
  const msgs: MsgOut[] = [];
  log.AddMsg = (msg: Msg): void => {
    msgs.push({
      kind: msg.Kind,
      text: msg.Data.Text,
      ...(msg.Notes.length > 0 ? { notes: msg.Notes.map((n) => n.Text) } : {}),
    });
  };
  const { expr, ok } = ParseJSON(
    log,
    makeSource(text),
    init(new JSONOptions(), { IsForDefine: isForDefine }),
  );
  return { expr, ok, msgs };
}

function typeName(data: js_ast.E | null): string | undefined {
  if (data instanceof js_ast.ENull) return "ENull";
  if (data instanceof js_ast.EBoolean) return "EBoolean";
  if (data instanceof js_ast.EString) return "EString";
  if (data instanceof js_ast.ENumber) return "ENumber";
  if (data instanceof js_ast.EBigInt) return "EBigInt";
  if (data instanceof js_ast.EArray) return "EArray";
  if (data instanceof js_ast.EObject) return "EObject";
  return undefined;
}

test("json 夹具 sha256 锁定（两份）", () => {
  const a = readFileSync(new URL("../../../testdata/js_parser/json.json", import.meta.url));
  const b = readFileSync(new URL("../../../testdata/js_parser/is-valid-json.json", import.meta.url));
  assert.equal(createHash("sha256").update(a).digest("hex"), JSON_PIN_SHA256);
  assert.equal(createHash("sha256").update(b).digest("hex"), IS_VALID_PIN_SHA256);
});

test("ParseDefineExpr：属性链 / 基元 Constant / 复合值 与 Go 逐例一致", () => {
  assert.ok(cases.length >= 40, "语料不得缩水");
  for (const c of cases) {
    const [expr, value] = ParseDefineExpr(c.text);
    assert.deepEqual(expr.Parts, c.parts ?? [], `[${JSON.stringify(c.text)}] Parts`);
    assert.equal(typeName(expr.Constant), c.constant, `[${JSON.stringify(c.text)}] Constant 类型`);

    if (c.compound) {
      assert.notEqual(value, null, `[${JSON.stringify(c.text)}] 复合值应当返回 E`);
      assert.equal(c.constant, undefined, `[${JSON.stringify(c.text)}] 复合值时 Constant 必须为 nil`);
    } else {
      assert.equal(value, null, `[${JSON.stringify(c.text)}] 非复合值不应返回 E`);
    }

    // 可打印值的逐字节（Go 侧同构打印）
    const printable = expr.Constant ?? value;
    if (c.valueOut === undefined) {
      assert.equal(printable, null, `[${JSON.stringify(c.text)}] Go 侧无可打印值`);
    } else {
      assert.notEqual(printable, null, `[${JSON.stringify(c.text)}] Go 侧有可打印值`);
      assert.equal(printValue(printable!), c.valueOut, `[${JSON.stringify(c.text)}] 打印字节`);
    }
  }
});

test("ParseJSON(IsForDefine:true)：ok / 打印字节 / 诊断文案与 Go 逐例一致", () => {
  for (const c of cases) {
    const got = runParseJSON(c.text, true);
    assert.equal(got.ok, c.jsonOk, `[${JSON.stringify(c.text)}] ok`);

    if (c.jsonOut === undefined) {
      assert.equal(c.jsonOutOk, undefined, `[${JSON.stringify(c.text)}] 夹具自洽：无字节时不该有 jsonOutOk`);
    } else {
      assert.notEqual(got.expr.Data, null, `[${JSON.stringify(c.text)}] 成功解析必须有 Data`);
      assert.equal(printValue(got.expr.Data!), c.jsonOut, `[${JSON.stringify(c.text)}] 打印字节`);
    }

    assert.deepEqual(got.msgs, c.jsonMsgs ?? [], `[${JSON.stringify(c.text)}] 诊断`);
  }
});

test("ParseJSON(IsForDefine:false)：BigInt 走 Unexpected，文案与 Go 一致", () => {
  for (const c of cases) {
    const got = runParseJSON(c.text, false);
    assert.equal(got.ok, c.notDefineOk, `[${JSON.stringify(c.text)}] ok`);
    assert.deepEqual(got.msgs, c.notDefineMsgs ?? [], `[${JSON.stringify(c.text)}] 诊断`);
  }
});

test("isValidJSON 与 Go 逐例一致（含 __proto__ 计算属性 / BigInt 反例）", () => {
  assert.ok(validCases.length >= 15, "语料不得缩水");
  for (const c of validCases) {
    const got = runParseJSON(c.text, true);
    assert.equal(got.ok, c.ok, `[${JSON.stringify(c.text)}] ParseJSON ok`);
    if (!c.ok) continue;
    assert.equal(isValidJSON(got.expr), c.okIsValid, `isValidJSON(${JSON.stringify(c.text)})`);
  }
});

test("重复 key 警告：MsgID / 级别 / 文案（Go 的 %q 引号形态）", () => {
  // 单独取一例，把 Kind 与 MsgID 也钉住（夹具里只记录 kind/text/notes）。
  const log = new Log();
  const msgs: Msg[] = [];
  log.AddMsg = (msg: Msg): void => { msgs.push(msg); };
  const { ok } = ParseJSON(log, makeSource('{"日":1,"日":2,"a\\u00a0b":1,"a\\u00a0b":2}'), new JSONOptions());
  assert.equal(ok, true);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].Kind, MsgKind.Warning);
  assert.equal(msgs[0].Data.Text, 'Duplicate key "日" in object literal');
  assert.equal(msgs[1].Data.Text, 'Duplicate key "a\\u00a0b" in object literal');
  assert.equal(msgs[1].Notes[0].Text, 'The original key "a\\u00a0b" is here:');
});
