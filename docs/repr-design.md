# M1 表示设计：Go 版 esbuild AST 紧凑化

阶段：M1（表示设计）。前置：M0 已过（5/5 入口字节等价 + `go test ./...` 全绿，见 `../baselines/m0-result.md`）。
本文只做设计与取证，**不改源码**；源码改造是 M2。

## 1. 代码事实（以源码为准，纠正立项书估算）

立项书写「43 类型 / 171 分派 / 91 断言 / B=20B」，实测与之不符。以 `internal/js_ast/js_ast.go` 为准：

| 项 | 立项书估算 | 代码实测 | 信源 |
| --- | ---: | ---: | --- |
| 表达式变体 `E*` | 43 | **40** | `isExpr()` 实现 40 个 [^1] |
| 语句变体 `S*` | — | **33** | `isStmt()` 实现 33 个 [^2] |
| 绑定变体 `B*` | — | **4** | `isBinding()` 实现 4 个 [^3] |
| 表达式字段并集（去重后） | — | **64** 个字段名 | 见 §2 |
| 字段出现总次数（40 个 `E*` 求和） | — | **110** | 见 §2 |
| `.Data.` 引用点 | 171 分派 / 91 断言 | **706** 处 / 25 文件 | grep 全文 [^4] |
| 分派最密文件 | — | `js_parser.go` 317、`js_ast_helpers.go` 97、`js_printer.go` 76 | [^4] |

结论：**改动面比立项书估计更大**（E+S+B 共 77 个变体类、706 处 `.Data.`）。任何 codemod 必须整族同时改，并靠字节门兜底。

## 2. 字段并集与分歧点

40 个 `E*` 的字段并集共 **64 个不同字段名**，合计 110 次出现。按类别：

| 类别 | 出现次数 | 内联大小（64 位） |
| --- | ---: | ---: |
| `bool / 标志枚举` | 37 | 1B |
| `Expr` 子节点 | 20 | 24B（接口 16 + Loc 4，对齐） |
| `logger.Loc / Range` | 17 | 4B / 8B |
| `uint32/int32/OpCode/...` 标量 | 12 | ≤4B |
| slice（`[]Expr`/`[]Property`/...） | 10 | 24B（切片头） |
| `string` | 6 | 16B |
| `ast.Ref` | 4 | 8B |
| 值类型大结构（`Fn`/`Class`/`FnBody`） | 3 | 104B |
| `float64` | 1 | 8B |

**分歧点（同名字段不同类型）——这是「扁平 struct」的核心障碍：**

1. `Value` 有 **5 种类型**：
   - `Expr` → `EUnary, ESpread, EInlinedEnum, EAnnotation, EAwait`
   - `bool` → `EBoolean`
   - `float64` → `ENumber`
   - `string` → `EBigInt, ERegExp`
   - `[]uint16` → `EString`
2. `Args` 有 2 种类型：`[]Expr` → `ENew, ECall`；`[]Arg` → `EArrow`。

其余高复用字段（`CloseParenLoc` 6、`IsParenthesized` 5、`Target` 4、`Ref` 4、`CanBeUnwrappedIfUnused` 3、`OptionalChain` 3）类型一致，无分歧。

## 3. 内存解剖（实测 `unsafe.Sizeof`，64 位）

| 项 | 大小 |
| --- | ---: |
| `logger.Loc` | 4B |
| `logger.Range` | 8B |
| `js_ast.E` 接口 | 16B |
| `Expr` 包装（`Data E` + `Loc`） | **24B** |
| `ENumber` 负载 | 8B |
| `ECall` 负载 | 56B |
| `EDot` / `EArray` 负载 | 48B / 40B |
| `EIf` / `EArrow` 负载 | 72B |
| `ETemplate` / `EFunction` / `EClass` 负载 | **104B** |

现状每个节点 = 内联 `Expr` 24B + **独立 `E*` 堆分配**（1–104B，另有 malloc 头与 size-class 取整）。
R14 的 88B/节点 = 这两部分之和。**主要浪费是「逐节点 malloc」**，其次是接口间接。

## 4. 关键判断：立项书「B 扁平 struct = 20B」不能直接套用

R14 的 A/B/C 三版是在 **TS 侧构造的同构 AST 微基准**（每节点同形）上测的，得到 B=C=20B、4.4×。
真实 esbuild AST 是 **40 变体、64 字段并集、含 20 个递归 `Expr` 子节点与 10 个 slice**：

