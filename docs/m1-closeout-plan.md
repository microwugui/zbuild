# M1 收口批量计划（第 21 次推进，v2 于第 24 轮重排）

> 目的：把驱动轴从「差异簇」换成「M1 收口批量」。差异簇在 4,141/4,238（97.7%）之后边际收益已经接近 0，而且推不动 M1 剩余的 256 个函数；M1 的验收是 **830/830 双 100%**（移植 830/830 + 执行 830/830），不是逐字节百分比。
>
> **算术恒等式（第 24 轮起硬约束）**：§2 批次表「剩余」列合计 ≡ `830 − progress.json.ported`。改表后先跑 `npm run doc:check`，不通过不许写汇报。

## 0. 为什么换轴（证据）

| 事实 | 读数 | 含义 |
| --- | ---: | --- |
| M1 逐字节相等 | **4,141 / 4,238（97.7%）** | 距离 100% 还差 97 例，`m1.json` |
| 其中「其他（逐例单点）」 | **72** | 没有共同根因，逐例扫违反纪律 |
| `three/package/src` | **756 / 757（99.9%）** | 近饱和，边际收益 ≈ 1 例 |
| `esbuild-cases` 剩余差异 | **94** | 3,382 / 3,476 = 97.3%，剩下的全是长尾（第 23 轮对齐：原写 99 / 97.2%） |
| M1 已移植 / 目标 | **830 / 830（100%）** | **还差 0 个函数**才是 M1 收口（第 113 轮 +7 落 visit 内层整族：parser handleIdentifier/maybeRewritePropertyAccess/parseExprOrLetOrUsingStmt/binaryExprVisitor.checkAndPrepare/visitRightAndFinish + printer binaryExprVisitor.checkAndPrepare/visitRightAndFinish，M1 收口；（第 111 轮 +2 落 printer import-record 底座 printRequireOrImportExpr/printImportCallAssertOrWith，M1 823（第 112 轮 +3 落 visit-pass 底座 LazyExportAST/GlobResolveAST/prepareForVisitPass）/820/818；第 110 轮 +2 printer minify 折叠族；第 109 轮 +6 using 降级整族 5 + lowerTemplateLiteral 归置，M1 810→816；第 108 轮 +1 落 handleGlobPattern、第 107 轮 +6 落 js_parser 诊断/inject/符号助手族，M1 803→810；第 104 轮 +1 落 ParseSourceMap，M1 802→803；第 91 轮 +2 落 OptionsFromConfig/Equal，M1 800→802；第 84 轮 +3 落 logger clang/visualstudio style 3，M1 797→800） |
| 差异簇可归属的未移植整函数 | ≈ 0 | 第 20 轮的 4 个结构簇已全部落在「已移植函数内部」 |

结论：**逐字节百分比与 M1 的函数口径不是同一张网**。继续只盯 97 例会停在 97.7% 很久，而 256 个函数一个也不会因此完成。所以第 21 轮起，主轴换成「按 Go 文件/依赖顺序成批搬函数 + 每批用 Go 字节验收」，差异簇只做有结构的两件事（见 §5）。

## 1. 剩余 0 的机械分布

来源：`inventory.json`（`go run tools/inventory.go`）× `tools/progress.ts` 的同名 AST 判定 × `progress.json` 的 per-package 口径。逐包读数（第 23 轮收口时点）：

| 包 | M1 函数 | 已移植 | 未移植 | 备注 |
| --- | ---: | ---: | ---: | --- |
| `internal/xxhash` | 25 | 25 | 0 | 完成 |
| `internal/helpers` | 88 | 88 | **0** | 第 21 轮 +1（`IsInsideNodeModules`）；第 26 轮 +9（dataurl 3 / mime 1 / path 3 / glob 2） |
| `internal/ast` | 30 | 30 | 0 | 完成 |
| `internal/logger` | 76 | 76 | **0** | 第 84 轮落 style_clang 2 + style_visualstudio 1（73→76，Go 探针 8 例逐字节）；第 80 轮落平台变体 6 个；第 72 轮 StringInJSTable 三件套回归 |
| `internal/js_lexer` | 45 | 45 | 0 | 完成 |
| `internal/js_ast` | 169 | 169 | **0** | 第 78 轮 `ExprToConstValue` / `ConstValueToExpr` 落地（Go 探针 5011 例逐字节） |
| `internal/js_parser` | 307 | 307 | **0** | 第 109 轮 +6（using 降级整族 5 + lowerTemplateLiteral 归置，Go 探针 5 场景逐字节）；第 91 轮 +2（OptionsFromConfig/Equal，主链桥接底座）；第 72 轮 +2（OptionsForYarnPnP/remapExprLocsInJSON）；第 21 轮 +4；第 22 轮 +13、第 23 轮 +30、第 24 轮 +9、第 26 轮 +6、第 27 轮 +8（`js_parser_lower_class` 2 重新计数 + G/F/E 8；K 的 8 个在 `ts_parser.ts` 计入同包）；第 43 轮 G-3 +3、第 44 轮 define/CharFreq/glob/ParseGlobalName +4 |
| `internal/js_printer` | 71 | 71 | **0** | sourcemap / TS enum / minify 三族（第 42 轮累计落 12 个纯助手，Go 探针直调 + 主链接线；第 44 轮落 addSourceMapping/addSourceMappingForName；第 109 轮 +2 落 minify 折叠族；第 111 轮 +2 落 import-record 底座 printRequireOrImportExpr/printImportCallAssertOrWith） |
| `internal/sourcemap` | 19 | 19 | **0** | M1 里唯一整包未动（Print 的 sourcemap 通道） |
| **合计** | **830** | **830** | **0** | `830 − 830 = 0`（`npm run doc:check` 机器核对） |

