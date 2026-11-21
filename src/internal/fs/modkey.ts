// 共享类型与常量：Go internal/fs ModKey（fs.go:222）+ modKeySafetyGap（fs.go:237）。
/** Go: type ModKey struct (fs.go:222) —— OS 相关字段 */
export class ModKey {
  inode = 0n;      // uint64
  size = 0n;       // int64
  mtime_sec = 0n;  // int64
  mtime_nsec = 0n; // int64
  mode = 0;        // uint32
  uid = 0;         // uint32
}

/** Go: const modKeySafetyGap = 3 (fs.go:237) */
export const modKeySafetyGap = 3;
/** Go: var modKeyUnusable = errors.New(...) (fs.go:238) —— TS 侧用稳定 tag 表达 */
export const modKeyUnusable = "The modification key is unusable";

export interface ModKeyResult { key: ModKey; err: string; }
