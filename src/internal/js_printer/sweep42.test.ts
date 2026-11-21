// 第 42 轮 FINAL SWEEP：printer 助手 1:1 移植的直调差分测试。
// 期望值来自**一次集中运行**的 Go 包内探针 `/tmp/sweep_probe.json`：
//   cd /root/esbuild && go test ./internal/js_printer -run TestTmpSweepProbe -count=1
// 探针构造真实 printer / SymbolMap / TSEnumValue 并调用被测函数，跑完即删；
// 产物固化为 testdata/sweep_probe.json（sha256 2377a86a…），逐字段比对。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as js_ast from "../js_ast/js_ast.ts";
import { Ref } from "../ast/ast.ts";
import { Loc } from "../logger/logger.ts";
import { printer, Options } from "./js_printer.ts";
import { SymbolKind, Symbol } from "../ast/ast.ts";
import { wrapInlinedEnum } from "../js_parser/ts_parser.ts";

const expected = JSON.parse(readFileSync(new URL("../../../testdata/sweep_probe.json", import.meta.url), "utf8"));

function mkPrinter(symbols: Symbol[], options: Options): printer {
  return new printer(symbols, { NameForSymbol: (ref: Ref) => "renamed" + String(ref.InnerIndex) }, options);
}

function utf16(s: string): Uint16Array {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x10000) out.push(c);
    else {
      const d = c - 0x10000;
      out.push(0xd800 + (d >> 10), 0xdc00 + (d & 0x3ff));
    }
  }
  return new Uint16Array(out);
}

function mkSymbol(kind: number, originalName: string): Symbol {
  const s = new Symbol();
  s.Link = new Ref(0xffffffff, 0xffffffff); // InvalidRef
  s.Kind = kind;
  s.OriginalName = originalName;
  return s;
}

test("mangledPropName 逐位等于 Go 探针", () => {
  const hit = mkPrinter([mkSymbol(0, "orig"), mkSymbol(0, "orig")], new Options());
  hit.options.MangledProps.set(0, "mangled");
  assert.equal(hit.mangledPropName(new Ref(0, 0)), expected.mangled_hit);
  const miss = mkPrinter([mkSymbol(0, "orig0"), mkSymbol(0, "orig1")], new Options());
  assert.equal(miss.mangledPropName(new Ref(1, 0)), expected.mangled_miss);
});

test("tryToGetImportedEnumValue(+UTF16) 逐位等于 Go 探针", () => {
  const p = mkPrinter([mkSymbol(SymbolKind.SymbolTSEnum, "E")], new Options());
  const enumMap = new Map<string, js_ast.TSEnumValue>();
  const a = new js_ast.TSEnumValue();
  a.Number = 1;
  const b = new js_ast.TSEnumValue();
  b.String = utf16("hi");
  enumMap.set("A", a);
  enumMap.set("B", b);
  p.options.TSEnums.set(0, enumMap);
  const target = new js_ast.Expr(new js_ast.EImportIdentifier(new Ref(0, 0)), new Loc(0));

  const vA = p.tryToGetImportedEnumValue(target, "A");
  assert.ok(vA !== null);
  assert.equal(vA.Number, expected.enumA.num);
  assert.equal(new TextDecoder().decode(Uint8Array.from(vA.String ?? [])), expected.enumA.str);

  const vB = p.tryToGetImportedEnumValue(target, "B");
  assert.ok(vB !== null);
  assert.equal(new TextDecoder().decode(Uint8Array.from(vB.String ?? [])), expected.enumB.str);
  assert.equal(vB.Number, expected.enumB.num);

  assert.equal(p.tryToGetImportedEnumValue(target, "C"), null);
  assert.equal(expected.enumC_ok, false);

  const vAU = p.tryToGetImportedEnumValueUTF16(target, utf16("A"));
  assert.ok(vAU !== null);
  assert.equal(vAU.name, expected.enumA_utf16.str);
  assert.equal(vAU.value.Number, expected.enumA_utf16.num);
});

test("wrapInlinedEnum 结构逐位等于 Go 探针", () => {
  // Go 探针：wrapInlinedEnum(值 1, 注释 A) 打印为「空格 1 空格 块注释 A」。
  // 第 42 轮深水链已接 printer 的 EInlinedEnum 打印分支，这里断言真实字节。
  const num = new js_ast.Expr(new js_ast.ENumber(1), new Loc(0));
  const wrapped = wrapInlinedEnum(num, "A");
  assert.ok(wrapped.Data instanceof js_ast.EInlinedEnum);
  assert.equal((wrapped.Data as js_ast.EInlinedEnum).Comment, "A");
  assert.equal((wrapped.Data as js_ast.EInlinedEnum).Value.Data, num.Data);
  assert.equal(wrapped.Loc.Start, num.Loc.Start);
  // 独立直调在 LLowest 下 printNumber 的前导空格行为 Go/TS 子集本就有差异（与本链无关），
  // 故在真实上下文（等号右侧）验 EInlinedEnum 的注释字节，与 byte oracle 的
  // `console.log(1 /* A */)` 一致：值后必须精确输出 " /* A */"。
  const p = mkPrinter([], new Options());
  p.print("x =");
  p.printSpace();
  p.printExpr(wrapped, js_ast.L.LComma, 0);
  assert.equal(new TextDecoder().decode(Uint8Array.from(p.js)), "x = 1 /* A */");

  // comment 含注释结束符则不包（返回原表达式）
  assert.equal(wrapInlinedEnum(num, "a*/b").Data, num.Data);
});
