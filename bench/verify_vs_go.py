#!/usr/bin/env python3
"""审计：验证「基线 TS 产物」是否与 Go 0.28.2 逐字节一致（不只是基线 vs 候选自洽）。

对 50 条 wide 代表性子集 + three 四入口：
  - 基线 TS：用 /root/port-baseline 的驱动（bundle1/bundle_multi）产出字节；
  - Go：/tmp/esbuild-go --bundle --format=esm --platform=node --target=esnext --log-level=warning <entry>
  - 比较 returncode 与 sha256；记录不一致项（单独记账）。

用法: python3 bench/verify_vs_go.py --limit 50 --out bench/vs-go.json
"""
import argparse, hashlib, json, os, subprocess
from pathlib import Path

ROOT = Path("/root/port")
BASE_MOD = "/root/port-baseline/src"
WORKER = ROOT / "bench/align_worker.ts"
GO = "/tmp/esbuild-go"
FLAGS = ["--bundle", "--format=esm", "--platform=node", "--target=esnext", "--log-level=warning"]


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run_ts(case, out):
    driver = case["driver"]
    modfile = "bundle_multi.ts" if driver == "multi" else "bundle1.ts"
    cmd = ["node", "--experimental-strip-types", str(WORKER), "--mod", BASE_MOD + "/" + modfile,
           "--entry", str(ROOT / case["entry"]), "--driver", driver, "--out", out]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=case.get("timeout_s", 120),
                           cwd=str(ROOT), env={**os.environ, "GOMAXPROCS": "1"})
    except subprocess.TimeoutExpired:
        return {"status": "TIMEOUT"}
    try:
        info = json.loads(p.stdout.strip().splitlines()[-1])
    except Exception:
        return {"status": "WORKER_FAIL", "detail": (p.stdout + p.stderr)[-200:]}
    return {"status": "OK" if info.get("ok") else "ERROR", "sha": info.get("sha256"), "len": info.get("len")}


def run_go(case, out):
    cmd = [GO] + FLAGS + [str(ROOT / case["entry"])]
    try:
        p = subprocess.run(cmd, capture_output=True, timeout=case.get("timeout_s", 120),
                           cwd=str(ROOT), env={**os.environ, "GOMAXPROCS": "1"})
    except subprocess.TimeoutExpired:
        return {"status": "TIMEOUT"}
    if p.returncode != 0:
        return {"status": "ERROR", "detail": p.stderr.decode(errors="ignore")[-200:]}
    Path(out).write_bytes(p.stdout)
    return {"status": "OK", "sha": sha(out), "len": len(p.stdout)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=50)
    ap.add_argument("--out", default="bench/vs-go.json")
    a = ap.parse_args()
    manifest = json.loads((ROOT / "bench/align-corpus.json").read_text())
    wide = [c for c in manifest["cases"] if c["group"] == "wide"]
    stride = max(1, len(wide) // a.limit)
    subset = wide[::stride][:a.limit]
    three = [c for c in manifest["cases"] if c["group"] == "three-proxy"]
    cases = subset + three

    results, mismatch = [], []
    for c in cases:
        ts = run_ts(c, "/tmp/vg_ts.bin")
        go = run_go(c, "/tmp/vg_go.bin")
        same = (ts["status"] == go["status"] == "OK" and ts.get("sha") == go.get("sha") and ts.get("len") == go.get("len")) \
            or (ts["status"] == go["status"] == "ERROR")
        rec = {"id": c["id"], "driver": c["driver"], "ts": ts, "go": go, "equal": same}
        results.append(rec)
        if not same:
            mismatch.append(rec)
        print(f"{'OK ' if same else 'DIFF'} {c['id']} ts={ts.get('status')}/{ts.get('len')} go={go.get('status')}/{go.get('len')}")

    rep = {
        "note": "基线 TS 产物 vs Go 0.28.2 逐字节；ERROR==ERROR 视为等价失败；three tsl/webgpu 的已知未收敛会单列",
        "cases": len(results), "mismatches": len(mismatch),
        "mismatchIds": [m["id"] for m in mismatch], "results": results,
    }
    (ROOT / a.out).write_text(json.dumps(rep, ensure_ascii=False, indent=2) + "\n")
    print(f"\nmismatches {len(mismatch)}/{len(results)}; wrote {a.out}")


if __name__ == "__main__":
    main()
