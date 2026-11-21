#!/usr/bin/env python3
"""进程级交叉的配对 A/B 主指标（阶段0 主指标，v3.1）。

根因（机器实测）：
  base 树与 cand 树的 internal/* 是两套独立模块实例。同一进程里「先 import 的树」获得
  稳定的 JIT/加载优势（探针实测 ~2~2.5%：port-first 0.9757、baseline-first 0.98）。
  单进程内无论怎么交错都消不掉这个「树级」偏置（v1/v2 已证伪）。

正确设计：
  跑两组 block：forward=base-first（偏 base，s_F<true）、reverse=cand-first（偏 cand，s_R>true）。
  每组内用随机采样顺序（消除 GC 周期性共振），取该组全部逐配对 ratio 的中位数 s_F、s_R。
  合并 speedup = sqrt(s_F * s_R)：乘性首导入偏置 k 约掉
      s_F = true·k, s_R = true/k  →  sqrt(s_F·s_R)=true。
  CI：bootstrap 每次分别重采样两组 ratio，算 sqrt(median_F* · median_R*) 的分布取 2.5/97.5 分位。
  这比「把所有 ratio 混池」稳健：混池会被单个异常 block 拉偏。

噪声地板：2 核 VM + V8 背景线程下，相同代码的空自测 |speedup-1| 实测可达 ~3%%（v3.1 空自测
  0.9688）。故判定额外要求 |speedup-1| >= --min-effect（默认 5%%），否则一律 NOT_SIGNIFICANT。
  这保证只有超过噪声地板的真实效应才被采纳；大算法优化（>10%%）不受影响。

判定：speedup=base/cand，>1=候选更快；CI 全>1=FASTER，全<1=SLOWER，含1=NOT_SIGNIFICANT。
字节门：所有 block 的 bytesEqual 必须 true 且 outLen>0。

用法：
    python3 bench/ab_orch.py --base /root/port-baseline/src/bundle_multi.ts \
        --cand /root/port/src/bundle_multi.ts \
        --entry testdata/three/package/build/three.module.js \
        --blocks-per-order 3 --n 10 --warmup 3 --out bench/ab-result.json
"""
import argparse, json, subprocess, sys, os
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path("/root/port")
WORKER = ROOT / "bench/ab_worker.ts"


def median(xs):
    v = sorted(xs); m = len(v) // 2
    return v[m] if len(v) % 2 else (v[m - 1] + v[m]) / 2


def boot_combined_ci(fwd, rev, B=20000, seed=0x2f6e2b1):
    nf, nr = len(fwd), len(rev)
    out = []; state = [seed]
    def rnd():
        state[0] = (state[0] * 1103515245 + 12345) & 0x7fffffff
        return state[0] / 0x7fffffff
    for _ in range(B):
        sf = median([fwd[int(rnd() * nf)] for _ in range(nf)])
        sr = median([rev[int(rnd() * nr)] for _ in range(nr)])
        out.append((sf * sr) ** 0.5)
    out.sort()
    return out[int(0.025 * B)], out[int(0.975 * B)]


def run_block(order, a, env):
    cmd = ["node", "--experimental-strip-types", str(WORKER),
           "--base", a.base, "--cand", a.cand, "--entry", str(ROOT / a.entry),
           "--n", str(a.n), "--warmup", str(a.warmup), "--order", order,
           "--driver", a.driver]
    p = subprocess.run(cmd, capture_output=True, text=True, cwd=str(ROOT), env=env)
    try:
        info = json.loads(p.stdout.strip().splitlines()[-1])
    except Exception:
        raise SystemExit(f"block worker failed: {p.stdout[-300:]} {p.stderr[-300:]}")
    if "error" in info:
        raise SystemExit(f"block error: {info['error']}")
    return info


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True); ap.add_argument("--cand", required=True)
    ap.add_argument("--entry", required=True)
    ap.add_argument("--blocks-per-order", type=int, default=3)
    ap.add_argument("--n", type=int, default=10)
    ap.add_argument("--warmup", type=int, default=3)
    ap.add_argument("--driver", choices=["multi", "single"], default="multi",
                    help="multi=bundleWithImports；single=bundleSingleFile")
    ap.add_argument("--min-effect", type=float, default=0.05,
                    help="决策阈值：|speedup-1| 必须超过实测空自测噪声地板（默认 0.05=5%%）")
    ap.add_argument("--out", default="bench/ab-result.json")
    a = ap.parse_args()
    env = {**os.environ, "GOMAXPROCS": "1"}
    fwd, rev, blocks = [], [], []
    bytes_ok = True; out_len = -1; out_sha = None
    for order, bucket in (("base-first", fwd), ("cand-first", rev)):
        for k in range(a.blocks_per_order):
            info = run_block(order, a, env)
            bucket.extend(info["ratios"])
            blocks.append({"order": order, "baseMed": info["baseMed"], "candMed": info["candMed"], "n": info["n"]})
            if not info["bytesEqual"] or info["outLen"] <= 0:
                bytes_ok = False
            out_len, out_sha = info["outLen"], info["outSha"]
            print(f"[{order} #{k}] baseMed={info['baseMed']} candMed={info['candMed']}", file=sys.stderr)

    s_f, s_r = median(fwd), median(rev)
    speedup = (s_f * s_r) ** 0.5
    lo, hi = boot_combined_ci(fwd, rev)
    ci_excludes_1 = (lo > 1 or hi < 1)
    effect_ok = abs(speedup - 1.0) >= a.min_effect
    verdict = ("BYTES_DIFFER" if not bytes_ok else
               "SIGNIFICANT_FASTER" if lo > 1 and effect_ok else
               "SIGNIFICANT_SLOWER" if hi < 1 and effect_ok else "NOT_SIGNIFICANT")
    rep = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "base": a.base, "cand": a.cand, "entry": a.entry,
        "blocks_per_order": a.blocks_per_order, "n_per_block": a.n, "warmup": a.warmup,
        "driver": a.driver,
        "samples_forward": len(fwd), "samples_reverse": len(rev),
        "forward_ratio_median": round(s_f, 4), "reverse_ratio_median": round(s_r, 4),
        "outBytes": out_len, "outSha": out_sha,
        "speedup_base_over_cand": round(speedup, 4),
        "ci95_speedup": [round(lo, 4), round(hi, 4)],
        "bytesEqual": bytes_ok, "verdict": verdict,
        "ciExcludes1": ci_excludes_1, "minEffect": a.min_effect,
        "effectExceedsFloor": effect_ok,
        "per_block": blocks,
        "note": "process-level crossover; speedup=sqrt(median(base-first)*median(cand-first)); bootstrap B=20000 re-samples each order group; >1=cand faster; CI含1不算赢",
    }
    (ROOT / a.out).write_text(json.dumps(rep, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(rep, ensure_ascii=False, indent=2))
    if not bytes_ok:
        sys.exit(3)


if __name__ == "__main__":
    main()
