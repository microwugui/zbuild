// 对应 esbuild internal/logger/logger.go 的差分测试。
// 期望值由 Go 参考实现现场跑出（临时程序 `go run ./tmplogcheck`，直接调用 logger.Range 的方法）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { init } from "../helpers/init.ts";
import { createHash } from "node:crypto";

import {
  AddError,
  AddErrorWithNotes,
  AddID,
  AddIDWithNotes,
  AddMsgID,
  allowOverride,
  DeferLogKind,
  Error as MsgKindError,
  Icon as msgKindIcon,
  Loc,
  LogLevel,
  LogStyle,
  MakeLineColumnTracker,
  Msg,
  MsgData,
  MsgKind,
  MsgLocation,
  NewDeferLog,
  NewStderrLog,
  OutputOptions,
  OutputOptionsForArgs,
  Path,
  PathFlags,
  PathStyle,
  PlatformIndependentPathDirBaseExt,
  PrettyPaths,
  PrintErrorToStderr,
  PrintErrorWithNoteToStderr,
  PrintMessageToStderr,
  PrintSummary,
  PrintText,
  PrintTextWithColor,
  Range,
  SortableMsgs,
  Source,
  String as msgKindString,
  SummaryTable,
  SummaryTableEntry,
  TerminalInfo,
  UseColor,
  EncodeImportAttributes,
  ImportAttributes,
  errorAndWarningSummary,
  hasNoColorEnvironmentVariable,
  isProbablyWindowsCommandPrompt,
  plural,
} from "./logger.ts";
import type { FileLike } from "./logger.ts";
import { MsgID_JS_EqualsNaN, StringToMsgIDs } from "./msg_ids.ts";

test("Range.End: Loc.Start + Len（logger.go:185-187）", () => {
  assert.equal(new Range(new Loc(10), 5).End(), 15); // Go: end=15
  assert.equal(new Range(new Loc(0), 0).End(), 0);
});

test("Range.ExpandBy: Len==0 时整体替换，否则并集（logger.go:189-202）", () => {
  const zero = new Range(new Loc(3), 0);
  zero.ExpandBy(new Range(new Loc(7), 2));
  assert.deepEqual([zero.Loc.Start, zero.Len], [7, 2]); // Go: expand_zero,7,2

  const inside = new Range(new Loc(12), 1);
  inside.ExpandBy(new Range(new Loc(10), 2));
  assert.deepEqual([inside.Loc.Start, inside.Len], [10, 3]); // Go: expand_inside,10,3

  const right = new Range(new Loc(10), 2);
  right.ExpandBy(new Range(new Loc(14), 3));
  assert.deepEqual([right.Loc.Start, right.Len], [10, 7]); // Go: expand_right,10,7

  const left = new Range(new Loc(10), 2);
  left.ExpandBy(new Range(new Loc(4), 2));
  assert.deepEqual([left.Loc.Start, left.Len], [4, 8]); // Go: expand_left,4,8

  const cover = new Range(new Loc(10), 2);
  cover.ExpandBy(new Range(new Loc(5), 20));
  assert.deepEqual([cover.Loc.Start, cover.Len], [5, 20]); // Go: expand_cover,5,20
});

test("Loc: int32 语义（Go 里 Start 是 int32）", () => {
  assert.equal(new Loc(0x7fffffff).Start, 0x7fffffff);
  assert.equal(new Loc(-1).Start, -1);
});

// ---------------------------------------------------------------------------
// 以下期望值由 Go 参考实现现场跑出：在 `internal/logger` 包内放一个临时 _test.go
// 调未导出函数（`errorAndWarningSummary` / `plural` / `EncodeImportAttributes`），
// 跑 `go test ./internal/logger -run TestTmpProbe` 后删除临时文件。
// ---------------------------------------------------------------------------

test("EncodeImportAttributes: 小端长度前缀 + 字节序键排序（logger.go:302-330）", () => {
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
  const enc = (o: Record<string, string>) => {
    const m = new Map<string, Uint8Array>();
    const te = new TextEncoder();
    for (const [k, v] of Object.entries(o)) m.set(k, te.encode(v));
    return EncodeImportAttributes(m);
  };

  // Go 实测：hex_empty="" / hex_type / hex_ba
  assert.equal(hex(new ImportAttributes().packedData), "");
  assert.equal(hex(enc({ type: "json" }).packedData), "0400000074797065040000006a736f6e");
  assert.equal(hex(enc({ b: "2", a: "1" }).packedData), "0100000061010000003101000000620100000032");
});

test("ImportAttributes: 解码顺序与 map 回读对齐 Go（logger.go:275-300）", () => {
  const te = new TextEncoder();
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
  const enc = (o: Record<string, string>) => {
    const m = new Map<string, Uint8Array>();
    for (const [k, v] of Object.entries(o)) m.set(k, te.encode(v));
    return EncodeImportAttributes(m);
  };

  // Go: attrs0 count=0 / map0 nil
  assert.deepEqual(new ImportAttributes().DecodeIntoArray(), []);
  assert.equal(new ImportAttributes().DecodeIntoMap(), null);

  // Go: attrs1 type=json
  const a1 = enc({ type: "json" }).DecodeIntoArray();
  assert.equal(a1.length, 1);
  assert.equal(new TextDecoder().decode(a1[0].Key), "type");
  assert.equal(new TextDecoder().decode(a1[0].Value), "json");

  // Go: attrs2 a=1;b=2;c=3（按键的字节序排）
  const a2 = enc({ b: "2", a: "1", c: "3" }).DecodeIntoArray();
  assert.deepEqual(a2.map((x) => new TextDecoder().decode(x.Key)), ["a", "b", "c"]);
  assert.deepEqual(a2.map((x) => new TextDecoder().decode(x.Value)), ["1", "2", "3"]);

  // Go: attrs3 a=first;z=last
  const a3 = enc({ z: "last", a: "first" }).DecodeIntoArray();
  assert.deepEqual(a3.map((x) => new TextDecoder().decode(x.Key)), ["a", "z"]);

  // Go: attrs4 e=y;é=x（'e'=0x65 排在 0xC3 0xA9 前，字节序而非码点序）
  const a4 = enc({ "\u00e9": "x", e: "y" }).DecodeIntoArray();
  assert.deepEqual(a4.map((x) => new TextDecoder().decode(x.Key)), ["e", "\u00e9"]);
  assert.equal(hex(a4[1].Key), "c3a9");

  const map4 = enc({ "\u00e9": "x", e: "y" }).DecodeIntoMap()!;
  assert.equal(map4.size, 2);
  assert.equal(new TextDecoder().decode(map4.get("\u00e9")!), "x");
});

