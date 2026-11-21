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

### R5 — 冷首趟 inclusive/调用树取证 + 降重复工作量卡 → **回滚并记账（负结果）**

按第168代审计要求：不再看 self-time，先做**冷首趟** inclusive/调用树 profile（`bench/cold_calltree.py`，
源 `bench/profiles/after-r1-three.module.cpuprofile`，单次冷 bundle wall 5.4s），定位真正吃工作量的顶层调用根。[^22]

**冷首趟调用树（机器证据）**：`bundleWithImports` inclusive **78.23%** → `load`/`Parse` **53.49%**、
`printOne`/`Print` **18.41%**、`collectRefs` **4.01%**（self 202.73ms）、GC self 528ms（10.07%）。
在探针 worktree 加阶段计时器（`/root/port-probe`，不动主树）：run0 = parse **2812ms(68%)** +
print 993ms + treeshake 237ms + renamer 90ms；连续 6 次 parse **3157→1301→1400→1102→1025→1122ms**，
与 deopt **112→14→4→2→0→1**（主因 generic named access）同形 → **4114↔1864ms 差额 = parse 首轮 JIT tier-up**。[^23]

**为何不直接改 tier-up**：R4 已证 dispatch 数值化端到端 0%；实测预热卡也无效——小输入 8 次预热
（31ms）后真跑仍 4069–4538ms，116KB 多样本预热花 1014ms 后真跑 4082ms（不降）。预热不可廉价付清 tier-up。[^24]

**选卡（根因=降真实重复工作量）**：计数探针（`/root/port-probe`）实测一次 bundle 中
- `bytesToString`（`src/internal/js_parser/js_parser.ts:90`）调用 **146,073 次 `dec.decode`，95% 重复**（仅 7,410 种不同字节串）；[^25]
- `collectRefs`（`src/bundle_multi.ts:97`）`Object.keys` 反射递归 **536,963 次 / 552,400 节点**，其中 223,964 个键是 `Uint16Array` 字符串字面量的逐字符元素（Ref 不可能是数字，纯浪费）；[^26]
- `encoder.encode` 112,223 次（7,386 种不同串，热点 `__PURE__`/`__KEY__` 各 ~7.5K 次）。[^25]

**改法与门**（候选 `/root/port-c5` @594850e，基线 `/root/port-r1`@db0f7da）：
1. `bytesToString` 加内容 memo：冷 CLI speedup **1.0266**（CI[0.9771,1.0561]，byte 等）；[^27]
2. memo + `collectRefs` 剪掉 typed-array 元素：**0.9946**（CI[0.9631,1.0095]，byte 等）；[^28]
3. 仅短串（≤24B）memo：**0.9946**（CI[0.964,1.0083]，byte 等）。[^29]

三手均 `NOT_SIGNIFICANT`、无一 ≥10%，且都字节等价（module `2985154b…`/core `c0fdbed2…`）、tsc 166。
**天花板实证**：decode 全量仅 167ms、encode 245ms、collectRefs self 202ms —— 三者合计 ~614ms 分散在
~4240ms bundle，各 ~4%，即使全消也到不了 10%；缓存键构造还倒吃收益（短串 memo 反慢）。[^24][^25]

**决策：回滚并记账**。`git reset --hard 594850e` 复原临时 worktree `/root/port-c5`（主树 `/root/port` 未动）。
结论写死：**R2/R3/R4/R5 四张负卡共同证明——冷 CLI 的大头是 parse 首轮 JIT tier-up，可由局部代码消除的
重复工作量每处仅 ~4% 且分散，无单点 ≥10%**；继续在此方向逐卡试错不会产生采纳卡。要缩小 15–17× 差距，
需换**非逐卡**的结构路线（例如让首轮直接跑优化 tier 的构建/执行方式），而非再找单函数重复工作。[^23][^24]

> **安全规矩（第168代审计，写死）**：`reset --hard` 只允许在临时 worktree（`/root/port-kind`/`-r1`/
> `-probe`/`-c5`）上做；对 `/root/port`（main）动破坏性命令前先 `git rev-parse --show-toplevel` +
> `git log -1` 确认 cwd/HEAD；主树回滚用新 worktree 或先说明，不许就地 reset。

### R6 — visit-pass scope 消费 Array.shift() → O(1) 游标（**已采纳**）

第169代用户直觉扭转口径：R1–R5 全在 ~5s 冷 CLI 上找卡，而 V8 冷启动税 ~5s 对 Go 静态二进制
结构性打不过；应改用「Go 自己也要跑数秒」的大构建，让启动占比变小，量真实工作量。
**先证伪审计建议的 megamorphic 假设**：冷首趟 `--log-ic` 8.8MB 日志显示 **0 个 IC 站点进入
megamorphic**（最大状态只到 premonomorphic）；`--trace-deopt-verbose` 定位 60 处 generic named access
+ 8 处 wrong map，但全部 deopt 仅耗时 **260ms/110 次**（~2.4ms/次）—— 形状多态/JIT deopt 不是靶。[^30][^31]
真正的大头经大构建 warm profile（`bench/profile_warm_big.py` + inspector）暴露：
**`pushScopeForVisitPass` self 7700ms = 37.8%**（three.module 上仅 75ms/1.44%，R1–R5 从未看见）。[^32]

