# 移植进度看板

> 由 `tools/progress.ts` 自动生成（AST 分析 + V8 覆盖率 + 差分 oracle），请勿手改。

- Go 非测试函数总数：**1755**
- 已移植：**1750**（99.7%）
- 已被测试执行：**1750**（99.7%）
- 已等价：**1022**（oracle 通道 **25** + unit 通道 **526** + go-bytes 通道 **471**；unit 为临时等价、M4 前必须回 oracle 重跑；go-bytes 为逐函数 Go 实测等价、fixture SHA 已校验）
- 期望值来源 = Go 实测：**424**（仅 tools/go-verified.json 登记过的包；已等价不得超过该值）
- 未移植：5；已移植未测试：0
- 差分 oracle：已评估 **15818 / 16958**；ts-error 7918 + diff 5227 + equal 2672 + fixture-fail 1；**0** 条 cli 用例 `ts-missing` 未评估；go-error 1140 不适用
- 口径：「已测试未等价」= 已测试 − 已等价：`internal/js_parser` 1，`internal/css_parser` 103，`internal/css_ast` 27，`internal/fs` 93，`pkg/api` 24，`internal/helpers` 88，`internal/resolver` 21，`internal/linker` 7，`internal/logger` 70，`internal/js_printer` 65，`cmd/esbuild` 28，`internal/bundler` 6，`internal/ast` 30，`internal/renamer` 29，`internal/config` 22，`internal/css_lexer` 26，`internal/css_printer` 23，`pkg/cli` 16，`internal/sourcemap` 19，`internal/compat` 16，`internal/graph` 4，`internal/cache` 8，`internal/cli_helpers` 2（fixture 的 equal 只等于 pin 校验通过，不等于函数级等价）

| 包 | Go 函数 | 已移植 | 已测试 | 已等价(oracle) | 已等价(unit·临时) | 已等价(go-bytes) | Go 实测期望值 | 移植率 | 测试率 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `internal/js_parser` | 307 | 307 | 307 | 0 | 306 | 0 | 75 | 100.0% | 100.0% |
| `internal/css_parser` | 208 | 208 | 208 | 0 | 0 | 105 | 0 | 100.0% | 100.0% |
| `internal/js_ast` | 169 | 169 | 169 | 0 | 169 | 0 | 169 | 100.0% | 100.0% |
| `internal/css_ast` | 116 | 116 | 116 | 0 | 0 | 89 | 0 | 100.0% | 100.0% |
| `internal/fs` | 100 | 100 | 100 | 0 | 0 | 7 | 0 | 100.0% | 100.0% |
| `pkg/api` | 95 | 92 | 92 | 0 | 0 | 68 | 0 | 96.8% | 96.8% |
| `internal/helpers` | 88 | 88 | 88 | 0 | 0 | 0 | 0 | 100.0% | 100.0% |
| `internal/resolver` | 81 | 81 | 81 | 0 | 0 | 60 | 0 | 100.0% | 100.0% |
| `internal/linker` | 77 | 77 | 77 | 0 | 0 | 70 | 0 | 100.0% | 100.0% |
| `internal/logger` | 76 | 76 | 76 | 0 | 0 | 6 | 59 | 100.0% | 100.0% |
| `internal/js_printer` | 71 | 71 | 71 | 0 | 0 | 6 | 46 | 100.0% | 100.0% |
| `internal/js_lexer` | 45 | 45 | 45 | 0 | 45 | 0 | 45 | 100.0% | 100.0% |
| `cmd/esbuild` | 38 | 38 | 38 | 0 | 0 | 10 | 0 | 100.0% | 100.0% |
| `internal/bundler` | 36 | 35 | 35 | 0 | 0 | 29 | 0 | 97.2% | 97.2% |
| `internal/ast` | 30 | 30 | 30 | 0 | 0 | 0 | 30 | 100.0% | 100.0% |
| `internal/renamer` | 29 | 29 | 29 | 0 | 0 | 0 | 0 | 100.0% | 100.0% |
| `internal/config` | 27 | 27 | 27 | 0 | 0 | 5 | 0 | 100.0% | 100.0% |
| `internal/css_lexer` | 26 | 26 | 26 | 0 | 0 | 0 | 0 | 100.0% | 100.0% |
| `internal/xxhash` | 25 | 25 | 25 | 25 | 0 | 0 | 0 | 100.0% | 100.0% |
| `internal/css_printer` | 23 | 23 | 23 | 0 | 0 | 0 | 0 | 100.0% | 100.0% |
| `pkg/cli` | 23 | 22 | 22 | 0 | 0 | 6 | 0 | 95.7% | 95.7% |
| `internal/sourcemap` | 19 | 19 | 19 | 0 | 0 | 0 | 0 | 100.0% | 100.0% |
| `internal/compat` | 16 | 16 | 16 | 0 | 0 | 0 | 0 | 100.0% | 100.0% |
| `internal/graph` | 13 | 13 | 13 | 0 | 0 | 9 | 0 | 100.0% | 100.0% |
| `internal/cache` | 8 | 8 | 8 | 0 | 0 | 0 | 0 | 100.0% | 100.0% |
| `internal/test` | 6 | 6 | 6 | 0 | 6 | 0 | 0 | 100.0% | 100.0% |
| `internal/cli_helpers` | 2 | 2 | 2 | 0 | 0 | 0 | 0 | 100.0% | 100.0% |
| `internal/runtime` | 1 | 1 | 1 | 0 | 0 | 1 | 0 | 100.0% | 100.0% |
| **合计** | **1755** | **1750** | **1750** | **25** | **526** | **471** | **424** | **99.7%** | **99.7%** |

## 未移植函数

> 处置列仅为根因标注（`tools/known-deviations.json` + 逐轮评估），不改变机械计数；剩余函数按注入缝手法逐族推进。

| 文件:行 | 函数 | 处置 |
| --- | --- | --- |
| `internal/bundler/bundler.ts:1355` | `generateUniqueKeyPrefix` | prohibited-port |
| `pkg/api/serve_wasm.ts:10` | `Serve` | prohibited-port |
| `pkg/api/serve_wasm.ts:17` | `broadcastBuildResult` | prohibited-port |
| `pkg/api/serve_wasm.ts:20` | `stop` | prohibited-port |
| `pkg/cli/cli_impl.ts:1497` | `serveImpl` | prohibited-port |
