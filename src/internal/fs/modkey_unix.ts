// 1:1 移植自 esbuild internal/fs/modkey_unix.go（v0.28.2）—— build tag darwin||freebsd||linux。
// Go 用 golang.org/x/sys/unix.Stat 取 inode/size/mtime/mode/uid；TS 用 node:fs.statSync(bigint)。
// 判定语义（逐行对齐 Go）：mtime 全 0 → unusable；mtime+gap 晚于 now → unusable（文件太新）。
import { statSync } from "node:fs";
import { ModKey, modKeySafetyGap, modKeyUnusable } from "./modkey.ts";
import type { ModKeyResult } from "./modkey.ts";

/** Go: func modKey(path string) (ModKey, error) (modkey_unix.go:12) */
export function modKey(path: string): ModKeyResult {
  let st;
  try { st = statSync(path, { bigint: true }); }
  catch (e: any) { return { key: new ModKey(), err: "stat-error:" + (e?.code ?? "unknown") }; }
  const mtimeSec = st.mtimeNs !== undefined ? BigInt(st.mtimeNs) / 1000000000n : BigInt(st.mtimeMs) / 1000n;
  const mtimeNsec = st.mtimeNs !== undefined ? BigInt(st.mtimeNs) % 1000000000n : (BigInt(st.mtimeMs) % 1000n) * 1000000n;
  // mtime 全 0 → unusable
  if (mtimeSec === 0n && mtimeNsec === 0n) return { key: new ModKey(), err: modKeyUnusable };
  // 文件太新：mtime + gap > now
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (mtimeSec + BigInt(modKeySafetyGap) > nowSec) return { key: new ModKey(), err: modKeyUnusable };
  const key = new ModKey();
  key.inode = st.ino; key.size = st.size;
  key.mtime_sec = mtimeSec; key.mtime_nsec = mtimeNsec;
  key.mode = Number(BigInt(st.mode) & 0xffffffffn); // uint32 截断
  key.uid = Number(st.uid & 0xffffffffn);
  return { key, err: "" };
}
