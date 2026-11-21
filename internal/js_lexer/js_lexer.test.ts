// js_lexer 的**差分 oracle**：TS 实现 vs Go 实测夹具（逐 token / 逐 log 全等）。
//
// 期望值来源：testdata/lexer/tokens-from-esbuild-cases.part-00..03.jsonl（Go 侧的裸 token 循环，
// 1,738 例 / 15,886 token / 94 种 kindName / 73 条 log）与 testdata/lexer/tokens-lex-err.jsonl
// （116 例 expectLexerError 调用点）。两份都是 Go 参考实现的产物，测试只做比较，不产生期望值。
//
// 比较的字段（与 PLAN.md「第 5 次推进」写死的判据一致）：
//   token: kind / kindName / rawHex / start / len / nlBefore / commentBefore / comments(含 legal)
//          / valueHex / numberBits / valuePanic
//   log:   kind / text / hasLoc / line / col / len
//   case:  tokens / logs / endOfFile / stop / panic（+ 输入字节数与 sha256）
//
// 注意：TSyntaxError 是终止态；panic 分支（LexerPanic）必须原样复现——Go 是
// 「先 addRangeError 再 panic」的契约，TS 侧也一样（见 PLAN.md「第 11 次推进」§0 的分类结论）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Lexer, LexerPanic } from "./js_lexer.ts";
import { T } from "./tables.ts";
import { DeferLogKind, NewDeferLog, Source } from "../logger/logger.ts";

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

/** Go 的 token 名：从 tables.ts 的 T 反查（该表由 go/ast 读 iota 块生成） */
const KIND_NAME = new Map<number, string>();
for (const [name, value] of Object.entries(T)) KIND_NAME.set(value as number, name);

interface CommentRec {
  start: number;
  len: number;
  legal?: boolean;
}

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
  comments?: CommentRec[];
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

interface CaseDump {
  tokens: TokenRec[];
  logs: LogRec[];
  summary: CaseRec;
}

/** 与 Go 适配器（tools/gen_lexer_tokens.go 的 dumpCase）逐行等价 */
function dumpCase(name: string, contents: Uint8Array): CaseDump {
  const log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null);
  const source = new Source();
  source.Contents = contents;

  const tokens: TokenRec[] = [];
  const logs: LogRec[] = [];
  let panicValue: string | undefined;
  let endOfFile = false;
  let stop: string | undefined;

  // 硬上限：Go 侧不加会 OOM；TS 这里保留同样的语义（触上限 = 语料/实现异常，测试会红）
  const tokenCap = 500000;

  try {
    const lexer = Lexer.NewLexer(log, source, { Parse: false, NoAmbiguousLessThan: false });
    for (let i = 0; ; i++) {
      if (lexer.Token === T.TEndOfFile) {
        endOfFile = true;
        break;
      }
      if (i >= tokenCap) {
        panicValue = "tokenCap";
        stop = "tokenCap";
        break;
      }

      const comments: CommentRec[] = [];
      for (const cr of lexer.CommentsBeforeToken) {
        const rec: CommentRec = { start: cr.Loc.Start, len: cr.Len };
        for (const legal of lexer.LegalCommentsBeforeToken) {
          if (legal.Loc.Start === cr.Loc.Start && legal.Len === cr.Len) {
            rec.legal = true;
            break;
          }
        }
        comments.push(rec);
      }

      const rec: TokenRec = {
        r: "t",
        case: name,
        i,
        kind: lexer.Token,
        kindName: KIND_NAME.get(lexer.Token)!,
        rawHex: hex(lexer.Raw()),
        start: lexer.start,
        len: lexer.end - lexer.start,
      };
      if (lexer.HasNewlineBefore) rec.nlBefore = true;
      if (lexer.HasCommentBefore) rec.commentBefore = lexer.HasCommentBefore;
      if (comments.length > 0) rec.comments = comments;

      switch (lexer.Token) {
        case T.TIdentifier:
        case T.TEscapedKeyword:
        case T.TBigIntegerLiteral:
          rec.valueHex = hex(lexer.Identifier.String);
          break;

        case T.TStringLiteral:
        case T.TNoSubstitutionTemplateLiteral:
        case T.TTemplateHead:
        case T.TTemplateMiddle:
        case T.TTemplateTail:
          try {
            const units = lexer.StringLiteral();
            const buf = new Uint8Array(2 * units.length);
            for (let j = 0; j < units.length; j++) {
              buf[2 * j] = units[j] >> 8;
              buf[2 * j + 1] = units[j] & 0xff;
            }
            // Go 的 `json:"valueHex,omitempty"`：空字符串（例如 '' 解码为空）不写该字段
            if (buf.length > 0) rec.valueHex = hex(buf);
          } catch (e) {
            if (!(e instanceof LexerPanic)) throw e;
            rec.valuePanic = true;
          }
          break;

        case T.TNumericLiteral: {
          const dv = new DataView(new ArrayBuffer(8));
          dv.setFloat64(0, lexer.Number);
          const buf = new Uint8Array(dv.buffer);
          rec.numberBits = hex(buf);
          break;
        }
      }

      tokens.push(rec);
      if (rec.valuePanic) break;
      if (lexer.Token === T.TSyntaxError) {
        stop = "syntaxError";
        break;
      }
      lexer.Next();
    }
  } catch (e) {
    if (e instanceof LexerPanic) {
      panicValue = "LexerPanic";
    } else {
      throw e;
    }
  }

  for (const msg of log.Done()) {
    const l: LogRec = {
      r: "l",
      case: name,
      kind: msg.Kind,
      text: msg.Data.Text,
      hasLoc: false,
    };
    const loc = msg.Data.Location;
    if (loc !== null) {
      l.hasLoc = true;
      if (loc.Line !== 0) l.line = loc.Line;
      if (loc.Column !== 0) l.col = loc.Column;
      if (loc.Length !== 0) l.len = loc.Length;
    }
    logs.push(l);
  }

  const summary: CaseRec = {
    r: "c",
    case: name,
    contentsBytes: contents.length,
    contentsSha256: sha256(contents),
    tokens: tokens.length,
    logs: logs.length,
    endOfFile,
    contentsHex: hex(contents),
  };
  if (stop !== undefined) summary.stop = stop;
  if (panicValue !== undefined) summary.panic = panicValue;

  return { tokens, logs, summary };
}

