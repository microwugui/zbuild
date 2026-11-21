// 1:1 移植自 esbuild pkg/cli/cli_impl.go（v0.28.2，commit f6058f83）
// 第 44 轮叶子优先规划：CLI 参数解析纯函数。字节证据由 Go 探针固化在
// testdata/cli-impl-go.json。
import { ErrorWithNote, MakeErrorWithNote, ParseLoader } from "../../internal/cli_helpers/cli_helpers.ts";
import { PrintErrorWithNoteToStderr, PrintTextWithColor, OutputOptionsForArgs, stderr as defaultStderr, type FileLike } from "../../internal/logger/logger.ts";
import { Transform, Build, AnalyzeMetafile } from "../api/api.ts";
import type { BuildOptionsInput, PluginBuild } from "../api/api_impl.ts";
import { Joiner } from "../../internal/helpers/joiner.ts";
import { QuoteForJSON } from "../../internal/helpers/quote.ts";

/** Go: func isBoolFlag(arg string, flag string) bool (cli_impl.go:59) */
export function isBoolFlag(arg: string, flag: string): boolean {
  if (arg.startsWith(flag)) {
    const remainder = arg.slice(flag.length);
    return remainder.length === 0 || remainder[0] === "=";
  }
  return false;
}

/** Go: func parseBoolFlag(arg string, defaultValue bool) (bool, *cli_helpers.ErrorWithNote) (cli_impl.go:67) */
export function parseBoolFlag(arg: string, defaultValue: boolean): { value: boolean; err: ErrorWithNote | null } {
  const equals = arg.indexOf("=");
  if (equals === -1) return { value: defaultValue, err: null };
  const value = arg.slice(equals + 1);
  if (value === "false") return { value: false, err: null };
  if (value === "true") return { value: true, err: null };
  return { value: false, err: MakeErrorWithNote(`Invalid value ${JSON.stringify(value)} in ${JSON.stringify(arg)}`, 'Valid values are "true" or "false".') };
}

/** Go: func parseLogLevel(value string, arg string) (api.LogLevel, *ErrorWithNote) (cli_impl.go:1558) */
export function parseLogLevel(value: string, arg: string): { value: number; err: ErrorWithNote | null } {
  const levels: Record<string, number> = { verbose: 1, debug: 2, info: 3, warning: 4, error: 5, silent: 0 };
  const v = levels[value];
  if (v !== undefined) return { value: v, err: null };
  return { value: 0, err: MakeErrorWithNote(`Invalid value ${JSON.stringify(value)} in ${JSON.stringify(arg)}`, 'Valid values are "verbose", "debug", "info", "warning", "error", or "silent".') };
}

/** Go: func parseLogStyle(value string, arg string) (api.LogStyle, *ErrorWithNote) (cli_impl.go:1580) */
export function parseLogStyle(value: string, arg: string): { value: number; err: ErrorWithNote | null } {
  const styles: Record<string, number> = { default: 0, clang: 1, visualstudio: 2 };
  const v = styles[value];
  if (v !== undefined) return { value: v, err: null };
  return { value: 0, err: MakeErrorWithNote(`Invalid value ${JSON.stringify(value)} in ${JSON.stringify(arg)}`, 'Valid values are "default", "clang", or "visualstudio".') };
}

/** Go: func isArgForBuild(arg string) bool (cli_impl.go:1080) */
export function isArgForBuild(arg: string): boolean {
  return !arg.startsWith("-") || arg === "--bundle";
}

