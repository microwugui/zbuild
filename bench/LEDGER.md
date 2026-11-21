# 性能优化实验台账（阶段0 起）

决策规则（写死）：**字节等价 ∧ 统计显著 ∧ 门不回退** 三者全满足才采纳；
否则回滚并记账，负结果照记。CI 含 1.0 一律不算赢。

**决策主指标（第166代重锚）= 冷 CLI 配对 A/B（`bench/wall.py`）**：每个被测样本都是一次冷子进程
（含 Node 启动 + `--experimental-strip-types` 类型剥离 + V8 冷 tier），这才是用户对标的 22×
（Go 0.2194s 也是冷静态二进制）。立项线 = **冷 CLI 总量降幅 ≥10%**。
进程内预热交叉 A/B（`ab_worker.ts`/`ab_orch.ts`）**降为辅指标**（只覆盖稳态 ~1.86s，
约为冷 CLI 的 40%，不能当立项门槛）。正确性门=宽差异语料 + 覆盖夹具逐字节。
为什么重锚：主指标只量 `run()`（预热后），漏掉冷 CLI 中模块加载 ~0.57s + 首轮低 tier 执行
~4.1s 里的大头；R1 主指标 1.3758 而冷 CLI wall 仅 1.1595 就是证据。[^1][^2][^14]

## 基线锚点

| 项 | 值 |
| --- | --- |
| 代码提交（基线锚点） | `d1e4942696e926b9fe601de817e1bdefdfa13cad`（stage0：守卫 + bench 底座 + 台账） |
| 冻结基线 | `/root/port-baseline` 以 `git worktree` 锚到 `d1e4942`，`src` 树与 port `diff -rq` 应为空 |
| three.module 输入 | sha `104f5614…e341`，658900 B；产物 `2985154b…cda9b4`，1709893 B |
| Node / 核数 | v22.23.3；2 核 VM；`GOMAXPROCS=1`，无后台负载 |
| 测量噪声地板 | 相同代码空自测 |speedup−1| 实测 ~3%（v3.1 0.9664 / v3.2 1.0330，方向会翻转；成因未确证） |

## 冷启动分解表（第166代 b) 机器证据，一项一行）

冷 CLI 口径：three.module，候选 ~4.96s（5 次 4.64/5.06/5.19/4.95/4.96），Go 0.311s。

| 项 | 毫秒 | 来源 | 结论 |
| --- | ---: | --- | --- |
| Go 冷跑（对标） | 311 | 7 次中位 `/tmp/esbuild-go` | TS/Go 冷比 ~15–17×（core 16.9×、_tsc 14.3×）|
| 模块加载 + 类型剥离 | ~570 | `await import(bundle_multi.ts)` 3 次 0.55–0.61s | 41 模块 / 1.5MB，无未用子系统 |
| 首轮 bundle（冷） | ~4114 | warmup 曲线 run0 | 稳态 run5=1864ms，冷/热 2.2× |
| 稳态 bundle（预热） | ~1864 | warmup 曲线 run5 | 主指标只量这一段 |
| TurboFan 贡献 | ~3700 | `--no-opt` 8.65s vs default ~4.96s | 优化器在首轮内即生效 |
| `--jitless` | N/A | `ERR_WEBASSEMBLY_NOT_SUPPORTED` | 本环境不可运行，边界未测到 |
| `--maglev` / `--stress-maglev` | ~4880 / ~5110 | 3 次中位 | ~1.6% / 更差，噪声内 |
| `--no-lazy-feedback-allocation` / `--max-opt=8` | ~4950 / ~4920 | 3 次中位 | 无 ≥10% 收益 |
| `NODE_COMPILE_CACHE` | 4880/4850/5050 | 3 次热缓存 | 只否证编译缓存一法 |
| 预编译单文件 .mjs（esbuild bundle） | 4900–5320 | `run-bundled.mjs` 3 次 | 不比现状 4.96s 快 → 构建层打包无收益 |
| GC | ~528（10.07%） | after-r1 profile | 分配点分散、单点 ≤2.2% |
| deopt 分段 | 112→14→4→2→0→1 | trace-deopt 6 轮 | 纯预热一次性，稳态无 deopt |

