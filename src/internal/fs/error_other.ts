// 1:1 移植自 esbuild internal/fs/error_other.go（v0.28.2）—— build tag (!js||!wasm)&&!windows。
// Go 源码：`func is_ERROR_INVALID_NAME(err error) bool { return false }`（一行常量）。
/** Go: func is_ERROR_INVALID_NAME(err error) bool (error_other.go:7) */
export function is_ERROR_INVALID_NAME(_err: unknown): boolean { return false; }
