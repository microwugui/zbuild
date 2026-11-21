#!/usr/bin/env python3
"""阶段1 profile：node --cpu-prof + --trace-gc 重跑，按成本类别归账。

- CPU profile：函数级 self-time 归到成本类别（encode / print / parse / renamer / treeshake / GC / other）。
- GC trace：从 stderr 解析 GC 次数与各类型暂停总时长（Scavenge / Mark-sweep / Incremental）。

用法：
    python3 bench/profile_run.py --entry three.module.js --out bench/profile-stage1.json
"""
import argparse, collections, json, re, subprocess, time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path("/root/port")
PROF_DIR = ROOT / "bench/profiles"


def categorize(label: str) -> str:
    l = label.lower()
    if "garbage collector" in l or "(program)" in l:
        return "runtime-gc"
    if "encode" in l or "textencoder" in l or "encoding.ts" in l:
        return "utf8-encode"
    if "js_printer" in l or "print" in l:
        return "printing"
    if "js_lexer" in l or "js_parser" in l or "lexer" in l or "parse" in l:
        return "parsing-lexing"
    if "renamer" in l or "followsymbols" in l or "assignnames" in l:
        return "renamer"
    if "bundle_multi" in l or "bundler" in l or "collectrefs" in l or "treeshak" in l:
        return "treeshake-link"
    return "other"


def analyze_cpu(prof_path: Path, top: int = 40):
    prof = json.loads(prof_path.read_text())
    nodes = {n["id"]: n for n in prof["nodes"]}
    self_us = collections.Counter()
    for nid, dt in zip(prof["samples"], prof["timeDeltas"]):
        self_us[nid] += dt
    by_fn = collections.Counter()
    for nid, us in self_us.items():
        cf = nodes[nid]["callFrame"]
        fn = cf.get("functionName") or "(anonymous)"
        url = (cf.get("url") or "").rsplit("/", 1)[-1]
        by_fn[f"{fn} @ {url}:{cf.get('lineNumber', -1)}"] += us
    cat_us = collections.Counter()
    for label, us in by_fn.items():
        cat_us[categorize(label)] += us
    total = sum(self_us.values())
    return {
        "total_self_ms": round(total / 1000, 2),
        "samples": len(prof["samples"]),
        "by_category": [
            {"category": c, "self_ms": round(us / 1000, 2), "pct": round(100 * us / total, 2)}
            for c, us in cat_us.most_common()
        ],
        "top_functions": [
            {"function": fn, "category": categorize(fn), "self_ms": round(us / 1000, 2),
             "pct": round(100 * us / total, 2)}
            for fn, us in by_fn.most_common(top)
        ],
    }


def analyze_gc(text: str):
    # Node 22 本进程里 --trace-gc 打到 stdout（与产物二进制交错），格式如:
    #   [pid:0x..]  215 ms: Scavenge 8.1 (8.8) -> 7.6 (9.8) MB, pooled: 0 MB, 1.32 / 0.00 ms  (average mu=...) allocation failure;
    # 暂停时长取 "X / Y ms" 的 X。
    types = collections.Counter()
    pauses = []
    for line in text.splitlines():
        kind = next((t for t in ("Scavenge", "Mark-sweep", "Mark-compact",
                                 "Incremental Marking", "WeakCallback") if t in line), None)
        if not kind:
            continue
        m = re.search(r"([\d.]+)\s*/\s*[\d.]+\s*ms", line)
        if m:
            types[kind] += 1
            pauses.append(float(m.group(1)))
    return {
        "gc_events": len(pauses),
        "total_gc_pause_ms": round(sum(pauses), 2),
        "by_type_events": dict(types),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--entry", default="testdata/three/package/build/three.module.js")
    ap.add_argument("--out", default="bench/profile-stage1.json")
    a = ap.parse_args()
    entry_rel = a.entry
    if not (ROOT / entry_rel).exists():
        alt = Path("testdata/three/package/build") / entry_rel
        if (ROOT / alt).exists():
            entry_rel = str(alt)
    entry = ROOT / entry_rel
    PROF_DIR.mkdir(parents=True, exist_ok=True)
    name = "stage1-" + entry.stem + ".cpuprofile"
    prof_path = PROF_DIR / name
    if prof_path.exists():
        prof_path.unlink()
    cmd = ["node", "--experimental-strip-types", "--cpu-prof",
           f"--cpu-prof-dir={PROF_DIR}", f"--cpu-prof-name={name}",
           "--trace-gc", "src/bundle_multi.ts", entry_rel]
    t0 = time.perf_counter()
    p = subprocess.run(cmd, capture_output=True, cwd=str(ROOT))
    wall = time.perf_counter() - t0
    if p.returncode != 0 or not prof_path.exists():
        raise SystemExit(f"profile run failed rc={p.returncode}: {p.stderr.decode(errors='ignore')[:400]}")
    cpu = analyze_cpu(prof_path)
    gc = analyze_gc(p.stdout.decode(errors="ignore") + "\n" + p.stderr.decode(errors="ignore"))
    rep = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "entry": entry_rel, "profile": str(prof_path.relative_to(ROOT)),
        "wall_s": round(wall, 2), "cpu": cpu, "gc": gc,
    }
    (ROOT / a.out).write_text(json.dumps(rep, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"entry": entry_rel, "wall_s": rep["wall_s"],
                      "by_category": cpu["by_category"], "gc": gc}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
