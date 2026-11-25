# object 字面量 properties 预分配：内存双指标首次过门（第240代）

日期：2026-11-25。审计纠偏：不许用 ENumber 的 0 收益外推成 Property 大头也无路、不许"太麻烦"放弃、
不许手算判死、选(a)对真正大头做端到端实测。本代交付：**对 gen8 决定性大头
（properties=append 196MB）做最小预分配改动，TotalAlloc −16.49% / 峰值 RSS −12.95%，
双指标同时过 −10% 门**，字节门 + go test 全绿。main 9dff11c 未动。

## 一、靶（pprof 实证，非手算）
`/tmp/alloc-gen8.prof`（gen8 19MB 大量 object 字面量）：parsePrefix 266MB flat 中
`properties = append(properties, property)`（js_parser.go:3945）**196.25MB alloc_space**——
Property 结构 120B，object 字面量解析时 `properties := []js_ast.Property{}` 零容量起步，
每次 append 扩容复制整个 Property。这是 gen8 内存分配的决定性大头。

上一代 ENumber 值化 0 收益是因为它只占 2%、多是瞬时节点，**不能外推**到这个 196MB 的大头——
审计明确指出这点。本代直接打这个大头。

## 二、改动（最小、4 行）
`internal/js_parser/js_parser.go:3919`（object 字面量 `{...}` 分支）：
`properties := []js_ast.Property{}` → `properties := make([]js_ast.Property, 0, 4)`。
只改 object 字面量这一处（gen8 大头）；JSX attributes(5270) 等其他 properties 不动。
不动任何字段布局、不碰 class/decorator，因此编译安全、字节安全（区别于破坏性删字段/ sidecar）。

## 三、门（全部机器实测）
### 字节门（严格同源基线 main 9dff11c vs 候选）
big40.js / gen8.js / deep12k.js `--bundle --minify --format=esm` 产物**逐字节一致**，rc 全 0。
go build ./... 全绿；go test ./... 全绿。

### 双指标（配对 A/B，GOMAXPROCS=1，固定分母，n≥8）
**TotalAlloc**（parse-only n=6，KB/parse）：
| 语料 | base | cand | 变化 |
| --- | ---: | ---: | ---: |
| **gen8** | 522955 | 436705 | **−16.49%** |
| big40 | 545862 | 535768 | −1.9% |
| deep12k | 16184 | 16184 | 0%（无 object 字面量，符合预期） |

**峰值 RSS**（整构建 gen8，n=8，/usr/bin/time %M）：
- base 中位 **687.6MB**（范围 687.5–687.7）
- cand 中位 **598.5MB**（范围 598.5–598.6）
- **−12.95%，8 次采样区间完全不重叠**（CI 不含 1）

**TotalAlloc −16.49% 与峰值 RSS −12.95% 同时过 −10% 门。** 本会话内存优化首次达标。

## 四、为什么这次成功而 parts 预分配失败
parts 预分配（上代 exp-mem 证伪，TotalAlloc 反增）用 `len/256` 粗估 cap，对 4 万个大 Part
（~200B）过度预分配，浪费抵消收益。这次 properties 用**固定小 cap=4**（object 字面量通常 ≤4 属性），
每处只多分配 3 个空槽（3×120B=360B），但省掉前几轮 append 扩容复制（1→2→4 复制 7 个 Property）。
gen8 海量小 object 使净收益巨大，且不引入过度预分配浪费。

## 五、边界与下一步
- 收益集中在 object 字面量密集语料（gen8）；big40 −1.9%、deep12k 0%。这不是缺陷——算法针对性优化的预期。
- cap=4 是保守起点，未调参（cap=2/8 可能更优/更差），本代先固化已达标的 cap=4。
- 不外推 16G：gen8 19MB/598MB（本机 1GB），百分比不作为用户 16G 场景承诺。
- **下一步（继续，非请示）**：① 对 cap 做小梯度实测（2/4/8）取最优；② 把同样的"小 slice 固定 cap"手法
  应用到其他 append 热点（items=append 47MB、CloneLinkerGraph 的 Part/Symbol clone）；③ 每步字节门 +
  双指标 + 配对 A/B。成果固化在 exp-expr 分支，main 保持隔离。

