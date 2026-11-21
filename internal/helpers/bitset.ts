// 1:1 移植自 esbuild internal/helpers/bitset.go（v0.28.2）
// Go 的值接收者 + 共享底层数组语义，在 TS 里用「同一 entries 引用」表达。
// DEVIATION: Go 的 String() 返回 string（UTF-8 字节），这里返回 Uint8Array。

export class BitSet {
  entries: Uint8Array;

  constructor(entries: Uint8Array) {
    this.entries = entries;
  }

  /** Go: func (bs BitSet) HasBit(bit uint) bool */
  HasBit(bit: number): boolean {
    return (this.entries[(bit / 8) | 0] & (1 << (bit & 7))) !== 0;
  }

  /** Go: func (bs BitSet) SetBit(bit uint) */
  SetBit(bit: number): void {
    this.entries[(bit / 8) | 0] |= 1 << (bit & 7);
  }

  /** Go: func (bs BitSet) Equals(other BitSet) bool */
  Equals(other: BitSet): boolean {
    const a = this.entries, b = other.entries;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /** Go: func (bs BitSet) String() string */
  String(): Uint8Array {
    return this.entries;
  }
}

/** Go: func NewBitSet(bitCount uint) BitSet */
export function NewBitSet(bitCount: number): BitSet {
  return new BitSet(new Uint8Array(((bitCount + 7) / 8) | 0));
}
