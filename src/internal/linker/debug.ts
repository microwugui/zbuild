// 1:1 移植自 esbuild internal/linker/debug.go（v0.28.2，commit f6058f83）
// 第 44 轮叶子优先规划：moveBeforeExport 字符串助手。字节证据由 Go 探针固化在
// testdata/linker-debug-go.json。

/** Go: func moveBeforeExport(contents string, i int) int (debug.go:142) */
export function moveBeforeExport(contents: string, i: number): number {
  let s = contents.slice(0, i).replace(/[ \t\r\n]+$/, "");
  if (s.endsWith("export")) return s.length - 6;
  return i;
}

/**
 * Go: func (c *linkerContext) generateExtraDataForFileJS (debug.go:21).
 * Go 的 debugVerboseMetafile 是编译时常量 false，故恒返回 ""。
 * 字节证据：testdata/linker-extra-data-go.json（SHA 57c337be…），Go 探针
 * tools/go/tmpgen_debug_test.go 对 3 个 sourceIndex 实测均返回 ""。
 */
export function generateExtraDataForFileJS(_c: unknown, _sourceIndex: number): string { return ""; }
