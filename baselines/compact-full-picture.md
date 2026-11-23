# 紧凑化全面收益图景 + 业界调研（第223代）

日期：2026-11-21。**纯取证，未改源码（探针均 git restore，worktree 0 dirty）。**

## 口径边界（先写死）
本机仅 1GB 内存；用 big40.js 8.2MB / 峰值堆 594MB 与 gen8.js 19MB / 543MB 两个不崩案例。
**所有数字不可外推到用户 16G 场景**；只回答"各数据结构的表示可压缩空间与量级"。

## 一、各数据结构真实可压缩收益表（真实构建探针坐实，非微基准）

基准：big40 真实构建，inuse 采样 211.93MB / 峰值堆 594MB；alloc_space 高采样率 `/tmp/alloc-big40.prof`。

| 数据结构 | 存活占比 | alloc 占比 | 死字段/可压缩点（真实探针） | 真实收益估算 |
| --- | ---: | ---: | --- | ---: |
| **Scope** (192B×32万) | 21.7% | 19.4%(push) | **Replaced/Generated/TSNamespace 全 0 = 56B死字段**；Members 内联已优化 | ~56/192=29% of Scope ≈ **−6.3% 存活** |
| **Expr** (24B wrapper + payload) | 20.5% | 16.5% | 去 interface wrapper 24→8B + malloc头/对齐；payload 40.96MB 不可消 | 坐实 **−31.1% of Expr ≈ −6.4% 存活** |
| **Symbol** (48B×44万) | 11.9% | **20.2%(newSymbol第一)** | **NamespaceAlias/Link 全 0 = 16B死字段**；name 零拷贝子串；slice 增长 21.47MB | ~16/48=33% of Symbol ≈ **−4% 存活** + TotalAlloc 侧消增长 |
| **ScopeMembers** (80B+map) | 10.3% | 10.2% | 溢出 map 35.28MB（含 make 3.67MB）；2槽近最优（m2e 已证） | 边际，非独立靶 |
| 源码 buffer | 3.85% | 1.85% | 1:1 线性，不可约 | 0 |

**单靶全部过不了 ≥10% 门**（Scope −6.3% / Expr −6.4% / Symbol −4%）。
**合用**（Scope+Expr+Symbol，三者独立不重叠）乐观上 ≈ −17% 存活堆 — 过门，但需三处改造，其中 Expr 是 706 处大改。

## 二、业界调研（V8 parser-and-ast.md，权威一手）

三条做法直接对应我们的死字段/字符串问题：
1. **Vtable-free AstNode**：AST 节点无虚函数，NodeType + flags 打包进单个 32-bit `bit_field_`，省 8B/节点且提升 cache 局部性。→ 对应我们 Expr/Symbol 的 kind 打包。
2. **Off-heap AstValueFactory + 编译期字符串去重**：解析期所有字符串在 Zone arena，identifier 在 `string_table_` 去重，之后比较名字只是一次**指针相等**。→ 对应我们 Symbol name 54.5% 重复率，可去重为指针/offset。
3. **Zone arena 分配 + 延迟 internalize**：解析期 AST/scope/string 全在 arena，解析完成后才一次性 internalize 到堆。→ 这是"一次性编译"的原生范式，能把逐节点 GC 压力变成 arena 批量管理。

来源：`https://github.com/v8/v8/blob/3a9b.../docs/parsing/parser-and-ast.md`（V8 官方文档，2026-11-21 抓取）。
旁证 oxc、tsv 也用 arena + compact representation（minifier.md / tsv architecture.md）。

## 三、推荐与决策点

- 死字段消除（Scope 56B + Symbol 16B）是**低风险、改动面小、收益确定**的第一刀：不动布局语义，只是把构建期从不用的字段移出主结构。Scope −6.3% + Symbol −4% ≈ **−10.3% 存活堆，单靠死字段合用就卡在门上**。
- Expr 去 interface（−6.4%）是主收益但 706 处大改、高风险，应作为第二阶段，且需先解决"enumerated kind + arena 负载"的正确写法。
- V8 的 string 去重（54.5% 重复）是额外叠加项，可独立做。

**我的推荐**：第一刀砍**死字段**（Scope+Symbol），低风险即可触门线；Expr 作为第二阶段主攻。
但这是"是否现在动源码 + 先改哪个"的方向决策，按纪律我不在结论刚坐实、未获拍板时擅自开工。

## 信源
- `/tmp/alloc-big40.prof`（MemProfileRate=1）按行 flat；`/tmp/pk-big40.js.prof`（inuse）。
- Scope 探针 graph.go:167（big40: total=320001, replNZ=0, genNZ=0, tsnNZ=0，已 git restore）。
- Symbol 探针（total=440004, alias=0, link=0, dup=54.5%，已 git restore）。
- sizeof：Scope=192 Symbol=48 Expr=24（unsafe.Sizeof，go1.26.5）。
- V8 官方文档 URL 见上；本机 1GB / big40 594MB，不可外推 16G。
