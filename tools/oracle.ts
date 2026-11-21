#!/usr/bin/env node
/**
 * oracle.ts —— 差分 oracle：唯一的行为等价判据
 *
 * 两类用例：
 *   kind=cli     参照实现 = Go esbuild 二进制；被测 = src/cli.ts。逐字节比对 stdout。
 *   kind=fixture 参照实现 = 由 Go 参考实现生成的基准数据（tools/gen_*_fixture.go）；
 *                被测 = 对应包的单元测试。测试全绿即判定该包函数级等价。
 *
 * 语料由目录扫描自动生成（不手工挑文件），并输出 oracle-corpus.json 供复核：
 *   - testdata/three/package/build/*.js      构建产物（M1 验收目标）
 *   - testdata/three/package/src/**\/*.js    源码态（757 个文件）
 *   - testdata/esbuild-cases/**\/*.js        从 esbuild 自带 Go 测试里自动提取的输入
 *
 * 用法:
 *   node --experimental-strip-types tools/oracle.ts [--limit N] [--params 2]
 *        [--go /tmp/esbuild-go] [--ts "..."] [--go-only] [--out oracle.json]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";

interface Case {
  name: string;
  kind: "cli" | "fixture";
  file: string;
  args: string[];
  exercises: string[];
}

interface Result {
  name: string;
  kind: "cli" | "fixture";
  file: string;
  args: string[];
  equal: boolean;
  status: "equal" | "diff" | "ts-missing" | "go-error" | "ts-error" | "fixture-fail" | "fixture-stale";
  goBytes: number;
  tsBytes: number;
  exercises: string[];
  referenceSha256?: string;
}

const TRANSFORM_PKGS = [
  "internal/js_lexer",
  "internal/js_ast",
  "internal/js_parser",
  "internal/js_printer",
  "internal/helpers",
  "internal/ast",
];

const PARAM_MATRIX: { name: string; args: string[] }[] = [
  { name: "esm", args: ["--loader=js", "--format=esm"] },
  { name: "esm-min", args: ["--loader=js", "--format=esm", "--minify"] },
  { name: "iife-min-es2015", args: ["--loader=js", "--format=iife", "--minify", "--target=es2015"] },
  { name: "cjs-ascii-sm", args: ["--loader=js", "--format=cjs", "--charset=ascii", "--sourcemap=inline"] },
];

function parseArgs(argv: string[]) {
  const o = {
    go: "/tmp/esbuild-go",
    ts: "node --experimental-strip-types src/cli.ts",
    limit: 0,
    params: 0, // 0 = 全部
    out: "oracle.json",
    corpus: "oracle-corpus.json",
    goOnly: false,
    /** 诊断开关：全量跑时跳过差异例的 shrink（只影响产出的最小复现，不影响 equal/diff 判定） */
    noShrink: false,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--go": o.go = argv[++i]; break;
      case "--ts": o.ts = argv[++i]; break;
      case "--limit": o.limit = parseInt(argv[++i], 10); break;
      case "--params": o.params = parseInt(argv[++i], 10); break;
      case "--out": o.out = argv[++i]; break;
      case "--corpus": o.corpus = argv[++i]; break;
      case "--go-only": o.goOnly = true; break;
      case "--no-shrink": o.noShrink = true; break;
      default:
        if (argv[i].startsWith("--")) {
          console.error(`未知参数: ${argv[i]}`);
          process.exit(2);
        }
    }
  }
  return o;
}

function walk(dir: string, ext: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      out.push(...walk(p, ext));
    } else if (e.name.endsWith(ext)) {
      out.push(p);
    }
  }
  return out.sort();
}

const sha256 = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

const opts = parseArgs(process.argv.slice(2));

// ---- 语料清单：目录扫描，不手工挑 ----
const SOURCES: { id: string; dir: string; glob: string; files: string[] }[] = [
  { id: "three-build", dir: "testdata/three/package/build", glob: "*.js", files: walk("testdata/three/package/build", ".js") },
  { id: "three-src", dir: "testdata/three/package/src", glob: "**/*.js", files: walk("testdata/three/package/src", ".js") },
  { id: "esbuild-cases", dir: "testdata/esbuild-cases", glob: "**/*.js", files: walk("testdata/esbuild-cases", ".js") },
];

const params = opts.params > 0 ? PARAM_MATRIX.slice(0, opts.params) : PARAM_MATRIX;

const cases: Case[] = [];
for (const src of SOURCES) {
  for (const f of src.files) {
    for (const p of params) {
      cases.push({
        name: `${path.relative("testdata", f)}::${p.name}`,
        kind: "cli",
        file: f,
        args: p.args,
        exercises: TRANSFORM_PKGS,
      });
    }
  }
}

