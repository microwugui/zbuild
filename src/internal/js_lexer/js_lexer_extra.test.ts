// 裸 token 循环覆盖不到的入口：用 Go 探针实测的期望值钉住（不是手写猜测）。
//
// 期望值来源：第 11 次推进的临时包内测试 `tmpunit2_test.go`（跑完即删）直接构造
//   NewLexerGlobalName / NewLexerJSON(JSON, " in JSON") / NewLexer(…, config.TSOptions{})
// 并打印首个 token 的状态、注释区间、pragma span、HasCommentBefore、log（含 note）。
// 探针已删（临时文件不留），期望值逐条抄成下面的字面量；复现方式见该探针的四个入口。
//
// 这些用例都不进 V2 夹具（夹具哈希已钉死），只作函数级单元验证；
// 它们让 NewLexerGlobalName / NewLexerJSON / Unexpected / AddRangeErrorWithNotes /
// hasPrefixWithWordBoundary / scanForPragmaArg / isUpperASCII / isLetterASCII 都真正被执行到。

import { test } from "node:test";
import assert from "node:assert/strict";
import { Lexer, LexerPanic, hasPrefixWithWordBoundary, IsAssign, isLetterASCII, isUpperASCII } from "./js_lexer.ts";
import { CommentBefore, JSONFlavor } from "./js_lexer.ts";
import { T } from "./tables.ts";
import { DeferLogKind, NewDeferLog, Source } from "../logger/logger.ts";
import type { Log, Range, Span } from "../logger/logger.ts";

interface FirstToken {
  Token: number;
  start: number;
  len: number;
  HasCommentBefore: number;
  Comments: [number, number][];
  LegalComments: [number, number][];
}

interface Captured {
  first: FirstToken | null;
  logs: { kind: number; text: string; line: number; col: number; len: number; notes: { text: string; line: number; col: number; len: number }[] }[];
  panic: string | undefined;
  jsxFactory: Span | null;
  jsxFragment: Span | null;
  jsxRuntime: Span | null;
  jsxImportSource: Span | null;
  sourceMappingURL: Span | null;
}

function capture(contents: string, make: (log: Log, source: Source) => Lexer): Captured {
  const log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null);
  const source = new Source();
  source.Contents = new TextEncoder().encode(contents);
  const out: Captured = {
    first: null,
    logs: [],
    panic: undefined,
    jsxFactory: null,
    jsxFragment: null,
    jsxRuntime: null,
    jsxImportSource: null,
    sourceMappingURL: null,
  };
  try {
    const lexer = make(log, source);
    const ranges = (rs: Range[]): [number, number][] => rs.map((r) => [r.Loc.Start, r.Len]);
    out.first = {
      Token: lexer.Token,
      start: lexer.start,
      len: lexer.end - lexer.start,
      HasCommentBefore: lexer.HasCommentBefore,
      Comments: ranges(lexer.CommentsBeforeToken),
      LegalComments: ranges(lexer.LegalCommentsBeforeToken),
    };
    const span = (s: Span): Span | null => (s.Range.Len === 0 ? null : s);
    out.jsxFactory = span(lexer.JSXFactoryPragmaComment);
    out.jsxFragment = span(lexer.JSXFragmentPragmaComment);
    out.jsxRuntime = span(lexer.JSXRuntimePragmaComment);
    out.jsxImportSource = span(lexer.JSXImportSourcePragmaComment);
    out.sourceMappingURL = span(lexer.SourceMappingURL);
  } catch (e) {
    if (!(e instanceof LexerPanic)) throw e;
    out.panic = "js_lexer.LexerPanic";
  }
  for (const msg of log.Done()) {
    const loc = msg.Data.Location;
    out.logs.push({
      kind: msg.Kind,
      text: msg.Data.Text,
      line: loc === null ? 0 : loc.Line,
      col: loc === null ? 0 : loc.Column,
      len: loc === null ? 0 : loc.Length,
      notes: msg.Notes.map((n) => ({
        text: n.Text,
        line: n.Location === null ? 0 : n.Location.Line,
        col: n.Location === null ? 0 : n.Location.Column,
        len: n.Location === null ? 0 : n.Location.Length,
      })),
    });
  }
  return out;
}

const asJS = (log: Log, source: Source): Lexer =>
  Lexer.NewLexer(log, source, { Parse: false, NoAmbiguousLessThan: false });

test("NewLexerGlobalName：'/' 不进入注释分支，直接出 TSlash", () => {
  const c = capture("//x", (log, source) => Lexer.NewLexerGlobalName(log, source));
  assert.deepEqual(c.first, {
    Token: T.TSlash,
    start: 0,
    len: 1,
    HasCommentBefore: 0,
    Comments: [],
    LegalComments: [],
  });
  assert.deepEqual(c.logs, []);
});

