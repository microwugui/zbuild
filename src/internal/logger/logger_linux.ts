// 1:1 移植自 esbuild internal/logger/logger_linux.go（v0.28.2，commit f6058f83）
//
// DEVIATION（记录在 PLAN.md「第 7 次推进」）：Go 用 `//go:build linux` 在编译期挑选
// logger_{linux,darwin,windows,other}.go；TS 没有构建标签，本移植只以 Linux 为目标，
// 因此 logger.ts 直接静态 import 本文件。darwin / windows / other 三个平台的实现均未移植。
//
// Go 侧用 ioctl(TCGETS) / ioctl(TIOCGWINSZ) 判断 TTY 与窗口大小；TS 用 Node 的
// stream.isTTY / columns / rows —— 这正是 Node 自己对同一组 ioctl 的封装结果。

import type { FileLike, TerminalInfo } from "./logger.ts";
import { TerminalInfo as TerminalInfoClass, hasNoColorEnvironmentVariable } from "./logger.ts";

/** Go: SupportsColorEscapes（linux = true） */
export const SupportsColorEscapes = true;

/** Go: func GetTerminalInfo(file *os.File) (info TerminalInfo) */
export function GetTerminalInfo(file: FileLike): TerminalInfo {
  const info = new TerminalInfoClass();
  const stream = file.Stream;

  // Is this file descriptor a terminal?
  if (stream !== undefined && stream.isTTY === true) {
    info.IsTTY = true;
    info.UseColorEscapes = !hasNoColorEnvironmentVariable();

    // Get the width of the window
    info.Width = stream.columns ?? 0;
    info.Height = stream.rows ?? 0;
  }

  return info;
}

/** Go: func writeStringWithColor(file *os.File, text string) */
export function writeStringWithColor(file: FileLike, text: Uint8Array): void {
  file.WriteString(text);
}
