#!/usr/bin/env python3
"""宽差异产物对齐：候选 vs 冻结基线，逐字节比较，每条单例超时上限。

用法：
    python3 bench/gen_align_corpus.py          # 生成清单（确定性）
    python3 bench/align.py                     # 跑 wide 组（默认），结果 bench/align-result.json
    python3 bench/align.py three-proxy         # 只跑 three 代理组，结果 bench/align-result-three-proxy.json

子进程隔离 + timeout：病态输入超时记 TIMEOUT 并单独计数，不拖死整轮，也不当作 PASS。
退出码：0=无 BYTES_DIFFER/STATUS_DIFFER；2=存在产物不一致；3=清单缺失。
"""
import json, os, subprocess, sys, time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path("/root/port")
WORKER = ROOT / "bench/align_worker.ts"
BASE_MOD = "/root/port-baseline/src"
CAND_MOD = "/root/port/src"
CORPUS = ROOT / "bench/align-corpus.json"

group = sys.argv[1] if len(sys.argv) > 1 else "wide"
if not CORPUS.exists():
    print("corpus missing; run gen_align_corpus.py first", file=sys.stderr)
    sys.exit(3)
manifest = json.loads(CORPUS.read_text())
cases = [c for c in manifest["cases"] if c["group"] == group]


def run_one(mod_dir: str, case: dict) -> dict:
    driver = case["driver"]
    modfile = "bundle_multi.ts" if driver == "multi" else "bundle1.ts"
    tag = "base" if mod_dir == BASE_MOD else "cand"
    out = f"/tmp/align_{tag}_{os.getpid()}.bin"
    cmd = ["node", "--experimental-strip-types", str(WORKER),
           "--mod", mod_dir + "/" + modfile,
           "--entry", str(ROOT / case["entry"]),
           "--driver", driver, "--out", out]
    env = {**os.environ, "GOMAXPROCS": "1"}
    t0 = time.perf_counter()
    try:
        p = subprocess.run(cmd, capture_output=True, text=True,
                           timeout=case["timeout_s"], cwd=str(ROOT), env=env)
    except subprocess.TimeoutExpired:
        return {"status": "TIMEOUT", "wall_ms": round((time.perf_counter() - t0) * 1000, 1)}
    wall = round((time.perf_counter() - t0) * 1000, 1)
    detail = (p.stdout or p.stderr or "").strip().splitlines()
    try:
        info = json.loads(detail[-1]) if detail else {}
    except Exception:
        info = {}   # worker 崩溃/输出不可解析 → 无 ok 键，标 WORKER_FAIL（硬失败，绝不吞成绿）
    if "ok" not in info:
        info["status"] = "WORKER_FAIL"
    else:
        info["status"] = "OK" if info["ok"] else "ERROR"
    info["wall_ms"] = wall
    return info


results = []
t_start = time.perf_counter()
for c in cases:
    b = run_one(BASE_MOD, c)
    d = run_one(CAND_MOD, c)
    if b["status"] == "OK" and d["status"] == "OK":
        if b.get("len", 0) == 0 or d.get("len", 0) == 0:
            status = "EMPTY_OUTPUT"   # 0 字节产物绝不记 PASS（曾掩盖 bundle1 守卫回归）
        else:
            status = "PASS" if (b.get("sha256") == d.get("sha256") and b.get("len") == d.get("len")) else "BYTES_DIFFER"
    elif b["status"] == "WORKER_FAIL" or d["status"] == "WORKER_FAIL":
        status = "WORKER_FAIL"       # harness 自身失败，硬失败
    elif b["status"] == d["status"] == "ERROR":
        status = "PASS_BOTH_ERROR"   # 两侧同样失败（真 error 字段），视为等价
    elif b["status"] == "TIMEOUT" or d["status"] == "TIMEOUT":
        status = "TIMEOUT"
    else:
        status = "STATUS_DIFFER"
    results.append({"id": c["id"], "group": c["group"], "driver": c["driver"],
                    "status": status, "base": b, "cand": d})

counts = {}
for r in results:
    counts[r["status"]] = counts.get(r["status"], 0) + 1
report = {
    "generatedAt": datetime.now(timezone.utc).isoformat(),
    "group": group,
    "corpus": str(CORPUS),
    "corpusCases": len(cases),
    "totalWallS": round(time.perf_counter() - t_start, 2),
    "counts": counts,
    "results": results,
}
suffix = "" if group == "wide" else "-" + group.replace("/", "_")
out = ROOT / f"bench/align-result{suffix}.json"
out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"group": group, "cases": len(cases), "counts": counts,
                  "totalWallS": report["totalWallS"], "out": str(out)}, ensure_ascii=False))
bad = (counts.get("BYTES_DIFFER", 0) + counts.get("STATUS_DIFFER", 0)
       + counts.get("WORKER_FAIL", 0) + counts.get("EMPTY_OUTPUT", 0))
# 健全性护栏：若没有任何一条真正产出字节并 PASS（worker 全崩/全错），绝不当绿。
if not any(r["status"] == "PASS" for r in results):
    print("SANITY FAIL: no PASS with real bytes across corpus; harness likely broken",
          file=sys.stderr)
    bad += 1
sys.exit(2 if bad else 0)
