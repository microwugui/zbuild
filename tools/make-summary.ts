#!/usr/bin/env node
/**
 * make-summary.ts —— 把 2.7MB 的 oracle.json 压成可入库的小摘要，
 * 并把 go-error 用例按来源分桶 dump 到 /tmp/go-error.txt，供根因分析。
 *
 * 用法: node --experimental-strip-types tools/make-summary.ts
 */

import * as fs from "node:fs";

const oracle = JSON.parse(fs.readFileSync("oracle.json", "utf8"));
const fixtures = JSON.parse(fs.readFileSync("tools/fixtures.json", "utf8"));

const ge = oracle.cases.filter((c: { status: string }) => c.status === "go-error");

// 按来源目录分桶（路径前三段）
const buckets: Record<string, number> = {};
for (const c of ge) {
  const parts = String(c.file).split("/");
  const key = parts.slice(0, 2).join("/");
  buckets[key] = (buckets[key] ?? 0) + 1;
}

const summary = {
  generatedAt: new Date().toISOString(),
  corpus: oracle.corpus,
  total: oracle.total,
  applicable: oracle.applicable,
  equal: oracle.equal,
  byStatus: oracle.byStatus,
  tsMissing: oracle.tsMissing,
  fixtures: (fixtures as { name: string; referenceSha256: string }[]).map((f) => ({
    name: f.name,
    referenceSha256: f.referenceSha256,
  })),
};

fs.writeFileSync("oracle-summary.json", JSON.stringify(summary, null, 2) + "\n");

const lines = [
  `# go-error 用例 ${ge.length} 个（按来源目录分桶）`,
  JSON.stringify(buckets, null, 2),
  "",
  "# 文件清单",
  ...ge.map((c: { file: string; args: string[] }) => `${c.file}\t${c.args.join(" ")}`),
];
fs.writeFileSync("/tmp/go-error.txt", lines.join("\n") + "\n");

console.log(`摘要已写入 oracle-summary.json；go-error ${ge.length} 个 → /tmp/go-error.txt`);
console.log(JSON.stringify(buckets));
