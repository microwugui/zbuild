// 1:1 移植自 esbuild internal/compat/js_table.go（v0.28.2，commit f6058f83）
//
// 本轮只落 `js_ast_helpers` 的硬依赖子集：JSFeature 位掩码 + Has。
// 三个常量由 Go 探针实测（/root/esbuild/tmpcompat）：
//   NullishCoalescing         = 4398046511104   = 1<<42
//   OptionalChain             = 140737488355328 = 1<<47
//   TypeofExoticObjectIsObject= 288230376151711744 = 1<<58
//
// Go 的 JSFeature 是 uint64，TS 的 number 位运算只有 32 位，超过 31 的位会溢出，
// 所以这里用 bigint 承载（与 uint64 一一对应）。M3 补全 compat 包时沿用该表示。
//
// DEVIATION：Go 的 `features.Has(feature)` 是方法，TS 侧改为函数 `Has(features, feature)`
// （bigint 不能挂方法；调用点写作 `Has(unsupportedFeatures, JSFeature.OptionalChain)`）。

/** Go: type JSFeature uint64 (js_table.go:60) */
export type JSFeature = bigint;

export const JSFeature = {
  /** Go: NullishCoalescing (js_table.go:105) —— 第 42 位 */
  NullishCoalescing: 1n << 42n,
  /** Go: OptionalChain (js_table.go:110) —— 第 47 位 */
  OptionalChain: 1n << 47n,
  /** Go: TypeofExoticObjectIsObject (js_table.go:121) —— 第 58 位 */
  TypeofExoticObjectIsObject: 1n << 58n,
};

/** Go: func (features JSFeature) Has(feature JSFeature) bool (js_table.go:190) */
export function Has(features: JSFeature, feature: JSFeature): boolean {
  return (features & feature) !== 0n;
}