**口径纠错**：`NODE_COMPILE_CACHE` 无改善**只否证「编译缓存」这一机制**，
不能推出「冷启动是 JIT tiering」，更不能推出「冷启动不可由局部代码改动消除」。
`--no-opt` 显示优化器首轮即贡献 ~3.7s，故「首轮在低 tier 执行」有机器证据，
但**冷启动的内部机制仍未确证**，以上表为准，禁止再写断言式归因。[^15]

## 轮次记录

### R0 — 阶段0 仪表落地（纯仪表，不改产物行为，可回滚）

**改动**：驱动加 `_invoked` CLI 守卫（`bundle_multi.ts`/`bundle1.ts`，两侧逐字节相同）；
基线 worktree 同步同守卫。守卫正则修正：`bundle_?(multi|1)`（首版漏匹配 `bundle1.ts`，见下）。[^3]

| 实验 | 工具/sha | 测量 | 决策 |
| --- | --- | --- | --- |
| v1 空自测 | `ab-v1.ts` | 0.9418，CI 不含 1，误判 FASTER | **弃用**：方向反 + 伪配对 + GC 共振[^4] |
| v2 空自测 N=24 | `ab.ts` v2 | 0.9641 / 0.9572，误判 SLOWER | **弃用**：树级加载顺序偏置无法在实例级抵消[^5] |
| v3.1 空自测 | `ab_worker.ts`+`ab_orch.py` | 0.9664，`NOT_SIGNIFICANT`（效应<5%地板） | 发现预热顺序根因[^6] |
| v3.2 空自测（预热随 import 顺序） | 同上 | 1.0330，`NOT_SIGNIFICANT`；方向翻转 | **采纳 v3.2**：方向翻转只证明存在未消除的首/次执行顺序效应；~3% 按噪声处理，**不宣称已确证环境漂移**[^7] |
| 宽差异对齐 | `align.py`+`align_worker.ts` | 448 条：440 PASS + 8 PASS_BOTH_ERROR（真 parse failed），0 BYTES_DIFFER/EMPTY/WORKER_FAIL，559 s | **采纳门**：候选 vs 基线逐字节一致[^8] |
| three 代理对齐 | 同上 | 5/5 PASS，66 s | 代理组与 wide 门分开[^9] |
| wall 空自测 | `wall.py` | n=20：speedup 0.9878，CI[0.9607,1.031]，`NOT_SIGNIFICANT`，bytes True；另 n=12：0.9989，CI[0.9777,1.0339]，out `2985154b…` | **采纳辅指标**（已加 EMPTY_OUTPUT 硬门）[^10] |
| bundle1 守卫回归（负结果） | `src/bundle1.ts` | three_verify core 0 B / `e3b0c442…` | 改 `bundle_?(multi|1)` → core 恢复 `c0fdbed2…`[^11] |
| 门校验（修正后） | — | three_verify core `c0fdbed2…` + module `2985154b…` 逐字节；tsl/webgpu 首差 2431/15159 为 HEAD 既有；tsc 166 | **门不回退**[^11] |
| 阶段1 profile | `profile_run.py` | self-time：parse/lex 36.5%、other 16.7%、encode 14.5%、print 12.9%、GC 12.8%、treeshake 5.2%、renamer 1.3%；GC 138 次 Scavenge / 411 ms | **记账**，非优化决策[^12] |
| 阶段1 inclusive | `analyze_inclusive.py` | bundleWithImports 77.7%、parseFile/Parse 46.9%、printOne/Print 24.0%；parseStmt 33.5%、parseFn 27.3%、printStmt 23.6% | **顶层地图**：parse+print 占 bundle 主链约 9 成；大优化优先这两条[^13] |

**R0 结论**：测量底座已建立并诚实校准（噪声地板 ~3–5%），产物行为零改动。

### R1 — 阶段2 首个结构性优化：打印器 encodeInto + 可增长 Uint8Array（**已采纳**）

