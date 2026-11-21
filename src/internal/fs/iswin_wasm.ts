// 1:1 移植自 esbuild internal/fs/iswin_wasm.go（v0.28.2）—— build tag js&&wasm。
// Go 用 os.Stat("C:\\") 是否存在判断（wasm 平台 workaround）；TS 侧用 node:fs.existsSync 表达等价语义。
import { existsSync } from "node:fs";

let checkedIfWindows = false;
let cachedIfWindows = false;

/** Go: func CheckIfWindows() bool (iswin_wasm.go:13) */
export function CheckIfWindows(): boolean {
  if (!checkedIfWindows) {
    checkedIfWindows = true;
    cachedIfWindows = existsSync("C:\\");
  }
  return cachedIfWindows;
}
