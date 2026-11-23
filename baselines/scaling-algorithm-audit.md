# 算法级 superlinear 热点审计（第227代）— 结论：无 O(n²) 可攻，表示层天花板坐实

日期：2026-11-23。用户反复点顶层/算法级方向。用 big4(796KB/4000组) vs big40(8.2MB/40000组) 10× 规模
的 CPU profile（`/tmp/cpu-big4.prof`、`/tmp/cpu-big40.prof`，go tool pprof）找真正 superlinear 热点，
不靠读代码猜。**纯取证，worktree 0 dirty。**

## 规模归一化（单次构建；big4 总 1.13s/3≈0.38s，big40 总 15.99s/3≈5.33s，≈14×）

| 函数 | big4 单次 | big40 单次 | 增长倍率 | 判定 |
| --- | ---: | ---: | ---: | --- |
| runtime.memclrNoHeapPointers | 0.05s | 2.85s | ~57× | GC 清扫组合效应，非算法 |
| runtime.growslice (cum) | ~0 | 3.41s(21.3%) | — | 分配量线性+扩容，见下 |
| visitExprInOut | 0.05s | 0.43s | ~8.6× | 亚线性 |
| parsePrefix | 0.04s | 0.16s flat / 1.75s cum | — | 线性 |
| visitAndAppendStmt | 0.03s | 0.31s | ~10× | 线性 |

**无函数呈真正 O(n²)**（超 14× 且随规模持续恶化）。`memclrNoHeapPointers` 的 57× 来自
mallocgcLarge + mspan.initHeapBits（大对象清零），是分配量与堆增长的组合，不是某段算法。

## growslice 深挖：M2-d 预分配已砍 47%，剩余是合成语料密度极端

- growslice 调用者 top：parsePrefix 0.66s / appendPart 0.54s / newSymbol 0.41s / pushScopeForParsePass 0.37s。
- 对比 pristine(733da4e)：growslice cum **6.43s → 3.41s（M2-d 预分配省 47%）**——M2-d 预分配有效。
- big40 符号密度 1/19 字节（M2-d 公式按真实 _tsc.js 的 /110 调，密度高 5.8×）、scope 1/26 字节（/157，高 6×）。
  继续调常数 = 过拟合合成代理（比例微调禁令），真实语料上 /110//157 已近最优。
- `CloneLinkerGraph`(graph.go:155-175)/`appendPart` 的拷贝是每文件一次的线性操作，非 O(n²)。

## Go vs TS 的 O(n²) 差异（先验确证，不套用）
Go `pushScopeForVisitPass`(js_parser.go:8656) = `p.scopesInOrder = p.scopesInOrder[1:]`（O(1) 切片推进），
**不是** TS 侧 R6 的 `shift()` O(n²)。TS 的 1.53× 大构建胜利是移植引入的缺陷，Go 原版没有——不能照搬。

## 收敛结论（单一推荐）
算法级这条唯一可能量级翻身的路，用规模 profile 证伪：**Go 侧无 O(n²) 热点，全部线性或亚线性**；
M2-d 已吃掉预分配收益的 47%；其余 superlinear 假象是 GC 清扫组合效应。表示层（Scope/Expr/Symbol）单靶
实测均 <1~6%、合用 ~17% 需 706 处 Expr 大改；Green Tea 实测负向；Go arena 不可用。
**在给定约束（1:1 字节门、不改语义、合成代理、1GB 机器）下，"大幅度"没有可达路径。**

可确定的部分（绑探针字节+固定分母 594MB）：Scope 56B 死字段(32万全0)/Expr 去interface真实-31.1%子集/
Symbol 16B 死字段(44万全0)/buffer 1:1 线性/无 O(n²)。全部不可外推真实大场景。

**推荐**：停止在合成代理上找量级路径（平台期无新信息，四路已穷尽）；若用户仍要压内存，
唯一可能产生量级信息的是完成 Expr 去 interface 706 处真实改造并过门（把所有增量合用推过 10%），
但这是高风险大改、且无量级先验证据支持。在此之前不做无证据的局部小改。

证据：`/tmp/cpu-big4.prof`、`/tmp/cpu-big40.prof`、`/tmp/cpu-big40-pristine.prof`；
`/tmp/alloc-big40.prof`；js_parser.go:8656（O(1) 推进）；graph.go:155-175（线性拷贝）。
