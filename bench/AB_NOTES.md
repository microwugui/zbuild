# 阶段0 测量底座：进程级交叉配对 A/B 校准记账

本文件记录 harness 本身的验证与修复，不是产物优化结果。阶段0 只加仪表、不改产物行为、可回滚。

## 1. 前置：CLI 守卫（import 期不跑 CLI）

`bench/ab_worker.ts`（及旧版 `bench/ab-v2.ts`）动态 import 驱动时，驱动底部 CLI main 块会在 import 期执行，把
bench 参数值当 entry 解析，报 `bundle_multi: parse failed: …`。修复：驱动底部加 `_invoked` 守卫，
仅当 `process.argv[1]` 匹配 `bundle_?(multi|1)\.ts$` 时才跑 CLI。[^1]

**回归与修正（负结果）**：初次正则写成 `bundle_(multi|1)\.ts$`（要求下划线），漏匹配无下划线的
`bundle1.ts` → `three.core.js` 产物变 0 字节。由 `tools/three_verify.sh` 捕获（core TS sha `e3b0c442…`），
机器确证 `/bundle_(multi|1)\.ts$/.test("src/bundle1.ts")===false`。改 `bundle_?(multi|1)` 后 core 恢复
`c0fdbed2…`（1114554 B）。并给 `align.py`/`wall.py` 加 EMPTY_OUTPUT 硬失败，杜绝「两侧都空→伪等价」。[^2]

## 2. harness 演进（v1 → v3.2，全部由「相同代码空自测」驱动）

空自测：base 与 cand 指向逐字节相同的驱动（`port-baseline/src/bundle_multi.ts` vs
`port/src/bundle_multi.ts`，`src` 树 `diff -rq` 零差异），同一份 `three.module.js`（sha `104f5614…`），
`GOMAXPROCS=1`。判定要求：`NOT_SIGNIFICANT` 且 `bytesEqual=true`。

| 版本 | 设计 | 空自测结果 | 结论 |
| --- | --- | --- | --- |
| v1 | 2 实例，严格交替，`ratio=base/cand` | ratio 0.9418, CI[0.9212,0.9823], 误判 `SIGNIFICANT_FASTER` | 弃用：①方向写反（`hi<1` 实为 cand 更慢）②伪配对 bootstrap ③严格交替与 GC 周期共振[^3] |
| v2 | 4 实例实例级交叉 | 0.9919 / 1.0002（N=16 过），但 N=24 两次 0.9641/0.9572 误判 `SIGNIFICANT_SLOWER` | 弃用：两棵树的 `internal/*` 是独立 JIT 单元，实例级交叉消不掉树级加载顺序偏置[^4] |
| v3.1 | 进程级交叉（正/反 import 顺序）+ 随机采样顺序 + 几何平均 | 0.9664 | 仍有 ~3.4% 残差；根因：预热恒为 base→cand，base 永远拿「首次执行」JIT 优势[^5] |
| v3.2 | 同上 + **预热顺序跟随 import 顺序** | 1.0330（同门 `NOT_SIGNIFICANT`） | 方向翻转 → 说明存在**未消除的首/次执行顺序效应**；~3% 按噪声处理，**不写成已确证的环境漂移**[^6] |

**偏移方向在 v3.1（0.9664，port 更慢）与 v3.2（1.0330，port 更快）之间翻转**，两次都是相同代码。
结论只到这一步：**方向翻转证明存在未消除的首/次执行顺序效应**（[38766] swap 探针同进程
first/second 0.9726、0.9801 即证据），~3% 一律按噪声处理，**不宣称「已确证是 run-to-run 环境漂移」**。
可操作含义：2 核 VM 上本 harness 的可分辨下限约 **3~5%**，低于该量级的差异不可信。

## 3. 最终设计（v3.2，`bench/ab_worker.ts` + `bench/ab_orch.py`）

1. **进程级交叉**：一半 block `--order=base-first`（偏 base），一半 `cand-first`（偏 cand）；
   合并 `speedup = sqrt(median_F · median_R)`，乘性首导入偏置 `k` 约掉（`s_F=true·k, s_R=true/k`）。
2. **预热顺序 = import 顺序**（v3.2 修正）：否则首次执行优势恒归 base。
3. **每个样本随机顺序**：消除 v1 严格交替与 GC 周期的共振。
4. **真配对 bootstrap**：每次分别重采样两组 ratio，算 `sqrt(median_F*·median_R*)` 的 95% CI。
5. **字节硬门**：所有 block `bytesEqual=true` 且 `outLen>0`，否则 `BYTES_DIFFER`/exit 3。
6. **最小效应门**：`|speedup-1| >= --min-effect`（默认 0.05）。CI 即使不含 1，效应未超噪声地板也判
   `NOT_SIGNIFICANT`。这让「相同代码 ~3% 漂移」不会被误报显著。[^6]

## 4. 空自测最终结果（负结果照记）

| 轮次 | blocks/order × n | forward | reverse | speedup | verdict | 备注 |
| --- | --- | ---: | ---: | ---: | --- | --- |
| v3.1 空自测 | 3×10 | 0.9608 | 0.9721 | 0.9664 | `NOT_SIGNIFICANT` | CI 不含 1 但效应 3.4% < 5% 地板[^5] |
| v3.2 空自测 | 2×8 | 1.0362 | 1.0299 | 1.0330 | `NOT_SIGNIFICANT` | 方向翻转，证实是漂移[^6] |

数据：`bench/ab-null-final.json`、`bench/ab-null-warmfix.json`、`bench/ab-null-v31.json`。

## 5. 决策规则（写死，防过拟合）

1. 字节等价（主指标 `bytesEqual` + 宽差异语料全绿）为**前置硬门**。
2. 主指标：进程级交叉 speedup 的 95% CI 不含 1.0 **且** `|speedup-1| ≥ 5%`（噪声地板）。
3. 辅指标：end-to-end wall time 同向（`bench/wall.py`，同样带空自测）。
4. 三者全满足才采纳；否则回滚并记账，负结果同样入账。
5. 任何 <5% 的「改善」一律视为噪声，不得宣称提速（历史 −5.7% 即此类）。

## 脚注

[^1]: src/bundle_multi.ts:308,312；src/bundle1.ts:145,149；/root/port-baseline/src 同号；修复前复现 `bundle_multi: parse failed: ../port-baseline/src/bundle_multi.ts`
[^2]: tools/three_verify.sh（core `c0fdbed2…` / module `2985154b…`）；bench/align.py / bench/wall.py（EMPTY_OUTPUT 硬失败）
[^3]: bench/ab-selftest.json + bench/ab-v1.ts:42,82,90
[^4]: bench/ab-null-n24-run1.json / run2.json（0.9641 / 0.9572）+ `diff -rq port/src port-baseline/src` 零差异
[^5]: bench/ab-null-final.json（v3.1，0.9664）
[^6]: bench/ab-null-warmfix.json（v3.2，1.0330）+ bench/ab_worker.ts 预热顺序修正