test("Path.IsDisabled: 只看 PathDisabled 位（logger.go:332-334）", () => {
  const p = new Path();
  assert.equal(p.IsDisabled(), false);
  p.Flags = PathFlags.PathDisabled;
  assert.equal(p.IsDisabled(), true);
  p.Flags = 0xfe;
  assert.equal(p.IsDisabled(), false);
});

test("plural: 与 Go 的 %d/%s 拼接逐字一致（logger.go:638-651）", () => {
  assert.equal(plural("warning", 1, 1, false), "1 warning");
  assert.equal(plural("warning", 0, 0, false), "0 warnings");
  assert.equal(plural("error", 2, 2, false), "2 errors");
  assert.equal(plural("error", 2, 2, true), "all 2 errors");
  assert.equal(plural("warning", 5, 3, false), "3 of 5 warnings");
  assert.equal(plural("error", 1, 1, true), "1 error"); // count==1 时不加 all
});

test("errorAndWarningSummary: 8 组输出对齐 Go（logger.go:653-666）", () => {
  // Go 输出（参数顺序：errors, warnings, shownErrors, shownWarnings）
  const rows: [number, number, number, number, string][] = [
    [1, 1, 1, 0, "0 of 1 warning and 1 error"],
    [0, 0, 0, 0, "0 warnings"],
    [2, 2, 2, 0, "0 of 2 warnings and all 2 errors"],
    [5, 3, 3, 0, "0 of 3 warnings and 3 of 5 errors"],
    [2, 1, 2, 0, "0 of 1 warning and all 2 errors"],
    [3, 2, 3, 0, "0 of 2 warnings and all 3 errors"],
    [0, 3, 0, 1, "1 of 3 warnings"],
    [1, 2, 1, 2, "2 warnings and 1 error"],
  ];
  for (const [e, w, se, sw, want] of rows) assert.equal(errorAndWarningSummary(e, w, se, sw), want);
});

test("SortableMsgs.Less/Len/Swap: 比较矩阵与 Go 完全一致（logger.go:210-243）", () => {
  const mk = (abs: string, rel: string, line: number, col: number, kind: number, text: string) => {
    const m = new Msg();
    m.Kind = kind;
    m.Data = new MsgData();
    m.Data.Text = text;
    m.Data.Location = new MsgLocation();
    m.Data.Location.File = new PrettyPaths();
    m.Data.Location.File.Abs = abs;
    m.Data.Location.File.Rel = rel;
    m.Data.Location.Line = line;
    m.Data.Location.Column = col;
    return m;
  };
  const withNil = new Msg();
  withNil.Kind = 1;
  withNil.Data = new MsgData();
  withNil.Data.Text = "no-location";

  const msgs = new SortableMsgs([
    withNil,
    mk("b.js", "b.js", 1, 0, 2, "bb"),
    mk("a.js", "a.js", 2, 0, 1, "aa"),
    mk("a.js", "a.js", 1, 5, 1, "cc"),
    mk("a.js", "a.js", 1, 5, 0, "dd"),
  ]);
  assert.equal(msgs.Len(), 5);

  // Go 实测的 less 对集合
  const want = [[0, 1], [0, 2], [0, 3], [0, 4], [2, 1], [3, 1], [3, 2], [4, 1], [4, 2], [4, 3]];
  const got: number[][] = [];
  for (let i = 0; i < msgs.Len(); i++) {
    for (let j = 0; j < msgs.Len(); j++) if (msgs.Less(i, j)) got.push([i, j]);
  }
  assert.deepEqual(got, want);

  msgs.Swap(0, 1);
  assert.equal(msgs.msgs[0].Data.Text, "bb"); // Go: swap01,"bb","no-location"
  assert.equal(msgs.msgs[1].Data.Text, "no-location");
});

// ---------------------------------------------------------------------------
// Source：内容用 Uint8Array，全部 range 按字节（决策记录见 PLAN.md「第 6 次推进」）。
// 期望值来自 Go 探针 `go run ./tmpsrccheck`（已删），字符串一律以 hex 比，避免编码歧义。
// ---------------------------------------------------------------------------

const enc = (s: string) => new TextEncoder().encode(s);
const hx = (b: Uint8Array) => Buffer.from(b).toString("hex");
const src = (s: string) => {
  const x = new Source();
  x.Contents = enc(s);
  return x;
};
const at = (s: string, sub: string) => {
  // 注意：必须按**字节**找位置（要测的正是字节偏移），不能用 JS string 的 indexOf
  const bytes = enc(s);
  const needle = enc(sub);
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return i;
  }
  assert.fail(`找不到子串 ${sub}`);
};

test("Source.TextForRange: 返回字节切片（Go: string 就是字节串）", () => {
  const text = 'const x = "hello" + 1;';
  const s = src(text);
  assert.equal(hx(s.TextForRange(new Range(new Loc(10), 7))), "2268656c6c6f22"); // Go: s1.text_bytes

  // 非 ASCII: é 占 2 字节，range 按字节取到 "héllo" 的残缺片段也要与 Go 一致
  const s2 = src('const é = "héllo";');
  assert.equal(hx(s2.TextForRange(new Range(new Loc(12), 7))), "68c3a96c6c6f22"); // Go: s2.text_bytes
});