**假设卡片 A（采纳）**：打印器逐片段编码是 encode 成本主源。
- 靶成本：encode 占 self-time 14.5%，其中 **10.76% 记在打印侧**、4.49% 解析侧；GC 12.8% 独立、无法挂阶段（`bench/cost-attribution.json`）。
- 机制：`printer.print(text)` 每次 `TextEncoder.encode(text)` 分配一个 Uint8Array；`printBytes` 再逐字节 `js.push(c)` 进 `number[]`。实测 three.module 输出 1.71MB 触发 **744,311 次 encode（445 次/KB，平均 6.4B/次）**、149,303 次 decode。
- 改法：`js: number[]` → 可增长 `Uint8Array`（OutBuf，保留 `.length` getter 与 `.at()`）；`print` 改 `encoder.encodeInto` 直写；`printBytes` 用 `set` 批量追加；lineLength 用 `lastIndexOf(0x0a)`。字节语义不变（同一 UTF-8 编码器）。
- 预期 ≥10%；破字节条件：孤立代理项处理差异 / 扩容偏移错 / lineLength 错。

**假设卡片 B（当场证伪，删除）**：parse 对同一子树跑两趟。
- 计数证据：`parseFile` 仅由 `load` 在 `byAbs` 去重后调用一次（`src/bundle_multi.ts:133`），`Parse` 每文件一次（`src/bundle_multi.ts:58`）；parser 内部 visit+lower 与 Go 同构。驾驶层无重复 Parse，不立项。

| 手 | 输入 | speedup | 95% CI | verdict |
| --- | --- | ---: | --- | --- |
| 主-1 | three.module（bundle_multi） | 1.3758 | [1.3407,1.4136] | SIGNIFICANT_FASTER |
| 主-2 | three.core（bundle1） | 1.3156 | [1.2735,1.3455] | SIGNIFICANT_FASTER |
| 主-3 | `_tsc.js` 5.9MB（bundle1，非 three） | 1.3755 | [1.3229,1.4657] | SIGNIFICANT_FASTER |
| 辅 | three.module end-to-end wall | 1.1143 | [1.0844,1.1425] | SIGNIFICANT_FASTER |

字节：three.core `c0fdbed2…`、three.module `2985154b…` 与 Go 逐字节；wide 子集 100/100 PASS；
**全量 448 条：440 PASS + 8 PASS_BOTH_ERROR，0 BYTES_DIFFER/EMPTY/WORKER_FAIL（591.3s）**；
**覆盖缺口夹具 48/48 相等**（8 fixture × 6 选项：ASCIIOnly / MinifyWhitespace / LegalComments / AddSourceMappings / Unicode / 非 BMP / 孤立代理项 / CRLF）。
门：tsc 166、m1 4158≥4157、assign 0、doc OK、test:cov 1746 pass / 10 基线 F64、three_verify core/module 逐字节。
**决策：采纳**（三手同向 + 字节等价 + 门不回退）。代码 sha `74437a3b…`（js_printer.ts），提交 `db0f7da501f9d13b96085dbd62a3ae060adfada9`。

### 审计：基线产物 vs Go 0.28.2（此前只测过自洽）

55 例（50 wide 分层 + three 5 入口）：**31 相等、9 Go 空输出、9 Go 报错、6 双方不同**（含 3 three 已知未收敛）。
- 9 条 Go 空输出：Go tree-shaking 丢弃无导出/无副作用片段；TS 单文件驱动未开 treeShaking（既有）。
- 9 条 Go 报错：JSX loader / import attributes / package.json type 等 CLI 配置差异。
- 6 条双方不同：3 条 three tsl/webgpu/nodes（已知 2431/15159 首距）；3 条边界语义（`x;0&&(()=>{});(()=>{})()`、`export default function(){}`、`undefined=1`）。
- **结论**："产物等价"目前只在「候选==基线」意义成立；「基线==Go」在宽语料上不成立，属既有保真缺口，单独立项，不阻塞本次采纳。

### R2 — 取证完成，结论：**当前证据不支持 ≥10% 靶，不立项**

R1 后重跑 profile（`bench/profile-after-r1.json`、`bench/cost-attribution-after-r1.json`）：
- encode 14.5% → **6.88%**（打印侧 10.76%→3.05%；解析侧仍 4.58%）；GC 12.8% → **10.55%**；wall 6.24s → **5.4s**。
- 现 self-time：parse-lex **42.01%**、other 19.79%、printing 14.95%、GC 10.55%、encode 6.88%、treeshake 4.75%。

