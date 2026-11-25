# 放宽覆盖：with-scope 快路径成功；class 因字节门破坏而回退 — goport exp-declbind 第234代

日期：2026-11-25。沿上轮唯一成功主线（声明期 shadow-stack，c495a7b）扩大覆盖。
本代交付：**with-scope 副作用精确模拟并纳入快路径**（真实收益 + 字节门 + 双算断言），
**class-scope 放宽尝试因破坏字节门而诚实回退**（按"为覆盖率牺牲字节门一律不收"纪律）。

## 一、本轮新增改动（相对 c495a7b）
`fastbind.go`：
1. `fastScopeFrame` 增加 `isWith`/`withBefore`：记录每个栈帧下方 ScopeWith 数量。
2. `fastFind` 增加返回值 `insideWith`：O(1) 算出 currentScope→声明scope 路径是否穿过 with scope
   = `(top.withBefore+top.isWith) > declFrame.withBefore`，与 findSymbolSlow 爬链时置位逻辑等价。
3. `fastBindFileIsSafe`：**移除对 ScopeWith 的排除**（上轮排除项），允许 with 文件走快路径。
4. `findSymbolPure`（双算断言用）同步返回 insideWith，断言比较 ref/loc/insideWith 三者。

`js_parser.go`：
5. `findSymbol` 包装：命中快路径时若 insideWith 则精确设置 `p.symbols[ref].Flags |= ast.MustNotBeRenamed`，
   并返回 `findSymbolResult{..., insideWith}`（驱动 `MustKeepDueToWithStmt`）。
6. 两个回退守卫：`name=="arguments"`（ForbidArguments 在 visit 期动态设置，只在 findSymbolSlow 精确处理）；
   `!p.fastStackIsCurrent()`（decoratorScope 直接改 currentScope 绕开栈时回退，栈在 decorator 访问后自愈）。
7. `popScope` 加 `p.fastStackIsCurrent()` 守卫，防止无对应 push 的 pop 造成栈越界。

## 二、with-scope 收益证据（配对 A/B，parse-only，GOMAXPROCS=1，n=8）
语料：wn12k.js（with 块内 12000 层嵌套，每层引用最外层 acc，必须穿过 with scope 才能解析）。
| 语料 | base med | cand med | 比值 | CI重叠 |
| --- | ---: | ---: | ---: | ---: |
| wn3k (nested with) | 159.2ms | 62.7ms | 2.54× | — |
| **wn12k (nested with)** | **2017.7ms** | **258.1ms** | **7.82×** | 否 |
base x8 范围 [1963.3,2128.7]，cand x8 范围 [227.3,274.3]，完全分离。
斜率：3k→12k（4× 深度）base 12.56×（近二次）、cand 4.09×（线性）——with 场景同样把 O(n²) 压成 O(n)。

**这是上轮做不到的**：上轮 with 文件整体排除、全走慢路径，无任何收益；本轮 with 深链获 7.82×。

## 三、正确性门
- 全项目 `go test ./...` 在 `GOPORT_FASTSYM_VERIFY=1` 下通过 = 双算断言机器校验等价（含 with 的 ref/loc/insideWith）。
- 字节门：严格同源基线（main 9dff11c 编译）vs 候选 vs 候选+verify，with-deep3k/12k、wn3k/wn12k
  产物逐字节一致，rc 全 0，mismatch=0。
- `arguments`/decoratorScope 走慢路径回退，字节不变（设计保证 + 全测试覆盖）。

## 四、class 放宽：诚实负面结果（已回退，不收）
尝试同时移除 ScopeClassName/ScopeClassBody/ScopeClassStaticInit 排除，配合本轮副作用模拟。
结果：`bundler_tests` 的 `TestLowerUsingHoisting` 产物字节不一致（using 声明 lowering + class）。
根因：class 在 visit 期动态 `Members.Set`（innerClassName，js_parser.go:12276）并动态设置 ForbidArguments，
使 fastPush 时快照的 name 集合与实际栈分歧；双算断言只比对 findSymbol 的 ref/loc/insideWith，
无法覆盖"动态新增 member 未入栈 → 后续 findSymbol 回退慢路径"引发的连锁差异。
按纪律（为覆盖率牺牲字节门一律不收），**保留 class 排除**，main 隔离不受影响。

## 五、核心收益无回归（parse-only）
deep12k 1942.8→251.4ms（7.7×）；deep24k 7853.3→642.3ms（12.2×）——与上轮一致。
浅语料 big4 334→346ms、gen8 3433→3333ms，区间噪声内无显著回归。

## 六、下一步（未停，按序）
1. class 精确化：在 innerClassName 的 `Members.Set` 与 ForbidArguments 动态设置点同步 fastVis 栈，
   再重新放开 class 三类 scope，以 TestLowerUsingHoisting + 双算断言为门。
2. TS namespace alias 副作用（最后排除项）。
3. 内存：本轮仍是时间优化，RSS 基本持平；用户核心痛点 16G 内存尚未触及，作为独立目标跟进。

## 七、信源 / 改动清单
- 分支 exp-declbind，worktree /root/goport-declbind；main(9dff11c) 未动。
- 改动：internal/js_parser/fastbind.go、js_parser.go；台账本文件。
- 根因与选型：baselines/o2-scope-chain-found.md、baselines/treesitter-crosscompare.md、
  baselines/decltime-binding-success.md。
- 副作用代码：js_parser.go findSymbolSlow(8700+)、popScope(1276)、pushScopeForVisitPass(8670)、
  parseDecorators(6932)、visitDecorators(12198)、innerClassName Set(12276)。
