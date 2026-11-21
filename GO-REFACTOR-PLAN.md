# goport：Go 版 esbuild AST 紧凑化重构 — 立项书 + 进度看板

## 立项（用户方向，选 A/B/C 逐一确认后定案）

目标：**改 Go 版本身**的 AST 表示，把 `interface` + 逐节点堆分配换成紧凑表示，
降低大构建内存占用与 GC 压力；用测试逐步验证，保持输出逐字节等价。

- **分支**：`goport`，孤儿分支（与 main 无共同历史），内容 = 完整 Go esbuild 0.28.2 源码 + 本套管理工具。
- **基线（比对对象，保留不删）**：`/root/esbuild` @ `f6058f8`（esbuild 0.28.2），二进制 `/tmp/esbuild-go`
  sha256 `b8387dbab66e8c2ce90ce0397e7efd94814f61601c6e351a59d1f7dd0abbee11`。
  Go 工具链 `go.version=1.26.5`（`GOTOOLCHAIN=go1.26.5` 可下载）。
- **工作树**：`/root/goport`（本分支 checkout 处）。`/root/port`（TS 侧）已按用户指示删除。

## 为什么立项（收益证据，机器实测）

R14 微基准（`bench/ast-soa-go-bench.go`，在 TS 侧 zbuild 仓库构造，见 main 的 LEDGER R14）：
同构 AST 负载，三版表示的内存：

| 表示 | 100 万节点 | 字节/节点 |
| --- | ---: | ---: |
| A esbuild 现状（`Expr{Data interface, Loc value}` + 逐节点 new） | 83.93 MB | 88 B |
| B 紧凑扁平结构体（去 interface） | 19.08 MB | 20 B |
| C SoA（并行 typed 数组） | 19.10 MB | 20 B |

三规模（10万/100万/400万）完全线性，**4.4× 下降**。关键判断：
- 收益来自「去 interface 间接 + 消除逐节点分配」，**不是 SoA 本身**（B=C=20B）；
- 与语言无关——瓶颈是表示方式，不是 Go-vs-TS；
- 43 个 `E*` 类型、171 处 `.Data.(type)` 分派、91 处类型断言 → 必须一次性全量改造，不能只改热点。

## 目标（可量化）

主目标（内存）：单个 9MB 级大构建（typescript.js / _tsc.js）的峰值存活堆或 TotalAlloc 下降。
次目标（时间）：大构建 wall time；紧凑表示改善缓存局部性，时间可能同步受益，需实测。
**立项线**：内存降幅 ≥10%（对标 R14 的 4.4× 上限，留足工程折中余量）；输出逐字节等价；门不回退。

## 硬门（每阶段都必须过，否则回滚）

1. **字节等价（第一硬门）**：同一入口、同一参数，候选 vs 基线 `/tmp/esbuild-go` 输出 `sha256` 逐字节一致。
   - 验的是**输出产物**，不是二进制 sha——基线二进制用原工具链构建，实测不可逐 sha 复现
     （go1.26.5 重建得 `27a1330…` ≠ `b8387d…`，原因未确证，不臆测）。
   - 覆盖入口：three 5 入口（module/core/tsl/webgpu/webgpu.nodes）+ 宽语料子集。
2. **Go 测试门**：`go test ./...` 全绿（对照基线树同命令结果）。
3. **工具链固定**：`GOTOOLCHAIN=go1.26.5`，`CGO_ENABLED=0`，`Makefile` 的 `GO_FLAGS`（`-trimpath -ldflags=-s -w -buildid= -buildvcs=false`）。

## 里程碑（逐步替代，每步可独立验收/回滚）

- **M0 基线固化**：clone 出的 goport 用 go1.26.5 构建 → 对 three 5 入口跑字节基线，存 `baselines/`。
  验收：候选（未改代码）输出与 `/tmp/esbuild-go` 逐字节一致。
- **M1 表示设计**：确定紧凑表示方案（优先 B：去 interface 的扁平 struct + kind 标签，因 B=C 内存相同、
  B 更简单）；写设计注 `docs/repr-design.md`，给出 43 类型的字段并集与分歧点。
- **M2 机械改造**：codemod 把 `E` interface → 扁平结构；171 处 `.Data.(type)` → kind 分派；
  91 处类型断言 → 数值 kind 检查。每批改造后跑字节门 + go test。
- **M3 收益验收**：大构建配对 A/B（内存 + 时间），n≥8、bootstrap CI 不含 1、内存降幅 ≥10%。
- **M4 收口**：全部门绿则采纳；否则回滚该批并记账。

## 进度看板（每轮更新）

| 里程碑 | 状态 | 证据 | 日期 |
| --- | --- | --- | --- |
| 立项/分支建立 | 进行中 | 本文件 + goport 孤儿分支 | — |
| M0 基线固化 | 未开始 | — | — |
| M1 表示设计 | 未开始 | — | — |
| M2 机械改造 | 未开始 | — | — |
| M3 收益验收 | 未开始 | — | — |
| M4 收口 | 未开始 | — | — |

## 风险与约束

- 这是全量 AST 表示重构，43 类型 / 171 分派点，改动面大；每批必须过字节门才可继续。
- 基线 `/root/esbuild` 绝不可改（是比对对象）；所有改造只在 goport 工作树。
- `go.mod` 刻意停在 go 1.13 语法（注释明确"不要改"）——改造不得引入 1.13 不支持的语法。
- 负结果照记：若 M3 收益 <10% 或字节门失败，回滚并如实记录，不硬凑。

## 信源

- 收益证据：zbuild main 的 `bench/LEDGER.md` R14、`bench/ast-soa-go-result.json`、`bench/ast-soa-go-bench.go`。
- 基线：esbuild 0.28.2 `/root/esbuild` @ f6058f8，Makefile 构建口径。
