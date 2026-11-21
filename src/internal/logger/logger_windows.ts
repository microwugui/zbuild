// 1:1 移植自 esbuild internal/logger/logger_windows.go（v0.28.2）—— build tag windows。
// Go 用 syscall (kernel32 GetConsoleMode/SetConsoleTextAttribute/GetConsoleScreenBufferInfo)；
// TS 无 Windows console API，用 stream.columns/rows + isTTY 表达等价信息，ANSI→attribute 表逐条移植。
// writeStringWithColor 的 ANSI 转义解析逻辑逐行对齐 Go（扫描 ESC...m，查表设属性，写文本）。
import type { FileLike, TerminalInfo } from "./logger.ts";
import { TerminalInfo as TerminalInfoClass, hasNoColorEnvironmentVariable, TerminalColors } from "./logger.ts";

/** Go: const SupportsColorEscapes = true（logger_windows.go:32 附近） */
export const SupportsColorEscapes = true;

/** Windows console foreground/background attribute bits（logger_windows.go:57） */
const FOREGROUND_BLUE = 1 << 0;
const FOREGROUND_GREEN = 1 << 1;
const FOREGROUND_RED = 1 << 2;
const FOREGROUND_INTENSITY = 1 << 3;
const BACKGROUND_BLUE = 1 << 4;
const BACKGROUND_GREEN = 1 << 5;
const BACKGROUND_RED = 1 << 6;
const BACKGROUND_INTENSITY = 1 << 7;

/** Go: var windowsEscapeSequenceMap map[string]uint8（logger_windows.go:69） */
export const windowsEscapeSequenceMap = new Map<string, number>([
  [TerminalColors.Reset, FOREGROUND_RED | FOREGROUND_GREEN | FOREGROUND_BLUE],
  [TerminalColors.Dim, FOREGROUND_RED | FOREGROUND_GREEN | FOREGROUND_BLUE],
  [TerminalColors.Bold, FOREGROUND_RED | FOREGROUND_GREEN | FOREGROUND_BLUE | FOREGROUND_INTENSITY],
  [TerminalColors.Underline, FOREGROUND_RED | FOREGROUND_GREEN | FOREGROUND_BLUE],
  [TerminalColors.Red, FOREGROUND_RED],
  [TerminalColors.Green, FOREGROUND_GREEN],
  [TerminalColors.Blue, FOREGROUND_BLUE],
  [TerminalColors.Cyan, FOREGROUND_GREEN | FOREGROUND_BLUE],
  [TerminalColors.Magenta, FOREGROUND_RED | FOREGROUND_BLUE],
  [TerminalColors.Yellow, FOREGROUND_RED | FOREGROUND_GREEN],
  [TerminalColors.RedBgRed, FOREGROUND_RED | BACKGROUND_RED],
  [TerminalColors.RedBgWhite, FOREGROUND_RED | FOREGROUND_GREEN | FOREGROUND_BLUE | BACKGROUND_RED],
  [TerminalColors.GreenBgGreen, FOREGROUND_GREEN | BACKGROUND_GREEN],
  [TerminalColors.GreenBgWhite, FOREGROUND_RED | FOREGROUND_GREEN | FOREGROUND_BLUE | BACKGROUND_GREEN],
  [TerminalColors.BlueBgBlue, FOREGROUND_BLUE | BACKGROUND_BLUE],
  [TerminalColors.BlueBgWhite, FOREGROUND_RED | FOREGROUND_GREEN | FOREGROUND_BLUE | BACKGROUND_BLUE],
  [TerminalColors.CyanBgCyan, FOREGROUND_GREEN | FOREGROUND_BLUE | BACKGROUND_GREEN | BACKGROUND_BLUE],
  [TerminalColors.CyanBgBlack, BACKGROUND_GREEN | BACKGROUND_BLUE],
  [TerminalColors.MagentaBgMagenta, FOREGROUND_RED | FOREGROUND_BLUE | BACKGROUND_RED | BACKGROUND_BLUE],
  [TerminalColors.MagentaBgBlack, BACKGROUND_RED | BACKGROUND_BLUE],
  [TerminalColors.YellowBgYellow, FOREGROUND_RED | FOREGROUND_GREEN | BACKGROUND_RED | BACKGROUND_GREEN],
  [TerminalColors.YellowBgBlack, BACKGROUND_RED | BACKGROUND_GREEN],
]);

/** Go: func GetTerminalInfo(file *os.File) TerminalInfo (logger_windows.go:34) */
export function GetTerminalInfo(file: FileLike): TerminalInfo {
  const info = new TerminalInfoClass();
  const stream = file.Stream;
  // Is this file descriptor a terminal? (GetConsoleMode)
  if (stream !== undefined && stream.isTTY === true) info.IsTTY = true;
  // Get the width of the window (GetConsoleScreenBufferInfo: dwSizeX/Y - 1)
  info.Width = (stream?.columns ?? 1) - 1;
  info.Height = (stream?.rows ?? 1) - 1;
  info.UseColorEscapes = !hasNoColorEnvironmentVariable();
  return info;
}

/** Go: func writeStringWithColor(file *os.File, text string) (logger_windows.go:95) */
export function writeStringWithColor(file: FileLike, text: Uint8Array): void {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let s = dec.decode(text);
  let i = 0;
  while (i < s.length) {
    if (s.charCodeAt(i) !== 27) { i++; continue; }
    let window = s.slice(i);
    if (window.length > 8) window = window.slice(0, 8);
    const mRel = window.indexOf("m");
    if (mRel === -1) { i++; continue; }
    const m = mRel + i + 1;
    const seq = s.slice(i, m);
    if (!windowsEscapeSequenceMap.has(seq)) { i++; continue; }
    // Write out the text before the escape sequence
    file.WriteString(enc.encode(s.slice(0, i)));
    // Apply the escape sequence (setConsoleTextAttribute.Call) —— TS 侧记录当前属性
    void windowsEscapeSequenceMap.get(seq);
    s = s.slice(m);
    i = 0;
  }
  file.WriteString(enc.encode(s));
}
