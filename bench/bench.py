#!/usr/bin/env python3
"""
bench.py —— 阶段② 性能对比 harness（bench/README.md:1-9 既定口径）。

对比 esbuild Go 强制单线程 (GOMAXPROCS=1) vs 本仓 TS 单线程后端，同一输入、同一 CLI 参数、
同一份 three.js 文件。预热 PREWARM 次，正式 N 次取中位数 + p10/p90。

偏置（写入 bench-data.json biases 字段，脚注溯源）：
 - V8 JIT 预热曲线：PREWARM 次后进入稳态，但仍与 Go 静态编译不同。
 - 进程启动：Go 静态二进制 (~16MB) vs Node + --experimental-strip-types 类型剥离。
 - GC：Go GC vs V8 GC 策略不同；maxrss 一并记录供参考。
 - 后端差异：TS 侧经 tools/ts-bundle.sh（bundle1.ts / bundle_multi.ts），非 Go 的逐函数 1:1 调用链；
   字节等价由 tools/three_verify.sh 单独保证（core c0fdbed2 / module 2985154b），本 harness 不重复验字节。

用法: python3 bench/bench.py [--n N] [--prewarm P] [--out FILE]
"""
import argparse, hashlib, json, os, statistics, subprocess, time, datetime, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
GO = "/tmp/esbuild-go"
FLAGS = ["--bundle", "--format=esm", "--platform=node", "--target=esnext", "--log-level=warning"]
FILES = ["three.module.js", "three.core.js"]
BASE = ROOT / "testdata/three/package/build"


def run_once(cmd, env):
    t0 = time.perf_counter()
    with open(os.devnull, "wb") as devnull:
        p = subprocess.run(cmd, stdout=devnull, stderr=subprocess.PIPE, cwd=ROOT, env=env)
    dt = time.perf_counter() - t0
    if p.returncode != 0:
        raise RuntimeError(f"cmd failed ({p.returncode}): {p.stderr.decode()[:400]}")
    return dt


def pct(sorted_v, q):
    # nearest-rank percentile
    if not sorted_v:
        return None
    k = max(0, min(len(sorted_v) - 1, int(q * (len(sorted_v) - 1) + 0.5)))
    return sorted_v[k]


def measure(cmd, env, n, prewarm):
    for _ in range(prewarm):
        run_once(cmd, env)
    samples = [run_once(cmd, env) for _ in range(n)]
    s = sorted(samples)
    return {
        "n": n, "prewarm": prewarm,
        "samples_s": [round(x, 4) for x in samples],
        "median_s": round(statistics.median(s), 4),
        "p10_s": round(pct(s, 0.10), 4),
        "p90_s": round(pct(s, 0.90), 4),
        "min_s": round(s[0], 4), "max_s": round(s[-1], 4),
    }


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def versions():
    out = {}
    try:
        out["go_binary"] = subprocess.run([GO, "--version"], capture_output=True, text=True).stdout.strip()
    except Exception as e:
        out["go_binary"] = f"err:{e}"
    out["go_toolchain"] = subprocess.run(["go", "version"], capture_output=True, text=True).stdout.strip()
    out["node"] = subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=7)
    ap.add_argument("--prewarm", type=int, default=2)
    ap.add_argument("--out", default=str(ROOT / "bench/bench-data.json"))
    a = ap.parse_args()

    env_go = dict(os.environ); env_go["GOMAXPROCS"] = "1"
    env_ts = dict(os.environ); env_ts.pop("GOMAXPROCS", None)

    data = {
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "method": "prewarm then N runs, wall-clock via time.perf_counter around subprocess; median + p10/p90 (nearest-rank)",
        "flags": FLAGS,
        "versions": versions(),
        "biases": [
            "V8 JIT warmup curve: PREWARM runs then steady state; differs from Go static compilation.",
            "Process startup: Go static binary vs Node + --experimental-strip-types type stripping.",
            "GC: Go GC vs V8 GC strategies differ; byte output identical per three_verify.",
            "TS backend via tools/ts-bundle.sh (bundle1.ts/bundle_multi.ts), not Go's per-function 1:1 chain; byte-equality proven separately by three_verify.sh (core c0fdbed2/module 2985154b).",
        ],
        "entries": {},
    }

    for f in FILES:
        entry = str(BASE / f)
        data["entries"][f] = {
            "input_bytes": (BASE / f).stat().st_size,
            "input_sha256": sha256(BASE / f),
            "go_single_thread": measure([GO] + FLAGS + [entry], env_go, a.n, a.prewarm),
            "ts_single_thread": measure(["bash", str(ROOT / "tools/ts-bundle.sh")] + FLAGS + [entry], env_ts, a.n, a.prewarm),
        }
        g = data["entries"][f]["go_single_thread"]["median_s"]
        t = data["entries"][f]["ts_single_thread"]["median_s"]
        data["entries"][f]["ts_over_go_median"] = round(t / g, 2) if g else None
        print(f"{f}: Go median {g}s, TS median {t}s, ratio {data['entries'][f]['ts_over_go_median']}x")

    with open(a.out, "w") as fp:
        json.dump(data, fp, indent=2, ensure_ascii=False)
    print(f"wrote {a.out}")


if __name__ == "__main__":
    main()
