// 1:1 移植自 esbuild internal/helpers/serializer.go（v0.28.2，f6058f83）
// Go 用 sync.WaitGroup 做「Enter(i) 等 Leave(i-1)」的顺序约束。TS 单线程下
// Enter/Leave 本就是顺序调用，结构（flags）与 Go 语义保持一致。

/** Go: type Serializer struct (serializer.go:8) */
export class Serializer {
  flags: number[] = [];

  /** Go: func MakeSerializer(count int) Serializer (serializer.go:10) */
  constructor(count: number) {
    // Go: flags[i].Add(1) —— 每把锁初始计数 1
    this.flags = new Array(count).fill(1);
  }

  /** Go: func (s *Serializer) Enter(i int) (serializer.go:18) */
  Enter(i: number): void {
    // Go: if i > 0 { s.flags[i-1].Wait() } —— 单线程下前一步 Leave 已同步完成
  }

  /** Go: func (s *Serializer) Leave(i int) (serializer.go:24) */
  Leave(i: number): void {
    this.flags[i] = 0; // Go: s.flags[i].Done()
  }
}

/** Go: func MakeSerializer(count int) Serializer (serializer.go:10) */
export function MakeSerializer(count: number): Serializer {
  return new Serializer(count);
}
