// bench/ab.ts —— 阶段0 进程内配对 A/B 基准（方法论 [38390] 阶段0）。
// 基线↔候选同一 Node 进程内以 cache-busting 查询串各加载一份模块实例，交错调用，
// 消除进程启动偏置；每轮 warmup 后采 N 个样本，报中位数 + bootstrap 95% CI。
// 判定规则：ratio 的 95% CI 含 1.0 → 不显著（NOT_SIGNIFICANT），不得宣称提速。
//
// 用法:
//   node --experimental-strip-types bench/ab.ts \
//     --base /root/port-baseline/src/bundle_multi.ts \
//     --cand /root/port/src/bundle_multi.ts \
//     --entry testdata/three/package/build/three.module.js \
//     --n 24 --warmup 4 --out bench/ab-result.json
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

function args(): Record<string, string> {
  const a: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) a[argv[i]] = argv[i + 1];
  return a;
}

function median(s: number[]): number {
  const v = [...s].sort((x, y) => x - y);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
function pct(s: number[], q: number): number {
  const v = [...s].sort((x, y) => x - y);
  const k = Math.max(0, Math.min(v.length - 1, Math.round(q * (v.length - 1))));
  return v[k];
}
// paired bootstrap CI of median(base/cand) ratio: resample pair indices B times.
function bootstrapRatioCI(base: number[], cand: number[], B = 20000): [number, number] {
  const n = Math.min(base.length, cand.length);
  const ratios: number[] = [];
  // deterministic LCG for reproducibility
  let seed = 0x2f6e2b1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += base[Math.floor(rnd() * n)] / cand[Math.floor(rnd() * n)];
    ratios.push(s / n);
  }
  ratios.sort((x, y) => x - y);
  return [ratios[Math.floor(0.025 * B)], ratios[Math.floor(0.975 * B)]];
}

async function main() {
  const a = args();
  const basePath = a["--base"], candPath = a["--cand"], entry = resolve(a["--entry"]);
  const n = Number(a["--n"] ?? 24), warmup = Number(a["--warmup"] ?? 4);
  const out = a["--out"] ?? "bench/ab-result.json";
  if (!basePath || !candPath || !entry) throw new Error("need --base --cand --entry");

  // 两个模块实例（cache-busting 查询串，避免同一 ESM 实例）
  const baseMod: any = await import(basePath + "?v=base-" + Date.now());
  const candMod: any = await import(candPath + "?v=cand-" + Date.now());
  const run = (mod: any) => mod.bundleWithImports(entry);

  // warmup（两侧各 warmup 次，不计时）
  for (let i = 0; i < warmup; i++) { run(baseMod); run(candMod); }

  const base: number[] = [], cand: number[] = [];
  // 交错 A/B：偶数轮先 base 后 cand，奇数轮反转，抵消顺序偏置
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) {
      let t = performance.now(); run(baseMod); base.push(performance.now() - t);
      t = performance.now(); run(candMod); cand.push(performance.now() - t);
    } else {
      let t = performance.now(); run(candMod); cand.push(performance.now() - t);
      t = performance.now(); run(baseMod); base.push(performance.now() - t);
    }
  }
  // 产物等价校验：两侧 output 逐字节一致才允许比较
  const rb = run(baseMod), rc = run(candMod);
  let bytesEqual = rb.ok === rc.ok && rb.output.length === rc.output.length;
  if (bytesEqual) for (let i = 0; i < rb.output.length; i++) { if (rb.output[i] !== rc.output[i]) { bytesEqual = false; break; } }

  const mb = median(base), mc = median(cand);
  const [lo, hi] = bootstrapRatioCI(base, cand);
  const significant = bytesEqual && hi < 1.0; // cand 显著快于 base
  const result = {
    entry, n, warmup,
    base_ms: { median: +mb.toFixed(4), p10: +pct(base, 0.1).toFixed(4), p90: +pct(base, 0.9).toFixed(4) },
    cand_ms: { median: +mc.toFixed(4), p10: +pct(cand, 0.1).toFixed(4), p90: +pct(cand, 0.9).toFixed(4) },
    ratio_base_over_cand: +(mb / mc).toFixed(4),
    ci95_ratio: [+lo.toFixed(4), +hi.toFixed(4)],
    bytesEqual,
    verdict: !bytesEqual ? "BYTES_DIFFER" : significant ? "SIGNIFICANT_FASTER" :
      (lo > 1.0 ? "SIGNIFICANT_SLOWER" : "NOT_SIGNIFICANT"),
    note: "in-process paired A/B; CI of median(base/cand) via paired bootstrap B=20000; CI 含 1.0 不算赢",
  };
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!bytesEqual) process.exit(3);
}
main().catch((e) => { console.error(e); process.exit(1); });
