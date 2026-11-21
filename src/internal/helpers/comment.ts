// 1:1 移植自 esbuild internal/helpers/comment.go（v0.28.2）
// DEVIATION: Go 的 string 参数/返回值改为 Uint8Array（字节语义）。

/** Go: func EscapeClosingTag(text string, slashTag string) string */
export function EscapeClosingTag(text: Uint8Array, slashTag: Uint8Array): Uint8Array {
  if (slashTag.length === 0) return text;

  let i = indexOfBytes(text, 0x3c, 0x2f, 0); // "</"
  if (i < 0) return text;

  const out: number[] = [];
  for (;;) {
    // b.WriteString(text[:i+1])
    for (let k = 0; k < i + 1; k++) out.push(text[k]);
    text = text.subarray(i + 1);

    if (text.length >= slashTag.length && equalFold(text.subarray(0, slashTag.length), slashTag)) {
      out.push(0x5c); // '\\'
    }
    i = indexOfBytes(text, 0x3c, 0x2f, 0);
    if (i < 0) break;
  }
  for (let k = 0; k < text.length; k++) out.push(text[k]);
  return new Uint8Array(out);
}

function indexOfBytes(b: Uint8Array, x: number, y: number, from: number): number {
  for (let i = from; i + 1 < b.length; i++) {
    if (b[i] === x && b[i + 1] === y) return i;
  }
  return -1;
}

/** Go strings.EqualFold 的 ASCII 子集（esbuild 只用它比较 HTML 标签名） */
function equalFold(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    let x = a[i], y = b[i];
    if (x >= 0x41 && x <= 0x5a) x += 0x20;
    if (y >= 0x41 && y <= 0x5a) y += 0x20;
    if (x !== y) return false;
  }
  return true;
}