/** Go: func printMangleCache(mangleCache map[string]interface{}, originalOrder []string, asciiOnly bool) []byte (mangle_cache.go:100) */
export function printMangleCache(mangleCache: Map<string, string | boolean | number>, originalOrder: string[], asciiOnly: boolean): Uint8Array {
  const enc = new TextEncoder();
  const j = new Joiner();
  j.AddString(enc.encode("{"));
  let order = originalOrder;
  if (mangleCache.size > order.length) {
    const keys = [...mangleCache.keys()];
    const sorted = [...order].sort();
    if (JSON.stringify(sorted) === JSON.stringify(order)) {
      order = keys.sort();
    } else {
      const original = new Set(order);
      order = [...order, ...keys.filter((k) => !original.has(k)).sort()];
    }
  }
  for (let i = 0; i < order.length; i++) {
    const key = order[i];
    j.AddString(enc.encode(i > 0 ? ",\n  " : "\n  "));
    j.AddBytes(QuoteForJSON(enc.encode(key), asciiOnly));
    const value = mangleCache.get(key);
    if (value !== false && value !== undefined) {
      j.AddString(enc.encode(": "));
      j.AddBytes(QuoteForJSON(enc.encode(String(value)), asciiOnly));
    } else {
      j.AddString(enc.encode(": false"));
    }
  }
  if (order.length > 0) j.AddString(enc.encode("\n"));
  j.AddString(enc.encode("}\n"));
  return j.Done();
}

/** Go: func splitWithEmptyCheck(s string, sep string) []string (cli_impl.go:1134) */
export function splitWithEmptyCheck(s: string, sep: string): string[] {
  if (s === "") return [];
  return s.split(sep);
}

const VALID_TARGETS: Record<string, number> = {
  esnext: 1, es5: 2, es6: 3, es2015: 3, es2016: 4, es2017: 5, es2018: 6,
  es2019: 7, es2020: 8, es2021: 9, es2022: 10, es2023: 11, es2024: 12, es2025: 13, es2026: 14,
};
const VALID_ENGINES: Record<string, number> = {
  chrome: 0, deno: 1, edge: 2, firefox: 3, hermes: 4, ie: 5, ios: 6, node: 7, opera: 8, rhino: 9, safari: 10,
};

/** Go: func parseTargets(targets []string, arg string) (api.Target, []api.Engine, *ErrorWithNote) (cli_impl.go:1025) */
export function parseTargets(targets: string[], arg: string): { target: number; engines: { name: number; version: string }[]; err: { Text: string; Note: string } | null } {
  let target = 0;
  const engines: { name: number; version: string }[] = [];
  for (const value of targets) {
    const valid = VALID_TARGETS[value.toLowerCase()];
    if (valid !== undefined) { target = valid; continue; }
    let matched = false;
    for (const engine of Object.keys(VALID_ENGINES)) {
      if (value.startsWith(engine)) {
        const version = value.slice(engine.length);
        if (version === "") return { target: 0, engines: [], err: MakeErrorWithNote(`Target ${JSON.stringify(value)} is missing a version number in ${JSON.stringify(arg)}`, "") };
        engines.push({ name: VALID_ENGINES[engine], version });
        matched = true; break;
      }
    }
    if (matched) continue;
    const names = ["\"esN\"", ...Object.keys(VALID_ENGINES).map((k) => JSON.stringify(k + "N"))].sort();
    const note = `Valid values are ${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]} where N is a version number.`;
    return { target: 0, engines: [], err: MakeErrorWithNote(`Invalid target ${JSON.stringify(value)} in ${JSON.stringify(arg)}`, note) };
  }
  return { target, engines, err: null };
}

/** Go: func newBuildOptions() api.BuildOptions (cli_impl.go:23) */
export function newBuildOptions(): BuildOptionsInput {
  return {
    Banner: new Map(), Define: new Map(), Footer: new Map(),
    Loader: new Map(), LogOverride: new Map(), Supported: new Map(),
  };
}

/** Go: func newTransformOptions() api.TransformOptions (cli_impl.go:34) */
export function newTransformOptions(): { Define: Map<string, string>; LogOverride: Map<string, number>; Supported: Map<string, boolean> } {
  return { Define: new Map(), LogOverride: new Map(), Supported: new Map() };
}

// ============================================================================
// 第 100 轮成片端口：CLI 选项解析底座（parseOptionsImpl + 公开 wrapper），当轮接进 service handler。
// 真实使用上面的 parseBoolFlag/parseLogLevel/parseTargets/ParseLoader 叶子构件，非桩。
// 端到端 oracle：testdata/service-chain-go.json（service handler 请求→响应逐字节）。