**根因（机器证据）**：`pushScopeForVisitPass`（`src/internal/js_parser/js_parser.ts:1893`）调用
`this.scopesInOrder.shift()`；在 9MB typescript.js 上该数组长度达 **66,640**，`shift()` 被调用
**66,640 次**，每次 O(n) memmove → ~22 亿次元素搬移 = 那 7.7s。探针证实 **pushInVisit=0**
（72,210 次 parse-pass push 全部先于 66,640 次 visit-pass 消费完成，两阶段不交错），故可用 O(1) 游标
精确替代。[^33]

**改法**：加 `scopesInOrderHead=0` 字段，`scopesInOrder[0]`→`[head]`、`shift()`→`head++`（5 行）。
 semantics=同一批 scope 顺序消费，字节不变。

**门**：three.module `2985154b…`/core `c0fdbed2…` 逐字节；**9MB typescript.js 产物候选==基线逐字节**
（identical-command A/B, sha `c2983579…`）；tsc 166、m1 CHECK OK 4158≥4157、assign 0、doc OK、
three_verify core/module 逐字节（tsl/webgpu 首差 2431/15159 为 HEAD 既有）。progress 「未收敛」为既有。

**大构建 A/B（用户口径：warm 后释放缓存再计时，`bench/wall_big.py`+`warm_time_worker.mjs`，
bootstrap CI）**：[^34][^35]
| 输入 | 基线中位 | 候选中位 | speedup | CI95 |
| --- | ---: | ---: | ---: | --- |
| typescript.js 9.1MB | 18418ms | 12024ms | **1.5317** | [1.439,1.880] |
| `_tsc.js` 6.2MB | 9570ms | 7264ms | **1.3174** | [1.265,1.407] |

three.module 冷 CLI 无变化（0.9764，数组小）—— 本卡专治大构建，符合用户第169代方向。
**决策：采纳**（两大构建同向 ≥10% 且 CI 不含 1 + 字节等价 + 六档门不回退）。
这是 R1 之后首张采纳卡，也是首个「顶层算法一优化一大片」的结构性胜利。

> 口径更新（第169代起）：大构建优化以「warm-build 配对 A/B（`bench/wall_big.py`）」为主指标——
> Go 在该类输入上要数秒甚至更久，V8 冷启动税占比小，才量得到真实算法收益；three 冷 CLI 保留为
> 产物门的代表，但不再是唯一立项口径。

### R7 — 打印器 print() 纯 ASCII 快路径（避开每次 2 次 subarray + encodeInto）（**已采纳**）

按审计169要求，R6 之后**先重跑大构建 warm profile**（`bench/profile_warm_big.py` on 9MB typescript.js；
结果 `bench/profile-warm-r7.json`，cpuprofile `/tmp/warm-big.cpuprofile`）：`pushScopeForVisitPass` 已消失，
**新 #1 = GC 20.18%（2632ms）**，其后 `Next@js_lexer.ts:640` 7.52%、`print@js_printer.ts:334` 5.86%、
`visitExprInOut` 4.17%。总量从 R6 前 20374ms 降到 13044ms。[^36]

**GC 不是直接靶（机器证据）**：GC 在 R6 前是 2418ms/11.87%、R6 后 2632ms/20.18%——**绝对耗时几乎不变**，
只是分母变小；顺着分配源头查（4KB 细粒度 `--heap-prof`，`bench/heap-attribution-r7-big.json`）：
`compileSourceTextModule` 36.8% 是模块加载固定开销，bundle 期所有分配点 ≤2.4%
（`visitExprInOut` 2.34% / `subarray` 2.24% / `Next` 2.17%…），**无单点分配杠杆**，与 R2/R5 一致。[^37]

**先否两张 O(n²) 疑似卡**（prototype 计数探针 `bench/count_probe_worker.mjs` on `/root/port-probe`，1.34M 次 Next/3.11M 次 print）：
- `popAndFlattenScope` 的 `scopesInOrder.splice(scopeIndex,1)`（js_parser.ts:1185）看似 R6 同类——5570 次调用、
  均长 32837、最大 66637；但 **94.5% 是尾部移除（5264/5570 次 move=0，平均 move 13）**，self 仅 11.9ms → **证伪，不动**。[^38]
- `Next()` 中 `CommentsBeforeToken`/`LegalCommentsBeforeToken = []`（js_lexer.ts:645-646）每次分配两空数组，
  Go 用 `[:0]` 复用（js_lexer.go:1003-1004）——改成 `.length=0` 候选 A/B **0.963×，CI 含 1，负结果回滚**
  （V8 对小空数组分配已足够廉价）。[^39]

**采纳卡：print() 纯 ASCII 快路径**。机制：9MB 构建 `print()` 被调 3.11M 次，平均每次仅输出 ~2.9 字节，
但每次都分配 2 个 `Uint8Array subarray` 视图 + 1 次 `encodeInto` 调用；绝大多数片段是纯 ASCII
（标识符/关键字/标点/换行）。改法（`src/internal/js_printer/js_printer.ts:334`）：纯 ASCII 片段用
`charCodeAt` 逐字节直写 `OutBuf.buf`，顺带记 `lastNl` 更新 lineLength；遇任一 `>0x7f` 立即回退到与基线
**完全相同**的 `encoder.encodeInto` 路径（孤立代理项仍按 U+FFFD）。约 20 行，字节语义不变。[^40]

