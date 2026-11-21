// 1:1 移植自 esbuild internal/logger/logger_other.go（v0.28.2）—— build tag !darwin&&!linux&&!windows。
// Go 源码：`const SupportsColorEscapes = false`；`GetTerminalInfo` 返回零值；`writeStringWithColor` 直接写。
import type { FileLike, TerminalInfo } from "./logger.ts";
import { TerminalInfo as TerminalInfoClass } from "./logger.ts";

/** Go: const SupportsColorEscapes = false（logger_other.go:8） */
export const SupportsColorEscapes = false;

/** Go: func GetTerminalInfo(*os.File) TerminalInfo (logger_other.go:10) */
export function GetTerminalInfo(_file: FileLike): TerminalInfo { return new TerminalInfoClass(); }

/** Go: func writeStringWithColor(file *os.File, text string) (logger_other.go:14) */
export function writeStringWithColor(file: FileLike, text: Uint8Array): void { file.WriteString(text); }
