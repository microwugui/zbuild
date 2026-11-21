# M1 差异簇 → Go 函数 → 未移植函数 的缺口地图（第 20 次推进，v1）

> 目的：把「206 例差异 / 248 个未移植 js_parser 函数 / 已移植函数内部」三张皮并成一张表，回答一个问题：
> **下一刀应该落在哪个 Go 函数上，以及它是否在 M1 的 Parse+Print 通道上。**
>
> 数据源（全部机械可复现）：
> - 差异与聚类：`npm run m1 -- --clusters` → `m1.json` 的 `summary`、`docs/m1-diff-clusters.md`；
> - 未移植函数清单：`inventory.json`（`go run tools/inventory.go`）× `tools/progress.ts` 的同名 AST 判定；
> - Go 行号：`/root/esbuild/internal/js_parser/js_parser.go`、`internal/js_printer/js_printer.go`（commit `f6058f83`）；
> - 函数级执行证据：`coverage-m1/`（`NODE_V8_COVERAGE=coverage-m1 npm run m1`）与 `equiv-map.json`。
>
> 记法：`P` = 已移植（含 partial，见备注）；`—` = 未移植；「可达」= 在 M1 的默认 options（无 minify、无 sourcemap、target=esnext、JS-only）下会被调用。

## 0. 本轮读数（第 20 轮收口 → 第 21 轮收口）

| 指标 | 第 19 轮 | 第 20 轮 | 第 21 轮 |
| --- | ---: | ---: | ---: |
| 逐字节相等 | 4,032 / 4,238（95.1%） | 4,132 / 4,238（97.5%） | **4,136 / 4,238（97.6%）** |
| `three/package/src` | 753 / 757 | 756 / 757（99.9%） | **756 / 757** |
| `three/package/build` | 1 / 5 | 3 / 5 | **3 / 5** |
| `esbuild-cases` | 3,278 / 3,476 | 3,373 / 3,476（97.0%） | **3,377 / 3,476（97.2%）** |
| TS parse/print 失败 | 0 | 0 | **0** |
| 差异例 | 206 | 106 | **102** |
| trivial equal（≤64B/空） | 3,128 / 4,032（77.6%） | 3,203 / 4,132（77.5%） | **3,207 / 4,136**；扣掉后 21.9% |
| 已移植函数 | 502 | 517（js_parser 57 → 72） | **522**（js_parser 72 → 76；helpers 66 → 67） |
| 期望值来源（Go 实测登记） | 403 | **418**（+15：`internal/js_parser` 56 → 71，来自 `tools/go-verified.json` 的逐函数登记；见 §4） | **422**（+4：`internal/js_parser` 71 → 75，json_parser 四函数；见 §4.1） |
| ts 通道（`ts.Parse=1 + jsx.Parse=1`） | — | — | **4,103 / 4,238（tsError 0）** |
| minify 通道 | — | — | **1,762 / 4,238（tsError 154）** |

## 1. 四个结构簇：具体 Go 函数、是否已移植、是否 M1 可达

### 1.1 JSX pragma（`@jsx` / `@jsxFrag` / `@jsxRuntime` / `@jsxImportSource`）：32 → **0**

| Go 函数（文件:行） | 已移植 | M1 可达 | 说明 |
| --- | :---: | :---: | --- |
| `ParseDefineExpr`（js_parser.go:18224） | P（partial） | 是 | 属性链分支逐字移植；JSON 值分支用 `JSON.parse` 只处理基元（`json_parser.go` 未移植，已登记） |
| `instantiateDefineExpr`（js_parser.go:12678） | P（partial） | 是 | 特殊名（NaN/Infinity/null/undefined/this/import.meta）+ 属性链；`defines`/`injectedDotNames` 未移植 |
| `importJSXSymbol`（js_parser.go:1818） | P | 是 | jsx/jsxs/Fragment/createElement 四路 |
| `generateImportStmt`（js_parser.go:18532） | P（partial） | 是 | TS 只有一个 Part，故只返回 `SImport`；DeclaredSymbols/namedImports 未落 |
| `sortedKeysOfMapStringLocRef`（js_parser.go:18597） | P | 是 | — |
| `visitExprInOut` 的 `EJSXElement` 分支（js_parser.go:13801-14111） | —（整函数未移植） | 是 | TS 用 `lowerJSXElement` 复刻该分支的 createElement / jsx() / key / children 逻辑 |
| pragma 应用段（js_parser.go:18373-18420） | P（内联） | 是 | Go 在 visit pass 开头应用；TS 因 lowering 在 parse 期，改为**预扫注释**（见 §2.3） |

