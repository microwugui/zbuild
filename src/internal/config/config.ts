// 1:1 移植自 esbuild internal/config（v0.28.2，commit f6058f83）
// 第 44 轮叶子优先规划：config 底座的纯判定函数（config.go / globals.go）。
// 真值表由 Go 包内探针固化在 testdata/config-leaf-go.json。

/** Go: type LegalComments uint8 (config.go:171) */
export type LegalComments = number;
export const LegalComments = {
  LegalCommentsInline: 0,
  LegalCommentsNone: 1,
  LegalCommentsEndOfFile: 2,
  LegalCommentsLinkedWithComment: 3,
  LegalCommentsExternalWithoutComment: 4,
} as const;

/** Go: func (lc LegalComments) HasExternalFile() bool (config.go:180) */
export function HasExternalFile(lc: LegalComments): boolean {
  return lc === LegalComments.LegalCommentsLinkedWithComment ||
    lc === LegalComments.LegalCommentsExternalWithoutComment;
}

/** Go: type Format uint8 (config.go:288) */
export type Format = number;
export const Format = {
  FormatPreserve: 0,
  FormatIIFE: 1,
  FormatCommonJS: 2,
  FormatESModule: 3,
} as const;

/** Go: func (f Format) String() string (config.go:326) */
export function String(f: Format): string {
  switch (f) {
    case Format.FormatIIFE: return "iife";
    case Format.FormatCommonJS: return "cjs";
    case Format.FormatESModule: return "esm";
  }
  return "";
}

/** Go: func (f Format) KeepESMImportExportSyntax() bool (config.go:322) */
export function KeepESMImportExportSyntax(f: Format): boolean {
  return f === Format.FormatPreserve || f === Format.FormatESModule;
}

/** Go: type Mode uint8 (config.go:373) */
export type Mode = number;
export const Mode = {
  ModePassThrough: 0,
  ModeConvertFormat: 1,
  ModeBundle: 2,
} as const;

/** Go: func ShouldCallRuntimeRequire(mode Mode, outputFormat Format) bool (config.go:696) */
export function ShouldCallRuntimeRequire(mode: Mode, outputFormat: Format): boolean {
  return mode === Mode.ModeBundle && outputFormat !== Format.FormatCommonJS;
}

/** Go: type Loader uint8 (config.go:187) */
export type Loader = number;
export const Loader = {
  LoaderNone: 0,
  LoaderBase64: 1,
  LoaderBinary: 2,
  LoaderCopy: 3,
  LoaderCSS: 4,
  LoaderDataURL: 5,
  LoaderDefault: 6,
  LoaderEmpty: 7,
  LoaderFile: 8,
  LoaderGlobalCSS: 9,
  LoaderJS: 10,
  LoaderJSON: 11,
  LoaderWithTypeJSON: 12,
  LoaderJSX: 13,
  LoaderLocalCSS: 14,
  LoaderText: 15,
  LoaderTS: 16,
  LoaderTSNoAmbiguousLessThan: 17,
  LoaderTSX: 18,
} as const;

/** Go: func (loader Loader) IsTypeScript() bool (config.go:230) */
export function IsTypeScript(loader: Loader): boolean {
  return loader === Loader.LoaderTS || loader === Loader.LoaderTSNoAmbiguousLessThan || loader === Loader.LoaderTSX;
}

/** Go: func (loader Loader) IsCSS() bool (config.go:238) */
export function IsCSS(loader: Loader): boolean {
  return loader === Loader.LoaderCSS || loader === Loader.LoaderGlobalCSS || loader === Loader.LoaderLocalCSS;
}

/** Go: func (loader Loader) CanHaveSourceMap() bool (config.go:247) */
export function CanHaveSourceMap(loader: Loader): boolean {
  switch (loader) {
    case Loader.LoaderJS: case Loader.LoaderJSX:
    case Loader.LoaderTS: case Loader.LoaderTSNoAmbiguousLessThan: case Loader.LoaderTSX:
    case Loader.LoaderCSS: case Loader.LoaderGlobalCSS: case Loader.LoaderLocalCSS:
    case Loader.LoaderJSON: case Loader.LoaderWithTypeJSON: case Loader.LoaderText:
      return true;
  }
  return false;
}

