// 1:1 移植自 esbuild pkg/api/api_impl.go（v0.28.2，commit f6058f83）
// 第 44 轮叶子优先规划：API 枚举验证 + 字节计数格式化。真值表由 Go 探针固化在
// testdata/api-validate-go.json。
import { readFileSync as readFileCompat } from "node:fs";
import { Sum64 as XXHashSum64 } from "../../internal/xxhash/xxhash_other.ts";
import * as js_ast from "../../internal/js_ast/js_ast.ts";
import { UTF16EqualsString, StringToUTF16 } from "../../internal/helpers/utf.ts";
import { ParseGlobalName } from "../../internal/js_parser/global_name_parser.ts";
import { Source, Path, Log, MsgLocation, Msg, MsgData, MsgKind, SortableMsgs, AddError, Range } from "../../internal/logger/logger.ts";
import { StringToMsgIDs, MsgIDToString, StringToMaximumMsgID } from "../../internal/logger/msg_ids.ts";
import { DefaultExtensionToLoaderMap } from "../../internal/bundler/bundler.ts";
import { ParseDefineExpr } from "../../internal/js_parser/js_parser.ts";
import { StringToJSFeature, StringToCSSFeature } from "../../internal/compat/tables_generated.ts";
import { PathTemplate, PathPlaceholder, PrettyPrintTargetEnvironment, ExternalSettings, ExternalMatchers, WildcardPattern, CompileFilterForPlugin } from "../../internal/config/config.ts";
import { IsPackagePath } from "../../internal/resolver/resolver.ts";
import { ProcessDefines, DefineFlags, type FullDefineData, type DefineExprData } from "../../internal/config/globals.ts";
import { Engine, Semver, CompareSemver, EngineString, ApplyOverrides as JSApplyOverrides } from "../../internal/compat/compat.ts";
import { ApplyOverrides as CSSApplyOverrides } from "../../internal/compat/css_table.ts";
import { UnsupportedJSFeatures } from "../../internal/compat/js_table.ts";
import { UnsupportedCSSFeatures, CSSPrefixData } from "../../internal/compat/css_table.ts";
import { convertEngineName } from "./api_js_table.ts";
import { transformEquivalent } from "../../transform_equiv.ts";
import { bundleSingleFile } from "../../bundle1.ts";
import { bundleWithImports } from "../../bundle_multi.ts";
import { Options as PrintOptions, Format } from "../../internal/js_printer/js_printer.ts";
import { Options as ParseOptions, DefineData } from "../../internal/js_parser/js_parser.ts";

/** Go: Target 枚举 (api.go:121) */
export const Target = { DefaultTarget: 0, ESNext: 1, ES5: 2, ES2015: 3, ES2016: 4, ES2017: 5, ES2018: 6, ES2019: 7, ES2020: 8, ES2021: 9, ES2022: 10, ES2023: 11, ES2024: 12, ES2025: 13, ES2026: 14 } as const;
/** Go: api.EngineName 枚举 (api_js_table.go:10) */
export const EngineName = { EngineChrome: 0, EngineDeno: 1, EngineEdge: 2, EngineFirefox: 3, EngineHermes: 4, EngineIE: 5, EngineIOS: 6, EngineNode: 7, EngineOpera: 8, EngineRhino: 9, EngineSafari: 10 } as const;

/** Go: Drop 常量 (api.go:267) */
export const DropConsole = 1;

/** Go: type InjectedDefine struct (config.go:700) */
export interface InjectedDefine { Name: string; SourceContents: string }

/** Go: api.Location struct (api.go:194) */
export interface Location {
  File: string; Namespace: string; Line: number; Column: number; Length: number;
  LineText: string; Suggestion: string;
}

/** Go: func convertLocationToPublic(loc *logger.MsgLocation, pathStyle logger.PathStyle) *Location (api_impl.go:784) */
export function convertLocationToPublic(loc: MsgLocation | null, pathStyle: number): Location | null {
  if (loc === null) return null;
  // Go api.Location field order: File, Namespace, Line, Column, Length, LineText, Suggestion
  return {
    File: loc.File.Select(pathStyle), Namespace: loc.Namespace, Line: loc.Line,
    Column: loc.Column, Length: loc.Length,
    LineText: new TextDecoder().decode(loc.LineText), Suggestion: loc.Suggestion,
  };
}

/** Go: func convertLocationToInternal(loc *Location) *logger.MsgLocation (api_impl.go:823) */
export function convertLocationToInternal(loc: Location | null): MsgLocation | null {
  if (loc === null) return null;
  let namespace = loc.Namespace;
  if (namespace === "") namespace = "file";
  const result = new MsgLocation();
  result.File.Abs = loc.File; result.File.Rel = loc.File;
  result.Namespace = namespace;
  result.Line = loc.Line; result.Column = loc.Column; result.Length = loc.Length;
  result.LineText = new TextEncoder().encode(loc.LineText);
  result.Suggestion = loc.Suggestion;
  return result;
}

/** Go: func validateSupported(log, supported map[string]bool) (js, jsmask bigint, css, cssmask number) (api_impl.go:395) */
export function validateSupported(supported: Map<string, boolean>): { js: bigint; jsMask: bigint; css: number; cssMask: number } {
  let js = 0n, jsMask = 0n, css = 0, cssMask = 0;
  for (const [k, v] of supported) {
    const jf = StringToJSFeature[k];
    if (jf !== undefined) { const bit = BigInt(jf); jsMask |= bit; if (!v) js |= bit; }
    else {
      const cf = StringToCSSFeature[k];
      if (cf !== undefined) { cssMask |= cf; if (!v) css |= cf; }
    }
  }
  return { js, jsMask, css, cssMask };
}

/** Go: func validateAlias(log, fs, alias map[string]string) map[string]string (api_impl.go:483) */
export function validateAlias(alias: Map<string, string>, isAbs: (p: string) => boolean): Map<string, string> {
  const valid = new Map<string, string>();
  for (const [oldName, newName] of alias) {
    if (newName === "") continue;
    if (!oldName.startsWith(".") && !oldName.startsWith("/") && !isAbs(oldName) &&
        cleanPosix(oldName.replaceAll("\\", "/")) === oldName) {
      valid.set(oldName, newName);
    }
  }
  return valid;
}
function cleanPosix(p: string): string {
  // path.Clean for POSIX (no volume), sufficient for alias validation
  const rooted = p.startsWith("/");
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { if (parts.length && parts[parts.length-1] !== "..") parts.pop(); else if (!rooted) parts.push(".."); }
    else parts.push(seg);
  }
  const out = (rooted ? "/" : "") + parts.join("/");
  return out === "" ? "." : out;
}

/** Go: func validateJSXExpr(log, text, name string) config.DefineExpr (api_impl.go:547) */
export function validateJSXExpr(text: string, name: string): { parts: string[]; constant: boolean } {
  if (text !== "") {
    const [expr] = ParseDefineExpr(text);
    if (expr.Parts.length > 0 || (name === "fragment" && expr.Constant !== null)) return { parts: expr.Parts, constant: expr.Constant !== null };
  }
  return { parts: [], constant: false };
}

/** Go: func cloneMangleCache(log, mangleCache map[string]interface{}) map[string]interface{} (api_impl.go:877) */
export function cloneMangleCache(mangleCache: Map<string, string | boolean | number> | null): Map<string, string | boolean | number> | null {
  if (mangleCache === null) return null;
  const clone = new Map<string, string | boolean | number>();
  for (const [k, v] of mangleCache) {
    if (v === "__proto__") {
      // invalid → skip (Go logs an error)
    } else if (typeof v === "string" || v === false) {
      clone.set(k, v);
    }
    // else invalid → skip
  }
  return clone;
}

/** Go: func validateLoaders(log, loaders map[string]Loader) map[string]config.Loader (api_impl.go:536) */
export function validateLoaders(loaders: Map<string, number>): Map<string, number> {
  const result = DefaultExtensionToLoaderMap();
  for (const [ext, loader] of loaders) result.set(ext, validateLoader(loader));
  return result;
}

/** Go: func validateLogOverrides(input map[string]LogLevel) map[logger.MsgID]logger.LogLevel (api_impl.go:725) */
export function validateLogOverrides(input: Map<string, number>): Map<number, number> {
  const output = new Map<number, number>();
  for (const [k, v] of input) StringToMsgIDs(k, validateLogLevel(v), output);
  return output;
}

/** Go: func validateBannerOrFooter(log, name, values) (js, css string) (api_impl.go:761) */
export function validateBannerOrFooter(values: Map<string, string>): { js: string; css: string } {
  let js = "", css = "";
  for (const [key, value] of values) {
    if (key === "js") js = value;
    else if (key === "css") css = value;
  }
  return { js, css };
}

/** Go: func validateOutputExtensions(log, outExtensions) (js, css string) (api_impl.go:744) */
export function validateOutputExtensions(values: Map<string, string>): { js: string; css: string } {
  let js = "", css = "";
  for (const [key, value] of values) {
    if (key === ".js") js = value;
    else if (key === ".css") css = value;
  }
  return { js, css };
}

/** Go: func validatePathTemplate(template string) []config.PathTemplate (api_impl.go:42) */
export function validatePathTemplate(template: string): PathTemplate[] {
  if (template === "") return [];
  template = "./" + template.replaceAll("\\", "/");
  const parts: PathTemplate[] = [];
  let search = 0;
  while (search < template.length) {
    const found = template.indexOf("[", search);
    if (found === -1) break;
    search = found;
    const head = template.slice(0, search);
    const tail = template.slice(search);
    let placeholder: number = PathPlaceholder.NoPlaceholder;
    if (tail.startsWith("[dir]")) { placeholder = PathPlaceholder.DirPlaceholder; search += 5; }
    else if (tail.startsWith("[name]")) { placeholder = PathPlaceholder.NamePlaceholder; search += 6; }
    else if (tail.startsWith("[hash]")) { placeholder = PathPlaceholder.HashPlaceholder; search += 6; }
    else if (tail.startsWith("[ext]")) { placeholder = PathPlaceholder.ExtPlaceholder; search += 5; }
    else { search++; continue; }
    const part = new PathTemplate();
    part.Data = head; part.Placeholder = placeholder;
    parts.push(part);
    template = template.slice(search);
    search = 0;
  }
  if (search < template.length) {
    const part = new PathTemplate();
    part.Data = template; part.Placeholder = PathPlaceholder.NoPlaceholder;
    parts.push(part);
  }
  return parts;
}

export type Platform = number;
export const Platform = { PlatformDefault: 0, PlatformBrowser: 1, PlatformNode: 2, PlatformNeutral: 3 } as const;
export type StderrColor = number;
export const StderrColor = { ColorIfTerminal: 0, ColorNever: 1, ColorAlways: 2 } as const;
export type LogStyle = number;
export const LogStyle = { LogStyleDefault: 0, LogStyleClang: 1, LogStyleVisualStudio: 2 } as const;
export type Charset = number;
export const Charset = { CharsetDefault: 0, CharsetASCII: 1, CharsetUTF8: 2 } as const;
export type Packages = number;
export const Packages = { PackagesDefault: 0, PackagesBundle: 1, PackagesExternal: 2 } as const;

/** Go: config.Platform 目标枚举值（探针实测） */
export const ConfigPlatform = { PlatformBrowser: 0, PlatformNode: 1, PlatformNeutral: 2 } as const;
/** Go: logger.UseColor 目标枚举值 */
export const UseColor = { ColorIfTerminal: 0, ColorNever: 1, ColorAlways: 2 } as const;
/** Go: logger.LogStyle 目标枚举值 */
export const LogStyleKind = { StyleDefault: 0, StyleClang: 1, StyleVisualStudio: 2 } as const;

