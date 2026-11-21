# JS 大 switch 优化：网络调研（2026-11-21）

目的：为 `Next()` / `parseStmt` 的巨型 switch 找成熟优化经验，避免从零研究。
下面是查证过的信源与结论，以及对照本项目机器证据的判读。

## 1. V8 什么时候给 switch 生成 jump table（权威：V8 源码提交）

V8 commit `9711289`（2021，"A jump-table implementation for constant case switch statements"）明确写了判据[^1]：
- **≥6 个 Smi（31-bit 整数）case**；
- 且 **max−min ≤ 3 × case 数量**（即 case 足够密集）；
- 满足则对 Smi 部分用 jump table，其余 case 仍走传统 if-else。

x64 instruction selector 里同样是「cases 多且值连续 → Table Switch，否则 Binary Search Switch」[^2]。

**对照本项目**：`Next()` 的 switch 判别式是 `codePoint`（0x09/0x0a/0x0d/0x20/0x23/0x25…0x7e/0x2028…），稀疏且跨度大（0x09→0x2028 差 8233，case 数 ~60，远超 3×）。→ **V8 不会给它 jump table，只能 compare 链**。这与本地反汇编实测「293 条 cmp、0 jump table entry」完全吻合[^3]。不是我们的写法问题，是 case 分布决定的。

## 2. 经典案例：JS 解释器 opcode dispatch（和本场景几乎同构）

Stack Overflow #18830626「Should I use big switch statements in JavaScript without performance problems?」[^4][^5]：
- 一个 256-entry 的 opcode switch（和 lexer token dispatch 同类），只传 NOP 时，注释掉 13 个 case 后**性能跳升 25×**，注释 12 个则仍慢——存在明确的「超过某规模就掉崖」阈值。
- Esailija 的高赞答案（引 V8 hydrogen.cc:3350）：V8 要优化 switch 需 case 同类型、都是 31-bit 整数字面量、且 <128 个；即便满足「也只是得到 if-else equivalent，没有 jump table」。
- 提问者最终方案：**array of functions（函数指针表）替代大 switch，整体程序快 25×**[^5]。这是社区对「大 switch 掉崖」最主流的绕法。

**对照本项目**：这正是用户提出的「把分支搬出去」的更强版本——不是搬成小方法（本地实测仅 7–11%）[^6]，而是搬成**函数指针数组按 token 索引直跳**。但注意：本场景 token 分布极度倾斜（whitespace 65.8 万 / 标点 49.5 万 / 标识符 18 万，共 134 万次）[^3]，且 case 值稀疏——函数表需要一个 `codePoint → 槽位` 的映射（本身是 compare 或查表），未必像 opcode（0–255 连续）那样 O(1) 索引。这是与 opcode 案例的关键差异，必须先量。

## 3. 计算 goto / token threading（解释器领域）

arXiv《How fast can we make interpreted Python?》[^7]：switch dispatch（`while(1) switch(ip->opcode)`）的问题是**分支预测失效**——每次都从 switch 顶部派发，CPU 无法学出「指令 A 后面常跟 B」，流水线停顿。解法 token-threading：把下一个 handler 的跳转内联到每个 handler 末尾。
RE2C scanner generator 论文[^8]：C 编译器按 case 密度选 jump table / if 链；但**扫描器经验是把 jump table 换成 if 反而更小、有时略快**——密度判据驱动。

**对照本项目**：lexer 同理——token 序列有强局部性（标识符后常跟标点，换行后常跟标识符）。主动 while + 顺序 if 让热点路径（ws/ident）排在前面，第一次比较就命中，恰好利用了这一点——这可能是本地主动版快 43–47% 的部分原因[^6]。

## 4. 结论与对本项目方向的判读

1. **大 switch 掉崖是真实现象**，社区有两套成熟绕法：① 拆成小 switch / 小函数；② 函数指针表直跳（opcode 场景 25×）。
2. **V8 不给稀疏 case 建 jump table**是有源码依据的硬事实，解释了本地反汇编，不是可「修复」的问题。
3. **对本项目**：
   - 「拆小函数」本地已测，仅 7–11%——与社区「小 switch」思路一致但收益有限（因热点仍要走的 dispatch 链没消失）。
   - 「函数指针表」值得作为**下一张卡**先做微基准：难点是 codePoint 稀疏 → 需要先做 `cp→槽位` 映射；若能用一个 128 项 Uint8Array 直接索引 ASCII（覆盖 99% 字符），则查表 O(1) + 函数表间接调用，可能兼得 jump table 效果与可读分派。
   - 「主动 while」本地已测 43–47%，是最强写法，已是全量重写级改动。
4. 三个方向强度：函数表 / 主动 while（大改成）> 拆小函数（小改为）。但全部仍是**简化 lexer 微基准**，到真实 `Next()`（~700ns/次）能不能 ≥10% 必须真改后跑大构建 A/B。

## 信源
[^1]: V8 commit 9711289 "A jump-table implementation for constant case switch statements" — https://chromium.googlesource.com/v8/v8/+/9711289d064ba420de310f533913169c37d01b61
[^2]: V8 x64 instruction-selector（Table Switch vs Binary Search Switch）— https://github.com/v8/v8/blob/master/src/compiler/backend/x64/instruction-selector-x64.cc
[^3]: 本地机器证据 — /tmp/optcode2.out（Next 293 cmp / 0 jump table）、bench/LEDGER.md:311（token 频次）
[^4]: Stack Overflow #18830626 — https://stackoverflow.com/questions/18830626/should-i-use-big-switch-statements-in-javascript-without-performance-problems
[^5]: 同上 answer revision（25× / array of functions / <128 cases）— https://stackoverflow.com/revisions/40251aaa-bb6d-410f-8ba7-5e8a960d04b0/view-source
[^6]: bench/lexer-split-bench.mjs（拆函数 7–11%、主动 43–47%）、bench/lexer-style-bench.mjs
[^7]: Power & Rubinsteyn, "How fast can we make interpreted Python?" arXiv:1306.6047 — https://arxiv.org/abs/1306.6047
[^8]: Bumbulis & Cowan, "RE2C: a more versatile scanner generator" — https://doi.org/10.1145/176454.176487
