# M2-c 子实验：热切片预分配 — 强负结果边界（−9.3% TotalAlloc，未过 −10% 门）

日期：2026-11-21。起点 `733da4e`。结论：TotalAlloc −9.29%（bootstrap CI [−9.30%,−9.26%] 不含 0），
统计显著、可复现，但**未达立项 −10% 门**，按门不采纳、待继续。

## 靶（pprof 实测）

`_tsc.js` 6.2MB：`p.symbols` 52,533 个 `ast.Symbol`（48B）、`p.scopesInOrder` 39,521 个 `scopeOrder`（16B）。
两者从 cap 0 经 append 增长，各 ~16 次 realloc，累计复制转瞬分配巨大。这两个 site 在 inuse/alloc pprof 都是前 4。

## 实施（byte-safe，纯预分配）

`newParser`：`symbols: make([]ast.Symbol,0,len(source.Contents)/110)`、
`scopesInOrder: make([]scopeOrder,0,len(source.Contents)/157)`；TS 时 `tsUseCounts` 同 cap。
比值经 sweep 定标（sym 80/90/100/108/110/112/118，scope 120/157/200/260），取最优 sym=/110、scope=/157。
候选 `go build ./...`、`go test ./...` 全绿；5 入口字节门 5/5 PASS。

## 测量（配对 A/B，GOMAXPROCS=1，_tsc.js，n=40 + bootstrap）

| 指标 | baseline 中位 | 预分配 中位 | 降幅 |
| --- | ---: | ---: | ---: |
| TotalAlloc | 156,525,008 | 141,985,528 | **−9.29%** |
| 峰值存活堆 | ~68.9MB | ~68.4MB | −0.6%（预分配只省转瞬复制，不留存活收益） |

bootstrap speedup(b/c) median 1.1019，CI95 [1.1021,1.1026]，不含 1 → 统计显著。
但 −9.29% < −10%，**未过门**。sweep 最优也只能到 ~−9.8%（ Sym=/118、scope=/157，单次 n=6 噪声内）。

## 为什么停在 −9.3%

预分配只消除 slice 增长的复制转瞬分配，收益上界 ≈ realloc 累计复制量 / TotalAlloc ≈ 9–10%；
且预分配本身有整体分配浪费（/110 对 _tsc.js 约多分配 7.5%）。两头挤压，卡在 −10% 之下。
真正的大头（峰值存活堆 34.6% 是 node payload，含 16B interface）预分配不触及——那需要去 interface 的核心杠杆。

## 结论与下一步

- 预分配是真实、byte-safe、统计显著的 −9.3%，但按立项书未过 −10% 门，不单独采纳。
- pprof 新证据：峰值存活堆里 node payload 合计 **20.6MB / 59.6MB = 34.6%**（远高于 TotalAlloc 口径的 12.8%），
  证明审计判断正确——TotalAlloc 低估长寿命 AST。核心杠杆（去 16B interface 的紧凑 Expr）针对这 34.6%，
  是唯一有真实机会达 −10% 存活堆的路径，继续推进。

## 信源

- `/tmp/ab-def.txt`（n=40 配对原始数）、`/tmp/ab-sym*.txt`、`/tmp/live-sym.txt`。
- `/tmp/pk-b-1.prof`（pprof inuse_space/objects，59.56MB / 667K 对象；node payload 34.6%）。
- `/root/membench/main.go`、`/root/memlive/main.go`、`/root/mempeak/main.go`。
