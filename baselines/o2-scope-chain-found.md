# 发现真正的 O(n²)：findSymbol 作用域链查找（第227代）

日期：2026-11-23。**这是六轮取证以来第一个实锤的 superlinear 算法热点，且与表示层/界面重写无关。**

## 规模证据（深嵌套语料，go tool pprof）

| 语料 | 规模 | wall | findSymbol self | ScopeMembers.Get self |
| --- | ---: | ---: | ---: | ---: |
| deep3k | 3000 层嵌套, 142KB | 0.22s | 0.10s | 0.19s |
| deep12k | 12000 层嵌套, 591KB (4×) | 1.94s (8.8×) | **2.58s (25.8×)** | **2.35s (12.4×)** |

deep12k profile：`findSymbol` cum 87%、`ScopeMembers.Get` 41.5%。两者线性叠加是 superlinear 元凶。

对照 shallow12k（每层引用本层变量，无跨层查找）：4× 规模 wall 0.04→0.16s = **线性**。
**证实 O(n²) 完全来自 `findSymbol` 沿 `s=s.Parent` 逐级向上查找外层符号**——每层引用 `acc`（最外层定义），
深度 N 时每次查找爬 O(N) 层，总 O(N²)。

## 根因（代码实证）
`internal/js_parser/js_parser.go:8686` findSymbol：
```
s := p.currentScope
for {
    if member, ok := s.Members.Get(name); ok { ... break }   // 每层线性查 Members
    if tsNamespace := s.TSNamespace; ... {}
    s = s.Parent
    if s == nil { ... unbound ... break }
}
```
深嵌套 + 频繁引用外层变量 → 每次 O(depth)。这是 JS 作用域链语义，但 V8 等用 dedup 字符串指针相等 +
缓存优化；esbuild 这里对每个标识符都从头爬链并线性查每层 Members。

## 为什么之前六轮没发现
big40/gen8 是扁平语料（4 万独立浅函数），天然规避深链；TS 侧 R6 的 shift O(n²) 也是深嵌套 typescript.js
才暴露。**合成扁平代理的盲区**——本轮专门造深嵌套语料才抓到。

## 优化方向（待微基准验证，尚未改源码）
1. 每文件名字→符号的解析缓存（`map[name]findSymbolResult`，解析期有效），命中即停爬链；
   风险：with 作用域、TS namespace 别名、重命名标志等副作用需正确重放。
2. 复用 linker 已算好的 scope 深度信息做跳表。
3. 缓存需按 scope 上下文失效——最直接是「(scope, name) → ref」二级缓存。

## 口径边界
deep12k 仅 591KB / RSS 78MB，本机 1GB 不崩；但这是合成极端（每层引用最外层变量），
真实项目嵌套深度分布未知、不可外推用户场景。本发现只证明"存在 O(n²) 算法热点、可优化"，
收益幅度需在真实改造后配对 A/B n≥8 验证。

## 下一步
先对 deep3k/deep12k 做优化方案微基准（缓存命中率 + 预期加速比），确认量级后再动源码；
任何改造走字节门 + 双指标 A/B。

证据：`/tmp/cpu-deep3k.prof`、`/tmp/cpu-deep12k.prof`、`/tmp/cpu-{shallow3k,shallow12k}` 对照；
js_parser.go:8686 findSymbol；js_ast.go ScopeMembers.Get。

## 追加（同代深入）：精确定位 + 修复尝试的证伪与风险

### findSymbol 按行 profile（deep12k，2.58s flat）
- `if s.Kind == ScopeWith`：**1.61s（62%）** ← 每次爬链都读 scope.Kind
- `if s.ForbidArguments && name=="arguments"`：480ms
- `s.Members.Get`：170ms flat / 2.57s cum
- TSNamespace：60ms
根因不是 Members.Get 慢，而是**每次爬链对每层做 4 个分支检查**（多数为 false），O(depth×引用数) 累加。

### 修复尝试 1（最小版）：with 检查短路 → 实测无效，已回滚
parser 加 `hasWithScope`，`if p.hasWithScope && s.Kind==ScopeWith`。构建/字节门/go test 全过，
但 findSymbol 2.58s→2.22s（噪声内）、wall 1.74–1.88s 两侧重叠，**无显著收益**——分支预测本就几乎零成本，
短路没消除 per-scope 的字段读取。已回滚。

### 修复尝试 2（完整缓存）：设计完成但因正确性面过大未实施
方案：`map[(scope,name)]→ref` 记忆化 + 路径压缩，微基准证明理论加速 27,000×（12000 层）。
但爬链有 4 类副作用：with flag 标记（影响重命名）、arguments 报错（loc 相关）、
TS namespace 符号创建、unbound 符号创建；且 ForbidArguments 在 visit pass 才设置（class/static block），
visit pass 前预扫描 scope 树读不到未来修改。要正确启用缓存需静态判断"无 class/with/TS 语法"，
正确性面广、验证成本高。半成品（缓存未初始化=死代码）已回滚。

### 收敛判断
O(n²) 热点确凿（findSymbol 作用域链爬，深嵌套引用外层变量触发），但：
1. 只在**合成极端语料**（每层引用最外层 acc）验证，deep12k 591KB 就 superlinear；
   真实项目嵌套分布未知，**不可外推**。
