# 微基准：Symbol 表 / Expr 表示的紧凑化收益（锚定真实结构，非同构构造）

日期：2026-11-21。承 [41504][41511]：重新审视所有可压数据结构（不限 AST），用当前不崩案例做微基准。
**纯取证，未改源码，工作树 0 dirty。**

## 口径边界（先写死，不是停下理由）
- 本机仅 **1GB 内存**（可用 ~797MB）；31MB 语料 OOM 是机器限制，非语料非线性。
- 用 `big40.js`（8.2MB / 峰值堆 594MB，RSS 606MB）与 `gen8.js`（19MB / 543MB）两个不崩案例。
- **本微基准与 594MB 案例不可外推到用户 16G 场景**；它只回答"哪些结构的表示有压缩空间、空间多大"。

## 真实案例剖析（big40.js，pprof inuse 211.93MB 采样）
| 数据结构 | 分配点 | inuse | 占比 |
| --- | --- | ---: | ---: |
| Scope 本体 | pushScopeForParsePass | 46.04MB | 21.7% |
| Expr 节点 | parsePrefix 等 | 43.5MB | 20.5% |
| Symbol 表 | newSymbol | 25.17MB | 11.9% |
| ScopeMembers | (Set) | 21.76MB | 10.3% |
| 源码 buffer | realFS.ReadFile | 8.16MB | 3.85%（1:1 线性，不可约） |

**证伪 buffer 假设**：源码 buffer 仅 3.85% 且线性，"buffer 是大头"不成立。大头全是解析期常驻 AST 数据结构。

## sizeof 实测（go1.26.5 unsafe.Sizeof）
Scope=192B、ScopeMembers=80B、Symbol=48B、Expr wrapper=24B（interface 8B + Loc 4B 对齐）；
Expr 负载 EIdent=12B / ENum=8B / EStr=32B / EDot=48B / EBin=56B / ECall=56B / EIf=72B。

## 微基准 A：Symbol 表（锚定真实 ast.Symbol 48B + 真实 55 万规模）
单进程 A/B，GC 间隔，runtime.MemStats 测 TotalAlloc + 峰值存活堆。基准自校验：A 版 25.19MB 与真实 pprof
newSymbol 25.17MB **精确吻合** → 基准可信（锚定真实，非 R14 同构构造）。

| 表示 | 结构大小 | TotalAlloc | 相对 A |
| --- | ---: | ---: | ---: |
| A 当前 `[]ast.Symbol` | 48B | 25.19MB | — |
| B 去稀疏 NamespaceAlias/Link  shortening | 40B | 20.99MB | −16.7% |
| C string interning（Name→uint32 offset） | 24B | 13.61MB | −46.0% |
| D SoA 平行数组 | — | 8.94MB | −64.5% |

Symbol 表是真大头（48B×55万）且**从没被压过**；C/D 方案省 46–65%。

## 微基准 B：Expr 去 interface（锚定真实 E* 负载 + 真实 mix + 100 万节点）
mix = 40%EIdent/20%ENum/15%EDot/10%EBin/10%ECall/5%EStr。

| 表示 | TotalAlloc | 相对 A |
| --- | ---: | ---: |
| A 当前 Expr wrapper(24B) + 逐节点 new(E*) | 68.82MB | — |
| B tagged-handle（8B，去 interface + 去逐节点 malloc） | 7.63MB | **−88.9%** |

与 R14（4.4×）方向一致：收益来自去 interface 间接 + 去逐节点 malloc。但**这是纯节点微基准**，
未计 handle 指向的 arena 负载、709 处 `.Data.` 改造成本、以及真实构建里 Expr 只占存活堆 20.5% 的权重。

## 结论与靶子排序（供决策，非执行）
1. **Expr（20.5% 存活堆，微基准 −89%）**：空间最大，但改动面 706 处 `.Data.`、M1 证字面摊平反胖、
   多条实现路径（unsafe union / SoA / 句柄）先例全负——需先定写法再谈改造。
2. **Symbol 表（11.9%，微基准 −46~65%）**：真大头、从没压过、改动面小（单一 `[]ast.Symbol`），
   string interning 或 SoA 收益扎实——**最有把握的下一个结构靶**。
3. **Scope（21.7%）/ ScopeMembers（10.3%）**：M2-d 已压过一轮（内联 2 槽近最优，见 m2e 分布探针），
   边际空间小，非下一靶。

## 纪律
字节门先于收益门、双指标 TotalAlloc + 峰值存活堆、配对 A/B n≥8 + CI 不含 1、禁止比例微调、根因先行——
均未因本轮微基准而松动。微基准只是选靶取证，任何采纳仍需过上述门。

## 信源
- 剖面 big40.js：`/tmp/pk-big40.js.prof`；gen8.js：`/tmp/pk-gen8.js.prof`；`go tool pprof -top -inuse_space /tmp/mempeak-adopt`。
- sizeof + 微基准：goport-exp 内临时 `internal/sizeprobe2`、`internal/symbench`、`internal/exprbench`（均 go1.26.5，跑完已删除，工作树 0 dirty）。
- Symbol 字段：`internal/ast/ast.go:519`（Symbol）、`:385`（Ref）、`:237`（Index32）；Expr 负载：`internal/js_ast/js_ast.go`。

## 追加取证（[41533] 后）：微基准假设被真实构建验证/修正

