# 性能对比与 profile 优化报告（阶段②③）

> 移植阶段已完成（非禁 1750/1755 + 5 prohibited，六档门全绿，three.js core/module 逐字节相等），
> 本报告按用户三段式终态的阶段②③执行：性能对比 + profile 驱动的有限优化。

## ② esbuild 强制单线程 vs 单线程 TS

口径见 `bench/README.md:1-9`；harness 为 `bench/bench.py`（预热 2 次 + 正式 7 次取中位数/p10/p90）。
两侧读同一份 three.js 文件，Go 侧 `GOMAXPROCS=1`，同一 CLI 参数，TS 侧经 `tools/ts-bundle.sh`。[^1]

| 输入 | 字节 | Go GOMAXPROCS=1 中位 | TS 单线程中位 | TS/Go | Go p10/p90 | TS p10/p90 |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| three.module.js | 658,900 | 0.2194 s | 5.0858 s | 23.18× | 0.209/0.230 | 5.052/5.274 |
| three.core.js | 1,474,799 | 0.1614 s | 3.6112 s | 22.37× | 0.151/0.170 | 3.510/3.689 |

数据固化于 `bench/bench-data.json`（含每次采样、版本、偏置说明）。**偏置**：V8 JIT 预热曲线、
进程启动（Go 静态二进制 vs Node `--experimental-strip-types` 类型剥离）、GC 策略差异；
TS 后端为 `bundle1.ts`/`bundle_multi.ts` 驱动，非 Go 逐函数 1:1 调用链——字节等价由
`tools/three_verify.sh` 单独保证（core `c0fdbed2` / module `2985154b`），本 harness 不重复验字节。[^1][^2]

结论：强制单线程下 TS 约为 Go 的 **22–23 倍**耗时；主要来自字符串→UTF-8 字节编码（Go 的 `[]byte`
模型在 TS 需反复 `TextEncoder.encode`）与 GC 压力，而非算法复杂度差异。

## ③ profile → 热点 → 有限优化

`node --cpu-prof` 生成 `bench/profiles/three-module.cpuprofile`（4660 样本 / 5989 ms self-time），
`bench/analyze_profile.py` 按 self-time 聚合到函数级，报告见 `bench/profile-report.json`。[^3]

Top self-time：`encode@encoding:350` 12.2%、`(garbage collector)` 10.9%、`printExprInner` 3.9%、
`visitExprInOut` 3.7%、`Next` 3.7%、`collectRefs@bundle_multi.ts:96` 3.6%。

落地两处安全优化（均经 three_verify 字节等价 + 六档门验证）：
1. **opt1**：`js_printer.ts` 4 处内联 `new TextEncoder()` 提到模块级共享 `encoder`——针对 encode/GC 热点。[^4]
2. **opt2**：`bundle_multi.ts` tree-shaking 内层循环把 `HelperContext` 构造提到循环外 + 复用 `collectRefs`
   的 `seen` Set——针对 collectRefs 热点。[^5]

优化效果（TS 中位，同 harness N=7）：three.module 5.3942→5.0858 s（−5.7%）、
three.core 3.7549→3.6112 s（−3.8%）。**诚信口径**：该幅度落在采样噪声内、**未证明统计显著**——
baseline 与 optimized 的样本区间重叠（module 5.291–5.539 vs 4.989–5.349 s；core 3.286–4.110
vs 3.431–3.888 s，core baseline 组内散布达 21.9%）。故二者仅**方向性**改善，需 N≥20 配对重测
才能定论；保留两处 hoist 是因为语义正确、零字节回归，而非已证明显著提速。优化前数据存
`bench-data-baseline.json`，标注见 `bench-data.json:comparison_vs_baseline`（significance=NOT_SIGNIFICANT）。
每步优化后均跑 `three_verify.sh`（两哈希不回退）+ 六档门（tsc 166 / m1 4158≥4157 / assign 0 /
doc 830−830）+ test:cov（1746 pass / fail 10 基线）。

## 脚注

[^1]: bench/bench.py（harness）+ bench/bench-data.json（采样/版本/偏置）+ bench/README.md:1-9
[^2]: tools/three_verify.sh:1-60（GOMAXPROCS=1 自校验 + TS/Go 逐字节 diff，core/module 哈希）
[^3]: bench/profiles/three-module.cpuprofile（node --cpu-prof）+ bench/analyze_profile.py + bench/profile-report.json
[^4]: src/internal/js_printer/js_printer.ts:117（模块级 encoder）+ :147/:157/:159/:2445（改用共享 encoder）
[^5]: src/bundle_multi.ts（tree-shaking 循环 HelperContext hoist + seen Set 复用）