/** Go: MaybeBool / TSImportsNotUsedAsValues（config.go:382/519） */
// Go: MaybeBool (config.go:382)。第 159 批修正为 Go 顺序 Unspecified=0/True=1/False=2；
// 此前 False/True 颠倒，因 UnusedImportFlags 等只用符号比较未暴露，但 ParseTSConfigJSON 输出数值须与 Go 一致。
export const MaybeBool = { Unspecified: 0, True: 1, False: 2 } as const;
// Go: TSImportsNotUsedAsValues (config.go:519)。第 159 批补齐 Remove 并修正数值：
// 此前缺 Remove 导致 Preserve=1/Error=2，与 Go 的 Remove=1/Preserve=2/Error=3 偏移。
export const TSImportsNotUsedAsValues = { TSImportsNotUsedAsValues_None: 0, TSImportsNotUsedAsValues_Remove: 1, TSImportsNotUsedAsValues_Preserve: 2, TSImportsNotUsedAsValues_Error: 3 } as const;

/** Go: TSTarget (config.go:568) —— tsconfig target 解析输出 */
export const TSTarget = { TSTargetUnspecified: 0, TSTargetBelowES2022: 1, TSTargetAtOrAboveES2022: 2 } as const;

/** Go: TSUnusedImportFlags (config.go:564) */
export const TSUnusedImportFlags = { TSUnusedImport_KeepStmt: 1, TSUnusedImport_KeepValues: 2 } as const;

/** Go: type TSConfig struct (config.go:108) —— 第 159 批补齐 ParseTSConfigJSON 用到的全字段 */
export class TSConfig {
  ExperimentalDecorators: number = MaybeBool.Unspecified;
  ImportsNotUsedAsValues: number = TSImportsNotUsedAsValues.TSImportsNotUsedAsValues_None;
  PreserveValueImports: number = MaybeBool.Unspecified;
  Target: number = TSTarget.TSTargetUnspecified;
  UseDefineForClassFields: number = MaybeBool.Unspecified;
  VerbatimModuleSyntax: number = MaybeBool.Unspecified;

  /** Go: func (derived *TSConfig) ApplyExtendedConfig(base TSConfig) (config.go:117) */
  ApplyExtendedConfig(base: TSConfig): void {
    if (base.ExperimentalDecorators !== MaybeBool.Unspecified) this.ExperimentalDecorators = base.ExperimentalDecorators;
    if (base.ImportsNotUsedAsValues !== TSImportsNotUsedAsValues.TSImportsNotUsedAsValues_None) this.ImportsNotUsedAsValues = base.ImportsNotUsedAsValues;
    if (base.PreserveValueImports !== MaybeBool.Unspecified) this.PreserveValueImports = base.PreserveValueImports;
    if (base.Target !== TSTarget.TSTargetUnspecified) this.Target = base.Target;
    if (base.UseDefineForClassFields !== MaybeBool.Unspecified) this.UseDefineForClassFields = base.UseDefineForClassFields;
    if (base.VerbatimModuleSyntax !== MaybeBool.Unspecified) this.VerbatimModuleSyntax = base.VerbatimModuleSyntax;
  }

  /** Go: func (cfg *TSConfig) UnusedImportFlags() TSUnusedImportFlags (config.go:139) */
  UnusedImportFlags(): number {
    if (this.VerbatimModuleSyntax === MaybeBool.True) {
      return TSUnusedImportFlags.TSUnusedImport_KeepStmt | TSUnusedImportFlags.TSUnusedImport_KeepValues;
    }
    let flags = 0;
    if (this.PreserveValueImports === MaybeBool.True) flags |= TSUnusedImportFlags.TSUnusedImport_KeepValues;
    if (this.ImportsNotUsedAsValues === TSImportsNotUsedAsValues.TSImportsNotUsedAsValues_Preserve ||
        this.ImportsNotUsedAsValues === TSImportsNotUsedAsValues.TSImportsNotUsedAsValues_Error) {
      flags |= TSUnusedImportFlags.TSUnusedImport_KeepStmt;
    }
    return flags;
  }
}

