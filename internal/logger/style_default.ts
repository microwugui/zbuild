// 1:1 移植自 esbuild internal/logger/style_default.go（v0.28.2，commit f6058f83）
//
// 本文件只覆盖 `--color=false` 与 `--color=true` 两条 default style 路径。
// clang / visualstudio style 未实现（见 PLAN.md「第 7 次推进」TODO）；Msg.String 遇到这两种
// LogStyle 会抛错，不返回假格式。
//
// DEVIATION：Go 的 fmt.Sprintf 模板在 TS 里逐段改写成 ByteBuilder 写入（拼接顺序与模板一一对应），
// 这样非 ASCII 情况下切出来的字节不会被 UTF-16 解码/重编码改写。

import { ByteBuilder, byteLen, utf8 } from "./bytes.ts";
import { formatLineSpan, linkifyText, wrapWordsInString } from "./style.ts";
import { MsgIDToString, MsgID_None } from "./msg_ids.ts";
import type { Msg, MsgData, MsgID, MsgKind, OutputOptions, PathStyle, TerminalInfo } from "./logger.ts";
import { Colors, Icon, Note, String, TerminalColors, defaultTerminalWidth, extraMarginChars } from "./logger.ts";

/** Go: func msgToStringDefault(msg Msg, options OutputOptions, terminalInfo TerminalInfo) string */
export function msgToStringDefault(msg: Msg, options: OutputOptions, terminalInfo: TerminalInfo): Uint8Array {
  // Format the message
  const text = new ByteBuilder();
  text.writeBytes(
    msgString(options.IncludeSource, options.PathStyle, terminalInfo, msg.ID, msg.Kind, msg.Data, msg.PluginName),
  );

  // Format the notes
  let oldData: MsgData | null = null;
  for (let i = 0; i < msg.Notes.length; i++) {
    const note = msg.Notes[i];
    if (
      options.IncludeSource &&
      (i === 0 || (oldData !== null && (oldData.Text.indexOf("\n") >= 0 || oldData.Location !== null)))
    ) {
      text.writeString("\n");
    }
    text.writeBytes(msgString(options.IncludeSource, options.PathStyle, terminalInfo, MsgID_None, Note, note, ""));
    oldData = note;
  }

  // Add extra spacing between messages if source code is present
  if (options.IncludeSource) text.writeString("\n");
  return text.bytes();
}

/** Go: func marginWithLineText(maxMargin int, line int) string */
export function marginWithLineText(maxMargin: number, line: number): Uint8Array {
  const number = `${line}`;
  const b = new ByteBuilder();
  b.writeString("      ");
  b.writeString(" ".repeat(maxMargin - byteLen(number)));
  b.writeString(number);
  b.writeString(" │ ");
  return b.bytes();
}

/** Go: func emptyMarginText(maxMargin int, isLast bool) string */
export function emptyMarginText(maxMargin: number, isLast: boolean): Uint8Array {
  const space = " ".repeat(maxMargin);
  return utf8(isLast ? `      ${space} ╵ ` : `      ${space} │ `);
}

/**
 * Go: func msgString(includeSource bool, pathStyle PathStyle, terminalInfo TerminalInfo,
 *                    id MsgID, kind MsgKind, data MsgData, pluginName string) string
 */
