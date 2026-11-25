# tree-sitter 交叉比对（选型依据）— 紧凑表示可行性 + 与 Go esbuild parse 对比

日期：2026-11-25。用户给任务：拉 tree-sitter、研究源码/数据结构、实际跑、与 Go 实现对比（单线程、
不求逐字节、作选型依据）。**纯取证，未改 goport 源码，worktree 0 dirty。**

## 一、tree-sitter 版本与环境
- tree-sitter **0.28.0**（commit 127254c，2026-11-24），源 `/root/ts-compare/tree-sitter`（8.3M 浅克隆）。
- grammar：tree-sitter-javascript（`ts-js`，parser.c 2.8M）；C runtime 用 `lib/src/lib.c` 编译。
- 对比 harness：
  - `/tmp/ts-parse-bench`（C，直接调 `ts_parser_parse_string` N 次，单线程，CLOCK_MONOTONIC + getrusage）。
  - `/tmp/go-parse-bench`（Go，直接调 `js_parser.Parse` N 次，单线程，time + getrusage）——纯 parse，不含 print/link，与 TS 公平。

## 二、tree-sitter 核心数据结构（选型关键）

**Subtree = 8 字节 tagged union**（`lib/src/subtree.h`）：
- `union { SubtreeInlineData data; const SubtreeHeapData *ptr; }`——低位 `is_inline` 标记（利用指针对齐低位必 0）。
- 小叶子节点（无外部 scanner、非 error）：**完全内联进 8B**——`symbol`(u8) + `parse_state`(u16) + 7 个 1-bit flag +
  padding(size/padding bytes)，**零堆分配**。
- 父节点/大叶子：堆上 `SubtreeHeapData`（ref_count + padding/size(Length) + child_count + symbol/state + 11 个 flag +
  union{内部节点统计 / external scanner state / error char}），引用计数共享以便增量重解析。
- 公共 `TSNode` = `uint32 context[4] + id指针 + tree指针`（32B），是对 Subtree 的轻量视图，不常驻。

**对比 esbuild Go**：`Expr{Data interface(16B), Loc(4B)}` 24B wrapper + 每个 `E*` 独立堆分配（8~104B + malloc 头）。
tree-sitter 用 tagged pointer 把常见小节点压进 1 个字、零分配——这是 V8 AstNode bit_field_ / oxc boxed-enum 同路的 C 实现，
且被 tree-sitter 证明可用。**这是"去 interface 紧凑表示"在业界的成功先例。**

## 三、parse 性能对比（单线程，n=5，取中位数，重复 3 轮稳定）

| 语料 | tree-sitter parse | Go esbuild parse | TS/Go 比值 | peak RSS (TS / Go) |
| --- | ---: | ---: | ---: | --- |
| big4 (812KB, 4000 浅函数) | 999ms | 338ms | 2.95× | 61MB / 70MB |
| big40 (8.2MB, 4万浅函数) | 7232ms | 4314ms | 1.68× | 591MB / 803MB |
| **deep12k (591KB, 12000 层嵌套)** | **330ms** | **2040ms** | **0.17×（TS 快 6.1×）** | **41MB / 95MB** |

deep12k 三轮稳定：TS 329.8/336.9/329.7ms，Go 2058/2018/2045ms。

**关键解读**：
- 浅代码（big4/big40）：Go esbuild 比 tree-sitter 快 1.7–3×——esbuild 手写递归下降 + tiny allocator 在常规代码上很高效。
- **深嵌套（deep12k）：tree-sitter 快 6.1×、内存省一半**——正好命中此前发现的 Go `findSymbol` 作用域链 O(n²)
  （baselines/o2-scope-chain-found.md）。tree-sitter 的 GLR + 8B 紧凑 subtree 没有逐层爬父链的语义分析开销。
- 口径注意：tree-sitter 只做语法 CST，Go `Parse` 含符号解析/作用域绑定/lowering（工作量更大）。所以 6× 是
  "语法层紧凑表示 + 无 O(n²) 语义爬链"的综合优势，不能全归因于表示；但作为选型依据足够了。

## 四、病态案例（负面）
- gen8（19MB 大量 object 字面量）：tree-sitter JS grammar parse 单次 >120s 超时无输出（Go parse 3.4s）。
- _tsc.js：语料随 port-baseline worktree 清理已删，未测；big40 上 tree-sitter 7.2s vs Go 4.3s。
tree-sitter JS grammar 对某些真实 JS 模式（大 object 字面量）有严重性能病态——选型时需考虑 grammar 质量。

## 五、选型结论

1. **紧凑表示可行且已工业化**：tree-sitter 8B tagged-union subtree 证明"去 interface/逐节点堆对象"的紧凑 AST 能大规模工作，
   支撑 V8/oxc 同类判断。对 esbuild Go 版，这佐证了 706 处去 interface 重写方向在业界有先例——但改动成本是真金白银。
2. **tree-sitter 不是 esbuild 的替代品**：浅代码 Go 更快、gen8 病态、且 tree-sitter 只做语法不做语义/打印/tree-shaking。
   作为"编译前端语法层"选型有优势（尤其深嵌套/增量），但不能整体替代 esbuild 的单次全链路编译。
3. **对当前优化的直接启示**：深嵌套 6× 差距印证 `findSymbol` O(n²) 是真瓶颈且 tree-sitter 式布局能规避；
   若要压缩这个差距，应针对语义分析的 scope 查找做结构性优化（但此前三种缓存方案实测净亏，见 o2-scope-chain-found.md）。

## 纪律/口径
字节门不适用于本对比（用户明确"不需要逐字节一致，作选型依据"）。所有百分比绑墙钟/RSS 实测，固定 n=5 分母。
本机 1GB、deep12k 591KB，不可外推用户真实大场景。

## 信源
- tree-sitter 0.28.0 `/root/ts-compare/tree-sitter`；subtree.h 8B tagged union（lib/src/subtree.h:38-159）；api.h TSNode（:133）。
- 对比 harness `/tmp/ts-parse-bench`（C）+ `/tmp/go-parse-bench`（Go，goport-exp 内部临时，已删，0 dirty）。
- 原始输出见本轮控制台；o2-scope-chain-found.md（Go findSymbol O(n²) 发现与三种修复证伪）。
