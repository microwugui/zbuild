#!/usr/bin/env python3
"""Large-build paired A/B: warm fully, release caches (global.gc), then time one
measured cold-latency run per process (user direction: exclude startup tax on a
large build where Go itself takes seconds).

Compares two worktrees' bundle1.ts via an identical worker. Each worker process:
  import driver -> N warm runs -> global.gc() -> 1 measured run (wall ms) -> print.
We run K processes per tree, alternating order, and report median(base)/median(cand).
"""
import argparse, json, statistics, subprocess, sys
from pathlib import Path

WORKER = Path("/root/port/bench/warm_time_worker.mjs")


def one_run(tree, inp, warm):
    cmd = ["node", "--expose-gc", "--max-old-space-size=768", "--experimental-strip-types",
           str(WORKER), "--driver", str(Path(tree) / "src/bundle1.ts"),
           "--input", inp, "--warm", str(warm)]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    if p.returncode != 0:
        raise SystemExit(f"worker failed rc={p.returncode}: {p.stderr[-600:]}")
    return json.loads(p.stdout.strip().splitlines()[-1])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--base", default="/root/port-r1")
    ap.add_argument("--cand", default="/root/port-c6")
    ap.add_argument("--warm", type=int, default=2)
    ap.add_argument("--n", type=int, default=6)
    ap.add_argument("--out", default="bench/wall-big-r6.json")
    a = ap.parse_args()
    base_ms, cand_ms, ratios = [], [], []
    for i in range(a.n):
        if i % 2 == 0:
            b, c = one_run(a.base, a.input, a.warm), one_run(a.cand, a.input, a.warm)
        else:
            c, b = one_run(a.cand, a.input, a.warm), one_run(a.base, a.input, a.warm)
        if not b["ok"] or not c["ok"] or b["sha"] != c["sha"]:
            raise SystemExit(f"byte mismatch / error: base={b} cand={c}")
        base_ms.append(b["ms"]); cand_ms.append(c["ms"])
        ratios.append(b["ms"] / c["ms"])
        print(f"  pair {i}: base={b['ms']}ms cand={c['ms']}ms ratio={ratios[-1]:.3f}", flush=True)
    mb, mc = statistics.median(base_ms), statistics.median(cand_ms)
    rep = {"input": a.input, "warm": a.warm, "n": a.n,
           "base_ms_median": mb, "cand_ms_median": mc,
           "speedup_base_over_cand": round(mb / mc, 4),
           "ratios": [round(x, 4) for x in ratios],
           "base_ms": base_ms, "cand_ms": cand_ms,
           "bytes_equal": True}
    Path(a.out).write_text(json.dumps(rep, indent=2) + "\n")
    print(json.dumps(rep, indent=2))


if __name__ == "__main__":
    main()