> 32 例全部收口的原因不是「簇落回已移植函数」，而是上面 5 个 Go 函数 + 那段 pragma 逻辑被真正补上；`automatic` 的 16 例依赖 `generateImportStmt` 生成 `import { jsx } from "react/jsx-runtime"`。

### 1.2 块级函数声明 hoisting（Annex B）：25 → **0**

| Go 函数（文件:行） | 已移植 | M1 可达 | 说明 |
| --- | :---: | :---: | --- |
| `hoistSymbols`（js_parser.go:1535） | P（partial） | 是 | 只落 sloppy 块级函数的兄弟符号 + 父作用域碰撞删除；`MustNotBeRenamed`/catch 合并等未落 |
| `canMergeSymbols`（js_parser.go:1391） | P | 是 | 全部规则逐字移植（含 private get/set、catch/arguments） |
| `addSymbolAlreadyDeclaredError`（js_parser.go:1467） | P | 是 | 诊断文案与 Go 二进制一致（单测钉住） |
| `mergeSymbols`（js_parser.go:1358） | **—** | 是（被 `declareSymbol` 的 `ReplaceWithNew` 路径覆盖） | Go 的 `declareSymbol` 自己只写 `symbol.Link`，不调用 `mergeSymbols`；本轮不落避免「无调用点空壳」 |
| `parseFnStmt` 的 `hasIfScope`（js_parser.go:6803） | P（分支） | 是 | `if (1) function f(){}` 的假 ScopeBlock |
| `parseStmt` 的 `TOpenBrace` 作用域（js_parser.go:8255） | P（分支） | 是 | TS 之前**没有块作用域**，这是 25 例的结构性根因 |
| `visitStmts`（js_parser.go:8960） | P（partial） | 是 | 只落块级函数降级为 `let` + `var` 的分支 |
| `visitSingleStmt`（js_parser.go:9990） | P（partial） | 是 | 只做「单语句 → 必要时包块」 |
| `stmtsToSingleStmt`（js_parser.go:10025） | P | 是 | — |
| `recordDeclaredSymbol`（js_parser.go:10063） | P（partial） | 是 | 只累计 `DeclaredSymbols`；TopLevel 判定同 Go |
| `recordUsage`（js_parser.go:1727） | P（partial） | 是 | 只增减 `UseCountEstimate`；part 级/TS 计数未落（只影响 minify 命名） |

### 1.3 可选链 continuation / 调用目标括号：21 → **1**

| Go 函数（文件:行） | 已移植 | M1 可达 | 说明 |
| --- | :---: | :---: | --- |
| `parseSuffix`（js_parser.go:4264）的 `optionalChain` 状态机 | P（分支） | 是 | `oldOptionalChain` / `OptionalChainContinue` 逐字对齐；TS 之前完全没有这个状态 |
| `parseSuffix` 的 `afterArrowBodyLoc`（js_parser.go:4269） | P（分支） | 是 | 顺带修掉 `x => {}\n(0)` 被解析成 IIFE 的 2 个「注释簇」误归类 |
| `printExpr` 的 `ECall`（js_printer.go:2303，wrap 2376-2385） | P（分支） | 是 | `@__PURE__` 分支的 `wrap` 条件补齐（Go: `hasPureComment && level >= LPostfix`） |
| `visitExprInOut` 的 IIFE 标记（js_parser.go:15282） | P（等价分支） | 是 | `ECall` 目标是 `EFunction` 时置 `IsParenthesized` |
| `visitExprInOut` 的 `forbidIn` 括号（js_printer.go:3431 / 2005） | — | 是 | 剩余 1 例 `for (1 * (x == a in b);;);`：TS 多打一层 `in` 括号，属单点边角（Go 的 `forbidIn` 传播规则） |

