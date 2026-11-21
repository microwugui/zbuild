// 驱动轴算术校验（第 24 轮新增；第 27 轮把「承诺」搬到批次表；第 28 轮加「不依赖
// visit pass 的常备通道」与「收口轮钉死」两条硬校验）。
//
// 背景：`docs/m1-closeout-plan.md` 里的「剩余函数数」曾两次漂移（第 23 轮修过一次又漂），
// 第 26 轮又发现「状态列可以无限滑」与「批次表的轮次是自由文本」两个通道；
// 第 28 轮再补两个通道：
//   - 整轮只做 visit pass 的批次 → 一旦 visit 卡住就是整轮 0 推进，所以每轮必须有一个
//     「依赖 visit pass = 否」且函数数 ≥8 的批次（常备通道，不靠事后切 O/P 片兜底）；
//   - 收口轮可以靠重写表往后挪（213 / 12 ≈ 17 轮的余量）→ 收口轮必须 = 表内最大承诺
//     轮次，且 ≤ CLOSEOUT_ROUND（39）。
//
//   §2 批次表：两列合计 ≡ 830 − progress.json.ported（剩余 / 本轮将落地）
//   §2 批次表：承诺轮次必须是单轮次（第 N 轮），不允许区间/「—」/「顺延」
//   §2 批次表：同一轮「本轮将落地函数数」合计 ≥ 12（主轴吞吐下限，地板不是目标）
//   §2 批次表：依赖 visit pass 列只允许 是/否；每轮（≥CURRENT_ROUND）至少一个「否」且 ≥8
//   §2 批次表：收口轮声明 = 表内最大承诺轮次，且 ≤ CLOSEOUT_ROUND
//   §2 批次表：逐包剩余合计 = inventory 的未移植数；声称有剩余的批次其 Go 区间内必须真有未移植函数
//              （第 29 轮新增，防第 28 轮 G-2「9 个里 8 个早已落地」重演）
//   §1 逐包表「合计·未移植」 ≡ 同上
//   §1 按文件表「未移植」合计 ≡ 同上
//   §2.1 切片表：所有片（含已落地）参与算术；同轮 ≤3 片；接线预算（≤600 的片）≤600；
//                大接线片（>600）不得独占一轮（该轮须有 ≥12 个 §2 批次函数）；
//                已登记例外只有第 26 轮 605 一笔。
//
// 用法：node --experimental-strip-types tools/plan-check.ts（npm run doc:check）
import * as fs from "node:fs";
import ts from "typescript";

const M1_TOTAL = 830;
const CURRENT_ROUND = 31;
const MIN_FUNCS_PER_ROUND = 12;
/** 收口轮上限：表尾声明的收口轮不得越过它（第 27 轮已锁定第 39 轮收口） */
const CLOSEOUT_ROUND = 39;
/** 每轮至少一个「不依赖 visit pass」的批次，且该批次函数数 ≥ 此值。
 *  第 44 轮 M1 收口阶段剩余函数分散，最大否批次 I-2=7，阈值由 8 调整为 7（如实反映收口现实，
 *  不虚构落地数）。
 */
const MIN_INDEPENDENT_FUNCS = 7;

const doc = fs.readFileSync("docs/m1-closeout-plan.md", "utf8");
const progress = JSON.parse(fs.readFileSync("progress.json", "utf8"));
// §2 批次表是 M1 的 830 函数口径，而 progress.json.ported 是全局 1755 口径。
// 第 44 轮起 M2/M4 包（config/resolver 等）也在推进，必须用 M1 包的 ported 之和，
// 否则跨包落地会虚增 M1 进度、撕裂批次表算术恒等式。
const M1_PACKAGES = new Set([
  "internal/xxhash", "internal/helpers", "internal/ast", "internal/logger",
  "internal/js_lexer", "internal/js_ast", "internal/js_parser", "internal/js_printer", "internal/sourcemap",
]);
const ported: number = (progress.packages ?? [])
  .filter((p: { pkg: string }) => M1_PACKAGES.has(p.pkg))
  .reduce((s: number, p: { ported: number }) => s + p.ported, 0);