// ---- 函数级差分（fixture）用例 ----
interface Fixture { name: string; package: string; test: string; fixture: string; generator: string; referenceSha256: string; }
let fixtures: Fixture[] = [];
const fixtureByName = new Map<string, Fixture>();
const fixturesPath = "tools/fixtures.json";
if (fs.existsSync(fixturesPath)) {
  fixtures = JSON.parse(fs.readFileSync(fixturesPath, "utf8"));
  for (const fx of fixtures) {
    fixtureByName.set(`fixture:${fx.name}`, fx);
    cases.unshift({
      name: `fixture:${fx.name}`,
      kind: "fixture",
      file: fx.test,
      args: [],
      exercises: [fx.package],
    });
  }
}

const corpusManifest = {
  generatedAt: new Date().toISOString(),
  paramMatrix: params.map((p) => ({ name: p.name, args: p.args })),
  sources: SOURCES.map((s) => ({
    id: s.id,
    dir: s.dir,
    glob: s.glob,
    files: s.files.length,
    bytes: s.files.reduce((n, f) => n + fs.statSync(f).size, 0),
    sha256: sha256(Buffer.concat(s.files.map((f) => fs.readFileSync(f)))),
    caseCount: s.files.length * params.length,
    paths: s.files,
  })),
  cliCases: SOURCES.reduce((n, s) => n + s.files.length * params.length, 0),
  fixtureCases: cases.filter((c) => c.kind === "fixture").length,
};
fs.writeFileSync(path.resolve(opts.corpus), JSON.stringify(corpusManifest, null, 2) + "\n");

const selected = opts.limit > 0 ? cases.slice(0, opts.limit) : cases;
const diffDir = path.resolve("testdata/oracle-diffs");
fs.mkdirSync(diffDir, { recursive: true });

function run(cmd: string, args: string[] = [], input?: Buffer) {
  const [bin, ...rest] = cmd.split(/\s+/);
  return spawnSync(bin, [...rest, ...args], {
    input,
    maxBuffer: 256 * 1024 * 1024,
    encoding: "buffer",
  });
}

const results: Result[] = [];
let tsMissing = false;
const tsEntryExists = fs.existsSync(path.resolve("src/cli.ts"));

for (const c of selected) {
  if (c.kind === "fixture") {
    const fx = fixtureByName.get(c.name)!;
    // 防自证循环：基准必须由 Go 参考实现当场重新生成，并与钉住的哈希一致。
    // 哈希不匹配说明基准过期（或人与实现同时改过），一律判失败，不静默通过。
    const gen = spawnSync("bash", ["-c", fx.generator], { maxBuffer: 64 * 1024 * 1024, encoding: "buffer" });
    const refBytes = gen.stdout ?? Buffer.alloc(0);
    const refHash = sha256(refBytes);
    if (gen.status !== 0 || refHash !== fx.referenceSha256) {
      results.push({
        name: c.name, kind: "fixture", file: c.file, args: [], equal: false,
        status: "fixture-stale", goBytes: refBytes.length, tsBytes: 0,
        exercises: c.exercises, referenceSha256: refHash,
      });
      continue;
    }
    const r = run(`node --experimental-strip-types --test ${c.file}`);
    const ok = r.status === 0;
    results.push({
      name: c.name, kind: "fixture", file: c.file, args: [], equal: ok,
      status: ok ? "equal" : "fixture-fail",
      goBytes: refBytes.length, tsBytes: (r.stdout ?? Buffer.alloc(0)).length,
      exercises: c.exercises, referenceSha256: refHash,
    });
    continue;
  }

  const input = fs.readFileSync(c.file);
  const go = run(opts.go, c.args, input);
  const goOut = go.stdout ?? Buffer.alloc(0);

  // Go 侧主动报错（非法语法用例）→ 不适用，从分母里剔除
  if (go.status !== 0) {
    results.push({
      name: c.name, kind: "cli", file: c.file, args: c.args, equal: false,
      status: "go-error", goBytes: goOut.length, tsBytes: 0, exercises: c.exercises,
    });
    continue;
  }

  if (opts.goOnly) {
    results.push({
      name: c.name, kind: "cli", file: c.file, args: c.args, equal: true,
      status: "equal", goBytes: goOut.length, tsBytes: 0, exercises: c.exercises,
    });
    continue;
  }

  if (!tsEntryExists) {
    tsMissing = true;
    results.push({
      name: c.name, kind: "cli", file: c.file, args: c.args, equal: false,
      status: "ts-missing", goBytes: goOut.length, tsBytes: 0, exercises: c.exercises,
    });
    continue;
  }

  const ts = run(opts.ts, c.args, input);
  const tsOut = ts.stdout ?? Buffer.alloc(0);
  if (ts.status !== 0) {
    results.push({
      name: c.name, kind: "cli", file: c.file, args: c.args, equal: false,
      status: "ts-error", goBytes: goOut.length, tsBytes: tsOut.length, exercises: c.exercises,
    });
    continue;
  }

  const equal = goOut.length === tsOut.length && goOut.equals(tsOut);
  if (!equal) {
    const slug = c.name.replace(/[^a-zA-Z0-9_.-]+/g, "_");
    fs.writeFileSync(path.join(diffDir, `${slug}.go.txt`), goOut);
    fs.writeFileSync(path.join(diffDir, `${slug}.ts.txt`), tsOut);
    const minimal = opts.noShrink ? input : shrink(input, (inp) => {
      const g = run(opts.go, c.args, inp);
      const t = run(opts.ts, c.args, inp);
      return g.status === 0 && t.status === 0 &&
        !(g.stdout ?? Buffer.alloc(0)).equals(t.stdout ?? Buffer.alloc(0));
    });
    fs.writeFileSync(path.join(diffDir, `${slug}.min.js`), minimal);
  }
  results.push({
    name: c.name, kind: "cli", file: c.file, args: c.args, equal,
    status: equal ? "equal" : "diff",
    goBytes: goOut.length, tsBytes: tsOut.length, exercises: c.exercises,
  });
}

