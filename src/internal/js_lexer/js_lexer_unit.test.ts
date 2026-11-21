// js_lexer 的**单元差分**：给骨架 parser 打不到、但 Go 侧确有调用者的那几个函数补 Go 实测。
//
// 覆盖（期望值全部来自 /root/esbuild 的包内探针 `internal/js_lexer/tmpunit_test.go`）：
//   - ExpectLessThan / ExpectGreaterThan / maybeExpandEquals
//       Go 的调用点在 ts_parser.go:791/808/823 与 js_parser.go:4092（TS 类型参数 / 类型断言），
//       骨架 parser 不解析 TypeScript，因此无法由 parser 真实调用驱动；这里用**真实的 lexer
//       token 状态**（`a<<=b` 这类输入先 Next() 一次）喂进去，与 Go 的 token/start/end/raw 逐字段比对。
//   - RangeOfIdentifier / RangeOfImportAssertOrWith
//       Go 的调用点在 bundler / resolver / linker（M2），不在 M1 的 parser 关键路径上；同样用 Go 实测值比对。
//
// 这不是「用假测试充已移植」：输入是真实源码、期望值是 Go 当场跑出来的、比对的是 Go 的公开行为
// （含 `RangeOfIdentifier` 在「标识符一直延伸到文件末尾」时回退 RangeOfString 返回 Len 0 这种怪行为）。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  KeyOrValue,
  Lexer,
  RangeOfIdentifier,
  RangeOfImportAssertOrWith,
} from "./js_lexer.ts";
import { T, tokenToString } from "./tables.ts";
import { Loc, Log, Path, Source } from "../logger/logger.ts";

interface UnitProbe {
  expectTokens: {
    input: string;
    which: "lt" | "gt";
    token: number;
    name: string;
    start: number;
    end: number;
    raw: string;
  }[];
  ranges: { contents: string; start: number; loc: number; len: number }[];
  assertRanges: { which: number; loc: number; len: number }[];
}

const probe: UnitProbe = JSON.parse(
  readFileSync(new URL("../../../testdata/lexer/unit-probe.json", import.meta.url), "utf8"),
);

const decoder = new TextDecoder();

function makeSource(contents: string): Source {
  const source = new Source();
  source.Contents = new TextEncoder().encode(contents);
  source.KeyPath = new Path();
  source.KeyPath.Text = "<stdin>";
  return source;
}

test("ExpectLessThan / ExpectGreaterThan / maybeExpandEquals：token 切分与 Go 逐字段相同", () => {
  assert.ok(probe.expectTokens.length >= 14, "夹具不得缩水");

  for (const want of probe.expectTokens) {
    const lexer = Lexer.NewLexer(new Log(), makeSource(want.input), {
      Parse: false,
      NoAmbiguousLessThan: false,
    });
    // 前进到第一个运算符 token（跳过开头的 'a'）
    lexer.Next();

    if (want.which === "lt") {
      lexer.ExpectLessThan(false);
    } else {
      lexer.ExpectGreaterThan(false);
    }

    const raw = decoder.decode(lexer.source.Contents.subarray(lexer.start, lexer.end));
    assert.equal(lexer.Token, want.token, `[${want.input}/${want.which}] token`);
    assert.equal(tokenToString.get(lexer.Token), want.name, `[${want.input}/${want.which}] tokenName`);
    assert.equal(lexer.start, want.start, `[${want.input}/${want.which}] start`);
    assert.equal(lexer.end, want.end, `[${want.input}/${want.which}] end`);
    assert.equal(raw, want.raw, `[${want.input}/${want.which}] raw`);
  }
});

test("RangeOfIdentifier：与 Go 实测相同（含回退 RangeOfString 的边界）", () => {
  assert.ok(probe.ranges.length >= 8, "夹具不得缩水");

  for (const want of probe.ranges) {
    const range = RangeOfIdentifier(makeSource(want.contents), new Loc(want.start));
    assert.equal(range.Loc.Start, want.loc, `[${JSON.stringify(want.contents)}@${want.start}] loc`);
    assert.equal(range.Len, want.len, `[${JSON.stringify(want.contents)}@${want.start}] len`);
  }
});

test("RangeOfImportAssertOrWith：KeyRange / ValueRange / KeyAndValueRange 与 Go 相同", () => {
  const source = makeSource('foo "bar"');
  const assertOrWith = {
    Key: Array.from(new TextEncoder().encode("foo")),
    Value: Array.from(new TextEncoder().encode("bar")),
    KeyLoc: new Loc(0),
    ValueLoc: new Loc(4),
    PreferQuotedKey: false,
  };

  for (const want of probe.assertRanges) {
    const range = RangeOfImportAssertOrWith(source, assertOrWith, want.which as KeyOrValue);
    assert.equal(range.Loc.Start, want.loc, `[which=${want.which}] loc`);
    assert.equal(range.Len, want.len, `[which=${want.which}] len`);
  }

  // 枚举值本身也要与 Go 的 iota 一致（KeyRange=0 / ValueRange=1 / KeyAndValueRange=2）
  assert.deepEqual(
    [KeyOrValue.KeyRange, KeyOrValue.ValueRange, KeyOrValue.KeyAndValueRange],
    probe.assertRanges.map((r) => r.which),
  );
  assert.equal(T.TEndOfFile, 0);
});