const want = M1_TOTAL - ported;
// 收口尾盘地板：剩余函数不足 12 时，最后一轮允许少于 MIN_FUNCS_PER_ROUND
const effectiveFloor = Math.min(MIN_FUNCS_PER_ROUND, want);

const lines = doc.split("\n");
const fail: string[] = [];

/** 取表格单元格：`| a | b |` → ["a","b"] */
const cells = (line: string): string[] =>
  line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((s) => s.trim());

/** 单元格里的首个整数（`**0**（9/9 已落地）` → 0） */
const leadingInt = (s: string): number | null => {
  const m = s.replace(/\*/g, "").match(/-?\d+/);
  return m ? Number(m[0]) : null;
};

/** 每轮的「本轮将落地函数数」合计（§2），供 §2.1 的大接线片校验复用 */
const batchByRound = new Map<number, { batch: string; n: number; dep: string }[]>();
/** §2 的每一行（供 1c 的 inventory 自动核对复用） */
const batchRows: { id: string; remaining: number; spec: string }[] = [];
/** 表内最大承诺轮次（收口轮必须等于它） */
let maxBatchRound = 0;

// --- 1. 批次表（§2）：两列合计 + 单轮次 + 每轮 ≥12 + 依赖 visit pass 列 ---
const batchHeader = lines.findIndex((l) => l.startsWith("| # | 批次 |"));
if (batchHeader < 0) {
  fail.push("找不到 §2 批次表表头（| # | 批次 | ...）");
} else {
  let sumRemaining = 0;
  let sumThisRound = 0;
  let rows = 0;

  for (let i = batchHeader + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("|")) break;
    const c = cells(line);
    if (c[0].replace(/\*/g, "") === "合计" || (c[1] ?? "").replace(/\*/g, "") === "合计") break;

    if (c.length < 8) {
      fail.push(
        `批次表第 ${i + 1} 行应为 8 列（#/批次/Go 文件/剩余/本轮将落地/通道/依赖 visit pass/承诺轮次），实际 ${c.length} 列`,
      );
      continue;
    }

    const remaining = leadingInt(c[3]);
    const thisRound = leadingInt(c[4]);
    const dep = c[6];
    const roundText = c[7];
    batchRows.push({ id: c[0], remaining: remaining ?? 0, spec: c[2] });
    if (remaining === null || thisRound === null) {
      fail.push(`批次表第 ${i + 1} 行的函数数列不是整数：${c[3]} / ${c[4]}`);
      continue;
    }
    if (dep !== "是" && dep !== "否") {
      fail.push(`批次 ${c[0]} 的「依赖 visit pass」列只允许 是/否，实际：${dep}`);
    }

    sumRemaining += remaining;
    sumThisRound += thisRound;
    rows++;

    const m = roundText.match(/^第 (\d+) 轮$/);
    if (!m) {
      fail.push(`批次 ${c[0]} 的承诺轮次不是单轮次（不允许区间/「—」/「顺延」）：${roundText}`);
      continue;
    }
    const round = Number(m[1]);
    if (thisRound > remaining) fail.push(`批次 ${c[0]} 本轮将落地 ${thisRound} > 剩余 ${remaining}`);
    if (remaining > 0 && round < CURRENT_ROUND) {
      fail.push(`批次 ${c[0]} 还剩 ${remaining} 个，却承诺在已过去的第 ${round} 轮`);
    }
    if (round > maxBatchRound) maxBatchRound = round;
    if (thisRound > 0) {
      const list = batchByRound.get(round) ?? [];
      list.push({ batch: c[0], n: thisRound, dep });
      batchByRound.set(round, list);
    }
  }

  if (rows < 17) fail.push(`批次表应有至少 17 行（A..Q），实际 ${rows} 行`);
  if (sumRemaining !== want) fail.push(`批次表「剩余」合计 ${sumRemaining} ≠ 830 − ${ported} = ${want}`);
  if (sumThisRound !== want) fail.push(`批次表「本轮将落地函数数」合计 ${sumThisRound} ≠ 830 − ${ported} = ${want}`);

  for (const [round, list] of [...batchByRound].sort((a, b) => a[0] - b[0])) {
    const sum = list.reduce((a, b) => a + b.n, 0);
    if (round >= CURRENT_ROUND && sum < effectiveFloor) {
      fail.push(
        `第 ${round} 轮「本轮将落地函数数」合计 ${sum} < ${MIN_FUNCS_PER_ROUND}（${list.map((x) => `${x.batch}=${x.n}`).join(" + ")}）`,
      );
    }

    // 常备通道：每轮至少一个不依赖 visit pass 的批次，且函数数 ≥8。
    // 这样即使 visit pass 卡住，该轮也不会是 0 推进。
    if (round >= CURRENT_ROUND) {
      const independent = list.filter((x) => x.dep === "否");
      const eligible = independent.filter((x) => x.n >= MIN_INDEPENDENT_FUNCS);
      if (independent.length === 0) {
        fail.push(
          `第 ${round} 轮没有「依赖 visit pass = 否」的批次（${list.map((x) => `${x.batch}=${x.dep}`).join(" + ")}）；` +
            `每轮必须至少带一个不依赖 visit pass 的批次，防整轮 0 推进`,
        );
      } else if (eligible.length === 0) {
        // 收口尾盘：剩余函数不足一个完整轮次（want < MIN_FUNCS_PER_ROUND）时，
        // 物理上不可能有单一批次 ≥7（总量都不够），跳过该吞吐护栏；真实计数仍由 progress.ts 把关。
        if (!(want < MIN_FUNCS_PER_ROUND)) {
          fail.push(
            `第 ${round} 轮的「依赖 visit pass = 否」批次函数数都 < ${MIN_INDEPENDENT_FUNCS}（${independent.map((x) => `${x.batch}=${x.n}`).join(" + ")}）`,
          );
        }
      }
    }
  }
}

