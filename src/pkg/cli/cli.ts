// 1:1 移植自 esbuild pkg/cli/cli.go（v0.28.2，commit f6058f83）
// 第 102 轮成片端口：CLI 公开解析入口（ParseBuildOptions / ParseTransformOptions /
// ParseServeOptions）薄包装 → cli_impl.ts 的真实解析底座。字节证据 testdata/cli-chain-go.json。
import { readFileSync } from "node:fs";
import { newBuildOptions, newTransformOptions, parseOptionsImpl, parseServeOptionsImpl, runImpl } from "./cli_impl.ts";
import type { ServeOptionsIR } from "./cli_impl.ts";
import type { BuildOptionsInput } from "../api/api_impl.ts";
import type { FileLike } from "../../internal/logger/logger.ts";

// 第 103 轮成片端口：CLI 主循环公开入口 Run / RunWithPlugins → runImpl。
const realStderr: FileLike = { WriteString: (b: Uint8Array) => { process.stderr.write(b); } };

/** Go: func Run(osArgs []string) int (cli.go:30) —— IO 可注入（默认真实 stdin/stdout/stderr），便于逐字节测试 */
export function Run(
  osArgs: string[],
  io?: { stdin: Uint8Array; writeOut: (b: Uint8Array) => void; stderr: FileLike },
): number {
  if (io) return runImpl(osArgs, io.stdin, io.writeOut, io.stderr);
  let input = new Uint8Array(0);
  try { input = new Uint8Array(readFileSync(0)); } catch { /* 无 stdin */ }
  return runImpl(osArgs, input, (b) => { process.stdout.write(b); }, realStderr);
}

/** Go: func RunWithPlugins(osArgs []string, plugins) int (cli.go:36) */
export function RunWithPlugins(
  osArgs: string[], plugins: any[] = [],
  io?: { stdin: Uint8Array; writeOut: (b: Uint8Array) => void; stderr: FileLike },
): number {
  // TS 侧插件由 service/convertPlugins 承载；此处与主 Run 同口径（plugins 透传预留）。
  void plugins;
  return Run(osArgs, io);
}

type TransformOptionsIR = { Format?: number; Define?: Map<string, string>; MinifyWhitespace?: boolean; MinifySyntax?: boolean; MinifyIdentifiers?: boolean; Loader?: number; LogLevel?: number; Target?: number; Platform?: number; Sourcemap?: number; MangleProps?: string };

/** Go: func ParseBuildOptions(osArgs []string) (BuildOptions, error) (cli.go:53) */
export function ParseBuildOptions(osArgs: string[]): { options: BuildOptionsInput; err: string | null } {
  const options = newBuildOptions();
  const { err } = parseOptionsImpl(osArgs, options, null, "build");
  return { options, err: err === null ? null : err.Text };
}

/** Go: func ParseTransformOptions(osArgs []string) (TransformOptions, error) (cli.go:75) */
export function ParseTransformOptions(osArgs: string[]): { options: TransformOptionsIR; err: string | null } {
  const options = newTransformOptions();
  const { err } = parseOptionsImpl(osArgs, null, options, "transform");
  return { options, err: err === null ? null : err.Text };
}

/** Go: func ParseServeOptions(osArgs []string) (ServeOptions, []string, error) (cli.go:98) */
export function ParseServeOptions(osArgs: string[]): { options: ServeOptionsIR; rest: string[]; err: string | null } {
  const { opts, rest, err } = parseServeOptionsImpl(osArgs);
  return { options: opts, rest, err };
}
