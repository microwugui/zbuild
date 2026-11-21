#!/usr/bin/env python3
"""按 V8 heap profile（node --heap-prof）的分配采样树，把分配字节数归到函数。

回答「GC 10.55% 到底由哪些分配点造成」：heap profile 的树节点 selfSize = 该调用帧直接分配
并存活到采样点的字节数。按函数汇总 selfSize，得到分配侧热点（不是时间侧）。

用法:
    node --heap-prof --heap-prof-dir=bench/profiles --heap-prof-name=after-r1.heapprofile \
         src/bundle_multi.ts testdata/three/package/build/three.module.js
    python3 bench/analyze_heap.py bench/profiles/after-r1.heapprofile --top 25 --out bench/heap-attribution.json
"""
import argparse, collections, json


def label(cf):
    fn = cf.get("functionName") or "(anonymous)"
    url = (cf.get("url") or "").rsplit("/", 1)[-1]
    return f"{fn} @ {url}:{cf.get('lineNumber', -1)}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("profile")
    ap.add_argument("--top", type=int, default=25)
    ap.add_argument("--out", default="bench/heap-attribution.json")
    a = ap.parse_args()
    prof = json.load(open(a.profile))
    by_fn = collections.Counter()
    total = 0

    def walk(node):
        nonlocal total
        size = node.get("selfSize", 0) or 0
        if size:
            by_fn[label(node.get("callFrame", {}))] += size
            total += size
        for ch in node.get("children", []) or []:
            walk(ch)

    walk(prof["head"])
    rows = [{"function": fn, "self_mb": round(sz / 1048576, 3),
             "pct": round(100 * sz / total, 2) if total else 0}
            for fn, sz in by_fn.most_common(a.top)]
    rep = {"profile": a.profile, "total_sampled_mb": round(total / 1048576, 3),
           "top_alloc_sites": rows}
    json.dump(rep, open(a.out, "w"), indent=2, ensure_ascii=False)
    print(f"total sampled {rep['total_sampled_mb']} MB")
    print(f"{'self_MB':>9} {'pct':>6}  function")
    for r in rows:
        print(f"{r['self_mb']:>9} {r['pct']:>6}  {r['function']}")
    print("wrote", a.out)


if __name__ == "__main__":
    main()
