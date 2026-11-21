// 对应 esbuild internal/logger/style.go + style_default.go 的差分测试。
//
// 期望值来源：`testdata/logger/style.json`，由 Go 探针 `tmpmsgfmt style` 打出（已删）：
// 探针手工构造 `Msg` / `MsgLocation`，调 `msg.String(OutputOptions{IncludeSource, Color:ColorNever},
// TerminalInfo{Width, UseColorEscapes})`，把输出**原始字节的 hex** 打出来。
// 覆盖：长行裁剪（居中 / 行首 / 行尾 marker）、制表符展开、宽字符列宽、note 折行（40/120/0 宽）、
// suggestion 三行块、颜色 + https 链接、插件名 + msgID、无 IncludeSource、Note kind、AbsPath。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { Msg, MsgData, MsgLocation, OutputOptions, PrettyPaths, TerminalInfo, UseColor } from "./logger.ts";
import { estimateWidthInTerminal, formatLineSpan, linkifyText, renderTabStops, wrapWordsInString } from "./style.ts";

const truth = JSON.parse(readFileSync("testdata/logger/style.json", "utf8")) as {
  cases: {
    name: string;
    lineTextHex: string;
    line: number;
    column: number;
    length: number;
    text: string;
    kind: number;
    id: number;
    plugin: string;
    suggestion: string;
    notes: string[];
    width: number;
    useColor: boolean;
    disableMaximumWidth: boolean;
    pathStyle: number;
    includeSource: boolean;
    outputHex: string;
  }[];
};

const hx = (b: Uint8Array) => Buffer.from(b).toString("hex");

// 夹具哈希钉死：防止「侧改夹具让它通过」（生成器见 tools/gen_logger_fixtures.go）
test("style 夹具未被侧改（sha256）", () => {
  const hash = createHash("sha256").update(readFileSync("testdata/logger/style.json")).digest("hex");
  assert.equal(hash, "603351022cb6ac3b6aaa8d3039d8b2700fdb4aa6b03e579dda8c7935e58ed9dd");
});

test("default style: msg.String 逐字节对齐 Go 探针（17 例）", () => {
  for (const c of truth.cases) {
    const msg = new Msg();
    msg.Kind = c.kind;
    msg.ID = c.id;
    msg.PluginName = c.plugin;

    const data = new MsgData();
    data.Text = c.text;
    data.DisableMaximumWidth = c.disableMaximumWidth;

    const loc = new MsgLocation();
    loc.File = new PrettyPaths();
    loc.File.Rel = "rel.js";
    loc.File.Abs = "/abs/rel.js";
    loc.LineText = Buffer.from(c.lineTextHex, "hex");
    loc.Line = c.line;
    loc.Column = c.column;
    loc.Length = c.length;
    loc.Suggestion = c.suggestion;
    data.Location = loc;
    msg.Data = data;

    for (const note of c.notes) {
      const d = new MsgData();
      d.Text = note;
      msg.Notes.push(d);
    }

    const options = new OutputOptions();
    options.IncludeSource = c.includeSource;
    options.Color = UseColor.ColorNever;
    options.PathStyle = c.pathStyle;

    const terminalInfo = new TerminalInfo();
    terminalInfo.Width = c.width;
    terminalInfo.UseColorEscapes = c.useColor;

    assert.equal(hx(msg.String(options, terminalInfo)), c.outputHex, c.name);
  }
});

test("estimateWidthInTerminal: 按码点计列宽，跳过 U+FEFF（style.go:256-270）", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  assert.equal(estimateWidthInTerminal(enc("abc")), 3);
  assert.equal(estimateWidthInTerminal(enc("a\u{1F355}b")), 3); // emoji 是 1 个码点
  assert.equal(estimateWidthInTerminal(enc("\uFEFFabc")), 3); // BOM 不计列
  assert.equal(estimateWidthInTerminal(new Uint8Array([0xff, 0x61])), 2); // 非法字节算 1 个码点
});

test("renderTabStops: 制表符按 2 列展开（style.go:272-294）", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  assert.deepEqual([...renderTabStops(enc("ab\tc"), 2)], [...enc("ab  c")]);
  assert.deepEqual([...renderTabStops(enc("\t\tx"), 2)], [...enc("    x")]);
  // 没有制表符时原样返回（同一引用，Go 也直接 return withTabs）
  const plain = enc("no-tabs");
  assert.equal(renderTabStops(plain, 2), plain);
});

test("linkifyText: underline 为空时原样返回；否则按 https:// 切开（style.go:16-57）", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const text = enc("see https://example.com/a_b. ok");
  assert.equal(linkifyText(text, "", ""), text);
  // Go 实测（包内临时 _test.go 探针）：末尾标点被排除在链接外，但仍会输出
  assert.equal(hx(linkifyText(text, "<", ">")), hx(enc("see <https://example.com/a_b>. ok")));
  assert.equal(hx(linkifyText(enc("https://x.y/z)"), "[", "]")), hx(enc("[https://x.y/z])")));
  assert.equal(hx(linkifyText(enc("see https://example.com/a_b ok"), "<", ">")), hx(enc("see <https://example.com/a_b> ok")));
});

test("wrapWordsInString: 折行结果与 Go 完全一致（style.go:59-119）", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const runs = wrapWordsInString(enc("one two three four"), 9);
  assert.deepEqual(runs.map((r) => Buffer.from(r).toString()), ["one two", "three", "four"]);
  // 空串返回 [""]
  assert.deepEqual(wrapWordsInString(new Uint8Array(0), 10).map((r) => r.length), [0]);
});

test("formatLineSpan: 裁剪/标记/缩进与 Go 一致（style.go:125-254）", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const span = formatLineSpan(enc("abcdefghij"), 1, 4, 1, 1);
  assert.equal(Buffer.from(span.firstLineBefore).toString(), "");
  assert.equal(Buffer.from(span.firstLineMarked).toString(), "e");
  assert.equal(Buffer.from(span.firstLineAfter).toString(), "");
  assert.equal(Buffer.from(span.marker).toString(), "^");
  assert.equal(Buffer.from(span.indent).toString(), "");
  assert.equal(Buffer.from(span.afterFirstLine).toString(), "");
});