按 Go 文件的机械分布：

| Go 文件 | 未移植 | 主体内容 |
| --- | ---: | --- |
| `internal/js_parser/js_parser.go` | 0 | visit pass / mangle / 诊断 / 作用域收尾（第 91 轮落 OptionsFromConfig/Equal；第 72 轮落 OptionsForYarnPnP/remapExprLocsInJSON；第 34/35 轮落 captureValue + G-3 谓词/IIFE；第 36 轮落 mangleStmts/mangleIf；第 43 轮落 substitute×2/minifySwitchStmt；第 44 轮落 isDotOrIndexDefineMatch/computeCharacterFrequency/globPatternFromExpr） |
| `internal/js_parser/js_parser_lower.go` | 0 | 降级（using 族 5 个 + lowerTemplateLiteral 归置均第 109 轮落地） |
| `internal/js_parser/js_parser_lower_class.go` | 0 | class 降级（第 34 轮落 private/super 14；第 37 轮 lowerClass 全链 17 个落地并接 visitClass） |
| `internal/js_parser/ts_parser.go` | 0 | TS 语法（第 34/35 轮落 type-skipper 全族 + interface/type stmt；第 42 轮落 wrapInlinedEnum + enum/namespace 全链 5 个，逐字节等于 Go） |
| `internal/js_printer/js_printer.go` | 0 | sourcemap / TS enum / minify / import call（第 38 轮落 guardAgainst 3 函数；第 42 轮落 12 个纯助手；第 44 轮落 addSourceMapping×2 + M2 通道接线；第 109 轮落 minify 折叠族 2；第 111 轮落 import-record 底座 2） |
| `internal/helpers/*.go` | 0 | serializer / timer / waitgroup（dataurl / glob / mime / path 已在第 26 轮落地） |
| `internal/sourcemap/sourcemap.go` | 0 | VLQ / ChunkBuilder / LineColumnOffset |
| `internal/logger/*.go` | 0 | clang / visualstudio 已于第 84 轮落地（Go 探针 8 例逐字节）；第 72 轮落 StringInJSTable 三件套；第 80 轮落平台变体 6 个 |
| `internal/js_parser/sourcemap_parser.go` | 0 | `ParseSourceMap` 第 104 轮落地（sourcemap 反解，17 例逐字节等于 Go） |
| `internal/js_ast/js_ast.go` | 0 | 第 78 轮 `ExprToConstValue` / `ConstValueToExpr` 落地 |
| `internal/js_parser/global_name_parser.go` | 0 | `ParseGlobalName`（第 44 轮归置到 global_name_parser.ts，测试已覆盖） |

## 2. 批次表（批次 → Go 文件行号 → 剩余函数数 → 验证通道 → 目标轮次）

通道口径（全部来自 `tools/parseprint.json` 的钉死基准，`npm run m1:check` 逐模式校验）：

- **① js 默认语料**：`equalBaseline 4,141 / 4,238`（trivialEqual 3,207 单列；diff 97）
- **② `ts.Parse=1 + jsx.Parse=1` 语料**（第 21 轮新增）：`equalBaseline 4,108 / 4,238`、`tsErrorBaseline 0`
- **③ minify 语料**（`MinifyWhitespace + MinifySyntax`，第 21 轮新增）：`equalBaseline 1,767 / 4,238`、`tsErrorBaseline 154`

