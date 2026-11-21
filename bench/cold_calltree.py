#!/usr/bin/env python3
"""Cold first-pass CPU profile -> root-path inclusive call tree.

Unlike a flat inclusive ranking, this walks parent->child so the top-level
call ROOTS that actually consume work are visible (the 'one top-level fix
moves a whole region' target).  Uses an existing --cpu-prof capture from a
single cold bundle invocation.
"""
import argparse, collections, json


def label(nodes, nid):
    cf = nodes[nid]["callFrame"]
    fn = cf.get("functionName") or "(anonymous)"
    url = (cf.get("url") or "").rsplit("/", 1)[-1]
    return f"{fn} @ {url}:{cf.get('lineNumber', -1)}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("profile")
    ap.add_argument("--root", default="bundleWithImports")
    ap.add_argument("--depth", type=int, default=3)
    a = ap.parse_args()
    prof = json.load(open(a.profile))
    nodes = {n["id"]: n for n in prof["nodes"]}
    parent = {}
    for n in prof["nodes"]:
        for c in n.get("children", []):
            parent[c] = n["id"]
    # inclusive self-attributed time per node (one count per sample node, not ancestors)
    self_us = collections.Counter()
    for nid, dt in zip(prof["samples"], prof["timeDeltas"]):
        self_us[nid] += dt
    # inclusive = sum over the subtree of a node
    incl = collections.Counter()
    for nid, us in self_us.items():
        cur = nid
        while cur is not None and cur in nodes:
            incl[cur] += us
            cur = parent.get(cur)
    total = sum(self_us.values())
    # find root node matching
    roots = [nid for nid in nodes if a.root in label(nodes, nid)]
    if not roots:
        raise SystemExit(f"root {a.root!r} not found")
    root = max(roots, key=lambda n: incl[n])
    print(f"cold profile: total_self_ms={total/1000:.1f}  root={label(nodes,root)} incl={100*incl[root]/total:.2f}%")

    def show(nid, depth, prefix):
        lbl = label(nodes, nid)
        self_ms = self_us.get(nid, 0) / 1000
        print(f"{prefix}{100*incl[nid]/total:6.2f}%incl {self_ms:8.1f}ms self  {lbl}")
        if depth >= a.depth:
            return
        kids = sorted(nodes[nid].get("children", []), key=lambda c: -incl.get(c, 0))
        # merge children with the same label
        merged = collections.Counter()
        mself = collections.Counter()
        for c in kids:
            merged[label(nodes, c)] += incl.get(c, 0)
            mself[label(nodes, c)] += self_us.get(c, 0) / 1000
        for lbl, us in merged.most_common(12):
            print(f"{prefix}  └ {100*us/total:6.2f}%incl {mself[lbl]:8.1f}ms self  {lbl}")
            if depth + 1 < a.depth:
                # descend into the single biggest child node for that label
                best = max((c for c in kids if label(nodes, c) == lbl), key=lambda c: incl.get(c, 0), default=None)
                if best is not None:
                    show(best, depth + 2, prefix + "    ")

    show(root, 0, "")


if __name__ == "__main__":
    main()