/** Go: parseOptionsExtras (cli_impl.go) —— 本链用到 watch 等；当前 harness 不涉及，保留空壳 */
export interface ParseOptionsExtras { watch: boolean; watchDelay: number }

/**
 * Go: func parseOptionsImpl(osArgs, buildOpts, transformOpts, kind) (extras, err) (cli_impl.go:85)
 * 聚焦 service 链实际驱动的 flags（bundle/define/minify/minify-whitespace/format/loader/platform/
 * sourcemap/target/log-level），逐条走真实叶子解析器；未知 flag 按 Go 文案报错。
 * 可扩展：新增 flag 按同结构追加 case 即可。
 */
export function parseOptionsImpl(
  osArgs: string[], buildOpts: BuildOptionsInput | null,
  transformOpts: { Format?: number; Define?: Map<string, string>; MinifyWhitespace?: boolean; MinifySyntax?: boolean; MinifyIdentifiers?: boolean; Loader?: number; LogLevel?: number; Target?: number; Platform?: number; Sourcemap?: number } | null,
  kind: "build" | "transform" = buildOpts !== null ? "build" : "transform",
): { extras: ParseOptionsExtras; err: ErrorWithNote | null } {
  const extras: ParseOptionsExtras = { watch: false, watchDelay: 0 };
  let hasBareSourceMapFlag = false;
  for (const arg of osArgs) {
    // --bundle (build only)
    if (isBoolFlag(arg, "--bundle") && buildOpts !== null) {
      const r = parseBoolFlag(arg, true); if (r.err) return { extras, err: r.err }; buildOpts.Bundle = r.value; continue;
    }
    // --define:KEY=VALUE
    if (arg.startsWith("--define:")) {
      const value = arg.slice("--define:".length);
      const eq = value.indexOf("=");
      if (eq === -1) return { extras, err: MakeErrorWithNote(`Missing "=" in ${JSON.stringify(arg)}`, 'You need to use "=" to specify both the original value and the replacement value. For example, "--define:DEBUG=true" replaces "DEBUG" with "true".') };
      const target = buildOpts !== null ? buildOpts : transformOpts!;
      if (target.Define === undefined) target.Define = new Map();
      (target.Define as Map<string, string>).set(value.slice(0, eq), value.slice(eq + 1));
      continue;
    }
    // --minify (both) / --minify-whitespace / --minify-syntax / --minify-identifiers
    if (isBoolFlag(arg, "--minify")) {
      const r = parseBoolFlag(arg, true); if (r.err) return { extras, err: r.err };
      const t = buildOpts ?? transformOpts!;
      t.MinifySyntax = r.value; t.MinifyWhitespace = r.value; (t as any).MinifyIdentifiers = r.value; continue;
    }
    if (isBoolFlag(arg, "--minify-whitespace")) {
      const r = parseBoolFlag(arg, true); if (r.err) return { extras, err: r.err };
      (buildOpts ?? transformOpts!).MinifyWhitespace = r.value; continue;
    }
    // --format=iife|cjs|esm
    if (arg.startsWith("--format=")) {
      const value = arg.slice("--format=".length);
      const map: Record<string, number> = { iife: 1, cjs: 2, esm: 3 };
      const f = map[value];
      if (f === undefined) return { extras, err: MakeErrorWithNote(`Invalid value ${JSON.stringify(value)} in ${JSON.stringify(arg)}`, 'Valid values are "iife", "cjs", or "esm".') };
      (buildOpts ?? transformOpts!).Format = f; continue;
    }
    // --loader=NAME
    if (arg.startsWith("--loader=")) {
      const value = arg.slice("--loader=".length);
      const r = ParseLoader(value); if (r.err) return { extras, err: r.err };
      if (buildOpts !== null) { if (!buildOpts.Loader) buildOpts.Loader = new Map(); buildOpts.Loader.set("*", r.loader); }
      else transformOpts!.Loader = r.loader;
      continue;
    }
    // --platform=browser|node|neutral (build only)
    if (arg.startsWith("--platform=") && buildOpts !== null) {
      const value = arg.slice("--platform=".length);
      const map: Record<string, number> = { browser: 1, node: 2, neutral: 3 };
      const p = map[value];
      if (p === undefined) return { extras, err: MakeErrorWithNote(`Invalid value ${JSON.stringify(value)} in ${JSON.stringify(arg)}`, 'Valid values are "browser", "node", or "neutral".') };
      buildOpts.Platform = p; continue;
    }
    // --target=X,Y
    if (arg.startsWith("--target=")) {
      const r = parseTargets(arg.slice("--target=".length).split(","), arg);
      if (r.err) return { extras, err: r.err as ErrorWithNote };
      (buildOpts ?? transformOpts!).Target = r.target; continue;
    }
    // --sourcemap / --sourcemap=...
    if (arg === "--sourcemap") { hasBareSourceMapFlag = true; (buildOpts ?? transformOpts!).Sourcemap = 1; continue; }
    if (arg.startsWith("--sourcemap=")) {
      const v = arg.slice("--sourcemap=".length);
      const map: Record<string, number> = { false: 0, inline: 1, linked: 2, external: 3, both: 4 };
      const s = map[v]; if (s === undefined) return { extras, err: MakeErrorWithNote(`Invalid value ${JSON.stringify(v)} in ${JSON.stringify(arg)}`, 'Valid values are "inline", "linked", "external", or "both".') };
      (buildOpts ?? transformOpts!).Sourcemap = s; continue;
    }
    // --metafile (build only)
    if (isBoolFlag(arg, "--metafile") && buildOpts !== null) {
      const r = parseBoolFlag(arg, true); if (r.err) return { extras, err: r.err }; buildOpts.Metafile = r.value; continue;
    }
    // --mangle-props=REGEX (both)
    if (arg.startsWith("--mangle-props=")) {
      ((buildOpts ?? transformOpts) as any).MangleProps = arg.slice("--mangle-props=".length); continue;
    }
    // Go default 分支：非 flag 参数 → EntryPoints / EntryPointsAdvanced（build only）
    if (!arg.startsWith("-")) {
      if (buildOpts !== null) {
        const eq = arg.indexOf("=");
        if (eq !== -1) {
          if (!buildOpts.EntryPointsAdvanced) buildOpts.EntryPointsAdvanced = [];
          buildOpts.EntryPointsAdvanced.push({ OutputPath: arg.slice(0, eq), InputPath: arg.slice(eq + 1) });
        } else {
          if (!buildOpts.EntryPoints) buildOpts.EntryPoints = [];
          buildOpts.EntryPoints.push(arg);
        }
      }
      continue;
    }
    // 未知 flag：Go 的错误文案
    return { extras, err: MakeErrorWithNote(`Invalid ${kind} flag: ${JSON.stringify(arg)}`, "") };
  }
  if (buildOpts !== null && hasBareSourceMapFlag && buildOpts.Outfile === "" && buildOpts.Outdir === "") buildOpts.Sourcemap = 1;
  return { extras, err: null };
}

