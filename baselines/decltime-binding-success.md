# 声明期符号解析（shadow stack）：O(n²) 真修复首次成功 — goport exp-declbind

日期：2026-11-25。用户纠偏：缓存失败 ≠ 整条路线证伪，要求换根本手段（声明期直接绑定），
做局部可回滚原型 + 规模梯度曲线验证斜率，不抛回用户、不请示方向。本代交付：**首个把 superlinear
压成 linear 的实测成功方案**，字节门 + 双算断言 + 配对 A/B 全部通过。

## 一、根因与手段（与前四种证伪方案的本质区别）
真热点：`findSymbol` 沿 `s=s.Parent` 逐级爬链（js_parser.go:8681），每层做 with/arguments/
Members.Get/TSNamespace 四类检查。deep12k profile：`findSymbol`+`ScopeMembers.Get` 合计 84% self-time。

此前四种全败：表示层706处、Green Tea、Go arena、算法级缓存（map版 + 固定64槽 + 动态slice + 单槽）。
缓存败因：在"每层爬链"算法上打补丁，写入/内存成本 ≥ 爬链节省，且只在合成极端语料有效。

**本方案从根上消除爬链**：visit pass 按 scope 树严格 DFS 进出（`pushScopeForVisitPass`/`popScope`），
维护全局 `name → []*Scope` 遮蔽栈——当前 DFS 路径上声明该 name 的 scope，最内层在栈顶。
`findSymbol` 取栈顶 scope 的 `Members.Get(name)` 即 O(1)：
- 存储 O(总声明数)：每个 member 压栈一次弹栈一次，**不是**每 scope 一个完整 map（那才是 O(N²) 内存）；
- 存 scope 指针而非缓存 ref，后续 `Members.Set`（如 unbound 合并）自动可见，无失效问题；
- 进入/退出栈由 visit pass scope 生命周期驱动，惰性初始化从 currentScope.Parent 链重建初始路径。

## 二、正确性护栏
1. **安全文件才启用**（fastBindFileIsSafe）：排除含 with / class scope（ForbidArguments 在 visit 期才设、
   inner-class member）/ TSNamespace 的文件，以及所有 TS 文件；这些文件 100% 走原爬链，字节不变。
2. **未命中回退**：name 不在遮蔽栈顶（unbound 等）→ 原 `findSymbolSlow`。
3. **双算断言**（`GOPORT_FASTSYM_VERIFY=1`）：每次 O(1) 命中同时跑无副作用纯爬链比对 ref/declareLoc，
   不等即 panic。全项目 `go test ./...` 带断言通过 = 机器校验的等价性证明。
4. **字节门**：严格同源基线（9dff11c 干净编译）vs 候选，5 语料（deep3k/deep12k/big4/big40/gen8）
   `--bundle --minify --format=esm` 产物逐字节一致，rc 全 0。gen8 产物 16,244,686 B 一致（非 0 输出）。

## 三、量级证据（配对 A/B，GOMAXPROCS=1，n=8，固定 outfile，wall 中位数）
### 完整构建（CLI）
| 语料 | 规模 | base wall | cand wall | 比值 |
| --- | --- | ---: | ---: | ---: |
| deep3k | 3000 层嵌套 | 200ms | 90ms | 2.22× |
| **deep12k** | **12000 层嵌套（4×）** | **2145ms** | **370ms** | **5.80×** |
| big4 | 4000 浅函数 | 415ms | 450ms | 1.08× (重叠) |
| big40 | 40000 浅函数 | 4770ms | 4525ms | 0.95× (重叠) |
| gen8 | 19MB object字面量 | 3395ms | 3635ms | 1.07× (重叠) |

**斜率归因（关键，避开 CST/语义工作量绝对差）**：深度 3k→12k（4×）
- base：4× 深度 → **10.72×** 时间（superlinear，介于线性4与二次16之间）
- cand：4× 深度 → **4.11×** 时间（**线性**）
→ O(n²) 被压成 O(n)。CI：base deep12k [2110,2170]、cand [330,430]，完全分离无重叠。

