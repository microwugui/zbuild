// 1:1 移植自 esbuild pkg/api/api_js_table.go（v0.28.2）。第 121 批 Go 探针 11 例。
/** Go: func convertEngineName(engine EngineName) compat.Engine (api_js_table.go:23) */
export function convertEngineName(engine: number): number {
  // Go compat.Engine 枚举：Chrome 0, Deno 1, Edge 2, Firefox 4, Hermes 5,
  // IE 6, IOS 7, Node 8, Opera 9, Rhino 10, Safari 11（API EngineName 连续 0..10）
  const table = [0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11];
  return table[engine] ?? 0;
}