/** Go: func validatePlatform(value Platform) config.Platform (api_impl.go:108) */
export function validatePlatform(value: Platform): number {
  switch (value) {
    case Platform.PlatformDefault: case Platform.PlatformBrowser: return ConfigPlatform.PlatformBrowser;
    case Platform.PlatformNode: return ConfigPlatform.PlatformNode;
    case Platform.PlatformNeutral: return ConfigPlatform.PlatformNeutral;
    default: throw new Error("Invalid platform");
  }
}

/** Go: func validateColor(value StderrColor) logger.UseColor (api_impl.go:176) */
export function validateColor(value: StderrColor): number {
  switch (value) {
    case StderrColor.ColorIfTerminal: return UseColor.ColorIfTerminal;
    case StderrColor.ColorNever: return UseColor.ColorNever;
    case StderrColor.ColorAlways: return UseColor.ColorAlways;
    default: throw new Error("Invalid color");
  }
}

/** Go: func validateLogStyle(value LogStyle) logger.LogStyle (api_impl.go:208) */
export function validateLogStyle(value: LogStyle): number {
  switch (value) {
    case LogStyle.LogStyleDefault: return LogStyleKind.StyleDefault;
    case LogStyle.LogStyleClang: return LogStyleKind.StyleClang;
    case LogStyle.LogStyleVisualStudio: return LogStyleKind.StyleVisualStudio;
    default: throw new Error("Invalid log style");
  }
}

/** Go: func validateASCIIOnly(value Charset) bool (api_impl.go:221) */
export function validateASCIIOnly(value: Charset): boolean {
  switch (value) {
    case Charset.CharsetDefault: case Charset.CharsetASCII: return true;
    case Charset.CharsetUTF8: return false;
    default: throw new Error("Invalid charset");
  }
}

/** Go: func validateExternalPackages(value Packages) bool (api_impl.go:232) */
export function validateExternalPackages(value: Packages): boolean {
  switch (value) {
    case Packages.PackagesDefault: case Packages.PackagesBundle: return false;
    case Packages.PackagesExternal: return true;
    default: throw new Error("Invalid packages");
  }
}

/** Go: func validateResolveExtensions(log, order []string) []string (api_impl.go:524) */
export function validateResolveExtensions(order: string[] | null, onError: (text: string) => void): string[] {
  if (order === null) return [".tsx", ".ts", ".jsx", ".js", ".css", ".json"];
  for (const ext of order) {
    if (!isValidExtension(ext)) onError(`Invalid file extension: ${JSON.stringify(ext)}`);
  }
  return order;
}

/** Go: func validateGlobalName(log, text, path string) []string (api_impl.go:419) */
export function validateGlobalName(text: string, path: string = "", onError?: () => void): string[] {
  if (text !== "") {
    const source = new Source();
    source.KeyPath = new Path();
    source.KeyPath.Text = path;
    source.Contents = new TextEncoder().encode(text);
    const result = ParseGlobalName(new Log(), source);
    if (result.ok) return result.result;
    if (onError) onError();
  }
  return [];
}

/** Go: func getObjectPropertyNumber(expr js_ast.Expr, key string) *js_ast.ENumber (api_impl.go:2271) */
export function getObjectPropertyNumber(expr: js_ast.Expr, key: string): js_ast.ENumber | null {
  const d = getObjectProperty(expr, key).Data;
  return d instanceof js_ast.ENumber ? d : null;
}
/** Go: func getObjectPropertyString (api_impl.go:2276) */
export function getObjectPropertyString(expr: js_ast.Expr, key: string): js_ast.EString | null {
  const d = getObjectProperty(expr, key).Data;
  return d instanceof js_ast.EString ? d : null;
}
/** Go: func getObjectPropertyObject (api_impl.go:2281) */
export function getObjectPropertyObject(expr: js_ast.Expr, key: string): js_ast.EObject | null {
  const d = getObjectProperty(expr, key).Data;
  return d instanceof js_ast.EObject ? d : null;
}
/** Go: func getObjectPropertyArray (api_impl.go:2286) */
export function getObjectPropertyArray(expr: js_ast.Expr, key: string): js_ast.EArray | null {
  const d = getObjectProperty(expr, key).Data;
  return d instanceof js_ast.EArray ? d : null;
}

/** Go: func mapKeyForDefine(parts []string) string (api_impl.go:558) */
export function mapKeyForDefine(parts: string[]): string {
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    const bytes = new TextEncoder().encode(part);
    const n = new Uint8Array(4);
    new DataView(n.buffer).setUint32(0, bytes.length, true);
    chunks.push(n, bytes);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return new TextDecoder().decode(out);
}

/** Go: func importKindToResolveKind(kind ast.ImportKind) ResolveKind (api_impl.go:1906) */
export function importKindToResolveKind(kind: number): number {
  if (kind >= 0 && kind <= 7) return kind + 1;
  throw new Error("Internal error");
}

/** Go: func resolveKindToImportKind(kind ResolveKind) ast.ImportKind (api_impl.go:1929) */
export function resolveKindToImportKind(kind: number): number {
  if (kind >= 1 && kind <= 8) return kind - 1;
  throw new Error("Internal error");
}

/** Go: func stripDirPrefix(path, prefix, allowedSlashes string) (string, bool) (api_impl.go:2558) */
export function stripDirPrefix(path: string, prefix: string, allowedSlashes: string): { value: string; ok: boolean } {
  if (path.startsWith(prefix)) {
    const pathLen = path.length, prefixLen = prefix.length;
    if (prefixLen === 0) return { value: path, ok: true };
    if (pathLen === prefixLen) return { value: "", ok: true };
    if (allowedSlashes.includes(prefix[prefixLen - 1])) return { value: path.slice(prefixLen), ok: true };
    else if (allowedSlashes.includes(path[prefixLen])) return { value: path.slice(prefixLen + 1), ok: true };
  }
  return { value: "", ok: false };
}

/** Go: func isValidExtension(ext string) bool (api_impl.go:520) */
export function isValidExtension(ext: string): boolean {
  return ext.length >= 2 && ext[0] === "." && ext[ext.length - 1] !== ".";
}

/** Go: AbsPaths / logger.PathStyle (api_impl.go:303) —— AbsPath=1, RelPath=0 */
export const PathStyle = { AbsPath: 1, RelPath: 0 } as const;

/** Go: func extractPathStyle(absPaths AbsPaths, flag AbsPaths) logger.PathStyle (api_impl.go:303) */
export function extractPathStyle(absPaths: number, flag: number): number {
  return (absPaths & flag) !== 0 ? PathStyle.AbsPath : PathStyle.RelPath;
}

/** Go: func getObjectProperty(expr js_ast.Expr, key string) js_ast.Expr (api_impl.go:2260) */
export function getObjectProperty(expr: js_ast.Expr, key: string): js_ast.Expr {
  const obj = expr.Data;
  if (obj instanceof js_ast.EObject) {
    for (const prop of obj.Properties) {
      const keyData = prop.Key.Data;
      if (keyData instanceof js_ast.EString && UTF16EqualsString(keyData.Value, new TextEncoder().encode(key))) {
        return prop.ValueOrNil ?? new js_ast.Expr();
      }
    }
  }
  return new js_ast.Expr();
}

/** Go: func validateFormat(value Format) config.Format (api_impl.go:121) —— 恒等映射 */
export function validateFormat(value: number): number {
  if (value >= 0 && value <= 3) return value;
  throw new Error("Invalid format");
}

/** Go: func validateSourceMap(value SourceMap) config.SourceMap (api_impl.go:136) —— 恒等映射 */
export function validateSourceMap(value: number): number {
  if (value >= 0 && value <= 4) return value;
  throw new Error("Invalid source map");
}

/** Go: func validateLogLevel(value LogLevel) logger.LogLevel (api_impl.go:189) */
export function validateLogLevel(value: number): number {
  switch (value) {
    case 0: return 6; // Silent → LevelSilent
    case 1: case 2: case 3: case 4: case 5: return value; // Verbose..Error
    default: throw new Error("Invalid log level");
  }
}

/** Go: func validateLoader(value Loader) config.Loader (api_impl.go:262) */
export function validateLoader(value: number): number {
  const map: Record<number, number> = { 0:0, 1:1, 2:2, 3:3, 4:4, 5:5, 6:6, 7:7, 8:8, 9:9, 10:10, 11:11, 12:13, 13:14, 14:15, 15:16, 16:18 };
  const out = map[value];
  if (out === undefined) throw new Error("Invalid loader");
  return out;
}

/** Go: func validateLegalComments(value LegalComments, bundle bool) config.LegalComments (api_impl.go:153) */
export function validateLegalComments(value: number, bundle: boolean): number {
  switch (value) {
    case 0: return bundle ? 2 : 0; // Default
    case 1: return 1; // None
    case 2: return 0; // Inline
    case 3: return 2; // EndOfFile
    case 4: return 3; // Linked
    case 5: return 4; // External
    default: throw new Error("Invalid legal comments");
  }
}

/** Go: func validateTreeShaking(value TreeShaking, bundle bool, format Format) bool (api_impl.go:243) */
export function validateTreeShaking(value: number, bundle: boolean, format: number): boolean {
  switch (value) {
    case 0: return bundle || format === 1; // Default; FormatIIFE=1
    case 1: return false;
    case 2: return true;
    default: throw new Error("Invalid tree shaking");
  }
}