test("Source.LocBeforeWhitespace: 只跳过 ASCII 空白，非 ASCII 不被吃掉", () => {
  const s = src('const x = "hello" + 1;');
  assert.equal(s.LocBeforeWhitespace(new Loc(12)).Start, 12); // Go: s1.locws=12

  const s2 = src('const é = "héllo"; 中文 ');
  assert.equal(s2.Contents.length, 28);
  assert.equal(s2.LocBeforeWhitespace(new Loc(28)).Start, 27); // Go: s2.locws=27（末尾空格被跳过）
});

test("Source.RangeOfOperatorBefore/After: 字节级 Index/LastIndex", () => {
  const text = 'const x = "hello" + 1;';
  const s = src(text);
  const eq = at(text, "=");
  const before = s.RangeOfOperatorBefore(new Loc(eq), "=");
  assert.deepEqual([before.Loc.Start, before.Len], [8, 0]); // Go: s1.op_before,start=8,len=0

  const after = s.RangeOfOperatorAfter(new Loc(at(text, '"hello"')), "+");
  assert.deepEqual([after.Loc.Start, after.Len], [18, 1]); // Go: s1.op_after
});

test("Source.RangeOfString: 引号/转义/模板字面量（含 `${` 截断）", () => {
  const text = 'const x = "hello" + \'a\\\'b\' + 1;';
  const s = src(text);
  const dq = s.RangeOfString(new Loc(at(text, '"hello"')));
  assert.deepEqual([dq.Loc.Start, dq.Len], [10, 7]); // Go: s1.str_dq
  const sq = s.RangeOfString(new Loc(at(text, "'a")));
  assert.deepEqual([sq.Loc.Start, sq.Len], [20, 6]); // Go: s1.str_sq

  const s3 = src("const a = `abc`; const b = `a${x}b`;");
  const plain = s3.RangeOfString(new Loc(10));
  assert.deepEqual([plain.Loc.Start, plain.Len], [10, 5]); // Go: s3.tmpl_plain
  const sub = s3.RangeOfString(new Loc(27));
  assert.deepEqual([sub.Loc.Start, sub.Len], [27, 0]); // Go: s3.tmpl_sub

  const s2 = src('const é = "héllo";');
  const str = s2.RangeOfString(new Loc(11));
  assert.deepEqual([str.Loc.Start, str.Len], [11, 8]); // Go: s2.str（é 算 2 字节）
});

test("Source.RangeOfNumber / RangeOfLegacyOctalEscape", () => {
  const text = 'const x = "hello" + 123 + 0o777;';
  const s = src(text);
  const num = s.RangeOfNumber(new Loc(at(text, "123")));
  assert.deepEqual([num.Loc.Start, num.Len], [at(text, "123"), 3]); // Go: s1.num,len=3
  // Go 实测：loc 指向 "0o" 前一个字节（空格）时返回 len=0（不是反斜杠就不是八进制转义）
  const octal = s.RangeOfLegacyOctalEscape(new Loc(at(text, "0o") - 1));
  assert.deepEqual([octal.Loc.Start, octal.Len], [at(text, "0o") - 1, 0]);
  // 非数字开头
  const notNum = s.RangeOfNumber(new Loc(0));
  assert.deepEqual([notNum.Loc.Start, notNum.Len], [0, 0]);
});

test("Source.CommentTextWithoutIndent: 去缩进 + 非 ASCII 不做偏移计算", () => {
  // ASCII: 首行保留，后续行按 min(indent, 前导空白) 切
  const s4text = "code();\n    /* line1\n       line2\n         line3 */\n";
  const s4 = src(s4text);
  const a4 = at(s4text, "/*");
  const b4 = at(s4text, "*/") + 2;
  assert.equal(
    hx(s4.CommentTextWithoutIndent(new Range(new Loc(a4), b4 - a4))),
    "2f2a206c696e65310a2020206c696e65320a20202020206c696e6533202a2f",
  ); // Go: s4.comment_bytes

  // 非 ASCII: 中文注释 + é，字节 range 与 Go 一致
  const s2text = 'const é = "héllo"; 中文 /* 注释\n   second */\n';
  const s2 = src(s2text);
  const a2 = at(s2text, "/*");
  const b2 = at(s2text, "*/") + 2;
  assert.deepEqual([a2, b2 - a2], [28, 22]); // Go: s2.comment_range
  assert.equal(
    hx(s2.CommentTextWithoutIndent(new Range(new Loc(a2), b2 - a2))),
    "2f2a20e6b3a8e9878a0a7365636f6e64202a2f",
  ); // Go: s2.comment_bytes

  // U+2028 行分隔符（3 字节）也要分行
  const s5text = "x\n/* a\u2028   b */\n";
  const s5 = src(s5text);
  const a5 = at(s5text, "/*");
  const b5 = at(s5text, "*/") + 2;
  assert.equal(
    hx(s5.CommentTextWithoutIndent(new Range(new Loc(a5), b5 - a5))),
    "2f2a20610a20202062202a2f",
  ); // Go: s5.comment_bytes
});

test("Source: 非 ASCII 下所有 range 用字节偏移（不得转成 UTF-16 下标）", () => {
  const s = src('const é = "héllo";');
  // 若误用码元下标，length 会是 18 而不是 20
  assert.equal(s.Contents.length, 20);
  const quote = s.Contents.indexOf(0x22);
  assert.equal(quote, 11);
  const r = s.RangeOfString(new Loc(quote));
  assert.deepEqual([r.Loc.Start, r.Len], [11, 8]);
  assert.equal(hx(s.TextForRange(r)), "22 68 c3 a9 6c 6c 6f 22".replace(/ /g, ""));
});

