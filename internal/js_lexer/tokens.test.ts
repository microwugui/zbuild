// js_lexer 的 token 级 oracle 基准（Go 侧产出；TS 侧 lexer 尚未移植，所以这里只做「基准自洽」校验）。
//
// 期望值来源（Go 实测，不是手写）：
//   把 tools/gen_lexer_tokens.go 拷成 /root/esbuild/internal/js_lexer/tmpadapter_test.go，然后
//   LEX_DIR=/root/port/testdata/esbuild-cases-lex LEX_OUT=/tmp/tokens.jsonl \
//     go test -run TestTmpDumpTokens -count=1 ./internal/js_lexer/
//   产物即 testdata/lexer/tokens.jsonl（每行一个记录，r = "t"(token) / "l"(log) / "c"(case 摘要)）。
//   适配器只「取结构体并打印」，不做归一化；token 的枚举名由 go/ast 从 js_lexer.go 的 iota 块读出。
//
// 判据（PLAN.md「第 5 次推进」已写死）：kind / raw（字节 hex）/ range / newlineBefore / comments /
// value（identifier 字节、字符串 UTF-16 码元、number 的 IEEE754 位）/ 报错的 kind + 原文，全等才算通过。
// 本轮先用「raw 必须等于输入在 [start, start+len) 的切片」这类不变量把基准本身钉死。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

interface TokenRec {
  r: "t";
  case: string;
  i: number;
  kind: number;
  kindName: string;
  rawHex: string;
  start: number;
  len: number;
  nlBefore?: boolean;
  commentBefore?: number;
  comments?: { start: number; len: number; legal?: boolean }[];
  valueHex?: string;
  numberBits?: string;
  valuePanic?: boolean;
}

interface LogRec {
  r: "l";
  case: string;
  kind: number;
  text: string;
  hasLoc: boolean;
  line?: number;
  col?: number;
  len?: number;
}

interface CaseRec {
  r: "c";
  case: string;
  contentsBytes: number;
  contentsSha256: string;
  tokens: number;
  logs: number;
  endOfFile: boolean;
  stop?: string;
  panic?: string;
  contentsHex?: string;
}

interface SummaryRec {
  r: "s";
  cases: number;
  tokens: number;
  distinctKinds: number;
  logs: number;
  skippedDuplicates: number;
}

test("js_lexer token 基准 V1（对照基准，粒度无效，仅留档）：166 个单 token 片段", () => {
  const raw = readFileSync("testdata/lexer/tokens.jsonl");
  assert.equal(sha256(raw), "c2ce1c2beb2b434bbfd74fc5225ee0a38ae2730c53b99db4d7c47dcd4ad54f91", "tokens.jsonl 被侧改");

  const recs = raw
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TokenRec | LogRec | CaseRec);

  const cases = recs.filter((r): r is CaseRec => r.r === "c");
  assert.equal(cases.length, 166, "语料条数（testdata/esbuild-cases-lex/*.js）");

  const byCase = new Map<string, { tokens: TokenRec[]; logs: LogRec[]; summary: CaseRec }>();
  // 记录顺序：某用例的 token/log 在前、case 摘要在后（适配器逐用例收尾才写摘要），所以先收摘要
  for (const r of recs) {
    if (r.r === "c") {
      assert.equal(byCase.has(r.case), false, `duplicate case record: ${r.case}`);
      byCase.set(r.case, { tokens: [], logs: [], summary: r });
    }
  }
  for (const r of recs) {
    if (r.r === "c") continue;
    const entry = byCase.get(r.case);
    assert.ok(entry, `record for unknown case: ${r.case}`);
    if (r.r === "t") entry.tokens.push(r);
    else entry.logs.push(r);
  }

  let totalTokens = 0;
  let totalLogs = 0;
  for (const [name, entry] of byCase) {
    const contents = readFileSync(`testdata/esbuild-cases-lex/${name}`);
    assert.equal(contents.length, entry.summary.contentsBytes, `${name} 字节数`);
    assert.equal(sha256(contents), entry.summary.contentsSha256, `${name} 内容 sha256`);
    assert.equal(entry.tokens.length, entry.summary.tokens, `${name} token 计数`);
    assert.equal(entry.logs.length, entry.summary.logs, `${name} log 计数`);
    assert.equal(entry.summary.endOfFile, true, `${name} 必须扫到 TEndOfFile`);
    assert.equal(entry.summary.panic, undefined, `${name} 不应 panic`);

    let prevStart = -1;
    entry.tokens.forEach((t, i) => {
      assert.equal(t.i, i, `${name} token 序号`);
      assert.ok(t.kindName.length > 0, `${name}#${i} kindName 不能为空`);
      assert.ok(t.start >= 0 && t.len >= 0, `${name}#${i} range`);
      assert.ok(t.start >= prevStart, `${name}#${i} range 必须单调不减`);
      prevStart = t.start;
      // 关键不变量：raw 必须就是输入在 [start, start+len) 的字节切片（证明适配器没有归一化）
      const slice = contents.subarray(t.start, t.start + t.len);
      assert.equal(Buffer.from(slice).toString("hex"), t.rawHex, `${name}#${i} raw 切片`);
      for (const c of t.comments ?? []) {
        assert.ok(c.start >= 0 && c.start + c.len <= contents.length, `${name}#${i} comment range`);
      }
    });
    totalTokens += entry.tokens.length;
    totalLogs += entry.logs.length;
  }

  // 本轮基准的实测规模：166 例 / 170 token / 0 条 log / 0 次 panic。
  // 注意：这份语料是「片段」（多来自 expectString/expectNumber 用例），几乎每个文件只有 1 个 token，
  // 因此判据里的「非法数字 / 非法转义报错」那一条**本轮没有覆盖到**（见 PLAN.md「第 9 次推进」§3 的缺口）。
  // 改语料就要同时改这里的两行数字 —— 这是故意的：避免覆盖面被悄悄改小。
  assert.equal(totalTokens, 170);
  assert.equal(totalLogs, 0);
});

