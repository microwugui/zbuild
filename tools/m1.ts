#!/usr/bin/env node
/**
 * tools/m1.ts —— M1 判据的常驻差分通道（Parse+Print，逐字节）
 *
 * 判据（PLAN.md「第 16 次推进」§2）：
 *   Go 侧  = js_parser.Parse + js_printer.Print，**不经 linker**
 *   TS 侧  = 直接 Parse + Print，**不经过 src/cli.ts 的 IsExport 替身**
 * 两侧同一份源、同一套 Options（OutputFormat=FormatESModule）、同一个 KeyPath "<stdin>"。
 *
 * 防自证循环：
 *   1. 语料由目录扫描确定性生成（排序后），源字节聚合 sha256 钉在 tools/parseprint.json；
 *   2. Go 端由常驻生成器 /root/esbuild/tmpgenparseprint 当场重新运行，
 *      其 stdout 的 sha256 必须与 parseprint.json 的 referenceSha256 一致，否则判 stale 直接失败。
 *
 * 输出指标：
 *   - 逐字节相等数 / Go 可解析数（N）
 *   - 首差异字节：中位数 / 最大值（仅统计有差异的用例）
 *   - TS parse/print 失败数（单独列，不混进「差异」）
 *
 * 用法：
 *   npm run m1            # 跑一遍，写 m1.json 并打印指标
 *   npm run m1:check      # 额外校验 pin 与 equalBaseline（只许升不许降）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";

import { Log, Msg, Path as LogPath, Source } from "../src/internal/logger/logger.ts";
import { Options as ParseOptions, Parse } from "../src/internal/js_parser/js_parser.ts";
import { Format, Options as PrintOptions, Print } from "../src/internal/js_printer/js_printer.ts";

const PIN_PATH = "tools/parseprint.json";
const OUT_PATH = "m1.json";
const CORPUS_SOURCES = [
  { id: "three-src", dir: "testdata/three/package/src" },
  { id: "three-build", dir: "testdata/three/package/build" },
  { id: "esbuild-cases", dir: "testdata/esbuild-cases" },
];
const GENERATOR = "cd /root/esbuild && go run ./tmpgenparseprint";

const sha256 = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      out.push(...walk(p));
    } else if (e.name.endsWith(".js")) {
      out.push(p);
    }
  }
  return out.sort();
}

interface InCase { id: string; path: string; mode: M1Mode; }

/**
 * M1 的三组语料口径（同一份文件 × 三套 Options）：
 *   js     —— M1 默认口径（JS-only、target=esnext、无 minify），即第 16–20 轮的 4,238 例；
 *   ts     —— `ts.Parse=1`（Go: config.TSOptions{Parse:true}），给 TS 语法族提供 Go 字节；
 *   minify —— `MinifyWhitespace + MinifySyntax`，给 minify 族（mangle、substitute 系列）提供 Go 字节。
 *
 * 第 21 轮新增 ts/minify 两组。基准分源、分模式钉死（只许升），js 组的 referenceSha256 与
 * equalBaseline 与第 20 轮完全一致（同一份 stdout，只是入参多了 mode 字段）。
 *
 * 第 28 轮新增 target 三档（es2015/2016/2017），但**默认不跑**：6 档全量 m1 要 ~140s
 * （Go 侧 ~17s，TS 侧 ~123s），其中三档只为 I/J 批的 lower* 服务。默认只跑 js/ts/minify，
 * 需要时用 `npm run m1 -- --target-modes`（校验）或 `npm run m1 -- --write-pin --target-modes`
 * （重钉）。三档基线仍常驻 `parseprint.json`，默认 `--write-pin` 也不会丢。
 */
type M1Mode = "js" | "ts" | "minify" | "es2015" | "es2016" | "es2017";

/**
 * 目标降级语料（第 28 轮新增，给 I/J 批的 lower* 提供 Go 字节）。
 *
 * 位掩码不是猜的：Go 探针 `compat.UnsupportedJSFeatures(map[compat.Engine]compat.Semver{
 * compat.ES: {Parts: []int{2015}}})` 实测（第 28 轮，探针 tmpgenbits 跑完即删）：
 *   es2015 = 0x165fe46fc5c5ffb9
 *   es2016 = 0x165fe42fc585ffb9
 *   es2017 = 0x165fe42fc585ffb1
 * TS 侧 parser 的 options.unsupportedJSFeatures 是同一个 bitmask，直接照抄。
 */
const TARGET_BITS: Partial<Record<M1Mode, bigint>> = {
  es2015: 0x165fe46fc5c5ffb9n,
  es2016: 0x165fe42fc585ffb9n,
  es2017: 0x165fe42fc585ffb1n,
};
const MODES: { id: M1Mode; note: string }[] = [
  { id: "js", note: "默认（JS-only，target=esnext，无 minify）" },
  { id: "ts", note: "ts.Parse=1" },
  { id: "minify", note: "MinifyWhitespace+MinifySyntax" },
];
/** 第 28 轮新增的 target 降级档：只在 --target-modes 时跑（第 29 轮 I-1 开工时使用） */
const TARGET_MODES: { id: M1Mode; note: string }[] = [
  { id: "es2015", note: "target=es2015（lower* 触发）" },
  { id: "es2016", note: "target=es2016（lower* 触发）" },
  { id: "es2017", note: "target=es2017（lower* 触发）" },
];