// ---------------------------------------------------------------------------
// 第 7 次推进：MakeLineColumnTracker / default style / 打印器
//
// 期望值来源（全部由 Go 现场跑出，见 testdata/logger/）：
// - tracker.json：Go 探针 `tmpmsgfmt tracker`，对同一份 contents 按指定偏移序列调
//   MakeLineColumnTracker + MsgLocationOrNil，打出 line:column:lineText(hex)；
//   asc/desc 顺序验证增量扫描（scanTo 前进 / 后退），fresh 验证新建 tracker 的冷路径。
// - cases.json + *.stderr：真实 /tmp/esbuild-go 跑真实语料的整段 stderr（--color=false）；
//   并已用探针 `tmpmsgfmt fmt` 以同一个 Msg 重放，与 CLI 逐字节相等（见 PLAN.md）。
// - printer.json / loglevel.json：探针 `tmpmsgfmt printer|loglimit` 的原始输出。
// ---------------------------------------------------------------------------

class MemoryFile implements FileLike {
  chunks: Uint8Array[] = [];

  WriteString(text: Uint8Array): void {
    this.chunks.push(text);
  }

  hex(): string {
    return Buffer.concat(this.chunks.map((c) => Buffer.from(c))).toString("hex");
  }
}

/** 对应 Go 里「临时把 os.Stderr 换成管道」的手法；PrintSummary 内部固定写 stderr */
function captureStderr(fn: () => void): string {
  const original = process.stderr.write;
  const chunks: Buffer[] = [];
  (process.stderr as unknown as { write: (b: Uint8Array) => boolean }).write = (b: Uint8Array): boolean => {
    chunks.push(Buffer.from(b));
    return true;
  };
  try {
    fn();
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
  }
  return Buffer.concat(chunks).toString("hex");
}

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

// 夹具哈希钉死：防止「侧改夹具让它通过」（生成器见 tools/gen_logger_fixtures.go）
test("logger 夹具未被侧改（sha256）", () => {
  const pins: [string, string][] = [
    ["testdata/logger/tracker.json", "9692b747906e5687e149ba5ed513721a1210412f505ae0b822d6f22ea6af4d60"],
    ["testdata/logger/printer.json", "a9f67e71c5055820ab809f716ca3d07818cd8b68b70dae7b79315c89ed837b90"],
    ["testdata/logger/loglevel.json", "87ffc4d8b50096b74b1a7eaa47c3abdf2f5e53cd9592cfbf6af718869b76316e"],
    ["testdata/logger/cases.json", "a4d9736261843e8428cd437a64ebd16dc3ecd497c461b0dc957949ff95425c0f"],
  ];
  for (const [file, want] of pins) assert.equal(sha256(readFileSync(file)), want, file);
});

test("MakeLineColumnTracker: line/column/lineText 与 Go 全等（含 CRLF / U+2028 / 非法 UTF-8）", () => {
  const truth = JSON.parse(readFileSync("testdata/logger/tracker.json", "utf8")) as {
    cases: { name: string; contentsHex: string; mode: string; offsets: number[]; expected: string[] }[];
  };
  for (const c of truth.cases) {
    const source = new Source();
    source.Contents = Buffer.from(c.contentsHex, "hex");
    const tracker = MakeLineColumnTracker(source);
    const got: string[] = [];
    for (const offset of c.offsets) {
      const t = c.mode === "fresh" ? MakeLineColumnTracker(source) : tracker;
      const loc = t.MsgLocationOrNil(new Range(new Loc(offset)));
      got.push(loc === null ? "nil" : `${loc.Line}:${loc.Column}:${Buffer.from(loc.LineText).toString("hex")}`);
    }
    assert.deepEqual(got, c.expected, c.name);
  }
});

test("MakeLineColumnTracker: nil source → hasSource=false、MsgLocationOrNil 返回 nil", () => {
  const tracker = MakeLineColumnTracker(null);
  assert.equal(tracker.hasSource, false);
  assert.equal(tracker.MsgLocationOrNil(new Range(new Loc(0))), null);
  const data = tracker.MsgData(new Range(new Loc(0)), "x");
  assert.equal(data.Location, null);
  assert.equal(data.Text, "x");
});

test("LineColumnTracker.MsgData: Location 的 File 是拷贝（Go 值语义）", () => {
  const source = new Source();
  source.Contents = new TextEncoder().encode("a\nbc");
  source.PrettyPaths.Rel = "rel.js";
  const tracker = MakeLineColumnTracker(source);
  const data = tracker.MsgData(new Range(new Loc(2), 1), "boom");
  assert.ok(data.Location !== null);
  assert.deepEqual([data.Location!.Line, data.Location!.Column, data.Location!.Length], [2, 0, 1]);
  assert.equal(data.Location!.File.Rel, "rel.js");
  source.PrettyPaths.Rel = "changed.js";
  assert.equal(data.Location!.File.Rel, "rel.js");
});

test("PrintMessageToStderr: 真实用例与 Go CLI stderr 逐字节相等（--color=false）", () => {
  const truth = JSON.parse(readFileSync("testdata/logger/cases.json", "utf8")) as {
    cases: {
      name: string;
      source: string;
      sourceSha256: string;
      args: string[];
      stderr: string;
      stderrSha256: string;
      msgs: {
        kind: number;
        id: number;
        text: string;
        plugin: string;
        start: number;
        len: number;
        notes: { text: string; start: number; len: number; hasLocation: boolean }[];
      }[];
    }[];
  };

  for (const c of truth.cases) {
    const contents = readFileSync(c.source);
    assert.equal(sha256(contents), c.sourceSha256, `${c.name} source`);
    const expected = readFileSync(c.stderr);
    assert.equal(sha256(expected), c.stderrSha256, `${c.name} stderr`);

    const source = new Source();
    source.Contents = contents;
    source.PrettyPaths.Rel = "<stdin>";
    const tracker = MakeLineColumnTracker(source);

    const file = new MemoryFile();
    const log = NewStderrLog(OutputOptionsForArgs([...c.args, "--color=false"]), file);
    for (const m of c.msgs) {
      const msg = new Msg();
      msg.Kind = m.kind;
      msg.ID = m.id;
      msg.PluginName = m.plugin;
      msg.Data = tracker.MsgData(new Range(new Loc(m.start), m.len), m.text);
      for (const n of m.notes) {
        if (n.hasLocation) {
          msg.Notes.push(tracker.MsgData(new Range(new Loc(n.start), n.len), n.text));
        } else {
          const d = new MsgData();
          d.Text = n.text;
          msg.Notes.push(d);
        }
      }
      log.AddMsg(msg);
    }
    log.Done();

    assert.equal(file.hex(), Buffer.from(expected).toString("hex"), c.name);
  }
});