**parse 内部摊开**（`bench/profile-inclusive-after-r1.json`，top250 self 汇总）：
parse-* 18.73% + visitor 12.25% + lexer 8.52% + utf16/decode 7.50%；单函数 self 最高
`visitExprInOut` 4.6%、`Next` 4.3%、`appendPart` inclusive 16.3%（self 仅 1.1ms）。

**分配侧证据（`--heap-prof`，8KB 采样，`bench/heap-attribution-8k.json`）**：
- `compileSourceTextModule` 38.97% 是模块加载固定开销（非 bundle 工作）。
- bundle 期分配分散：`step@lexer` 2.17%、`parseStmt` 1.6%、`printExprInner` 1.52%、`String` 1.48%、
  `set` 1.46%、`[Symbol.hasInstance]` 1.38%、`parseSuffix` 1.35%、`Next` 1.15% —— **无单点 >2.2%**。

**JIT 证据（`--trace-deopt`）**：123 次 deopt，主因 **58 次 "Insufficient type feedback for generic
named access"**（AST 多形状属性访问）+ 10 次 "wrong map"（`Loc`），集中在 `Parse`/`Next`/`Loc`/`Raw`。

**卡片 A（GC 分配）→ 不立项**：GC 总量仅 10.55%，需消掉几乎全部才能换 10% 总量；
分配点分散、单点 ≤2.2%。做局部减分配预期 <3% 总量，按规则不立项。

**卡片 B（对象形状 / deopt）→ 暂不立项**：deopt 主因是 AST 多形状属性访问与 `Loc` wrong-map，
但 deopt 多发生在预热早期；要证明它能换 ≥10%，必须量到**稳态**（预热后）仍占 parse ≥25% 的样本。
- 证伪方式：在预热后重置 deopt 计数或分段采集，统计 `Next`/`visitExprInOut` 稳态 deopt 频率与
  重编译样本占比；若 <15% 则删除本卡。
- 破字节条件：任何 AST 形状 / 打印改动都必须候选==基线字节（全量 align + 48 夹具）。

**卡片 B 已证伪（deopt 分段计数）**：同一进程连续 6 次 bundle，deopt 次数
**112 → 14 → 4 → 2 → 0 → 1**，纯预热一次性；主指标已含预热，稳态几乎无 deopt → 删卡。

**decodeRune 假靶**：`decodeRune` 每次返回 `{r,width}`（`src/internal/logger/bytes.ts:80`），但 heap profile 中
**无任何 decodeRune / bytes.ts 分配样本** → V8 已标量替换，无需改（避免了一次凭印象的无效改动）。

**冷启动发现（口径级，重要）**：同进程连续 6 次 = **4114 → 2229 → 2026 → 1870 → 1786 → 1864 ms**。
CLI 单次 ~4.7s ≈ 冷 run0 4.1s + 模块加载 0.57s；主指标（预热后 ~1.8s）**不代表 CLI 体感**，
这也解释了 R1 主指标 1.3758 而 wall 仅 1.1143。`NODE_COMPILE_CACHE` 实测无改善
（4.88/4.85/5.05s）→ 冷启动是 JIT tiering，不是模块编译缓存能解决。

**R2 决策：不立项**。现有证据下无 ≥10% 的稳态单点改动能通过主指标；冷启动不可由局部代码改动消除。
下一轮若继续，应把「CLI 冷启动」作为独立课题（口径/构建层），或做更大的 parser 表示级重构（非单点）。

> 度量口径（自本轮起）：每个实验至少三手 —— three.module + three.core + 一个非 three 大输入；三处同向才算赢。wide 全量留收口，单次实验跑 100 条代表性子集（记 `subsetIds`）。

### R3 — 删除死 `lineLength` 更新 → **回滚并记账（负结果）**

取证：`lineLength` 在 `src/**/*.ts`（含测试）**只写不读**（`currentLineLength` 自行回扫缓冲，
`src/internal/js_printer/js_printer.ts:930`）；`print`/`printBytes` 里每次调用的 `subarray` +
`lastIndexOf` 是纯死工作。改码删除之，tsc 166、字节 `2985154b`/`c0fdbed2` 不变。

