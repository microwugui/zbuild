# M2-d 子实验：Scope Members 紧凑表示 + 热切片预分配 — **过门，采纳**

日期：2026-11-21。起点 `733da4e`。结论：TotalAlloc **−10.92%**、峰值存活堆 **−10.06%**，
两项均过 −10% 门；paired A/B n=24 bootstrap CI 均不含 1；5 入口字节门 5/5；`go test ./...` 全绿。
**按门采纳。**

## 靶（pprof 峰值存活堆实测，非 TotalAlloc 口径）

`_tsc.js` 6.2MB 峰值 inuse 59.56MB，按分配行摊开（`pprof -list` on `mem-base`）：
- `&Scope{}`（`js_ast.go:1171`）**5MB** —— 39,521 个 Scope × 120B；
- 函数体 copy-down `scope.Members[name]=member`（`js_parser.go:1205`）**5MB**；
- `declareSymbol` 的 Members map 写入（`js_parser.go:1519`）**6.5MB**；
- Members map 头 ~1MB。

Scope member 机制合计 ≈12.5MB / 59.6MB ≈ **21%**，是存活堆第一大项——远大于 Expr 节点负载。
上一代 M2-b（仅 lazy map，−0.99%）/ M2-c（仅预分配，−9.29% TotalAlloc 但存活 −0.59%）各自为证，
本轮把**两者叠加**并新增**内联小 map**：三个不同分配类，非比例微调。

## 实施（byte-safe 结构性）

1. **内联小 map**（`js_ast.Scope.Members`）：`map[string]ScopeMember` → `ScopeMembers`
   ——2 个内联槽（name+ScopeMember），超 2 项溢出到 map。≤2 成员的 scope 不再分配 hmap+bucket。
   - 迭代器、索引读、长度、赋值全部改方法（Get/GetRef/Set/Len/ForEach/MembersPtr）。
   - **关键正确性**：`range Members` 的 10 处全部要么显式排序、要么顺序无关（renamer/linker/
     hoistSymbols/charFreq），故 ForEach 的无序迭代与 Go map 无序等价。
   - **溢出不变量**：一旦溢出 `n=0` 且所有写走 map，内联与 map 存储互斥，无重复条目（已修一处潜在 bug）。
   - 唯一 Scope 结构拷贝点（`graph.go:223` 克隆 ModuleScope）在大语料下已溢出为共享 map，与旧语义一致；
     该点之后无任何 `Members` 写入。
2. **热切片预分配**（复用 M2-c 已验证口径）：`newParser` 中 symbols/scopesInOrder/tsUseCounts
   按源码长度预估 cap（sym=/110、scope=/157）——消除 append 增长复制的转瞬分配。

候选 `go build ./...`、`go test ./...` 全绿（30 包）。

## 字节门（先于收益门）

注：冻结 golden 由不同工具链生成，pristine 733da4e 现重建与 golden 本就差 3–9B（m0 已知遗留），
故以**同 flags 同工具链现重建的 pristine** 为参照系。5 入口 `cand == pristine` **5/5 PASS**
（three.module/core/tsl/webgpu/webgpu.nodes），stderr 均 0。

## 测量（配对交错 A/B，GOMAXPROCS=1，_tsc.js，n=24 + bootstrap 30000）

| 指标 | baseline 中位 | 候选 中位 | 降幅 | CI95(b/c) | 不含 1 |
| --- | ---: | ---: | ---: | --- | --- |
| TotalAlloc | 156,477,696 | 139,384,472 | **−10.92%** | [1.1226, 1.1228] | ✅ |
| 峰值存活堆 | 65,754,752 | 59,142,200 | **−10.06%** | [1.0580, 1.1641] | ✅ |

存活堆原始样本呈 59M/65M/75M 三簇（GC 时机噪声），故用中位数 + 配对比值 bootstrap；中位数稳定。
TotalAlloc CI 极窄（[1.1226,1.1228]），robust 过门。

## 根因链闭环

- M2-a 竞技场（去 malloc 头）：+0.32% → 否证「去逐节点 malloc」代理法。
- M2-b lazy map：−0.99% 存活 → 空 map 只是小头。
- M2-c 预分配：−9.29% TotalAlloc / −0.59% 存活 → 转瞬复制收益，不触及存活堆。
- **M2-d 内联小 map + 预分配**：同时命中存活堆主体（Scope member 机制）+ 转瞬复制 → 双指标均过门。
  这验证了「存活堆口径 + 结构性压缩」路线，纠正了 m4-closeout 仅凭 TotalAlloc 得出的「不可达 10%」结论。

## 信源

- `/tmp/sc3-ta.txt`（TotalAlloc n=24 配对原始数）、`/tmp/sc3-live.txt`（存活堆 n=24 配对原始数）。
- `/tmp/pk-b-1.prof`（pprof inuse_space 59.56MB；`pprof -list` 按行 5/5/6.5MB）。
- `/tmp/mb-sc-{base,exp3}`、`/tmp/ml-sc-{base,exp3}`（配对 A/B 二进制，分别链接 pristine/候选源码）。
- `/tmp/esbuild-sc3` 与 `/tmp/esbuild-pristine`（字节门候选/参照 CLI，同 GOTOOLCHAIN=go1.26.5 flags）。
- 候选源码：goport 分支 commit（本文件同批提交）。