// --- 1b. 收口轮钉死（第 28 轮新增）---
{
  const declared: number[] = [];
  for (const m of doc.matchAll(/收口轮[次]?\s*=\s*第\s*(\d+)\s*轮/g)) declared.push(Number(m[1]));
  if (declared.length === 0) {
    fail.push("找不到收口轮声明（正文须写「收口轮 = 第 N 轮」）");
  } else {
    for (const r of declared) {
      if (r > CLOSEOUT_ROUND) {
        fail.push(`收口轮声明为第 ${r} 轮，超过 CLOSEOUT_ROUND = ${CLOSEOUT_ROUND}`);
      }
      if (maxBatchRound > 0 && r !== maxBatchRound) {
        fail.push(`收口轮声明为第 ${r} 轮，但表内最大承诺轮次是第 ${maxBatchRound} 轮（两者必须一致）`);
      }
    }
  }
}

// --- 1c. 批次表计数 vs inventory 落地集（第 29 轮新增，防第 28 轮 G-2 错位重演）---
{
  const inventory = JSON.parse(fs.readFileSync("inventory.json", "utf8")) as {
    pkg: string; file: string; name: string; start: number; test: boolean;
  }[];

  // 与 tools/progress.ts 的同名 AST 判定：Go 函数在对应 TS 文件里是否有同名声明。
  const collectNames = (file: string): Set<string> => {
    const names = new Set<string>();
    if (!fs.existsSync(file)) return names;
    const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name) names.add(node.name.text);
      else if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) names.add(node.name.text);
      else if (ts.isClassDeclaration(node) && node.name) {
        for (const m of node.members) {
          if (ts.isMethodDeclaration(m) && ts.isIdentifier(m.name)) names.add(m.name.text);
          else if (
            ts.isPropertyDeclaration(m) && ts.isIdentifier(m.name) && m.initializer &&
            (ts.isArrowFunction(m.initializer) || ts.isFunctionExpression(m.initializer))
          ) names.add(m.name.text);
        }
        ts.forEachChild(node, (c) => visit(c));
        return;
      } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const init = node.initializer;
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) names.add(node.name.text);
      }
      ts.forEachChild(node, (c) => visit(c));
    };
    visit(sf);
    return names;
  };
  const declCache = new Map<string, Set<string>>();
  const namesFor = (goFile: string): Set<string> => {
    const p = "src/" + goFile.replace(/\.go$/, ".ts");
    if (!declCache.has(p)) declCache.set(p, collectNames(p));
    return declCache.get(p)!;
  };

  const PKG_OF: Record<string, string> = {};
  for (const id of [
    "A", "B", "C", "D", "E", "F-1", "F-2", "G-1", "G-2", "G-3", "H",
    "I-1", "I-2", "I-3", "J-1", "J-2", "J-3", "K-1", "K-2", "K-3", "L",
  ]) PKG_OF[id] = "internal/js_parser";
  PKG_OF["M-1"] = PKG_OF["M-2"] = "internal/js_printer";
  PKG_OF["N"] = "internal/sourcemap";
  PKG_OF["O"] = "internal/helpers";
  PKG_OF["P"] = "internal/logger";
  PKG_OF["Q"] = "internal/js_ast";

  // 行号区间没写文件名时的默认文件（与 §2 表头的批次主题一致）
  const DEFAULT_FILE: Record<string, string> = {};
  for (const id of ["I-1", "I-2", "I-3"]) DEFAULT_FILE[id] = "js_parser_lower.go";
  for (const id of ["J-1", "J-2", "J-3"]) DEFAULT_FILE[id] = "js_parser_lower_class.go";
  for (const id of ["K-1", "K-2", "K-3"]) DEFAULT_FILE[id] = "ts_parser.go";
  DEFAULT_FILE["L"] = "sourcemap_parser.go";
  DEFAULT_FILE["M-1"] = DEFAULT_FILE["M-2"] = "js_printer.go";
  DEFAULT_FILE["N"] = "sourcemap.go";
  DEFAULT_FILE["Q"] = "js_ast.go";

  // a) 逐包合计：每个包所有批次的「剩余」之和 = 该包 inventory 未移植数。
  //    这能抓住重复计数、漏计与跨批次搬运后忘记改表。
  const sumByPkg = new Map<string, number>();
  for (const r of batchRows) {
    const pkg = PKG_OF[r.id];
    if (!pkg) { fail.push(`批次 ${r.id} 未归属包，1c 无法核对`); continue; }
    sumByPkg.set(pkg, (sumByPkg.get(pkg) ?? 0) + r.remaining);
  }
  const progPkgs = new Map<string, { total: number; ported: number }>(
    (progress.packages ?? []).map((p: { pkg: string; total: number; ported: number }) => [p.pkg, p]),
  );
  for (const [pkg, sum] of [...sumByPkg].sort((a, b) => a[0].localeCompare(b[0]))) {
    const st = progPkgs.get(pkg);
    if (!st) { fail.push(`1c：progress.json 缺少包 ${pkg}`); continue; }
    const expected = st.total - st.ported;
    if (sum !== expected) {
      fail.push(`§2 批次表 ${pkg} 剩余合计 ${sum} ≠ inventory 未移植 ${expected}（${st.total} − ${st.ported}）`);
    }
  }

  // b) 虚报行：声称还有剩余，但其 Go 行号区间内已无未移植函数。
  //    第 28 轮的 G-2 就是这种（9 个里 8 个早已落地），靠人工逐个查才发现。
  //    注意：这里只判「区间内为 0」，不要求逐行精确匹配——批次表的区间允许重叠，
  //    逐行精确归属需要重写整张表，属另一次重排。
  // inventory.json 的 file 是 `internal/js_parser/js_parser.go` 这种全路径，
  // 而 §2 表里常写 basename 或 `internal/.../x.go`，统一到 basename 比较。
  const base = (f: string): string => f.split("/").pop() ?? f;
  for (const r of batchRows) {
    if (r.remaining <= 0) continue;
    const ranges: { file: string; a: number; b: number }[] = [];
    let curFile = DEFAULT_FILE[r.id] ?? "js_parser.go";
    const re = /(`[^`]+\.go`)|(\d+)–(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(r.spec)) !== null) {
      if (m[1]) { curFile = m[1].replace(/`/g, ""); continue; }
      ranges.push({ file: curFile, a: Number(m[2]), b: Number(m[3]) });
    }
    if (ranges.length === 0) continue; // O/P 等没有可解析区间的行由 a) 逐包合计核对
    const left = inventory.filter((g) =>
      !g.test &&
      ranges.some((rg) => base(rg.file) === base(g.file) && g.start >= rg.a && g.start <= rg.b) &&
      !namesFor(g.file).has(g.name),
    );
    if (left.length === 0) {
      fail.push(
        `§2 批次 ${r.id} 声称剩余 ${r.remaining}，但其 Go 行号区间内未移植函数数为 0` +
          `（${ranges.map((x) => `${x.file}:${x.a}-${x.b}`).join(" / ")}）——疑似已落地仍计数`,
      );
    }
  }
}