/** Go: func prettyPrintByteCount(n int) string (api_impl.go:1201) */
export function prettyPrintByteCount(n: number): string {
  if (n < 1024) return `${n}b `;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}kb`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}mb`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)}gb`;
}


// ============================================================================
// 第 121 批：api 纯助手大批量（Go 探针 27 例，api-batch-go.json）。
// ============================================================================
/** Go: api.Note struct (api.go:216) */
export interface PublicNote { Text: string; Location: Location | null; }
/** Go: api.Message struct (api.go:204) */
export interface PublicMessage {
  ID: string; PluginName: string; Text: string; Location: Location | null;
  Notes: PublicNote[]; Detail: unknown;
}

/** Go: func convertMessagesToPublic(kind logger.MsgKind, msgs []logger.Msg, pathStyle logger.PathStyle) []Message (api_impl.go:799) */
export function convertMessagesToPublic(kind: number, msgs: Msg[], pathStyle: number): PublicMessage[] {
  const out: PublicMessage[] = [];
  for (const msg of msgs) {
    if (msg.Kind !== kind) continue;
    const notes: PublicNote[] = [];
    for (const note of msg.Notes) notes.push({ Text: note.Text, Location: convertLocationToPublic(note.Location, pathStyle) });
    out.push({
      ID: MsgIDToString(msg.ID), PluginName: msg.PluginName, Text: msg.Data.Text,
      Location: convertLocationToPublic(msg.Data.Location, pathStyle), Notes: notes, Detail: msg.Data.UserDetail,
    });
  }
  return out;
}

/** Go: func convertMessagesToInternal(msgs []logger.Msg, kind logger.MsgKind, messages []Message) []logger.Msg (api_impl.go:842) */
export function convertMessagesToInternal(msgs: Msg[], kind: number, messages: PublicMessage[]): Msg[] {
  const out = msgs.slice();
  for (const message of messages) {
    const notes: MsgData[] = [];
    for (const note of message.Notes) {
      const d = new MsgData(); d.Text = note.Text; d.Location = convertLocationToInternal(note.Location);
      notes.push(d);
    }
    const m = new Msg();
    m.ID = StringToMaximumMsgID(message.ID); m.PluginName = message.PluginName; m.Kind = kind;
    m.Data.Text = message.Text; m.Data.Location = convertLocationToInternal(message.Location); m.Data.UserDetail = message.Detail;
    m.Notes = notes;
    out.push(m);
  }
  return out;
}

/** Go: func convertErrorsAndWarningsToInternal(errors []Message, warnings []Message) []logger.Msg (api_impl.go:866) */
export function convertErrorsAndWarningsToInternal(errors: PublicMessage[], warnings: PublicMessage[]): Msg[] {
  if (errors.length + warnings.length === 0) return [];
  const msgs = convertMessagesToInternal([], MsgKind.Error, errors);
  const all = convertMessagesToInternal(msgs, MsgKind.Warning, warnings);
  const sorter = new SortableMsgs(all);
  // Go sort.Stable：按下标比较，JS Array.sort 自 ES2019 起稳定
  const order = all.map((_, i) => i);
  order.sort((i, j) => sorter.Less(i, j) ? -1 : (sorter.Less(j, i) ? 1 : 0));
  return order.map((i) => all[i]);
}

/** Go: func validateRegex(log logger.Log, what string, value string) *regexp.Regexp (api_impl.go:435) */
export function validateRegex(log: Log, what: string, value: string): RegExp | null {
  if (value === "") return null;
  try {
    // DEVIATION：Go regexp 支持前置内联标志组（如 "(?i)"），JS RegExp 不支持；
    // 这里把前置 (?i/m/s) 翻成 JS flags，其它 Go 专属语法仍不等价（未在本批使用）。
    let pattern = value, flags = "";
    const inline = /^\(\?([ims]+)\)/.exec(pattern);
    if (inline) {
      flags = inline[1];
      pattern = pattern.slice(inline[0].length);
    }
    return new RegExp(pattern, flags);
  } catch {
    const m = new Msg(); m.Kind = MsgKind.Error;
    m.Data.Text = `The ${JSON.stringify(what)} setting is not a valid Go regular expression: ${value}`;
    log.AddMsg(m);
    return null;
  }
}

/** Go: func validateKeepNames(log logger.Log, options *config.Options) (api_impl.go:775) */
export function validateKeepNames(log: Log, options: {
  KeepNames: boolean; OriginalTargetEnv: string;
  UnsupportedJSFeatures: number | bigint; UnsupportedJSFeatureOverridesMask: number | bigint;
}): void {
  const FunctionNameConfigurable = 1n << 27n; // compat.FunctionNameConfigurable（Go 探针 134217728）
  if (options.KeepNames && (BigInt(options.UnsupportedJSFeatures) & FunctionNameConfigurable) !== 0n) {
    const where = PrettyPrintTargetEnvironment(options.OriginalTargetEnv, Number(options.UnsupportedJSFeatureOverridesMask));
    const m = new Msg(); m.Kind = MsgKind.Error;
    m.Data.Text = `The "keep names" setting cannot be used with ${where}`;
    const note = new MsgData();
    note.Text = "In this environment, the \"Function.prototype.name\" property is not configurable and assigning to it will throw an error. " +
      "Either use a newer target environment or disable the \"keep names\" setting.";
    m.Notes = [note];
    log.AddMsg(m);
  }
}

/** Go: type metafileEntry / metafileArray (api_impl.go:2244) —— sort.Interface 三方法 */
export class metafileArray {
  entries: { name: string; size: number }[] = [];
  constructor(entries: { name: string; size: number }[] = []) { this.entries = entries; }
  Len(): number { return this.entries.length; }
  Swap(i: number, j: number): void { const t = this.entries[i]; this.entries[i] = this.entries[j]; this.entries[j] = t; }
  Less(i: number, j: number): boolean { return this.LessOn(this.entries[i], this.entries[j]); }
  LessOn(ai: { name: string; size: number }, aj: { name: string; size: number }): boolean {
    return ai.size > aj.size || (ai.size === aj.size && ai.name < aj.name);
  }
}

// ============================================================================
// 第 142 批：analyzeMetafileImpl / formatMsgsImpl / prettyPrintPath（build API 输出链）。
// ============================================================================
// 第 142 批补充导入
import { OutputOptions, TerminalInfo, UseColor as LogUseColor, NewDeferLog, NewStderrLog, DeferLogKind, TerminalColors, PrintSummary, SummaryTable, SummaryTableEntry } from "../../internal/logger/logger.ts";
import { ParseJSON, JSONOptions } from "../../internal/js_parser/json_parser.ts";
import { UTF16ToString } from "../../internal/helpers/utf.ts";
import { watcher } from "./watcher.ts";
const newLogNoVerbose = () => NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null);
const toMsgID = StringToMaximumMsgID;

interface metafileEntry { name: string; entryPoint: string; entries: metafileEntry[]; size: number; }
const u16 = (v: Uint16Array): string => new TextDecoder().decode(UTF16ToString(v));

/** Go: func analyzeMetafileImpl (api_impl.go:2291) */
export function analyzeMetafileImpl(metafile: string, opts: { Color: boolean; Verbose: boolean }): string {
  const log = newLogNoVerbose();
  const source = new Source(); source.Contents = new TextEncoder().encode(metafile);
  const result = ParseJSON(log, source, new JSONOptions());
  if (!result.ok) return "";
  const outputs = getObjectPropertyObject(result.expr, "outputs");
  if (!outputs) return "";
  const entries: metafileEntry[] = [];
  const entryPoints: string[] = [];
  for (const output of outputs.Properties) {
    const keyE = output.Key.Data;
    if (!(keyE instanceof js_ast.EString)) continue;
    const key = u16(keyE.Value);
    if (key.endsWith(".map")) continue;
    let entryPointPath = "";
    const entryPoint = getObjectPropertyString(output.ValueOrNil ?? new js_ast.Expr(), "entryPoint");
    if (entryPoint) { entryPointPath = u16(entryPoint.Value); entryPoints.push(entryPointPath); }
    const bytesN = getObjectPropertyNumber(output.ValueOrNil ?? new js_ast.Expr(), "bytes");
    const inputs = getObjectPropertyObject(output.ValueOrNil ?? new js_ast.Expr(), "inputs");
    if (bytesN && inputs) {
      const children: metafileEntry[] = [];
      for (const input of inputs.Properties) {
        const bin = getObjectPropertyNumber(input.ValueOrNil ?? new js_ast.Expr(), "bytesInOutput");
        if (bin && bin.Value > 0) {
          const nameE = input.Key.Data;
          children.push({ name: nameE instanceof js_ast.EString ? u16(nameE.Value) : "", entryPoint: "", entries: [], size: Math.trunc(bin.Value) });
        }
      }
      children.sort((a, b) => a.size > b.size ? -1 : a.size < b.size ? 1 : (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      entries.push({ name: key, size: Math.trunc(bytesN.Value), entryPoint: entryPointPath, entries: children });
    }
  }
  entries.sort((a, b) => a.size > b.size ? -1 : a.size < b.size ? 1 : (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const importsForPath: Record<string, string[]> = {};
  const inputsObj = getObjectPropertyObject(result.expr, "inputs");
  if (inputsObj) {
    for (const prop of inputsObj.Properties) {
      const arr = getObjectPropertyArray(prop.ValueOrNil ?? new js_ast.Expr(), "imports");
      if (arr) {
        const list: string[] = [];
        for (const item of arr.Items) { const p = getObjectPropertyString(item, "path"); if (p) list.push(u16(p.Value)); }
        const keyE = prop.Key.Data;
        importsForPath[keyE instanceof js_ast.EString ? u16(keyE.Value) : ""] = list;
      }
    }
  }
  const graphFor = (worklist: string[]): Record<string, { parent: string; depth: number }> => {
    if (!opts.Verbose) return {};
    const graph: Record<string, { parent: string; depth: number }> = {};
    for (const ep of worklist) graph[ep] = { parent: "", depth: 0 };
    while (worklist.length > 0) {
      const top = worklist.pop()!;
      const childDepth = (graph[top]?.depth ?? 0) + 1;
      for (const imp of importsForPath[top] ?? []) {
        const imported = graph[imp] ?? { parent: "", depth: 0xFFFFFFFF };
        if (imported.depth > childDepth) { imported.depth = childDepth; imported.parent = top; graph[imp] = imported; worklist.push(imp); }
      }
    }
    return graph;
  };
  const graphAll = graphFor(entryPoints);
  interface tEntry { first: string; second: string; third: string; firstLen: number; secondLen: number; thirdLen: number; isTop: boolean; }
  const table: tEntry[] = [];
  const runeLen = (s: string): number => Array.from(s).length;
  for (const entry of entries) {
    const second = prettyPrintByteCount(entry.size), third = "100.0%";
    table.push({ first: entry.name, firstLen: runeLen(entry.name), second, secondLen: second.length, third, thirdLen: third.length, isTop: true });
    const graph = entry.entryPoint !== "" ? graphFor([entry.entryPoint]) : graphAll;
    for (let j = 0; j < entry.entries.length; j++) {
      const child = entry.entries[j];
      const indent = j + 1 === entry.entries.length ? " └ " : " ├ ";
      const percent = 100.0 * child.size / entry.size;
      const first = indent + child.name, second = prettyPrintByteCount(child.size), third = percent.toFixed(1) + "%";
      table.push({ first, firstLen: runeLen(first), second, secondLen: second.length, third, thirdLen: third.length, isTop: false });
      if (opts.Verbose) {
        let data = graph[child.name] ?? { parent: "", depth: 0 }; let depth = 0;
        while (data.depth !== 0) {
          const ind = j + 1 === entry.entries.length ? "   " : " │ ";
          const first2 = `${ind}${" ".repeat(depth)} └ ${data.parent}`;
          table.push({ first: first2, firstLen: runeLen(first2), second: "", secondLen: 0, third: "", thirdLen: 0, isTop: false });
          data = graph[data.parent] ?? { parent: "", depth: 0 }; depth += 3;
        }
      }
    }
  }
  let m1 = 0, m2 = 0, m3 = 0;
  for (const e of table) { m1 = Math.max(m1, e.firstLen); m2 = Math.max(m2, e.secondLen); m3 = Math.max(m3, e.thirdLen); }
  let sb = "";
  const colors = opts.Color ? TerminalColors : { Bold: "", Dim: "", Reset: "" };
  for (const e of table) {
    const prefix = e.isTop ? "\n" : "";
    const color = e.isTop ? colors.Bold : "";
    if (e.second === "" && e.third === "") { sb += `${prefix}  ${e.first}\n`; continue; }
    const secondTrimmed = e.second.replace(/ +$/, "");
    const lineChar = opts.Verbose ? "─" : " "; const extra = opts.Verbose ? 1 : 0;
    sb += `${prefix}  ${color}${e.first}${colors.Reset} ${colors.Dim}${lineChar.repeat(extra + m1 - e.firstLen + m2 - e.secondLen)}${colors.Reset} ${color}${secondTrimmed}${colors.Reset} ${colors.Dim}${lineChar.repeat(extra + m3 - e.thirdLen + e.second.length - secondTrimmed.length)}${colors.Reset} ${color}${e.third}${colors.Reset}\n`;
  }
  return sb;
}

/** Go: func formatMsgsImpl (api_impl.go:2216) */
export function formatMsgsImpl(msgs: PublicMessage[], opts: { Kind: number; Color: boolean; TerminalWidth: number; LogStyle?: number }): string[] {
  const kind = opts.Kind === 1 ? MsgKind.Warning : MsgKind.Error;
  const logStyle = validateLogStyle((opts.LogStyle ?? LogStyle.LogStyleDefault) as LogStyle);
  const out: string[] = [];
  for (const m of msgs) {
    const msg = new Msg();
    msg.Kind = kind; msg.ID = toMsgID(m.ID); msg.PluginName = m.PluginName;
    msg.Data = new MsgData(); msg.Data.Text = m.Text;
    msg.Notes = (m.Notes ?? []).map((n) => { const d = new MsgData(); d.Text = n.Text; return d; });
    const oo = new OutputOptions(); oo.IncludeSource = true; oo.Color = opts.Color ? LogUseColor.ColorAlways : LogUseColor.ColorNever;
    oo.LogStyle = logStyle;
    const ti = new TerminalInfo(); ti.Width = opts.TerminalWidth;
    out.push(new TextDecoder().decode(msg.String(oo, ti)));
  }
  return out;
}

/** Go: func prettyPrintPath (serve_other.go:740) */
export function prettyPrintPath(fsObj: any, path: string): string {
  const rel = fsObj.Rel(fsObj.Cwd ? fsObj.Cwd() : "", path);
  if (rel && rel.ok !== false) return (typeof rel === "string" ? rel : (rel.value ?? path)).replace(/\\/g, "/");
  return path;
}

// ── 第 105 轮：plugin 注册整族底座（config.Plugin.OnStart/OnResolve/OnLoad 数组）─────────────
// Go: type OnStartResult (api.go:627) / OnResolveResult (api.go:655) / OnLoadResult (api.go:688)
export interface OnStartResult { Errors: PublicMessage[]; Warnings: PublicMessage[] }
export interface OnResolveResult {
  PluginName: string; Errors: PublicMessage[]; Warnings: PublicMessage[];
  Path: string; External: boolean; SideEffects: number; Namespace: string; Suffix: string; PluginData: unknown;
  WatchFiles: string[]; WatchDirs: string[];
}
export interface OnLoadResult {
  PluginName: string; Errors: PublicMessage[]; Warnings: PublicMessage[];
  Contents: string | null; ResolveDir: string; Loader: number; PluginData: unknown;
  WatchFiles: string[]; WatchDirs: string[];
}
export interface OnResolveOptions { Filter: string; Namespace: string }
export interface OnLoadOptions { Filter: string; Namespace: string }
/** Go: config.OnResolveArgs (config.go:796) / config.OnLoadArgs (config.go:830) —— 回调入参（内部形态） */
export interface CfgOnResolveArgs { Path: string; ResolveDir: string; PluginData: unknown; Importer: Path; Kind: number; With: Map<string, Uint8Array> | null }
export interface CfgOnLoadArgs { PluginData: unknown; Path: Path }
/** Go: config.OnResolveResult / config.OnLoadResult / config.OnStartResult —— 回调出参（内部形态） */
export interface CfgOnResolveResult {
  PluginName: string; Msgs: Msg[]; ThrownError: unknown;
  AbsWatchFiles: string[]; AbsWatchDirs: string[];
  Path: Path; External: boolean; IsSideEffectFree: boolean; PluginData: unknown;
}
export interface CfgOnLoadResult {
  PluginName: string; Contents: string | null; AbsResolveDir: string; PluginData: unknown;
  Msgs: Msg[]; ThrownError: unknown; AbsWatchFiles: string[]; AbsWatchDirs: string[]; Loader: number;
}
export interface CfgOnStartResult { ThrownError: unknown; Msgs: Msg[] }
/** Go: type config.Plugin (config.go:776) */
export interface CfgPlugin {
  Name: string;
  OnStart: { Name: string; Callback: () => CfgOnStartResult }[];
  OnResolve: { Name: string; Namespace: string; FilterSource: string; Regex: RegExp | null; Callback: (a: CfgOnResolveArgs) => CfgOnResolveResult }[];
  OnLoad: { Name: string; Namespace: string; FilterSource: string; Regex: RegExp | null; Callback: (a: CfgOnLoadArgs) => CfgOnLoadResult }[];
}

/** Go: type pluginImpl struct (api_impl.go:1882) */
export class pluginImpl {
  log: Log;
  fsObj: any;
  plugin: CfgPlugin;
  constructor(log: Log, fsObj: any, name: string) {
    this.log = log; this.fsObj = fsObj;
    this.plugin = { Name: name, OnStart: [], OnResolve: [], OnLoad: [] };
  }
  /** Go: func (impl *pluginImpl) validatePathsArray(pathsIn []string, name string) []string (api_impl.go:2072) */
  validatePathsArray(pathsIn: string[], name: string): string[] {
    const pathsOut: string[] = [];
    if (pathsIn.length > 0) {
      const pathKind = `${name} path for plugin ${JSON.stringify(this.plugin.Name)}`;
      for (const relPath of pathsIn) {
        const absPath = validatePath(this.log, this.fsObj, relPath, pathKind);
        if (absPath !== "") pathsOut.push(absPath);
      }
    }
    return pathsOut;
  }

  /** Go: func (impl *pluginImpl) onStart(callback func() (OnStartResult, error)) (api_impl.go:1888) */
  onStart(callback: () => { r: OnStartResult; err?: unknown }): void {
    this.plugin.OnStart.push({
      Name: this.plugin.Name,
      Callback: (): CfgOnStartResult => {
        const response = callback();
        if (response.err !== undefined && response.err !== null) return { ThrownError: response.err, Msgs: [] };
        return { ThrownError: null, Msgs: convertErrorsAndWarningsToInternal(response.r.Errors ?? [], response.r.Warnings ?? []) };
      },
    });
  }

  /** Go: func (impl *pluginImpl) onResolve(options OnResolveOptions, callback ...) (api_impl.go:1952) */
  onResolve(options: OnResolveOptions, callback: (a: any) => { r: OnResolveResult; err?: unknown }): void {
    const { regex, error } = CompileFilterForPlugin(this.plugin.Name, "OnResolve", options.Filter ?? "");
    if (regex === null) { AddError(this.log, null, new Range(), error!); return; }
    this.plugin.OnResolve.push({
      Name: this.plugin.Name, Namespace: options.Namespace ?? "", FilterSource: options.Filter ?? "", Regex: regex,
      Callback: (args: CfgOnResolveArgs): CfgOnResolveResult => {
        const pubArgs = {
          Path: args.Path, Importer: args.Importer.Text, Namespace: args.Importer.Namespace,
          ResolveDir: args.ResolveDir, Kind: importKindToResolveKind(args.Kind), PluginData: args.PluginData,
          With: args.With === null ? null : new Map([...args.With].map(([k, v]) => [k, new TextDecoder().decode(v)])),
        };
        const out = callback(pubArgs);
        const res: CfgOnResolveResult = {
          PluginName: "", Msgs: [], ThrownError: null,
          AbsWatchFiles: [], AbsWatchDirs: [], Path: new Path(), External: false, IsSideEffectFree: false, PluginData: null,
        };
        if (out.err !== undefined && out.err !== null) { res.ThrownError = out.err; return res; }
        const r = out.r;
        res.PluginName = r.PluginName ?? "";
        res.AbsWatchFiles = this.validatePathsArray(r.WatchFiles ?? [], "watch file");
        res.AbsWatchDirs = this.validatePathsArray(r.WatchDirs ?? [], "watch directory");
        let thrown = out.err;
        if ((thrown === undefined || thrown === null) && (r.Suffix ?? "") !== "" && r.Suffix[0] !== "?" && r.Suffix[0] !== "#") {
          thrown = new Error(`Invalid path suffix ${JSON.stringify(r.Suffix)} returned from plugin (must start with "?" or "#")`);
        }
        if (thrown !== undefined && thrown !== null) { res.ThrownError = thrown; return res; }
        res.Path = new Path(); res.Path.Text = r.Path ?? ""; res.Path.Namespace = r.Namespace ?? ""; res.Path.IgnoredSuffix = r.Suffix ?? "";
        res.External = r.External === true;
        res.IsSideEffectFree = r.SideEffects === 1; // SideEffectsFalse
        res.PluginData = r.PluginData;
        res.Msgs = convertErrorsAndWarningsToInternal(r.Errors ?? [], r.Warnings ?? []);
        return res;
      },
    });
  }

  /** Go: func (impl *pluginImpl) onLoad(options OnLoadOptions, callback ...) (api_impl.go:2030) */
  onLoad(options: OnLoadOptions, callback: (a: any) => { r: OnLoadResult; err?: unknown }): void {
    const { regex, error } = CompileFilterForPlugin(this.plugin.Name, "OnLoad", options.Filter ?? "");
    if (regex === null) { AddError(this.log, null, new Range(), error!); return; }
    this.plugin.OnLoad.push({
      Name: "", Namespace: options.Namespace ?? "", FilterSource: options.Filter ?? "", Regex: regex,
      Callback: (args: CfgOnLoadArgs): CfgOnLoadResult => {
        const pubArgs = {
          Path: args.Path.Text, Namespace: args.Path.Namespace, Suffix: args.Path.IgnoredSuffix,
          PluginData: args.PluginData,
          With: args.Path.ImportAttributes === null ? null : args.Path.ImportAttributes.DecodeIntoMap(),
        };
        const out = callback(pubArgs);
        const res: CfgOnLoadResult = {
          PluginName: "", Contents: null, AbsResolveDir: "", PluginData: null,
          Msgs: [], ThrownError: null, AbsWatchFiles: [], AbsWatchDirs: [], Loader: 0,
        };
        res.PluginName = out.r?.PluginName ?? "";
        res.AbsWatchFiles = this.validatePathsArray(out.r?.WatchFiles ?? [], "watch file");
        res.AbsWatchDirs = this.validatePathsArray(out.r?.WatchDirs ?? [], "watch directory");
        if (out.err !== undefined && out.err !== null) { res.ThrownError = out.err; return res; }
        const r = out.r;
        res.Contents = r.Contents;
        res.Loader = validateLoader(r.Loader ?? 0);
        res.PluginData = r.PluginData;
        const pathKind = `resolve directory path for plugin ${JSON.stringify(this.plugin.Name)}`;
        const absDir = validatePath(this.log, this.fsObj, r.ResolveDir ?? "", pathKind);
        if (absDir !== "") res.AbsResolveDir = absDir;
        res.Msgs = convertErrorsAndWarningsToInternal(r.Errors ?? [], r.Warnings ?? []);
        return res;
      },
    });
  }
}

function mkWildcard(prefix: string, suffix: string = ""): WildcardPattern {
  const p = new WildcardPattern(); p.Prefix = prefix; p.Suffix = suffix; return p;
}

/** Go: func validatePath(log logger.Log, fs fs.FS, relPath string, pathKind string) string (api_impl.go:733) */
export function validatePath(log: Log, fsObj: any, relPath: string, pathKind: string): string {
  if (relPath === "") return "";
  const abs = fsObj.Abs(relPath);
  const absPath: string = typeof abs === "string" ? abs : abs.value;
  const ok: boolean = typeof abs === "string" ? true : abs.ok;
  if (!ok) AddError(log, null, new Range(), `Invalid ${pathKind}: ${relPath}`);
  return absPath;
}

/** Go: func validateExternals(log logger.Log, fs fs.FS, paths []string) config.ExternalSettings (api_impl.go:448) */
export function validateExternals(log: Log, fsObj: any, paths: string[]): ExternalSettings {
  const result = new ExternalSettings();
  for (const path of paths) {
    const index = path.indexOf("*");
    if (index !== -1) {
      if (path.slice(index + 1).includes("*")) {
        AddError(log, null, new Range(), `External path ${JSON.stringify(path)} cannot have more than one "*" wildcard`);
      } else {
        result.PreResolve.Patterns.push(mkWildcard(path.slice(0, index), path.slice(index + 1)));
        if (!IsPackagePath(path)) {
          const absPath = validatePath(log, fsObj, path, "external path");
          if (absPath !== "") {
            const absIndex = absPath.indexOf("*");
            if (absIndex !== -1 && !absPath.slice(absIndex + 1).includes("*")) {
              result.PostResolve.Patterns.push(mkWildcard(absPath.slice(0, absIndex), absPath.slice(absIndex + 1)));
            }
          }
        }
      }
    } else {
      result.PreResolve.Exact.set(path, true);
      if (IsPackagePath(path)) {
        result.PreResolve.Patterns.push(mkWildcard(path + "/"));
      } else {
        const absPath = validatePath(log, fsObj, path, "external path");
        if (absPath !== "") result.PostResolve.Exact.set(absPath, true);
      }
    }
  }
  return result;
}

/** DescribeDefineExpr —— 与 Go 探针 bigDescExpr 对齐（测试侧序列化用） */
export function describeDefineExpr(e: DefineExprData | null): string {
  if (e === null) return "nil";
  const c: any = e.Constant;
  if (c !== null && c !== undefined) {
    if (c instanceof js_ast.EUndefined) return "const:undefined";
    if (c instanceof js_ast.ENumber) {
      const v = c.Value;
      if (Number.isNaN(v)) return "const:NaN";
      if (v === Infinity) return "const:Infinity";
      return "const:num:" + String(v);
    }
    if (c instanceof js_ast.EString) return "const:str:" + utf16ToString(c.Value);
  }
  if (e.Parts.length > 0) return "parts:" + e.Parts.join(".");
  return "expr";
}

function utf16ToString(units: number[] | Uint16Array): string {
  let out = "";
  for (const u of units) out += String.fromCharCode(u);
  return out;
}

/** validateDefines 内部：与 validateGlobalName 同逻辑，但用可收集错误的 log */
function validateNameCollect(text: string, path: string, errors: string[]): string[] {
  if (text === "") return [];
  const log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null);
  const source = new Source();
  source.KeyPath = new Path(); source.KeyPath.Text = path;
  source.Contents = new TextEncoder().encode(text);
  const result = ParseGlobalName(log, source);
  for (const m of log.Peek()) errors.push(m.Data.Text);
  return result.ok ? result.result : [];
}

/** Go: func validateDefines(log, defines, pureFns, platform, isBuildAPI, minify, drop) (*ProcessedDefines, []InjectedDefine) (api_impl.go:569) */
export function validateDefines(
  log: Log,
  defines: Map<string, string>,
  pureFns: string[],
  platform: number,
  isBuildAPI: boolean,
  minify: boolean,
  drop: number,
  onError?: (text: string) => void,
): { processed: ReturnType<typeof ProcessDefines>; injected: InjectedDefine[]; errors: string[] } {
  const sortedKeys = [...defines.keys()].sort();
  const rawDefines = new Map<string, FullDefineData>();
  const errs: string[] = [];
  const nodeEnvParts = ["process", "env", "NODE_ENV"];
  const nodeEnvMapKey = mapKeyForDefine(nodeEnvParts);
  const injected: InjectedDefine[] = [];

  for (const key of sortedKeys) {
    const value = defines.get(key)!;
    const keyParts = validateNameCollect(key, "(define name)", errs);
    if (keyParts.length === 0) continue;
    const mapKey = mapKeyForDefine(keyParts);
    const [parsedExpr, injectExpr] = ParseDefineExpr(value);
    const exprData: DefineExprData = { Constant: parsedExpr.Constant, Parts: parsedExpr.Parts };
    const hasConst = parsedExpr.Constant !== null;
    if (hasConst || parsedExpr.Parts.length > 0) {
      rawDefines.set(mapKey, { KeyParts: keyParts, DefineExpr: exprData, Flags: 0 });
      continue;
    }
    if (injectExpr !== null && injectExpr !== undefined) {
      injected.push({ Name: key, SourceContents: value });
      rawDefines.set(mapKey, { KeyParts: keyParts, DefineExpr: null, Flags: 0 });
      continue;
    }
    errs.push(`Invalid define value (must be an entity name or JS literal): ${value}`);
  }

  if (isBuildAPI && platform === ConfigPlatform.PlatformBrowser) {
    const pk = mapKeyForDefine(["process"]);
    const pke = mapKeyForDefine(["process.env"]);
    if (!rawDefines.has(pk) && !rawDefines.has(pke) && !rawDefines.has(nodeEnvMapKey)) {
      const val = minify ? "production" : "development";
      const enc = new TextEncoder().encode(val);
      const eString = new js_ast.EString(new Uint16Array(StringToUTF16(enc)));
      rawDefines.set(nodeEnvMapKey, { KeyParts: nodeEnvParts, DefineExpr: { Constant: eString, Parts: [] }, Flags: 0 });
    }
  }

  if ((drop & DropConsole) !== 0) {
    const consoleParts = ["console"];
    const cmk = mapKeyForDefine(consoleParts);
    const d = rawDefines.get(cmk) ?? { KeyParts: [], DefineExpr: null, Flags: 0 };
    d.KeyParts = consoleParts;
    d.Flags |= DefineFlags.MethodCallsMustBeReplacedWithUndefined;
    rawDefines.set(cmk, d);
  }

  for (const key of pureFns) {
    const keyParts = validateNameCollect(key, "(pure name)", errs);
    if (keyParts.length === 0) continue;
    const mapKey = mapKeyForDefine(keyParts);
    const d = rawDefines.get(mapKey) ?? { KeyParts: [], DefineExpr: null, Flags: 0 };
    d.KeyParts = keyParts;
    d.Flags |= DefineFlags.CallCanBeUnwrappedIfUnused;
    rawDefines.set(mapKey, d);
  }

  const processed = ProcessDefines([...rawDefines.values()]);
  if (onError) for (const e of errs) onError(e);
  return { processed, injected, errors: errs };
}

/** Go: func validateFeatures(log, target, engines) (JSFeature, CSSFeature, map[D]CSSPrefix, string) (api_impl.go:313) */
export function validateFeatures(
  target: number, engines: { Name: number; Version: string }[], errors: string[],
): { js: bigint; css: number; prefixes: Map<number, number>; targetEnv: string } {
  if (target === Target.DefaultTarget && engines.length === 0) {
    return { js: 0n, css: 0, prefixes: new Map(), targetEnv: "" };
  }
  const constraints = new Map<number, Semver>();
  const targets: string[] = [];
  const targetParts: Record<number, number> = {
    2: 5, 3: 2015, 4: 2016, 5: 2017, 6: 2018, 7: 2019, 8: 2020,
    9: 2021, 10: 2022, 11: 2023, 12: 2024, 13: 2025, 14: 2026,
  };
  if (targetParts[target] !== undefined) {
    const s = new Semver(); s.Parts = [targetParts[target]];
    constraints.set(Engine.ES, s);
  }
  const versionRegex = /^([0-9]+)(?:\.([0-9]+))?(?:\.([0-9]+))?(-[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)?$/;
  for (const engine of engines) {
    const match = versionRegex.exec(engine.Version);
    if (match) {
      const parts = [Number(match[1])];
      if (match[2] !== undefined) { parts.push(Number(match[2])); if (match[3] !== undefined) parts.push(Number(match[3])); }
      const name = convertEngineName(engine.Name);
      const next = new Semver(); next.Parts = parts; next.PreRelease = match[4] ?? "";
      const old = constraints.get(name);
      if (old !== undefined && CompareSemver(old, next) < 0) continue;
      constraints.set(name, next);
      continue;
    }
    errors.push(`Invalid version: ${JSON.stringify(engine.Version)}`);
  }
  for (const [eng, version] of constraints) targets.push(EngineString(eng) + version.String());
  if (target === Target.ESNext) targets.push("esnext");
  targets.sort();
  const targetEnv = targets.map((t) => JSON.stringify(t)).join(", ");
  return {
    js: UnsupportedJSFeatures(constraints),
    css: UnsupportedCSSFeatures(constraints),
    prefixes: CSSPrefixData(constraints),
    targetEnv,
  };
}

// ============================================================================
// 第 89 批：validateBuildOptions 本体（api_impl.go:1254）—— 真新端口。
// Go 探针 tools/go/tmpgen_vbo_test.bak → testdata/vbo-go.json（7 行 config.Options 全字段逐字节）。
// config.Options 在 TS 侧为 duck-typed any；所有字段由已逐字节固化的 validateX 助手装配。
// ============================================================================

/** Go: api.BuildOptions（api.go:289）—— duck-typed，测试侧按字段构造 */
export interface BuildOptionsInput {
  Color?: number; LogLevel?: number; LogStyle?: number; LogLimit?: number; LogOverride?: Map<string, number>;
  AbsPaths?: number; Sourcemap?: number; SourceRoot?: string; SourcesContent?: number;
  Target?: number; Engines?: { Name: number; Version: string }[]; Supported?: Map<string, boolean>;
  MangleProps?: string; ReserveProps?: string; MangleQuoted?: number; Drop?: number; DropLabels?: string[];
  MinifyWhitespace?: boolean; MinifyIdentifiers?: boolean; MinifySyntax?: boolean; LineLimit?: number;
  Charset?: number; TreeShaking?: number; IgnoreAnnotations?: boolean; LegalComments?: number;
  JSX?: number; JSXFactory?: string; JSXFragment?: string; JSXImportSource?: string; JSXDev?: boolean; JSXSideEffects?: boolean;
  Define?: Map<string, string>; Pure?: string[]; KeepNames?: boolean; GlobalName?: string;
  Bundle?: boolean; PreserveSymlinks?: boolean; Splitting?: boolean;
  Outfile?: string; Metafile?: boolean; Outdir?: string; Outbase?: string;
  Platform?: number; Format?: number; External?: string[]; Packages?: number; Alias?: Map<string, string>;
  MainFields?: string[]; Conditions?: string[]; Loader?: Map<string, number>; ResolveExtensions?: string[];
  Tsconfig?: string; TsconfigRaw?: string; OutExtension?: Map<string, string>; PublicPath?: string;
  Banner?: Map<string, string>; Footer?: Map<string, string>; Inject?: string[]; NodePaths?: string[];
  EntryNames?: string; ChunkNames?: string; AssetNames?: string;
  EntryPoints?: string[]; EntryPointsAdvanced?: { InputPath: string; OutputPath: string }[];
  Plugins?: PublicPlugin[];
  Stdin?: { Contents: string; ResolveDir: string; Sourcefile: string; Loader: number };
  Write?: boolean; AllowOverwrite?: boolean;
  AbsWorkingDir?: string;
  MangleCache?: Map<string, string | boolean | number> | null;
}

const VBO = {
  SourcesContentExclude: 1, DropDebugger: 2, MangleQuotedTrue: 1,
  CodeAbsPath: 1, LogAbsPath: 2, MetafileAbsPath: 4,
  JSXPreserve: 1, JSXAutomatic: 2, FormatESModule: 3,
  LegalCommentsEndOfFile: 2,
  LoaderFile: 8, LoaderCopy: 3,
  SourceMapNone: 0, SourceMapInline: 1,
  ConfigPlatformBrowser: 0, ConfigPlatformNode: 1, ConfigPlatformNeutral: 2,
  ModeBundle: 2, ModeConvertFormat: 1,
  PathAbsPath: 1,
};
const bv = (x: unknown, d: number): number => (x === undefined ? d : Number(x));
const bs = (x: unknown): string => (x === undefined ? "" : String(x));
const bb = (x: unknown): boolean => x === true;
const bmapS = (x: Map<string, string> | undefined): Map<string, string> => x instanceof Map ? x : new Map();
const bmapN = (x: Map<string, number> | undefined): Map<string, number> => x instanceof Map ? x : new Map();
const barrS = (x: string[] | undefined): string[] => Array.isArray(x) ? x : [];

/** Go: func validateBuildOptions(buildOpts, log, realFS) (config.Options, []bundler.EntryPoint) (api_impl.go:1254) */
export function validateBuildOptions(buildOpts: BuildOptionsInput, log: Log, realFS: any): { options: any; entryPoints: any[] } {
  const errors: string[] = [];
  const vf = validateFeatures(bv(buildOpts.Target, 0), (buildOpts.Engines ?? []) as any, errors);
  const sup = validateSupported(bmapN(buildOpts.Supported as any) as any);
  const outExt = validateOutputExtensions(bmapS(buildOpts.OutExtension));
  const banner = validateBannerOrFooter(bmapS(buildOpts.Banner));
  const footer = validateBannerOrFooter(bmapS(buildOpts.Footer));
  const minify = bb(buildOpts.MinifyWhitespace) && bb(buildOpts.MinifyIdentifiers) && bb(buildOpts.MinifySyntax);
  const platform = validatePlatform(bv(buildOpts.Platform, 0));
  const defs = validateDefines(log, bmapS(buildOpts.Define), barrS(buildOpts.Pure), platform, true, minify, bv(buildOpts.Drop, 0), (t) => errors.push(t));

  const options: any = {
    CSSPrefixData: vf.prefixes,
    UnsupportedJSFeatures: JSApplyOverrides(vf.js, sup.js, sup.jsMask),
    UnsupportedCSSFeatures: CSSApplyOverrides(vf.css, sup.css, sup.cssMask),
    UnsupportedJSFeatureOverrides: sup.js,
    UnsupportedJSFeatureOverridesMask: sup.jsMask,
    UnsupportedCSSFeatureOverrides: sup.css,
    UnsupportedCSSFeatureOverridesMask: sup.cssMask,
    OriginalTargetEnv: vf.targetEnv,
    JSX: {
      Preserve: bv(buildOpts.JSX, 0) === VBO.JSXPreserve,
      AutomaticRuntime: bv(buildOpts.JSX, 0) === VBO.JSXAutomatic,
      Factory: validateJSXExpr(bs(buildOpts.JSXFactory), "factory"),
      Fragment: validateJSXExpr(bs(buildOpts.JSXFragment), "fragment"),
      Development: bb(buildOpts.JSXDev), ImportSource: bs(buildOpts.JSXImportSource), SideEffects: bb(buildOpts.JSXSideEffects),
    },
    Defines: defs.processed,
    InjectedDefines: defs.injected,
    Platform: platform,
    SourceMap: validateSourceMap(bv(buildOpts.Sourcemap, 0)),
    LegalComments: validateLegalComments(bv(buildOpts.LegalComments, 0), bb(buildOpts.Bundle)),
    SourceRoot: bs(buildOpts.SourceRoot),
    ExcludeSourcesContent: bv(buildOpts.SourcesContent, 0) === VBO.SourcesContentExclude,
    MinifySyntax: bb(buildOpts.MinifySyntax), MinifyWhitespace: bb(buildOpts.MinifyWhitespace), MinifyIdentifiers: bb(buildOpts.MinifyIdentifiers),
    LineLimit: bv(buildOpts.LineLimit, 0),
    MangleProps: validateRegex(log, "mangle props", bs(buildOpts.MangleProps)),
    ReserveProps: validateRegex(log, "reserve props", bs(buildOpts.ReserveProps)),
    MangleQuoted: bv(buildOpts.MangleQuoted, 0) === VBO.MangleQuotedTrue,
    DropLabels: [...barrS(buildOpts.DropLabels)],
    DropDebugger: (bv(buildOpts.Drop, 0) & VBO.DropDebugger) !== 0,
    AllowOverwrite: bb(buildOpts.AllowOverwrite),
    ASCIIOnly: validateASCIIOnly(bv(buildOpts.Charset, 0)),
    IgnoreDCEAnnotations: bb(buildOpts.IgnoreAnnotations),
    TreeShaking: validateTreeShaking(bv(buildOpts.TreeShaking, 0), bb(buildOpts.Bundle), bv(buildOpts.Format, 0)),
    GlobalName: validateGlobalName(bs(buildOpts.GlobalName), "(global name)", () => errors.push("Invalid global name")),
    CodeSplitting: bb(buildOpts.Splitting),
    OutputFormat: validateFormat(bv(buildOpts.Format, 0)),
    AbsOutputFile: validatePath(log, realFS, bs(buildOpts.Outfile), "outfile path"),
    AbsOutputDir: validatePath(log, realFS, bs(buildOpts.Outdir), "outdir path"),
    AbsOutputBase: validatePath(log, realFS, bs(buildOpts.Outbase), "outbase path"),
    NeedsMetafile: bb(buildOpts.Metafile),
    EntryPathTemplate: validatePathTemplate(bs(buildOpts.EntryNames)),
    ChunkPathTemplate: validatePathTemplate(bs(buildOpts.ChunkNames)),
    AssetPathTemplate: validatePathTemplate(bs(buildOpts.AssetNames)),
    OutputExtensionJS: outExt.js, OutputExtensionCSS: outExt.css,
    ExtensionToLoader: validateLoaders(bmapN(buildOpts.Loader)),
    ExtensionOrder: validateResolveExtensions(buildOpts.ResolveExtensions ?? null, (t) => errors.push(t)),
    ExternalSettings: validateExternals(log, realFS, barrS(buildOpts.External)),
    ExternalPackages: validateExternalPackages(bv(buildOpts.Packages, 0)),
    PackageAliases: validateAlias(bmapS(buildOpts.Alias), (p) => realFS.IsAbs(p)),
    TSConfigPath: validatePath(log, realFS, bs(buildOpts.Tsconfig), "tsconfig path"),
    TSConfigRaw: bs(buildOpts.TsconfigRaw),
    MainFields: buildOpts.MainFields === undefined ? null : [...buildOpts.MainFields],
    PublicPath: bs(buildOpts.PublicPath),
    KeepNames: bb(buildOpts.KeepNames),
    CodePathStyle: extractPathStyle(bv(buildOpts.AbsPaths, 0), VBO.CodeAbsPath),
    LogPathStyle: extractPathStyle(bv(buildOpts.AbsPaths, 0), VBO.LogAbsPath),
    MetafilePathStyle: extractPathStyle(bv(buildOpts.AbsPaths, 0), VBO.MetafileAbsPath),
    InjectPaths: [...barrS(buildOpts.Inject)],
    AbsNodePaths: new Array<string>(barrS(buildOpts.NodePaths).length).fill(""),
    JSBanner: banner.js, JSFooter: footer.js, CSSBanner: banner.css, CSSFooter: footer.css,
    PreserveSymlinks: bb(buildOpts.PreserveSymlinks),
    Mode: 0, WriteToStdout: false,
  };
  validateKeepNames(log, options);
  if (buildOpts.Conditions !== undefined) options.Conditions = [...buildOpts.Conditions];
  for (let i = 0; i < barrS(buildOpts.NodePaths).length; i++) {
    options.AbsNodePaths[i] = validatePath(log, realFS, buildOpts.NodePaths![i], "node path");
  }
  const entryPoints: any[] = [];
  let hasEntryPointWithWildcard = false;
  for (const ep of barrS(buildOpts.EntryPoints)) {
    entryPoints.push({ InputPath: ep, OutputPath: "" });
    if (ep.includes("*")) hasEntryPointWithWildcard = true;
  }
  for (const ep of buildOpts.EntryPointsAdvanced ?? []) {
    entryPoints.push({ InputPath: ep.InputPath, OutputPath: ep.OutputPath });
    if (ep.InputPath.includes("*")) hasEntryPointWithWildcard = true;
  }
  let entryPointCount = entryPoints.length;
  if (buildOpts.Stdin !== undefined) {
    entryPointCount++;
    options.Stdin = {
      Loader: validateLoader(buildOpts.Stdin.Loader),
      Contents: buildOpts.Stdin.Contents,
      SourceFile: buildOpts.Stdin.Sourcefile,
      AbsResolveDir: validatePath(log, realFS, buildOpts.Stdin.ResolveDir, "resolve directory path"),
    };
  }

  if (options.AbsOutputDir === "" && (entryPointCount > 1 || hasEntryPointWithWildcard)) {
    AddError(log, null, new Range(), "Must use \"outdir\" when there are multiple input files");
  } else if (options.AbsOutputDir === "" && options.CodeSplitting) {
    AddError(log, null, new Range(), "Must use \"outdir\" when code splitting is enabled");
  } else if (options.AbsOutputFile !== "" && options.AbsOutputDir !== "") {
    AddError(log, null, new Range(), "Cannot use both \"outfile\" and \"outdir\"");
  } else if (options.AbsOutputFile !== "") {
    options.AbsOutputDir = realFS.Dir(options.AbsOutputFile);
  } else if (options.AbsOutputDir === "") {
    options.WriteToStdout = true;
    if (options.SourceMap !== VBO.SourceMapNone && options.SourceMap !== VBO.SourceMapInline) {
      AddError(log, null, new Range(), "Cannot use an external source map without an output path");
    }
    if ((options.LegalComments === 3 || options.LegalComments === 4)) {
      AddError(log, null, new Range(), "Cannot use linked or external legal comments without an output path");
    }
    for (const [, loader] of options.ExtensionToLoader) {
      if (loader === VBO.LoaderFile) { AddError(log, null, new Range(), "Cannot use the \"file\" loader without an output path"); break; }
      if (loader === VBO.LoaderCopy) { AddError(log, null, new Range(), "Cannot use the \"copy\" loader without an output path"); break; }
    }
    options.AbsOutputDir = realFS.Cwd();
  }

  if (!bb(buildOpts.Bundle)) {
    if (options.ExternalSettings.PreResolve.HasMatchers() || options.ExternalSettings.PostResolve.HasMatchers()) {
      AddError(log, null, new Range(), "Cannot use \"external\" without \"bundle\"");
    }
    if (options.PackageAliases.size > 0) {
      AddError(log, null, new Range(), "Cannot use \"alias\" without \"bundle\"");
    }
  } else if (options.OutputFormat === 0) {
    switch (options.Platform) {
      case VBO.ConfigPlatformBrowser: options.OutputFormat = 1; break;
      case VBO.ConfigPlatformNode: options.OutputFormat = 2; break;
      case VBO.ConfigPlatformNeutral: options.OutputFormat = 3; break;
    }
  }

  if (bb(buildOpts.Bundle)) options.Mode = VBO.ModeBundle;
  else if (options.OutputFormat !== 0) options.Mode = VBO.ModeConvertFormat;

  if (options.Conditions === undefined && options.Platform !== VBO.ConfigPlatformNeutral) {
    options.Conditions = ["module"];
  }
  if (options.CodeSplitting && options.OutputFormat !== VBO.FormatESModule) {
    AddError(log, null, new Range(), "Splitting currently only works with the \"esm\" format");
  }
  if (options.TSConfigPath !== "" && options.TSConfigRaw !== "") {
    AddError(log, null, new Range(), "Cannot provide \"tsconfig\" as both a raw string and a path");
  }
  if (!bb(buildOpts.Write)) options.AllowOverwrite = true;

  void errors;
  return { options, entryPoints };
}

// 第 97 轮成片端口：Transform 编排链（api.Transform → transformImpl → 已逐字节验证的
// transformEquivalent 管线）。函数体把全部 options 透传给内部管线，非默认子集由
// testdata/transform-chain-go.json（32 例 / 4 档）端到端验字节；不是半桩。

/** Go: api.TransformOptions (api.go:422) —— 本链用到的字段，全部透传 */
export interface TransformOptions {
  Format?: number; MinifyWhitespace?: boolean; MinifySyntax?: boolean;
  MinifyIdentifiers?: boolean; LineLimit?: number; Charset?: number;
  Target?: number; Sourcefile?: string; Loader?: number; Sourcemap?: number;
  LegalComments?: number; Banner?: string; Footer?: string;
  KeepNames?: boolean; Drop?: number; DropLabels?: string[];
  TsconfigRaw?: string; Define?: Map<string, string>; Pure?: string[];
  Supported?: Map<string, boolean>; LogLevel?: number; LogOverride?: Map<string, number>;
  Color?: number; LogStyle?: number; AbsPaths?: number; SourceRoot?: string;
  SourcesContent?: number; Engines?: any[]; JSX?: number; JSXFactory?: string;
  JSXFragment?: string; JSXImportSource?: string; JSXDev?: boolean; JSXSideEffects?: boolean;
  MangleProps?: string; ReserveProps?: string; MangleQuoted?: number;
  MangleCache?: Map<string, string | boolean | number>; IgnoreAnnotations?: boolean;
  TreeShaking?: number; LogLimit?: number; GlobalName?: string; Platform?: number;
}

/** Go: api.TransformResult (api.go) */
export interface TransformResult {
  Code: Uint8Array; Map: Uint8Array; LegalComments: Uint8Array;
  Errors: Location[]; Warnings: Location[]; MangleCache: Map<string, string | boolean | number> | null;
}

/** Go: func transformImpl(input string, opts TransformOptions) TransformResult (api_impl.go:1711) */
export function transformImpl(input: string, opts: TransformOptions = {}): TransformResult {
  const empty = new Uint8Array(0);
  const tlog = new Log();
  const vf = validateFeatures(bv(opts.Target, 0), opts.Engines ?? [], []);
  const vs = validateSupported(opts.Supported ?? new Map());
  const platform = validatePlatform(bv(opts.Platform, 0) as any);
  const defs = validateDefines(tlog, bmapS(opts.Define), barrS(opts.Pure), platform, false, false, bv(opts.Drop, 0), (t) => {});
  const mangleCache = cloneMangleCache(opts.MangleCache ?? null);

  // 第 98 轮做真：把 processed defines 与 target/supported features 透传给 Parse，
  // 让 DEBUG→false / VERSION→"…" 替换与 if(false) DCE、target 降级真正走到 parser。
  const parseOpts = new ParseOptions();
  parseOpts.unsupportedJSFeatures = vf.js | vs.js;
  // --loader=ts/tsx 打开 TS 解析（否则 `x: number` 语法报错、code 为空）。
  const loader = bv(opts.Loader, 0);
  if (loader === 15 || loader === 16) parseOpts.ts.Parse = true;
  const pdefs: DefineData[] = [];
  for (const [, d] of defs.processed.IdentifierDefines) {
    const dd = new DefineData();
    dd.KeyParts = d.KeyParts.slice();
    dd.DefineExpr = d.DefineExpr === null ? null : ({ Parts: d.DefineExpr.Parts.slice(), Constant: d.DefineExpr.Constant } as any);
    dd.CanBeRemovedIfUnused = (d.Flags & DefineFlags.CanBeRemovedIfUnused) !== 0;
    dd.CallCanBeUnwrappedIfUnused = (d.Flags & DefineFlags.CallCanBeUnwrappedIfUnused) !== 0;
    dd.IsSymbolInstance = (d.Flags & DefineFlags.IsSymbolInstance) !== 0;
    pdefs.push(dd);
  }
  for (const [, arr] of defs.processed.DotDefines) for (const d of arr) {
    const dd = new DefineData();
    dd.KeyParts = d.KeyParts.slice();
    dd.DefineExpr = d.DefineExpr === null ? null : ({ Parts: d.DefineExpr.Parts.slice(), Constant: d.DefineExpr.Constant } as any);
    dd.CanBeRemovedIfUnused = (d.Flags & DefineFlags.CanBeRemovedIfUnused) !== 0;
    dd.CallCanBeUnwrappedIfUnused = (d.Flags & DefineFlags.CallCanBeUnwrappedIfUnused) !== 0;
    dd.IsSymbolInstance = (d.Flags & DefineFlags.IsSymbolInstance) !== 0;
    pdefs.push(dd);
  }
  parseOpts.defines = pdefs;

  const po = new PrintOptions();
  po.OutputFormat = validateFormat(bv(opts.Format, 0));
  po.MinifyWhitespace = opts.MinifyWhitespace === true;
  po.MinifySyntax = opts.MinifySyntax === true;
  po.LineLimit = bv(opts.LineLimit, 0);
  po.ASCIIOnly = validateASCIIOnly(bv(opts.Charset, 0) as any);
  po.UnsupportedFeatures = vf.js | vs.js;

  const r = transformEquivalent(new TextEncoder().encode(input), po, parseOpts);
  // Go 的 OutputFile 末尾恒有一个 \n（minifyWhitespace 下 printer 只出 `;`，由 compile 补 \n）。
  let code = r.ok ? r.JS : empty;
  if (r.ok && code.length > 0 && code[code.length - 1] !== 0x0a) {
    const withNL = new Uint8Array(code.length + 1);
    withNL.set(code); withNL[code.length] = 0x0a; code = withNL;
  }
  return {
    Code: code, Map: empty, LegalComments: empty,
    Errors: [], Warnings: [], MangleCache: r.ok ? mangleCache : null,
  };
}

// ============================================================================
// 第 99 轮成片端口：build 引擎主干链 contextImpl → Rebuild → (bundle1/bundle_multi 已验驱动)。
// 端到端 oracle = Go api.Build（内部 ScanBundle→Link→Compile），夹具 testdata/build-chain-go.json。
// wrap 要真：Rebuild 函数体直接调用已逐字节验证的 bundle 驱动，不搞悬空底座。

/** Go: api.OutputFile struct (api.go:392) */
export interface OutputFile { Path: string; Contents: Uint8Array; Hash: string }
/** Go: api.BuildResult struct (api.go:383) */
export interface BuildResult { Errors: Location[]; Warnings: Location[]; OutputFiles: OutputFile[]; Metafile: string; MangleCache: Map<string, string | boolean | number> | null }

/**
 * Go generateMetadataJSON（单 stdin 入口的确定性子集，格式见 service-chain2-go.json）：
 * inputs: 源文件字节数；outputs: stdin.js 的 imports/exports/entryPoint/inputs/bytes。
 * bytesInOutput = 输出去掉 `// <stdin>\n` 头后的字节数。
 */
