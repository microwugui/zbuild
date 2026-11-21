// 1:1 移植自 esbuild internal/helpers/joiner.go（v0.28.2）
// DEVIATION: Go 的 string / []byte 参数统一为 Uint8Array（字节语义）。

interface JoinerString { data: Uint8Array; offset: number; }
interface JoinerBytes { data: Uint8Array; offset: number; }

export class Joiner {
  strings: JoinerString[] = [];
  bytes: JoinerBytes[] = [];
  length = 0; // Go: uint32，按 32 位回绕
  lastByte = 0;

  /** Go: func (j *Joiner) AddString(data string) */
  AddString(data: Uint8Array): void {
    if (data.length > 0) this.lastByte = data[data.length - 1];
    this.strings.push({ data, offset: this.length });
    this.length = (this.length + data.length) >>> 0;
  }

  /** Go: func (j *Joiner) AddBytes(data []byte) */
  AddBytes(data: Uint8Array): void {
    if (data.length > 0) this.lastByte = data[data.length - 1];
    this.bytes.push({ data, offset: this.length });
    this.length = (this.length + data.length) >>> 0;
  }

  /** Go: func (j *Joiner) LastByte() byte */
  LastByte(): number {
    return this.lastByte;
  }

  /** Go: func (j *Joiner) Length() uint32 */
  Length(): number {
    return this.length;
  }

  /** Go: func (j *Joiner) EnsureNewlineAtEnd() */
  EnsureNewlineAtEnd(): void {
    if (this.length > 0 && this.lastByte !== 0x0a) {
      this.AddString(new Uint8Array([0x0a]));
    }
  }

  /** Go: func (j *Joiner) Done() []byte */
  Done(): Uint8Array {
    if (this.strings.length === 0 && this.bytes.length === 1 && this.bytes[0].offset === 0) {
      // 只有一个字节数组时无需分配（Go 返回同一个底层数组）
      return this.bytes[0].data;
    }
    const buffer = new Uint8Array(this.length);
    for (const item of this.strings) buffer.set(item.data, item.offset);
    for (const item of this.bytes) buffer.set(item.data, item.offset);
    return buffer;
  }

  /** Go: func (j *Joiner) Contains(s string, b []byte) bool */
  Contains(s: Uint8Array, b: Uint8Array): boolean {
    for (const item of this.strings) if (containsBytes(item.data, s)) return true;
    for (const item of this.bytes) if (containsBytes(item.data, b)) return true;
    return false;
  }
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true;
  const n = haystack.length - needle.length;
  outer: for (let i = 0; i <= n; i++) {
    for (let k = 0; k < needle.length; k++) {
      if (haystack[i + k] !== needle[k]) continue outer;
    }
    return true;
  }
  return false;
}