| # | 批次 | Go 文件（行号区间） | 剩余函数数（已落地/名义） | 本轮将落地函数数 | 通道 | 依赖 visit pass（是/否） | 承诺轮次 |
| ---: | --- | --- | ---: | ---: | --- | --- | --- |
| A | 作用域 / 符号收尾 | `js_parser.go` 1145–1767（`selectLocalKind`、`popAndDiscardScope`、`popAndFlattenScope`、`discardScopesUpTo`、`mergeSymbols`、`scopeMemberArray.Len/Swap/Less`、`declareBinding`） | **0**（9/9 已落地） | 0 | ① | 否 | 第 22 轮 |
| B | 解析期诊断 / 严格模式 / defines | `js_parser.go` 1953–2164、6387–6393、6744–6755、18283–18317 + `js_parser_lower.go` 132–138、155–236（解析期诊断 / 严格模式闭包 / defines；`logExprErrors` 依赖 `markSyntaxFeature`，随 I 批） | **0**（25/25 已落地；第 107 轮落 logExprErrors，probe 6 场景；第 29 轮落 strict 闭包 6 个） | 0 | ① + 真实 Go 二进制 stderr | 否 | 第 38 轮 |
| C | defines / inject / mangled props | `js_parser.go` 1748–1788、2851–2927、12619–12807、16598–16615 | **0**（9/9 已落地；第 107 轮落 instantiateInjectDotName，probe 4 场景；第 72 轮落 remapExprLocsInJSON；第 44 轮落 `isDotOrIndexDefineMatch`） | 0 | ① | 是 | 第 38 轮 |
| D | 解析侧补全 | `js_parser.go` 4137–4155、4220–4222、5019–5127、8470–8490（`willNeedBindingPattern`、`parseExprOrBindings`、`parseExprOrLetOrUsingStmt`、`parseFnBody`） | **0**（第 113 轮落 parseExprOrLetOrUsingStmt，4/4 已落地；原 3/4） | 0 | ① | 否 | 第 38 轮 |
| E | lowering / runtime 运行时助手 | `js_parser.go` 1790–1894、8624–8655、13401–13413、11854–11889 | **0**（9/9 已落地） | 0 | ①（模板 `</script>` 5 例在此） | 是 | 第 22 轮 |
| F-1 | visit 期：E-s2 正则判据 + 相等性诊断 | `js_parser.go` 13415–13548、12832–12934 | **0**（3/3 已落地） | 0 | ① | 是 | 第 27 轮 |
| F-2 | visit 收尾（prepareForVisitPass / glob / symbol-use 辅助） | `js_parser.go` 18319–18430、16617–16832、16834–16927、12939–13060、16030–16090、17058–17120 | **0**（第 113 轮落 maybeRewritePropertyAccess/checkAndPrepare/visitRightAndFinish/handleIdentifier，区间内已无未移植；原 4） | 0 | ① | 是 | 第 38 轮 |
| G-1 | minify：duplicate-case 族 + switch liveness | `js_parser.go` 750–1040、865–1035 | **0**（5/5 已落地） | 0 | ③ | 是 | 第 27 轮 |
| G-2 | minify 第一批 | `js_parser.go` 843–855、1113–1143、8800–8877（minify 第一批：fall-through / jump 判据 + 死代码保留） | **0**（9/9 已落地；第 28 轮机械核对发现 8 个早在第 22–27 轮落地，`mangleStmts` 计入 G-3） | 0 | ③ | 是 | 第 28 轮 |
| G-3 | minify 第二批 | `js_parser.go` 8884–9674、9676–10391、11612–12143（visitStmts / mangleStmts 及其被调函数） | **0**（第 33 轮 5 + 第 34 轮 captureValue + 第 35 轮 3 谓词 + 第 36 轮 `mangleStmts`/`mangleIf` + 第 43 轮 `substituteSingleUseSymbolInStmt`/`InExpr`/`minifySwitchStmt` 全落地；8 例逐字节等于 Go，见 g3-substitute-go.json；③ 2,501→2,517） | 0 | ③ | 是 | 第 39 轮 |
| H | glob / TS import-equals / 入口 / 选项 | `js_parser.go` 16617–16832、17270–17330、494–590、18137–18222 + `global_name_parser.go` 9–62 | **0**（第 112 轮落 LazyExportAST/GlobResolveAST，第 108 轮落 handleGlobPattern；区间内已无未移植）（第 107 轮落 maybeRelocateVarsToTopLevel（probe 6 场景）；第 72 轮落 OptionsForYarnPnP；第 44 轮落 `globPatternFromExpr` + `ParseGlobalName`；余 handleGlobPattern/LazyExportAST/GlobResolveAST） |  0 | ①（glob 需先补 glob 语料） | 否 | 第 38 轮 |
| I-1 | `js_parser_lower.go` 第一批（optional chain / template） | `js_parser_lower.go` 18–1275（optional chain / template + 由 I-2 移入 5 个） | **0**（第 40/41 轮落地 13：nullish/赋值/幂/对象展开/可选链/async 全链，接 visit 主链当轮验字节） | 0 | ①（需 target 降级语料，见 §4） | 否 | 第 37 轮 |
| I-2 | `js_parser_lower.go` 第二批（object rest / using） | `js_parser_lower.go` 1277–2152（object rest / using；其中 5 个已移入 I-1） | **0**（第 109 轮落 using 族 5：shouldLowerUsingDeclarations/lowerUsingDeclarationContext/scanStmts/finalize/lowerUsingDeclarationInForOf，Go 探针 5 场景逐字节；lowerTemplateLiteral 同轮从 js_parser.ts 归置到 js_parser_lower.ts 消除名实不符） | 0 | ①（同上） | 否 | 第 38 轮 |
| I-3 | `js_parser_lower.go` 第三批（function / 谓词） | 254–801 | **0**（第 41 轮落 lowerFunction/captureThis/captureArguments/markAsyncFn，接 visit 主链） | 0 | ①（同上） | 否 | 第 37 轮 |
| J-1 | `js_parser_lower_class.go` 第一批（private / super） | 14–379 | **0**（14/14 已落地；第 34 轮直调 + Go 8 条字节证据；名义 10 vs inventory 14 漂移已对账） | 0 | ①（需 target 语料） | 否 | 第 34 轮 |
| J-2 | `js_parser_lower_class.go` 第二批（class / field） | 683–1204 | **0**（17/17 已落地；第 37 轮 lowerClass 全链接 visitClass 三处调用点；名义 11 vs inventory 17 漂移已对账） | 0 | ①（同上） | 否 | 第 36 轮 |
| J-3 | `js_parser_lower_class.go` 第三批（process / auto-accessor） | 1219–1972 | **0**（并入 J-2 同链接链落地；名义 10 已对账） | 0 | ①（同上） | 否 | 第 37 轮 |
| K-1 | TS 语法族：独立判据第一批 | `ts_parser.go` 1024–1269 | **0**（8/8 已落地） | 0 | ②（直调单测） | 否 | 第 27 轮 |
| K-2 | TS 语法族第二批（type skipper） | `ts_parser.go` 177–1000 | **0**（12/12 已落地；第 35 轮直调 + Go 38 条字节证据） | 0 | ② | 否 | 第 34 轮 |
| K-3 | TS 语法族第三批（stmt / namespace） | `ts_parser.go` 1271–2086 | **0**（第 39 轮落 parseTypeScriptImportEqualsStmt；第 42 轮 enum/namespace 整链 6 个全落地：parseTypeScriptEnumStmt/parseTypeScriptNamespaceStmt/getOrCreateExportedNamespaceMembers/两个 generateClosure*/wrapInlinedEnum，7 例逐字节等于 Go，见 enum-chain-go.json） | 0 | ② | 否 | 第 38 轮 |
| L | sourcemap 反解 | `js_parser/sourcemap_parser.go` 18–436 | **0**（第 104 轮落 ParseSourceMap，17 例逐字节等于 Go） | 0 | 需 M2（`--sourcemap` 通道） | 否 | 第 38 轮 |
| M-1 | printer 剩余第一批（import call / source mapping） | `js_printer.go` 329–3542（部分） | **0**（第 113 轮落 printer binaryExprVisitor.checkAndPrepare/visitRightAndFinish，区间内已无未移植；原 2） | 0 | ①③（sourcemap 组用 M2） | 否 | 第 38 轮 |
| M-2 | printer 剩余第二批（TS enum / minify） | `js_printer.go` 369–3967（其余） | **0**（第 38 轮落 guardAgainst 3；第 42 轮落 parseSmallInt/mangledPropName/tryToGetImportedEnumValue(+UTF16)，共 3 个 Go 探针字节；余项记入 M-1） | 0 | ①③ | 否 | 第 38 轮 |
| N | `sourcemap` 包 | `sourcemap.go` 42–829 | **0**（19/19 已落地；第 30 轮 Go 探针 52 例，sha256 9cf61378…） | 0 | Go 探针 fixture（无 M2） | 否 | 第 30 轮 |
| O | helpers 剩余 | `serializer` 3、`timer` 5、`waitgroup` 4 | **0**（12/12 已落地；第 30 轮 Go 探针 4 例，sha256 86ae5e4b…） | 0 | Go 探针 fixture | 否 | 第 30 轮 |
| P | logger 剩余 | 全部落地（第 84 轮补 style_clang 2 + style_visualstudio 1；darwin/windows 不可达已登记） | **0**（第 84 轮 clang/visualstudio 3 个落地；第 72 轮 StringInJSTable 三件套；第 80 轮平台变体 6 个） | 0 | fixture + 平台分支（不可达的要显式登记） | 否 | 第 38 轮 |
| Q | `js_ast` 收尾 | `js_ast.go` 1650–1750（`ExprToConstValue` / `ConstValueToExpr`，第 78 轮落地） | **0** | 0 | ① + fixture | 否 | 第 39 轮 |
| | **合计** | | **0** | **0** | | | |

