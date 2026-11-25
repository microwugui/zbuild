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
