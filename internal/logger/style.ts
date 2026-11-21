// 1:1 移植自 esbuild internal/logger/style.go（v0.28.2，commit f6058f83）
//
// DEVIATION（已论证）：Go 的 string 是字节串，本文件里所有索引/切片按字节，入参与返回值
// 一律 `Uint8Array`（见 bytes.ts 的文件头与 PLAN.md「第 6 次推进」§0）。
// 只有「按 rune 计数」的地方（estimateWidthInTerminal / wrapWordsInString 的列宽 / renderTabStops）
// 走 `decodeRune`，它等价于 Go 的 utf8.DecodeRuneInString（非法编码 → RuneError,1）。

import { ByteBuilder, decodeRune, indexOfBytes, spaces, utf8 } from "./bytes.ts";

/**
 * Go: func linkifyText(text string, underline string, reset string) string
 *
 * underline 为空（--color=false）时原样返回。
 */
export function linkifyText(text: Uint8Array, underline: string, reset: string): Uint8Array {
  if (underline === "") return text;

  const scheme = utf8("https://");
  if (indexOfBytes(text, scheme) === -1) return text;

  const sb = new ByteBuilder();
  const space = utf8(" ");
  for (;;) {
    const https = indexOfBytes(text, scheme);
    if (https === -1) break;

    let end = indexOfBytes(text.subarray(https), space);
    if (end === -1) end = text.length;
    else end += https;

    // Remove trailing punctuation
    if (end > https) {
      switch (text[end - 1]) {
        case 0x2e: // .
        case 0x2c: // ,
        case 0x3f: // ?
        case 0x21: // !
        case 0x29: // )
        case 0x5d: // ]
        case 0x7d: // }
          end--;
      }
    }

    sb.writeBytes(text.subarray(0, https));
    sb.writeString(underline);
    sb.writeBytes(text.subarray(https, end));
    sb.writeString(reset);
    text = text.subarray(end);
  }

  sb.writeBytes(text);
  return sb.bytes();
}

/**
 * Go: func wrapWordsInString(text string, width int) []string
 *
 * 注意 Go 里内层 `c, width := utf8.DecodeRuneInString(...)` 把外层的 width 遮蔽了，
 * 这里改名成 `size`，避免误用。
 */
export function wrapWordsInString(text: Uint8Array, width: number): Uint8Array[] {
  const runs: Uint8Array[] = [];

  outer: for (;;) {
    if (text.length === 0) break;
    let i = 0;
    let x = 0;
    let wordEndI = 0;

    // Skip over any leading spaces
    while (i < text.length && text[i] === 0x20) {
      i++;
      x++;
    }

    // Find out how many words will fit in this run
    while (i < text.length) {
      const oldWordEndI = wordEndI;
      const wordStartI = i;

      // Find the end of the word
      while (i < text.length) {
        const { r: c, width: size } = decodeRune(text, i);
        if (c === 0x20) break;
        i += size;
        x += 1; // Naively assume that each unicode code point is a single column
      }
      wordEndI = i;

      // Split into a new run if this isn't the first word in the run and the end is past the width
      if (wordStartI > 0 && x > width) {
        runs.push(text.subarray(0, oldWordEndI));
        text = text.subarray(wordStartI);
        continue outer;
      }

      // Skip over any spaces after the word
      while (i < text.length && text[i] === 0x20) {
        i++;
        x++;
      }
    }

    // If we get here, this is the last run (i.e. everything fits)
    break;
  }

  // Remove any trailing spaces on the last run
  while (text.length > 0 && text[text.length - 1] === 0x20) text = text.subarray(0, text.length - 1);
  runs.push(text);
  return runs;
}

/** Go: type formattedLineSpan struct {...} —— 字段都是字节切片 */
export class FormattedLineSpan {
  firstLineBefore: Uint8Array = new Uint8Array(0);
  firstLineMarked: Uint8Array = new Uint8Array(0);
  firstLineAfter: Uint8Array = new Uint8Array(0);
  afterFirstLine: Uint8Array = new Uint8Array(0);
  marker: Uint8Array = new Uint8Array(0);
  indent: Uint8Array = new Uint8Array(0);
}

/**
 * Go: func formatLineSpan(lineText string, line int, column int, length int, widthLimit int) formattedLineSpan
 */