test("NewLexerJSON：'-' 走 Unexpected（错误原文含 errorSuffix），且 panic 后日志已落地", () => {
  const c = capture("-x", (log, source) => Lexer.NewLexerJSON(log, source, JSONFlavor.JSON, " in JSON"));
  assert.equal(c.panic, "js_lexer.LexerPanic");
  assert.deepEqual(c.logs, [
    { kind: 0, text: 'Unexpected "-" in JSON', line: 1, col: 0, len: 1, notes: [] },
  ]);
});

test("NewLexerJSON：单引号字符串报错但仍产出 TStringLiteral", () => {
  const c = capture("'a'", (log, source) => Lexer.NewLexerJSON(log, source, JSONFlavor.JSON, " in JSON"));
  assert.equal(c.panic, undefined);
  assert.deepEqual(c.first, {
    Token: T.TStringLiteral,
    start: 0,
    len: 3,
    HasCommentBefore: 0,
    Comments: [],
    LegalComments: [],
  });
  assert.deepEqual(c.logs, [
    { kind: 0, text: "JSON strings must use double quotes", line: 1, col: 0, len: 3, notes: [] },
  ]);
});

test("NewLexerJSON：注释被记录但报 'JSON does not support comments'", () => {
  const c = capture("//x", (log, source) => Lexer.NewLexerJSON(log, source, JSONFlavor.JSON, " in JSON"));
  assert.deepEqual(c.first, {
    Token: T.TEndOfFile,
    start: 3,
    len: 0,
    HasCommentBefore: 0,
    Comments: [[0, 3]],
    LegalComments: [],
  });
  assert.deepEqual(c.logs, [
    { kind: 0, text: "JSON does not support comments", line: 1, col: 0, len: 3, notes: [] },
  ]);
});

test("未闭合多行注释：AddRangeErrorWithNotes 的正文 + note 位置（Go 实测）", () => {
  const c = capture("/* x", asJS);
  assert.equal(c.panic, "js_lexer.LexerPanic");
  assert.deepEqual(c.logs, [
    {
      kind: 0,
      text: 'Expected "*/" to terminate multi-line comment',
      line: 1,
      col: 4,
      len: 0,
      notes: [{ text: "The multi-line comment starts here:", line: 1, col: 0, len: 2 }],
    },
  ]);
});

test("pragma 注释：@jsx / @jsxFrag / @jsxRuntime / @jsxImportSource / sourceMappingURL 的 span", () => {
  const spanText = (s: Span | null): string | null => (s === null ? null : Buffer.from(s.Text).toString());

  const jsx = capture("/* @jsx h */x", asJS);
  assert.equal(spanText(jsx.jsxFactory), "h");
  assert.deepEqual([jsx.jsxFactory!.Range.Loc.Start, jsx.jsxFactory!.Range.Len], [8, 1]);

  const frag = capture("// @jsxFrag Frag\nx", asJS);
  assert.equal(spanText(frag.jsxFragment), "Frag");
  assert.deepEqual([frag.jsxFragment!.Range.Loc.Start, frag.jsxFragment!.Range.Len], [12, 4]);
  assert.equal(spanText(frag.jsxFactory), null, "@jsxFrag 不得被当成 @jsx");

  const runtime = capture("// @jsxRuntime classic\nx", asJS);
  assert.equal(spanText(runtime.jsxRuntime), "classic");
  assert.deepEqual([runtime.jsxRuntime!.Range.Loc.Start, runtime.jsxRuntime!.Range.Len], [15, 7]);

  const importSource = capture("// @jsxImportSource foo/bar\nx", asJS);
  assert.equal(spanText(importSource.jsxImportSource), "foo/bar");
  assert.deepEqual(
    [importSource.jsxImportSource!.Range.Loc.Start, importSource.jsxImportSource!.Range.Len],
    [20, 7],
  );

  const sourceMap = capture("//# sourceMappingURL=foo.js.map\nx", asJS);
  assert.equal(spanText(sourceMap.sourceMappingURL), "foo.js.map");
  assert.deepEqual([sourceMap.sourceMappingURL!.Range.Loc.Start, sourceMap.sourceMappingURL!.Range.Len], [21, 10]);
});