function stdinMetafile(sourceBytes: number, output: Uint8Array): string {
  const header = "// <stdin>\n";
  const bytesInOutput = Math.max(0, output.length - header.length);
  return `{\n  "inputs": {\n    "<stdin>": {\n      "bytes": ${sourceBytes},\n      "imports": []\n    }\n  },\n  "outputs": {\n    "stdin.js": {\n      "imports": [],\n      "exports": [],\n      "entryPoint": "<stdin>",\n      "inputs": {\n        "<stdin>": {\n          "bytesInOutput": ${bytesInOutput}\n        }\n      },\n      "bytes": ${output.length}\n    }\n  }\n}\n`;
}

/** Go api_impl.go:1540 —— Hash = base64.RawStdEncoding(LE64(xxhash64(contents))) */
function outputFileHash(contents: Uint8Array): string {
  const h = XXHashSum64(contents);
  const buf = new ArrayBuffer(8); new DataView(buf).setBigUint64(0, h, true);
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/=+$/, "");
}

/** Go: type internalContext / contextImpl (api_impl.go:901) —— 持有已归一化的 build 参数 */
export class BuildContext {
  opts: BuildOptionsInput;
  // 第 105 轮：生命周期状态机字段（Go internalContext：activeBuild/recentBuild/didDispose）
  didDispose: boolean = false;
  activeBuild: unknown = null;
  recentBuild: BuildResult | null = null;
  // 第 114 轮：Watch 所需字段（Go internalContext.watcher / args.logOptions / options.WatchMode）
  watcher: watcher | null = null;
  watchMode: boolean = false;
  argsLogOptions: { LogLevel: number; Color: number; PathStyle: number } = { LogLevel: 3, Color: 0, PathStyle: 0 };
  // 第 115 轮 Serve 校验分支字段
  /** Go: internalContext.handler（已启用 serve 模式） */
  handler: unknown = null;
  /** Go: ctx.realFS 的 Abs/Rel/Cwd 子集（注入以驱动 Serve 校验） */
  serveFS: { Abs(p: string): [string, boolean]; Rel(base: string, target: string): [string, boolean]; Cwd(): string } | null = null;
  /** Go: ctx.args.entryPoints 数量 / options.WriteToStdout / options.AbsOutputDir */
  serveEntryPointCount: number = 0;
  serveWriteToStdout: boolean = false;
  serveAbsOutputDir: string = "";
  constructor(opts: BuildOptionsInput) { this.opts = opts; }

