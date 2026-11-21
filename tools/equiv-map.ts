#!/usr/bin/env node
/**
 * equiv-map.ts —— 「差分用例 → 函数名」证据映射 v1（第 20 次推进新增）
 *
 * 目的：把「已移植但没有等价证据」的函数从一句总账，变成可逐函数追踪的表。
 *
 * 证据等级（从严到宽）：
 *   1. go-bytes  —— tools/go-verified.json 里该包的 evidence 文本明确点名了这个函数
 *                   （只对逐函数登记过的包有意义；package 级计数不算函数级证据）
 *   2. m1-byte   —— 在 `NODE_V8_COVERAGE=coverage-m1 npm run m1` 的字节差分运行里被执行过。
 *                   M1 是 Go Parse+Print vs TS Parse+Print 的逐字节比较，所以「被执行」
 *                   意味着该函数的产物至少进入过一次 Go/TS 字节比对（仍是运行级、非逐函数断言）。
 *   3. unit-only —— 只在 npm test 的单元测试覆盖里被执行（unit-oracle.json 只是 case 级）。
 *   4. none      —— 上述都没有：真正的「无等价证据」。
 *
 * oracle 用例映射：oracle.json 的每个 case 只有 `exercises: [包名]`，没有函数名，
 * 所以本工具给出的是「包级 case 集合」：函数 f 继承其所属包的 applicable/equal 计数。
 * 逐 case → 逐函数需要 per-case coverage（本轮不重跑 oracle，已在 PLAN 记为 v2）。
 *
 * 用法：
 *   node --experimental-strip-types tools/equiv-map.ts \
 *     [--root .] [--cov-m1 coverage-m1] [--cov-unit coverage] \
 *     [--json equiv-map.json] [--md docs/equiv-map.md]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

interface GoFunc {
  pkg: string;
  file: string;
  name: string;
  start: number;
  end: number;
  body: boolean;
  test: boolean;
}

type CovMap = Map<string, Map<string, number>>;

function parseArgs(argv: string[]) {
  const o = {
    root: process.cwd(),
    inventory: "inventory.json",
    src: "src",
    covM1: "coverage-m1",
    covUnit: "coverage",
    oracle: "oracle.json",
    goVerified: "tools/go-verified.json",
    json: "equiv-map.json",
    md: "docs/equiv-map.md",
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--root": o.root = argv[++i]; break;
      case "--inventory": o.inventory = argv[++i]; break;
      case "--src": o.src = argv[++i]; break;
      case "--cov-m1": o.covM1 = argv[++i]; break;
      case "--cov-unit": o.covUnit = argv[++i]; break;
      case "--oracle": o.oracle = argv[++i]; break;
      case "--json": o.json = argv[++i]; break;
      case "--md": o.md = argv[++i]; break;
      default:
        if (argv[i].startsWith("--")) {
          console.error(`未知参数: ${argv[i]}`);
          process.exit(2);
        }
    }
  }
  return o;
}

/** 与 tools/progress.ts 的 loadCoverage 同构：V8 coverage → file → functionName → count */
function loadCoverage(covDir: string, srcDir: string): CovMap {
  const cov: CovMap = new Map();
  if (!fs.existsSync(covDir)) return cov;
  const srcAbs = path.resolve(srcDir);
  for (const f of fs.readdirSync(covDir)) {
    if (!f.endsWith(".json")) continue;
    let data: { result?: { url?: string; functions?: { functionName?: string; ranges?: { count: number }[] }[] }[] };
    try {
      data = JSON.parse(fs.readFileSync(path.join(covDir, f), "utf8"));
    } catch {
      continue;
    }
    for (const r of data.result ?? []) {
      const url = r.url ?? "";
      if (!url.startsWith("file://")) continue;
      const abs = path.resolve(decodeURIComponent(url.slice("file://".length)));
      if (!abs.startsWith(srcAbs)) continue;
      let m = cov.get(abs);
      if (!m) {
        m = new Map();
        cov.set(abs, m);
      }
      for (const fn of r.functions ?? []) {
        const name = fn.functionName || "";
        if (!name) continue;
        m.set(name, Math.max(m.get(name) ?? 0, fn.ranges?.[0]?.count ?? 0));
      }
    }
  }
  return cov;
}

function isCovered(exec: Map<string, number> | undefined, name: string): boolean {
  if (!exec) return false;
  if ((exec.get(name) ?? 0) > 0) return true;
  const suffix = "." + name;
  for (const [k, v] of exec) if (v > 0 && k.endsWith(suffix)) return true;
  return false;
}