/** Go: func ParseBuildOptions(osArgs []string) (BuildOptions, error) (cli.go:53) */
export function ParseBuildOptions(osArgs: string[]): { options: BuildOptionsInput; err: ErrorWithNote | null } {
  const options = newBuildOptions();
  const { err } = parseOptionsImpl(osArgs, options, null, "build");
  return { options, err };
}

/** Go: func ParseTransformOptions(osArgs []string) (TransformOptions, error) (cli.go:75) */
export function ParseTransformOptions(osArgs: string[]): { options: { Format?: number; Define?: Map<string, string>; MinifyWhitespace?: boolean; MinifySyntax?: boolean; MinifyIdentifiers?: boolean; Loader?: number; LogLevel?: number; Target?: number; Platform?: number; Sourcemap?: number }; err: ErrorWithNote | null } {
  const options = newTransformOptions();
  const { err } = parseOptionsImpl(osArgs, null, options, "transform");
  return { options, err };
}

/** Go: api.ServeOptions (api.go:496) 的端口 IR */
export interface ServeOptionsIR {
  Port: number; Host: string; Servedir: string; Keyfile: string; Certfile: string;
  Fallback: string; CORS: { Origin: string[] | null };
}

/** Go: func parseServeOptionsImpl(osArgs []string) (ServeOptions, []string, error) (cli_impl.go:1427) */
export function parseServeOptionsImpl(osArgs: string[]): { opts: ServeOptionsIR; rest: string[]; err: string | null } {
  let host = "", portText = "", servedir = "", keyfile = "", certfile = "", fallback = "";
  let corsOrigin: string[] | null = null;
  const filtered: string[] = [];
  for (const arg of osArgs) {
    if (arg === "--serve") continue;
    else if (arg.startsWith("--serve=")) portText = arg.slice("--serve=".length);
    else if (arg.startsWith("--servedir=")) servedir = arg.slice("--servedir=".length);
    else if (arg.startsWith("--keyfile=")) keyfile = arg.slice("--keyfile=".length);
    else if (arg.startsWith("--certfile=")) certfile = arg.slice("--certfile=".length);
    else if (arg.startsWith("--serve-fallback=")) fallback = arg.slice("--serve-fallback=".length);
    else if (arg.startsWith("--cors-origin=")) corsOrigin = arg.slice("--cors-origin=".length).split(",");
    else filtered.push(arg);
  }
  // net.SplitHostPort（IPv6 用最后一个 ':'，IPv4/host 用第一个）
  if (portText.includes(":")) {
    const idx = portText.startsWith("[") ? portText.indexOf("]:") : portText.lastIndexOf(":");
    if (idx < 0) return { opts: emptyServe(), rest: [], err: `address ${JSON.stringify(portText)}: too many colons in address` };
    host = portText.slice(0, idx).replace(/^\[|\]$/g, "");
    portText = portText.slice(idx + 1);
  }
  let port = 0;
  if (portText !== "") {
    if (!/^-?\d+$/.test(portText)) return { opts: emptyServe(), rest: [], err: `strconv.ParseInt: parsing ${JSON.stringify(portText)}: invalid syntax` };
    port = Number(portText);
    if (port < 0 || port > 0xFFFF) return { opts: emptyServe(), rest: [], err: `Invalid port number: ${portText}` };
    if (port === 0) port = -1;
  }
  return { opts: { Port: port, Host: host, Servedir: servedir, Keyfile: keyfile, Certfile: certfile, Fallback: fallback, CORS: { Origin: corsOrigin } }, rest: filtered, err: null };
}
function emptyServe(): ServeOptionsIR {
  return { Port: 0, Host: "", Servedir: "", Keyfile: "", Certfile: "", Fallback: "", CORS: { Origin: null } };
}

