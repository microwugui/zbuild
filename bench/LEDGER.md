# 性能优化实验台账（阶段0 起）

决策规则（写死）：**字节等价 ∧ 统计显著（且超过噪声地板）∧ 门不回退** 三者全满足才采纳；
否则回滚并记账，负结果照记。CI 含 1.0 一律不算赢；<5% 的「改善」一律视为噪声。
主指标=进程级交叉配对 A/B，辅指标=end-to-end wall time，正确性门=宽差异语料逐字节对齐。
方法论见 [38390]，harness 校准见 `bench/AB_NOTES.md`。[^1][^2]

## 基线锚点

| 项 | 值 |
| --- | --- |
| 代码提交（基线锚点） | `d1e4942696e926b9fe601de817e1bdefdfa13cad`（stage0：守卫 + bench 底座 + 台账） |
| 冻结基线 | `/root/port-baseline` 以 `git worktree` 锚到 `d1e4942`，`src` 树与 port `diff -rq` 应为空 |
| three.module 输入 | sha `104f5614…e341`，658900 B；产物 `2985154b…cda9b4`，1709893 B |
| Node / 核数 | v22.23.3；2 核 VM；`GOMAXPROCS=1`，无后台负载 |
| 测量噪声地板 | 相同代码空自测 |speedup−1| 实测 ~3%（v3.1 0.9664 / v3.2 1.0330，方向会翻转；成因未确证） |

## 轮次记录

### R0 — 阶段0 仪表落地（纯仪表，不改产物行为，可回滚）

**改动**：驱动加 `_invoked` CLI 守卫（`bundle_multi.ts`/`bundle1.ts`，两侧逐字节相同）；
基线 worktree 同步同守卫。守卫正则修正：`bundle_?(multi|1)`（首版漏匹配 `bundle1.ts`，见下）。[^3]

| 实验 | 工具/sha | 测量 | 决策 |
| --- | --- | --- | --- |
| v1 空自测 | `ab-v1.ts` | 0.9418，CI 不含 1，误判 FASTER | **弃用**：方向反 + 伪配对 + GC 共振[^4] |
| v2 空自测 N=24 | `ab.ts` v2 | 0.9641 / 0.9572，误判 SLOWER | **弃用**：树级加载顺序偏置无法在实例级抵消[^5] |
| v3.1 空自测 | `ab_worker.ts`+`ab_orch.py` | 0.9664，`NOT_SIGNIFICANT`（效应<5%地板） | 发现预热顺序根因[^6] |
| v3.2 空自测（预热随 import 顺序） | 同上 | 1.0330，`NOT_SIGNIFICANT`；方向翻转 | **采纳 v3.2**：方向翻转只证明存在未消除的首/次执行顺序效应；~3% 按噪声处理，**不宣称已确证环境漂移**[^7] |
| 宽差异对齐 | `align.py`+`align_worker.ts` | 448 条：440 PASS + 8 PASS_BOTH_ERROR（真 parse failed），0 BYTES_DIFFER/EMPTY/WORKER_FAIL，559 s | **采纳门**：候选 vs 基线逐字节一致[^8] |
| three 代理对齐 | 同上 | 5/5 PASS，66 s | 代理组与 wide 门分开[^9] |
| wall 空自测 | `wall.py` | n=20：speedup 0.9878，CI[0.9607,1.031]，`NOT_SIGNIFICANT`，bytes True；另 n=12：0.9989，CI[0.9777,1.0339]，out `2985154b…` | **采纳辅指标**（已加 EMPTY_OUTPUT 硬门）[^10] |
| bundle1 守卫回归（负结果） | `src/bundle1.ts` | three_verify core 0 B / `e3b0c442…` | 改 `bundle_?(multi|1)` → core 恢复 `c0fdbed2…`[^11] |
| 门校验（修正后） | — | three_verify core `c0fdbed2…` + module `2985154b…` 逐字节；tsl/webgpu 首差 2431/15159 为 HEAD 既有；tsc 166 | **门不回退**[^11] |
| 阶段1 profile | `profile_run.py` | self-time：parse/lex 36.5%、other 16.7%、encode 14.5%、print 12.9%、GC 12.8%、treeshake 5.2%、renamer 1.3%；GC 138 次 Scavenge / 411 ms | **记账**，非优化决策[^12] |
| 阶段1 inclusive | `analyze_inclusive.py` | bundleWithImports 77.7%、parseFile/Parse 46.9%、printOne/Print 24.0%；parseStmt 33.5%、parseFn 27.3%、printStmt 23.6% | **顶层地图**：parse+print 占 bundle 主链约 9 成；大优化优先这两条[^13] |