**门**：
- 字节：three.module `2985154b…`/core `c0fdbed2…` 与 Go 逐字节（r8 驱动跑 `tools/three_verify.sh`）；
  **9MB typescript.js sha `8f4d020fd58fb19a` 候选==基线逐字节**；6.2MB `_tsc.js` sha `ad5864271ceb4ffe` 逐字节；
  **编码边界夹具 48/48 逐字节**（`bench/printer-fixtures-r7-result.json`：BMP/非BMP/孤立代理项/CRLF/ASCIIOnly/MinifyWhitespace/LegalComments/AddSourceMappings 全过）。[^41]
- 大构建配对 A/B（`bench/wall_big.py` warm=1，bootstrap CI，base=HEAD R6，cand=r7）：

| 输入 | 基线中位 | 候选中位 | speedup(med ratio) | CI95 | n |
| --- | ---: | ---: | ---: | --- | --- |
| typescript.js 9.1MB | 10747ms | 9140ms | **1.211** | [1.116,1.291] | 8 |
| `_tsc.js` 6.2MB | 7718ms | 6736ms | **1.124** | [1.069,1.196] | 8 |

  注：typescript.js 首轮 n=6 得 1.088（CI[1.011,1.389]，被基线 12706ms 噪声污染），加测到 n=8 得干净
  1.176×（med ratio 1.211）；两大构建同向 ≥10%、CI 均不含 1。[^42]
- 六档门（`src/internal/js_printer/js_printer.ts` 改动，节点软链 `node_modules` 后实跑）：tsc 166≤167、
  m1 CHECK OK 4158≥4157、assign 0、doc OK、progress「未收敛」为既有、three_verify core/module 逐字节。

**决策：采纳**（两大构建同向 ≥10% + CI 不含 1 + 字节等价（含 48 编码夹具）+ 六档门不回退）。
工作树命名 r8（台账轮次 R7）@HEAD 55f2bd0；主树 `src/internal/js_printer/js_printer.ts` 已应用同款改动。
这是 R1 之后第二张采纳卡，也是大构建路线的第二张结构性胜利。

### R8 — 根因复查：GC 分配源头 + 五个候选逐一证伪 → **无采纳卡，记账**

按审计要求，R7 后第一件事重跑 9MB warm profile（`bench/profile-warm-r8.json`）：
**新 #1 = GC 21.74%（2325ms，绝对耗时与 R6 前 2418ms 几乎不变，纯分母效应）**，#2 `Next` 8.77%、
#3 `visitExprInOut` 4.25%；print 已从 top10 消失（R7 生效）。[^43]

**GC 分配源头（4KB heap-prof，post-R7）**：`compileSourceTextModule` 36% 是模块加载固定开销；
bundle 期所有点 ≤2.1%（visitExprInOut 2.09%、set 1.84%、parseStmt 1.63%、parsePrefix 1.42%、
Raw 0.61%、init 0.53%、exprOut 0.34%）——**无单点 ≥10% 分配杠杆**，与 R2/R5 一致。[^44]

**逐一证伪（均机器证据，无一进入门）：**
1. `popAndFlattenScope.splice`（js_parser.ts:1185）：5570 次、94.5% 尾部移除、平均 move 13 → R7 已证伪，未重开。
2. `Next()` 两空数组 `=[]`：R7 的 `.length=0` A/B 已负（0.963×），未重开。
3. `exprIn`/`exprOut`（Go 栈值 vs TS 各 591,830 次 new）：**256B padding 实验证明 V8 已标量替换**——
   padded GC pause 4310ms vs baseline 4411ms、max heap 均 312MB，pooling 无收益 → 删除此卡。[^45]
4. `bytesToString`（744,314 次 / 96.4% 重复，纯 ASCII 分支）：ASCII 快路径候选 A/B **0.982×（CI 含 1，更慢）**；
   两遍扫描成本 > 单次 decode → 回滚，且 R5 内容 memo 已负 → 删除此卡。[^46]
5. `pendingStmtLists`（js_parser.ts:972/4754）：**只写不读**（全 src 无消费点），9MB 上 34,837 次 push；
   但 ~1.7MB <1% 天花板，不值得一个门周期 → 记账不动。

**结论：本轮无采纳卡**。GC 是分散分配症状（非单点），五个候选逐一证伪或低于天花板；与 R2/R4/R5
结论一致——大构建 warm 帧下可局部消除的单点均 <10%。next 方向：继续沿大构建 warm profile，
按 inclusive/顶层算法找「一优化一大片」的结构卡；用户 [39497] 的「Go 自身 ≥10s 超大构建」目标仍未达成，
只在 1GB 内用真实大源码树试，不为凑 10s 制造 OOM/超时。

### R9 — 函数指针表 + ASCII 查表（Next 大 switch 候选）→ **微基准证伪，不立项**

调研 `bench/switch-opt-research.md` §2/§4 判读的下一张卡：社区 opcode 场景（case 0–255 连续）用
函数表直跳快 25×，本项目能否复用。写四版简化词法微基准 `bench/fn-table-bench.mjs`：
A big（稀疏 codePoint 大 switch = 真实写法）、B table（128 项 Uint8Array `cp→槽位` + 10 handler
函数指针数组直跳）、C hotif（顺序 if 热点排前）、D active（R8 已知最强写法）。三语料 token 直方图
逐项相等，配对 ratio=big/variant（>1 为该版更快）+ bootstrap 95% CI（seed 固定）。[^47]