// ---------------------------------------------------------------------------
// V2 基准：直接扫 `testdata/esbuild-cases` 的完整文件（不再用单 token 片段）
//
// 生成（Go 实测，不是手写）：
//   LEX_ROOT=/root/port LEX_DIRS=/root/port/testdata/esbuild-cases LEX_STRIDE=2 \
//     LEX_OUT=/tmp/tok-v2.jsonl go test -run TestTmpDumpTokens ./internal/js_lexer/
//   然后 split -l 4425 -d --additional-suffix=.jsonl（单文件拉取上限 1MiB，拆 4 片）
//
// 抽样规则是**确定性**的：排序后的文件列表取每第 2 个；去掉 LEX_STRIDE 即全量（3,476 例 / 31,570 token / 98 kind）。
// 为什么抽样：全量夹具 5.5MB，抽样后 2.6MB，而覆盖的 kind 只少 4 个 punctuator（实测见 PLAN §3）。
//
// 已知的结构性缺口（不是语料缩水造成的）：`TRegExpLiteral` / `TTemplateMiddle` / `TTemplateTail`
// 在裸 token 循环里**根本不出现** —— 它们必须由 parser 主动重扫（`js_parser.go:3716` 的 `ScanRegExp()`、
// `js_parser.go:5571` / `ts_parser.go:461` 的 `RescanCloseBraceAsTemplateToken()`），留给 parser 阶段。
// ---------------------------------------------------------------------------

const V2_PARTS = [
  "testdata/lexer/tokens-from-esbuild-cases.part-00.jsonl",
  "testdata/lexer/tokens-from-esbuild-cases.part-01.jsonl",
  "testdata/lexer/tokens-from-esbuild-cases.part-02.jsonl",
  "testdata/lexer/tokens-from-esbuild-cases.part-03.jsonl",
];

