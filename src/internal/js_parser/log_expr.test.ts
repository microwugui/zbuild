// 第 107 轮：parser.logExprErrors 三分支逐字节等于 Go（6 场景）。
// Go 探针 tools/go/tmpgen_logexpr_test.go → testdata/log-expr-go.json。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { newParser, Options, deferredErrors } from "./js_parser.ts";
import { NewDeferLog, DeferLogKind, Source, Range, Loc, MsgKind } from "../logger/logger.ts";
import { Lexer } from "../js_lexer/js_lexer.ts";
import { JSFeature } from "../compat/compat.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/log-expr-go.json", import.meta.url)));
const SHA = "5d97d6555237be3dd2d0b6b8a2773d6550a16c30dcd984e7d53ae398bab8966a";
const rows = JSON.parse(new TextDecoder().decode(raw)) as any[];

const rng = (start: number, len: number) => new Range(new Loc(start), len);
function run(idx: number): any {
  const log = NewDeferLog(DeferLogKind.DeferLogAll, null);
  const src = new Source();
  src.Contents = new TextEncoder().encode("abc = ? ...");
  src.KeyPath.Text = "<stdin>";
  const o = new Options();
  if (idx === 2 || idx === 4) o.unsupportedJSFeatures = JSFeature.ArraySpread;
  const p = newParser(log, src, Lexer.NewLexer(log, src, o.ts), o);
  const errs = new deferredErrors();
  if (idx === 0 || idx === 4) errs.invalidExprDefaultValue = rng(1, 1);
  if (idx === 1 || idx === 4) errs.invalidExprAfterQuestion = rng(0, 3);
  if (idx === 2 || idx === 3 || idx === 4) errs.arraySpreadFeature = rng(0, 1);
  p.logExprErrors(errs);
  return {
    name: rows[idx].name,
    msgs: log.Done().map((m) => ({ text: m.Data.Text, kind: m.Kind, start: m.Data.Location?.Column ?? 0, len: m.Data.Location?.Length ?? 0 })),
  };
}

test("log-expr 夹具 sha256（6 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("logExprErrors 三分支逐字节等于 Go（6 场景）", () => {
  assert.equal(rows.length, 6);
  for (let i = 0; i < rows.length; i++) assert.deepEqual(run(i), rows[i], `scenario ${i}: ${rows[i].name}`);
});