> **计数与承诺自校验（第 27 轮起由 `npm run doc:check` 机器校；第 28 轮加两条）**：
>
> 0. **CURRENT_ROUND 已推进到 31**：第 30 轮（N19+O12=31）已收口；第 31 轮落接线地基（stmtsKind + visitStmts 调用点 + mangleStmts 桩，函数数 0 但服务 G-3/J-1 真实落地）；`plan-check` 从 31 轮起校吞吐与常备通道。
> 1. 两列合计均 = **105 = 830 − progress.json.ported（725）**。
> 2. **每轮「本轮将落地函数数」合计 ≥ 12**：31=F-2(6)+P(12)=**18**；37=I-1(13)+I-2(7)+I-3(12)+L(4)=**36**；38=H(11)+K-3(7)+M-2(11)+C(3)+D(1)+B(1)=**34**；39=M-1(12)+G-3(3)+Q(2)=**17**。合计 **105**。第 37 轮 J-2+J-3 lowerClass 全链 17 个落地并接 visitClass 三处调用点（③ 2,454→2,479；① es2015 3,491→3,576）；名义 J-2 11 + J-3 10 = 21 与 inventory 17 的漂移已对账。
> 3. **收口轮次 = 第 39 轮**（表内最大承诺轮次；`plan-check.ts` 的 `CLOSEOUT_ROUND = 39` 硬校验，超过 39 或与最大承诺轮次不一致即 failure）。不再出现「24–27」这类区间或「—/顺延」占位。
> 4. 已落地 **708**；其中第 36 轮 +2（G-3 `mangleStmts`/`mangleIf` 接进 visitStmts 主链，③ minify equal 1,767→**2,454**、tsError 154→47；修打印机 ETemplate-inline 分支）；第 35 轮 +20（K-2 type-skipper 全族 15：`skipTypeScriptTypeWithFlags`/`skipTypeScriptObjectType`/`skipTypeScriptTypeParameters`/`skipTypeScriptTypeArguments`/`skipTypeScriptType`/`skipTypeScriptReturnType`/`skipTypeScriptBinding`/`skipTypeScriptFnArgs`/`skipTypeScriptParenOrFnType`/`trySkipTypeArgumentsInExpressionWithBacktracking`/`trySkipTypeScriptTypeParametersThenOpenParenWithBacktracking`/`trySkipTypeScriptArrowReturnTypeWithBacktracking`/`trySkipTypeScriptArrowArgsWithBacktracking`/`trySkipTypeScriptConstraintOfInferTypeWithBacktracking`/`isTypeScriptArrowReturnTypeAfterQuestionAndBeforeColon` + K-3 `skipTypeScriptInterfaceStmt`/`skipTypeScriptTypeStmt` 2 + G-3 `isSafeForConstLocalPrefix`/`tryToInlineCaseBody`/`maybeInlineIIFE` 3），第 34 轮 +15（J-1 private/super 14：`lowerPrivateBrandCheck`/`lowerPrivateGet`/`lowerPrivateSet`/`lowerPrivateSetUnOp`/`lowerPrivateSetBinOp`/`extractPrivateIndex`/`extractSuperProperty`/`lowerSuperPropertyOrPrivateInAssign`/`shouldLowerSuperPropertyAccess`/`callSuperPropertyWrapper`/`lowerSuperPropertyGet`/`lowerSuperPropertySet`/`lowerSuperPropertySetBinOp`/`maybeLowerSuperPropertyGetInsideCall` + G-3 `captureValueWithPossibleSideEffects` 1），第 33 轮 +5（G-3 浅依赖：mangleFor 等），第 32 轮 +1（couldPotentiallyThrow），第 30 轮 +31（N19+O12），第 29 轮 +6（strict 闭包），第 28 轮 +11。
> 5. **每轮至少一个「依赖 visit pass = 否」的批次且 ≥8**：31=P（12）、32=I-1（12）、33=H（11）、34=K-2（12）、35=I-3（12）、36=J-2（11）、37=J-3（10）、38=M-2（11）/K-3（7）、39=M-1（12）。G-3（33）作「是」批次与「否」批次同轮；J-1（34）/K-2（34/35）自身即「否」批次（已落 14/12），与 K-2（35）同轮。
> 6. **12 是地板不是目标**：收口 31/37/38/39 四轮吃 105，平均 **26.25/轮**（第 37 轮实落 17 个函数 + ① 三档各 +85 已超前）。第 36 轮 +2（mangleStmts/mangleIf + ③ +687）与第 37 轮 +17 均为「当轮移植 + 当轮接主链 + 当轮验字节」。落后就当场重排，不许改地板。
> 7. **第 28 轮的诚实披露**：承诺 17（B 8 + G-2 9），实落地 **11**（B 6 + C 4 + 1 个未归属函数）；未达 17 的根因是 §2 计数与 `inventory.json` 的落地集错位——G-2 行列出的 9 个函数里有 **8 个早在第 22–27 轮已落地**（机械核对：`caseBodyCouldHaveFallThrough` `js_parser.ts:8319`、`isJumpStatement` `:7872`、`jumpStmtsLookTheSame` `:7878`、`shouldKeepStmtsInDeadControlFlow` `:7998`、`shouldKeepStmtInDeadControlFlow` `:8011`、`visitStmtsAndPrependTempRefs` `:2027`、`visitStmts` `:2034`、`warnAboutDuplicateProperties` `:4825`），唯一真未落地的 `mangleStmts`（`js_parser.go:9156`，519 行）依赖 G-3 的 13 个被调函数，已整组挪到 G-3。**没有用「把已落地的函数再计一遍」凑数。**
> 8. §2.1 的 F-s5（698 行）顺延到第 31 轮：第 31 轮已有 18 个 §2 批次函数（P12+F-2 6），满足大接线片不独占一轮。第 31 轮的 visitStmts kind 改造是 F-s5 的真实前置地基（已落地）。
> 10. **第 30 轮实落 31 个**（sourcemap 整包 19 + helpers 12），远超 16.5/轮节奏；N/O 两批归零，腾出的轮次额度已重排到 30–39。
> 9. B 在第 29 轮落地 strict 闭包 6 个（`js_parser_lower.ts` 4 + `js_parser.ts` 2），§2.2 #2 的 E-s1c 前置已解除；只剩 `logExprErrors`，其前置 `markSyntaxFeature` 仍需 `fnOrArrowDataVisit.tryBodyCount` 与 20 个 compat 位。