### 1.4 注释位置（表达式/语句级）：19 → **17** → **13**（第 21 轮：合法注释双层缩进修掉 4 例）

| Go 函数（文件:行） | 已移植 | M1 可达 | 说明 |
| --- | :---: | :---: | --- |
| `saveExprCommentsHere`（js_parser.go:3476） | P | 是 | 注释挂到 `Loc` → `exprComments` |
| `printExprCommentsAtLoc`（js_printer.go:1917） | P | 是 | — |
| `printExprCommentsAfterCloseTokenAtLoc`（js_printer.go:1955） | P | 是 | — |
| `willPrintExprCommentsAtLoc`（js_printer.go:549） | P | 是 | — |
| `printIndentedComment`（js_printer.go:3905） | P | 是 | 已定位 1 例 `//!` 合法注释缩进（4 空格 vs 2 空格），未修 |

> 17 例的剩余首差异 token 已由 `docs/m1-diff-clusters.md` 附录 B 机械分组（`"\n "→"/*"`、`"()"→"/*"`、`"(x"→"/*"`、`"//"→"  "` 等）。按纪律：**下一轮先对 17 例做 ≤10 行最小复现聚类，≥3 例同型才动手**；本轮只确证了两个子根因（`//!` 缩进；`for ((/* foo */ let).x of y)` 的括号）。

## 2. 「其他 72」的处理（禁止逐例扫）

- 现状：`classifyDiff` 是 **token 对 + 源码特征** 的机械启发式，72 例被判定为「其他」。这 72 例不是 72 个独立 bug，而是分类器覆盖不到的形态。
- 下一轮的唯一做法：先跑 `npm run m1 -- --clusters` 取附录 B 的 token 对，再按「Go 首差异片段」做**二次聚类**，≥3 例同型才立簇；单点例写进 §4「已知边角」并说明不动理由。
- 本轮已经用这个方法确证并修掉的：`a?.[b](c)`（26 例）、IIFE 目标括号（10 例）、`x => {}\n(0)`（2 例）、`export {x}; let x`（7 例）。

## 3. 未移植 js_parser 函数与 M1 的关系（248 个的分类）

| 类别 | 约数 | 代表函数（inventory 名） | M1 可达 | 处理时点 |
| --- | ---: | --- | :---: | --- |
| visit pass / 降级（unsupported features、minify 除外） | ~90 | `visitAndAppendStmt`、`visitExprInOut`、`mangleStmts`、`lowerClass`、`lowerOptionalChain`、`lowerObjectSpread`、`lowerUsingDeclaration*` | 仅其中少数在默认 target 触发 | M1 只按差异簇取分支；整函数留给 M2/M4 |
| TS 语法（`ts.Parse`） | ~45 | `skipTypeScript*`、`parseTypeScriptEnumStmt`、`parseTypeScriptNamespaceStmt`、`trySkipTypeArguments*` | 否（M1 是 JS-only） | M3 |
| minify 专用 | ~15 | `mangleStmts`、`mangleIf`、`substituteSingleUse*`、`minifySwitchStmt` | 否（M1 不开 minify） | M2 |
| JSON 解析（defines 用） | 4 | `ParseJSON`、`isValidJSON`、`jsonParser.parseExpr`、`jsonParser.parseMaybeTrailingComma` | 仅 `ParseDefineExpr` 的 JSON 分支 | 下一轮（把 `ParseDefineExpr` 的 partial 补全） |
| 入口/配置 | ~6 | `OptionsFromConfig`、`OptionsForYarnPnP`、`ParseSourceMap` | 否 | M2 |
| 作用域/符号收尾 | ~8 | `popAndDiscardScope`、`popAndFlattenScope`、`discardScopesUpTo`、`declareBinding`、`checkForUnrepresentableIdentifier` | 部分 | 按需 |
| 诊断/警告 | ~20 | `forbidLexicalDecl`、`warnAboutTypeofAndString`、`markSyntaxFeature` | 部分 | 按需（不影响字节） |
| 其他 | ~60 | `parseFnBody`、`parseExprOrBindings`、`maybeRewritePropertyAccess`、`captureThis`… | 部分 | 按差异簇 |

