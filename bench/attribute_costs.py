#!/usr/bin/env python3
"""把每个采样点的 self-time 按「最近阶段祖先」归属，回答 encode/GC 记在解析侧还是打印侧。

方法：cpuprofile 的 nodes 构成调用树。对每个采样点（叶子），
  1) 叶子自身的成本类别 = self_category(leaf)（encode / gc / other）；
  2) 沿父链向上找最近的「阶段祖先」（parse/lex、print、treeshake、renamer）；
  3) 把 dt 累加到 matrix[self_category][phase]。
这样 encode 的 14.5% 会被拆成「打印表达式时的 encode」vs「解析时的 encode」，而不是按类别猜。

用法: python3 bench/attribute_costs.py bench/profiles/stage1-three.module.cpuprofile \
          --out bench/cost-attribution.json
"""
import argparse, collections, json, re

PHASES = [
    ("renamer", re.compile(r"renamer|followsymbols|assignnames", re.I)),
    ("parse-lex", re.compile(r"js_parser|js_lexer|\bparse|visit|\blex\b|lexer", re.I)),
    ("print", re.compile(r"js_printer|\bprint", re.I)),
    ("treeshake-link", re.compile(r"collectRefs|topStmts|bundle_|treeshak|helper", re.I)),
]


def label(cf):
    fn = cf.get("functionName") or "(anonymous)"
    url = (cf.get("url") or "").rsplit("/", 1)[-1]
    return f"{fn} @ {url}:{cf.get('lineNumber', -1)}"


def self_cat(lbl):
    l = lbl.lower()
    if "garbage collector" in l or "(program)" in l: return "GC"
    if "encode" in l or "textencoder" in l or "encoding" in l: return "encode"
    if "decode" in l or "textdecoder" in l: return "decode"
    return "JIT-other"


def phase_of(lbl):
    for name, rx in PHASES:
        if rx.search(lbl):
            return name
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("profile")
    ap.add_argument("--out", default="bench/cost-attribution.json")
    a = ap.parse_args()
    prof = json.load(open(a.profile))
    nodes = {n["id"]: n for n in prof["nodes"]}
    parent = {}
    for n in prof["nodes"]:
        for c in n.get("children", []):
            parent[c] = n["id"]

    matrix = collections.Counter()  # (self_cat, phase) -> us
    phase_total = collections.Counter()
    total = 0
    for nid, dt in zip(prof["samples"], prof["timeDeltas"]):
        total += dt
        leaf = label(nodes[nid]["callFrame"])
        sc = self_cat(leaf)
        # 找最近阶段祖先（含自身）
        cur, ph = nid, "root/unattributed"
        seen = set()
        while cur is not None and cur in nodes and cur not in seen:
            seen.add(cur)
            p = phase_of(label(nodes[cur]["callFrame"]))
            if p:
                ph = p
                break
            cur = parent.get(cur)
        matrix[(sc, ph)] += dt
        phase_total[ph] += dt

    self_cats = ["GC", "encode", "decode", "JIT-other"]
    phases = ["parse-lex", "print", "treeshake-link", "renamer", "root/unattributed"]
    rep = {
        "profile": a.profile, "total_ms": round(total / 1000, 2),
        "matrix_ms": {sc: {ph: round(matrix[(sc, ph)] / 1000, 2) for ph in phases} for sc in self_cats},
        "matrix_pct_of_total": {sc: {ph: round(100 * matrix[(sc, ph)] / total, 2) for ph in phases} for sc in self_cats},
        "phase_total_pct": {ph: round(100 * phase_total[ph] / total, 2) for ph in phases},
    }
    json.dump(rep, open(a.out, "w"), indent=2, ensure_ascii=False)
    print(f"total {rep['total_ms']} ms")
    hdr = "self\\phase".ljust(12) + "".join(p.rjust(14) for p in phases)
    print(hdr)
    for sc in self_cats:
        row = sc.ljust(12) + "".join(f"{rep['matrix_pct_of_total'][sc][p]:>13.2f}%" for p in phases)
        print(row)
    print()
    print("phase totals:", {k: f"{v}%" for k, v in rep["phase_total_pct"].items()})
    print("wrote", a.out)


if __name__ == "__main__":
    main()