test("PrintErrorToStderr / PrintErrorWithNoteToStderr / PrintText / PrintTextWithColor / PrintSummary 与 Go 全等", () => {
  const truth = JSON.parse(readFileSync("testdata/logger/printer.json", "utf8")) as {
    errorText: string;
    noteText: string;
    summary: { dir: string; base: string; size: string; bytes: number; isSourceMap: boolean }[];
    cases: { name: string; hex: string }[];
  };
  const byName = new Map(truth.cases.map((c) => [c.name, c.hex]));
  const args = ["--color=false"];
  const enc = (s: string) => new TextEncoder().encode(s);

  let f = new MemoryFile();
  PrintErrorToStderr(args, truth.errorText, f);
  assert.equal(f.hex(), byName.get("print-error"));

  f = new MemoryFile();
  PrintErrorWithNoteToStderr(args, truth.errorText, truth.noteText, f);
  assert.equal(f.hex(), byName.get("print-error-note"));

  f = new MemoryFile();
  PrintText(f, LogLevel.Info, args, (colors) => enc("text:" + colors.Red + "x" + colors.Reset + "\n"));
  assert.equal(f.hex(), byName.get("print-text-loglevel"));

  f = new MemoryFile();
  PrintText(f, LogLevel.Verbose, ["--log-level=info"], () => enc("must not appear\n"));
  assert.equal(f.hex(), byName.get("print-text-silenced"));

  f = new MemoryFile();
  PrintTextWithColor(f, UseColor.ColorAlways, (colors) =>
    enc("a" + colors.Red + "b" + colors.Reset + "c" + colors.Bold + "d" + colors.Reset + "\n"));
  assert.equal(f.hex(), byName.get("print-text-color-always"));

  f = new MemoryFile();
  PrintTextWithColor(f, UseColor.ColorNever, (colors) => enc("a" + colors.Red + "b" + colors.Reset + "\n"));
  assert.equal(f.hex(), byName.get("print-text-color-never"));

  f = new MemoryFile();
  PrintTextWithColor(f, UseColor.ColorIfTerminal, (colors) => enc("t" + colors.Green + "u" + colors.Reset + "\n"));
  assert.equal(f.hex(), byName.get("print-text-color-if-terminal"));

  // PrintSummary 内部固定写 stderr（与 Go 一致）：临时把 stderr.write 换成收集器
  const mkTable = () =>
    new SummaryTable(truth.summary.map((e) => init(new SummaryTableEntry(), {
      Dir: e.dir, Base: e.base, Size: e.size, Bytes: e.bytes, IsSourceMap: e.isSourceMap,
    })));
  assert.equal(captureStderr(() => PrintSummary(UseColor.ColorNever, mkTable(), null)), byName.get("print-summary"));
  assert.equal(captureStderr(() => PrintSummary(UseColor.ColorAlways, mkTable(), null)), byName.get("print-summary-color"));

  // 默认 file 参数 = stderr（对应 Go 里直接写 os.Stderr）
  const msg = new Msg();
  msg.Kind = MsgKind.Error;
  msg.Data.Text = truth.errorText;
  assert.equal(captureStderr(() => PrintMessageToStderr(args, msg)), byName.get("print-error"));
});

test("PrintSummary: start 非 nil 时输出 ⚡ Done in Nms（时间不可比，只钉格式）", () => {
  const text = Buffer.from(
    captureStderr(() => PrintSummary(UseColor.ColorNever, new SummaryTable([]), new Date(Date.now() - 5))),
    "hex",
  ).toString("utf8");
  assert.match(text, /^\n⚡ Done in \d+ms\n$/);
});

test("NewStderrLog: message limit / deferred warnings / log level 与 Go 全等", () => {
  const truth = JSON.parse(readFileSync("testdata/logger/loglevel.json", "utf8")) as {
    cases: { name: string; messageLimit: number; logLevel: number; msgs: { kind: number; text: string }[]; outputHex: string }[];
  };
  for (const c of truth.cases) {
    const file = new MemoryFile();
    const options = new OutputOptions();
    options.MessageLimit = c.messageLimit;
    options.LogLevel = c.logLevel;
    options.Color = UseColor.ColorNever;
    const log = NewStderrLog(options, file);
    for (const m of c.msgs) {
      const msg = new Msg();
      msg.Kind = m.kind;
      msg.Data.Text = m.text;
      log.AddMsg(msg);
    }
    log.Done();
    assert.equal(file.hex(), c.outputHex, c.name);
  }
});

test("MsgKind.String / Icon: 6 个 kind 与 Go 逐字相等，非法 kind 抛错（logger.go:61-118）", () => {
  const kinds = [MsgKind.Error, MsgKind.Warning, MsgKind.Info, MsgKind.Note, MsgKind.Debug, MsgKind.Verbose];
  assert.deepEqual(kinds.map((k) => msgKindString(k)), ["ERROR", "WARNING", "INFO", "NOTE", "DEBUG", "VERBOSE"]);
  assert.deepEqual(kinds.map((k) => msgKindIcon(k)), ["✘", "▲", "▶", "→", "●", "⬥"]);
  assert.throws(() => msgKindString(6));
  assert.throws(() => msgKindIcon(6));
  assert.equal(MsgKindError, 0);
});

test("isProbablyWindowsCommandPrompt / hasNoColorEnvironmentVariable", () => {
  if (process.platform !== "win32") assert.equal(isProbablyWindowsCommandPrompt(), false);
  assert.equal(hasNoColorEnvironmentVariable(), process.env.NO_COLOR !== undefined);
});

