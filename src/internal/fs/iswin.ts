// 运行时平台选择（TS 无 Go 的 //go:build，按 process.platform 选等价变体）。
// Go 侧三个 build-tag 变体分别落在 iswin_other.ts / iswin_windows.ts / iswin_wasm.ts。
import { checkIfWindowsOther } from "./iswin_other.ts";
import { checkIfWindowsWindows } from "./iswin_windows.ts";

/** 等价于 Go fs.CheckIfWindows() 在宿主平台的取值。 */
export function checkIfWindows(): boolean {
  return process.platform === "win32" ? checkIfWindowsWindows() : checkIfWindowsOther();
}