export function formatLineSpan(
  lineText: Uint8Array,
  line: number,
  column: number,
  length: number,
  widthLimit: number,
): FormattedLineSpan {
  let endOfFirstLine = lineText.length;

  // Note: Go 用 IndexByte（SIMD）；这里按字节找即可，语义相同。
  {
    const i = lineText.indexOf(0x0a);
    if (i >= 0) endOfFirstLine = i;
  }

  const firstLine = lineText.subarray(0, endOfFirstLine);
  let afterFirstLine = lineText.subarray(endOfFirstLine);
  if (afterFirstLine.length > 0 && afterFirstLine[afterFirstLine.length - 1] !== 0x0a) {
    const b = new ByteBuilder();
    b.writeBytes(afterFirstLine);
    b.writeByte(0x0a);
    afterFirstLine = b.bytes();
  }

  // Clamp values in range
  if (line < 0) line = 0;
  if (column < 0) column = 0;
  if (length < 0) length = 0;
  if (column > endOfFirstLine) column = endOfFirstLine;
  if (length > endOfFirstLine - column) length = endOfFirstLine - column;

  const spacesPerTab = 2;
  lineText = renderTabStops(firstLine, spacesPerTab);
  const textUpToLoc = renderTabStops(firstLine.subarray(0, column), spacesPerTab);
  let markerStart = textUpToLoc.length;
  let markerEnd = markerStart;
  let indent = spaces(estimateWidthInTerminal(textUpToLoc));
  let marker = utf8("^");

  // Extend markers to cover the full range of the error
  if (length > 0) {
    markerEnd = renderTabStops(firstLine.subarray(0, column + length), spacesPerTab).length;
  }

  // Clip the marker to the bounds of the line
  if (markerStart > lineText.length) markerStart = lineText.length;
  if (markerEnd > lineText.length) markerEnd = lineText.length;
  if (markerEnd < markerStart) markerEnd = markerStart;

  // Trim the line to fit the terminal width
  let width = widthLimit;
  if (width < 1) width = 1;
  if (column === endOfFirstLine) {
    // If the marker is at the very end of the line, the marker will be a "^"
    // character that extends one column past the end of the line. In this case
    // we should reserve a column at the end so the marker doesn't wrap.
    width -= 1;
  }
  if (lineText.length > width) {
    // Try to center the error
    let sliceStart = Math.trunc((markerStart + markerEnd - width) / 2);
    if (sliceStart > markerStart - Math.trunc(width / 5)) sliceStart = markerStart - Math.trunc(width / 5);
    if (sliceStart < 0) sliceStart = 0;
    if (sliceStart > lineText.length - width) sliceStart = lineText.length - width;
    const sliceEnd = sliceStart + width;

    // Slice the line
    let slicedLine = lineText.subarray(sliceStart, sliceEnd);
    markerStart -= sliceStart;
    markerEnd -= sliceStart;
    if (markerStart < 0) markerStart = 0;
    if (markerEnd > slicedLine.length) markerEnd = slicedLine.length;

    // Truncate the ends with "..."
    if (slicedLine.length > 3 && sliceStart > 0) {
      slicedLine = concatTwo(utf8("..."), slicedLine.subarray(3));
      if (markerStart < 3) markerStart = 3;
    }
    if (slicedLine.length > 3 && sliceEnd < lineText.length) {
      slicedLine = concatTwo(slicedLine.subarray(0, slicedLine.length - 3), utf8("..."));
      if (markerEnd > slicedLine.length - 3) markerEnd = slicedLine.length - 3;
      if (markerEnd < markerStart) markerEnd = markerStart;
    }

    // Now we can compute the indent
    lineText = slicedLine;
    indent = spaces(estimateWidthInTerminal(lineText.subarray(0, markerStart)));
  }

  // If marker is still multi-character after clipping, make the marker wider
  if (markerEnd - markerStart > 1) {
    marker = new Uint8Array(estimateWidthInTerminal(lineText.subarray(markerStart, markerEnd))).fill(0x7e);
  }

  const span = new FormattedLineSpan();
  span.firstLineBefore = lineText.subarray(0, markerStart);
  span.firstLineMarked = lineText.subarray(markerStart, markerEnd);
  span.firstLineAfter = lineText.subarray(markerEnd);
  span.afterFirstLine = afterFirstLine;
  span.marker = marker;
  span.indent = indent;
  return span;
}

/** Estimate the number of columns this string will take when printed */
export function estimateWidthInTerminal(text: Uint8Array): number {
  // For now just assume each code point is one column. This is wrong but is
  // less wrong than assuming each code unit is one column.
  let width = 0;
  let i = 0;
  while (i < text.length) {
    const { r: c, width: size } = decodeRune(text, i);
    i += size;

    // Ignore the Zero Width No-Break Space character (UTF-8 BOM)
    if (c !== 0xfeff) width++;
  }
  return width;
}

/** Go: func renderTabStops(withTabs string, spacesPerTab int) string */
export function renderTabStops(withTabs: Uint8Array, spacesPerTab: number): Uint8Array {
  if (withTabs.indexOf(0x09) < 0) return withTabs;

  const withoutTabs = new ByteBuilder();
  let count = 0;
  let i = 0;
  while (i < withTabs.length) {
    const { r: c, width: size } = decodeRune(withTabs, i);
    i += size;
    if (c === 0x09) {
      const n = spacesPerTab - (count % spacesPerTab);
      for (let j = 0; j < n; j++) {
        withoutTabs.writeByte(0x20);
        count++;
      }
    } else {
      withoutTabs.writeRune(c);
      count++;
    }
  }

  return withoutTabs.bytes();
}

function concatTwo(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