### 2.1 F/E 切片表 v2（第 24 轮按 `inventory.json` 实测行数重切）

> **第 23 轮的真结论写进表里**：「一个 Stmt/Expr 种类」≠「一截可独立编译的代码」。实测：`visitAndAppendStmt` 1,218 行、`visitExprInOut` 2,424 行、`visitClass` 371 行、`visitRightAndFinish` 530 行。
>
> 所以 v2 的切片单位改成「**函数**」，每片必须同时满足：① 切片内自洽可编译；② 能跑一条 Go 字节断言（`tools/go/tmpgenparseprint` 当场跑）。行数为 `inventory.json` 的 `end − start + 1` 实测值。
>
> **升级条款**：若第 25 轮 F 仍为 0，放弃按片切，直接整段搬 `visitBinding → visitFn → visitClass → visitExprInOut` 主体，不再按 Stmt 种类切第五次。
>
> **承诺轮次（第 26 轮新增，第 27 轮改硬）**：`承诺轮次` 列由 `tools/plan-check.ts` 机器校验：
>
> 1. **所有片（含已落地）都参与算术**：已落地写「第 N 轮（已落地）」，不再用「—」滑过；
> 2. 同一轮最多 **3 片**；
> 3. **接线预算**：同一轮里 `Go 行数 ≤ 600` 的片的行数合计必须 ≤ 600；
> 4. **大接线片不许独占一轮**：单片 `Go 行数 > 600`（F-s5 698 / E-s3 944 / E-s6 950）自身不计入接线预算，但那一轮必须同时带上 **≥12 个来自不依赖该片的批次**的函数（由 §2 批次表的「每轮 ≥12」机器钉死）；
> 5. 已登记例外只有一笔：第 26 轮 F-s1c 410 + F-s2 195 = **605 行** > 600（上一轮执行令锁定的历史承诺；函数行数 481+371=852）。除它以外，任何轮超限都是 `doc:check` failure。
>
> 改表后先跑 `npm run doc:check`：超限会直接按算术报错，滑期只能表现为算术失败。
>
> **`本片新增 Go 函数` 列的口径**（第 26 轮新增）：只数 `inventory.json` 里独立命名的 Go 函数；`visitAndAppendStmt` / `visitExprInOut` 的 switch 分支本身不增加函数计数（§3 的同一口径）。所以 F-s3/F-s4/F-s5/F-s6/E-s5/E-s6 的该列是 0——它们是分支接线，不是新函数。

