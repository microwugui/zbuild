#!/usr/bin/env python3
"""Profile a WARM large build (post-startup) with V8 CPU profiler via inspector.

User direction: exclude the irreducible ~5s V8 startup/tier-up tax; measure the
real build work on a large input where Go takes seconds, so the optimization
target is the top-level algorithm, not cold-start.
"""
import argparse, json, subprocess, sys
from pathlib import Path

ROOT = Path("/root/port")
WORKER = Path("/root/port-ev/bench/warm_profile_worker.mjs")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--warm", type=int, default=2)
    ap.add_argument("--out", default="bench/profile-warm-big.json")
    a = ap.parse_args()
    PROFILE = Path("/tmp/warm-big.cpuprofile")
    if PROFILE.exists():
        PROFILE.unlink()
    cmd = ["node", "--expose-gc", "--max-old-space-size=768", "--experimental-strip-types",
           str(WORKER), "--input", a.input, "--warm", str(a.warm), "--profile", str(PROFILE)]
    p = subprocess.run(cmd, capture_output=True, text=True, cwd=str(ROOT), timeout=1200)
    sys.stdout.write(p.stdout[-2000:])
    if p.returncode != 0:
        sys.stderr.write(p.stderr[-3000:])
        raise SystemExit(f"worker rc={p.returncode}")
    # aggregate
    prof = json.loads(PROFILE.read_text())
    import collections
    nodes = {n["id"]: n for n in prof["nodes"]}
    parent = {}
    for n in prof["nodes"]:
        for c in n.get("children", []):
            parent[c] = n["id"]
    self_us = collections.Counter()
    for nid, dt in zip(prof["samples"], prof["timeDeltas"]):
        self_us[nid] += dt
    incl = collections.Counter()
    for nid, us in self_us.items():
        cur = nid
        while cur is not None and cur in nodes:
            incl[cur] += us
            cur = parent.get(cur)
    total = sum(self_us.values())
    byfn = collections.Counter()
    ifn = collections.Counter()
    for nid, us in self_us.items():
        cf = nodes[nid]["callFrame"]
        name = cf.get("functionName") or "(anon)"
        url = (cf.get("url") or "").rsplit("/", 1)[-1]
        byfn[f"{name}@{url}:{cf.get('lineNumber',-1)}"] += us
    for nid, us in incl.items():
        cf = nodes[nid]["callFrame"]
        name = cf.get("functionName") or "(anon)"
        url = (cf.get("url") or "").rsplit("/", 1)[-1]
        ifn[f"{name}@{url}:{cf.get('lineNumber',-1)}"] += us
    rep = {
        "input": a.input, "warm": a.warm,
        "total_self_ms": round(total/1000, 1), "samples": len(prof["samples"]),
        "top_self": [{"fn": k, "self_ms": round(v/1000,1), "pct": round(100*v/total,2)} for k,v in byfn.most_common(30)],
        "top_inclusive": [{"fn": k, "incl_ms": round(v/1000,1), "pct": round(100*v/total,2)} for k,v in ifn.most_common(30)],
    }
    (ROOT / a.out).write_text(json.dumps(rep, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({"total_self_ms": rep["total_self_ms"], "top_inclusive": rep["top_inclusive"][:12],
                      "top_self": rep["top_self"][:12]}, indent=2))


if __name__ == "__main__":
    main()
