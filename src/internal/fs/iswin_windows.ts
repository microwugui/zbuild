// 1:1 移植自 esbuild internal/fs/iswin_windows.go（v0.28.2）—— build tag windows。
// Go 源码：`func CheckIfWindows() bool { return true }`（一行常量）。
/** Go: func CheckIfWindows() bool (iswin_windows.go:6) */
export function CheckIfWindows(): boolean { return true; }
export const checkIfWindowsWindows = CheckIfWindows;