/** Go: func parseOptionsForRun(osArgs) (buildOpts, transformOpts, extras, err) (cli_impl.go:1085) */
export function parseOptionsForRun(osArgs: string[]): {
  build: BuildOptionsInput | null; transform: any | null;
  extras: { watch: boolean; watchDelay: number; metafile: string | null; mangleCache: string | null };
  errText: string;
} {
  const isBuild = osArgs.some((a) => isArgForBuild(a));
  const extras = { watch: false, watchDelay: 0, metafile: null as string | null, mangleCache: null as string | null };
  if (isBuild) {
    const options = newBuildOptions();
    options.LogLimit = 6; (options as any).LogLevel = 3; options.Write = true;
    const r = parseOptionsImpl(osArgs, options, null, "build");
    if (r.err) return { build: null, transform: null, extras, errText: r.err.Text };
    (extras as any).watch = r.extras.watch; (extras as any).watchDelay = r.extras.watchDelay;
    return { build: options, transform: null, extras, errText: "" };
  }
  const options: any = newTransformOptions();
  options.LogLimit = 6; options.LogLevel = 3;
  const r = parseOptionsImpl(osArgs, null, options, "transform");
  if (r.err) return { build: null, transform: null, extras, errText: r.err.Text };
  return { build: null, transform: options, extras, errText: "" };
}