> 结论：**「248 个未移植函数」与「106 例差异」不是同一张网**。M1 的可达面集中在 visit pass 的少数分支；把整函数逐个搬过来并不会线性减少差异。本轮按差异簇取分支，新增 15 个 Go 同名函数（§4），并保持「已移植未测试 0」。

## 4. 本轮新增的 Go 同名函数（15 个）

| # | 函数（Go 文件:行） | 调用点 | 覆盖证据 |
| ---: | --- | --- | --- |
| 1 | `instantiateDefineExpr`（js_parser.go:12678） | `lowerJSXElement` | `js_printer.test.ts` P20 表（Go 字节） |
| 2 | `importJSXSymbol`（1818） | `lowerJSXElement` | 同上（jsx 16 例） |
| 3 | `generateImportStmt`（18532） | `toAST` | 同上（`import { jsx } …`） |
| 4 | `sortedKeysOfMapStringLocRef`（18597） | `toAST` | 同上（`Fragment, jsx` 排序） |
| 5 | `ParseDefineExpr`（18224） | pragma 应用 | 同上（`@jsx a.b.c`） |
| 6 | `hoistSymbols`（1535） | `Parse` 末尾 | P20 表 hoist 9 例 |
| 7 | `canMergeSymbols`（1391） | `declareSymbol` | `js_parser.test.ts` 重复声明诊断 |
| 8 | `addSymbolAlreadyDeclaredError`（1467） | `declareSymbol` | 同上（Go 二进制文案） |
| 9 | `visitStmts`（8960，块级函数分支） | `Parse` 末尾 | P20 表（let/var 降级） |
| 10 | `visitSingleStmt`（9990） | `Parse` 末尾 | P20 表（`if (1) function`、label） |
| 11 | `stmtsToSingleStmt`（10025） | `visitSingleStmt` | 同上 |
| 12 | `recordDeclaredSymbol`（10063） | `visitStmts` | P20 表（var 分支被执行） |
| 13 | `recordUsage`（1727） | `visitStmts` | 同上 |
| 14 | `parseExprWithFlags`（4228） | `parseSuffix` 的 `? :` | 现有 4,238 例 |
| 15 | `validateFunctionName`（6374） | `parseFnStmt` / `parseFnExpr` | 现有 4,238 例 |

**未达 20 的原因（如实记账）**：另外 5 个候选是 `mergeSymbols`（无调用点）、`parseFnBody`（需要把参数作用域成员复制一起搬，半搬会改变语义）、`declareBinding`（TS 的 `parseBinding` 直接声明，没有独立调用点）、`isStrictMode`/`isStrictModeOutputFormat`（只在 visit pass 用）。为凑数硬拆会违反「不落无调用点/无期望值的空壳」，所以本轮停在 15。

## 4.1 第 21 轮新增的 Go 同名函数（5 个）