| 片 | 内容（Go 行号 / 实测行数） | Go 行数 | 本片新增 Go 函数 | 前置依赖 | 可独立编译 | 验收 | 状态 | 承诺轮次 |
| --- | --- | ---: | ---: | --- | --- | --- | --- | --- |
| F-s1a | `visitBinding` 10083（58）+ `SLocal` 分支 10721–10862（142） | 200 | 1（`visitBinding`） | `recordDeclaredSymbol`、`selectLocalKind`（已落）、`visitExpr`→`visitExprInOut` 字面量分支（E-s1） | ✅ | `tmpgenparseprint` 的 SLocal 语料字节 + Go 语句 dump | 已落地（第 24 轮） | 第 24 轮（已落地） |
| F-s1b | `SFunction` 11319–11377（59）+ `visitFn` 17205（45） | 104 | 3（`visitFn`/`visitArgs`/`visitStmtsAndPrependTempRefs`） | F-s1a | ✅ | ①（函数声明/表达式） | 已落地（第 25 轮） | 第 25 轮（已落地） |
| F-s1c | `SClass` 11378–11416（39）+ `visitClass` 12177–12547（371） | 410 | 1（`visitClass`；另依赖 J 批 `computeClassLoweringInfo` 227、`privateSymbolNeedsToBeLowered` 4） | F-s1b + `visitDecorators` 12145（19）+ `isSimpleParameterList` 12549（11）+ `fnBodyContainsUseStrict` 12561（15） | ✅ | ① + class 语料 Go 字节（static block / private / decorator / computed key） | 已落地（第 26 轮） | 第 26 轮（已落地） |
| F-s2 | `SImport`/`SExportClause`/`SExportFrom`/`SExportStar`/`SExportDefault`/`SExportEquals` 10426–10620（195） | 195 | 5（`recordExport` 11、`appendPart` 54、`scanForImportsAndExports` 349、`checkForUnusedTSImportEquals` 42、`scanForUnusedTSImportEquals` 18） | `declareSymbol`（已落）；`findSymbol` 的 unbound 结算 | ✅ | ① + import/export 全形态 Go 字节（含 `export {x}; let x`） | 已落地（第 26 轮） | 第 26 轮（已落地） |
| F-s3 | `SExpr`/`SReturn`/`SThrow`/`SBlock`/`SWith` 10863–10934（72） | 72 | 0（纯分支接线） | `visitStmtsAndPrependTempRefs` 8884（67） | ✅ | ①（with 语料） | 已落地（第 27 轮） | 第 27 轮（已落地） |
| F-s4 | 循环与 `SIf` 10935–11139（205） | 205 | 0（纯分支接线） | F-s3 + `visitLoopBody` 9981（8）+ `visitForLoopInit` 10035（27） | ✅ | ① | 已落地（第 27 轮） | 第 27 轮（已落地） |
| F-s5 | `STry`/`SSwitch`/`SBreak`/`SContinue`/`SLabel` 10621–11318（698） | 698 | 0（纯分支接线） | F-s4 + `findLabelSymbol`（已落） | ✅ | ① | 未落地 | 第 38 轮 |
| F-s6 | `SEnum`/`SNamespace`/`STypeScript`/`SDirective`/`SEmpty` 10399–10425、11417–11610（221） | 221 | 0（纯分支接线） | K 批（TS 语法） | ❌（依赖 TS 通道） | ② | 未落地 | 第 29 轮 |
| E-s1 | `ENull`/`ESuper`/`EBoolean`/`EUndefined`/`EBigInt` 13563–13575（13）+ `EString`/`ENumber` 13606–13631（26） | 39 | 0（纯分支接线） | 无（`checkForLegacyOctalLiteral`/`parseBigIntOrStringIfUnsupported` 已落） | ✅ | ① + Go 字节 | 已落地（第 24 轮） | 第 24 轮（已落地） |
| E-s1b | `EThis` 13632–13647（16）+ `EImportMeta` 13648–13698（51） | 67 | 2（`valueForThis` 54、`valueForImportMeta` 16） | 无 | ✅ | ① | 已落地（第 25 轮） | 第 25 轮（已落地） |
| E-s1c | `EIdentifier` 13702–13800（99） | 99 | 1（`handleIdentifier` 140） | `validateDeclaredSymbolName` 6387（7）+ strict-mode 闭包 | 单列（§2.2） | ① | 未落地 | 第 29 轮 |
| E-s2 | `ERegExp` 13579–13600（22）+ `ENameOfSymbol`/`ENewTarget`（2）+ `ETemplate` 14114–14206（93） | 117 | 1（`isUnsupportedRegularExpression` 134） | `lowerTemplateLiteral`（已落） | ✅ | ①（正则/模板语料） | 已落地（第 27 轮） | 第 27 轮（已落地） |
| E-s3 | `EBinary`/`EDot`/`EIndex` 14207–14620（414）+ `visitRightAndFinish` 16067（530） | 944 | 2（`checkAndPrepare` 36、`visitRightAndFinish` 530） | 单列（§2.2） | 单列（§2.2） | ① | 未落地 | 第 38 轮 |
| E-s4 | `ESpread`（3）+ `EUnary`/`EIf`/`EAwait`/`EYield` 14621–14836（216） | 216 | 2（`maybeLowerAwait` 20、`couldPotentiallyThrow` 8） | I 批部分 | ✅ | ① | 未落地 | 第 32 轮 |
| E-s5 | `EArray`/`EObject` 14837–15025（189） | 189 | 0（纯分支接线） | `warnAboutDuplicateProperties`（已落） | ✅ | ① | 未落地 | 第 29 轮 |
| E-s6 | `EImportCall`/`ECall`/`ENew`/`EArrow`/`EFunction`/`EClass` 15026–15975（950） | 950 | 0（纯分支接线；`lowerFunction`/`lowerClass` 记在 I/J 批） | `valueToSubstituteForRequire`（已落）、`captureThis`、`lowerFunction`/`lowerClass` | ❌（等 I/J） | ① | 未落地 | 第 38 轮 |
| E-s7 | `EJSXElement` 13801–14113（313） | 313 | 0（解析期已用 `lowerJSXElement` 复刻） | — | — | ①（JSX 16 例） | 未落地 | 第 39 轮（M2 后） |

