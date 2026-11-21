// bench/align_worker.ts —— 单例产物求值 worker（供 bench/align.py 以子进程+超时调用）。
// import 目标模块时 argv[1] 是本文件，驱动底部 CLI 守卫不会触发（见 AB_NOTES.md §1）。
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

function arg(name: string): string | undefined {
  const a = process.argv.slice(2);
  const i = a.indexOf(name);
  return i >= 0 ? a[i + 1] : undefined;
}
async function main() {
  const modPath = arg("--mod")!, entry = arg("--entry")!, driver = arg("--driver") ?? "single";
  const out = arg("--out");
  const m: any = await import(modPath + "?v=" + Date.now() + "-" + Math.random());
  const r = driver === "multi" ? m.bundleWithImports(entry) :
    m.bundleSingleFile(new Uint8Array(readFileSync(entry)), entry);
  if (!r.ok) { console.log(JSON.stringify({ ok: false, error: String(r.error).slice(0, 200) })); return; }
  if (out) writeFileSync(out, r.output);
  const sha256 = createHash("sha256").update(r.output).digest("hex");
  console.log(JSON.stringify({ ok: true, len: r.output.length, sha256 }));
}
main().catch((e: any) => {
  console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e).slice(0, 200) }));
  process.exit(1);
});