| 输入 | tokens | table/big | hotif/big | active/big |
| --- | ---: | --- | --- | --- |
| `_tsc.js` 6.2MB | 885238 | 0.668 CI[0.644,0.743] | 1.115 CI[1.007,1.118] | 1.565 CI[1.406,1.554] |
| three.core.min 1.47MB | 131018 | 0.744 CI[0.742,0.894] | 1.099 CI[0.99,1.185] | 1.707 CI[1.686,2.101] |
| `js_lexer.ts` 100KB | 15278 | 0.636 CI[0.613,0.707] | 1.147 CI[1.07,1.219] | 1.596 CI[1.477,1.779] |

**根因（机器证据）**：`--trace-turbo-inlining`（`/tmp/fntable-inline.stdout`）显示 10 个 handler
彼此内联 44 次（函数本身可内联），但**内联进 `Next()` 的 handler 数为 0**——因为调用走
`HANDLERS[slot](...)` 数组元素间接调用，call site 是 megamorphic（`FeedbackCell[many closures]`），
V8 拒绝内联；再加一次 Uint8Array 查表 → table 比 big 慢 31–41%（三手 CI 全不含 1 且 <1）。
与调研判读吻合：opcode 的 25× 依赖 case 连续 + handler 够大，本项目 codePoint 稀疏、handler 微小、
调用点 megamorphic，套不过来。hotif 仅 ~10–15%（three 手 CI 含 1），active 仍最强（1.56–1.71×）。

**决策：不立项**。函数表方向在微基准层即证伪（负结果），不进六档门/大构建 A/B，不改真实 lexer。
next 方向：active 主动 while 仍是唯一 >10% 的写法，但属全量重写级改动；用户若要推进，
下一步应在真实 `js_lexer.ts` 上做 active 重写的配对 A/B 与六档门，而非函数表。

### R10 — codePoint 哈希到 0~255 再 switch → **机制成立但性能未达标，不立项**

用户方向 [40144]：针对"稀疏"病根，把 codePoint 哈希压到 0~255 连续域骗 V8 建 jump table，
case 内二次区分冲突桶。写 `bench/hash-switch-bench.mjs`（输入用解码后 codePoint 的 Int32Array，
注入 U+2028/U+2029 触发稀疏标签与冲突桶），三版对照：big（真实稀疏 switch）、hash
（`switch(cp&0xff)`）、active（参照）。字母数字在两版都显式列为 case 标签（真实 Next 如此，
是哈希后达到 98 case 密集域的前提）。正确性：三语料 ± 注入共 6 组 token 直方图逐项相等[^48]。

| 输入 | hash/big | active/big | hash 是否显著 |
| --- | --- | --- | --- |
| `_tsc.js` 6.2MB | 1.034 CI[1.02,1.066] | 0.999 CI[0.932,1.067] | 是但 <10% |
| three.core.min | 1.013 CI[1.001,1.046] | 1.109 CI[1.044,1.164] | 是但 <10% |
| `js_lexer.ts` | 1.037 CI[0.991,1.089] | 1.064 CI[0.967,1.201] | 否(CI 含 1) |
| `_tsc.js`+注入离群 | 0.914 CI[0.883,1.003] | 1.004 CI[1.015,1.113] | 否，甚至变慢 |

**根因（反汇编机器证据 `/tmp/hash-optcode.out`）**：hash 版**确实生成 jump table**——826 个
`jump table entry`、`jmp [r10+rX*8]` 间接跳转，cmp 从 big 的 1552 降到 799；big 版 0 个
jump table entry。用户"哈希骗 jump table"的机制假设成立。但性能只有 1.01–1.04×：
① 哈希有前置成本——≥0x80 codePoint 必须按 identifier 先分流（否则低 8 位撞进 ASCII 桶误判，
实测首次跑 js_lexer.ts 因此直方图不等），冲突桶 0x28/0x29 还要 case 内二次区分；
② 更关键——token 分布极度倾斜，jump table 每次都算索引+间接跳转，而顺序 if 让热点
(ws/ident) 第一次比较就命中。与调研 §3 的 RE2C"换 jump table 换 if 有时略快"吻合。

**决策：不立项**。机制成立但收益 1–4%（远低于 10% 线），注入离群后部分反慢，且输给 active。
next 方向：jump table 路线已排除；active 主动 while 仍是唯一 >10% 写法，若要推进须在真实
`js_lexer.ts` 上做配对 A/B + 六档门。

### R11 — 真实 Next() 热点短路（ws/newline fast-path）→ **无显著收益，回滚不采纳**

用户方向 [40144后]：把 R10 微基准里占优的"热点短路"落到真实 `js_lexer.ts`。
在 `Next()` 的 `switch(this.codePoint)` 前插入 fast-path：newline(0x0a/0x0d/0x2028/0x2029)
与 space(0x09/0x20) 命中即 `step()`+`continue`，语义与 switch 里原 case 逐字节等价
（候选树 `/root/port-hotshort` @7067522，改动仅 +13 行；base 树 `/root/port-hotbase` 同 sha）[^49]。

