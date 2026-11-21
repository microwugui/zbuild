# 等价证据映射（v1，机械生成）

> 由 `node --experimental-strip-types tools/equiv-map.ts` 生成。
> 证据等级：`go-bytes`（go-verified.json 的 evidence 文本点名）> `m1-byte`（M1 字节差分运行中执行过）> `unit-only`（只在 npm test 覆盖里执行过）> `none`。
> oracle.json 的 case 只有 `exercises: [包名]`，因此函数继承其包的 applicable/equal 计数；逐 case→逐函数的覆盖需要 per-case coverage（v2）。

- 已移植函数：**665**
- go-bytes：**232**；m1-byte：**117**；unit-only：**316**；**none：0**

## 分档

| 包 | 已移植 | go-bytes | m1-byte | unit-only | none | oracle 适用/相等（包级） |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `internal/ast` | 30 | 3 | 5 | 22 | 0 | 2667/15812 |
| `internal/helpers` | 88 | 0 | 8 | 80 | 0 | 2669/15815 |
| `internal/js_ast` | 167 | 101 | 24 | 42 | 0 | 2668/15813 |
| `internal/js_lexer` | 45 | 30 | 12 | 3 | 0 | 2667/15812 |
| `internal/js_parser` | 179 | 41 | 49 | 89 | 0 | 2667/15812 |
| `internal/js_printer` | 48 | 36 | 12 | 0 | 0 | 2668/15813 |
| `internal/logger` | 64 | 21 | 7 | 36 | 0 | — |
| `internal/sourcemap` | 19 | 0 | 0 | 19 | 0 | — |
| `internal/xxhash` | 25 | 0 | 0 | 25 | 0 | 1/1 |

## oracle 用例 → 包（case 级证据）

| 包 | 适用 case | equal | 等价比 |
| --- | ---: | ---: | ---: |
| `internal/ast` | 15812 | 2667 | 16.9% |
| `internal/helpers` | 15815 | 2669 | 16.9% |
| `internal/js_ast` | 15813 | 2668 | 16.9% |
| `internal/js_lexer` | 15812 | 2667 | 16.9% |
| `internal/js_parser` | 15812 | 2667 | 16.9% |
| `internal/js_printer` | 15813 | 2668 | 16.9% |
| `internal/xxhash` | 1 | 1 | 100.0% |

## 无等价证据（none）

（空）