test("OutputOptionsForArgs: 各开关与 Go 逐项一致（含源码里的 --log-level=clang 笔误）", () => {
  const d = OutputOptionsForArgs([]);
  assert.equal(d.IncludeSource, true);
  assert.equal(d.MessageLimit, 0);
  assert.equal(d.Color, UseColor.ColorIfTerminal);
  assert.equal(d.LogLevel, LogLevel.None);
  assert.equal(d.LogStyle, LogStyle.StyleDefault);
  assert.equal(d.PathStyle, PathStyle.RelPath);

  assert.equal(OutputOptionsForArgs(["--color=false"]).Color, UseColor.ColorNever);
  assert.equal(OutputOptionsForArgs(["--color"]).Color, UseColor.ColorAlways);
  assert.equal(OutputOptionsForArgs(["--color=true"]).Color, UseColor.ColorAlways);
  assert.equal(OutputOptionsForArgs(["--log-level=info"]).LogLevel, LogLevel.Info);
  assert.equal(OutputOptionsForArgs(["--log-level=warning"]).LogLevel, LogLevel.Warning);
  assert.equal(OutputOptionsForArgs(["--log-level=error"]).LogLevel, LogLevel.Error);
  assert.equal(OutputOptionsForArgs(["--log-level=silent"]).LogLevel, LogLevel.Silent);
  assert.equal(OutputOptionsForArgs(["--log-style=default"]).LogStyle, LogStyle.StyleDefault);
  assert.equal(OutputOptionsForArgs(["--log-level=clang"]).LogStyle, LogStyle.StyleClang);
  assert.equal(OutputOptionsForArgs(["--log-level=visualstudio"]).LogStyle, LogStyle.StyleVisualStudio);
  assert.equal(OutputOptionsForArgs(["--unknown"]).LogLevel, LogLevel.None);
});

test("PrettyPaths.Select: RelPath 取 Rel，AbsPath 取 Abs（logger.go:431-437）", () => {
  const p = new PrettyPaths();
  p.Abs = "/abs/a.js";
  p.Rel = "a.js";
  assert.equal(p.Select(PathStyle.RelPath), "a.js");
  assert.equal(p.Select(PathStyle.AbsPath), "/abs/a.js");
});

test("Msg.String: clang / visualstudio 已移植（第 84 轮），三风格均可输出且互不相同", () => {
  const msg = new Msg();
  msg.Data.Text = "x";
  const options = new OutputOptions();
  options.IncludeSource = true;
  const terminalInfo = new TerminalInfo();
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

  options.LogStyle = LogStyle.StyleDefault;
  const def = hex(msg.String(options, terminalInfo));
  options.LogStyle = LogStyle.StyleClang;
  const clang = hex(msg.String(options, terminalInfo));
  options.LogStyle = LogStyle.StyleVisualStudio;
  const vs = hex(msg.String(options, terminalInfo));
  // 逐字节真值由 style_extra.test.ts 对齐 Go；这里只验证 dispatch 不再抛错、三风格各异。
  assert.ok(def.length > 0 && clang.length > 0 && vs.length > 0);
  assert.notEqual(clang, def);
  assert.notEqual(vs, def);
  assert.notEqual(vs, clang);
});

// ---------------------------------------------------------------------------
// 第 8 次推进：Log.Add* / allowOverride / NewDeferLog
// 期望值：`testdata/logger/logapi.json`，由 Go 探针 `tmplogapi`（源码见 tools/gen_log_add_fixtures.go）打出：
// add* 是 NewStderrLog 的原始 stderr 字节 hex（含 override 降级 / 抑制 / plugin / msgID / notes），
// defer* 是 NewDeferLog 的 Done() 摘要（kind/id/text 顺序 + hasErrors + Peek 长度）。
// ---------------------------------------------------------------------------

