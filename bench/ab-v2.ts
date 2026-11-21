// bench/ab.ts —— 阶段0 进程内配对 A/B 基准（方法论 [38390] 阶段0）v2。
//
// v1 的三个缺陷（均由 base==cand 空自测证实，见 bench/AB_NOTES.md）：
//   1) verdict 方向写反：ratio=base/cand，>1 才是 cand 更快，v1 却把 hi<1 判成 SIGNIFICANT_FASTER。
//   2) 首导入偏置：call-site/模块实例初始化顺序使「先 import 的实例」稳定快 4~6%，
//      相同代码也会得出 CI 不含 1 的假阳性。
//   3) 所谓 paired bootstrap 实为 base/cand 各自独立抽样，不是真配对。
//
// v2 修正：
//   - 交叉(crossover)设计：加载 4 个实例 baseA,candA,candB,baseB，导入序
//     [baseA(先), candA, candB, baseB]。pass1 测 baseA/candA（base 先导入，偏向 base），
//     pass2 测 baseB/candB（cand 先导入，偏向 cand）。逐配对取几何平均 sqrt(r1*r2)，
//     乘性首导入偏置 k 精确约掉：sqrt((T_b*k/T_c)*(T_b/(T_c*k)))=T_b/T_c。
//   - 真配对 bootstrap：对同一配对索引 i 重采样 rc[i]=sqrt(r1[i]*r2[i])。
//   - 判定方向纠错：speedup=median(base/cand)，>1=候选更快；CI 全>1=FASTER，全<1=SLOWER，含1=NOT_SIGNIFICANT。
//
// 判定硬门：bytesEqual 必须为 true，否则 BYTES_DIFFER 直接失败(exit 3)，不比较性能。
//
// 用法:
//   GOMAXPROCS=1 node --experimental-strip-types bench/ab.ts \
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
// 真配对 bootstrap：对同一索引 i 重采样合并后的 speedup rc[i]，取中位数分布 95% CI。
function bootstrapMedianCI(rc: number[], B = 20000): [number, number] {
  const n = rc.length;
  const meds: number[] = [];
  let seed = 0x2f6e2b1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let b = 0; b < B; b++) {
    const s: number[] = [];
    for (let i = 0; i < n; i++) s.push(rc[Math.floor(rnd() * n)]);
    meds.push(median(s));
  }
  meds.sort((x, y) => x - y);
  return [meds[Math.floor(0.025 * B)], meds[Math.floor(0.975 * B)]];
}
function bytesOf(r: any): Uint8Array | null { return r && r.ok ? r.output : null; }
function equalBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function main() {
  const a = args();
  const basePath = a["--base"], candPath = a["--cand"], entry = resolve(a["--entry"]);
  const n = Number(a["--n"] ?? 24), warmup = Number(a["--warmup"] ?? 4);
  const out = a["--out"] ?? "bench/ab-result.json";
  if (!basePath || !candPath || !entry) throw new Error("need --base --cand --entry");

  // 4 个独立实例；导入序刻意让 base 先、cand 后，再 cand 先、base 后。
  const stamp = Date.now();
  const mk = (p: string, tag: string) => import(p + "?v=" + tag + "-" + stamp + "-" + Math.random());
  const baseA: any = await mk(basePath, "baseA");       // 位置1（最快偏置）
  const candA: any = await mk(candPath, "candA");       // 位置2
  const candB: any = await mk(candPath, "candB");       // 位置3
  const baseB: any = await mk(basePath, "baseB");       // 位置4
  const run = (mod: any) => mod.bundleWithImports(entry);

  // 预热：每个实例各 warmup 次，顺序对称（A 组 base→cand，B 组 cand→base）。
  for (let i = 0; i < warmup; i++) { run(baseA); run(candA); run(candB); run(baseB); }

  // pass1：baseA(先导入) vs candA。交错抵消「对内先后」偏置。
  const b1: number[] = [], c1: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) {
      let t = performance.now(); run(baseA); b1.push(performance.now() - t);
      t = performance.now(); run(candA); c1.push(performance.now() - t);
    } else {
      let t = performance.now(); run(candA); c1.push(performance.now() - t);
      t = performance.now(); run(baseA); b1.push(performance.now() - t);
    }
  }
  // pass2：baseB(后导入) vs candB(先导入)。
  const b2: number[] = [], c2: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) {
      let t = performance.now(); run(baseB); b2.push(performance.now() - t);
      t = performance.now(); run(candB); c2.push(performance.now() - t);
    } else {
      let t = performance.now(); run(candB); c2.push(performance.now() - t);
      t = performance.now(); run(baseB); b2.push(performance.now() - t);
    }
  }

  // 逐配对合并：rc[i]=sqrt(r1[i]*r2[i])，乘性首导入偏置约掉。
  const rc: number[] = [];
  for (let i = 0; i < n; i++) rc.push(Math.sqrt((b1[i] / c1[i]) * (b2[i] / c2[i])));

  // 产物等价：四个实例产出的字节必须全一致。
  const oa1 = run(baseA), oa2 = run(candA), ob1 = run(candB), ob2 = run(baseB);
  const bytesEqual = equalBytes(bytesOf(oa1), bytesOf(oa2)) &&
                     equalBytes(bytesOf(oa1), bytesOf(ob1)) &&
                     equalBytes(bytesOf(oa1), bytesOf(ob2));
  const outLen = bytesOf(oa1)?.length ?? -1;

  const speedup = median(rc);                 // >1 表示候选更快
  const [lo, hi] = bootstrapMedianCI(rc);
  const verdict = !bytesEqual ? "BYTES_DIFFER" :
    lo > 1.0 ? "SIGNIFICANT_FASTER" :
    hi < 1.0 ? "SIGNIFICANT_SLOWER" : "NOT_SIGNIFICANT";

  const result = {
    entry, n, warmup,
    outBytes: outLen,
    pass1_base_ms_median: +median(b1).toFixed(4),
    pass1_cand_ms_median: +median(c1).toFixed(4),
    pass2_base_ms_median: +median(b2).toFixed(4),
    pass2_cand_ms_median: +median(c2).toFixed(4),
    pass1_ratio: +(median(b1) / median(c1)).toFixed(4),
    pass2_ratio: +(median(b2) / median(c2)).toFixed(4),
    speedup_base_over_cand: +speedup.toFixed(4),
    ci95_speedup: [+lo.toFixed(4), +hi.toFixed(4)],
    bytesEqual,
    verdict,
    note: "crossover 4-instance in-process paired A/B; rc=sqrt(r1*r2) cancels multiplicative first-import bias; CI of median(base/cand) via paired bootstrap B=20000; >1=cand faster; CI含1不算赢",
  };
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!bytesEqual) process.exit(3);
}
main().catch((e) => { console.error(e); process.exit(1); });