### 2.2 单列清单（第 24 轮：≤3 项，写调用点 + 并入位置 + 原因）
| # | 项（Go 行 / 行数） | 调用点函数（Go 行） | 被并入位置 | 原因 |
| ---: | --- | --- | --- | --- |
| 1 | `SClass` 11378–11416（39）+ `visitClass` 12177–12549（371） | `visitAndAppendStmt` 的 `case *js_ast.SClass`（11378） | F-s1c | `visitClass` 单函数 371 行，且还缺 `visitDecorators`/`isSimpleParameterList`/`fnBodyContainsUseStrict` 三个函数；和 SLocal 片放同一轮会突破单片 2 小时根因阈值 |
| 2 | `EIdentifier` 13702–13800（99） | `visitExprInOut` 的 `case *js_ast.EIdentifier`（13702） | E-s1c | 依赖 `validateDeclaredSymbolName`（6387）+ strict-mode 闭包 `markStrictModeFeature`/`whyStrictMode`/`whyESModule`（`js_parser_lower.go:132-236`）；TS 侧 strict 状态在 parse 期已消费，需先决定 visit 通道的 strict 上下文来源 |
| 3 | `visitRightAndFinish` 16067（530） | `visitExprInOut` 的 `EBinary` 分支调用（14207 起） | E-s3 | 530 行单函数 + 依赖 `checkAndPrepare`（36）；与 `EBinary`/`EDot`/`EIndex`（414 行）合并后单片 1,000 行级，必须整片搬，不能按 Expr 种类拆 |

