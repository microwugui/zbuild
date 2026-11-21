#!/usr/bin/env python3
"""生成「宽差异」产物对齐语料清单 bench/align-corpus.json（确定性，可重生成）。

与 three.js 代理性能指标分开：group=wide 是正确性对齐门（候选 vs 冻结基线逐字节），
group=three-proxy 只作大输入代理，默认不进对齐门。每条带 timeout_s 单例超时上限，
防止 553s 级病态输入拖死整轮。
"""
import json, re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path("/root/port")
cases = []


def add(cid, entry, driver, timeout, group="wide"):
    cases.append({
        "id": cid, "group": group, "driver": driver,
        "entry": str(entry.relative_to(ROOT)), "timeout_s": timeout,
    })


def needs_multi(path: Path) -> bool:
    try:
        txt = path.read_text(errors="ignore")
    except Exception:
        return False
    return bool(re.search(r"\bfrom\s*['\"]\.[^'\"]*['\"]", txt))


# 1) 单文件修 fixture（class / legal / multidecl 覆盖不同 lowering 与 legal 注释路径）
for p in sorted((ROOT / "testdata/b1fix").glob("*.js")):
    if p.name.endswith(".out.js"):
        continue
    add("b1fix/" + p.name, p, "single", 10)

# 2) 多文件 fixture（相对 import → bundle_multi 依赖图 + 链接 + tree-shaking）
for p in sorted((ROOT / "testdata/b1multi").glob("entry*.js")):
    add("b1multi/" + p.name, p, "multi", 15)

# 3) esbuild-cases 分层抽样（按文件名排序每隔 8 取 1 → ~436 条，覆盖 3488 个语法小样例）
esb = sorted((ROOT / "testdata/esbuild-cases").glob("*.js"))
for p in esb[::8]:
    add("esbuild/" + p.name, p, "single", 6)

# 4) enum-chain TS 样例（TS 语法入口）
for p in sorted((ROOT / "testdata/enum-chain-src").glob("*.ts")):
    add("enum/" + p.name, p, "single", 10)

# 5) three.js 代理组（大输入，单独 group，不与 wide 对齐门混算）
for name in ["three.core.js", "three.module.js", "three.tsl.js",
             "three.webgpu.js", "three.webgpu.nodes.js"]:
    p = ROOT / "testdata/three/package/build" / name
    if p.exists():
        add("three/" + name, p, "multi" if needs_multi(p) else "single", 120, "three-proxy")

manifest = {
    "generatedAt": datetime.now(timezone.utc).isoformat(),
    "note": "宽差异产物对齐语料；候选 vs 冻结基线逐字节；每条 timeout_s 上限；three-proxy 单独分组",
    "counts": {
        "wide": sum(1 for c in cases if c["group"] == "wide"),
        "three-proxy": sum(1 for c in cases if c["group"] == "three-proxy"),
    },
    "cases": cases,
}
out = ROOT / "bench/align-corpus.json"
out.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
print("wrote", out, manifest["counts"])
