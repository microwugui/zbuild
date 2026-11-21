// bench/ab_worker.ts —— 单个 block 的进程内配对 A/B 采样器（供 bench/ab_orch.py 调用）。
//
// 关键设计（v3，已由空自测证伪 v1/v2 后重写）：
//  - 每个进程只加载 2 个实例（base, cand）。--order 决定先 import 哪个：base-first / cand-first。
//    两棵树各自的 internal/* 是独立 JIT 单元，先加载的树在进程内有固定优势；单进程无法消除，
//    故由 orchestrator 跑正反两种 --order 的 block，跨进程抵消。
//  - 每个样本用随机顺序（非严格交替）。v2 的严格交替会与 GC 周期性共振，产生 ~4% 系统偏置。
//  - 输出逐配对 ratios[i]=base_ms/cand_ms 与 bytesEqual，供 orchestrator 汇总 bootstrap。
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";

function arg(n: string): string | undefined {
  const a = process.argv.slice(2); const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined;
}
function median(a: number[]): number {
  const v = [...a].sort((x, y) => x - y); const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
async function main() {
  const basePath = arg("--base")!, candPath = arg("--cand")!, entry = arg("--entry")!;
  const n = Number(arg("--n") ?? 10), warmup = Number(arg("--warmup") ?? 3);
  const order = arg("--order") ?? "base-first";
  const stamp = Date.now() + "-" + Math.random();
  let base: any, cand: any;
  if (order === "cand-first") {
    cand = await import(candPath + "?v=c-" + stamp);
    base = await import(basePath + "?v=b-" + stamp);
  } else {
    base = await import(basePath + "?v=b-" + stamp);
    cand = await import(candPath + "?v=c-" + stamp);
  }
  const run = (m: any) => m.bundleWithImports(entry);
  // 关键：预热顺序必须跟随 import 顺序。若恒为 base→cand，则 base 永远拿到「首次执行」的
  // JIT 优势，cand-first 的交叉就被抵消——这正是 v3.1 残留 ~3% 偏置的根因。
  const first = order === "cand-first" ? cand : base;
  const second = order === "cand-first" ? base : cand;
  for (let w = 0; w < warmup; w++) { run(first); run(second); }
  const B: number[] = [], C: number[] = [];
  let seed = 987654321;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < n; i++) {
    if (rnd() < 0.5) {
      let t = performance.now(); run(base); B.push(performance.now() - t);
      t = performance.now(); run(cand); C.push(performance.now() - t);
    } else {
      let t = performance.now(); run(cand); C.push(performance.now() - t);
      t = performance.now(); run(base); B.push(performance.now() - t);
    }
  }
  const ob = run(base), oc = run(cand);
  let bytesEqual = ob.ok === oc.ok && ob.output.length === oc.output.length;
  if (bytesEqual) for (let i = 0; i < ob.output.length; i++) if (ob.output[i] !== oc.output[i]) { bytesEqual = false; break; }
  const ratios = B.map((x, i) => x / C[i]);
  console.log(JSON.stringify({
    order, n, bytesEqual,
    outLen: ob.ok ? ob.output.length : -1,
    outSha: ob.ok ? createHash("sha256").update(ob.output).digest("hex") : null,
    baseMed: +median(B).toFixed(3), candMed: +median(C).toFixed(3),
    ratios: ratios.map((x) => +x.toFixed(5)),
  }));
}
main().catch((e: any) => { console.log(JSON.stringify({ error: String(e?.message ?? e) })); process.exit(1); });