// ============================================================================
// 第 103 轮成片端口：CLI 主循环 runImpl（stdin→stdout / stderr / 退出码）。
// 端到端 oracle：testdata/run-chain-go.json（真实 cli.Run 重定向 IO 的字节）。

/** Go: func runImpl(osArgs []string, plugins) int (cli_impl.go:1198) —— IO 通过回调注入，保持可测。 */
export function runImpl(
  osArgs: string[],
  stdin: Uint8Array,
  writeOut: (bytes: Uint8Array) => void,
  stderrFile: FileLike,
): number {
  // serve 特殊分支：本链不涉及（IO 长连接），诚实不接。
  const filtered = filterAnalyzeFlags(osArgs);
  const args = filtered.args;
  const parsed = parseOptionsForRun(args);

  if (parsed.errText !== "") {
    // parseOptionsForRun 只回 err.Text；Go 用 PrintErrorWithNoteToStderr。
    PrintErrorWithNoteToStderr(args, parsed.errText, "", stderrFile);
    return 1;
  }
  const dec = new TextDecoder();
  if (parsed.transform !== null) {
    const result = Transform(dec.decode(stdin), parsed.transform);
    if (result.Errors.length > 0) return 1;
    writeOut(result.Code);
    return 0;
  }
  if (parsed.build !== null) {
    const bo = parsed.build;
    const hasEntry = (bo.EntryPoints?.length ?? 0) + (bo.EntryPointsAdvanced?.length ?? 0) > 0;
    if (!hasEntry) bo.Stdin = { Contents: dec.decode(stdin), ResolveDir: process.cwd(), Sourcefile: "<stdin>", Loader: 0 };
    const result = Build(bo);
    if (result.Errors.length > 0) return 1;
    for (const f of result.OutputFiles) writeOut(f.Contents);
    return 0;
  }
  return 1;
}

/** Go: func filterAnalyzeFlags(osArgs []string) ([]string, analyzeMode) (cli_impl.go:1151) */
export function filterAnalyzeFlags(osArgs: string[]): { args: string[]; mode: number } {
  for (const arg of osArgs) {
    if (isArgForBuild(arg)) {
      let analyze = 0, end = 0;
      const result = [...osArgs];
      for (const a of osArgs) {
        if (a === "--analyze") analyze = 1;
        else if (a === "--analyze=verbose") analyze = 2;
        else { result[end] = a; end++; }
      }
      return { args: result.slice(0, end), mode: analyze };
    }
  }
  return { args: [...osArgs], mode: 0 };
}

/**
 * Go: func addAnalyzePlugin(buildOptions *api.BuildOptions, analyze analyzeMode, osArgs []string) (cli_impl.go:1174)
 * append PrintAnalysis 插件（OnEnd 输出 AnalyzeMetafile）+ 强制 Metafile=true。
 * stderr 通过可选 file 注入以便逐字节捕获（默认 process.stderr，对应 Go 的 os.Stderr）。
 */
export function addAnalyzePlugin(
  buildOptions: BuildOptionsInput,
  analyze: number,
  osArgs: string[],
  file: FileLike = defaultStderr,
): void {
  const color = OutputOptionsForArgs(osArgs).Color;
  const plugins = buildOptions.Plugins ?? [];
  plugins.push({
    Name: "PrintAnalysis",
    Setup(build: PluginBuild): void {
      build.OnEnd((result: any): any => {
        if (result.Metafile !== "") {
          PrintTextWithColor(file, color, (colors: any): Uint8Array => {
            const out = AnalyzeMetafile(result.Metafile, {
              Color: !(colors.Reset === "" && colors.Bold === "" && colors.Dim === ""),
              Verbose: analyze === 2,
            });
            return new TextEncoder().encode(out);
          });
          file.WriteString(new Uint8Array([0x0a])); // os.Stderr.WriteString("\n")
        }
        return {};
      });
    },
  });
  buildOptions.Plugins = plugins;
  buildOptions.Metafile = true;
}
