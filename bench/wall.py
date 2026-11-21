#!/usr/bin/env python3
"""阶段0 辅指标：end-to-end wall time，配对子进程 A/B（基线树 vs 候选树走真实 CLI 路径）。

与主指标 bench/ab.ts 的区别：这里计入进程启动 + 类型剥离 + CLI 分发，是「用户感知」口径；
主指标只测进程内 bundle 函数。两者都固定输入字节、GOMAXPROCS=1、预热、交替采样。

用法：
    python3 bench/wall.py --entry three.module.js --n 20 --warmup 3 \
        --out bench/wall-result.json

判定：speedup=median(base)/median(cand)，>1=候选更快；配对 bootstrap CI 含 1 不算赢。
两侧 CLI stdout 必须逐字节一致，否则 BYTES_DIFFER（硬门）。
"""
import argparse, hashlib, json, os, re, subprocess, time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path("/root/port")
BASE = Path("/root/port-baseline")
CAND = Path("/root/port")


def median(xs):
    v = sorted(xs); m = len(v) // 2
    return v[m] if len(v) % 2 else (v[m - 1] + v[m]) / 2


def needs_multi(entry: Path) -> bool:
    return bool(re.search(r"\bfrom\s*['\"]\.[^'\"]*['\"]", entry.read_text(errors="ignore")))


def run(tree: Path, entry_rel: str, driver: str) -> tuple:
    cmd = ["node", "--experimental-strip-types",
           str(tree / "src" / f"bundle_{driver}.ts"), entry_rel]
    env = {**os.environ, "GOMAXPROCS": "1"}
    t0 = time.perf_counter()
    p = subprocess.run(cmd, capture_output=True, cwd=str(tree), env=env)
    dt = time.perf_counter() - t0
    if p.returncode != 0:
        raise RuntimeError(f"CLI failed rc={p.returncode}: {p.stderr.decode(errors='ignore')[:200]}")
    return dt, hashlib.sha256(p.stdout).hexdigest(), len(p.stdout)


def paired_ci(ratios, B=20000, seed=0x2f6e2b1):
    n = len(ratios); meds = []
    state = [seed]
    def rnd():
        state[0] = (state[0] * 1103515245 + 12345) & 0x7fffffff
        return state[0] / 0x7fffffff
    for _ in range(B):
        s = [ratios[int(rnd() * n)] for _ in range(n)]
        meds.append(median(s))
    meds.sort()
    return meds[int(0.025 * B)], meds[int(0.975 * B)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--entry", default="testdata/three/package/build/three.module.js")
    ap.add_argument("--n", type=int, default=20)
    ap.add_argument("--warmup", type=int, default=3)
    ap.add_argument("--out", default="bench/wall-result.json")
    a = ap.parse_args()
    entry_rel = a.entry
    entry = ROOT / entry_rel
    if not entry.exists():
        alt = Path("testdata/three/package/build") / entry_rel
        if (ROOT / alt).exists():
            entry_rel = str(alt); entry = ROOT / entry_rel
    driver = "multi" if needs_multi(entry) else "single"

    for _ in range(a.warmup):
        run(BASE, entry_rel, driver); run(CAND, entry_rel, driver)

    base_ms, cand_ms, ratios = [], [], []
    for i in range(a.n):
        if i % 2 == 0:
            tb, hb, lb = run(BASE, entry_rel, driver)
            tc, hc, lc = run(CAND, entry_rel, driver)
        else:
            tc, hc, lc = run(CAND, entry_rel, driver)
            tb, hb, lb = run(BASE, entry_rel, driver)
        base_ms.append(tb * 1000); cand_ms.append(tc * 1000)
        ratios.append(tb / tc)
    bytes_equal = hb == hc and lb == lc
    # 0 字节产物绝不记绿：曾掩盖 bundle1 守卫回归（CLI 不跑→空输出→两侧都空→伪等价）。
    if lb == 0 or lc == 0:
        raise SystemExit(f"EMPTY_OUTPUT: one side produced 0 bytes (base={lb}, cand={lc}); harness regression")
    speedup = median(ratios)
    lo, hi = paired_ci(ratios)
    verdict = ("BYTES_DIFFER" if not bytes_equal else
               "SIGNIFICANT_FASTER" if lo > 1 else
               "SIGNIFICANT_SLOWER" if hi < 1 else "NOT_SIGNIFICANT")
    rep = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "entry": entry_rel, "driver": driver, "n": a.n, "warmup": a.warmup,
        "input_bytes": entry.stat().st_size,
        "base_ms_median": round(median(base_ms), 3),
        "cand_ms_median": round(median(cand_ms), 3),
        "speedup_base_over_cand": round(speedup, 4),
        "ci95_speedup": [round(lo, 4), round(hi, 4)],
        "bytes_equal": bytes_equal, "out_bytes": lb, "out_sha256": hb,
        "verdict": verdict,
        "note": "end-to-end CLI subprocess wall time; paired bootstrap B=20000; >1=cand faster; CI含1不算赢",
    }
    out = ROOT / a.out
    out.write_text(json.dumps(rep, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(rep, ensure_ascii=False, indent=2))
    if not bytes_equal:
        raise SystemExit(3)


if __name__ == "__main__":
    main()