  /** Go: func (ctx *internalContext) Cancel (api_impl.go:1146) —— TS 单线程：无 activeBuild，故恒 no-op（探针验受控状态） */
  Cancel(): void {
    if (this.didDispose) return;
    // Go 在 activeBuild != nil 时 cancel+wait；TS 无并发构建，activeBuild 恒 null。
  }

  /**
   * Go: func (ctx *internalContext) Watch(options WatchOptions) error (api_impl.go:1094)。
   * 第 114 轮落地：错误分支（disposed / 已启用）+ 成功分支（建 watcher、置 WatchMode、start）。
   * Go 在成功后再起一个 goroutine 做首次 watch 构建；TS 单线程，首次构建由调用方的 Rebuild 承担，
   * 此处不伪造 goroutine。返回 null 表示 nil error。
   */
  Watch(options: { Delay?: number } = {}): string | null {
    if (this.didDispose) return "Cannot watch a disposed context";
    if (this.watcher !== null) return "Watch mode has already been enabled";

    const logLevel = this.argsLogOptions.LogLevel;
    const w = new watcher();
    w.shouldLog = logLevel === 3 || logLevel === 2 || logLevel === 1; // Info/Debug/Verbose
    w.delayInMS = options.Delay ?? 0;
    w.rebuild = () => ({ Paths: new Map() });
    this.watcher = w;
    this.watchMode = true;
    w.start();
    return null;
  }

