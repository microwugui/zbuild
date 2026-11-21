// 1:1 移植自 esbuild internal/fs/iswin_other.go（v0.28.2）—— build tag (!js||!wasm)&&!windows。
// Go 源码：`func CheckIfWindows() bool { return false }`（一行常量，fixture 见 testdata/fs-platform-go.json）。
/** Go: func CheckIfWindows() bool (iswin_other.go:7) */
export function CheckIfWindows(): boolean { return false; }
/** 别名，供 iswin.ts 运行时选择使用 */
export const checkIfWindowsOther = CheckIfWindows;