大构建配对 A/B（`bench/wall_big.py`，warm=2 释放缓存后单次测量，n=8，byte sha 硬门）:

| 输入 | speedup(mean) | median ratio | bootstrap median CI95 | bytes_equal |
| --- | --- | --- | --- | --- |
| typescript.js 9MB | 1.0052 | 0.9486 | [0.924,1.041] | true |
| `_tsc.js` 6.2MB | 0.9934 | 0.9859 | [0.952,1.037] | true |

**决策：回滚不采纳**。两手 median ratio 均 <1（候选反而略慢），CI 都跨 1 → 噪声内、无
≥10% 降幅；产物字节对齐但性能不达标。主树从未改动；候选临时树已 `git checkout` 复原
（sha 回到 d709b9…）。根因与 R10 一致：V8 已对 `Next()` switch 的热点 case 做了优化，
短路省下的几个 cmp 不足 10%；真正占大头的是 GC/分配与顶层 parse 主链（R8/R10）。
next 方向：ws/newline 短路路线已排除；函数表(R9)/哈希 jump table(R10)/热点短路(R11)三条
lexer 微优化路线均未达 10%，lexer 侧局部改动空间基本穷尽。

### R12 — 算法复杂度取证（用户方法论提示）：**全阶段线性，无 O(n²) 红利可摘**

用户提示「算法时间复杂度优化常大幅超越语言依赖」。为验证本项目是否存在 O(n²)→O(n) 的结构卡，
做受控规模 scaling：新 worker `bench/scaling_profile_worker.mjs` 接受 --driver，warm=2 释放缓存后
profile 单次运行；两类输入——① 真实语料三规模（three.module 0.66M / three.core 1.47M / _tsc 6.21M）；
② 同风格生成语料 2.33M/4.69M/9.46M（纯数据对象字面量，规模精确 1:2:4）[^50]。

| 阶段 | 生成 2.33M | 4.69M | 9.46M | 4×规模下增长 | 判定 |
| --- | ---: | ---: | ---: | ---: | --- |
| parser | 559ms | 881ms | 1816ms | 3.25× | 线性/亚线性 |
| GC | 1148ms | 1913ms | 5069ms | 4.42× | ≈线性(ms/MB 恒定) |
| lexer | 311ms | 545ms | 1070ms | 3.44× | 线性 |
| utf8-codec | 884ms | 1498ms | 2986ms | 3.38× | 线性 |
| printer | 370ms | 483ms | 967ms | 2.61× | 亚线性 |

**结论（机器证据）**：所有阶段随规模线性或亚线性增长（4× 规模 → 各阶段 2.6–4.4×），GC/ms-per-MB
恒定（真实语料 174→191→208、同风格 493→408→536 无趋势）——**解析/lex/print/codec 主链本就是线性
递归下降，不存在可摘的 O(n²) 算法红利**。用户方法论适用于有超线性算法的代码，本项目不满足前提。
剩余差距来自运行时固定开销：GC 21.76%（R8 已证伪单点分配、分散）、utf8-codec 12.26%（R5 memo /
R8 ASCII 快路径均已证伪）。renamer 仅 1.71%（`findUnusedName` 的 encode 调用总量小）；R4 的
instanceof→数值 kind 分派微基准虽快 3.2×，但端到端零收益、归因已写死（self 含真实工作+字段写抵消），
无新 profile 证据不重开。

**决策：本轮为取证轮，无卡可开**。诚实结论：算法复杂度维度已排除； lexer 三路线(R9/R10/R11)、
AST kind(R4)、分配(R8)、codec(R5/R8) 全部证伪。next 方向：若继续压缩 TS/Go 差距，须转向
**减少总算法工作量**而非加速现有算法——例如 tree-shaking / 死代码消除的覆盖率、或
冷启动 JIT tiering（分解表已记，机制未确证）；这两者是尚未系统验证的顶层方向，需用户定夺。

### R13 — 空间复杂度取证：内存为什么高（用户方向）→ **取证轮，无卡**