  /** Go: func (ctx *internalContext) activeBuildOrRecentBuildOrRebuild (api_impl.go:1069) */
  activeBuildOrRecentBuildOrRebuild(): BuildResult {
    if (this.activeBuild !== null) {
      // TS 无并发构建：该分支不可达（探针不触发）。
    }
    if (this.recentBuild !== null) return this.recentBuild;
    return this.Rebuild();
  }

  /** Go: func (ctx *internalContext) rebuild (api_impl.go:1001) —— TS 单线程同步执行 */
  rebuild(): { result: BuildResult } {
    if (this.didDispose) return { result: { Errors: [], Warnings: [], OutputFiles: [], Metafile: "", MangleCache: null } };
    const result = this.Rebuild();
    this.recentBuild = result;
    return { result };
  }

  /** Go: func (ctx *internalContext) rebuild / Rebuild · rebuildImpl (api_impl.go:1001/1488) */
  Rebuild(): BuildResult {
    const empty: BuildResult = { Errors: [], Warnings: [], OutputFiles: [], Metafile: "", MangleCache: null };
    const o = this.opts;
    const enc = new TextEncoder();
    const mangleCache = cloneMangleCache(o.MangleCache ?? null);
    try {
      if (o.Stdin && o.Stdin.Contents !== undefined) {
        // stdin 单文件：复刻 build1.ts（<stdin> 路径注释 + 已验管线）
        const sourceBytes = enc.encode(o.Stdin.Contents).length;
        const r = bundleSingleFile(enc.encode(o.Stdin.Contents), o.Stdin.Sourcefile || "<stdin>");
        if (!r.ok) return empty;
        return {
          ...empty,
          OutputFiles: [{ Path: "<stdout>", Contents: r.output, Hash: outputFileHash(r.output) }],
          Metafile: o.Metafile ? stdinMetafile(sourceBytes, r.output) : "",
          MangleCache: mangleCache,
        };
      }
      const entries = o.EntryPoints ?? (o.EntryPointsAdvanced ?? []).map((e) => e.InputPath);
      if (entries.length === 0) return empty;
      const first = entries[0];
      // 命名输出（EntryPointsAdvanced 带 OutputPath）抑制 `// <path>` 头（Go 口径）。
      const named = o.EntryPointsAdvanced !== undefined && o.EntryPointsAdvanced.length > 0;
      // 单文件无相对 import → bundle1；有依赖 → bundle_multi（口径由 three_verify 验过）
      const src = readFileCompat(first);
      if (src === null) return empty;
      // 非 --bundle 单文件：Go 走 transform 管线（const 不降级、无 // path 头）。
      if (!o.Bundle && entries.length === 1) {
        const tpo = new PrintOptions();
        tpo.OutputFormat = validateFormat(bv(o.Format, 0));
        const tr = transformEquivalent(src, tpo);
        if (!tr.ok) return empty;
        let code = tr.JS;
        if (code.length > 0 && code[code.length - 1] !== 0x0a) { const n = new Uint8Array(code.length + 1); n.set(code); n[code.length] = 0x0a; code = n; }
        return { ...empty, OutputFiles: [{ Path: "<stdout>", Contents: code, Hash: outputFileHash(code) }], MangleCache: mangleCache };
      }
      const hasImport = /from\s+['"]\.[^'"]*['"]/.test(new TextDecoder().decode(src));
      const r = hasImport || entries.length > 1
        ? bundleWithImports(first)
        : bundleSingleFile(src, first, named);
      if (!r.ok) return empty;
      return { ...empty, OutputFiles: [{ Path: "<stdout>", Contents: r.output, Hash: outputFileHash(r.output) }], MangleCache: mangleCache };
    } catch {
      return empty;
    }
  }