export function msgString(
  includeSource: boolean,
  pathStyle: PathStyle,
  terminalInfo: TerminalInfo,
  id: MsgID,
  kind: MsgKind,
  data: MsgData,
  pluginName: string,
): Uint8Array {
  if (!includeSource) {
    const loc = data.Location;
    if (loc !== null) {
      return utf8(`${loc.File.Select(pathStyle)}: ${String(kind)}: ${data.Text}\n`);
    }
    return utf8(`${String(kind)}: ${data.Text}\n`);
  }

  let colors = new Colors();
  if (terminalInfo.UseColorEscapes) colors = TerminalColors;

  let iconColor = "";
  let kindColorBrackets = "";
  let kindColorText = "";

  let location = new Uint8Array(0);

  const loc = data.Location;
  if (loc !== null) {
    const maxMargin = byteLen(`${loc.Line}`);
    const margin = marginWithLineText(maxMargin, loc.Line);
    let widthLimit = terminalInfo.Width;
    if (widthLimit < 1) widthLimit = defaultTerminalWidth;
    widthLimit -= maxMargin + extraMarginChars;

    const span = formatLineSpan(loc.LineText, loc.Line, loc.Column, loc.Length, widthLimit);
    const path = loc.File.Select(pathStyle);

    const b = new ByteBuilder();
    if (loc.Suggestion !== "") {
      b.writeString("\n    ");
      b.writeString(path);
      b.writeString(":");
      b.writeString(`${loc.Line}`);
      b.writeString(":");
      b.writeString(`${loc.Column}`);
      b.writeString(":\n");
      b.writeString(colors.Dim);
      b.writeBytes(margin);
      b.writeBytes(span.firstLineBefore);
      b.writeString(colors.Green);
      b.writeBytes(span.firstLineMarked);
      b.writeString(colors.Dim);
      b.writeBytes(span.firstLineAfter);
      b.writeString("\n");
      b.writeBytes(emptyMarginText(maxMargin, false));
      b.writeBytes(span.indent);
      b.writeString(colors.Green);
      b.writeBytes(span.marker);
      b.writeString(colors.Dim);
      b.writeString("\n");
      b.writeBytes(emptyMarginText(maxMargin, true));
      b.writeBytes(span.indent);
      b.writeString(colors.Green);
      b.writeString(loc.Suggestion);
      b.writeString(colors.Reset);
      b.writeString("\n");
      b.writeBytes(span.afterFirstLine);
    } else {
      b.writeString("\n    ");
      b.writeString(path);
      b.writeString(":");
      b.writeString(`${loc.Line}`);
      b.writeString(":");
      b.writeString(`${loc.Column}`);
      b.writeString(":\n");
      b.writeString(colors.Dim);
      b.writeBytes(margin);
      b.writeBytes(span.firstLineBefore);
      b.writeString(colors.Green);
      b.writeBytes(span.firstLineMarked);
      b.writeString(colors.Dim);
      b.writeBytes(span.firstLineAfter);
      b.writeString("\n");
      b.writeBytes(emptyMarginText(maxMargin, true));
      b.writeBytes(span.indent);
      b.writeString(colors.Green);
      b.writeBytes(span.marker);
      b.writeString(colors.Reset);
      b.writeString("\n");
      b.writeBytes(span.afterFirstLine);
    }
    location = b.bytes();
  }

  switch (kind) {
    case 5: // Verbose
      iconColor = colors.Cyan;
      kindColorBrackets = colors.CyanBgCyan;
      kindColorText = colors.CyanBgBlack;
      break;

    case 4: // Debug
      iconColor = colors.Green;
      kindColorBrackets = colors.GreenBgGreen;
      kindColorText = colors.GreenBgWhite;
      break;

    case 2: // Info
      iconColor = colors.Blue;
      kindColorBrackets = colors.BlueBgBlue;
      kindColorText = colors.BlueBgWhite;
      break;

    case 0: // Error
      iconColor = colors.Red;
      kindColorBrackets = colors.RedBgRed;
      kindColorText = colors.RedBgWhite;
      break;

    case 1: // Warning
      iconColor = colors.Yellow;
      kindColorBrackets = colors.YellowBgYellow;
      kindColorText = colors.YellowBgBlack;
      break;

    case 3: { // Note
      const sb = new ByteBuilder();

      for (const line of data.Text.split("\n")) {
        // Special-case word wrapping
        let wrapWidth = terminalInfo.Width;
        if (wrapWidth > 2) {
          if (!data.DisableMaximumWidth && wrapWidth > 100) {
            wrapWidth = 100; // Enforce a maximum paragraph width for readability
          }
          for (const run of wrapWordsInString(utf8(line), wrapWidth - 2)) {
            sb.writeString("  ");
            sb.writeBytes(linkifyText(run, colors.Underline, colors.Reset));
            sb.writeByte(0x0a);
          }
          continue;
        }

        // Otherwise, just write an indented line
        sb.writeString("  ");
        sb.writeBytes(linkifyText(utf8(line), colors.Underline, colors.Reset));
        sb.writeByte(0x0a);
      }

      sb.writeBytes(location);
      return sb.bytes();
    }
  }

  if (pluginName !== "") {
    pluginName = ` ${colors.Bold}${colors.Magenta}[plugin ${pluginName}]${colors.Reset}`;
  }

  let msgID = MsgIDToString(id);
  if (msgID !== "") msgID = ` [${msgID}]`;

  const out = new ByteBuilder();
  out.writeString(iconColor);
  out.writeString(Icon(kind));
  out.writeString(" ");
  out.writeString(kindColorBrackets);
  out.writeString("[");
  out.writeString(kindColorText);
  out.writeString(String(kind));
  out.writeString(kindColorBrackets);
  out.writeString("]");
  out.writeString(colors.Reset);
  out.writeString(" ");
  out.writeString(colors.Bold);
  out.writeString(data.Text);
  out.writeString(colors.Reset);
  out.writeString(pluginName);
  out.writeString(msgID);
  out.writeString("\n");
  out.writeBytes(location);
  return out.bytes();
}
