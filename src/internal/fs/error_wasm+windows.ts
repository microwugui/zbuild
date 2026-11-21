// 1:1 移植自 esbuild internal/fs/error_wasm_windows.go（v0.28.2）—— build tag (js&&wasm)||windows。
// Go 源码常量 ERROR_INVALID_NAME syscall.Errno = 123；`err == ERROR_INVALID_NAME`。
// TS 侧错误用 code 字符串/数字 errno 表达，这里判定 errno 123（Windows ERROR_INVALID_NAME）。
const ERROR_INVALID_NAME = 123;
/** Go: func is_ERROR_INVALID_NAME(err error) bool (error_wasm_windows.go:12) */
export function is_ERROR_INVALID_NAME(err: unknown): boolean {
  if (typeof err === "number") return err === ERROR_INVALID_NAME;
  if (err && typeof err === "object" && "errno" in err) return (err as { errno: number }).errno === ERROR_INVALID_NAME;
  return false;
}
