# M2-b 子实验：scope Members 懒分配 — 负结果（已回滚）

日期：2026-11-21。起点 `733da4e`。结论：TotalAlloc −0.43%、峰值存活堆 −0.99%，均远未达 −10%，按门回滚。

## 为什么选这个靶

pprof `alloc_space` 与 `inuse_space`（`_tsc.js` 6.2MB）双口径实测一致指向 scope 机制：
- `pushScopeForParsePass`：in-use **11.7MB / 23.3%**（全表第一），其中 `&Scope{}` 5MB、`Members: make(map)` 2.5MB、
  函数体 copy-down 2.5MB、`scopesInOrder` append 1.46MB；
- `newSymbol` 4.2MB / 8.3%；`declareSymbol` 2.6MB。
- 39,521 个 scope 中 33%（25,461）的 Members  map 最终为空——每个都白分配一个 map。

## 实施（byte-safe）

- `js_ast.Scope` 加 `AddMember` helper：首次写时才 `make(map)`；读 nil map 在 Go 中安全。
- codemod 把 9 处 `X.Members[k]=v` 改为 `X.AddMember(k,v)`，删去 scope 字面量的 `Members: make(...)`。
- 候选 `go build ./...`、`go test ./...` 全绿；5 入口字节门 5/5 PASS（cwd=/root）。

## 测量（n=12 交错 A/B，TotalAlloc + 存活堆双口径）

| 指标 | baseline 中位 | lazy-map 中位 | 降幅 |
| --- | ---: | ---: | ---: |
| TotalAlloc | 156,474,040 | 155,794,972 | **−0.43%** |
| 存活堆（GC 后 HeapAlloc） | 68,895,264 | 68,212,352 | **−0.99%** |

两口径都远未达 −10%；TotalAlloc 有一个 149M 的离群点但中位数稳定。存活堆原始数在 62/68/75MB 三档跳动
（GC 时机噪声），但中位数仍只 −0.99%。

## 结论

scope Members 懒分配是真实但微小的优化（≈0.5–1%），不足以立项采纳。已回滚到 `733da4e`，字节门复验 OK。
本轮证实：即便命中 pprof 第一大 allocation site（23%），单点微优化也拿不到 R14 承诺的 4.4×——
因为 R14 是同构微基准（AST 表示=全部内存），真实构建里内存分散在 scope 结构本身、符号表、printer、IO 等多处。

## 信源

- `/tmp/ab-scope.txt`（TotalAlloc A/B n=12）、`/tmp/live-scope.txt`（存活堆 A/B n=12）。
- `/tmp/pk-b-1.prof`（pprof inuse_space/inuse_objects，peak 59.56MB / 667K 对象）。
- `/root/membench/main.go`、`/root/memlive/main.go`、`/root/mempeak/main.go`（测量工具）。