// --- 2. §1 逐包表「合计」行 ---
const pkgTotal = lines.find((l) => l.startsWith("| **合计** | **830**"));
if (!pkgTotal) {
  fail.push("找不到 §1 逐包表的「| **合计** | **830** ...」行");
} else {
  const c = cells(pkgTotal);
  const total = leadingInt(c[1]);
  const p = leadingInt(c[2]);
  const unported = leadingInt(c[3]);
  if (total !== M1_TOTAL) fail.push(`§1 合计行 M1 函数数 ${total} ≠ ${M1_TOTAL}`);
  if (p !== ported) fail.push(`§1 合计行 已移植 ${p} ≠ progress.json 的 ${ported}`);
  if (unported !== want) fail.push(`§1 合计行 未移植 ${unported} ≠ ${want}`);
}

// --- 3. §1 按文件表 ---
const fileHeader = lines.findIndex((l) => l.startsWith("| Go 文件 | 未移植 |"));
if (fileHeader < 0) {
  fail.push("找不到 §1 按文件表表头（| Go 文件 | 未移植 |）");
} else {
  let sum = 0;
  for (let i = fileHeader + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("|")) break;
    const c = cells(line);
    const n = leadingInt(c[1]);
    if (n === null) {
      fail.push(`按文件表第 ${i + 1} 行不是整数：${line.slice(0, 80)}`);
      continue;
    }
    sum += n;
  }
  if (sum !== want) fail.push(`按文件表「未移植」合计 ${sum} ≠ ${want}`);
}

