// js_printer 最小子集的差分测试（第 14 次推进）。
//
// 期望值来自 Go 实测：/root/esbuild/tmpgenprinter 用**真实的** js_parser.Parse + js_printer.Print
// 生成 testdata/js_printer/basic.json（hex 编码，避免转义歧义）。
// 生成命令见 PLAN.md「第 14 次推进」§4；夹具 sha256 钉在 tools/fixtures.json。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Log, Path, Source } from "../logger/logger.ts";
import { Options, Parse } from "../js_parser/js_parser.ts";
import { Format, Options as PrintOptions, Print, QuoteIdentifier } from "./js_printer.ts";
import type { Ref } from "../ast/ast.ts";

interface PrinterCase {
  name: string;
  input: string;
  jsHex: string;
  minJsHex: string;
}

const fixture: { cases: PrinterCase[]; quotes: { input: string; hex: string }[] } = JSON.parse(
  readFileSync(new URL("../../../testdata/js_printer/basic.json", import.meta.url), "utf8"),
);

function print(input: string, minify: boolean): Uint8Array | null {
  const source = new Source();
  source.Index = 0;
  source.Contents = new TextEncoder().encode(input);
  source.KeyPath = new Path();
  source.KeyPath.Text = "<stdin>";

  const { ast, ok } = Parse(new Log(), source, new Options());
  if (!ok) return null;

  const symbols = ast.Symbols;
  const renamer = {
    NameForSymbol(ref: Ref): string {
      return symbols[ref.InnerIndex].OriginalName;
    },
  };
  const options = new PrintOptions();
  options.OutputFormat = Format.FormatESModule;
  options.MinifyWhitespace = minify;
  return Print(ast, symbols, renamer, options).JS;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

test("QuoteIdentifier 与 Go 实测一致", () => {
  for (const q of fixture.quotes) {
    assert.equal(toHex(QuoteIdentifier(q.input)), q.hex, q.input);
  }
});

test("js_printer 夹具不得缩水", () => {
  assert.ok(fixture.cases.length >= 20, `夹具只有 ${fixture.cases.length} 条`);
});

test("js_printer：20 个输入的默认输出与 Go 实测逐字节一致", () => {
  for (const c of fixture.cases) {
    const js = print(c.input, false);
    assert.notEqual(js, null, `[${c.name}] Parse 失败`);
    assert.equal(toHex(js!), c.jsHex, `[${c.name}] 输出字节不一致`);
  }
});

test("js_printer：minifyWhitespace 输出与 Go 实测逐字节一致", () => {
  for (const c of fixture.cases) {
    if (c.minJsHex === "") continue;
    const js = print(c.input, true);
    assert.notEqual(js, null, `[${c.name}] Parse 失败`);
    assert.equal(toHex(js!), c.minJsHex, `[${c.name}] minify 输出字节不一致`);
  }
});