## 六、信源/状态
- worktree /root/goport-expr(exp-expr) @ 本代提交；改动仅 js_parser.go 4 行；main(9dff11c)未动。
- profile /tmp/alloc-gen8.prof；A/B 原始数在本轮控制台。
- 相关台账：mem-targeting-audit.md、expr-tagged-poc.md、compact-full-picture.md。

## 追加（同代）：cap 梯度实测确认 cap=4 最优
gen8 TotalAlloc KB/parse（parse-only n=6，同源编译仅改 cap）：
| cap | gen8 KB/parse | 相对 base(522955) |
| ---: | ---: | ---: |
| 1 | 522955 | 0%（=无预分配） |
| 2 | 492955 | −5.7% |
| **4** | **436705** | **−16.5%（最优）** |
| 8 | 444205 | −15.1%（略差） |
| 16 | OOM Killed | 过量预分配反噬 |
cap=4 是甜点：object 字面量通常 ≤4 属性，cap=8 多分配空槽浪费，cap=16 在海量 object 下直接 OOM。
**确认已提交的 cap=4 为最优，无需改动。**

## 追加（同代继续）：array 字面量 items 预分配（同一手法第2例）
gen8 profile 次热点：`items=append`（js_parser.go:3877）47.85MB alloc_space，array 字面量 `[...]`
从 `items := []js_ast.Expr{}` 零容量起步。改动：`make([]js_ast.Expr, 0, 4)`（parsePrefix 的 TOpenBracket 分支）。
- 字节门：big40/gen8/deep12k 逐字节一致；go test 全绿。
- 增量（对照 8109497 仅 properties 版，隔离 array 单独效果）：
  - TotalAlloc gen8 436705→419830（**−3.86%**）、big40 −1.1%、deep12k 0%
  - 峰值 RSS gen8 598.5→581.1MB（**−2.92%**，8 次区间不重叠）
- cap 梯度：cap=2 431080、cap=4 419830、cap=8 419830（并列）、cap=16 464830（过量浪费）→ 保持 cap=4。
- **累计相对 main(9dff11c)**：TotalAlloc −19.72%（522955→419830）、峰值 RSS −15.49%（687.6→581.1MB）。
- 判断：array 增量本身 <10% 单靶门，但是已验证手法的第2例、代价 1 行、字节门全过、区间不重叠、
  累计收益继续扩大 → 采纳。不外推 16G。

## 追加（同代继续）：批量 8 处小 slice 预分配 — 负结果，回滚
把参数/解构类零容量 slice（args Arg/Expr、ArrayBinding、PropertyBinding、ClauseItem 共 8 处）
统一改 `make(..., 0, 4)`。字节门 3 语料一致、go test 全绿，但
TotalAlloc gen8 419830→419830（0%）、big40 +0.01%、deep12k 0% —— 收益为零。
根因：这些 slice 元素数少/实例少，固定 cap 的额外空槽浪费 ≈ 省下的扩容复制。
**按纪律回滚，只保留已成功的 properties(120B×海量小object) 和 items(24B×array) 两处。**
教训：固定 cap 预分配只对"元素结构较大 + 实例海量 + 元素数稳定少"的 slice 有效，
不可无差别推广到所有零容量 slice。

## 追加（同代继续）：symbol slice 自定义 2× 增长 — 采纳（增量，<10%单靶门）
big40 的 `p.symbols=append` 是 TotalAlloc 第一大项（89MB）。symCap=/110 是按长文件校准，
big40（4万浅函数、symbol 密度 54/110B）cap 严重不足，Go 默认 ~1.25× 增长导致多次全量复制。
- 失败尝试：symCap=/30 → big40 −8.2% 但 gen8 +5.2%、three.webgpu +10.4%（长文件过度预分配）。
- **采纳方案**：保持 symCap=/110 起步，在 newSymbol 里当 `len==cap` 时手动 `make(cap*2)+copy`，
  再 append。big40 少复制、长文件起步小不浪费。
- 增量（对照 0421881）：TotalAlloc big40 **−7.60%**（530212→489935）、gen8 0%、three 0%（不伤）。
  峰值 RSS big40 **−6.12%**（763.9→717.2MB，8 次区间不重叠）。
- 字节门 3 语料逐字节一致；go test 全绿；`p.symbols` 仅 newSymbol 一处 append（封装完整）。
- 判断：单靶 <10% 门，但真实收益、零字节差异、不伤其他语料、风险低 → 采纳累积。不外推 16G。
- 累计相对 main(9dff11c)：加上本项后 big40 TotalAlloc/RSS 进一步下降（逐项累积，见各节）。