### parse-only（直接调 js_parser.Parse，排除 linker/print）
| 语料 | base/parse | cand/parse | 比值 |
| --- | ---: | ---: | ---: |
| deep3k (n=20) | 159.8ms | 55.4ms | 2.88× |
| deep12k (n=5) | 2147.6ms | 266.6ms | **8.06×** |
| big4 (n=5) | 316.4ms | 356.8ms | 0.89× (略慢) |

CPU profile（deep12k，parse-only）：
- BASE：`findSymbol` flat 4.67s(43.5%) + `ScopeMembers.Get` flat 4.39s(40.9%) = 84% self-time 在爬链。
- CAND：findSymbol 消失（不在 top10），最高 flat 是 `runtime.memmove` 15%；总 samples 10.74s→1.33s。

## 四、诚实边界
- 收益只在深嵌套（每层引用外层变量）语料显著；浅函数/大 object 语料无收益、建栈固定开销使 parse-only
  big4 略慢 ~13%（CLI 构建口径被噪声淹没、区间重叠）。这是算法针对性优化的预期，非退化。
- deep12k 是合成极端；真实项目嵌套分布未知、不外推（延续此前纪律）。本代只证明"从根上消除爬链
  能把 superlinear 压成 linear 且不破坏字节"，不宣称真实 16G 场景收益。
- 当前实现仅对无 with/class/TS 的 JS 文件启用（纯 JS 子集）。覆盖更广需处理 decoratorScope 跳转、
  TS namespace alias 等副作用——属后续扩大范围，本原型不冒进。

## 五、改动清单（可回滚）
- `internal/js_parser/js_parser.go`：parser struct +5 字段；`findSymbol` 改名为 `findSymbolSlow` 保留原逻辑；
  新增 `findSymbol` O(1) 包装；`pushScopeForVisitPass`/`popScope` 各加门控的 fastPush/fastPop。
  共 +47 行（git diff 9dff11c）。
- `internal/js_parser/fastbind.go`（新增）：遮蔽栈实现 + 安全判定 + 纯爬链校验函数。
- 分支 `exp-declbind` @ 独立 worktree /root/goport-declbind；main(9dff11c) 未动。

## 六、信源
- 根因定位：baselines/o2-scope-chain-found.md（第227代，findSymbol O(n²)）。
- 选型启示：baselines/treesitter-crosscompare.md（tree-sitter deep12k 快 6.1×，命中本盲区）。
- profile：/tmp/cpu-base-deep12k.prof、/tmp/cpu-cand-deep12k.prof。
- A/B 原始数据：本轮控制台输出（deep3k/deep12k/big4/big40/gen8 × base/cand，n=8）。
- 代码：internal/js_parser/js_parser.go:8681 findSymbol；:8656 pushScopeForVisitPass；:1215 popScope；
  internal/js_parser/fastbind.go 全文。

## 七、追加验证（同代继续推进，checkpoint 后）
### 回退路径字节门（with/class 文件禁用快路径）
构造 deep3k-with.js（外层 with 块）、deep3k-class.js（顶层 class），严格基线 vs 候选 vs 候选+双算断言：
产物 BYTE-IDENTICAL，rc 全 0 → 不安全文件 100% 走原 findSymbolSlow，改动对它们零影响。

### 深度外推梯度（parse-only，确认线性趋势保持）
| 语料 | 深度 | base/parse | cand/parse | 比值 |
| --- | ---: | ---: | ---: | ---: |
| deep3k | 3000 | 159.8ms | 55.4ms | 2.88× |
| deep12k | 12000 | 2147.6ms | 266.6ms | 8.06× |
| **deep24k** | **24000** | **8145.7ms** | **474.3ms** | **17.2×** |

斜率（parse 中位数）：
- base：3k→24k（8× 深度）→ **50.97×** 时间（近二次64×，坐实 O(n²)）；12k→24k（2×）→3.79×
- cand：3k→24k → **8.56×** 时间（线性8×）；12k→24k（2×）→1.78×
- 收益随深度单调放大：8.1× (12k) → 17.2× (24k)

证据：/tmp/deep24k.js（1.16MB）、/tmp/deep3k-{with,class}.js；/tmp/pb-{base,cand} parse-only harness。