/** 语料来源 id（与 parseprint.json 的 sources[].id 对齐；用于分源基线，防止小片段盖掉真实回归） */
function sourceOf(id: string): string {
  if (id.startsWith("three/package/src/")) return "three-src";
  if (id.startsWith("three/package/build/")) return "three-build";
  if (id.startsWith("esbuild-cases/")) return "esbuild-cases";
  return "other";
}
interface GoOut {
  id: string;
  sourceSha256: string;
  ok: boolean;
  error?: string;
  outBase64?: string;
  outBytes: number;
  outSha256?: string;
}
interface Pin {
  note: string;
  generator: string;
  generatorSource: string;
  generatorSourceSha256: string;
  sources: { id: string; dir: string; files: number; sha256: string }[];
  entries: number;
  goOk: number;
  referenceSha256: string;
  equalBaseline: number;
  equalBaselineNote: string;
  /** 分源 equal 基线（只许升）：防止在 esbuild-cases 小片段上的增长掩盖 three-src 的真实回归 */
  equalBaselineBySource?: Record<string, number>;
  /** TS parse/print 失败数上限（只许降）；失败侧要先修诊断再谈归因 */
  tsErrorBaseline?: number;
  /** 非 js 模式（ts / minify）的基准；js 模式继续用上面的顶层字段（向后兼容） */
  modes?: Record<string, {
    entries: number;
    goOk: number;
    referenceSha256: string;
    equalBaseline: number;
    equalBaselineBySource: Record<string, number>;
    tsErrorBaseline: number;
    note: string;
  }>;
}

function buildCorpus(): { cases: { id: string; path: string }[]; sourcePins: Pin["sources"] } {
  const cases: { id: string; path: string }[] = [];
  const sourcePins: Pin["sources"] = [];
  for (const src of CORPUS_SOURCES) {
    const files = walk(src.dir);
    const hashInput = Buffer.concat(files.map((f) => Buffer.concat([
      Buffer.from(path.relative("testdata", f) + "\0", "utf8"),
      fs.readFileSync(f),
      Buffer.from("\0", "utf8"),
    ])));
    sourcePins.push({ id: src.id, dir: src.dir, files: files.length, sha256: sha256(hashInput) });
    for (const f of files) cases.push({ id: path.relative("testdata", f), path: path.resolve(f) });
  }
  return { cases, sourcePins };
}

interface TsResult {
  status: "ok" | "parse-error" | "print-error";
  out?: Uint8Array;
  error?: string;
  /** Log.Msgs[0] 的文案与位置（诊断用；第 18 轮新增） */
  msgText?: string;
  msgLine?: number;
  msgColumn?: number;
}

function tsParsePrint(contents: Uint8Array, mode: M1Mode): TsResult {
  const source = new Source();
  source.Index = 0;
  source.Contents = contents;
  source.KeyPath = new LogPath();
  source.KeyPath.Text = "<stdin>";
  // `new Log()` 的 AddMsg 默认是 no-op，会把 parser 的诊断吞掉；这里接管以取首条文案。
  const log = new Log();
  const msgs: Msg[] = [];
  log.AddMsg = (msg: Msg): void => { msgs.push(msg); };
  let parsed;
  try {
    const parseOptions = new ParseOptions();
    if (mode === "ts") {
      parseOptions.ts.Parse = true;
      // Go 侧 ts 模式也开了 JSX（见 tmpgenparseprint）：不开的话 235 个 JSX 例在 Go 侧 panic 被跳过
      parseOptions.jsx.Parse = true;
    }
    if (mode === "minify") parseOptions.minifyWhitespace = true;
    const targetBits = TARGET_BITS[mode];
    if (targetBits !== undefined) {
      parseOptions.unsupportedJSFeatures = targetBits;
      // Go: OriginalTargetEnv 来自 helpers.StringArrayToQuotedCommaSeparatedString(targets)，
      // 带引号（如 `"es2015"`），PrettyPrintTargetEnvironment 直接拼进括号里。
      parseOptions.originalTargetEnv = `"${mode}"`;
    }
    parsed = Parse(log, source, parseOptions);
  } catch (e) {
    return { status: "parse-error", error: String(e) };
  }
  if (!parsed.ok) {
    const first = msgs[0];
    let error = "Parse returned ok=false";
    if (first) {
      error += `: ${first.Data.Text}`;
      const loc = first.Data.Location;
      if (loc !== null) error += ` @${loc.Line}:${loc.Column}`;
    }
    return {
      status: "parse-error",
      error,
      msgText: first?.Data.Text ?? "",
      msgLine: first?.Data.Location?.Line ?? 0,
      msgColumn: first?.Data.Location?.Column ?? 0,
    };
  }
  try {
    const symbols = parsed.ast.Symbols;
    const renamer = {
      NameForSymbol(ref: { InnerIndex: number }): string {
        // Go: renamer.NewNoOpRenamer.NameForSymbol → ast.FollowSymbols(symbols, ref)
        // 跟随 Symbol.Link 链（TS 侧 Symbols 是扁平数组，Link 用 InnerIndex 索引）
        let idx = ref.InnerIndex;
        const seen = new Set<number>();
        while (idx < symbols.length && symbols[idx] !== undefined && symbols[idx].Link !== undefined && symbols[idx].Link.InnerIndex !== idx) {
          const next = symbols[idx].Link.InnerIndex;
          if (next >= symbols.length || seen.has(next)) break;
          seen.add(next);
          idx = next;
        }
        return symbols[idx]?.OriginalName ?? "";
      },
    };
    const printOptions = new PrintOptions();
    printOptions.OutputFormat = Format.FormatESModule;
    if (mode === "minify") {
      printOptions.MinifyWhitespace = true;
      printOptions.MinifySyntax = true;
    }
    return { status: "ok", out: Print(parsed.ast, symbols, renamer, printOptions).JS };
  } catch (e) {
    return { status: "print-error", error: String(e) };
  }
}

