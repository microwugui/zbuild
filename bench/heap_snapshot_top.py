#!/usr/bin/env python3
"""Stream-parse a V8 .heapsnapshot, aggregate live self_size by constructor name.

A .heapsnapshot is a large JSON (hundreds of MB) that json.load() OOMs on. This
uses mmap + a byte loop over just the nodes region (no full materialization):
node_fields = [type,name,id,self_size,edge_count,trace_node_id,detachedness] => 7 ints/node,
name is field[1] (index into the strings table), self_size is field[3].

Usage:
  node --expose-gc --experimental-strip-types driver.mjs   # app calls v8.writeHeapSnapshot(path)
  python3 bench/heap_snapshot_top.py /tmp/parse-heap.heapsnapshot 30
"""
import sys, mmap, json
from collections import Counter

path = sys.argv[1]
top_n = int(sys.argv[2]) if len(sys.argv) > 2 else 30
f = open(path, "rb")
mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)

nodes_key = b'"nodes":['
edges_key = b'"edges":['
strings_key = b'"strings":['
nstart = mm.find(nodes_key) + len(nodes_key)
eidx = mm.find(edges_key, nstart)
sidx = mm.find(strings_key, eidx) + len(strings_key) - 1  # keep the leading '['
# strings is a JSON array to end of file
strings, _ = json.JSONDecoder().raw_decode(mm[sidx:].decode("utf8", "replace").lstrip())

region = memoryview(mm)[nstart:eidx]
size, cnt = Counter(), Counter()
fields, num = [], bytearray()

def flush():
    if num:
        fields.append(int(num)); num.clear()
        if len(fields) == 7:
            size[fields[1]] += fields[3]; cnt[fields[1]] += 1
            fields.clear()

CH = 1 << 20
for p in range(0, len(region), CH):
    for c in region[p:p + CH]:
        if 48 <= c <= 57 or c == 45:
            num.append(c)
        else:
            flush()
flush()

total = sum(size.values())
print(f"total live self: {total / 1048576:.0f}MB, nodes: {sum(cnt.values())}")
for idx, sz in size.most_common(top_n):
    name = (strings[idx] if idx < len(strings) else f"?idx{idx}")[:60]
    print(f"  {sz / 1048576:8.2f}MB n={cnt[idx]:8d}  {name}")
