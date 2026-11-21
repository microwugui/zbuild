// 1:1 移植自 esbuild pkg/api/api.go（v0.28.2）。第 121 批 Go 探针 2 例；第 86 轮补公开薄包装。
import type { PublicMessage, TransformOptions, TransformResult, BuildOptionsInput, BuildResult } from "./api_impl.ts";
import { formatMsgsImpl, analyzeMetafileImpl, transformImpl, contextImpl } from "./api_impl.ts";

// 第 99 轮成片端口：api.Build 公开入口 → contextImpl → Rebuild → 已逐字节验证的 bundle 驱动。
/** Go: func Build(options BuildOptions) BuildResult (api.go:399) */
export function Build(options: BuildOptionsInput = {}): BuildResult {
  const { ctx, errors } = contextImpl(options);
  if (ctx === null) return { Errors: errors, Warnings: [], OutputFiles: [], Metafile: "", MangleCache: null };
  const result = ctx.Rebuild();
  ctx.Dispose();
  return result;
}

/** Go: func Context(buildOptions BuildOptions) (BuildContext, *ContextError) (api.go:557) */
export function Context(buildOptions: BuildOptionsInput = {}): { ctx: any; err: { Errors: PublicMessage[] } | null } {
  const { ctx, errors } = contextImpl(buildOptions);
  if (ctx === null) return { ctx: null, err: { Errors: errors as any } };
  return { ctx, err: null };
}

export type { BuildResult } from "./api_impl.ts";

// 第 97 轮成片端口：api.Transform 公开入口 → transformImpl → 已逐字节验证的 transform 管线。
export type { TransformOptions, TransformResult } from "./api_impl.ts";

/** Go: func Transform(input string, options TransformOptions) TransformResult (api.go:488) */
export function Transform(input: string, options: TransformOptions = {}): TransformResult {
  return transformImpl(input, options);
}

/** Go: type FormatMessagesOptions struct (api.go:727) */
export interface FormatMessagesOptions { TerminalWidth?: number; Kind?: number; Color?: boolean; LogStyle?: number }
/** Go: type AnalyzeMetafileOptions struct (api.go:740) */
export interface AnalyzeMetafileOptions { Color?: boolean; Verbose?: boolean }

/** Go: func FormatMessages(msgs []Message, opts FormatMessagesOptions) []string (api.go:734) */
export function FormatMessages(msgs: PublicMessage[], opts: FormatMessagesOptions): string[] {
  return formatMsgsImpl(msgs, {
    Kind: opts.Kind ?? 0, Color: opts.Color ?? false,
    TerminalWidth: opts.TerminalWidth ?? 0, LogStyle: opts.LogStyle ?? 0,
  });
}

/** Go: func AnalyzeMetafile(metafile string, opts AnalyzeMetafileOptions) string (api.go:747) */
export function AnalyzeMetafile(metafile: string, opts: AnalyzeMetafileOptions): string {
  return analyzeMetafileImpl(metafile, { Color: opts.Color ?? false, Verbose: opts.Verbose ?? false });
}

/** Go: type ContextError struct (api.go:547) */
export class ContextError {
  Errors: PublicMessage[] = [];
  constructor(errors: PublicMessage[] = []) { this.Errors = errors; }
  /** Go: func (err *ContextError) Error() string (api.go:549) */
  Error(): string {
    if (this.Errors.length > 0) return this.Errors[0].Text;
    return "Context creation failed";
  }
}