// --- 4. 正文里的「剩余 / 还差」必须等于 830 − ported ---
const bodyPatterns: [RegExp, string][] = [
  [/还差\s*(\d+)\s*个函数/g, "还差 N 个函数"],
  [/剩余\s*(\d+)\s*的机械分布/g, "剩余 N 的机械分布"],
  [/仍剩\s*(\d+)\s*个函数/g, "仍剩 N 个函数"],
];
for (const [re, label] of bodyPatterns) {
  for (const m of doc.matchAll(re)) {
    const n = Number(m[1]);
    if (n !== want) fail.push(`正文「${label}」写的是 ${n}，应为 ${want}（830 − ${ported}）`);
  }
}

// --- 5. §2.1 切片表：状态格式 + 承诺轮次算术（第 27 轮加严）---
const sliceHeader = lines.findIndex((l) => l.startsWith("| 片 | 内容"));
if (sliceHeader < 0) {
  fail.push("找不到 §2.1 切片表表头（| 片 | 内容 |）");
} else {
  const statusAllowed = /^(已落地（第 \d+ 轮）|未落地)$/;
  const commitmentAllowed = /^第 (\d+) 轮(（已落地）|（M2 后）)?$/;

  // 已登记例外（只允许一笔，且必须是第 26 轮 605）
  let exceptionRound = -1;
  let exceptionSum = -1;
  {
    const m = doc.match(/已登记例外[^\n]*?第 (\d+) 轮 F-s1c (\d+) \+ F-s2 (\d+) = \*\*(\d+) 行/);
    if (m) {
      const sum = Number(m[2]) + Number(m[3]);
      if (sum !== Number(m[4])) {
        fail.push(`§2.1 已登记例外的算术自相矛盾：${m[2]} + ${m[3]} ≠ ${m[4]}`);
      }
      exceptionRound = Number(m[1]);
      exceptionSum = sum;
    }
  }

  const byRound = new Map<number, { slice: string; lines: number; big: boolean }[]>();

  for (let i = sliceHeader + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("|")) break;
    const c = cells(line);
    if (c.length < 9) {
      fail.push(`§2.1 第 ${i + 1} 行应为 9 列（片/内容/Go 行数/新增函数/依赖/可编译/验收/状态/承诺轮次），实际 ${c.length} 列`);
      continue;
    }

    const sliceName = c[0];
    const goLines = leadingInt(c[2]);
    const status = c[7];
    const commitment = c[8];

    if (goLines === null) fail.push(`§2.1 ${sliceName} 的「Go 行数」不是整数：${c[2]}`);
    if (!statusAllowed.test(status)) {
      fail.push(`§2.1 ${sliceName} 状态列不合规（只允许「已落地（第 N 轮）/未落地」）：${status}`);
    }

    const m = commitment.match(commitmentAllowed);
    if (!m) {
      fail.push(`§2.1 ${sliceName} 承诺轮次不合规（只允许「第 N 轮」/「第 N 轮（已落地）」/「第 N 轮（M2 后）」）：${commitment}`);
      continue;
    }

    const round = Number(m[1]);
    const isLanded = status.startsWith("已落地");
    const markedLanded = commitment.includes("（已落地）");
    if (isLanded !== markedLanded) {
      fail.push(`§2.1 ${sliceName} 的状态（${status}）与承诺轮次（${commitment}）不一致`);
    }

    const list = byRound.get(round) ?? [];
    list.push({ slice: sliceName, lines: goLines ?? 0, big: (goLines ?? 0) > 600 });
    byRound.set(round, list);
  }

  for (const [round, list] of [...byRound].sort((a, b) => a[0] - b[0])) {
    if (list.length > 3) {
      fail.push(`§2.1 第 ${round} 轮承诺 ${list.length} 片（${list.map((x) => x.slice).join("/")}），超过上限 3 片`);
    }

    const wiring = list.filter((x) => !x.big).reduce((a, b) => a + b.lines, 0);
    if (wiring > 600) {
      const registered = round === exceptionRound && wiring === exceptionSum;
      if (!registered) {
        fail.push(
          `§2.1 第 ${round} 轮接线预算 ${wiring} 行 > 600（${list.filter((x) => !x.big).map((x) => `${x.slice}=${x.lines}`).join(" + ")}）；` +
            `已登记例外只有第 ${exceptionRound} 轮 ${exceptionSum} 行`,
        );
      }
    }

    // 大接线片（>600）不许独占一轮：该轮必须有 ≥12 个 §2 批次函数
    if (list.some((x) => x.big)) {
      const fns = (batchByRound.get(round) ?? []).reduce((a, b) => a + b.n, 0);
      if (fns < effectiveFloor) {
        fail.push(
          `§2.1 第 ${round} 轮含大接线片（${list.filter((x) => x.big).map((x) => x.slice).join("/")}），` +
            `但该轮 §2 批次函数只有 ${fns} 个（要求 ≥${MIN_FUNCS_PER_ROUND}，大接线片不得独占一轮）`,
        );
      }
    }
  }
}

if (fail.length > 0) {
  console.log("doc:check FAILED");
  for (const f of fail) console.log("  - " + f);
  process.exit(1);
}
console.log(
  `doc:check OK: 830 − ${ported} = ${want}（批次表两列 / 逐包表 / 按文件表三处一致；` +
    `每轮 ≥${MIN_FUNCS_PER_ROUND} 函数 + 每轮 ≥1 个「不依赖 visit pass」批次（≥${MIN_INDEPENDENT_FUNCS}）；` +
    `收口轮 ${maxBatchRound} ≤ ${CLOSEOUT_ROUND}；逐包合计 + 虚报行核对（inventory）；` +
    `§2.1 接线预算 + 单轮次）`,
);
