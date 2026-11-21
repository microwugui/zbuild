// 1:1 移植自 esbuild cmd/esbuild/main_other.go（v0.28.2）—— build tag !js||!wasm。
// Go 的 trace/pprof API 在 Node 无等价；忠实保留「os.Create + 错误文案 + 返回 cleanup 闭包」语义，
// profile 写入用空实现（Node 不产出 Go trace/heap/profile 格式，属平台能力边界，已登记）。
import { openSync, closeSync } from "node:fs";
import { PrintErrorToStderr } from "../../internal/logger/logger.ts";

/** Go: func createTraceFile(osArgs []string, traceFile string) func() (main_other.go:15) */
export function createTraceFile(osArgs: string[], traceFile: string): (() => void) | null {
  let fd: number;
  try { fd = openSync(traceFile, "w"); }
  catch (e: any) {
    PrintErrorToStderr(osArgs, `Failed to create trace file: ${e?.message ?? e}`);
    return null;
  }
  // Go: trace.Start(f) —— Node 无等价，profile 数据不产出
  return () => { /* trace.Stop */ closeSync(fd); };
}

/** Go: func createHeapFile(osArgs []string, heapFile string) func() (main_other.go:30) */
export function createHeapFile(osArgs: string[], heapFile: string): (() => void) | null {
  let fd: number;
  try { fd = openSync(heapFile, "w"); }
  catch (e: any) {
    PrintErrorToStderr(osArgs, `Failed to create heap file: ${e?.message ?? e}`);
    return null;
  }
  return () => { /* pprof.WriteHeapProfile —— Node 无等价 */ closeSync(fd); };
}

/** Go: func createCpuprofileFile(osArgs []string, cpuprofileFile string) func() (main_other.go:45) */
export function createCpuprofileFile(osArgs: string[], cpuprofileFile: string): (() => void) | null {
  let fd: number;
  try { fd = openSync(cpuprofileFile, "w"); }
  catch (e: any) {
    PrintErrorToStderr(osArgs, `Failed to create cpuprofile file: ${e?.message ?? e}`);
    return null;
  }
  return () => { /* pprof.StopCPUProfile */ closeSync(fd); };
}

/** Go: func isServeUnsupported() bool (main_other.go:60) */
export function isServeUnsupported(): boolean { return false; }
