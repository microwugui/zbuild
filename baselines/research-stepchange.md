# 更本质路线调研 + Green Tea 实测（第226代）— 结论：约束内无绕开重写的量级路径

日期：2026-11-23。**核心问题：能否绕开 706 处 Expr 去 interface 重写、拿到量级（非<10%）改善？**

## 一、业界一手调研（V8 / oxc / Go 官方）

1. **V8 parser-and-ast.md**（github.com/v8/v8）：紧凑 AST = 去 vtable + NodeType/bitfield 打包进 32-bit、
   Zone arena 分配、编译期 string dedup（比较变指针相等）。PreParser 懒解析是真 step-change 但要改架构。
2. **oxc architecture / issue #3047**：bumpalo arena + boxed enum（variant 全部 box，enum 恒 16B）、
   u32 offset 代 usize、CompactString 短串内联。10-100x 靠 Rust 语言级 arena + enum，无 GC。
3. **Go arena 现状**（blog.kakacn.com + proposal #51317 / discussion #70257）：
   - 显式 `arena` 包自 2023 无限期搁置，Go 1.26 非生产可用；含 pointer/interface/string 字段的结构体放 arena 会悬挂引用。
   - 官方原始 proposal 最高 ~15% CPU/memory 节省，仅针对适配生命周期的 workload，非普适。
   - arena 参数沿 call graph 病毒式传播、破坏 interface 组合性——正是 esbuild AST（Expr.Data interface）的死穴。
   - Go 1.26 默认方向是 Green Tea GC + stack allocation（把复杂度放进 runtime，不改 API）。

**判断**：V8/oxc 的量级收益来自**语言级 arena + 去 interface/enum boxing**，Go 两者都不具备；
M2-a 自实现 typed-chunk arena 已被证伪（+0.32%）。**绕开 706 处重写拿量级收益在 Go 上无可行路径。**

## 二、Green Tea GC 实测（零源码改动，同 892402d 源码，GOEXPERIMENT=greenteagc）

配对 A/B n=12，交错，bootstrap 20000，big40 8.2MB，GOMAXPROCS=1：

| 指标 | default 中位 | Green Tea 中位 | ratio(default/green) | CI95 | 结论 |
| --- | ---: | ---: | ---: | --- | --- |
| wall | 3742.6ms | 3822.0ms | 0.9548 | [0.906,0.999] | **Green Tea 慢 4.6%（显著但负向）** |
| TotalAlloc | 766.7MB | 766.7MB | 1.0000 | [0.9997,1.0003] | 无差异（符合预期） |
| 峰值堆 | 621.6MB | 640.2MB | 0.9823 | [0.960,1.005] | Green Tea 更高，CI 含 1 |

Green Tea 在此负载无收益、wall 反而略慢——官方 10-40% 是 GC overhead 降幅且针对 GC-heavy workload，
esbuild 大构建 GC 占比不足以兑现，1GB 机器堆紧张时 locality 优化未兑现。**该零改动路线证伪。**

## 三、收敛结论（单一推荐）

- 三条"绕开重写"路线全部实测/调研完毕：V8/oxc 做法需语言级 arena+enum（Go 无）、
  Go 官方 arena 不可用且破坏 interface、Green Tea 实测负向。**没有绕开 706 处重写的量级路径。**
- 已知可达的只有增量：Scope/Expr/Symbol 单靶实测均 <10%，合用 ~17% 需三处改造（Expr 706 处大改）。
- 本机 1GB / big40 594MB 结论不可外推用户场景（合成代理，无固定 repro）。

**单一推荐路径**：若继续，唯一可能产生量级信息的是完成 Expr 去 interface（706 处）真实改造并过门——
这是把所有增量合用推过 10% 的必要之举，但风险最高。在此之前不做无量级证据的局部小改（平台期无新信息）。
字节门先于收益门、双指标 A/B n≥8 CI、固定分母、绑探针字节的纪律全程保持。

证据：V8 parser-and-ast.md；oxc architecture + issue #3047；blog.kakacn.com/go-memory-arenas；
`/tmp/ab-greentea.json`（Green Tea n=12 原始）；`/tmp/mb-gc-{default,green}`。