/** Go: DefineFlags (globals.go:932) */
export const DefineFlags = { CanBeRemovedIfUnused: 1, CallCanBeUnwrappedIfUnused: 2 } as const;

/** Go: DefineData (globals.go) —— 只落 mergeDefineData 用到的字段 */
export class DefineData {
  Flags: number = 0;
  KeyParts: string[] = [];
}

/** Go: func mergeDefineData (globals.go:960) —— 实现在 globals.ts，与 Go 文件口径一致 */
export { mergeDefineData } from "./globals.ts";

/** Go: type WildcardPattern (config.go) —— 底座占位，字段略（HasMatchers 只取长度） */
export class WildcardPattern {
  Prefix: string = "";
  Suffix: string = "";
}

/** Go: type ExternalMatchers struct (config.go:350) */
export class ExternalMatchers {
  Exact: Map<string, boolean> = new Map();
  Patterns: WildcardPattern[] = [];

  /** Go: func (matchers ExternalMatchers) HasMatchers() bool (config.go:355) */
  HasMatchers(): boolean {
    return this.Exact.size > 0 || this.Patterns.length > 0;
  }
}

/** Go: type ExternalSettings struct (config.go:359) */
export class ExternalSettings {
  PreResolve: ExternalMatchers = new ExternalMatchers();
  PostResolve: ExternalMatchers = new ExternalMatchers();
}

/** Go: type CancelFlag struct (config.go) —— 原子取消标志（TS 单线程用普通布尔建模） */
export class CancelFlag {
  private flag: boolean = false;

  /** Go: func (flag *CancelFlag) Cancel() (config.go:391) */
  Cancel(): void {
    this.flag = true;
  }

  /** Go: func (flag *CancelFlag) DidCancel() bool (config.go:396) */
  DidCancel(): boolean {
    return this.flag;
  }
}

/** Go: func PluginAppliesToPath(path logger.Path, filter *regexp.Regexp, namespace string) bool (config.go:769) */
export function PluginAppliesToPath(pathText: string, pathNamespace: string, filter: RegExp, namespace: string): boolean {
  return (namespace === "" || pathNamespace === namespace) && filter.test(pathText);
}

/** Go: type PathPlaceholder uint8 (config.go:586) */
export type PathPlaceholder = number;
export const PathPlaceholder = {
  NoPlaceholder: 0,
  DirPlaceholder: 1,
  NamePlaceholder: 2,
  HashPlaceholder: 3,
  ExtPlaceholder: 4,
} as const;

/** Go: type PathTemplate struct (config.go:608) */
export class PathTemplate {
  Placeholder: PathPlaceholder = PathPlaceholder.NoPlaceholder;
  Data: string = "";
}

/** Go: PathPlaceholders (config.go:613) */
export class PathPlaceholders {
  Dir: string | null = null;
  Name: string | null = null;
  Hash: string | null = null;
  Ext: string | null = null;

  Get(placeholder: PathPlaceholder): string | null {
    switch (placeholder) {
      case PathPlaceholder.DirPlaceholder: return this.Dir;
      case PathPlaceholder.NamePlaceholder: return this.Name;
      case PathPlaceholder.HashPlaceholder: return this.Hash;
      case PathPlaceholder.ExtPlaceholder: return this.Ext;
    }
    return null;
  }
}