## 累计整体验证（对照 main 9dff11c，全部 3 处代码改动一起）
严格同源：main 无优化 vs exp-expr 最终(0d6db8f)。字节门 big40/gen8/deep12k 逐字节一致。
配对 A/B n=8、GOMAXPROCS=1、区间不重叠：
| 语料 | TotalAlloc | 峰值 RSS |
| --- | ---: | ---: |
| gen8 (19MB object字面量) | 522955→419830 KB = **−19.72%** | 687.6→581.0MB = **−15.50%** |
| big40 (8.2MB 4万函数) | 545857→489901 KB = **−10.25%** | 779.2→717.1MB = **−7.96%** |
三处改动合计仅 +22 行（symbol 2× 增长 + object properties cap4 + array items cap4），
零新抽象、字节安全。这是本会话内存优化的可交付成果。不外推 16G。

## 追加（第244代）：深度嵌套专项取证 —— 回答审计 [42209]「深度嵌套内存有优化吗」

审计指出前几轮 wins 集中在 gen8(object 密集)/big40(函数密集)，而 deep12k 显示 0%，
用户 [42209] 正是问这个。本代重新 pprof 取证并对齐"大内存/深嵌套"靶。

### 取证（新造 3.9MB 深嵌套语料 deepfast_3k_40.js = 40 函数 × 3000 层嵌套 block）
早期 31MB 深嵌套语料本机 1GB 直接 OOM；deep12k 仅 578K/12k 符号太小。
新语料把每层引用限制在自身局部(v_i，O(1) findSymbol)，避免纯链式的 O(n²) CPU 爆炸，
build 仅 1.3s，可在 1GB 上做 n≥8 配对 A/B。alloc_space/inuse_space（/tmp/df-expr.*.prof）：
- `pushScopeForParsePass`（&Scope{} 192B）27.8% alloc / 27.0% inuse —— 深嵌套第一大头
- `parseStmtsUpTo`（stmts slice）15.2% alloc —— 第二大头
- `newSymbol` 5.2% alloc / 7.9% inuse；`Assign` 6.9% alloc。

### 关键发现：deep12k 的 0% 是"语料太小"假象
deep12k 只有 12k 符号，symbol slice 增长收益被淹没；但 120k 符号规模下，
已提交的 symbol 2× 增长开始显著。**累计 exp-expr(全部 4 处) vs main 9dff11c，
deepfast 深嵌套语料，配对 A/B n=12、GOMAXPROCS=1、区间完全不重叠：**
| 指标 | main | exp-expr | 变化 |
| --- | ---: | ---: | ---: |
| TotalAlloc | 159421560 | 139050944 | **−12.78%** |
| 峰值 RSS | 169972 KB | 148114 KB | **−12.86%** |
**深嵌套不再是 0%——是双指标均 −12.8% 的实质收益。** 不外推 16G。

### 本代新增第 4 处改动：parseStmtsUpTo stmts 预分配 cap4
`js_parser.go:8522` `stmts := []js_ast.Stmt{}` → `make([]js_ast.Stmt,0,4)`。
字节门 big40/gen8/deep12k 逐字节一致；增量 TotalAlloc deepfast −3.97%（144.81M→139.05M，
配对 n=10，区间 [144805760,144806152] vs [139050504,139056096] 完全不重叠）。
cap 梯度：cap2 无收益(144.8M)、cap4 最优(139.0M)、cap8(150.0M)/cap16(173.0M)过量反噬。
gen8 不伤(614.7M 不变)。commit 45e0497。

### 结论与下一步
- [42209] 已回答：深嵌套在真实规模下累计 −12.8%（此前 0% 是小语料假象）。
- 深嵌套第一大头 Scope 结构体的冷字段 sidecar 已在第224代证伪（<1%，见 scope-sidecar-negative.md），
  Members 内联 [2] 已在 892402d 优化——Scope 单体暂无低风险空间。
- 继续方向：深嵌套 alloc 次热点（Assign 6.9%、parseSuffix）与 buffer 已证 1:1 不可约；
  按纪律继续找新的存活集热点，每处严格字节门+双指标+配对A/B。