冷 CLI 增量对比（基线=`/root/port-r1` @ db0f7da，候选=删除死代码）：three.module冷跑
**speedup 1.0415（快 4.15%），CI 不含 1，bytesEqual=true**（`bench/wall-r3-module.json`）。
虽显著但远低于立项线 **10%** → **按规则回滚**（`git checkout -- js_printer.ts`），
tsc/字节复原。记负结果：真实但 <10% 的收益不采纳。[^16]

### R4 — 给 AST 加数值 kind 判别、把 instanceof 链换成数值分派 → **回滚并记账（负结果）**

追回第 167 代自己提出却未验证就放弃的「顶层结构线索」：`visitExprInOut`
（`src/internal/js_parser/js_parser.ts:2002`）用 `instanceof js_ast.E*` 长链分派，`EIdentifier` 要过 10+
检查；用户方法论明确点名「顶层算法一优化一大片」，故必须机器求证，不许一句话放弃。

**代码实证（先证根因）**：`E` 基类（`src/internal/js_ast/js_ast.ts:447`）是空类，只有 `isExpr()`，**无任何
数值 kind 判别字段**；`S` 基类（`:871`）同理。全 `src` 有 1399 处 `instanceof js_ast.E*/S*`，其中
parser 381、printer 152；profile-inclusive-after-r1 中 `visitExprInOut` self 239.93ms（12.43% inclusive）、
`printExprInner` self 201.51ms（16.83% inclusive），两条链 self 合计 ~8.4% 总量。[^17]