### alloc_space 剖面（big40，`/tmp/alloc-big40.prof`，MemProfileRate=1）
累计分配 top：`newSymbol` **91.2MB/20.2%（第一大）**、`pushScopeForParsePass` 87.3MB/19.4%、
`parsePrefix`(Expr) 74.3MB/16.5%、`ScopeMembers.Set` 46MB/10.2%。但 `newSymbol` 的 flat 仅 21.47MB
（Symbol slice 反复增长的累计拷贝），其余是增长历史 + 零拷贝 name（见下）。**inuse（存活）口径仍是
Scope 46MB/Expr 43MB/Symbol 25MB**，两个口径排布不同，双指标都要看。

### 真实字段分布探针（graph.go:167 克隆点，跑完已 git restore，0 dirty）
对 big40 真实构建的 44 万 symbols 逐个统计：

| 字段 | 实测 | 含义 |
| --- | --- | --- |
| `NamespaceAlias != nil` | **0 / 440004** | 指针 8B 全程为 nil |
| `Link != Invalid` | **0 / 440004** | Ref 8B 全程无效 |
| `OriginalName` 唯一率 | 200008 / 440004（重复 54.5%） | interning 有真实去重空间 |

**根因确认**：`OriginalName` 是 `source.Contents` 的零拷贝子串（`lexer.Raw()` 直接切片，`MaybeSubstring`），
name content 已在 8.16MB 源码 buffer 里，不额外分配。所以 Symbol interning 的真实收益 =
省 16B string header→4B offset（×44万≈5.3MB）+ 去两个死字段 16B（×44万≈6.7MB）
≈ **12MB / 存活堆 594MB ≈ 2%**，加上 slice 增长消除（alloc_space 21.47MB）后 TotalAlloc 侧更高。
微基准 C/D 版（−46~65%）高估了，因为把 name content 当额外分配；真实收益需以改造后 A/B 为准。

### 修正后的认知
- Expr 去 interface 仍是唯一有 ≥10% 潜力的单靶（存活 20.5% × 微基准 −89%）。
- Symbol 表改造（去死字段 16B + interning）真实收益约 2% 存活堆，单独不过门，但**改动面小、风险低**，
  可与 Expr 叠加（用户 [41533] 明确两靶可合用）。
- 两者叠加是正确方向：Expr（大改，主收益）+ Symbol（小改，稳收益）→ 合计有希望显著过 10% 门。

证据：`/tmp/alloc-big40.prof`；graph.go 临时探针输出（已还原）；lexer Raw()/MaybeSubstring（js_lexer.go:374,236）。

## 追加取证（第222代）：Expr 去 interface 收益用真实构建坐实，推翻 −89% 微基准

审计指出方法论矛盾：一边用真实探针推翻 Symbol 微基准高估，一边仍拿 Expr 纯节点微基准 −89% 当决策依据。
本轮按同一标准验证 Expr。**结论：−89% 是高估，真实收益 −31.1%。**

### 真实分配形态（big40，MemProfileRate=1 的 alloc-big40.prof，按构造行 flat）
所有 E* 负载对象实际分配合计 **43.93MB**（不是微基准里凭空消失）：
EString 10.99MB / EFunction 8.55MB / EBinary 4.89MB / EIdentifier 4.56MB / EDot 3.67MB /
EArray 3.66MB / EObject 3.66MB / ECall 2.45MB / ENumber 1.50MB。

### 精确核算（分配字节÷size-class=节点数，再按 sizeof 打包紧凑 arena）
| 项 | 当前 | 紧凑(handle+arena) |
| --- | ---: | ---: |
| 节点数 | ~131 万 | 同 |
| payload 对象 | 43.93MB | arena 40.96MB（去 malloc 头/对齐，payload 字节不可消） |
| Expr wrapper | 24B×N = 30.06MB | handle 8B×N = 10.02MB |
| **合计** | **73.99MB** | **50.98MB** |

**真实收益 = −31.1%**（来自 wrapper 24→8B + 去 malloc 头/对齐），**不是微基准的 −89%**。
微基准 B 版错在把 payload 整体丢弃（7.63MB 只有 handle），而真实 arena 必须承载 40.96MB 负载。

### 对决策的影响（修正上轮错误）
- 上轮称"Expr 是唯一能过 10% 门的单靶（−18% 存活堆）"——**错**，那是拿 −89% 微基准 × 20.5% 占比算的。
- 坐实后：Expr −31.1% × 存活占比 20.5% ≈ **整构建存活堆 −6.4%**，单靶**同样过不了 10% 门**。
- Symbol（~2%）+ Expr（~6.4%）+ ScopeMembers/Scope 边际，三者全叠加乐观上也仅 ~10% 边缘，
  且 Expr 需 706 处 `.Data.` 改造、风险极高。**本机 1GB/594MB 案例不可外推 16G**（口径边界保持）。

### 结论
Expr 与 Symbol 的微基准收益在真实构建下都大幅缩水（−89%→−31%、−65%→−2%），根因同为
"payload/name content 不可消，微基准错误丢弃"。这印证 R14 同构微基准不可外推的老问题。
在动真实源码前，此轮先把两个靶的真实收益都坐实——**没有任何单靶能过 10% 门**，
叠加也仅边缘。是否仍要做 706 处 Expr 改造，属需拍板的方向，不在本取证轮擅自开工。

证据：`/tmp/alloc-big40.prof`；`go tool pprof -list 'js_parser'` 按构造行；`unsafe.Sizeof` 各 E* 负载；
本机 1GB / big40 峰值 594MB（不可外推用户 16G）。
