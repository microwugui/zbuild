// 1:1 移植自 esbuild internal/helpers/dataurl.go（v0.28.2，commit f6058f83）
//
// DEVIATION（类型）：Go 的 `text string` 本质是字节串，这里用 `Uint8Array` 承载，
// 以便与 Go 的 len()/utf8.DecodeRuneInString 逐字节一致（JS string 的 length 是 UTF-16 单元数）。
// 两处返回值也与 Go 对应：`EncodeStringAsPercentEscapedDataURL` 的 (string, bool) 改为
// `{ value, ok }`。

const hex = "0123456789ABCDEF";

/** Go: func isHex(c byte) bool (internal/helpers/dataurl.go:70) */
export function isHex(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);
}

/** Go: func EncodeStringAsShortestDataURL(mimeType string, text string) string (internal/helpers/dataurl.go:11) */
export function EncodeStringAsShortestDataURL(mimeType: string, text: Uint8Array): string {
  const encoded = Buffer.from(text).toString("base64");
  const url = `data:${mimeType};base64,${encoded}`;
  const percentURL = EncodeStringAsPercentEscapedDataURL(mimeType, text);
  if (percentURL.ok && Buffer.byteLength(percentURL.value, "utf8") < Buffer.byteLength(url, "utf8")) {
    return percentURL.value;
  }
  return url;
}

/** Go: func EncodeStringAsPercentEscapedDataURL(mimeType string, text string) (string, bool) (internal/helpers/dataurl.go:21) */
export function EncodeStringAsPercentEscapedDataURL(
  mimeType: string,
  text: Uint8Array,
): { value: string; ok: boolean } {
  // Go: `if c == utf8.RuneError && width == 1 { return "", false }` —— 整个输入必须是合法 UTF-8
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(text);
  } catch {
    return { value: "", ok: false };
  }

  const n = text.length;
  const encoder = new TextEncoder();
  let out = "data:" + mimeType + ",";
  let i = 0;
  let runStart = 0;

  // Scan for trailing characters that need to be escaped
  let trailingStart = n;
  while (trailingStart > 0) {
    const c = text[trailingStart - 1];
    if (c > 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) break;
    trailingStart--;
  }

  for (const ch of decoded) {
    const c = ch.codePointAt(0)!;
    const width = encoder.encode(ch).length;

    // Escape this character if needed
    if (
      c === 0x09 || c === 0x0a || c === 0x0d || c === 0x23 /* # */ || i >= trailingStart ||
      (c === 0x25 /* % */ && i + 2 < n && isHex(text[i + 1]) && isHex(text[i + 2]))
    ) {
      if (runStart < i) out += new TextDecoder().decode(text.subarray(runStart, i));
      out += "%" + hex[c >> 4] + hex[c & 15];
      runStart = i + width;
    }

    i += width;
  }

  if (runStart < n) out += new TextDecoder().decode(text.subarray(runStart, n));

  return { value: out, ok: true };
}
