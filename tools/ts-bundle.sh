#!/usr/bin/env bash
# TS bundle 后端包装（第 76 轮 · three_verify.sh 的 ESBUILD_TS_CMD 默认值）。
# 与 Go 同参数、同入口；代码零改动，只换后端。入口为第一个非 -- 参数。
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
# 第 77 轮：入口含相对 import 时走多文件驱动（依赖内联 + 跨文件链接 + tree-shaking），
# 无 import 的单文件入口（如 three.core.js）仍走 bundle1.ts。
ENTRY=""
for arg in "$@"; do case "$arg" in --*) ;; *) ENTRY="$arg"; break;; esac; done
if [ -n "$ENTRY" ] && grep -qE "from ['\"]\.[^'\"]*['\"]" "$ENTRY" 2>/dev/null; then
  exec node --experimental-strip-types "$HERE/src/bundle_multi.ts" "$@"
fi
exec node --experimental-strip-types "$HERE/src/bundle1.ts" "$@"