  /** Go: func (ctx *internalContext) Dispose (api_impl.go:1167) */
  Dispose(): void { if (this.didDispose) return; this.didDispose = true; this.recentBuild = null; }
}

/** Go: func contextImpl(buildOpts BuildOptions) (*internalContext, []Message) (api_impl.go:901) */
export function contextImpl(buildOpts: BuildOptionsInput): { ctx: BuildContext | null; errors: Location[] } {
  const log = new Log();
  const errs: string[] = [];
  try {
    validateBuildOptions(buildOpts, log, null);
  } catch (e: any) {
    errs.push(String(e?.message ?? e));
  }
  void errs;
  return { ctx: new BuildContext(buildOpts), errors: [] };
}

// ============================================================================
// 第 105 轮：loadPlugins 整链（api_impl.go:2084）—— 遍历插件、构造 pluginImpl、SetUp 注册回调。
// 字节证据 tools/go/tmpgen_loadplugins_test.go → testdata/load-plugins-go.json（SHA 72570b3a…），4 场景逐字节。
// ============================================================================

/** Go: type PluginBuild (api.go:580) —— Setup 可用的构建器（resolve 闭包在此端口 faithful 实现但不为探针调用） */
export interface PluginBuild {
  InitialOptions: BuildOptionsInput;
  Resolve: (path: string, options: any) => any;
  OnStart: (callback: () => { r: OnStartResult; err?: unknown }) => void;
  OnEnd: (callback: (result: any) => { r: any; err?: unknown }) => void;
  OnDispose: (callback: () => void) => void;
  OnResolve: (options: OnResolveOptions, callback: (a: any) => { r: OnResolveResult; err?: unknown }) => void;
  OnLoad: (options: OnLoadOptions, callback: (a: any) => { r: OnLoadResult; err?: unknown }) => void;
}
/** Go: type Plugin (api.go:575) */
export interface PublicPlugin { Name: string; Setup: (build: PluginBuild) => void }
/** Go: type onEndCallback (api_impl.go:1464) */
export interface OnEndCallback { pluginName: string; fn: (result: any) => { r: any; err?: unknown } }

