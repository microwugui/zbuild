// 1:1 移植自 esbuild internal/logger/style_visualstudio.go（v0.28.2，commit f6058f83）
// vsID 表由 Go 探针 dump msgIDToInfo(id).vsID 固化（testdata/logger/style-extra-go.json）。
import { ByteBuilder } from "./bytes.ts";
import { Error } from "./logger.ts";
import type { Msg, OutputOptions, TerminalInfo } from "./logger.ts";

/** Go: msgIDToInfo(id).vsID —— index = MsgID，Go 探针逐项固化 */
export const VSID: number[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
  12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
  24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35,
  36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47,
  48, 49, 50, 51, 52, 53, 54, 55, 55, 55, 55, 55,
  55, 55, 56, 56, 56, 56, 56, 56, 56, 56, 56, 0,
];

/** Go: func msgToStringVisualStudio(msg Msg, options OutputOptions, terminalInfo TerminalInfo) string */
export function msgToStringVisualStudio(msg: Msg, options: OutputOptions, terminalInfo: TerminalInfo): Uint8Array {
  const text = new ByteBuilder();
  const loc = msg.Data.Location;
  if (loc !== null) {
    text.writeString(loc.File.Abs);
    if (loc.Line > 0) text.writeString(`(${loc.Line},${loc.Column + 1})`);
    text.writeString(": ");
  } else {
    text.writeString("esbuild: ");
  }
  const vsid = VSID[msg.ID] ?? 0;
  const code = `ES${`${vsid}`.padStart(4, "0")}`;
  if (msg.Kind === Error) text.writeString(`error ${code}: `);
  else text.writeString(`warning ${code}: `);
  text.writeString(msg.Data.Text);
  text.writeString("\n");
  return text.bytes();
}