| # | 函数（Go 文件:行） | 调用点 | 覆盖证据 |
| ---: | --- | --- | --- |
| 1 | `ParseJSON`（`json_parser.go:189`） | `ParseDefineExpr` | `testdata/js_parser/json.json`（44 例，常驻生成器 `tools/gen_js_parser_json_fixture.go`） |
| 2 | `jsonParser.parseExpr`（`json_parser.go:36`） | `ParseJSON` | 同上（null/bool/number/string/array/object/嵌套/trailing comma/重复 key/`__proto__`/bigint/非法 JSON） |
| 3 | `jsonParser.parseMaybeTrailingComma`（`json_parser.go:22`） | `jsonParser.parseExpr` | 同上（`JSON does not support trailing commas` 文案） |
| 4 | `isValidJSON`（`json_parser.go:218`） | 无（Go 仅 YarnPnP 路径调用，TS 未移植） | `testdata/js_parser/is-valid-json.json`（20 例，包内临时 `_test.go`） |
| 5 | `IsInsideNodeModules`（`helpers/path.go:10`） | `jsonParser.suppressWarningsAboutWeirdCode` | `testdata/helpers-path.json`（19 例，`tmpgenpath`） |

> `ParseDefineExpr` 由 partial 补成 1:1（基元进 `Constant`、复合值直接返回、BigInt 支持），它是第 20 轮已登记的 15 个之一，**不重复计数**。

## 5. 已知边角（明确不动，不占下一轮时间盒）

| 用例 | 现象 | 理由 |
| --- | --- | --- |
| `esbuild-cases/353b132557cf.js` 等 5 例 | `@__PURE__ */` 注解缺失（`Object.create` / `RegExp.escape`） | Go 在 `visitExprInOut` 的 ECall 分支做纯函数识别（`js_parser.go:15578-15598`），TS 只有 ENew 版本；属 visit pass 批次（`docs/m1-closeout-plan.md` F），不在单点扫描里改 |
| `three/package/src/nodes/display/ColorAdjustment.js` 及 2 个 build 产物 | 调用实参里对象属性 `Key` 位置的注释丢失（ASC CDL 那行） | 同一源码行的 3 个产物，根因是 `exprComments` 在 `Key` 上的挂载；属注释挂载机制，留给 visit pass 批次 |
| `esbuild-cases/066ac3fb2081.js`、`afd8bdddffcc.js` | `for ((/* foo */ let).x of y)` 的括号与注释位置 | `forbidIn` 传播 + `(let)` 括号，两例子同型但机制跨 parser/printer；第 21 轮时间盒只做了 ≥3 例的簇 |
| `esbuild-cases/0b9fa734e490.js`、`74535bdc1b0b.js` | `0 && ...` / `1 || ...` 死代码未消 | visit pass 的 `&&`/`||` 常量折叠（`visitExprInOut`） |
| `esbuild-cases/6b3033449d69.js` | `π.𐀀` 应打印成 `π["𐀀"]` | 单点；printer 的 dot vs index 判定（非标识符属性名） |
| `esbuild-cases/3eb5a43605f0.js` | `for (1 * (x == a in b);;);` 多一层 `in` 括号 | 单点；Go 的 `forbidIn` 传播规则，需整段对照 `printExpr` 的 flag 传递 |
| `esbuild-cases/3743b66ef793.js` 等 3 例 | 字符串控制字符转义（`\0`/`\u0000`） | 属 `printUnquotedUTF16` 的 `\0` 规则，单簇 ≤3 例 |
| `three-build` 2 例 | 构建产物里的 `let`/`const` 差异 | 与源码同源，属同一 hoisting/注释规则；three-src 已 756/757 |

## 6. 复现

```bash
cd /root/port
npm run m1                    # 4,238 例，写 m1.json
npm run m1 -- --clusters      # 写 docs/m1-diff-clusters.md（簇 + 首差异 token 对）
npm run m1 -- --dump <caseId> # 单例 Go/TS 字节
NODE_V8_COVERAGE=coverage-m1 npm run m1   # 函数级执行证据（equiv-map 用）
node --experimental-strip-types tools/equiv-map.ts   # 写 equiv-map.json / docs/equiv-map.md
```
