// 第 42 轮：js_printer 纯助手 1:1 移植的直调差分测试。
// 期望字节来自 Go 包内探针 /tmp/printer_helpers.json：
//   cd /root/esbuild && go test ./internal/js_printer -run TestTmpHelpersProbe -count=1
// 探针调用真实的 CanEscapeIdentifier / smallIntToBytes / parseSmallInt，跑完即删。
import test from "node:test";
import assert from "node:assert/strict";

import {
  CanEscapeIdentifier,
  parseSmallInt,
  printer,
  Options,
} from "./js_printer.ts";
import { JSFeature } from "../compat/compat.ts";

// Go 探针实测（/tmp/printer_helpers.json，UnicodeEscapes=1<<59）
const IDENT: [string, boolean][] = [
  ["", false],
  ["x", true],
  ["abc", true],
  ["_$", true],
  ["a-b", false],
  ["9x", false],
  ["日本", true],
  ["a日本", true],
];
const INTS = [0, 5, 10, 1000, -42, 123456, -7];

function mkPrinter(): printer {
  return new printer([], { NameForSymbol: () => "" }, new Options());
}

test("CanEscapeIdentifier 逐位等于 Go 探针", () => {
  const none = 0n;
  const unesc = JSFeature.UnicodeEscapes;
  for (const [name, want] of IDENT) {
    assert.equal(CanEscapeIdentifier(name, none, false), want, `features=0 ascii=false: ${name}`);
    // Go 探针：UnicodeEscapes 位未置时 asciiOnly 不改变结果（!Has 项先短路）
    assert.equal(CanEscapeIdentifier(name, unesc, true), want, `features=UnicodeEscapes ascii=true: ${name}`);
  }
});

test("smallIntToBytes / parseSmallInt 逐位等于 Go 探针", () => {
  const p = mkPrinter();
  for (const n of INTS) {
    const s = new TextDecoder().decode(Uint8Array.from(p.smallIntToBytes(n)));
    assert.equal(s, String(n), `smallIntToBytes(${n})`);
    assert.equal(parseSmallInt(s), n, `parseSmallInt(${s})`);
  }
});

test("currentLineLength / printNewlinePastLineLimit 逐位等于 Go 探针", () => {
  // Go 探针实测（/tmp/line probe）：currentLineLength 从末尾回扫到上一换行
  const cases: [string, number][] = [
    ["abc", 3],
    ["ab\ncde", 3],
    ["x\nyy\nz", 1],
    ["a\r\nb", 1],
  ];
  for (const [s, want] of cases) {
    const p = mkPrinter();
    p.js.append(new TextEncoder().encode(s));
    assert.equal(p.currentLineLength(), want, `currentLineLength(${JSON.stringify(s)})`);
  }
  // printNewlinePastLineLimit: LineLimit=4
  const p1 = mkPrinter();
  p1.options.LineLimit = 4;
  p1.indent = 1;
  p1.print("abcdef");
  assert.equal(p1.printNewlinePastLineLimit(), true);
  assert.equal(new TextDecoder().decode(p1.js.toUint8Array()), "abcdef\n  ");
  const p2 = mkPrinter();
  p2.options.LineLimit = 4;
  p2.print("ab");
  assert.equal(p2.printNewlinePastLineLimit(), false);
  assert.equal(new TextDecoder().decode(p2.js.toUint8Array()), "ab");
});

test("printDotThenPrefix/Suffix Arrow 位两分支字节", () => {
  // Go: printDotThenPrefix/Suffix（js_printer.go:1609/1629）。
  // Arrow 未降级（默认 features=0）：.then(() => ...) + ")"
  const p1 = mkPrinter();
  p1.printDotThenPrefix();
  p1.print("body");
  p1.printDotThenSuffix();
  // Go 探针实测：".then(() => body)"（printSpace 在 `=>` 后确实输出空格）
  assert.equal(new TextDecoder().decode(p1.js.toUint8Array()), ".then(() => body)");

  // Arrow 降级（UnsupportedFeatures.Arrow）：.then(function(){return ...}) + ";})"
  const p2 = mkPrinter();
  p2.options.UnsupportedFeatures = JSFeature.Arrow;
  p2.printDotThenPrefix();
  p2.print("body");
  p2.printDotThenSuffix();
  assert.equal(
    new TextDecoder().decode(p2.js.toUint8Array()),
    ".then(function() {\n  return body;\n})",
  );
});
