// 1:1 移植自 esbuild internal/logger/logger_darwin.go（v0.28.2）—— build tag darwin。
// Go 用 unix.IoctlGetTermios(TIOCGETA) 判 TTY、unix.IoctlGetWinsize(TIOCGWINSZ) 取窗口尺寸；
// TS 用 Node stream.isTTY / columns / rows（Node 对同组 ioctl 的封装）。结构逐行对齐 Go。
import type { FileLike, TerminalInfo } from "./logger.ts";
import { TerminalInfo as TerminalInfoClass, hasNoColorEnvironmentVariable } from "./logger.ts";

/** Go: const SupportsColorEscapes = true（logger_darwin.go:12） */
export const SupportsColorEscapes = true;

/** Go: func GetTerminalInfo(file *os.File) (info TerminalInfo) (logger_darwin.go:14) */
export function GetTerminalInfo(file: FileLike): TerminalInfo {
  const info = new TerminalInfoClass();
  const stream = file.Stream;
  // Is this file descriptor a terminal? (unix.IoctlGetTermios TIOCGETA)
  if (stream !== undefined && stream.isTTY === true) {
    info.IsTTY = true;
    info.UseColorEscapes = !hasNoColorEnvironmentVariable();
    // Get the width of the window (unix.IoctlGetWinsize TIOCGWINSZ)
    info.Width = stream.columns ?? 0;
    info.Height = stream.rows ?? 0;
  }
  return info;
}

/** Go: func writeStringWithColor(file *os.File, text string) (logger_darwin.go:32) */
export function writeStringWithColor(file: FileLike, text: Uint8Array): void { file.WriteString(text); }