**改法**：机械 codemod（`bench/kind_codemod.mjs`，TypeScript AST 遍历）给 73 个 E/S 子类各加
`_kind = ExprKind.X` 单字段，`E/S` 基类不加字段（避免 super + 子类双写），新增 `kindIs<T>()` 类型守卫，
1097 处 `instanceof js_ast.X` → `js_ast.kindIs<js_ast.X>(v, ExprKind.X)`。用 const 对象而非 TS `enum`
（`node --experimental-strip-types` 不支持 enum，实测 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`）。[^18]

**门**：three.module `2985154b…`、three.core `c0fdbed2…` 逐字节；tsc 166（与基线错误集合逐条相同，
新增/删除均为 0）。

**冷 CLI 主指标**（基线 `/root/port-r1`@db0f7da，候选 `/root/port-kind`，n=12 warmup=2）：
- v1（基类+子类双写 `_kind`）：speedup **1.0022**，CI[0.98,1.0476]，`NOT_SIGNIFICANT`。[^19]
- v2（仅子类写 `_kind`）：speedup **1.0002**，CI[0.9888,1.0427]，`NOT_SIGNIFICANT`。[^20]

**为何不是 ≥10% 的杠杆（机器证据，非印象）**：独立冷进程微基准（`bench/inst_micro.mjs`，20 万节点、
73 类、热 kind 加权）实测：instanceof 链 ~205ms、kind 数值链 ~64ms（~3.2×）、switch ~6ms。
即单看分派，数值化确实更快；但端到端冷 CLI 零收益，说明 (a) 真实调用点 V8 的多态 IC 已把 instanceof
压到远低于合成基准；(b) 每节点 `_kind` 字段写 + `kindIs` 调用开销抵消分派节省；(c) 首轮低 tier 的
大头不在分派而在 JIT 编译/模块加载（分解表已记）。把函数级 self（两条链合计 ~8.4%）当成可消除的
纯分派成本是错误归因——self 里含 define 替换、usage 计数、lowering 等真实工作，非纯 instanceof。[^17][^21]

**决策：回滚并记账**。符合规则 <10% 不采纳；`git reset --hard db0f7da` 复原 `/root/port-kind`，
主树 `/root/port` 未受污染。结论写死：**AST 表示级 instanceof→数值 kind 分派不是本项目的 ≥10% 杠杆**，
不要再以「顶层算法」之名重开此卡（除非先有新的 profile 证据推翻上述归因）。

## 顶层 inclusive 地图（供阶段2选靶）

| 函数 | inclusive% | self% | 含义 |
| --- | ---: | ---: | --- |
| bundleWithImports | 77.7 | 0.2 | bundle 主链（其余 ~22% 为模块加载/启动） |
| parseFile → Parse | 46.9 | 0.6 | 解析阶段（约占 bundle 时间 60%） |
| parseStmt / parseStmtsUpTo | 33.5 | 1.7 | 语句解析 |
| parseFn / parseClass | 27.3 / 21.5 | 0.3 / 0.3 | 函数/类解析 |
| printOne → Print | 24.0 | 0.4 | 打印阶段（约占 bundle 时间 31%） |
| printStmt / printExpr | 23.6 / 21.3 | 0.7 / 1.3 | 语句/表达式打印 |

> self-time 榜首是 GC(12.4%)、encode(11.1%)；但 inclusive 显示真正的大头是 parse+print 顶层主链。
> 按用户方法论提示：优先找顶层算法问题（一处优化带动一大片），而非只盯 self-time 热点。[^13]

## 决策门槛检查清单（每轮优化前）

1. 列出代码 sha 变更点（含基线侧）。
2. 跑宽差异门 `python3 bench/align.py`：BYTES_DIFFER/EMPTY/WORKER_FAIL=0。
3. 跑主指标 `python3 bench/ab_orch.py --blocks-per-order 3 --n 10`：CI 不含 1 **且** |speedup−1|≥5%。
4. 跑辅指标 `python3 bench/wall.py` 同向。
5. 跑六档门（tsc/assign/m1/doc/cov/three_verify core+module）不回退。
6. 全绿才采纳；任一不过 → 回滚 + 本台账记负结果。

## 脚注

[^1]: bench/AB_NOTES.md（harness 演进 v1→v3.2）+ 方法论交付 [38390]
[^2]: bench/README.md:1-9（口径）+ bench/FINDINGS.md（阶段②③历史，含 −5.7% 噪声结论）
[^3]: src/bundle_multi.ts:308,312；src/bundle1.ts:145,149；/root/port-baseline/src 同号
[^4]: bench/ab-selftest.json + bench/ab-v1.ts:42,82,90
[^5]: bench/ab-null-n24-run1.json / run2.json（0.9641 / 0.9572）；`diff -rq port/src port-baseline/src` 零差异
[^6]: bench/ab-null-final.json（v3.1，0.9664）
[^7]: bench/ab-null-warmfix.json（v3.2，1.0330）+ bench/ab_worker.ts 预热顺序修正
[^8]: bench/align-result.json + bench/gen_align_corpus.py（448 wide）+ bench/align.py（timeout + 护栏）
[^9]: bench/align-result-three-proxy.json
[^10]: bench/wall-null.json；bench/wall.py（EMPTY_OUTPUT 硬门）
[^11]: tools/three_verify.sh（实跑 core/module 逐字节；tsl/webgpu 首差为 HEAD 既有）+ PLAN.md:5218 + src/bundle1.ts:145
[^12]: bench/profile-stage1.json + bench/profiles/stage1-three.module.cpuprofile
[^13]: bench/profile-inclusive.json + bench/analyze_inclusive.py（inclusive=沿栈含被调子树，同函数每栈计一次）
[^14]: bench/wall-cold-module.json / wall-cold-core.json / wall-cold-tsc.json（冷 CLI 三手）+ Go 7 次中位 311/200/754ms；bench/wall.py:39-41（冷子进程、字节硬门）
[^15]: bench/LEDGER.md 冷启动分解表 + /tmp/opt.out（trace-opt 322 次优化）+ /tmp/deopt-runs.log + /tmp/probe_warmup.mjs；机制未确证
[^16]: bench/wall-r3-module.json（1.0415）+ src/internal/js_printer/js_printer.ts:342-354（已回滚）+ git checkout 复原
[^17]: bench/profile-inclusive-after-r1.json（visitExprInOut 12.43%/self 239.93ms、printExprInner 16.83%/self 201.51ms）+ src/internal/js_ast/js_ast.ts:447,871（E/S 基类无 kind）
[^18]: bench/kind_codemod.mjs（TS AST codemod，73 子类 _kind + 1097 处替换）；node --experimental-strip-types enum 报错见 /tmp/kind-module.err
[^19]: bench/wall-kind-module.json（1.0022, NOT_SIGNIFICANT, bytes_equal=true）
[^20]: bench/wall-kind-module-v2.json（1.0002, NOT_SIGNIFICANT, bytes_equal=true）
[^21]: bench/inst_micro.mjs（inst ~205ms / kind ~64ms / switch ~6ms，20 万节点冷进程）