/** Go: func SubstituteTemplate(template []PathTemplate, placeholders PathPlaceholders) []PathTemplate (config.go:665) */
export function SubstituteTemplate(template: PathTemplate[], placeholders: PathPlaceholders): PathTemplate[] {
  let shouldSubstitute = false;
  for (let i = 0; i < template.length; i++) {
    if (placeholders.Get(template[i].Placeholder) !== null ||
        (template[i].Placeholder === PathPlaceholder.NoPlaceholder && i + 1 < template.length)) {
      shouldSubstitute = true; break;
    }
  }
  if (!shouldSubstitute) return template;
  const result: PathTemplate[] = [];
  for (const t of template) {
    const part = new PathTemplate(); part.Data = t.Data; part.Placeholder = t.Placeholder;
    const sub = placeholders.Get(part.Placeholder);
    if (sub !== null) { part.Data += sub; part.Placeholder = PathPlaceholder.NoPlaceholder; }
    const last = result.length - 1;
    if (last >= 0 && result[last].Placeholder === PathPlaceholder.NoPlaceholder) {
      result[last].Data += part.Data; result[last].Placeholder = part.Placeholder;
    } else result.push(part);
  }
  return result;
}

/** Go: func PrettyPrintTargetEnvironment(originalTargetEnv string, mask bigint) string (config.go:852) */
export function PrettyPrintTargetEnvironment(originalTargetEnv: string, mask: number): string {
  let where = "the configured target environment";
  let overrides = "";
  if (mask !== 0) {
    let count = 0, m = mask;
    while (m !== 0) { if ((m & 1) !== 0) count++; m = Math.floor(m / 2); }
    overrides = ` + ${count} override${count === 1 ? "" : "s"}`;
  }
  if (originalTargetEnv !== "") where = `${where} (${originalTargetEnv}${overrides})`;
  return where;
}

/** Go: TSJSX (config.go:31) */
export const TSJSX = { TSJSXNone: 0, TSJSXPreserve: 1, TSJSXReactNative: 2, TSJSXReact: 3, TSJSXReactJSX: 4, TSJSXReactJSXDev: 5 } as const;

/** Go: TSConfigJSX (config.go) —— ApplyExtendedConfig 用到的字段 */
export class TSConfigJSX {
  JSXFactory: string[] | null = null;
  JSXFragmentFactory: string[] | null = null;
  JSXImportSource: string | null = null;
  JSX: number = TSJSX.TSJSXNone;

  /** Go: func (derived *TSConfigJSX) ApplyExtendedConfig(base TSConfigJSX) (config.go:54) */
  ApplyExtendedConfig(base: TSConfigJSX): void {
    if (base.JSXFactory !== null) this.JSXFactory = base.JSXFactory;
    if (base.JSXFragmentFactory !== null) this.JSXFragmentFactory = base.JSXFragmentFactory;
    if (base.JSXImportSource !== null) this.JSXImportSource = base.JSXImportSource;
    if (base.JSX !== TSJSX.TSJSXNone) this.JSX = base.JSX;
  }

  /**
   * Go: func (tsConfig *TSConfigJSX) ApplyTo(jsxOptions *JSXOptions) (config.go:69)
   * 第 175 批：resolver 顶层入口依赖（NewResolver 把 tsconfig 的 JSX 设置应用到 options）。
   * DEVIATION：Go 的 JSXOptions.Factory/Fragment 是 config.DefineExpr，TS 的 JSXOptions
   * （js_parser.ts）把 Parts 直接摊成 string[]；这里用结构化最小接口避免 config→js_parser 循环依赖。
   */
  ApplyTo(jsxOptions: {
    AutomaticRuntime: boolean; Development: boolean;
    Factory: string[]; Fragment: string[]; ImportSource: string;
  }): void {
    switch (this.JSX) {
      case TSJSX.TSJSXPreserve:
      case TSJSX.TSJSXReactNative:
        // 故意不设 Preserve=true（见 Go 注释：Vercel 工具自动写 jsx=preserve 会让用户困惑）
        break;
      case TSJSX.TSJSXReact:
        jsxOptions.AutomaticRuntime = false;
        jsxOptions.Development = false;
        break;
      case TSJSX.TSJSXReactJSX:
        jsxOptions.AutomaticRuntime = true;
        // 故意不设 Development=false（保留 --jsx-dev 切换能力）
        break;
      case TSJSX.TSJSXReactJSXDev:
        jsxOptions.AutomaticRuntime = true;
        jsxOptions.Development = true;
        break;
    }
    if (this.JSXFactory !== null && this.JSXFactory.length > 0) jsxOptions.Factory = this.JSXFactory;
    if (this.JSXFragmentFactory !== null && this.JSXFragmentFactory.length > 0) jsxOptions.Fragment = this.JSXFragmentFactory;
    if (this.JSXImportSource !== null) jsxOptions.ImportSource = this.JSXImportSource;
  }
}