/** 与 tools/progress.ts 的 collectDecls 同构：TS 文件里有这个同名函数/方法就算「已移植」 */
function collectDecls(fileName: string): Set<string> {
  const sf = ts.createSourceFile(fileName, fs.readFileSync(fileName, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const names = new Set<string>();
  const visit = (node: ts.Node, className?: string): void => {
    if (ts.isFunctionDeclaration(node) && node.name) names.add(node.name.text);
    else if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      names.add(node.name.text);
      if (className) names.add(`${className}.${node.name.text}`);
    } else if (ts.isClassDeclaration(node) && node.name) {
      const cn = node.name.text;
      for (const m of node.members) {
        if (ts.isMethodDeclaration(m) && ts.isIdentifier(m.name)) {
          names.add(m.name.text);
          names.add(`${cn}.${m.name.text}`);
        }
      }
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) names.add(node.name.text);
    }
    ts.forEachChild(node, (c) => visit(c, className));
  };
  visit(sf);
  return names;
}

const opts = parseArgs(process.argv.slice(2));
const root = path.resolve(opts.root);
const srcDir = path.resolve(root, opts.src);

const inventory: GoFunc[] = JSON.parse(fs.readFileSync(path.resolve(root, opts.inventory), "utf8"));
const covM1 = loadCoverage(path.resolve(root, opts.covM1), srcDir);
const covUnit = loadCoverage(path.resolve(root, opts.covUnit), srcDir);

interface GoVerifiedReg {
  pkg: string;
  count: number;
  evidence: string;
  notEquiv?: { fn: string; reason: string }[];
}
const goVerified = new Map<string, GoVerifiedReg>();
for (const p of JSON.parse(fs.readFileSync(path.resolve(root, opts.goVerified), "utf8")).packages as GoVerifiedReg[]) {
  goVerified.set(p.pkg, p);
}

interface OracleCase { name: string; kind: string; equal: boolean; status: string; exercises: string[] }
let oracleByPkg: Map<string, { applicable: number; equal: number }> = new Map();
const oraclePath = path.resolve(root, opts.oracle);
if (fs.existsSync(oraclePath)) {
  const oracle = JSON.parse(fs.readFileSync(oraclePath, "utf8")) as { cases: OracleCase[] };
  for (const c of oracle.cases) {
    if (c.status === "ts-missing" || c.status === "go-error") continue;
    for (const pkg of c.exercises ?? []) {
      let s = oracleByPkg.get(pkg);
      if (!s) {
        s = { applicable: 0, equal: 0 };
        oracleByPkg.set(pkg, s);
      }
      s.applicable++;
      if (c.equal) s.equal++;
    }
  }
} else {
  oracleByPkg = new Map();
}

/** 逐包收集已移植函数名（progress 的口径） */
const portedByPkg = new Map<string, { file: string; tsFile: string; names: Set<string> }[]>();
const byFile = new Map<string, GoFunc[]>();
for (const f of inventory) {
  if (f.test) continue;
  const list = byFile.get(f.file) ?? [];
  list.push(f);
  byFile.set(f.file, list);
}
for (const [goFile, funcs] of byFile) {
  const tsFile = goFile.endsWith("_test.go") ? goFile.replace(/_test\.go$/, ".test.ts") : goFile.replace(/\.go$/, ".ts");
  const abs = path.resolve(srcDir, tsFile);
  if (!fs.existsSync(abs)) continue;
  const decls = collectDecls(abs);
  const pkg = funcs[0].pkg;
  const list = portedByPkg.get(pkg) ?? [];
  list.push({ file: tsFile, tsFile: abs, names: decls });
  portedByPkg.set(pkg, list);
}

interface Row {
  pkg: string;
  file: string;
  name: string;
  evidence: "go-bytes" | "m1-byte" | "unit-only" | "none";
  m1: boolean;
  unit: boolean;
  oracleApplicable: number;
  oracleEqual: number;
}

const rows: Row[] = [];
for (const f of inventory) {
  if (f.test) continue;
  const entry = (portedByPkg.get(f.pkg) ?? []).find((e) => e.file === f.file.replace(/\.go$/, ".ts"));
  if (!entry || !entry.names.has(f.name)) continue;

  const reg = goVerified.get(f.pkg);
  const goBytesNamed = reg !== undefined && new RegExp(`(?:^|[^A-Za-z0-9_])${f.name}(?:[^A-Za-z0-9_]|$)`).test(reg.evidence);
  const m1 = isCovered(covM1.get(entry.tsFile), f.name);
  const unit = isCovered(covUnit.get(entry.tsFile), f.name);

  let evidence: Row["evidence"];
  if (goBytesNamed) evidence = "go-bytes";
  else if (m1) evidence = "m1-byte";
  else if (unit) evidence = "unit-only";
  else evidence = "none";

  const o = oracleByPkg.get(f.pkg);
  rows.push({
    pkg: f.pkg,
    file: f.file,
    name: f.name,
    evidence,
    m1,
    unit,
    oracleApplicable: o?.applicable ?? 0,
    oracleEqual: o?.equal ?? 0,
  });
}

