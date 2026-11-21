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
