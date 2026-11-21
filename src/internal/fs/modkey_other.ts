// 1:1 移植自 esbuild internal/fs/modkey_other.go（v0.28.2）—— build tag !darwin&&!freebsd&&!linux。
// Go 用 os.Stat：mtime==zeroTime 或 mtime.Unix()==0 → unusable；mtime+gap>now → unusable；
// 返回 size/mtime_sec/mode（无 inode/nsec/uid）。TS 在 Node/Linux 主用 modkey_unix，本文件是非 unix 变体的忠实移植。
import { statSync } from "node:fs";
import { ModKey, modKeySafetyGap, modKeyUnusable } from "./modkey.ts";
import type { ModKeyResult } from "./modkey.ts";

/** Go: func modKey(path string) (ModKey, error) (modkey_other.go:13) */
export function modKey(path: string): ModKeyResult {
  let st;
  try { st = statSync(path, { bigint: true }); }
  catch (e: any) { return { key: new ModKey(), err: "stat-error:" + (e?.code ?? "unknown") }; }
  const mtimeMs = BigInt(st.mtimeMs);
  const mtimeSec = mtimeMs / 1000n;
  // mtime.Unix() == 0 → unusable（Go 不检查 nsec，只看秒）
  if (mtimeSec === 0n) return { key: new ModKey(), err: modKeyUnusable };
  // mtime + gap 晚于 now
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (mtimeSec + BigInt(modKeySafetyGap) > nowSec) return { key: new ModKey(), err: modKeyUnusable };
  const key = new ModKey();
  key.size = st.size; key.mtime_sec = mtimeSec;
  key.mode = Number(BigInt(st.mode) & 0xffffffffn);
  return { key, err: "" };
}