test("HasCommentBefore 三个位：#__PURE__ / @__KEY__ / @__NO_SIDE_EFFECTS__", () => {
  const pure = capture("// @__PURE__\nx", asJS);
  assert.equal(pure.first!.HasCommentBefore, CommentBefore.PureCommentBefore);
  assert.deepEqual(pure.first!.Comments, [], "#__PURE__ 被从常规注释保留里剔除");

  const key = capture("/* #__KEY__ */x", asJS);
  assert.equal(key.first!.HasCommentBefore, CommentBefore.KeyCommentBefore);

  const noSideEffects = capture("// @__NO_SIDE_EFFECTS__\nx", asJS);
  assert.equal(noSideEffects.first!.HasCommentBefore, CommentBefore.NoSideEffectsCommentBefore);
});

test("legal comment：/*! … */ 与 @preserve 同时进 Comments 和 LegalComments", () => {
  const bang = capture("/*! MIT */x", asJS);
  assert.deepEqual(bang.first!.Comments, [[0, 10]]);
  assert.deepEqual(bang.first!.LegalComments, [[0, 10]]);

  const preserve = capture("// @preserve\nx", asJS);
  assert.deepEqual(preserve.first!.Comments, [[0, 12]]);
  assert.deepEqual(preserve.first!.LegalComments, [[0, 12]]);
});

test("不是 pragma 的注释：只有 CommentsBeforeToken，没有 flag 也没有 span", () => {
  const c = capture("// &amp; __PURE__\nx", asJS);
  assert.deepEqual(c.first!.Comments, [[0, 17]]);
  assert.equal(c.first!.HasCommentBefore, 0);
  assert.equal(c.jsxFactory, null);
});

test("hasPrefixWithWordBoundary：词边界判定（Go 实测的 12 组代表值）", () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  const cases: [string, string, boolean][] = [
    ["", "", true],
    ["", "a", false],
    ["abc", "a", false], // 'b' 是标识符续接字符
    ["abc", "ab", false],
    ["ab", "ab", true], // 恰好相等
    ["ab ", "ab", true], // 空格不是标识符续接
    ["ab1", "ab", false],
    ["ab_", "ab", false],
    ["ab-", "ab", true],
    ["__PURE__", "__PURE__", true],
    ["__PURE__x", "__PURE__", false],
    ["__PURE__", "ab", false],
  ];
  for (const [text, prefix, ok] of cases) {
    assert.equal(hasPrefixWithWordBoundary(enc(text), prefix), ok, `${JSON.stringify(text)} / ${JSON.stringify(prefix)}`);
  }
});

test("isUpperASCII / isLetterASCII：26 / 52 个命中（Go 实测计数）+ 边界", () => {
  let upper = 0;
  let letter = 0;
  for (let i = 0; i < 256; i++) {
    if (isUpperASCII(i)) upper++;
    if (isLetterASCII(i)) letter++;
  }
  assert.equal(upper, 26);
  assert.equal(letter, 52);
  assert.equal(isUpperASCII(0x41), true); // 'A'
  assert.equal(isUpperASCII(0x5a), true); // 'Z'
  assert.equal(isUpperASCII(0x5b), false); // '['
  assert.equal(isUpperASCII(0x60), false); // '`'
  assert.equal(isLetterASCII(0x61), true); // 'a'
  assert.equal(isLetterASCII(0x7a), true); // 'z'
  assert.equal(isLetterASCII(0x30), false); // '0'
});

test("IsAssign：Go 实测的 16 个赋值 token（52..67），其余一律 false", () => {
  // Go 探针输出（tmpassign_test.go，已删）：52 "&&=" / 53 "&=" / 54 "**=" / 55 "*=" /
  // 56 "||=" / 57 "|=" / 58 "^=" / 59 "=" / 60 ">>=" / 61 ">>>=" / 62 "<<=" /
  // 63 "-=" / 64 "%=" / 65 "+=" / 66 "??=" / 67 "/="
  const names = new Set([
    "TAmpersandAmpersandEquals",
    "TAmpersandEquals",
    "TAsteriskAsteriskEquals",
    "TAsteriskEquals",
    "TBarBarEquals",
    "TBarEquals",
    "TCaretEquals",
    "TEquals",
    "TGreaterThanGreaterThanEquals",
    "TGreaterThanGreaterThanGreaterThanEquals",
    "TLessThanLessThanEquals",
    "TMinusEquals",
    "TPercentEquals",
    "TPlusEquals",
    "TQuestionQuestionEquals",
    "TSlashEquals",
  ]);
  const actual = new Set<string>();
  for (const [name, value] of Object.entries(T)) {
    if (IsAssign(value as number)) actual.add(name);
  }
  assert.deepEqual([...actual].sort(), [...names].sort());
  assert.equal(IsAssign(T.TAmpersandAmpersandEquals - 1), false, "区间左端之前");
  assert.equal(IsAssign(T.TEndOfFile), false);
});
