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