test("Log.AddError/AddID/AddErrorWithNotes/AddIDWithNotes/AddMsgID + NewDeferLog 与 Go 全等", () => {
  const truth = JSON.parse(readFileSync("testdata/logger/logapi.json", "utf8")) as {
    contents: string;
    logLevel: number;
    overrides: Record<string, number> | null;
    cases: {
      name: string; api: string; start: number; len: number; text: string; id: number; kind: number;
      plugin: string; notes: string[] | null; outputHex: string;
    }[];
    defer: { name: string; kind: number; overrides: Record<string, number> | null; msgs: { kind: number; id: number; text: string }[]; outputHex: string }[];
  };

  assert.equal(sha256(readFileSync("testdata/logger/logapi.json")), "8eb67afdc364e556cd386611fcd33b03e3ea52855833f0572dccc59bd155609d");

  const toMap = (o: Record<string, number> | null) => {
    const m = new Map<number, number>();
    for (const [k, v] of Object.entries(o ?? {})) m.set(Number(k), v);
    return m;
  };

  const source = new Source();
  source.Contents = new TextEncoder().encode(truth.contents);
  source.PrettyPaths.Rel = "<stdin>";
  const tracker = MakeLineColumnTracker(source);

  for (const c of truth.cases) {
    const file = new MemoryFile();
    const options = new OutputOptions();
    options.IncludeSource = true;
    options.Color = UseColor.ColorNever;
    options.LogLevel = truth.logLevel;
    options.Overrides = toMap(truth.overrides);
    const log = NewStderrLog(options, file);

    const r = new Range(new Loc(c.start), c.len);
    const notes: MsgData[] = [];
    for (const n of c.notes ?? []) {
      const d = new MsgData();
      d.Text = n;
      notes.push(d);
    }

    switch (c.api) {
      case "error":
        AddError(log, tracker, r, c.text);
        break;
      case "id":
        AddID(log, c.id, c.kind, tracker, r, c.text);
        break;
      case "error-notes":
        AddErrorWithNotes(log, tracker, r, c.text, notes);
        break;
      case "id-notes":
        AddIDWithNotes(log, c.id, c.kind, tracker, r, c.text, notes);
        break;
      case "msg-id": {
        const msg = new Msg();
        msg.Kind = c.kind;
        msg.PluginName = c.plugin;
        msg.Data = tracker.MsgData(r, c.text);
        msg.Notes = notes;
        AddMsgID(log, c.id, msg);
        break;
      }
      default:
        assert.fail(`unknown api: ${c.api}`);
    }
    log.Done();
    assert.equal(file.hex(), c.outputHex, c.name);
  }

  for (const d of truth.defer) {
    const log = NewDeferLog(d.kind, d.overrides === null ? null : toMap(d.overrides));
    for (const m of d.msgs) {
      const msg = new Msg();
      msg.Kind = m.kind;
      msg.ID = m.id;
      msg.Data.Text = m.text;
      log.AddMsg(msg);
    }
    const peek = log.Peek();
    let text = `hasErrors=${log.HasErrors()} peek=${peek.length} done=`;
    log.Done().forEach((m, i) => {
      if (i > 0) text += ";";
      text += `${m.Kind}/${m.ID}/${m.Data.Text}`;
    });
    assert.equal(Buffer.from(text).toString("hex"), d.outputHex, d.name);
  }

  // allowOverride 的 6 个分支（Go: LevelVerbose..LevelSilent，其中 LevelNone/Silent 都静默）
  assert.deepEqual(allowOverride(new Map([[6, LogLevel.Warning]]), 6, MsgKind.Error), { kind: MsgKind.Warning, ok: true });
  assert.deepEqual(allowOverride(new Map([[6, LogLevel.Error]]), 6, MsgKind.Warning), { kind: MsgKind.Error, ok: true });
  assert.deepEqual(allowOverride(new Map([[7, LogLevel.Silent]]), 7, MsgKind.Error), { kind: 0, ok: false });
  assert.deepEqual(allowOverride(new Map([[7, LogLevel.None]]), 7, MsgKind.Error), { kind: 0, ok: false });
  assert.deepEqual(allowOverride(null, 7, MsgKind.Info), { kind: MsgKind.Info, ok: true });
  assert.deepEqual(allowOverride(new Map(), 7, MsgKind.Info), { kind: MsgKind.Info, ok: true });
  assert.equal(DeferLogKind.DeferLogAll, 0);
  assert.equal(DeferLogKind.DeferLogNoVerboseOrDebug, 1);
});

// ---------------------------------------------------------------------------
// 第 9 次推进：真实文件名输入（不是 stdin）的 CLI 字节证据
//
// 期望值来源（全部 Go 实测，不是构造）：
// - `testdata/logger/cli-*.stderr`：真实 `/tmp/esbuild-go`（0.28.2）以 **cwd=/root/port** 跑
//   `testdata/logger/src/cli-*.js` 的整段 stderr（`--color=false`）。
// - `testdata/logger/cli-paths.json`：探针 `tools/gen_cli_path_fixtures.go`（mode=build）产物。
//   探针把同一入口的 `api.Message` 提成 Msg（start/len 由 line/column 反推 + tracker 回读校验），
//   并用 Go 的 `logger.NewStderrLog` 重放，与真实 CLI stderr 逐字节相等（不等 panic）。
//   所以「喂给 TS 的 Msg 就是 Go 当初用的那个」是探针断言过的。
// - Rel/Abs 两个路径串也是 Go 给的：同一入口跑两遍 Build（AbsPaths=0 / LogAbsPath），
//   要求除 Location.File 外全等，再回读 api.Message.Location.File（即 PrettyPaths.Select 的结果）。
// ---------------------------------------------------------------------------