## 3. 排序理由（依赖顺序，不按名字）

1. **作用域 / 符号收尾（A）先做**：visit pass（F）与 minify（G）都依赖 `popAndFlattenScope` / `discardScopesUpTo` / `declareBinding` 的作用域模型；先补它们，F/G 才不会边写边改地基。
2. **解析侧补全（D）与运行时助手（E）第二**：`parseFnBody` / `parseExprOrBindings` 是 parse pass 的缺口，`generateTopLevelTempRef` / `callRuntime` 是 lowering（I/J）与模板 `</script>`（E）的前置。
3. **visit pass（F）第三**：M1 的 97 例差异里绝大多数落在 visit pass 的语义（`undefined` 赋值目标、IIFE 括号、注释位置），但 F 是 2,400 行的整函数，必须整段搬而不是按例补。
4. **minify（G）与 TS（K）第四**：两者都**不再阻塞 ① 通道**——它们分别走 ③ / ② 语料；这两组语料第 21 轮已补好并钉死（§2 通道口径），因此 G/K 的函数可以在不推高 ① 的前提下成批落地。
5. **printer / sourcemap / helpers / logger（M/N/O/P/Q）最后**：M 的 sourcemap 组与 N 都依赖 M2 的 linker 通道；O/P 大多是平台或 I/O 函数，Linux 上不可达的分支必须显式登记「不可达」，不能拿覆盖率凑数。

## 4. 已知的通道缺口（必须在对应批次开工前补语料）

| 批次 | 缺口 | 补法 |
| --- | --- | --- |
| I / J | ① 是 `target=esnext`，`lower*`（optional chain / object rest / class / using）**不触发** | **第 28 轮已补**：`tools/parseprint.json` 的 `modes` 新增 es2015/es2016/es2017 三档，位掩码由 Go 探针实测，equal 基线 3,491 / 3,529 / 3,696（tsError 0），`m1:check` 已重跑通过 |
| H | glob import 语料（`import * as ns from "./glob/*.js"`）在 4,238 例里覆盖不足 | 用 `tools/go/tmpgenparseprint` 单独钉一组 glob 用例（先确认 Go 侧 `GlobResolveAST` 的入口） |
| L / N / M（sourcemap 组） | Parse+Print 不经 linker，`--sourcemap` 在 M2 才有通道 | 与 M2 一起做；M1 收口时这 4+19+5 个函数只能登记「已移植 + 单测执行」，不能登记「已等价」 |
| P | darwin / windows 分支在 Linux 不可达 | 只做 `logger.go` 与 `style_*` 的 Linux 可达部分；不可达的按「平台分支」单独登记，不冒充执行 |

## 5. 差异侧（本轮只做有结构的两件，时间盒 ≤ 本轮 1/3）

1. **注释簇 17 例**：按 `docs/m1-diff-clusters.md` 附录 B 的 token 对做二次聚类，≥3 例同型才动手；已确证候选：`printIndentedComment` 的 `//!` 缩进、`for ((/* foo */ let).x of y)` 的 `forbidIn` 括号。
2. **`json_parser.go` 4 个函数**（`ParseJSON` / `isValidJSON` / `jsonParser.parseExpr` / `jsonParser.parseMaybeTrailingComma`）：第 21 轮已完成（见 §7），把 `ParseDefineExpr` 的 partial 补成 1:1。
3. **「其他 72」禁止逐例扫**：单点例写进 `docs/m1-gap-map.md` §5 并写明不动理由。

## 6. 复现

```bash
cd /root/port
node --experimental-strip-types tools/m1.ts            # 三组口径（js/ts/minify）→ m1.json
node --experimental-strip-types tools/m1.ts --check    # 默认三档（js/ts/minify），~69s；target 三档基线仍在 parseprint.json 里但不逐轮校
node --experimental-strip-types tools/m1.ts --check --target-modes  # 六档全校（第 29 轮 I-1 开工时强制跑一次），~130s
node --experimental-strip-types tools/m1.ts --clusters  # docs/m1-diff-clusters.md（只针对 js 组）
npm run doc:check                                      # 算术恒等式 + 逐包合计 + 虚报行核对（inventory AST）；防 G-2 错位重演

# 剩余函数名单（机械）：progress.json + inventory.json，逐包/逐文件
node --experimental-strip-types tools/progress.ts
node -e 'const inv=require("./inventory.json");console.log(inv.filter(x=>!x.test&&x.pkg==="internal/js_parser").length)'
```

## 7. 第 21 轮在这张表上的落点

- 已完成：**A 之外的 D/E 前置**——`json_parser.go` 4 个 + `helpers/path.go:10` 1 个（共 5 个；通道 ①，Go 字节见 `testdata/js_parser/json.json`、`testdata/helpers-path.json`）。
- 已完成：**通道 ②③ 语料**（§2 口径，`tools/parseprint.json` 的 `modes` 字段，只许升/只许降）。
- 未开始：A/B/C/D/E/F/G/H/I/J/K/L/M/N/O 的其余函数（截至第 113 轮仍剩 0 个函数（M1 收口）；P/logger 与 Q 已全部落地）。
