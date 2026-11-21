// 1:1 移植自 esbuild internal/logger/style_clang.go（v0.28.2，commit f6058f83）
// Go 的 string 是字节串：所有中间结果走 Uint8Array（ByteBuilder），见 bytes.ts 文件头。
import { ByteBuilder } from "./bytes.ts";
import { formatLineSpan } from "./style.ts";
import { MsgIDToString, MsgID_None } from "./msg_ids.ts";
import { Colors, Error, Note, TerminalColors, defaultTerminalWidth } from "./logger.ts";
import type { Msg, MsgData, MsgID, MsgKind, OutputOptions, TerminalInfo } from "./logger.ts";

/** Go: func msgToStringClang(msg Msg, options OutputOptions, terminalInfo TerminalInfo) string */
export function msgToStringClang(msg: Msg, options: OutputOptions, terminalInfo: TerminalInfo): Uint8Array {
  const text = new ByteBuilder();
  writeMsgDataClang(text, msg.ID, msg.Data, options, terminalInfo, msg.Kind);
  for (const note of msg.Notes) {
    if (note.Location !== null) {
      writeMsgDataClang(text, MsgID_None, note, options, terminalInfo, Note);
    }
  }
  return text.bytes();
}

/** Go: func writeMsgDataClang(text *strings.Builder, id MsgID, data MsgData, options OutputOptions, terminalInfo TerminalInfo, kind MsgKind) */
export function writeMsgDataClang(
  text: ByteBuilder, id: MsgID, data: MsgData, options: OutputOptions, terminalInfo: TerminalInfo, kind: MsgKind,
): void {
  let colors = new Colors();
  if (terminalInfo.UseColorEscapes) colors = TerminalColors;
  text.writeString(colors.Bold);

  if (data.Location !== null) {
    const loc = data.Location;
    text.writeString(loc.File.Select(options.PathStyle));
    // Note: adjust column from 0-based to 1-based
    if (loc.Line > 0) text.writeString(`:${loc.Line}:${loc.Column + 1}`);
    text.writeString(": ");
  }

  let kindColor = "";
  let kindText = "";
  if (kind === Error) { kindColor = colors.Red; kindText = "error"; }
  else if (kind === Note) { kindColor = colors.Dim; kindText = "note"; }
  else { kindColor = colors.Magenta; kindText = "warning"; }

  let msgID = MsgIDToString(id);
  if (msgID !== "") msgID = ` [${msgID}]`;

  text.writeString(`${kindColor}${kindText}:${colors.Reset} ${colors.Bold}${data.Text}${msgID}${colors.Reset}\n`);

  if (data.Location !== null && data.Location.Line > 0) {
    const loc = data.Location;
    let widthLimit = terminalInfo.Width;
    if (widthLimit < 1) widthLimit = defaultTerminalWidth;
    const span = formatLineSpan(loc.LineText, loc.Line, loc.Column, loc.Length, widthLimit);
    text.writeString(
      `${colors.Dim}`
    );
    text.writeBytes(span.firstLineBefore);
    text.writeString(colors.Green);
    text.writeBytes(span.firstLineMarked);
    text.writeString(colors.Dim);
    text.writeBytes(span.firstLineAfter);
    text.writeString("\n");
    text.writeBytes(span.indent);
    text.writeString(colors.Green);
    text.writeBytes(span.marker);
    text.writeString(`${colors.Reset}\n`);

    if (loc.Suggestion !== "") {
      text.writeString(colors.Green);
      text.writeBytes(span.indent);
      text.writeString(loc.Suggestion);
      text.writeString(`${colors.Reset}\n`);
    }
  }
}