test("真实文件名输入的 CLI 证据：path:line:col / Abs+Rel / warning 的 msgID 与 override 逐字节相等", () => {
  assert.equal(
    sha256(readFileSync("testdata/logger/cli-paths.json")),
    "0cb6ecd350f7569f9510548de1e765f451db2c3ecb89f2a5cb5860afe4ea8325",
    "cli-paths.json 被侧改",
  );

  const truth = JSON.parse(readFileSync("testdata/logger/cli-paths.json", "utf8")) as {
    cases: {
      name: string;
      entry: string;
      cliArgs: string[];
      stderr: string;
      stderrBytes: number;
      stderrSha256: string;
      contentsSha256: string;
      relPath: string;
      absPath: string;
      pathStyle: number;
      overrides: string[];
      emittedKinds: number[];
      msgs: {
        kind: number;
        idName: string;
        id: number;
        text: string;
        plugin: string;
        start: number;
        len: number;
        line: number;
        col: number;
        notes: { text: string; start: number; len: number; hasLocation: boolean }[];
      }[];
    }[];
  };

  const levelFromName = (name: string): number => {
    switch (name) {
      case "verbose": return LogLevel.Verbose;
      case "debug": return LogLevel.Debug;
      case "info": return LogLevel.Info;
      case "warning": return LogLevel.Warning;
      case "error": return LogLevel.Error;
      case "silent": return LogLevel.Silent;
      default: assert.fail(`unknown log level: ${name}`);
    }
  };

  const byName = new Map(truth.cases.map((c) => [c.name, c]));
  assert.deepEqual([...byName.keys()], ["file-rel", "file-abs", "warn-id", "warn-override"]);

  for (const c of truth.cases) {
    const contents = readFileSync(c.entry);
    assert.equal(sha256(contents), c.contentsSha256, `${c.name} 源文件`);
    const expected = readFileSync(c.stderr);
    assert.equal(expected.length, c.stderrBytes, `${c.name} stderr 字节数`);
    assert.equal(sha256(expected), c.stderrSha256, `${c.name} stderr sha256`);

    const source = new Source();
    source.Contents = new Uint8Array(contents);
    source.PrettyPaths.Abs = c.absPath;
    source.PrettyPaths.Rel = c.relPath;
    const tracker = MakeLineColumnTracker(source);

    const options = new OutputOptions();
    options.IncludeSource = true;
    options.MessageLimit = 6; // CLI 默认（pkg/cli/cli_impl.go:1092）
    options.Color = UseColor.ColorNever; // 对应 --color=false
    options.LogLevel = LogLevel.Info; // CLI 默认（pkg/cli/cli_impl.go:1093）
    options.PathStyle = c.pathStyle === PathStyle.AbsPath ? PathStyle.AbsPath : PathStyle.RelPath;
    options.Overrides = new Map();
    for (const raw of c.overrides) {
      const eq = raw.indexOf("=");
      assert.ok(eq > 0, `bad override: ${raw}`);
      // 与 CLI 同入口：pkg/cli 的 --log-override:name=level 最终也走 StringToMsgIDs
      StringToMsgIDs(raw.slice(0, eq), levelFromName(raw.slice(eq + 1)), options.Overrides);
    }

    const file = new MemoryFile();
    const log = NewStderrLog(options, file);
    for (const m of c.msgs) {
      const msg = new Msg();
      msg.Kind = m.kind;
      msg.PluginName = m.plugin;
      msg.Data = tracker.MsgData(new Range(new Loc(m.start), m.len), m.text);
      for (const n of m.notes) {
        if (n.hasLocation) {
          msg.Notes.push(tracker.MsgData(new Range(new Loc(n.start), n.len), n.text));
        } else {
          const d = new MsgData();
          d.Text = n.text;
          msg.Notes.push(d);
        }
      }
      // 与 Go 侧同一条上报通道：id==0 走 AddError（js_lexer 的 JSX 报错），
      // id!=0 走 AddMsgID（js_parser 的 equals-nan 警告，override 也在这条路上生效）。
      if (m.id !== 0) AddMsgID(log, m.id, msg);
      else log.AddMsg(msg);
    }
    log.Done();

    assert.equal(file.hex(), Buffer.from(expected).toString("hex"), c.name);
  }

  // 把「这条用例钉住了什么」写成可读断言，防止将来悄悄改夹具把覆盖面弄丢
  const rel = readFileSync("testdata/logger/cli-file-rel.stderr", "utf8");
  const abs = readFileSync("testdata/logger/cli-file-abs.stderr", "utf8");
  const warn = readFileSync("testdata/logger/cli-warn-id.stderr", "utf8");
  const override = readFileSync("testdata/logger/cli-warn-override.stderr", "utf8");
  assert.ok(rel.includes("    testdata/logger/src/cli-bad.js:2:8:\n"), "Rel 路径 + 真实行号/列号");
  assert.ok(abs.includes("    /root/port/testdata/logger/src/cli-bad.js:2:8:\n"), "Abs 路径（--abs-paths=log）");
  assert.ok(warn.includes("▲ [WARNING] Comparison with NaN") && warn.includes("[equals-nan]\n"), "WARNING 图标 + msgID 后缀");
  assert.ok(warn.endsWith("1 warning\n"), "warning 汇总行");
  assert.ok(override.includes("✘ [ERROR] Comparison with NaN") && override.includes("[equals-nan]\n"), "override 把 warning 改成 error");
  assert.ok(override.endsWith("1 error\n"), "override 后的汇总行");
});

test("Log.AddMsgID 是值参数：不改调用方的 Msg（Go 探针实测）", () => {
  const truth = JSON.parse(readFileSync("testdata/logger/cli-paths.json", "utf8")) as {
    addMsgIDCallerKind: number;
    addMsgIDCallerID: number;
    addMsgIDCallerDataText: string;
    addMsgIDEmittedKind: number;
    addMsgIDEmittedID: number;
  };
  // 期望值由 Go 给出：AddMsgID 之后调用方 Kind/ID 仍是原值，只有发出去的副本被改写
  assert.deepEqual([truth.addMsgIDCallerKind, truth.addMsgIDCallerID], [MsgKind.Warning, 0]);
  assert.deepEqual([truth.addMsgIDEmittedKind, truth.addMsgIDEmittedID], [MsgKind.Error, MsgID_JS_EqualsNaN]);

  const log = NewDeferLog(DeferLogKind.DeferLogAll, new Map([[MsgID_JS_EqualsNaN, LogLevel.Error]]));
  const msg = new Msg();
  msg.Kind = MsgKind.Warning;
  msg.Data.Text = truth.addMsgIDCallerDataText;
  AddMsgID(log, MsgID_JS_EqualsNaN, msg);

  assert.equal(msg.Kind, truth.addMsgIDCallerKind, "调用方 Kind 不应被改写");
  assert.equal(msg.ID, truth.addMsgIDCallerID, "调用方 ID 不应被改写");
  const done = log.Done();
  assert.equal(done.length, 1);
  assert.equal(done[0].Kind, truth.addMsgIDEmittedKind);
  assert.equal(done[0].ID, truth.addMsgIDEmittedID);
  assert.equal(done[0].Data.Text, truth.addMsgIDCallerDataText);
});

// 第 16 次推进：PlatformIndependentPathDirBaseExt（import 命名的前置函数）。期望值来自 Go 探针
// tmpgenpaths16（真实调用 logger.PlatformIndependentPathDirBaseExt）。
test("PlatformIndependentPathDirBaseExt 与 Go 逐例相同（含 Windows / .module.css）", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("../../../testdata/js_ast/paths.json", import.meta.url), "utf8"),
  ) as { platformIndependentPathDirBaseExt: { in: string; dir: string; base: string; ext: string }[] };
  assert.ok(fixture.platformIndependentPathDirBaseExt.length >= 30);
  for (const e of fixture.platformIndependentPathDirBaseExt) {
    const got = PlatformIndependentPathDirBaseExt(e.in);
    assert.deepEqual(got, { dir: e.dir, base: e.base, ext: e.ext }, `PlatformIndependentPathDirBaseExt(${JSON.stringify(e.in)})`);
  }
});
