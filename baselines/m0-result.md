# M0 基线固化 — 验收记录

日期：2026-11-21。仓库：goport 孤儿分支（本地 `main`  Tracking `origin/goport`），本轮起点 `3d63b04`，固化提交 `b10d888`。

## 前置：基线二进制固化（本轮第一件事，已完成）

`/tmp/esbuild-go`（字节等价第一硬门的唯一参照）位于易失 `/tmp` 且实测无法用现有工具链按 SHA 复现，
已复制到持久位置并提交进 goport 分支，从此不依赖 `/tmp`：

| 固化文件 | sha256 | 来源 | 与基线关系 |
| --- | --- | --- | --- |
| `baselines/esbuild-go.base` | `b8387dab…bee11` | `/tmp/esbuild-go` | 参照本体 |
| `baselines/goport-go126.base` | `27a1330e…2760e` | go1.26.5 重建 | ≠ 基线（负结果留存） |
| `baselines/goport-go.base` | `a42bea90…69bc` | 系统 go1.27.3 重建 | ≠ 基线（负结果留存） |

`sha256sum -c baselines/SHA256SUMS` 三项 OK。清单见 `baselines/SHA256SUMS.md`。

## M0 构建口径

- 源码：goport `3d63b04`（**未改** esbuild 0.28.2 源码，仅含管理工具/立项书/基线目录）。
- 工具链：`GOTOOLCHAIN=go1.26.5`（命中缓存 `go1.26.5.linux-amd64`），`CGO_ENABLED=0`。
- flags：`"-ldflags=-s -w -buildid=" -buildvcs=false -trimpath`（Makefile `GO_FLAGS` 同口径）。
- 候选二进制 `baselines/m0-candidate` sha256 `27a1330e20215a93299dd1f155c425d3d1659e2a34e5175e997930892562760e`
  （与 `goport-go126.base` 一致，符合预期：同一源码同一工具链）。版本 `0.28.2`。

## 字节等价门（第一硬门）— 5/5 PASS

命令：`GOMAXPROCS=1 <binary> --bundle --format=esm --platform=node --target=esnext --log-level=warning <entry>`
（口径取自 `/root/port-hotbase/tools/three_verify.sh`）。语料 `/root/port-hotbase/testdata/three/package/build/`，
其文件与 `three-0.187.0.tgz` 逐字节一致（如 `three.core.js` 输入 sha `613e370f…` 两处相同），确认真实语料。
golden 由固化基线二进制现跑生成，candidate 由未改源码现跑生成，逐字节 `cmp`（含 stderr）比对：

| 入口 | 输出字节 | 输出 sha256 | base==cand |
| --- | ---: | --- | --- |
| three.module.js | 1709919 | `38edef43…edb3` | ✅ |
| three.core.js | 1114567 | `e2f02ab1…e7` | ✅ |
| three.tsl.js | 1251831 | `3c4cea35…ffa` | ✅ |
| three.webgpu.js | 3010240 | `9d794c6f…fa69` | ✅ |
| three.webgpu.nodes.js | 3003719 | `d3ffa9f1…54a57` | ✅ |

产物存 `baselines/m0-golden/*.base.js` 与 `baselines/m0-candidate-out/*.cand.js`（逐字节 `cmp` 一致）。

## Go 测试门 — 全绿

`GOTOOLCHAIN=go1.26.5 CGO_ENABLED=0 go test ./...`：所有包 `ok` / `[no test files]`，无 FAIL。
关键包：`cmd/esbuild` 0.013s、`internal/bundler_tests` 4.152s、`internal/js_parser` 1.122s、`pkg/api` 0.019s。

## 负结果 / 存疑（如实记录）

- 二进制 sha 不可复现：`b8387d`（基线）≠ `27a1330`（go1.26.5）≠ `a42bea`（go1.27.3）。
  这是已知负结果，根因未确证、不臆测；故硬门验输出产物而非二进制 sha（立项书已载）。
- 本轮 golden 输出 sha 与历史 `port-hotbase/bench/align-result-three-proxy.json` 的记录值不同
  （如 three.core.js 本轮 `e2f02ab1`/1114567B vs 历史 `c0fdbed2`/1114554B）。
  根因：历史 align-result 由不同 flag 管线产生（本轮权威口径是 `three_verify.sh` 的
  `--bundle --format=esm --platform=node --target=esnext --log-level=warning`，仓库内无其它 three flag 定义）。
  输入语料相同（均 three-0.187.0），差异来自 flags/包装；对 M0 无影响——M0 只要求 base 与 cand
  在同输入同 flags 下逐字节相等，已满足。不硬凑历史数值。

## 结论

M0 三要件（基线二进制固化 + 5/5 字节等价 + go test 全绿）全部通过。可进入 M1 表示设计；
基线参照系已脱离 `/tmp`，不再脆弱。
