#!/usr/bin/env python3
"""R1 覆盖缺口夹具：ASCIIOnly / MinifyWhitespace / LegalComments / AddSourceMappings /
非 ASCII+非 BMP 标识符 / 孤立代理项 / CRLF，逐字节比较「基线树 vs 候选树」。

这些正是 print/printBytes/printIdentifierUTF16/lineLength 的行为分叉点，wide 语料默认选项未覆盖。
用法: python3 bench/printer_fixtures.py --out bench/printer-fixtures-result.json
"""
import argparse, json, os, subprocess, sys
from pathlib import Path

ROOT = Path("/root/port")
HARNESS = ROOT / "bench/printer_opt_diff.mjs"
FIX = Path("/tmp/printer-fixtures")
BASE = "/root/port-baseline/src"
CAND = "/root/port/src"

FIXTURES = {
    # 非 ASCII 标识符（BMP）
    "unicode-ident.js": "const 日本 = 1;\nconst 東京 = 日本 + 1;\nexport { 日本, 東京 };\n",
    # 非 BMP 标识符（代理对）
    "nonbmp-ident.js": "const 𠮷 = 1;\nconst s = \"😀\";\nexport { 𠮷, s };\n",
    # 孤立代理项（源码里是转义文本，AST 得到孤立代理项）
    "lone-surrogate.js": 'const s = "\\uD800";\nexport { s };\n',
    # 非 ASCII / 非 BMP 对象键
    "unicode-key.js": 'const o = { 日本: 1, "😀": 2 };\nexport { o };\n',
    # CRLF 行尾 + 行注释
    "crlf.js": "// a\r\nconst x = 1;\r\n// b\r\nexport { x };\r\n",
    # legal comment（/*! ... */）
    "legal.js": "/*! @license MIT */\nconst x = 1;\nexport { x };\n",
    # 多行 legal + 普通注释
    "legal-multi.js": "/*! first */\n/*! second */\nconst x = 1; // tail\nexport { x };\n",
    # minify 空白相关
    "minify.js": "function foo ( a , b ) { return a + b ; }\nexport { foo };\n",
}

OPTS = {
    "default": {},
    "asciiOnly": {"ASCIIOnly": True},
    "minifyWs": {"MinifyWhitespace": True},
    "minifyWs+asciiOnly": {"MinifyWhitespace": True, "ASCIIOnly": True},
    "addSourceMappings": {"AddSourceMappings": True},
    "legalEOF": {"LegalComments": 2},
}


def run(src_dir, fixture, opts, out):
    cmd = ["node", "--experimental-strip-types", str(HARNESS), src_dir,
           str(FIX / fixture), json.dumps(opts), out]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=30,
                       cwd=str(ROOT), env={**os.environ, "GOMAXPROCS": "1"})
    try:
        return json.loads(p.stdout.strip().splitlines()[-1])
    except Exception:
        return {"ok": False, "stage": "worker", "detail": (p.stdout + p.stderr)[-160:]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="bench/printer-fixtures-result.json")
    a = ap.parse_args()
    FIX.mkdir(parents=True, exist_ok=True)
    for name, text in FIXTURES.items():
        (FIX / name).write_bytes(text.encode("utf-8"))

    rows, bad = [], 0
    for fixture in FIXTURES:
        for oname, opts in OPTS.items():
            b = run(BASE, fixture, opts, "/tmp/pf_b.bin")
            c = run(CAND, fixture, opts, "/tmp/pf_c.bin")
            same = (b.get("ok") == c.get("ok")) and (
                (not b.get("ok")) or (b.get("sha") == c.get("sha") and b.get("len") == c.get("len")))
            if not same:
                bad += 1
            rows.append({"fixture": fixture, "opts": oname, "equal": same,
                         "base": {k: b.get(k) for k in ("ok", "len", "sha", "stage")},
                         "cand": {k: c.get(k) for k in ("ok", "len", "sha", "stage")}})
            print(f"{'OK ' if same else 'DIFF'} {fixture:24} {oname}")
    rep = {"fixtures": len(FIXTURES), "opts": len(OPTS), "cases": len(rows),
           "mismatches": bad, "rows": rows,
           "note": "基线树 vs 候选树，同 fixture/同打印机选项；覆盖 ASCIIOnly/MinifyWhitespace/LegalComments/AddSourceMappings/Unicode/孤立代理项/CRLF"}
    (ROOT / a.out).write_text(json.dumps(rep, ensure_ascii=False, indent=2) + "\n")
    print(f"\nmismatches {bad}/{len(rows)}; wrote {a.out}")
    sys.exit(2 if bad else 0)


if __name__ == "__main__":
    main()
