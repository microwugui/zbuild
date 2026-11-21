#!/usr/bin/env python3
"""按 inclusive（含被调子树）时间聚合 CPU profile —— 找顶层算法级热点。

self-time 只回答「哪个函数自己最耗时」，会漏掉「顶层算法把大量工作摊到子调用」的情况。
本脚本沿采样点的祖先链累加 timeDelta：某函数 inclusive = 所有经过它的采样时间之和，
从而暴露「优化一个顶层入口就能带动一大片」的位置（如 Parse/Print/bundle 主链）。

用法:
    python3 bench/analyze_inclusive.py bench/profiles/stage1-three.module.cpuprofile \
        --top 25 --out bench/profile-inclusive.json
"""
import argparse, collections, json


def label(cf):
    fn = cf.get("functionName") or "(anonymous)"
    url = (cf.get("url") or "").rsplit("/", 1)[-1]
    return f"{fn} @ {url}:{cf.get('lineNumber', -1)}"


def categorize(lbl):
    l = lbl.lower()
    if "garbage collector" in l or "(program)" in l: return "runtime-gc"
    if "encode" in l or "textencoder" in l or "encoding" in l: return "utf8-encode"
    if "js_printer" in l or "print" in l: return "printing"
    if "js_lexer" in l or "js_parser" in l or "lexer" in l or "parse" in l: return "parsing-lexing"
    if "renamer" in l or "followsymbols" in l or "assignnames" in l: return "renamer"
    if "bundle" in l or "collectrefs" in l or "treeshak" in l or "link" in l: return "treeshake-link"
    return "other"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("profile")
    ap.add_argument("--top", type=int, default=25)
    ap.add_argument("--out", default="bench/profile-inclusive.json")
    a = ap.parse_args()
    prof = json.load(open(a.profile))
    nodes = {n["id"]: n for n in prof["nodes"]}
    parent = {}
    for n in prof["nodes"]:
        for c in n.get("children", []):
            parent[c] = n["id"]
    # 防御：可能存在多根；缺失父节点的视为根
    incl_us = collections.Counter()
    self_us = collections.Counter()
    cat_incl = collections.Counter()
    total = 0
    for nid, dt in zip(prof["samples"], prof["timeDeltas"]):
        total += dt
        cur = nid
        seen_nodes = set()
        seen_labels = set()  # 同一函数在同一栈只计一次，避免递归把 inclusive 放大到 >100%
        seen_cats = set()    # 同一成本类别在同一栈只计一次，避免同类嵌套函数重复累加
        while cur is not None and cur in nodes and cur not in seen_nodes:
            seen_nodes.add(cur)
            lab = label(nodes[cur]["callFrame"])
            if lab not in seen_labels:
                incl_us[lab] += dt
                seen_labels.add(lab)
            cat = categorize(lab)
            if cat not in seen_cats:
                cat_incl[cat] += dt
                seen_cats.add(cat)
            if cur == nid:
                self_us[lab] += dt
            cur = parent.get(cur)
    rows = []
    for lab, us in incl_us.most_common(a.top):
        rows.append({"function": lab, "category": categorize(lab),
                     "inclusive_ms": round(us / 1000, 2),
                     "inclusive_pct": round(100 * us / total, 2),
                     "self_ms": round(self_us.get(lab, 0) / 1000, 2)})
    rep = {
        "profile": a.profile,
        "total_self_ms": round(total / 1000, 2),
        "samples": len(prof["samples"]),
        "note": "inclusive=沿调用栈含被调子树；同一函数每栈只计一次；分类 rollup 因容器函数会污染子树，不提供，改用 profile-stage1.json 的 self-time 分类",
        "top_inclusive_functions": rows,
    }
    json.dump(rep, open(a.out, "w"), indent=2, ensure_ascii=False)
    print(f"total {rep['total_self_ms']} ms / {rep['samples']} samples")
    print(f"{'incl_ms':>10} {'pct':>6} {'self_ms':>9}  function")
    for r in rows:
        print(f"{r['inclusive_ms']:>10} {r['inclusive_pct']:>6} {r['self_ms']:>9}  {r['function']}")
    print("wrote", a.out)


if __name__ == "__main__":
    main()