/** 按行二分收缩，返回仍能复现差异的最小输入 */
function shrink(input: Buffer, fails: (b: Buffer) => boolean): Buffer {
  let lines = input.toString("utf8").split("\n");
  let best = input;
  for (let round = 0; round < 12; round++) {
    let changed = false;
    const chunk = Math.max(1, Math.floor(lines.length / 2));
    for (let start = 0; start < lines.length; start += chunk) {
      const candidate = lines.slice(0, start).concat(lines.slice(start + chunk));
      if (candidate.length === 0) continue;
      const buf = Buffer.from(candidate.join("\n"), "utf8");
      if (fails(buf)) {
        lines = candidate;
        best = buf;
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  return best;
}

const applicable = results.filter((r) => r.status !== "go-error");
const equalCount = applicable.filter((r) => r.equal).length;
// 修复（第 19 次推进）：corpusManifest.cliCases 已经乘过 params.length，不能再乘一次。
// 真实总量 = cli 例数（含参数矩阵）+ fixture 例数。
const corpusTotal = corpusManifest.cliCases + corpusManifest.fixtureCases;
const summary = {
  generatedAt: new Date().toISOString(),
  goBinary: opts.go,
  tsCommand: opts.ts,
  // 口径：本文件只评估了前 limit 个 cli 用例（0 = 全部）与 params 组参数；
  // corpusTotal 是“全部 cli 用例 × 全部参数 + fixture”的总量。看板必须显示“已评估 X / Y（子集）”。
  limit: opts.limit,
  params: params.map((p) => p.name),
  corpus: {
    cliCases: corpusManifest.cliCases, fixtureCases: corpusManifest.fixtureCases,
    corpusTotal,
    // 全部 4 组参数下的总量（看板用来说明本次只是子集）
    corpusTotalAllParams: SOURCES.reduce((n, s) => n + s.files.length, 0) * PARAM_MATRIX.length +
      corpusManifest.fixtureCases,
    sources: corpusManifest.sources.map((s) => ({ id: s.id, files: s.files, bytes: s.bytes, caseCount: s.caseCount })),
  },
  total: results.length,
  applicable: applicable.length,
  equal: equalCount,
  tsMissing,
  byStatus: results.reduce<Record<string, number>>((m, r) => {
    m[r.status] = (m[r.status] ?? 0) + 1;
    return m;
  }, {}),
  cases: results,
};

fs.writeFileSync(path.resolve(opts.out), JSON.stringify(summary, null, 2) + "\n");

console.log(`差分 oracle: ${equalCount}/${applicable.length} 适用用例一致` +
  `（总 ${results.length}，不适用 ${results.length - applicable.length}）`);
for (const [k, v] of Object.entries(summary.byStatus)) console.log(`  ${k}: ${v}`);
for (const s of corpusManifest.sources) console.log(`  语料 ${s.id}: ${s.files} 文件 / ${s.bytes} 字节 / ${s.caseCount} 例`);
console.log(`已写出 ${opts.out} 与 ${opts.corpus}`);
if (equalCount !== applicable.length) process.exitCode = 1;