test("js_lexer token 基准 V2（完整文件）：硬下限 + 每条记录自洽", () => {
  const all = Buffer.concat(V2_PARTS.map((p) => readFileSync(p)));
  // 拼接后的整体哈希：分片被换/被改都会失败
  assert.equal(sha256(all), "bbc3730dca283596a9289f45b1ca0456bc36d255341686ebbd4c1b3c167710da", "V2 夹具被侧改");

  const recs = all
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TokenRec | LogRec | CaseRec | SummaryRec);

  const summaries = recs.filter((r): r is SummaryRec => r.r === "s");
  assert.equal(summaries.length, 1, "必须恰好一条 summary 记录");
  const summary = summaries[0];

  const byCase = new Map<string, { tokens: TokenRec[]; logs: LogRec[]; summary: CaseRec }>();
  for (const r of recs) {
    if (r.r === "c") {
      assert.equal(byCase.has(r.case), false, `duplicate case record: ${r.case}`);
      byCase.set(r.case, { tokens: [], logs: [], summary: r });
    }
  }
  for (const r of recs) {
    if (r.r === "c" || r.r === "s") continue;
    const entry = byCase.get(r.case);
    assert.ok(entry, `record for unknown case: ${r.case}`);
    if (r.r === "t") entry.tokens.push(r);
    else entry.logs.push(r);
  }

  const kinds = new Set<string>();
  let totalTokens = 0;
  let totalLogs = 0;
  let panicked = 0;
  let syntaxErrorStops = 0;
  let tokenCapStops = 0;
  let valuePanicTokens = 0;

  for (const [name, entry] of byCase) {
    // 夹具内联了输入字节（LEX_INLINE=1）：`testdata/esbuild-cases` 本身不进 local 镜像时，
    // 这条测试仍然能在本地跑（否则就只能在远端验证）。
    assert.ok(entry.summary.contentsHex, `${name} 缺少内联输入`);
    const contents = Buffer.from(entry.summary.contentsHex!, "hex");
    assert.equal(contents.length, entry.summary.contentsBytes, `${name} 字节数`);
    assert.equal(sha256(contents), entry.summary.contentsSha256, `${name} 内容 sha256`);
    assert.equal(entry.tokens.length, entry.summary.tokens, `${name} token 计数`);
    assert.equal(entry.logs.length, entry.summary.logs, `${name} log 计数`);

    if (entry.summary.panic) panicked++;
    if (entry.summary.stop === "syntaxError") syntaxErrorStops++;
    if (entry.summary.stop === "tokenCap") tokenCapStops++;

    let prevStart = -1;
    entry.tokens.forEach((t, i) => {
      assert.equal(t.i, i, `${name} token 序号`);
      assert.ok(t.kindName.length > 0, `${name}#${i} kindName 不能为空`);
      assert.ok(t.start >= prevStart, `${name}#${i} range 必须单调不减（TSyntaxError 之后停机）`);
      prevStart = t.start;
      const slice = contents.subarray(t.start, t.start + t.len);
      assert.equal(Buffer.from(slice).toString("hex"), t.rawHex, `${name}#${i} raw 切片`);
      for (const c of t.comments ?? []) {
        assert.ok(c.start >= 0 && c.start + c.len <= contents.length, `${name}#${i} comment range`);
      }
      if (t.valuePanic) valuePanicTokens++;
      kinds.add(t.kindName);
    });
    totalTokens += entry.tokens.length;
    totalLogs += entry.logs.length;
  }

  // 硬下限：语料缩水 / 被换成单 token 片段时，这里会红（比逐 token 比对更能防「验证变软」）
  assert.ok(kinds.size >= 30, `不同 kindName 只有 ${kinds.size} 种（下限 30）`);
  assert.ok(totalTokens >= 10000, `token 总数只有 ${totalTokens}（下限 10000）`);
  assert.ok(totalLogs >= 20, `log 只有 ${totalLogs} 条（下限 20）`);

  // summary 记录必须与逐 case 统计完全一致（防止适配器自己的计数漂移）
  assert.equal(summary.cases, byCase.size);
  assert.equal(summary.tokens, totalTokens);
  assert.equal(summary.logs, totalLogs);
  assert.equal(summary.distinctKinds, kinds.size);

  // 本夹具范围内不得出现 tokenCap（出现就说明有输入让 token 流不推进，必须查清再入库）
  assert.equal(tokenCapStops, 0, "出现 tokenCap 停机：有输入让 token 流不推进");

  // 实测规模钉死（改语料就要同步改这几行）
  assert.equal(byCase.size, 1738);
  assert.equal(totalTokens, 15886);
  assert.equal(totalLogs, 73);
  assert.equal(kinds.size, 94);
  assert.equal(panicked, 63);
  assert.equal(syntaxErrorStops, 8);
  // StringLiteral() 解码时 panic 的用例（非法转义）：token 流到此为止，log 里有原文
  assert.equal(valuePanicTokens, 5);
});