rows.sort((a, b) => a.pkg.localeCompare(b.pkg) || a.name.localeCompare(b.name));

const byPkg = new Map<string, Row[]>();
for (const r of rows) {
  const list = byPkg.get(r.pkg) ?? [];
  list.push(r);
  byPkg.set(r.pkg, list);
}

const counts: Record<Row["evidence"], number> = { "go-bytes": 0, "m1-byte": 0, "unit-only": 0, none: 0 };
for (const r of rows) counts[r.evidence]++;
const none = rows.filter((r) => r.evidence === "none");

const out = {
  generatedAt: new Date().toISOString(),
  note: "v1：oracle 只有包级 exercises，函数级证据来自 go-verified 点名 + M1/单元覆盖率；判据与回收时点见 PLAN 第 20 次推进 §4。",
  covM1: opts.covM1,
  covUnit: opts.covUnit,
  totalPorted: rows.length,
  evidenceCounts: counts,
  oraclePkg: [...oracleByPkg.entries()].map(([pkg, s]) => ({ pkg, ...s })).sort((a, b) => a.pkg.localeCompare(b.pkg)),
  rows,
};
fs.writeFileSync(path.resolve(root, opts.json), JSON.stringify(out, null, 2) + "\n");

// ---------------------------------------------------------------- markdown
const lines: string[] = [];
lines.push("# 等价证据映射（v1，机械生成）");
lines.push("");
lines.push("> 由 `node --experimental-strip-types tools/equiv-map.ts` 生成。");
lines.push("> 证据等级：`go-bytes`（go-verified.json 的 evidence 文本点名）> `m1-byte`（M1 字节差分运行中执行过）> `unit-only`（只在 npm test 覆盖里执行过）> `none`。");
lines.push("> oracle.json 的 case 只有 `exercises: [包名]`，因此函数继承其包的 applicable/equal 计数；逐 case→逐函数的覆盖需要 per-case coverage（v2）。");
lines.push("");
lines.push(`- 已移植函数：**${rows.length}**`);
lines.push(`- go-bytes：**${counts["go-bytes"]}**；m1-byte：**${counts["m1-byte"]}**；unit-only：**${counts["unit-only"]}**；**none：${counts.none}**`);
lines.push("");
lines.push("## 分档");
lines.push("");
lines.push("| 包 | 已移植 | go-bytes | m1-byte | unit-only | none | oracle 适用/相等（包级） |");
lines.push("| --- | ---: | ---: | ---: | ---: | ---: | --- |");
for (const [pkg, list] of [...byPkg.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const c: Record<Row["evidence"], number> = { "go-bytes": 0, "m1-byte": 0, "unit-only": 0, none: 0 };
  for (const r of list) c[r.evidence]++;
  const o = oracleByPkg.get(pkg);
  lines.push(
    `| \`${pkg}\` | ${list.length} | ${c["go-bytes"]} | ${c["m1-byte"]} | ${c["unit-only"]} | ${c.none} | ${
      o ? `${o.equal}/${o.applicable}` : "—"
    } |`,
  );
}
lines.push("");
lines.push("## oracle 用例 → 包（case 级证据）");
lines.push("");
lines.push("| 包 | 适用 case | equal | 等价比 |");
lines.push("| --- | ---: | ---: | ---: |");
for (const s of out.oraclePkg) {
  lines.push(`| \`${s.pkg}\` | ${s.applicable} | ${s.equal} | ${s.applicable ? ((s.equal / s.applicable) * 100).toFixed(1) : "0.0"}% |`);
}
lines.push("");
lines.push("## 无等价证据（none）");
lines.push("");
if (none.length === 0) lines.push("（空）");
else {
  lines.push("| 包 | 函数 | 文件:行（Go） |");
  lines.push("| --- | --- | --- |");
  const goLine = new Map<string, number>();
  for (const f of inventory) goLine.set(`${f.pkg}\u0000${f.name}`, f.start);
  for (const r of none) {
    lines.push(`| \`${r.pkg}\` | \`${r.name}\` | \`${r.file}:${goLine.get(`${r.pkg}\u0000${r.name}`) ?? "?"}\` |`);
  }
}
lines.push("");
fs.mkdirSync(path.dirname(path.resolve(root, opts.md)), { recursive: true });
fs.writeFileSync(path.resolve(root, opts.md), lines.join("\n"));

console.log(`equiv-map: 已移植 ${rows.length}，go-bytes ${counts["go-bytes"]}，m1-byte ${counts["m1-byte"]}，unit-only ${counts["unit-only"]}，none ${counts.none}`);
console.log(`写出 ${opts.json} 与 ${opts.md}`);