interface LoadedCase {
  contents: Uint8Array;
  tokens: TokenRec[];
  logs: LogRec[];
  summary: CaseRec;
}

function loadCases(
  recs: (TokenRec | LogRec | CaseRec | SummaryRec)[],
  dir?: string,
): Map<string, LoadedCase> {
  const byCase = new Map<string, LoadedCase>();
  for (const r of recs) {
    if (r.r !== "c") continue;
    assert.equal(byCase.has(r.case), false, `duplicate case record: ${r.case}`);
    byCase.set(r.case, {
      contents: r.contentsHex !== undefined
        ? Buffer.from(r.contentsHex, "hex")
        : readFileSync(`${dir}/${r.case}`),
      tokens: [],
      logs: [],
      summary: r,
    });
  }
  for (const r of recs) {
    if (r.r === "c" || r.r === "s") continue;
    const entry = byCase.get(r.case);
    assert.ok(entry, `record for unknown case: ${r.case}`);
    if (r.r === "t") entry.tokens.push(r);
    else entry.logs.push(r);
  }
  return byCase;
}

function parseJsonl(raw: Uint8Array): (TokenRec | LogRec | CaseRec | SummaryRec)[] {
  return raw
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

interface DiffStats {
  cases: number;
  casesPassed: number;
  tokens: number;
  tokensMatched: number;
  logs: number;
  logsMatched: number;
  failures: string[];
}

function diffCases(byCase: Map<string, LoadedCase>): DiffStats {
  const stats: DiffStats = {
    cases: byCase.size,
    casesPassed: 0,
    tokens: 0,
    tokensMatched: 0,
    logs: 0,
    logsMatched: 0,
    failures: [],
  };

  for (const [name, expected] of byCase) {
    const actual = dumpCase(name, expected.contents);
    const local: string[] = [];

    // case 摘要
    const expSummary = { ...expected.summary } as Partial<CaseRec>;
    delete expSummary.contentsHex;
    const actSummary = { ...actual.summary } as Partial<CaseRec>;
    delete actSummary.contentsHex;
    if (JSON.stringify(expSummary) !== JSON.stringify(actSummary)) {
      local.push(`case: expected ${JSON.stringify(expSummary)} actual ${JSON.stringify(actSummary)}`);
    }

    // token 逐条
    const nTokens = Math.max(expected.tokens.length, actual.tokens.length);
    for (let i = 0; i < nTokens; i++) {
      stats.tokens++;
      const exp = expected.tokens[i];
      const act = actual.tokens[i];
      if (exp === undefined || act === undefined) {
        local.push(`token#${i}: ${exp === undefined ? "unexpected extra token" : "missing token"} ${JSON.stringify(act ?? exp)}`);
        continue;
      }
      if (JSON.stringify(exp) === JSON.stringify(act)) {
        stats.tokensMatched++;
      } else {
        local.push(`token#${i}: expected ${JSON.stringify(exp)} actual ${JSON.stringify(act)}`);
      }
    }

    // log 逐条
    const nLogs = Math.max(expected.logs.length, actual.logs.length);
    for (let i = 0; i < nLogs; i++) {
      stats.logs++;
      const exp = expected.logs[i];
      const act = actual.logs[i];
      if (exp === undefined || act === undefined) {
        local.push(`log#${i}: ${exp === undefined ? "unexpected extra log" : "missing log"} ${JSON.stringify(act ?? exp)}`);
        continue;
      }
      if (JSON.stringify(exp) === JSON.stringify(act)) {
        stats.logsMatched++;
      } else {
        local.push(`log#${i}: expected ${JSON.stringify(exp)} actual ${JSON.stringify(act)}`);
      }
    }

    if (local.length === 0) {
      stats.casesPassed++;
    } else {
      stats.failures.push(`${name}\n  ` + local.slice(0, 6).join("\n  "));
    }
  }

  return stats;
}

const V2_PARTS = [
  "testdata/lexer/tokens-from-esbuild-cases.part-00.jsonl",
  "testdata/lexer/tokens-from-esbuild-cases.part-01.jsonl",
  "testdata/lexer/tokens-from-esbuild-cases.part-02.jsonl",
  "testdata/lexer/tokens-from-esbuild-cases.part-03.jsonl",
];

test("js_lexer 差分 oracle（V1 单 token 片段）：166 例逐 token 全等（补 hashbang 分支）", () => {
  // V1 是单 token 片段，粒度无效（PLAN「第 10 次推进」§3.1），但它覆盖了 V2 抽样里缺失的
  // THashbang 等入口；夹具不内联输入，内容直接读 testdata/esbuild-cases-lex/<case>。
  const raw = readFileSync("testdata/lexer/tokens.jsonl");
  assert.equal(sha256(raw), "c2ce1c2beb2b434bbfd74fc5225ee0a38ae2730c53b99db4d7c47dcd4ad54f91", "tokens.jsonl 被侧改");

  const byCase = loadCases(parseJsonl(raw), "testdata/esbuild-cases-lex");
  const stats = diffCases(byCase);

  console.log(
    `V1 差分：cases ${stats.casesPassed}/${stats.cases} | tokens ${stats.tokensMatched}/${stats.tokens} | logs ${stats.logsMatched}/${stats.logs}`,
  );

  assert.equal(stats.failures.length, 0, stats.failures.slice(0, 5).join("\n\n"));
});

test("js_lexer 差分 oracle（V2 全量语料）：1,738 例逐 token 全等", () => {
  const all = Buffer.concat(V2_PARTS.map((p) => readFileSync(p)));
  assert.equal(sha256(all), "bbc3730dca283596a9289f45b1ca0456bc36d255341686ebbd4c1b3c167710da", "V2 夹具被侧改");

  const byCase = loadCases(parseJsonl(all));
  const stats = diffCases(byCase);

  console.log(
    `V2 差分：cases ${stats.casesPassed}/${stats.cases} | tokens ${stats.tokensMatched}/${stats.tokens} | logs ${stats.logsMatched}/${stats.logs}`,
  );

  assert.equal(stats.failures.length, 0, stats.failures.slice(0, 5).join("\n\n"));
});

test("js_lexer 差分 oracle（错误路径语料）：116 例逐 log 全等", () => {
  const raw = readFileSync("testdata/lexer/tokens-lex-err.jsonl");
  assert.equal(sha256(raw), "985f31867d7faae8b15887abad9379bfc9641dd3f510a0b5cbb8dcd16fe87b7d", "错误路径夹具被侧改");

  const byCase = loadCases(parseJsonl(raw));
  const stats = diffCases(byCase);

  console.log(
    `lex-err 差分：cases ${stats.casesPassed}/${stats.cases} | tokens ${stats.tokensMatched}/${stats.tokens} | logs ${stats.logsMatched}/${stats.logs}`,
  );

  assert.equal(stats.failures.length, 0, stats.failures.slice(0, 5).join("\n\n"));
});
