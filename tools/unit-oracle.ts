#!/usr/bin/env node
/**
 * unit-oracle.ts —— 「单元差分」通道的记账器
 *
 * 背景：js_lexer / js_ast / js_parser 的等价性证据是**单元测试形态**的差分
 * （期望值全部是 Go 实测产物，见各 test.ts 文件头），而不是 tools/oracle.ts 的 cli/fixture 通道。
 * 看板（tools/progress.ts）只认 oracle.json，所以这些包会一直显示「已等价 0」——那是口径洞，不是没验。
 *
 * 本工具把这条通道接进同一套记账：
 *   1. 读 tools/unit-differential.json 的清单；
 *   2. 逐个核对夹具的 sha256（与清单里钉住的值一致，防止语料被悄悄改小/重生）；
 *   3. 跑每条 `tests` 里的测试文件（node --test），全绿才算 equal；
 *   4. 写出 unit-oracle.json（schema 与 oracle.json 的 cases 对齐，kind="unit"）。
 *
 * 与 oracle.ts 的 fixture 通道相比**弱一档**：这里不会当场重跑 Go 生成器（那需要 /root/esbuild），
 * 只校验「夹具没变 + 测试全绿」。夹具本身仍是 Go 产物且哈希钉死，所以没有自证循环。
 *
 * 用法: node --experimental-strip-types tools/unit-oracle.ts [--out unit-oracle.json] [--quiet]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";

interface Manifest {
  name: string;
  package: string;
  note?: string;
  tests: string[];
  fixtures: { path: string; sha256: string }[];
}

interface UnitCase {
  name: string;
  kind: "unit";
  file: string;
  equal: boolean;
  status: "equal" | "fixture-stale" | "test-fail" | "test-missing";
  exercises: string[];
  referenceSha256: string;
}

const argv = process.argv.slice(2);
let out = "unit-oracle.json";
let quiet = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--out") out = argv[++i];
  else if (argv[i] === "--quiet") quiet = true;
}

const manifestPath = "tools/unit-differential.json";
if (!fs.existsSync(manifestPath)) {
  console.error(`找不到清单: ${manifestPath}`);
  process.exit(2);
}
const manifest: Manifest[] = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

const sha256 = (buf: Buffer): string => crypto.createHash("sha256").update(buf).digest("hex");

const cases: UnitCase[] = [];
let allOk = true;

for (const entry of manifest) {
  let status: UnitCase["status"] = "equal";
  let referenceSha256 = "";

  for (const fixture of entry.fixtures) {
    if (!fs.existsSync(fixture.path)) {
      status = "fixture-stale";
      referenceSha256 = "(missing)";
      break;
    }
    const actual = sha256(fs.readFileSync(fixture.path));
    referenceSha256 = actual;
    if (actual !== fixture.sha256) {
      status = "fixture-stale";
      break;
    }
  }

  for (const testFile of entry.tests) {
    if (status !== "equal") break;
    if (!fs.existsSync(testFile)) {
      status = "test-missing";
      break;
    }
    const r = spawnSync("node", ["--experimental-strip-types", "--test", testFile], {
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0) {
      status = "test-fail";
      break;
    }
  }

  if (status !== "equal") allOk = false;
  cases.push({
    name: `unit:${entry.name}`,
    kind: "unit",
    file: entry.tests.join(","),
    equal: status === "equal",
    status,
    exercises: [entry.package],
    referenceSha256,
  });

  if (!quiet) {
    const label = status === "equal" ? "OK  " : "FAIL";
    console.log(`${label} ${entry.package.padEnd(24)} ${entry.name.padEnd(34)} ${status}`);
  }
}

const payload = {
  generatedAt: new Date().toISOString(),
  total: cases.length,
  applicable: cases.length,
  equal: cases.filter((c) => c.equal).length,
  cases,
};
fs.writeFileSync(path.resolve(out), JSON.stringify(payload, null, 2) + "\n");
if (!quiet) console.log(`\n写出 ${out}：${payload.equal}/${payload.total} 通过`);
process.exit(allOk ? 0 : 1);
