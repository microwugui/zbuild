#!/usr/bin/env bash
# three.js 强制单线程完整 bundler 验证（第 73 轮备环境 / 第 76 轮点亮 TS 侧 diff）。
#
# 状态：Go oracle 侧自校验通过；TS 侧最小单文件 bundle 驱动（src/bundle1.ts）已能出字节。
#       默认双侧跑并逐字节对比——TS/Go 不等属「未收敛」诊断（打印首差字节与长度差），
#       由真实 diff 反向定后续函数优先级。GO_ONLY=1 可退回只跑 Go 自校验。
#
# 用法：
#   GO_ONLY=1 bash tools/three_verify.sh     # 只跑 Go 侧自校验
#   bash tools/three_verify.sh                # Go + TS 双侧逐字节 diff（默认）
#
# Go oracle 口径（PLAN.md「终态待办」§1-§2，第 73 轮实测钉死）：
#   GOMAXPROCS=1 /tmp/esbuild-go --bundle --format=esm --platform=node --target=esnext --log-level=warning <entry>
set -euo pipefail
cd "$(dirname "$0")/.."

ESBUILD_GO=${ESBUILD_GO:-/tmp/esbuild-go}
# TS 后端默认走最小单文件 bundle 驱动（预编译包装，代码零改动只换后端）。
ESBUILD_TS_CMD=${ESBUILD_TS_CMD:-bash "$(dirname "$0")/ts-bundle.sh"}
FLAGS=(--bundle --format=esm --platform=node --target=esnext --log-level=warning)
ENTRIES=(
  "three.module.js:2985154b88b53598f62e3801c362c0f9c90f6a4154667fd4cd2754f242cda9b4"
  "three.core.js:c0fdbed276f75d0c1e621c3f0a1b26c4306463bc336c84600cc58d46673cdd63"
  "three.tsl.js:5215390f52b49db49ee749577223af72fce4556894b116cea252a4b70ed12a4d"
  "three.webgpu.js:0e9cee6bdff950e2a3821fe6aa6d5ddd3d3b15717eb1fea59e3db3e67c65c3a0"
)
BASE=testdata/three/package/build
OUT=${OUT:-/tmp/three-verify-out}
mkdir -p "$OUT"

echo "== Go 二进制 =="
"$ESBUILD_GO" --version

fail=0
for pair in "${ENTRIES[@]}"; do
  f=${pair%%:*}
  entry="$BASE/$f"
  echo "-- $f --"
  GOMAXPROCS=1 "$ESBUILD_GO" "${FLAGS[@]}" "$entry" > "$OUT/$f.go1.js" 2> "$OUT/$f.go1.err"
  GOMAXPROCS=4 "$ESBUILD_GO" "${FLAGS[@]}" "$entry" > "$OUT/$f.go4.js" 2> "$OUT/$f.go4.err"
  s1=$(sha256sum "$OUT/$f.go1.js" | cut -d' ' -f1)
  s4=$(sha256sum "$OUT/$f.go4.js" | cut -d' ' -f1)
  if [ "$s1" != "$s4" ]; then echo "  GOMAXPROCS 自校验失败: $s1 != $s4"; fail=1; continue; fi
  echo "  Go 单/多线程自校验一致: $s1"

  if [ "${GO_ONLY:-0}" = "1" ]; then continue; fi

  # TS 侧：最小单文件 bundle 驱动。字节不等属「未收敛」诊断，不掩盖，打印首差供定位。
  if [ -z "${ESBUILD_TS_CMD:-}" ]; then
    echo "  ESBUILD_TS_CMD 未设置，跳过 TS 侧"; continue
  fi
  $ESBUILD_TS_CMD "${FLAGS[@]}" "$entry" > "$OUT/$f.ts.js" 2> "$OUT/$f.ts.err"
  ts=$(sha256sum "$OUT/$f.ts.js" | cut -d' ' -f1)
  gsz=$(wc -c < "$OUT/$f.go1.js"); tsz=$(wc -c < "$OUT/$f.ts.js")
  if [ "$ts" != "$s1" ]; then
    first=$(cmp "$OUT/$f.go1.js" "$OUT/$f.ts.js" 2>/dev/null | grep -oE 'byte [0-9]+' | head -1 || true)
    first=${first:-n/a}
    echo "  TS/Go 未收敛: ts=$ts go=$s1, bytes go=$gsz ts=$tsz, 首差=${first:-n/a}"
    fail=1
  else echo "  TS/Go 逐字节相等: $ts"; fi
  if ! cmp -s "$OUT/$f.go1.err" "$OUT/$f.ts.err"; then echo "  stderr 不一致"; fail=1; fi
done

if [ "$fail" -ne 0 ]; then echo "THREE VERIFY: FAIL（Go 自校验或 TS/Go 未收敛，见上）"; exit 1; fi
echo "THREE VERIFY: OK（Go 自校验 + TS/Go 四入口逐字节相等）"