- 若把 64 字段「字面地」塞进一个扁平 struct：仅 20 个 `Expr`(24B) + 10 个 slice(24B) + 3 个大结构(104B)
  就已远超 24B/节点，扁平结构会比现状**更大**，与 20B 目标相反。
- 分歧点 `Value`(5 型)/`Args`(2 型) 还要求重叠存储或联合，Go 1.13 无 union，须 `unsafe` 或指针逃逸。

因此**「去 interface + kind 标签」方向不变（用户已选 A，优先 B），但「一个扁平 struct 装下全部字段」在真实 AST 上不可行**。
真正的收益杠杆是：**消除逐节点 malloc** + **去接口间接**，而不是把所有字段物理摊平。

## 5. 推荐表示（B 的可实现形态）

采用 **kind 标签 + 竞技场（arena）内紧凑负载**，分三步，每步独立过字节门 + `go test`，可单独回滚：

- **M2-a 竞技场化（低风险、先证收益）**：保留 `Expr{Data E, Loc}`，但每个文件的 `E*/S*/B*` 负载从**按文件的 bump 竞技场**分配（替代逐节点 `new`）。
  语义与调用点几乎不变，字节等价近乎天然成立；消除 malloc 头与 size-class 浪费、改善局部性。先在这一步实测内存降幅，验证「≥10%」是否可达。
- **M2-b 增加 kind 标签**：给 `Expr`（及 `Stmt`）加 `Kind uint8`，构造点一次性写入；分派从 type switch 改为 `switch e.Kind` + 单次断言。
  为去接口做准备，此步仍保留 `E` 接口，风险可控。
- **M2-c 去接口（高风险、最后做）**：把 `Data E`（16B 接口）替换为 `Kind` + 内联标量槽 + 指向竞技场负载的句柄；
  用 `Value`/`Args` 分歧点的类型化槽位解决重叠。此步改动 706 处 `.Data.`，必须在 M2-a/b 收益已被 M3 确认后才做。

排序理由：先用最小改动拿到可测收益（M2-a），避免「全量 706 处改造后才发现收益不足」；若 M2-a 实测 <10%，
则按立项书「负结果照记、回滚不硬凑」处理，并重新评估是否值得做 M2-b/c。

## 6. 硬门与约束（沿用立项书）

- 每步后：5 入口 + 宽语料子集对固化基线 `baselines/esbuild-go.base` 逐字节等价；`go test ./...` 全绿。
- 工具链固定：`GOTOOLCHAIN=go1.26.5`、`CGO_ENABLED=0`、`GO_FLAGS=-trimpath -ldflags=-s -w -buildid= -buildvcs=false`。
- `go.mod` 停 Go 1.13 语法，禁止引入高版本语法（含泛型、union 类型）。
- 性能验收 n≥8、bootstrap CI 不含 1；内存降幅 ≥10%。
- `/root/esbuild` 基线源码绝不可改；所有改动仅在 goport 工作树。

## 7. 待确认（进入 M2 前的唯一决策点）

M2-a/b/c 的排序与取舍已在上文给出推荐默认（先 M2-a 证收益）。但「是否按此三步走、还是直接一次性做完整扁平化」
属于多种可行方案，编码改造前需用户确认一次。本文不擅自定义编码顺序的最终采纳，仅给出推荐与依据。

## 信源

[^1]: `internal/js_ast/js_ast.go:453`（`type E interface`）+ `455`（首个 `isExpr`），`grep -c 'func (\*E[A-Za-z]*) isExpr()'` = 40。
[^2]: `internal/js_ast/js_ast.go:942`（`type S interface`），`isStmt` 实现计数 = 33。
[^3]: `internal/js_ast/js_ast.go:422`（`type B interface`），`isBinding` 实现计数 = 4。
[^4]: `internal/js_parser/js_parser.go`、`internal/js_ast/js_ast_helpers.go`、`internal/js_printer/js_printer.go` 等 25 文件，全文 `grep -rc '\.Data\.'` 求和 = 706。
[^5]: `internal/js_ast/js_ast.go:446`（`type Expr struct`）、`453`（`E interface`）、`496`（`EArray`，首个负载结构）、`849`（`ETemplate`，104B 最大负载）。
[^6]: 内存大小用 `unsafe.Sizeof` 实测（Go 1.26.5，ptr=8B）；R14 的 20B/88B 数字来自立项书转述的 TS 侧同构微基准，本仓已无该文件，未独立复跑，标注为立项书转述。