/** Go: func LoaderFromFileExtension(extensionToLoader map[string]Loader, base string) Loader (config.go:259) */
export function LoaderFromFileExtension(extensionToLoader: Map<string, number>, base: string): number {
  let i = base.indexOf(".");
  if (i !== -1) {
    for (;;) {
      const loader = extensionToLoader.get(base.slice(i));
      if (loader !== undefined) return loader;
      base = base.slice(i + 1);
      i = base.indexOf(".");
      if (i === -1) break;
    }
  } else {
    const loader = extensionToLoader.get("");
    if (loader !== undefined) return loader;
  }
  return 0; // LoaderNone
}

/** Go: func TemplateToString(template []PathTemplate) string (config.go:634) */
export function TemplateToString(template: PathTemplate[]): string {
  if (template.length === 1 && template[0].Placeholder === PathPlaceholder.NoPlaceholder) {
    return template[0].Data;
  }
  let out = "";
  const suffix: Record<number, string> = { 1: "[dir]", 2: "[name]", 3: "[hash]", 4: "[ext]" };
  for (const part of template) {
    out += part.Data;
    if (part.Placeholder !== 0) out += suffix[part.Placeholder] ?? "";
  }
  return out;
}

/** Go: func (mf MetafileFormat) MaybeRemoveWhitespace(fmt string) string (config.go:883) */
export function MaybeRemoveWhitespace(fmt: string, minified: boolean): string {
  if (!minified) return fmt;
  let out = "";
  for (const c of fmt) if (c !== " " && c !== "\n") out += c;
  return out;
}

/** Go: func HasPlaceholder(template []PathTemplate, placeholder PathPlaceholder) bool (config.go:656) */
export function HasPlaceholder(template: PathTemplate[], placeholder: PathPlaceholder): boolean {
  for (const part of template) {
    if (part.Placeholder === placeholder) return true;
  }
  return false;
}

// Go: var filterCache map[string]*regexp.Regexp —— 端口缓存（单线程无 mutex）
const filterCache = new Map<string, RegExp | null>();
/** 把 Go 内联标志 (?i) 转成 JS 的 i 标志（esbuild filter 只用内联 i/m/s） */
function goRegexToJS(filter: string): RegExp {
  let flags = "";
  let body = filter;
  const m = body.match(/^\(\?([imsU]+)\)/);
  if (m) { flags = m[1].replace("U", "u"); body = body.slice(m[0].length); }
  return new RegExp(body, flags);
}
/** Go: func compileFilter(filter string) *regexp.Regexp (config.go:721) */
export function compileFilter(filter: string): RegExp | null {
  if (filter === "") return null;
  if (filterCache.has(filter)) return filterCache.get(filter)!;
  let result: RegExp | null;
  try { result = goRegexToJS(filter); } catch { result = null; }
  filterCache.set(filter, result);
  return result;
}
/** Go: func CompileFilterForPlugin(pluginName, kind, filter string) (*regexp.Regexp, error) (config.go:756) */
export function CompileFilterForPlugin(pluginName: string, kind: string, filter: string): { regex: RegExp | null; error: string | null } {
  if (filter === "") return { regex: null, error: `[${pluginName}] ${JSON.stringify(kind)} is missing a filter` };
  const result = compileFilter(filter);
  if (result === null) return { regex: null, error: `[${pluginName}] ${JSON.stringify(kind)} filter is not a valid Go regular expression: ${JSON.stringify(filter)}` };
  return { regex: result, error: null };
}