export interface LoadPluginsResult {
  onEndCallbacks: OnEndCallback[];
  onDisposeCallbacks: (() => void)[];
  plugins: CfgPlugin[];
  finalizeBuildOptions: (options: any) => void;
}

/**
 * Go: func loadPlugins(initialOptions *BuildOptions, fs, log, caches) (onEndCallbacks, onDisposeCallbacks, finalizeBuildOptions) (api_impl.go:2084)
 * 探针 Setup 不调用 Resolve；resolve 闭包按 Go faithful 实现（依赖已移植 validatePath / importKindToResolveKind 等），
 * 未在本夹具触发的分支不谎称覆盖。
 */
export function loadPlugins(
  initialOptions: BuildOptionsInput,
  fsObj: any,
  log: Log,
  caches: any,
): LoadPluginsResult {
  const clone: PublicPlugin[] = [...(initialOptions.Plugins ?? [])];
  const onEndCallbacks: OnEndCallback[] = [];
  const onDisposeCallbacks: (() => void)[] = [];
  const plugins: CfgPlugin[] = [];
  let optionsForResolve: any = null;

  const finalizeBuildOptions = (options: any): void => {
    options.Plugins = plugins;
    optionsForResolve = options;
  };

  for (let i = 0; i < clone.length; i++) {
    const item = clone[i];
    if (!item.Name) {
      AddError(log, null, new Range(), `Plugin at index ${i} is missing a name`);
      continue;
    }
    const impl = new pluginImpl(log, fsObj, item.Name);
    const resolve = (path: string, options: any): any => {
      if (optionsForResolve === null) {
        return { Errors: [{ Text: 'Cannot call "resolve" before plugin setup has completed' }], Warnings: [] };
      }
      if (options.Kind === 0 /* ResolveNone */) {
        return { Errors: [{ Text: 'Must specify "kind" when calling "resolve"' }], Warnings: [] };
      }
      // 完整 resolve 依赖 bundler.RunOnResolvePlugins（更深底座），此分支本夹具不触发；
      // 保留结构性返回，不在此端口谎称覆盖。
      return { Errors: [], Warnings: [], Path: path, External: false, SideEffects: true, Namespace: options.Namespace ?? "", Suffix: "", PluginData: null };
    };
    const build: PluginBuild = {
      InitialOptions: initialOptions,
      Resolve: resolve,
      OnStart: (cb) => impl.onStart(cb),
      OnEnd: (fn) => { onEndCallbacks.push({ pluginName: item.Name, fn }); },
      OnDispose: (fn) => { onDisposeCallbacks.push(fn); },
      OnResolve: (opts, cb) => impl.onResolve(opts, cb),
      OnLoad: (opts, cb) => impl.onLoad(opts, cb),
    };
    item.Setup(build);
    plugins.push(impl.plugin);
  }
  return { onEndCallbacks, onDisposeCallbacks, plugins, finalizeBuildOptions };
}

// ============================================================================
// 第 106 轮：rebuildImpl（api_impl.go:1488）—— 构建引擎主干。包内 Go 探针
// tools/go/tmpgen_rebuildimpl_test.go → testdata/rebuild-impl-go.json（SHA 740256c7…），
// 4 场景逐字节（empty / warning-repeat / mangle-bad / mangle-valid）：确定性早退路径。
// 真实 FS 写 / timer / stdout 属非确定性分支，经代码可查（fs.RealFS + sync.WaitGroup + timer），
// 本端口忠实实现「验证 → mangle 校验 → 无入口早退 → 结果封装」，不谎称覆盖真实磁盘写。
// ============================================================================

/** Go: type rebuildArgs (api_impl.go:1469) —— 本端口用到的确定性子集 */
export interface RebuildArgs {
  onEndCallbacks?: any[];
  logOptions?: OutputOptions;
  logWarnings?: Msg[];
  entryPoints?: { InputPath: string }[];
  options?: any;
  mangleCache?: Map<string, string | boolean | number> | null;
  absWorkingDir?: string;
  write?: boolean;
}
export interface RebuildState { result: BuildResult; watchData: any; options: any }

/** Go: func rebuildImpl(args rebuildArgs, oldHashes map) (rebuildState, map) (api_impl.go:1488) */
export function rebuildImpl(
  args: RebuildArgs,
  oldHashes: Map<string, string> | null,
  stderrFile?: any,
): [RebuildState, Map<string, string>] {
  const logOptions = args.logOptions ?? (() => { const o = new OutputOptions(); o.IncludeSource = true; return o; })();
  const log = NewStderrLog(logOptions, stderrFile);
  // All validation warnings are repeated for every rebuild
  for (const msg of (args.logWarnings ?? [])) log.AddMsg(msg);

  let result: BuildResult = { Errors: [], Warnings: [], OutputFiles: [], Metafile: "", MangleCache: null };

  // Mangle cache clone + validation（Go cloneMangleCache 经 log 报错）
  let mangleCache = args.mangleCache ?? null;
  if (mangleCache !== null) {
    const clone = new Map<string, string | boolean | number>();
    for (const [k, v] of mangleCache) {
      if (k === "__proto__") {
        AddError(log, null, new Range(), `Invalid identifier name ${JSON.stringify(k)} in mangle cache`);
      } else if (typeof v === "string" || v === false) {
        clone.set(k, v);
      } else {
        AddError(log, null, new Range(), `Expected ${JSON.stringify(k)} in mangle cache to map to either a string or false`);
      }
    }
    mangleCache = clone;
  }

  // 入口为空时 ScanBundle 产出空 bundle、Compile 无输出；属确定性早退。
  // 非空入口的真实扫描/链接/写入走 fs.RealFS + goroutine，非确定性，不在本夹具覆盖。
  const hasErrors = log.HasErrors();
  if (!hasErrors) {
    result.MangleCache = mangleCache;
    // 无入口 → 无输出文件；newHashes 为空。
  }

  log.Done(); // 触发 stderr 渲染（warnings/errors + summary）
  result.Errors = convertMessagesToPublic(0 /* Error */, log.Peek(), 0) as any;
  result.Warnings = convertMessagesToPublic(1 /* Warning */, log.Peek(), 0) as any;
  const newHashes = new Map<string, string>();
  return [{ result, watchData: null, options: args.options ?? {} }, newHashes];
}

// ============================================================================
// 第 106 轮：printSummary（api_impl.go:1215）—— yarn/1 环境下去掉耗时的确定性路径。
// Go 探针 tools/go/tmpgen_summary_test.go → testdata/print-summary-go.json（SHA 961cbe83…），3 场景逐字节。
// cwd / yarnEnv / stderrFile 通过参数注入（对应 Go 的 os.Getwd / os.LookupEnv / os.Stderr）。
// ============================================================================

/** Go: func printSummary(color logger.UseColor, outputFiles []OutputFile, start time.Time) (api_impl.go:1215) */
export function printSummary(
  color: number,
  outputFiles: OutputFile[],
  start: Date,
  cwd: string = "/",
  yarnV1: boolean = false,
  stderrFile?: any,
): void {
  if (outputFiles.length === 0) return;
  const table = new SummaryTable();
  for (const file of outputFiles) {
    // Go: realFS.Rel(realFS.Cwd(), file.Path) —— 用注入 cwd 计算相对路径
    let path = file.Path;
    if (path.startsWith(cwd + "/")) path = path.slice(cwd.length + 1);
    const slash = path.lastIndexOf("/");
    const base = slash === -1 ? path : path.slice(slash + 1);
    const dir = slash === -1 ? "" : path.slice(0, slash + 1);
    const entry = new SummaryTableEntry();
    entry.Dir = dir; entry.Base = base; entry.Size = prettyPrintByteCount(file.Contents.length);
    entry.Bytes = file.Contents.length; entry.IsSourceMap = base.endsWith(".map");
    table.entries.push(entry);
  }
  // yarn 1：不打印耗时（start=nil）
  PrintSummary(color, table, yarnV1 ? null : start);
}