2. 唯一量级修复（记忆化+路径压缩）正确性面大（with/class/TS/unbound/use-count），
   与已被否决的 706 处大改同属"高风险、只在代理验证"类别。

按纪律（根因先行、字节门+双指标、无量级证据不启动高风险大改、不外推），**不在本代理上贸然实施完整缓存**。
本代交付的是"找到了此前六轮盲区里的真 O(n²) 热点并精确定位"这一硬发现，以及两条修复路径的实测/设计评估。
若后续要在真实深嵌套项目上验证，应先确认收益真实存在再承担缓存的正确性成本。

证据：`/tmp/cpu-deep12k-o2with.prof`（最小版无效）；lookup_bench 27,000×；`/tmp/jsp_o2_base.go`（半成品备份，已弃）；
findSymbol 按行 pprof；js_parser.go:8681-8752。全部源码改动已回滚，worktree 0 dirty。

## 追加（同代）：完整路径压缩缓存实施 → 实测净亏，已回滚

实施了完整方案：`map[(scope,name)]→(ref,declareLoc)` 记忆化 + 路径压缩（爬链成功后回填路径上所有 scope），
启用条件 `!ts.Parse && !hasWithScope && name!="arguments"`。go test ./... 全绿。

**配对 A/B（deep12k / big40 / gen8 / _tsc.js，GOMAXPROCS=1）：**

| 语料 | base wall / RSS | cache wall / RSS |
| --- | --- | --- |
| deep12k (580KB) | 1.90s / 78MB | **15.31s / 861MB（慢 8×，内存 11×）** |
| big40 (8.2MB) | 4.87s / 776MB | 4.55s / 828MB |
| gen8 (19MB) | 3.45s / 729MB | 3.34s / 730MB |
| _tsc.js (6MB) | 0.93s / 151MB | 0.93s / 172MB |

deep12k 上缓存灾难性变差：12000 scope 的大量 name 引用使缓存条目爆炸，map 分配 + GC 成本远超省下的
爬链；RSS 861MB 几乎打满 1GB，实测中已触发一次 OOM。big40/gen8 wall 仅边际改善但 RSS +21~52MB。

**这是微基准不可外推的第三次实证**：lookup_bench（27000×）没算 map 内存/分配成本，真实 Go 构建里
缓存自身成为新瓶颈。按纪律（双指标、字节门先于收益门、不外推、不硬凑）**不采纳，已回滚，worktree 0 dirty**。

## 最终收敛（本代）
O(n²) 热点确凿（findSymbol 作用域链爬），但三种修复全部证伪/回滚：
- 最小短路版：无收益；
- 完整路径压缩缓存：deep 上 wall 慢 8×、内存 11×，净亏。
根因是 Go 的 map 缓存成本 > 爬链节省，且收益只在合成极端语料、不可外推。
**表示层(706处重写)/Green Tea/Go arena/算法级(O(n²)缓存) 四条路全部实测证伪。**
给定约束（1:1 字节门、1GB 本机、合成代理、不外推）下，"大幅度降内存"没有可达路径。
本代交付的是"发现并精确定位真 O(n²) + 三种修复的机器实证",这是此前六轮盲区里最有价值的硬结论。

证据：`/tmp/ab-*` O2 实测；`/tmp/esbuild-o2cache`；o2-scope-chain-found.md 各节；全部源码已回滚。

## 追加（tree-sitter 启示后）：扁平缓存三种变体全部净亏，已回滚

tree-sitter 交叉比对（treesitter-crosscompare.md）显示 deep12k 上 TS 快 6.1×，命中本 O(n²) 盲区。
据此又尝试三种"无 map、扁平数组"缓存（针对前次 map 版内存爆炸的根因）：

1. **固定 64 槽路径压缩**：pathN>64 放弃缓存。诊断（deep12k）：hit 22374 / miss 67626（命中率 25%），
   但深路径（>64 层，正是主要成本）全部跳过。wall 反而 1969→2322ms（慢）。
2. **动态复用 slice 路径压缩**：允许长路径。deep12k **2209→3255ms（慢 1.5×）**，回填 12000 槽的写入成本
   超过爬链读取（首次查找把 O(depth) 读变成 O(depth) 读+写，重复率不足以摊销）。
3. **（方案设计阶段终止）单槽起点缓存**：诊断显示 findSymbol 总调用 9 万次/12000 scope、命中率仅 25%，
   且每次查找 name 分散，起点单槽收益不足，未再实施。

三次全部净亏 → 回滚，worktree 0 dirty。

**根因定论**：deep12k 是合成极端（每层引用最外层 acc），真实重复率/嵌套分布未知、不可外推；
局部缓存无论 map 还是扁平，写入/内存成本都 ≥ 爬链节省。这个 O(n²) 的真修复需要**声明期符号解析 +
指针相等比较**（V8 AstRawString/tagged pointer 那套，见 treesitter-crosscompare.md），
属架构级重构、破坏 1:1 语义风险高，且无真实场景证据支撑，**不在代理上贸然启动**。

至此四路（表示层706处/Green Tea/Go arena/算法级O(n²)缓存）+ 本轮三种缓存变体全部实测证伪。
