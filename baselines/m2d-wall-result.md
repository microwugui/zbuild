# M2-f（继 M2-d）：采纳基线 892402d 的 wall time 取证 —— 真实收益，冷 CLI 稳定显著

日期：2026-11-21。本轮**不改源码**，只对已采纳的 M2-d（goport `892402d`，Scope Members 内联小 map
+ 热切片预分配）配对测 wall，回答"内存收益是否转化为用户主指标（编译速度）"。
结论：**冷 CLI 端到端 wall 稳定 +4.2~5.9%，4/4 独立 run 的 CI95 全部不含 1**，M2-d 在用户主指标上被验证。
进程内预热 build 阶段受宿主噪声影响（符号会翻转），只作辅证、不用于决策。

## 一、口径（用户方法学 [39497]：冷/热分离、充分预热、每轮释放算法缓存）

- 语料 `_tsc.js` 6.2MB（`testdata/large`）。两个**同 flags 同工具链现重建** CLI：
  - baseline `/tmp/wall-pristine` ← `/root/goport-base` @ `733da4e`（pristine），sha256 `27a1330e…`
  - candidate `/tmp/wall-adopt` ← `/root/goport-exp` @ `892402d`（采纳 M2-d），sha256 `30a691e5…`
  - 构建：`GOTOOLCHAIN=go1.26.5 CGO_ENABLED=0 go build -trimpath -ldflags='-s -w -buildid=' -buildvcs=false`
- **冷 CLI 端到端**（主指标，对标用户 15–17× 冷差距）：每样本一次全新子进程，
  `subprocess.run` + `perf_counter_ns` 计时，输出 `/dev/null`；3 次丢弃预热后交错 A/B（ABBA 抵消漂移），
  n=32/48/64；bootstrap 20000 次比值 ratio=base/cand，CI95 不含 1 才算显著。[^1]
- **预热后 build 阶段**（辅指标）：进程内 harness（替代 `/root/membench`，去掉 ReadMemStats 采样 goroutine
  以免污染 wall 计时），先 8 次 warmup，量 `api.Build` 单项 wall；每轮 `runtime.GC()` 清 sync.Pool
  （= 算法/资源缓存），`nofree` 模式额外不调 `debug.FreeOSMemory()` 以避免缺页噪声。[^2][^3]
- **字节门先于收益门**：同 CLI 同参数产物 `sha256(c9eb18c0…)` 两侧逐字节一致（stderr 0），PASS。

## 二、冷 CLI 端到端 wall（主指标，4/4 显著）

| run | n | base 均值 ms | cand 均值 ms | speedup(base/cand) | CI95 | 不含 1 |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| 1 | 32 | 798.17 | 765.26 | **1.0430** | [1.0113, 1.0731] | ✅ |
| 2 | 32 | 698.17 | 670.29 | **1.0416** | [1.0219, 1.0632] | ✅ |
| 3 | 64 | 826.31 | 791.27 | **1.0443** | [1.0214, 1.0698] | ✅ |
| 4 (GOMAXPROCS=1) | 48 | — | — | **1.0586** | [1.0222, 1.0991] | ✅ |

均值法 speedup 集中 1.042–1.059；中位数法同样全部不含 1（run1 1.063、run2 1.040、run3 1.048）。
**这是冷子进程、含进程启动的真实用户口径**，与 LEDGER 锚点（`bench/wall.py`）同类。

## 三、预热后 build 阶段 wall（辅指标，宿主噪声大、方向会翻转）

| 模式 | n | mean speedup | mean CI95 | med speedup | 采用? |
| --- | ---: | ---: | --- | ---: | --- |
| free(GOMAXPROCS=1) run1 | 32 | 1.0542 | [1.020,1.089] ✅ | 1.079 | 否 |
| free(默认) run1 | 32 | 1.0751 | [1.038,1.111] ✅ | 1.081 | 否 |
| free(默认) run2 | 32 | 0.9598 | [0.908,1.008] ❌ | 0.980 | 否 |
| nofree(GOMAXPROCS=1) run1 | 64 | 1.0980 | [1.058,1.141] ✅ | 1.103 | 否 |
| nofree(默认) | 64 | 1.0791 | [1.049,1.111] ✅ | 1.068 | 否 |
| nofree(GOMAXPROCS=1) run2 | 64 | 0.9824 | [0.956,1.010] ❌ | 0.982 | 否 |

`debug.FreeOSMemory()` 引发的缺页 + 共享宿主瞬态使进程内口径符号在 +10%/−2% 间翻转；同一现象与
LEDGER 记录的空自测噪声地板（±3%，方向翻转）一致。**故进程内结果只作方向参考，决策以冷 CLI 为准。**

## 四、根因链（与内存门闭环，非相关性猜测）

M2-d 已实测 TotalAlloc −10.92%（`baselines/m2d-scopecompact-result.md`）、峰值存活堆 −10.06%，
CI 极窄；本轮冷 CLI wall +4~6% 与之方向一致：分配少 → GC 次数/标记量少 → build 更快。
机制可对账，不是无根因盲改。但 wall 增益（~5%）远小于内存增益（~11%），符合 GC 只占 build 一部分。

## 五、决策与下一步

- **M2-d 在用户主指标（编译速度）上被验证**，无回滚、无源码改动。
- 下一步（评估，非擅改）：把 M2-d 的 Scope Members 内联小 map + 热切片预分配移植到 TS 侧
  （`src/internal/js_ast/js_ast.ts:1236 Members: Map`，`js_parser.ts:893/894 scopesInOrder/symbols`），
  目标直接压 TS/Go 差距；移植仍守字节门 + 双指标 + n≥8 CI + ≥10% 门。移植前先用 TS 侧 GC 占比
  （profile-warm-r7/r8：GC ~20%）对收益天花板做量级估算，避免无根因地投入大改。

## 信源
[^1]: baselines/wall/cold_wall_result_n32.json、cold_wall_repeat.json、cold_wall_n64.json、cold_wall_g1.json；harness /tmp/cold_wall.py
[^2]: baselines/wall/warm3_nofree_g1.json、warm3_nofree_g2.json、warm3_nofree_g1_repeat.json、warm_wall_result.json、warm_wall_repeat.json、warm_wall_g1_result.json
[^3]: /root/wallbench3/main.go（nofree/free 模式，warm=8，GC 清 sync.Pool）；/root/wallbench3-base/go.mod→/root/goport-base，/root/wallbench3/go.mod→/root/goport-exp
[^4]: 字节门 sha256 c9eb18c0…（/tmp/wp-out.js vs /tmp/wa-out.js，cmp 一致，stderr 0）
[^5]: baselines/m2d-scopecompact-result.md（TotalAlloc −10.92%/存活 −10.06% 原始证据）
