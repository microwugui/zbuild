# M2-e：采纳基线 892402d 的存活堆复查 + 下一靶定标

日期：2026-11-21。本轮不改动已采纳源码（goport `892402d`/`4e13e24` 保持不变），只对采纳后基线重跑
mempeak/pprof，定位剩余存活堆大头，并把下一结构靶的取舍建立在实测分布上。

## 一、复测口径（与 M2-d 一致）

- 语料 `_tsc.js` 6.2MB；`GOMAXPROCS=1`；`mempeak-adopt` 链接 goport-exp=892402d。
- 峰值 inuse 三次：121.1 / 119.2 / 123.7 MB（HeapAlloc 峰值高水位）；取涨水最大的
  `/tmp/pk-adopt-3.prof`（inuse_space 汇总 30.97MB 采样，pprof 采样口径，非全量）。
- alloc_space：`/tmp/alloc-adopt.prof`（58.71MB 汇总）。

## 二、采纳后存活堆 by-line（相对 M2-d 前的变化）

| 分配点 | M2-d 前 inuse | 采纳后 inuse | 变化 |
| --- | ---: | ---: | --- |
| `pushScopeForParsePass` | 11.50MB | 3.59MB | **−7.9MB**（内联小 map 生效，Members map 分配消失） |
| `declareSymbol` Members 写入 | 6.52MB | (并入 Set) | 消失 |
| `ScopeMembers.Set`（溢出 map） | — | 1.52MB | 新的残余项 |
| `&Scope{}` 结构本身 | 5MB(120B) | 3.5MB(192B) | 结构变大但总量降 |
| `ReadFile`（源码字节） | 5.93MB | 6.07MB | 不可约（行/tracker 需要源码） |
| EIdentifier 节点 | ~3MB | 3MB（197,715×16B） | 未动 |

`ScopeMembers.Set` 现在是解析侧第一大多余分配：alloc_space 3.52MB / inuse 1.52MB —— 来自
27% 有 3+ 成员的 scope 仍要整体 spill 到 Go map（hmap+bucket）。

## 三、下一靶定标（实测分布，排除比例微调）

临时探针在 `hoistSymbols` 后遍历 `p.scopesInOrder`（38,118 个 scope）：

| 成员数 | scope 数 | 占比 |
| ---: | ---: | ---: |
| 0 | 12,733 | 33% |
| 1 | 6,941 | 18% |
| 2 | 8,245 | 22% |
| 3 | 4,052 | 11% |
| 4 | 2,403 | 6% |
| 5 | 1,392 | 4% |
| 6 | 721 | 2% |
| 7+ | 1,631 | 4% |

冷字段占用：`Children` 21,618/38,118=57% 非空 → sidecar 会对多数 scope 额外分配，**不划算**；
`Replaced`/`TSNamespace`/`Label`（探针时刻）≈0。

推论：
- **内联槽 2→4**：ScopeMembers 80B→144B，全部 38,118 scope 各 +64B（+2.4MB），只让 6,455 个
  scope 免于 spill（≈1.8MB），**净亏** → 排除。
- **内联槽 2→1**：−36B×38,118（−1.4MB），但 6,941 个 1 成员 scope 转 spill（≈1.9MB），**净亏** → 排除。
  结论：M2-d 的 2 槽已近最优，成员表不是下一个可过门的结构靶。
- **Scope 冷字段 sidecar**：可省 ~48B×38K≈1.8MB（~3% 存活堆），**过不了 −10% 门**，属边际改动。
- **去 16B interface 的紧凑 Expr**：剩余 node payload ≈15MB alloc_space（EIdentifier 3MB +
  EDot/EBinary/ENumber…，197K EIdentifier 对象），是唯一仍有 ≥10% 潜力的核心杠杆；但需 706 处
  `.Data.` 改写，且 M1 已证「字面摊平 64 字段反增大结构」，实现路径有多种（unsafe 联合 / SoA /
  内联高频子集），风险与收益差异大。

## 四、结论与待定

采纳基线已固化，本轮 heap 基线二进制/剖面齐备：
`/tmp/mempeak-adopt`、`/tmp/allocprof`、`/tmp/pk-adopt-{1,2,3}.prof`、`/tmp/alloc-adopt.prof`；
配对 A/B harness `/tmp/mb-sc-{base,exp3}`、`/tmp/ml-sc-{base,exp3}`（链接 pristine/892402d）。

剩余可达 −10% 的唯一路径是去 interface 紧凑 Expr，实现方式有多种且需先定方案（见对话提问），
故本轮不擅自开工高风险改写。字节门先于收益门、双指标 + n≥8 + CI 的纪律保持不变。

## 信源

- `/tmp/pk-adopt-3.prof`（inuse_space）、`/tmp/alloc-adopt.prof`（alloc_space）、`go tool pprof -list`。
- 临时成员分布探针（已 git checkout 还原，r2 工作树 0 dirty）：DIST m0=12733 m1=6941 m2=8245
  m3=4052 m4=2403 m5=1392 m6=721 m7plus=1631。
- 冷字段探针（时刻 hoistSymbols）：child=21618 gen=0 repl=0 label=0 tsns=0。
- `/root/goport/baselines/m2d-scopecompact-result.md`（M2-d 采纳证据）。