**R0 结论**：测量底座已建立并诚实校准（噪声地板 ~3–5%），产物行为零改动，尚未做任何产物优化，
故「性能提升」为空 —— 不编造。

## 顶层 inclusive 地图（供阶段2选靶）

| 函数 | inclusive% | self% | 含义 |
| --- | ---: | ---: | --- |
| bundleWithImports | 77.7 | 0.2 | bundle 主链（其余 ~22% 为模块加载/启动） |
| parseFile → Parse | 46.9 | 0.6 | 解析阶段（约占 bundle 时间 60%） |
| parseStmt / parseStmtsUpTo | 33.5 | 1.7 | 语句解析 |
| parseFn / parseClass | 27.3 / 21.5 | 0.3 / 0.3 | 函数/类解析 |
| printOne → Print | 24.0 | 0.4 | 打印阶段（约占 bundle 时间 31%） |
| printStmt / printExpr | 23.6 / 21.3 | 0.7 / 1.3 | 语句/表达式打印 |

> self-time 榜首是 GC(12.4%)、encode(11.1%)；但 inclusive 显示真正的大头是 parse+print 顶层主链。
> 按用户方法论提示：优先找顶层算法问题（一处优化带动一大片），而非只盯 self-time 热点。[^13]

## 决策门槛检查清单（每轮优化前）

1. 列出代码 sha 变更点（含基线侧）。
2. 跑宽差异门 `python3 bench/align.py`：BYTES_DIFFER/EMPTY/WORKER_FAIL=0。
3. 跑主指标 `python3 bench/ab_orch.py --blocks-per-order 3 --n 10`：CI 不含 1 **且** |speedup−1|≥5%。
4. 跑辅指标 `python3 bench/wall.py` 同向。
5. 跑六档门（tsc/assign/m1/doc/cov/three_verify core+module）不回退。
6. 全绿才采纳；任一不过 → 回滚 + 本台账记负结果。

## 脚注

[^1]: bench/AB_NOTES.md（harness 演进 v1→v3.2）+ 方法论交付 [38390]
[^2]: bench/README.md:1-9（口径）+ bench/FINDINGS.md（阶段②③历史，含 −5.7% 噪声结论）
[^3]: src/bundle_multi.ts:308,312；src/bundle1.ts:145,149；/root/port-baseline/src 同号
[^4]: bench/ab-selftest.json + bench/ab-v1.ts:42,82,90
[^5]: bench/ab-null-n24-run1.json / run2.json（0.9641 / 0.9572）；`diff -rq port/src port-baseline/src` 零差异
[^6]: bench/ab-null-final.json（v3.1，0.9664）
[^7]: bench/ab-null-warmfix.json（v3.2，1.0330）+ bench/ab_worker.ts 预热顺序修正
[^8]: bench/align-result.json + bench/gen_align_corpus.py（448 wide）+ bench/align.py（timeout + 护栏）
[^9]: bench/align-result-three-proxy.json
[^10]: bench/wall-null.json；bench/wall.py（EMPTY_OUTPUT 硬门）
[^11]: tools/three_verify.sh（实跑 core/module 逐字节；tsl/webgpu 首差为 HEAD 既有）+ PLAN.md:5218 + src/bundle1.ts:145
[^12]: bench/profile-stage1.json + bench/profiles/stage1-three.module.cpuprofile
[^13]: bench/profile-inclusive.json + bench/analyze_inclusive.py（inclusive=沿栈含被调子树，同函数每栈计一次）