function runGenerator(cases: InCase[], expectedSha: string | null): { entries: GoOut[]; hash: string } | { stale: string } {
  const input = Buffer.from(JSON.stringify(cases), "utf8");
  const gen = spawnSync("bash", ["-c", GENERATOR], {
    input,
    maxBuffer: 512 * 1024 * 1024,
    encoding: "buffer",
  });
  const stdout = gen.stdout ?? Buffer.alloc(0);
  if (gen.status !== 0) {
    return { stale: `Go 生成器退出码 ${gen.status}: ${(gen.stderr ?? Buffer.alloc(0)).toString().slice(0, 500)}` };
  }
  const hash = sha256(stdout);
  if (expectedSha !== null && hash !== expectedSha) {
    return { stale: `Go 生成器输出 sha256 不匹配：${hash} != ${expectedSha}` };
  }
  return { entries: JSON.parse(stdout.toString("utf8")) as GoOut[], hash };
}

function median(xs: number[]): number {
  if (xs.length === 0) return -1;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function firstDiff(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

function buckets(xs: number[]) {
  const b: Record<string, number> = { "0": 0, "1-10": 0, "11-100": 0, "101-1000": 0, ">1000": 0 };
  for (const x of xs) {
    if (x === 0) b["0"]++;
    else if (x <= 10) b["1-10"]++;
    else if (x <= 100) b["11-100"]++;
    else if (x <= 1000) b["101-1000"]++;
    else b[">1000"]++;
  }
  return b;
}

/** 首差异处的“token”：单词取整词，标点取 2 字符；用于机械聚类（非人工归因） */
function tokenAtWindow(w: string, off: number): string {
  const i = off;
  if (i >= w.length) return "<EOF>";
  const isWord = (ch: string) => /[A-Za-z0-9_$]/.test(ch);
  if (isWord(w[i])) {
    let a = i, b = i;
    while (a > 0 && isWord(w[a - 1])) a--;
    while (b < w.length && isWord(w[b])) b++;
    return w.slice(a, b);
  }
  return JSON.stringify(w.slice(i, i + 2));
}

/** 失败侧文案归一：只抹掉标识符/数字，保留引号里的具体符号（"]" vs "}" 是不同根因） */
function normalizeMsg(s: string): string {
  return s
    .replace(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g, (m) =>
      /^(Parse|returned|ok|false|printer|unsupported|expr|Cannot|encode|identifier|Unicode|escapes|are|unsupported|Expected|Unexpected|end|of|file|before|after|token|but|found)$/.test(m) ? m : "ID")
    .replace(/[0-9]+/g, "N");
}

function mdEscape(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, "\\n");
}

function readCaseSource(id: string): string {
  try {
    return fs.readFileSync(path.join("testdata", id), "utf8").slice(0, 800);
  } catch {
    return "";
  }
}

/** 差异侧根因类别（机械规则 + 人工复核；Go 函数列来自 Go 源码定位） */
function classifyDiff(d: any): { cat: string; goFn: string } {
  const key = `${tokenAtWindow(d.goWin, d.winOff)}→${tokenAtWindow(d.tsWin, d.winOff)}`;
  const win = d.goWin + "\n" + d.tsWin;
  const src = readCaseSource(d.id);
  if (/@jsx(Runtime|Frag|Factory)\b|@jsx\s/.test(src)) {
    return { cat: "JSX pragma（@jsxRuntime/@jsxFrag/@jsxFactory）", goFn: "js_parser.go:18373 pragma 处理 + JSX lowering" };
  }
  if (/→function$/.test(key) || /^let→(if|const)$/.test(key)) {
    return { cat: "块级函数声明 hoisting（visit pass）", goFn: "js_parser visit pass（函数声明降级 + 变量提升）" };
  }
  if (/^(a|x|h|f|import|String|\(0|\(a|\(c|\(d|\(l|\(f)→/.test(key) && /\(/.test(key)) {
    return { cat: "可选链 continuation / 调用目标括号", goFn: "js_parser parseSuffix optionalChain + js_printer.go:2389 ECall 目标" };
  }
  if (/^\(-|\(~|\(v|^\(d/.test(key) || /delete/.test(key)) {
    return { cat: "一元表达式在 ** / delete 下的括号", goFn: "js_printer.go:3431 BinOpPow leftLevel / js_printer.go:2005 printExpr" };
  }
  if (/undefined→void/.test(key)) {
    return { cat: "undefined 作为赋值目标被错误代换", goFn: "js_parser visit pass assignTarget 判断（js_parser.go:13764）" };
  }
  if (/" x"→"};"|export/.test(key)) {
    return { cat: "export 子句符号绑定", goFn: "js_parser declareSymbol / mergeSymbols" };
  }
  if (/\\0|u0000/.test(win)) {
    return { cat: "字符串控制字符转义", goFn: "js_printer.go:65 printUnquotedUTF16" };
  }
  if (/→String$/.test(key) || /jsx\(/.test(win) || /__template/.test(win)) {
    return { cat: "模板 </script> 防注入 lowering / automatic runtime", goFn: "js_parser 模板 lowering / jsx runtime" };
  }
  if (win.includes("/*") || win.includes("//")) {
    return { cat: "注释位置（表达式/语句级）", goFn: "js_printer.go:1917 printExprCommentsAtLoc / 3905 printIndentedComment" };
  }
  return { cat: "其他（逐例单点）", goFn: "—" };
}

/** 失败侧功能归类（读源码做机械判定；仅用于归因，不代表已修复） */
function classifyTsError(e: any): string {
  const src = readCaseSource(e.id);
  if (/@\w/.test(src) || /^\s*@/m.test(src)) return "装饰器（@decorator）";
  if (/#\w/.test(src)) return "私有名（#name）";
  if (/\bawait\s+using\b|\busing\s+\w/.test(src)) return "using / await using 声明";
  if (/\baccessor\b/.test(src)) return "accessor 字段";
  if (/\bimport\s+(source|defer)\b|\bexport\s+(source|defer)\b/.test(src)) return "import/export phase（source/defer）";
  if (/\bimport\s*\(/.test(src)) return "动态 import 选项（assert/with）";
  if (/\bwith\s*\(/.test(src)) return "with 语句";
  if (/\bexport\s+default\s+async\s*$/.test(src.trim())) return "export default async（无函数体）";
  return "其他语法/边角";
}

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const list = out.get(k);
    if (list) list.push(x); else out.set(k, [x]);
  }
  return out;
}

function writeClusters(diffCases: any[], tsErrors: any[], trivialEqual: any[], summary: any) {
  const lines: string[] = [];
  lines.push("# M1 Parse+Print 差异聚类表（机械生成）");
  lines.push("");
  lines.push("> 数据源：`npm run m1 -- --clusters`（唯一合法口径：Go `js_parser.Parse` + `js_printer.Print` 不经 linker vs TS 直接 `Parse` + `Print`）。");
  lines.push("> 分类是**机械启发式 + 人工复核**：差异侧先按首差异处 token 对分组，再用源码里的 `@jsx*` / 语法特征归到根因类别；失败侧用 `Log.Msgs[0]` 文案 + 源码特征归类。");
  lines.push("> 每组的「代表用例」固定取 id 排序后的前 3 个（可复现）。根因类别与 Go 函数对应见下方两张表。");
  lines.push("");
  lines.push(`- 生成时间：${summary.generatedAt}`);
  lines.push(`- 总计：Go 可解析 ${summary.goOk}，逐字节相等 ${summary.equal}（${(summary.equalRatio * 100).toFixed(1)}%），差异 ${summary.diff}，TS parse/print 失败 ${summary.tsError}`);
  lines.push(`- 首差异字节：median ${summary.firstDiff.median} / max ${summary.firstDiff.max}，分布 \`${JSON.stringify(summary.firstDiff.buckets)}\``);
  lines.push(`- **trivial equal**（输出 0 字节或 ≤64 字节）：**${trivialEqual.length}** 例（其中 0 字节 **${summary.trivialEqual.empty}** 例）；扣掉后等价比 **${(summary.equalRatioExcludingTrivial * 100).toFixed(1)}%**（分母不变）`);
  lines.push("");
  lines.push("## 分源指标");
  lines.push("");
  lines.push("| 来源 | Go ok | 相等 | 相等率 | 差异 | TS 失败 |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const s of summary.bySource) {
    lines.push(`| ${s.id} | ${s.goOk} | ${s.equal} | ${s.goOk ? ((s.equal / s.goOk) * 100).toFixed(1) : "0.0"}% | ${s.diff} | ${s.tsError} |`);
  }
  lines.push("");

  // 人工复核后的根因类别表（底层仍由机械 token / 源码规则聚合，可重算）
  lines.push("## 根因类别（差异侧）");
  lines.push("");
  lines.push("| 根因类别 | 例数 | 代表用例（前 3） | 对应 Go 函数 | 预计 equal 增益（上限） |");
  lines.push("| --- | ---: | --- | --- | ---: |");
  const catGroups = [...groupBy(diffCases, (d) => classifyDiff(d).cat).entries()]
    .sort((a, b) => b[1].length - a[1].length);
  const catFn = new Map<string, string>();
  for (const d of diffCases) catFn.set(classifyDiff(d).cat, classifyDiff(d).goFn);
  for (const [cat, list] of catGroups) {
    const ids = list.map((d) => d.id).sort().slice(0, 3).join(", ");
    lines.push(`| ${mdEscape(cat)} | ${list.length} | ${ids} | ${mdEscape(catFn.get(cat) ?? "—")} | ${list.length} |`);
  }
  lines.push("");
  lines.push("> 「预计 equal 增益」是上限（= 例数）：同一例修完首个差异后可能还有后续差异。");
  lines.push("");

  lines.push("## 根因类别（失败侧，先修诊断后的归因）");
  lines.push("");
  lines.push("| 根因类别 | 例数 | 代表用例（前 3） | 首条文案样例 | 对应 Go 函数 |");
  lines.push("| --- | ---: | --- | --- | --- |");
  const featGroups = [...groupBy(tsErrors, classifyTsError).entries()].sort((a, b) => b[1].length - a[1].length);
  const featFn: Record<string, string> = {
    "装饰器（@decorator）": "ts_parser.go parseDecorators / parseClass（未移植）",
    "私有名（#name）": "js_parser parseProperty / private name 分支（未移植）",
    "using / await using 声明": "js_parser parseStmt LocalUsing（未移植）",
    "accessor 字段": "js_parser parseProperty accessor（未移植）",
    "import/export phase（source/defer）": "js_parser parseImport/parseExport phase（未移植）",
    "动态 import 选项（assert/with）": "js_parser parseImportExpr assert/with（未移植）",
    "with 语句": "js_parser parseStmt SWith（未移植）",
    "export default async（无函数体）": "js_parser parseStmt export default",
    "其他语法/边角": "—",
  };
  for (const [cat, list] of featGroups) {
    const ids = list.map((e) => e.id).sort().slice(0, 3).join(", ");
    const sample = mdEscape((list[0].error || "").slice(0, 160));
    lines.push(`| ${mdEscape(cat)} | ${list.length} | ${ids} | ${sample} | ${mdEscape(featFn[cat] ?? "—")} |`);
  }
  lines.push("");

  // 失败侧
  lines.push("## 附录 A. 失败侧（TS parse/print 失败，按首条文案归一）");
  lines.push("");
  const errGroups = [...groupBy(tsErrors, (e) => `${e.status}: ${normalizeMsg(e.msgText || e.error)}`).entries()]
    .sort((a, b) => b[1].length - a[1].length);
  lines.push("| 组 | 例数 | 代表用例 | 首条文案样例 |");
  lines.push("| --- | ---: | --- | --- |");
  for (const [k, list] of errGroups) {
    const ids = list.map((e) => e.id).sort().slice(0, 3).join(", ");
    const sample = mdEscape((list[0].error || "").slice(0, 200));
    lines.push(`| ${mdEscape(k)} | ${list.length} | ${ids} | ${sample} |`);
  }
  lines.push("");

  // 差异侧
  lines.push("## 附录 B. 差异侧（首差异 token 对，机械分组）");
  lines.push("");
  const diffGroups = [...groupBy(diffCases, (d) => `${tokenAtWindow(d.goWin, d.winOff)}${JSON.stringify(d.goChar)} → ${tokenAtWindow(d.tsWin, d.winOff)}${JSON.stringify(d.tsChar)}`).entries()]
    .sort((a, b) => b[1].length - a[1].length);
  lines.push("| Go token → TS token | 例数 | 代表用例 | Go 片段 | TS 片段 |");
  lines.push("| --- | ---: | --- | --- | --- |");
  for (const [k, list] of diffGroups.slice(0, 60)) {
    const ids = list.map((d) => d.id).sort().slice(0, 3).join(", ");
    const g = mdEscape(list[0].goWin.replace(/\n/g, "\\n").slice(50, 130));
    const t = mdEscape(list[0].tsWin.replace(/\n/g, "\\n").slice(50, 130));
    lines.push(`| ${mdEscape(k)} | ${list.length} | ${ids} | ${g} | ${t} |`);
  }
  lines.push("");

  // trivial equal
  lines.push("## 附录 C. trivial equal（必须能从等价比里一眼扣掉）");
  lines.push("");
  lines.push("| 用例 | 来源 | Go 输出字节 |");
  lines.push("| --- | --- | ---: |");
  const sortedTrivial = [...trivialEqual].sort((a, b) => a.id.localeCompare(b.id));
  for (const t of sortedTrivial.slice(0, 200)) lines.push(`| ${t.id} | ${t.source} | ${t.goBytes} |`);
  if (sortedTrivial.length > 200) lines.push(`| …其余 ${sortedTrivial.length - 200} 例省略（见 m1.json） | | |`);
  lines.push("");

  fs.mkdirSync("docs", { recursive: true });
  fs.writeFileSync("docs/m1-diff-clusters.md", lines.join("\n") + "\n");
  console.log(`已写 docs/m1-diff-clusters.md（失败组 ${errGroups.length}，差异组 ${diffGroups.length}）`);
  console.log("失败侧 top:");
  for (const [k, list] of errGroups.slice(0, 15)) console.log(`  ${list.length}\t${k}`);
  console.log("差异侧 top:");
  for (const [k, list] of diffGroups.slice(0, 25)) console.log(`  ${list.length}\t${k}`);
}

interface ModeStats {
  id: M1Mode;
  note: string;
  entries: number;
  goOk: number;
  goError: number;
  tsOk: number;
  tsError: number;
  equal: number;
  diff: number;
  equalRatio: number;
  trivialEqualCount: number;
  referenceSha256: string;
  bySource: { id: string; files: number; goOk: number; tsOk: number; tsError: number; equal: number; diff: number }[];
  diffs: number[];
  results: any[];
  tsErrors: any[];
  diffCases: any[];
  trivialEqual: { id: string; source: string; goBytes: number }[];
  showSamples: { id: string; fd: number; go: string; ts: string }[];
  /** 生成器原始输出（--dump 用） */
  goEntries: GoOut[];
}

/** 单模式（一组 Options）的评估；js 组字段与第 20 轮行为完全一致 */
function evaluateMode(
  mode: M1Mode,
  cases: InCase[],
  generatedEntries: GoOut[],
  sourcePins: Pin["sources"],
  referenceSha256: string,
  show: number,
  wantSamples: boolean,
): ModeStats {
  const results = [];
  let goOk = 0;
  let tsOkCount = 0;
  let equal = 0;
  const diffs: number[] = [];
  const tsErrors: {
    id: string; source: string; status: string; error: string;
    msgText?: string; msgLine?: number; msgColumn?: number;
  }[] = [];
  const diffCases: any[] = [];
  const trivialEqual: { id: string; source: string; goBytes: number }[] = [];
  const showSamples: { id: string; fd: number; go: string; ts: string }[] = [];
  const bySource = new Map<string, { id: string; files: number; goOk: number; tsOk: number; tsError: number; equal: number; diff: number }>();
  for (const s of sourcePins) bySource.set(s.id, { id: s.id, files: s.files, goOk: 0, tsOk: 0, tsError: 0, equal: 0, diff: 0 });
  const statOf = (id: string) => bySource.get(id) ?? { id, files: 0, goOk: 0, tsOk: 0, tsError: 0, equal: 0, diff: 0 };

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const source = sourceOf(c.id);
    const stat = statOf(source);
    const g = generatedEntries[i];
    if (!g || g.id !== c.id) {
      console.error(`FATAL: 生成器输出与语料顺序不一致（#${i} ${c.id}）`);
      process.exit(2);
    }
    if (!g.ok) {
      results.push({ id: c.id, source, mode, goStatus: "error", goError: g.error ?? "", tsStatus: "skip", equal: false, firstDiff: -1 });
      continue;
    }
    goOk++;
    stat.goOk++;
    const goOut = Buffer.from(g.outBase64 ?? "", "base64");
    if (goOut.length !== g.outBytes || sha256(goOut) !== g.outSha256) {
      console.error(`FATAL: 生成器输出自校验失败（${c.id}）`);
      process.exit(2);
    }
    const t = tsParsePrint(new Uint8Array(fs.readFileSync(c.path)), mode);
    if (t.status !== "ok") {
      stat.tsError++;
      tsErrors.push({
        id: c.id, source, status: t.status, error: t.error ?? "",
        msgText: t.msgText, msgLine: t.msgLine, msgColumn: t.msgColumn,
      });
      results.push({ id: c.id, source, mode, goStatus: "ok", tsStatus: t.status, equal: false, firstDiff: -1, goBytes: goOut.length });
      continue;
    }
    tsOkCount++;
    stat.tsOk++;
    const tsOut = t.out!;
    const fd = firstDiff(goOut, tsOut);
    const isEqual = fd === -1;
    if (isEqual) {
      equal++;
      stat.equal++;
      if (goOut.length <= 64) trivialEqual.push({ id: c.id, source, goBytes: goOut.length });
    } else {
      diffs.push(fd);
      stat.diff++;
      const from = Math.max(0, fd - 60);
      const goWin = Buffer.from(goOut.subarray(from, fd + 120)).toString("utf8");
      const tsWin = Buffer.from(tsOut.subarray(from, fd + 120)).toString("utf8");
      diffCases.push({
        id: c.id, source, fd, winOff: fd - from, goBytes: goOut.length, tsBytes: tsOut.length, goWin, tsWin,
        goChar: fd < goOut.length ? String.fromCharCode(goOut[fd]) : "<EOF>",
        tsChar: fd < tsOut.length ? String.fromCharCode(tsOut[fd]) : "<EOF>",
      });
      if (showSamples.length < show) {
        showSamples.push({
          id: c.id, fd,
          go: goWin.replace(/\n/g, "\\n"),
          ts: tsWin.replace(/\n/g, "\\n"),
        });
      }
    }
    results.push({
      id: c.id, source, mode, goStatus: "ok", tsStatus: "ok", equal: isEqual, firstDiff: fd,
      goBytes: goOut.length, tsBytes: tsOut.length,
    });
  }

  return {
    id: mode,
    note: [...MODES, ...TARGET_MODES].find((m) => m.id === mode)!.note,
    entries: cases.length,
    goOk,
    goError: cases.length - goOk,
    tsOk: tsOkCount,
    tsError: tsErrors.length,
    equal,
    diff: diffs.length,
    equalRatio: goOk === 0 ? 0 : equal / goOk,
    trivialEqualCount: trivialEqual.length,
    referenceSha256,
    bySource: [...bySource.values()],
    diffs,
    results,
    tsErrors,
    diffCases: wantSamples ? diffCases : [],
    trivialEqual: wantSamples ? trivialEqual : [],
    showSamples,
    goEntries: generatedEntries,
  };
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const writePin = args.includes("--write-pin");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 0;
  const showIdx = args.indexOf("--show");
  const show = showIdx >= 0 ? parseInt(args[showIdx + 1], 10) : 0;
  const dumpIdx = args.indexOf("--dump");
  const dumpId = dumpIdx >= 0 ? args[dumpIdx + 1] : "";
  const clusters = args.includes("--clusters");
  const includeTargets = args.includes("--target-modes");
  const activeModes = includeTargets ? [...MODES, ...TARGET_MODES] : MODES;

  const pin: Pin | null = fs.existsSync(PIN_PATH) ? JSON.parse(fs.readFileSync(PIN_PATH, "utf8")) : null;
  const { cases: allCases, sourcePins } = buildCorpus();
  const cases = limit > 0 ? allCases.slice(0, limit) : allCases;

  // 生成器源码也必须与 pin 一致（防止「改生成器 + 重新钉哈希」绕过）。
  const genSource = fs.readFileSync("tools/go/tmpgenparseprint/main.go");
  const genSourceSha = sha256(genSource);

  // 三组口径（js / ts / minify）：同一份语料 × 三套 Options，各自钉 referenceSha256 与 equal 基线
  // --target-modes 时追加 es2015/2016/2017；默认不跑以把每轮门从 ~140s 降回 ~70s。
  const perMode: ModeStats[] = [];
  for (const m of activeModes) {
    const modeCases: InCase[] = cases.map((c) => ({ id: c.id, path: c.path, mode: m.id }));
    const expectedSha = limit > 0 || writePin
      ? null
      : m.id === "js"
        ? (pin?.referenceSha256 ?? null)
        : (pin?.modes?.[m.id]?.referenceSha256 ?? null);
    const generated = runGenerator(modeCases, expectedSha);
    if (!("entries" in generated)) {
      console.error(`FATAL[${m.id}]: ${generated.stale}`);
      process.exit(2);
    }
    perMode.push(evaluateMode(m.id, modeCases, generated.entries, sourcePins, generated.hash, show, m.id === "js" || clusters));
  }
  // 顶层指标仍只来自 js 组（M1 判据：JS-only 默认 options），ts/minify 单列在 byMode
  const jsStats = perMode[0];
  const results = jsStats.results;
  const referenceSha256 = jsStats.referenceSha256;
  const goOk = jsStats.goOk;
  const tsOkCount = jsStats.tsOk;
  const equal = jsStats.equal;
  const diffs = jsStats.diffs;
  const tsErrors = jsStats.tsErrors;
  const diffCases = jsStats.diffCases;
  const trivialEqual = jsStats.trivialEqual;
  const bySource = new Map(jsStats.bySource.map((s) => [s.id, s]));
  const showSamples = jsStats.showSamples;

  const summary = {
    generatedAt: new Date().toISOString(),
    generator: GENERATOR,
    generatorSourceSha256: genSourceSha,
    limit,
    corpus: sourcePins,
    entries: cases.length,
    goOk,
    goError: cases.length - goOk,
    tsOk: tsOkCount,
    tsError: tsErrors.length,
    equal,
    diff: diffs.length,
    equalRatio: goOk === 0 ? 0 : equal / goOk,
    equalRatioExcludingTrivial: (() => {
      const nontrivial = equal - trivialEqual.length;
      return goOk === 0 ? 0 : nontrivial / goOk;
    })(),
    trivialEqual: { count: trivialEqual.length, empty: trivialEqual.filter((t) => t.goBytes === 0).length, maxBytes: 64, note: "输出 0 字节或 ≤64 字节的相等例；撑等价比但不代表能力" },
    bySource: [...bySource.values()],
    byMode: perMode.map((m) => ({
      id: m.id,
      note: m.note,
      entries: m.entries,
      goOk: m.goOk,
      goError: m.goError,
      tsOk: m.tsOk,
      tsError: m.tsError,
      equal: m.equal,
      diff: m.diff,
      equalRatio: m.equalRatio,
      trivialEqual: m.trivialEqualCount,
      referenceSha256: m.referenceSha256,
      bySource: m.bySource,
    })),
    firstDiff: {
      median: median(diffs),
      max: diffs.length === 0 ? -1 : Math.max(...diffs),
      buckets: buckets(diffs),
      note: "只统计 TS 能 parse+print 且与 Go 有差异的用例；-1 表示无差异样本",
    },
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify({ summary, cases: results, tsErrors, diffSamples: clusters ? diffCases : undefined, trivialEqual: clusters ? trivialEqual : undefined }, null, 1) + "\n");
  if (clusters) writeClusters(diffCases, tsErrors, trivialEqual, summary);
  if (dumpId !== "") {
    const i = cases.findIndex((c) => c.id === dumpId);
    if (i < 0) {
      console.error(`--dump: 找不到用例 ${dumpId}`);
      process.exit(2);
    }
    const goOut = Buffer.from(jsStats.goEntries[i].outBase64 ?? "", "base64");
    const t = tsParsePrint(new Uint8Array(fs.readFileSync(cases[i].path)), "js");
    console.log(`\n[dump] ${dumpId}`);
    console.log(`GO(${goOut.length}): ${JSON.stringify(goOut.toString("utf8"))}`);
    console.log(`TS(${t.out?.length ?? 0}): ${JSON.stringify(t.out ? Buffer.from(t.out).toString("utf8") : t.error)}`);
  }

  console.log(`M1 Parse+Print: equal ${equal}/${goOk}（${(summary.equalRatio * 100).toFixed(1)}%）`);
  console.log(`  corpus ${cases.length} 例（Go parse-error ${summary.goError}，TS parse/print-error ${summary.tsError}，TS ok ${tsOkCount}）`);
  console.log(`  首差异字节: median ${summary.firstDiff.median} / max ${summary.firstDiff.max}`);
  console.log(`  分布: ${JSON.stringify(summary.firstDiff.buckets)}`);
  for (const s of sourcePins) console.log(`  语料 ${s.id}: ${s.files} 文件 sha256 ${s.sha256.slice(0, 16)}…`);
  for (const m of perMode.slice(1)) {
    console.log(`  [${m.id}] equal ${m.equal}/${m.goOk}（Go parse-error ${m.goError}，TS error ${m.tsError}），tsError 基线见 parseprint.json`);
  }
  for (const s of showSamples) {
    console.log(`\n[show] ${s.id} @${s.fd}`);
    console.log(`  go: ${s.go}`);
    console.log(`  ts: ${s.ts}`);
  }

  if (writePin) {
    if (cases.length !== allCases.length) {
      console.error("--write-pin 不允许与 --limit 同用");
      process.exit(2);
    }
    const newPin: Pin = {
      note: "M1 Parse+Print 差分通道的钉死基准。goOk 是 Go 可解析数（N），referenceSha256 是 Go 生成器 stdout 的 sha256；每轮 --check 会重跑生成器并校验。",
      generator: GENERATOR,
      generatorSource: "tools/go/tmpgenparseprint/main.go",
      generatorSourceSha256: genSourceSha,
      sources: sourcePins,
      entries: cases.length,
      goOk,
      referenceSha256,
      equalBaseline: equal,
      equalBaselineNote: "逐字节相等数基线，只许升不许降（--check 时校验）",
      equalBaselineBySource: Object.fromEntries([...bySource.values()].map((s) => [s.id, s.equal])),
      tsErrorBaseline: tsErrors.length,
      modes: (() => {
        const out: NonNullable<Pin["modes"]> = Object.fromEntries(perMode.filter((m) => m.id !== "js").map((m) => [m.id, {
          entries: m.entries,
          goOk: m.goOk,
          referenceSha256: m.referenceSha256,
          equalBaseline: m.equal,
          equalBaselineBySource: Object.fromEntries(m.bySource.map((x) => [x.id, x.equal])),
          tsErrorBaseline: m.tsError,
          note: `${m.note}：逐字节相等基线只许升；tsError 只许降`,
        }]));
        // 默认 --write-pin 只跑三档，不能把常驻的 target 三档基线写丢。
        if (!includeTargets) {
          for (const t of TARGET_MODES) {
            if (pin?.modes?.[t.id]) out[t.id] = pin.modes[t.id];
          }
        }
        return out;
      })(),
    };
    fs.writeFileSync(PIN_PATH, JSON.stringify(newPin, null, 2) + "\n");
    console.log(`已写 ${PIN_PATH}`);
  }

  if (check && pin !== null) {
    const problems: string[] = [];
    if (genSourceSha !== pin.generatorSourceSha256 && limit === 0) {
      problems.push(`生成器源码 sha256 不匹配：${genSourceSha} != ${pin.generatorSourceSha256}`);
    }
    if (pin.entries !== cases.length) problems.push(`语料条数变化：${cases.length} != ${pin.entries}`);
    if (pin.goOk !== goOk) problems.push(`Go 可解析数变化：${goOk} != ${pin.goOk}`);
    if (equal < pin.equalBaseline) problems.push(`逐字节相等数下降：${equal} < ${pin.equalBaseline}`);
    if (pin.equalBaselineBySource) {
      for (const [id, base] of Object.entries(pin.equalBaselineBySource)) {
        const cur = bySource.get(id)?.equal ?? 0;
        if (cur < base) problems.push(`分源 equal 下降（${id}）：${cur} < ${base}`);
      }
      for (const id of bySource.keys()) {
        if (!(id in pin.equalBaselineBySource)) problems.push(`分源基线缺少语料来源：${id}`);
      }
    }
    if (pin.tsErrorBaseline !== undefined && tsErrors.length > pin.tsErrorBaseline) {
      problems.push(`TS parse/print 失败数上升：${tsErrors.length} > ${pin.tsErrorBaseline}`);
    }
    // ts / minify 两组：条数、Go 可解析数、分源 equal 只许升，tsError 只许降
    for (const m of perMode) {
      if (m.id === "js") continue;
      const base = pin.modes?.[m.id];
      if (!base) {
        problems.push(`基线缺少模式 ${m.id}（先跑 --write-pin）`);
        continue;
      }
      if (base.entries !== m.entries) problems.push(`[${m.id}] 语料条数变化：${m.entries} != ${base.entries}`);
      if (base.goOk !== m.goOk) problems.push(`[${m.id}] Go 可解析数变化：${m.goOk} != ${base.goOk}`);
      if (m.equal < base.equalBaseline) problems.push(`[${m.id}] 逐字节相等数下降：${m.equal} < ${base.equalBaseline}`);
      for (const [id, want] of Object.entries(base.equalBaselineBySource)) {
        const cur = m.bySource.find((x) => x.id === id)?.equal ?? 0;
        if (cur < want) problems.push(`[${m.id}] 分源 equal 下降（${id}）：${cur} < ${want}`);
      }
      if (m.tsError > base.tsErrorBaseline) {
        problems.push(`[${m.id}] TS parse/print 失败数上升：${m.tsError} > ${base.tsErrorBaseline}`);
      }
    }
    if (problems.length > 0) {
      for (const p of problems) console.error(`CHECK FAIL: ${p}`);
      process.exit(1);
    }
    console.log(`CHECK OK: equal ${equal} >= baseline ${pin.equalBaseline}`);
  }
}

main();
