# M2-a 竞技场化 — 负结果记录（已回滚）

日期：2026-11-21。起点 `856493b`（M1 完成态）。结论：**收益不成立，已按立项书回滚止损，代码回 `856493b` 未改**。

## 做了什么

- 生成 GC 安全的 typed-chunk 竞技场 `internal/js_ast/arena.go`（77 个 node 类型，`[][]T` 分块，
  返回 `&chunk[i]` 内部指针，GC 扫描块背阵，安全）。
- Go-AST codemod 把 `p *parser` 方法内的 `&js_ast.E*/S*/B*{...}` 改写为 `p.arena.AllocX(...)`：
  js_parser.go 389、js_parser_lower.go 152、js_parser_lower_class.go 45、ts_parser.go 若干。
- 候选通过 `go build ./...`、`go test ./...` 全绿；**5 入口字节门 5/5 PASS**（注意：必须以 cwd=`/root`
  跑，否则 legal-comment 的路径前缀 `port-hotbase/...` vs `../port-hotbase/...` 会造成假 FAIL——这是 cwd 产物，非代码 bug）。

## 测量（M3 口径：峰值存活堆或 TotalAlloc 降幅 ≥10%，n≥8）

内存测量工具 `/root/membench`（`pkg/api.Build` 单次 bundle `_tsc.js` 6.2MB，GOMAXPROCS=1，
强制 GC 后取 TotalAlloc 增量 + 采样峰值堆）。baseline = 未改源码，arena = M2-a 候选。

| 口径 | baseline 中位 | arena 中位 | 降幅 |
| --- | ---: | ---: | ---: |
| n=8 单跑 | 155,819,820 | 156,180,376 | **+0.23%（反而变大）** |
| 交错 A/B n=12 | 156,476,636 | 156,974,152 | **+0.32%（反而变大）** |
| 峰值堆 | ~203.2MB | ~204.0MB | 变大 |

chunk=8（减小分块浪费）复测更差：160,646,840（+3.1%）。**无一达 −10%，负结果确凿。**

## 根因（为什么竞技场在这里无效）

1. pprof `alloc_space` 实测：node 字面量分配合计仅 **20.01MB / 156.5MB = 12.8%**，
   还有其他路径（scop e/symbol slice 增长 ~20%、printer ~15%、文件 IO ~9%）。竞技场最多只能优化这 12.8% 的一部分。
2. 竞技场**不能消除负载字节**，只是把「逐节点 malloc」换成「批量分块 malloc」；省的只是 malloc 头与 size-class 取整。
   esbuild 的小节点（`EBoolean`/`ENumber`/`EIdentifier` 等无指针）已被 Go tiny allocator 打包（多个塞进 16B），
   本就几乎无浪费。
3. typed-chunk 的每类型 128 槽分块带来尾部浪费 + 分块头，抵消并超过了省下的 malloc 开销 → 净变大。

## 结论与后续

M2-a（竞技场化）作为「去逐节点 malloc」的低风险先手，实测失败。按立项书「负结果照记、<10% 回滚止损、不硬凑」：
- 代码已回滚到 `856493b`，工作树干净，字节门复验 OK。
- **R14 的 4.4× 收益来自同构微基准（每节点同形），不能直接外推到真实 AST**——真实 AST 里 node 分配只占 12.8%，
  这是 M1 已标注的风险，M2-a 用实测证实了它。
- 内存收益的真正大头在 scope/symbol slice 增长与 printer，不在 AST 节点表示本身。继续在 AST 表示上做 M2-b/c，
  预期同样难以达到 −10%；但是否继续由主线决策，本轮不再擅自停工（按 A 的精神，先如实记账并滚动到下一决策）。

## 信源

[^1]: `/tmp/ab.txt`（交错 A/B n=12 原始数）、`/tmp/membench*` 工具源码 `/root/membench/main.go`。
[^2]: pprof `alloc_space`（`/tmp/mem2.prof`，`runtime.MemProfileRate=1`，`_tsc.js` 单跑）node 字面量合计 20.01MB。
[^3]: 字节门 `/tmp/m2a-byte2/*`（cwd=/root），`go test ./...` 输出。
