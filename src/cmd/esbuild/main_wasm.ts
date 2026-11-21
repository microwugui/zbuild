// 1:1 移植自 esbuild cmd/esbuild/main_wasm.go（v0.28.2）—— build tag js&&wasm。
// Go 源码是 4 个 stub：trace/heap/cpuprofile 打印「not supported」，isServeUnsupported 返回 true。
import { PrintErrorToStderr } from "../../internal/logger/logger.ts";

/** Go: func createTraceFile(osArgs []string, traceFile string) func() (main_wasm.go:12) */
export function createTraceFile(osArgs: string[], _traceFile: string): (() => void) | null {
  PrintErrorToStderr(osArgs, 'The "--trace" flag is not supported when using WebAssembly');
  return null;
}
/** Go: func createHeapFile(osArgs []string, heapFile string) func() (main_wasm.go:18) */
export function createHeapFile(osArgs: string[], _heapFile: string): (() => void) | null {
  PrintErrorToStderr(osArgs, 'The "--heap" flag is not supported when using WebAssembly');
  return null;
}
/** Go: func createCpuprofileFile(osArgs []string, cpuprofileFile string) func() (main_wasm.go:24) */
export function createCpuprofileFile(osArgs: string[], _cpuprofileFile: string): (() => void) | null {
  PrintErrorToStderr(osArgs, 'The "--cpuprofile" flag is not supported when using WebAssembly');
  return null;
}
/** Go: func isServeUnsupported() bool (main_wasm.go:30) */
export function isServeUnsupported(): boolean { return true; }
