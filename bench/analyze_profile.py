#!/usr/bin/env python3
"""
analyze_profile.py —— 阶段③ CPU profile 自时间聚合到函数级找热点（bench/README.md:5）。

V8 .cpuprofile 的 samples[i] 指向 nodes 中正在执行的节点 id，timeDeltas[i] 是该样本代表的
微秒数。按 node 聚合 timeDeltas = self-time（排除被调函数），再按 functionName + url 归组，
输出 top-N 热点到 bench/profile-report.json 与 stdout。

用法: python3 bench/analyze_profile.py <cpuprofile> [--top N] [--out FILE]
"""
import argparse, collections, json, pathlib


def frame_label(call_frame):
    fn = call_frame.get("functionName") or "(anonymous)"
    url = call_frame.get("url") or ""
    if url:
        # 仅保留文件名，避免绝对路径噪声
        url = url.rsplit("/", 1)[-1]
    line = call_frame.get("lineNumber", -1)
    return f"{fn} @ {url}:{line}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("profile")
    ap.add_argument("--top", type=int, default=20)
    ap.add_argument("--out", default="bench/profile-report.json")
    a = ap.parse_args()

    with open(a.profile) as f:
        prof = json.load(f)
    nodes = {n["id"]: n for n in prof["nodes"]}
    samples = prof["samples"]
    deltas = prof["timeDeltas"]

    self_us = collections.Counter()
    sample_count = collections.Counter()
    for nid, dt in zip(samples, deltas):
        self_us[nid] += dt
        sample_count[nid] += 1

    # 归组到函数（同 functionName+url 跨多个 node 合并）
    by_fn_us = collections.Counter()
    by_fn_samples = collections.Counter()
    for nid, us in self_us.items():
        label = frame_label(nodes[nid]["callFrame"])
        by_fn_us[label] += us
        by_fn_samples[label] += sample_count[nid]

    total_us = sum(self_us.values())
    rows = []
    for label, us in by_fn_us.most_common(a.top):
        rows.append({
            "function": label,
            "self_ms": round(us / 1000, 2),
            "self_pct": round(100.0 * us / total_us, 2) if total_us else 0,
            "samples": by_fn_samples[label],
        })

    report = {
        "profile": a.profile,
        "total_samples": len(samples),
        "total_self_ms": round(total_us / 1000, 2),
        "top": rows,
    }
    print(f"total self-time {report['total_self_ms']} ms over {len(samples)} samples")
    print(f"{'self_ms':>10} {'pct':>6} {'samples':>8}  function")
    for r in rows:
        print(f"{r['self_ms']:>10} {r['self_pct']:>6} {r['samples']:>8}  {r['function']}")
    with open(a.out, "w") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    print(f"wrote {a.out}")


if __name__ == "__main__":
    main()
