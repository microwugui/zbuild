// 1:1 移植自 esbuild internal/helpers/waitgroup.go（v0.28.2，f6058f83）
// Go 用 atomic + channel 实现「线程安全且可并发 Add/Wait」的 WaitGroup。
// TS 单线程下不需要真正的阻塞：counter<=0 时 Wait 立即返回。

/** Go: type ThreadSafeWaitGroup struct (waitgroup.go:11) */
export class ThreadSafeWaitGroup {
  counter: number = 0;

  /** Go: func MakeThreadSafeWaitGroup() *ThreadSafeWaitGroup (waitgroup.go:17) */
  constructor() {}

  /** Go: func (wg *ThreadSafeWaitGroup) Add(delta int32) (waitgroup.go:23) */
  Add(delta: number): void {
    this.counter += delta;
    if (this.counter < 0) throw new Error("sync: negative WaitGroup counter");
  }

  /** Go: func (wg *ThreadSafeWaitGroup) Done() (waitgroup.go:31) */
  Done(): void {
    this.Add(-1);
  }

  /** Go: func (wg *ThreadSafeWaitGroup) Wait() (waitgroup.go:35) */
  Wait(): void {
    // Go: <-wg.channel —— 单线程下 counter 已由 Done 减到 0，立即返回
  }
}

/** Go: func MakeThreadSafeWaitGroup() *ThreadSafeWaitGroup (waitgroup.go:17) */
export function MakeThreadSafeWaitGroup(): ThreadSafeWaitGroup {
  return new ThreadSafeWaitGroup();
}