// ---------------------------------------------------------------------------
// 错误路径基准：`testdata/esbuild-cases-lex-err`（从 js_lexer_test.go 的
// expectLexerError / expectLexerErrorString 调用点提取，118 候选 → 去重后 116 例）
//
// 生成：tools/extract_esbuild_cases.go（第 10 次推进改了分流：lexer 的 Error 调用点单独入库）
//   → /tmp/corpus/esbuild-cases-lex-err/*.js
// 再由同一 token 适配器：
//   LEX_ROOT=/root/port LEX_DIRS=/root/port/testdata/esbuild-cases-lex-err LEX_OUT=…
// ---------------------------------------------------------------------------

test("js_lexer 错误路径基准：116 例非法输入，每例都有 Go 的报错 kind + 原文", () => {
  const raw = readFileSync("testdata/lexer/tokens-lex-err.jsonl");
  assert.equal(sha256(raw), "985f31867d7faae8b15887abad9379bfc9641dd3f510a0b5cbb8dcd16fe87b7d", "错误路径夹具被侧改");

  const recs = raw
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TokenRec | LogRec | CaseRec | SummaryRec);

  const cases = new Map<string, { tokens: TokenRec[]; logs: LogRec[]; summary: CaseRec }>();
  for (const r of recs) if (r.r === "c") cases.set(r.case, { tokens: [], logs: [], summary: r });
  for (const r of recs) {
    if (r.r === "c" || r.r === "s") continue;
    const entry = cases.get(r.case);
    assert.ok(entry, `record for unknown case: ${r.case}`);
    if (r.r === "t") entry.tokens.push(r);
    else entry.logs.push(r);
  }

  const texts = new Set<string>();
  let totalLogs = 0;
  let valuePanics = 0;
  for (const [name, entry] of cases) {
    // 这份语料**不进仓库目录**（从 js_lexer_test.go 现场提），所以夹具内联了输入字节；
    // 这样测试不依赖那 116 个文件是否被同步到本地，同时仍然可校验内容哈希。
    assert.ok(entry.summary.contentsHex, `${name} 缺少内联输入`);
    const contents = Buffer.from(entry.summary.contentsHex!, "hex");
    assert.equal(contents.length, entry.summary.contentsBytes, `${name} 字节数`);
    assert.equal(sha256(contents), entry.summary.contentsSha256, `${name} 内容 sha256`);
    // 错误路径语料的关键性质：**每一例**都必须至少产生一条 Go 报错
    assert.ok(entry.logs.length >= 1, `${name} 没有报错（那就不是错误路径语料）`);
    for (const l of entry.logs) {
      assert.equal(l.kind, 0, `${name} lexer 报错必须是 Error(0)，实际 ${l.kind}`);
      assert.ok(l.text.length > 0, `${name} 报错原文不能为空`);
      texts.add(l.text);
    }
    for (const t of entry.tokens) {
      if (t.valuePanic) valuePanics++;
      // raw 仍然是输入的精确切片（哪怕走到了报错路径）
      const slice = contents.subarray(t.start, t.start + t.len);
      assert.equal(Buffer.from(slice).toString("hex"), t.rawHex, `${name} raw 切片`);
    }
    totalLogs += entry.logs.length;
  }

  assert.equal(cases.size, 116);
  assert.ok(totalLogs >= 100, `报错总数只有 ${totalLogs}`);
  assert.ok(texts.size >= 10, `不同报错原文只有 ${texts.size} 种`);
  // 这三条是 Go 原文（夹具里直接能看到），钉住以免将来误以为可以“统一改写”
  assert.ok(texts.has("Unterminated string literal"));
  assert.ok(texts.has("Unexpected end of file"));
  assert.ok(texts.has('Syntax error "_"'));
  // 非法转义走的是 StringLiteral() panic 路径（不是顶层的 TSyntaxError）
  assert.equal(valuePanics, 10);
});
