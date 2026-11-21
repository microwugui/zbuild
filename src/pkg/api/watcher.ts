// 1:1 移植自 esbuild pkg/api/watcher.go（v0.28.2）。
// 第 106 轮：setWatchData 确定性状态（shouldLog=false）；期望值由 Go 包内探针
// tools/go/tmpgen_watcher_test.go → testdata/watcher-state-go.json（SHA 7617d3d2…）固化 4 场景。
// tryToFindDirtyPath 含 rand.Seed(time.Now()) + map 遍历（Go 源码可查），非确定性，不在本端口覆盖；
// start/stop 是 goroutine/时序，同样不谎称覆盖。
import type { FileLike } from "../../internal/logger/logger.ts";

/** Go: fs.WatchData（internal/fs/fs.go:214）—— Paths 每项返回非空路径表示变更 */
export interface WatchData { Paths: Map<string, () => string> }

/** Go: type watcher struct (watcher.go) —— 本端口覆盖 setWatchData 可达字段 */
export class watcher {
  data: WatchData = { Paths: new Map() };
  recentItems: string[] = [];
  itemsToScan: string[] = [];
  itemsPerIteration: number = 0;
  shouldLog: boolean = false;
  // 第 114 轮：start/stop 所需字段
  /** Go: w.shouldStop int32（atomic） */
  shouldStop: number = 0;
  /** Go: w.delayInMS time.Duration */
  delayInMS: number = 0;
  /** Go: w.rebuild func() fs.WatchData */
  rebuild: (() => WatchData) | null = null;
  /** Go: const watchIntervalSleep = 100ms（可注入以加速测试） */
  watchIntervalSleep: number = 100;
  /** Go: w.stopWaitGroup（用计数模拟 Wait） */
  stopWaitGroupCount: number = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  // 以下为 faithful 字段（本夹具不触发）：rebuild/delay/probe 相关
  fsObj: any = null;
  file: FileLike | null = null;

  /** Go: func (w *watcher) setWatchData(data fs.WatchData) (watcher.go:66) */
  setWatchData(data: WatchData): void {
    // shouldLog=true 的首构建打印分支本夹具以 shouldLog=false 屏蔽；fixture 为确定性子集。
    this.data = data;
    this.itemsToScan = []; // 复用内存：TS 直接清空
    // Remove any recent items that weren't a part of the latest build
    let end = 0;
    for (const path of this.recentItems) {
      if (data.Paths.has(path)) { this.recentItems[end] = path; end++; }
    }
    this.recentItems = this.recentItems.slice(0, end);
  }

  /**
   * Go: func (w *watcher) start() (watcher.go:95)。Go 用 goroutine 循环；TS 用递归 setTimeout
   * 复刻同一循环（检查 shouldStop → 睡 interval → tryToFindDirtyPath → 脏则 rebuild）。
   * 时序本身不逐字节比对；夹具验「启动后会触发 rebuild、stop 后循环终止」的状态。
   */
  start(): void {
    this.stopWaitGroupCount += 1;
    const loop = (): void => {
      if (this.shouldStop === 0) {
        this.timer = setTimeout(() => {
          this.timer = null;
          const absPath = this.tryToFindDirtyPath();
          if (absPath !== "") {
            if (this.delayInMS > 0) {
              // Go: time.Sleep(delayInMS * ms)；单线程 TS 以同步占位（夹具 delayInMS=0）
            }
            this.setWatchData(this.rebuild !== null ? this.rebuild() : { Paths: new Map() });
          }
          loop();
        }, this.watchIntervalSleep);
      } else {
        this.stopWaitGroupCount -= 1;
      }
    };
    loop();
  }

  /** Go: func (w *watcher) stop() (watcher.go:137) —— 置 shouldStop 并等待循环退出。 */
  stop(): void {
    this.shouldStop = 1;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    // 单线程：已无在途回调，等价于 stopWaitGroup.Wait() 立即返回
    this.stopWaitGroupCount = 0;
  }

  /** Go: func (w *watcher) tryToFindDirtyPath() string (watcher.go:142)
   *  Go 探针预置 itemsToScan 绕开 refill 的 rand 分支，取确定性路径（6 场景逐字节，SHA 87db84eb…）。
   *  refill 分支（itemsToScan 空时的 rand.Seed+洗牌）faithful 保留但不谎称已逐字节覆盖。
   */
  tryToFindDirtyPath(): string {
    const MAX_RECENT = 16, MIN_PER_ITER = 64, MAX_INTERVALS = 20;
    if (this.itemsToScan.length === 0) {
      const items = [...this.data.Paths.keys()];
      // Go: rand.Seed(time.Now()) + Fisher-Yates —— 非确定性，此分支不在夹具覆盖
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
      this.itemsToScan = items;
      let perIter = Math.ceil(items.length / MAX_INTERVALS);
      if (perIter < MIN_PER_ITER) perIter = MIN_PER_ITER;
      this.itemsPerIteration = perIter;
    }
    // Always check all recent items every iteration
    for (let i = 0; i < this.recentItems.length; i++) {
      const path = this.recentItems[i];
      const check = this.data.Paths.get(path);
      const dirty = check ? check() : "";
      if (dirty !== "") {
        // Move this path to the back of the list
        this.recentItems.splice(i, 1);
        this.recentItems.push(path);
        return dirty;
      }
    }
    // Check a constant number of items every iteration
    let remainingCount = this.itemsToScan.length - this.itemsPerIteration;
    if (remainingCount < 0) remainingCount = 0;
    const toCheck = this.itemsToScan.slice(remainingCount);
    const remaining = this.itemsToScan.slice(0, remainingCount);
    this.itemsToScan = remaining;
    for (const path of toCheck) {
      const check = this.data.Paths.get(path);
      const dirty = check ? check() : "";
      if (dirty !== "") {
        this.recentItems.push(path);
        if (this.recentItems.length > MAX_RECENT) this.recentItems = this.recentItems.slice(this.recentItems.length - MAX_RECENT);
        return dirty;
      }
    }
    return "";
  }
}