用户问「内存占用为什么那么高」。用两件机器证据分层回答[^51]：
① 内存曲线（`--trace-gc` + 各阶段 `global.gc()` 后 `memoryUsage`）：warm 后基线 heap 12MB/rss 340MB；
**一次 Parse() 后 heap 12→145MB**（AST 常驻）+133MB；symbolmap/tree-build 阶段几乎不变；
bundle 结束 heapUsed 回 12MB（**无泄漏**）。GC 峰值存活 167MB、回收后 15MB，548 次 Scavenge
且 255→251MB 回收极少。
② after-parse 存活堆 snapshot（`v8.writeHeapSnapshot` + 流式解析 `bench/heap_snapshot_top.py`）：
**总存活 163MB / 2,807,210 节点**，top：`(object elements)` 21.26MB/152K、`Loc` 18.87MB/**618,425 个**、
`JSArrayBufferData` 17.18MB、`Expr` 15.09MB/395K、`EIdentifier` 8.98MB/168K、`Array` 8.10MB/265K、
`Scope` 4.94MB、`Symbol` 4.29MB、`Stmt` 3.45MB/90K、`Index32` 2.86MB、`Ref` 2.12MB。

**根因（分层）**：(a) bundle 内存峰值 = Parse 阶段的整棵 AST 常驻（12→145MB），这是 esbuild
「全 AST 在内存」模型的必然结果；(b) **Go 的 `Loc` 是 `{Start int32}` 值类型内联在结构体里，
TS 移植成 32B 堆对象 × 618K = 18.87MB**，`Expr`/`EIdentifier`/`Stmt` 等每个 AST 节点同样有对象头开销
——这是表示层面的 Go值语义→TS堆分配差异；(c) rss 340MB 基线在 bundle 前就存在 = 模块加载
（compileSourceTextModule 占分配 36%）+ external 36MB + V8 预留堆，不是 bundle 工作本身；
(d) 548 次 GC + 极低回收率 = parse/print 期短命对象高分配抖动（时间侧 GC 21.76% 的分配根源）。

**决策：取证轮，无卡可开**。rss 大头（模块加载/预留堆/external）非 bundle 工作、不可由局部改动消除；
存活大头（AST 节点 + Loc）是表示级结构性成本，且 R4 已写死 AST 表示级改动不作 ≥10% 杠杆。
若未来要降 AST 内存，唯一量级手段是把 `Loc`/`Expr` 等改为数值索引+SoA（struct-of-arrays），
属全量表示重构，须先证明它能降到 ≥10% 峰值 RSS 且不破坏逐字节，当前无此证据。
next 方向：空间维度已定位到「AST 常驻 + Loc 堆对象 + 模块加载预留」，均非单点；等用户定夺是否
立项 AST 表示重构（高风险大改）或转向其它顶层方向。

### R14 — 紧凑/SoA AST 表示对 Go 是否益：微基准 → **有益且语言无关（4.4×），仅测表示本身**

用户设想「重做 AST 表示（SoA/typed-array）大幅提升一次性编译」，先验证该思想对 Go 是否成立
（判断瓶颈是语言还是表示）。写 `bench/ast-soa-go-bench.go`（go1.27.3、GOMAXPROCS=1、独立进程、
`runtime.ReadMemStats` + sink 保活），构造与 esbuild AST 同构的二叉表达式树，三版对照：
A esbuild 现状（`Expr{Data interface, Loc value}` + 逐节点 new）、B 紧凑扁平结构体（去 interface、
无逐节点分配）、C SoA（并行 typed 数组）。保真度：`sizeof` 与真实 esbuild 一致
（Expr=24/EBinary=56/ECall=56/Loc=4，`go run` 于 /root/esbuild 核对）。[^52]

| 规模 | A esbuild | B 紧凑 | C SoA | B/C vs A |
| --- | ---: | ---: | ---: | --- |
| 10 万节点 | 8.39MB | 1.91MB | 1.91MB | 4.4× |
| 100 万节点 | 83.93MB | 19.08MB | 19.10MB | 4.4× |
| 400 万节点 | 335.69MB | 76.30MB | 76.33MB | 4.4× |

即 **88 B/节点 → 20 B/节点，稳定 4.4×，三规模完全线性**。

**结论（机器证据）**：① 紧凑表示对 Go 同样有益——瓶颈是「interface 间接 + 逐节点堆分配」这一
**表示方式**，不是 Go-vs-TS 语言差异，故重构思想是语言无关的；esbuild 的 Loc 已是 4B 值类型
（领先 TS 的 32B 对象），但 interface+节点分配仍使每节点 88B。② **反直觉关键点：B（扁平结构体）
与 C（SoA）内存完全相同（20B）**——收益来自「去 interface + 消除逐节点分配」，不是 SoA 布局本身；
SoA 的价值在缓存局部性/遍历速度（需另行测时间），不在内存。③ 边界：此微基准只隔离 AST 节点存储，
真实 bundle 还有源缓冲/字符串/符号表/GC 抖动；4.4× 是「纯表示改动」的收益上限，不是整体内存降幅。

**决策：取证轮，不立项**。结论支持「表示重构思想正确」，但 (a) 对 Go 原版无改动机（esbuild 已是最优
实用折中，且用户目标是比较 TS 移植而非改 Go）；(b) 对 TS 侧，R4/R13 仍成立——V8 上无法 `#[repr(packed)]`，
要复刻 20B 需手搓 typed-array SoA，是全量重构；(c) 本轮证明 SoA 不比扁平结构体省内存，故若做，
先用更简单的「去多态、值化」而非完整 SoA。next：等用户定夺是否在 TS 侧立表示重构卡（先做
`Loc→Int32Array` 单点原型量收益上限），或转向其它方向。

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

### R15 — Go 侧 AST 紧凑化 goport M2-a 竞技场化实测 → **负结果，回滚并记账**

立项 R14 的 4.4× 来自 TS 侧同构 AST 微基准；goport 孤儿分支把它落到真实 esbuild 0.28.2 上验证。
M0（基线固化：5 入口逐字节 + go test 全绿）、M1（表示设计 `docs/repr-design.md`）通过。
M2-a 实施 77 类型 typed-chunk 竞技场（去逐节点 malloc），Go-AST codemod 改 389+152+45 处节点分配：
构建/字节门/go test 全绿，但收益实测为负——

- 交错 A/B n=12（`_tsc.js` 6.2MB，`GOMAXPROCS=1`，TotalAlloc）：baseline 中位 156,476,636 vs arena 156,974,152 = **+0.32%（不降反升）**，距 −10% 门极远；chunk=8 更差 +3.1%。
- 根因（`alloc_space` pprof）：AST node 字面量分配仅 20.01MB/156.5MB = **12.8%**；大头是 scope/symbol slice 增长 ~20%、printer ~15%、文件 IO ~9%。竞技场只省 malloc 头与 size-class 取整，小节点已被 Go tiny allocator 打包，省的少于分块头开销 → 净增。
- R14 不可外推：同构微基准里 AST≈全部内存，真实构建里 AST 节点表示只是零头。

按立项书「<10% 回滚止损、负结果照记」：M2-a 代码已回滚到 `856493b`，字节门复验 OK；
goport 收口提交 `733da4e`，工作树干净。**不采纳竞技场化这一子法**。
注意：本轮只否证「去逐节点 malloc 头」这一代理法；「去 16B interface / 压缩 Expr 包装」的核心杠杆与
「峰值存活堆」口径尚未在真实构建上直接测（R14 微基准未覆盖），不能据此宣布整条紧凑表示路线失败——路线继续推进。

证据：goport `baselines/m2a-result.md`、`baselines/m0-result.md`、`docs/m4-closeout.md`、`docs/repr-design.md`。

### R16 — Go 侧 M2-c 热切片预分配 → **强负结果（−9.29% TotalAlloc，未过 −10% 门），回滚并记账**

接续 R15：紧凑表示路线继续。M2-b（scope Members 懒分配）已否证（TotalAlloc −0.43%、存活堆 −0.99%，回滚）。
M2-c 针对 pprof alloc/inuse 前 4 的两个 append 增长热点：`p.symbols`（52,533×48B）与
`p.scopesInOrder`（39,521×16B）从 cap 0 各经 ~16 次 realloc。实施为纯 byte-safe 预分配：
`newParser` 按源码长度定标（sym=/110、scope=/157，TS 时 `tsUseCounts` 同 cap），并把 10 处
`Members[k]=v` 收敛到 `Scope.AddMember` 懒分配 map。

- 交错配对 A/B（`_tsc.js` 6.2MB，GOMAXPROCS=1，n=40 + bootstrap）：TotalAlloc 中位
  156,525,008 → 141,985,528 = **−9.29%**，CI95 [−9.30%,−9.26%] 不含 0，统计显著、可复现；
  但 **< −10% 立项门**。比值 sweep（sym 80..260 × scope 120..260）最优也只 ~−9.8%，flat plateau。
- 峰值存活堆：mempeak + `pprof -inuse_space` 实测 ~68.9MB → ~68.4MB = **−0.6%**：预分配只省转瞬复制，
  不留存活收益。node payload（含 Scope）存活堆 20.6/59.6MB = **34.6%**，远高于 TotalAlloc 口径 12.8%，
  确认 TotalAlloc 低估长寿命 AST。
- 门：候选 `go build`/`go test` 全绿、5 入口字节门 5/5 PASS。

按「<10% 回滚止损、负结果照记」：M2-c 代码已按 gate 回滚（`/root/goport` 工作树 tracked 文件恢复到
`733da4e`，未就地 `reset --hard`），残留 `js_parser.go.work` 已清理；实验 diff 留档
`baselines/m2c-prealloc-experiment.patch`，结论留档 `baselines/m2c-prealloc-result.md`。**不采纳预分配这一子法**。
R15/R16 只否证「去 malloc 头」「切片预分配」两类代理法；核心杠杆（去 16B interface 的紧凑 Expr，
针对 34.6% 存活堆）与峰值存活堆口径仍未在真实构建上直接测，路线继续推进。

证据：goport `baselines/m2c-prealloc-result.md`、`baselines/m2c-prealloc-experiment.patch`、`baselines/m2b-scope-result.md`；
`/tmp/ab-def.txt`（n=40 原始数）、`/tmp/pk-b-1.prof`（inuse_space 59.56MB / 667K 对象）。

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
[^22]: bench/cold_calltree.py + bench/profiles/after-r1-three.module.cpuprofile（冷首趟 bundleWithImports 78.23%/load·Parse 53.49%/Print 18.41%/collectRefs 4.01%）
[^23]: /root/port-probe 阶段计时器（run0 parse 2812ms/print 993ms；6 次 parse 3157→1122ms）+ /tmp/deopt-runs.log（deopt 112→14→4→2→0→1）
[^24]: /tmp/probe_warm2.mjs（小输入 8 次预热 31ms 后真跑 4069ms）+ /tmp/probe_warmfresh.mjs（116KB 预热 1014ms 后真跑 4082ms）+ /tmp/probe_ceiling.mjs（decode 167ms/4240ms）
[^25]: /tmp/probe_callsites.mjs（bytesToString→dec.decode 146,073 次；hasPrefixWithWordBoundary→encode 62,739 次）+ /tmp/probe_dedup.mjs（95% decode 重复、7,410 唯一）+ /tmp/probe_prefix.mjs（112,223 encode/7,386 唯一，245ms）
[^26]: /tmp/probe_shape2.mjs（唯一形状变体是 Uint16Array）+ /tmp/probe_typed.mjs（223,964 typed-array 键）+ /tmp/probe_cr.mjs（collectRefs 1.47M 调用/552K 节点）
[^27]: bench/wall-r5-module.json（1.0266, NOT_SIGNIFICANT, bytes_equal=true）
[^28]: bench/wall-r5-combined-module.json（0.9946, NOT_SIGNIFICANT, bytes_equal=true）
[^29]: bench/wall-r5-shortmemo-module.json（0.9946, NOT_SIGNIFICANT, bytes_equal=true）
[^30]: /tmp/ic2.log（--log-ic 8.8MB，0 个 mega 站点）+ /tmp/deoptverbose.out（--trace-deopt-verbose，60 generic named access + 8 wrong map，总 260ms/110 次）
[^31]: bench/LEDGER.md R6 节「先证伪 megamorphic 假设」（信源同上）
[^32]: bench/profile_warm_big.py + bench/warm_profile_worker.mjs + bench/profile-warm-big.json（typescript.js warm，pushScopeForVisitPass self 7700ms/37.8%）
[^33]: /tmp/probe_sio.mjs（scopesInOrder max=66640, shift=66640）+ /tmp/probe_phase.mjs（pushes=72210, visits=66640, pushInVisit=0）+ src/internal/js_parser/js_parser.ts:1893
[^34]: bench/wall_big.py + bench/warm_time_worker.mjs + bench/wall-big-r6.json（typescript.js 1.5317, CI[1.439,1.880]）
[^35]: bench/wall-big-r6-tsc.json（_tsc.js 1.3174, CI[1.265,1.407]）
[^36]: bench/profile-warm-r7.json + /tmp/warm-big.cpuprofile（R6 后 9MB warm：GC 20.18%/2632ms，Next 7.52%，print 5.86%，总量 13044ms）
[^37]: bench/heap-attribution-r7-big.json（4KB heap-prof：compileSourceTextModule 36.8% 模块加载，bundle 期各点 ≤2.4%）+ LEDGER R6/R2 的 GC 绝对耗时对比
[^38]: bench/count_probe_worker.mjs + /root/port-probe 计数（popFlatten 5570 次，尾部移除 5264 次，平均 move 13，self 11.9ms）
[^39]: /root/port-r7 候选 js_lexer.ts Next() 空数组复用 A/B 0.963×（CI 含 1，负结果已回滚）；Go js_lexer.go:1003-1004 用 [:0]
[^40]: src/internal/js_printer/js_printer.ts:334（print() 纯 ASCII 快路径，非 ASCII 回退 encodeInto）+ /tmp/port 候选 worktree r8
[^41]: bench/printer-fixtures-r7-result.json（48/48 逐字节）+ three_verify r8 驱动 + 9MB/_tsc.js sha 逐字节
[^42]: bench/wall-big-r7.json（typescript.js n=8 med ratio 1.211 CI[1.116,1.291]）+ bench/wall-big-r7-tsc.json（_tsc.js 1.124 CI[1.069,1.196]）
[^43]: bench/profile-warm-r8.json（R7 后 9MB warm：GC 21.74%/2325ms，Next 8.77%，visitExprInOut 4.25%，总量 10695ms）
[^44]: /tmp/hf/f（post-R7 4KB heap-prof：compileSourceTextModule 36%，bundle 期各点 ≤2.1%）+ bench/analyze_heap.py
[^45]: /tmp/gcm-padded.* vs /tmp/gcm-baseline.*（exprIn/exprOut +256B padding：GC pause 4310 vs 4411ms，max heap 均 312MB → 标量替换）
[^46]: /root/port-r9 bytesToString ASCII 快路径 A/B 0.982×（CI 含 1，已回滚）+ /tmp/wall-big-r9.json
[^47]: bench/fn-table-bench.mjs（四版简化词法微基准，三语料 equal）+ /tmp/fntable-inline.stdout（--trace-turbo-inlining：0 handler 内联进 Next，FeedbackCell[many closures]）
[^48]: bench/hash-switch-bench.mjs（codePoint 哈希微基准，三语料 ± 注入共 6 组 equal）+ /tmp/hash-optcode.out（--print-opt-code：hash 826 jump table entry / cmp 799，big 0 entry / cmp 1552）
[^49]: bench/wall-hotshort-ts.json + bench/wall-hotshort-tsc.json（大构建配对 A/B，n=8，bytes_equal=true，median ratio 0.949/0.986，bootstrap CI 跨 1）；候选 js_lexer.ts +13 行 fast-path 已回滚
[^50]: bench/scaling-analysis.json（受控规模 warm profile 阶段聚合）+ bench/scaling_profile_worker.mjs（--driver 版 profile worker）；原始 cpuprofile 在 /tmp/prof-{tm,tc,full,gen1,gen2,gen4}.cpuprofile
[^51]: bench/heap-space-analysis.json（内存曲线 + after-parse 存活构成）+ bench/heap_snapshot_top.py（流式 snapshot 解析）；原始 snapshot /tmp/parse-heap.heapsnapshot（274MB，未提交）；GC 日志 /tmp/memcurve.out、/tmp/gcm-baseline.out
[^52]: bench/ast-soa-go-bench.go（go1.27.3、三版 AST 表示、独立进程 ReadMemStats）+ bench/ast-soa-go-result.json（三规模数据与 sizeof 核对）；真实 esbuild sizeof 由 `go run` 于 /root/esbuild 验证
