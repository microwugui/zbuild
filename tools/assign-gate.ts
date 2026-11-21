#!/usr/bin/env node
/**
 * tools/assign-gate.ts —— 静态门：禁止再用 `Object.assign(new X(), {...})` 建节点。
 *
 * 根因见 PLAN.md「第 17 次推进」§3.1：Object.assign 不校验字段名，节点没这个字段时
 * 静默丢弃（类型门也盖不住，历史上丢过 ESpread/EFunction/SExpr 的构造参数）。
 * 现在统一改为 `init(new X(), {...})`（tools/…/helpers/init.ts），`Partial<T>` 受类型约束。
 *
 * 基线 0：任何新增的 `Object.assign(new ` 都直接失败。
 * 排除 helpers/init.ts 自身的注释（那里必然会提到这个旧写法）。
 */

import * as fs from "node:fs";
import * as path from "node:path";

const BASELINE = 0;
const ALLOW = new Set(["src/internal/helpers/init.ts"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const hits: string[] = [];
for (const file of walk("src")) {
  if (ALLOW.has(file)) continue;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("Object.assign(new ")) hits.push(`${file}:${i + 1}: ${lines[i].trim()}`);
  }
}

for (const h of hits) console.log(h);
console.log(`Object.assign(new ): ${hits.length}（baseline ${BASELINE}，只许降不许升）`);
if (hits.length > BASELINE) process.exit(1);
