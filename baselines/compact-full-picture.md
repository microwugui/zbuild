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

## 追加（第224代）：buffer/容器类真实探针，坐实 buffer 行

审计指出 buffer 格是断言未取证。补采 gen8（19MB，大量 object 字面量语料）的 alloc_space（`/tmp/alloc-gen8.prof`）
与 big40（`/tmp/alloc-big40.prof`）对照：

| 项 | big40 (8.2MB) | gen8 (19MB) |
| --- | ---: | ---: |
| `os.readFileContents`(源码 buffer, 1×) | 8.36MB / 1.85% | 18.62MB / 5.16% |
| 源码文件本身 | 8.2MB | 19MB |
| buffer/文件 比 | 1.02 | 0.98 → **1:1 线性** |
| StringToUTF16(字符串容器) | 4.26MB / 0.94% | 3.55MB / 0.98% |
| gzip/flate | 1.45MB inuse | 0 |
| `parsePrefix`(AST 节点) | 74.3MB / 16.5% | **272MB / 75.4%** |

**结论：buffer 严格随源码线性（≈1:1），不可约——审计要求坐实，坐实后确认原判断成立**，
但修正措辞：不是固定 3.85%，而是"1:1 线性、占比随语料类型 1.85%~5.16% 变化"。
`FSCache.ReadFile` cum 显示 2× 是调用图双分支（realFS/zipFS），实际只读 1 次，无重复读问题。
**buffer 不是 16G 问题的根**：它是线性必然成本，改不动；16G 场景的内存增长来自 AST 数据结构随项目规模增长。

### step-change 判断（诚实）
V8 的 arena/去 vtable/string dedup 对我们是**增量**（死字段 ~10% + Expr ~6% + dedup 潜力），
不是数量级 step-change。真正 step-change 是 V8 PreParser 那种"只解析不改 AST"的架构级懒解析，
但那要重写语义、无法 1:1 保持行为。**根本局限：没有用户那个真实 16G 项目，所有合成案例只是代理，
594MB/1GB 机器上的任何百分比都不能当成对 16G 场景的承诺。** 能确定的是：随规模线性增长的大头是
AST 数据结构（Scope/Expr/Symbol），压它们对 16G 场景是**同比例收益**（消除的字节数随项目规模线性放大）。

证据：`/tmp/alloc-gen8.prof`、`/tmp/alloc-big40.prof`（MemProfileRate=1）；FSCache.ReadFile cache_fs.go:25-52（单次读+modKey缓存）。
