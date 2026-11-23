# Scope 冷字段 sidecar（低风险层）— 负结果，不采纳（第224代开工首刀）

日期：2026-11-23。在采纳基线 892402d 上把 Scope 的 Replaced(24B)+TSNamespace(8B) 移入懒分配 sidecar
（Scope 192B→168B，使用点 7 处）。**按门不采纳，已回滚。**

## 门结果
- 字节门：5 入口 + big40/gen8/_tsc.js 全 PASS；go test ./... 全绿。
- 收益门（配对 A/B n=12，交错，bootstrap 20000，big40 8.2MB，GOMAXPROCS=1）：
  - TotalAlloc：731.3MB→726.3MB = **−0.69%**，CI[1.0063,1.007] 不含 1（显著但极小）
  - 峰值存活堆：610.3MB→605.6MB = **−0.78%**，CI[0.9821,1.008] **含 1，不显著**
- 双指标未同时过门；即使过也远低于 10%。**不采纳。**

## 根因：为什么微基准高估
- 微基准（内部 scopebench，Scope 192→136B 全移三字段）显示 −29%，A 版 58.6MB 与 pprof 精确吻合。
- 但实际只移两字段（192→168B，−24B），且 Scope 本体在整构建 TotalAlloc 731MB 里只占 ~8%；
  省 24B×32万≈7.7MB ≈ TotalAlloc 的 1%，实测 −0.69% 一致。**微基准的 −29% 是 Scope 子集口径，
  不是整构建口径**——又一次印证"微基准不可外推"。
- 峰值堆 CI 含 1：sidecar 的冷对象在少数 scope 上额外分配，抵消了主结构缩小。

## 决策
低风险死字段 sidecar 单独收益 <1%，不值得引入间接访问复杂度。**回滚。**
这进一步坐实全面表结论：Scope/Expr/Symbol 单靶全部 <10%，合用才是唯一可能触门的路径，
但 Expr 是 706 处大改。在 1GB/594MB 案例上做的任何改动都不可外推用户 16G 场景。

证据：/tmp/ab-sc-sidecar.json（n=12 原始数据）；/tmp/alloc-sidecar.prof（按行 &Scope{} 58.64→53.76MB）；
候选二进制 /tmp/esbuild-sc-sidecar；改动 3 文件已 git checkout 还原。
