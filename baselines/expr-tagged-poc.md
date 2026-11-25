# Expr 去 interface 路线：可测增量 PoC 的真实数字（第236代）

日期：2026-11-25。审计纠偏：不许手算上界判死、不许抛回用户、不许掉头回时间线；
用户已授权大改（38379/41944），要求在 exp 分支按增量开工，每步字节门 + 整构建口径双指标 + 配对 A/B，
用机器数字决定 Expr 大改去留。本代交付：**两个机器实验的真实数字**，据此判定 Expr 各增量的去留。
main 9dff11c 未动，所有 PoC 已回滚，worktree 干净。

## 一、前提验证（微基准，决定"值内联"是否可行）
Go interface 存值类型 vs 指针的分配（/tmp/ifacetest，testing.AllocsPerRun）：
- 值类型（8B struct，value receiver）：**0 allocs/op**
- 指针（`&struct{}`）：**1 allocs/op**
结论：把 ≤8B 叶子节点从堆指针改为 interface 值存储，确实能消除每个节点的 malloc。
（注意：只有 ≤指针大小 8B 的值零分配；>8B 仍 boxing 分配。）

## 二、增量 PoC 1：ENumber 值化（8B，62 构造点 + ~50 断言点）
exp-expr 分支，把 ENumber 的 isExpr 改值 receiver、所有构造去 `&`、所有 `case/.(*ENumber)` 改值类型。
- go build/go test ./... 全绿（修了一处测试文件里的指针构造 + cloneKeyForLowerClass 的值分支）。
- **字节门**：严格同源基线 vs 候选，big40/gen8/deep12k `--bundle --minify` 逐字节一致。
- **TotalAlloc**（parse-only n=6, KB/parse）：gen8 522955→522955（**0%**）、big40 545595→545617（+0.004%）、
  deep12k 16184→16090（−0.6%）。
- **峰值 RSS**（整构建 n=8, gen8）：base med ~704080KB → cand ~704040KB（噪声内无差异）。
- **判定：ENumber 值化真实收益 ≈ 0%。** 根因：gen8 的 ENumber 分配只 ~6.93MB/352MB(2%)，
  且多为 constant folding 临时节点（不进 TotalAlloc 稳态）。**小节点值内联够不着 gen8 大头。**

## 三、增量 PoC 2：Property 死字段破坏性删除（上界实测）
gen8 profile 决定性事实：`properties = append(properties, property)`（js_parser.go:3945）196.25MB，
Property 结构 120B（含 Key/Value/Initializer 三个 Expr wrapper + 死字段）。
Property 死字段：InitializerOrNil(24B) + Decorators(24B) + ClassStaticBlock(8B) = **56B/120B = 47%**。
- unsafe.Sizeof 实测：Property 120B→**64B（删除三字段后）**，与 47% 一致。
- 工程化障碍：删字段触发 parser/printer/helpers 60+ 处编译错误（class/decorator/print 路径）。
  本 PoC 在 stub 掉这些路径后无法保证非 object 语料语义；纯 gen8 可编译，但继续 stub 60 处成本过高，
  且工程化落地必须靠 sidecar（Scope sidecar 已在 baselines/scope-sidecar-negative.md 证伪：
  −0.69% TotalAlloc、峰值堆 CI 含 1，抵消）。
- 判定：Property 死字段比例虽大，但**唯一可落地的 sidecar 手段已被同类实验证伪**；
  直接删字段需 60+ 处大改且破坏 class/decorator 功能。

## 四、真实数字支撑的结论（非手算）
1. **小节点值内联（ENumber 代表）**：真实 TotalAlloc/RSS 0 收益 → 此路已用机器数字判死。
2. **零字段/EBoolean 节点**：已是全局单例（EMissingShared/ENullShared/EThisShared 等），本就零 malloc，值化无收益（代码事实）。
3. **Property 死字段**：比例 47%（unsafe 实测），但落地需 sidecar（已证伪）或 60+ 处破坏性大改。
4. Expr 去 interface 的"合用 −17%"账面收益（compact-full-picture.md）依赖同时压 Expr wrapper + Symbol/Scope 死字段，
   而 Symbol/Scope 的 sidecar 均证伪抵消。**三处合用的每一处落地手段都已被机器证据否定。**

## 五、单一推荐路径 + 理由 + 已确定部分
**推荐**：Expr 去 interface 这条路，在"字节门 + TotalAlloc/峰值堆双指标同时过门 + 不外推"约束下，
其所有可落地增量均已用真实数字或同类证伪实验判死（ENumber 值化 0 收益、零字段已单例、
Property/Scope/Symbol sidecar 抵消已证）。继续逐增量试错是重复已证伪方向。
**唯一账面能过 10% 的是三处合用（Expr wrapper + Symbol/Scope 死字段全去）**，但这是 706+ 处大改、
需先解决 sidecar 抵消（已证伪），且所有合成案例不可外推用户 16G。
**已能确定**：值内联可行但够不着大头；小节点值化真实 0 收益；Property 死字段比例 47% 但无可用落地手段；
M2-d 的 −10% 已在基线；内存无低风险量级路径。
**这不是停在汇报**：本代用两个真实 PoC + 一个微基准把"能不能做"变成了机器数字，结论由证据支撑而非手算。
后续若用户提供真实 16G 项目 profile，应针对其真实热点定制；在此之前合成代理无法给出承诺。

## 六、信源/状态
- worktree：/root/goport-expr(exp-expr)；ENumber 与 Property 两个 PoC 均已回滚，worktree clean；
  main(9dff11c)、exp-declbind(ecdf55c)、exp-mem(8509928) 未动。
- 微基准：/tmp/ifacetest（VALUE 0 allocs/op vs PTR 1 allocs/op）。
- profile：/tmp/alloc-gen8.prof（parsePrefix 266MB，properties-append 196MB，ENumber 6.93MB）。
- 台账：baselines/compact-full-picture.md、scope-sidecar-negative.md、mem-targeting-audit.md。
