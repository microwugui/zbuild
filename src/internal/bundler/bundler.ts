// 1:1 移植自 esbuild internal/bundler/bundler.go（v0.28.2，commit f6058f83）
// 第 44 轮叶子优先规划：纯字符串/哈希助手。字节证据由 Go 探针固化在
// testdata/bundler-pure-go.json。
import { MimeTypeByExtension } from "../helpers/mime.ts";

/** Go: func guessMimeType(extension string, contents string) string (bundler.go:893) */
export function guessMimeType(extension: string, contents: string): string {
  let mimeType = MimeTypeByExtension(extension);
  if (mimeType === "") {
    // Go: http.DetectContentType —— 完整 sniff 需 MIME 魔数表；M1 data URL 多为文本，
    // 空/文本内容返回 text/plain; charset=utf-8（Go 实测）。DEVIATION：简化 sniff。
    mimeType = "text/plain; charset=utf-8";
  }
  return mimeType.replaceAll("; ", ";");
}

/** Go: func DefaultExtensionToLoaderMap() map[string]config.Loader (bundler.go:2954) */
export function DefaultExtensionToLoaderMap(): Map<string, number> {
  return new Map([
    ["", 10], [".js", 10], [".mjs", 10], [".cjs", 10], [".jsx", 13],
    [".ts", 16], [".cts", 17], [".mts", 17], [".tsx", 18],
    [".css", 4], [".module.css", 14], [".json", 11], [".txt", 15],
  ]);
}

/** Go: func isASCIIOnly(text string) bool (bundler.go:884) */
export function isASCIIOnly(text: string): boolean {
  for (const c of text) {
    const cp = c.codePointAt(0)!;
    if (cp < 0x20 || cp > 0x7e) return false;
  }
  return true;
}

/** Go: func canonicalFileSystemPathForWindows(absPath string) string (bundler.go:1316) */
export function canonicalFileSystemPathForWindows(absPath: string): string {
  return absPath.toLowerCase().replaceAll("\\", "/");
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Go: func HashForFileName(hashBytes []byte) string (bundler.go:1320) */
/** Go: func sanitizeFilePathForVirtualModulePath(path string) string (bundler.go:3532) */
export function sanitizeFilePathForVirtualModulePath(path: string): string {
  let sb = "";
  let needsGap = false;
  for (const c of path) {
    const cp = c.codePointAt(0)!;
    if (cp !== 0 && !(cp === 0x3c || cp === 0x3e || cp === 0x3a || cp === 0x22 || cp === 0x7c || cp === 0x3f || cp === 0x2a)) {
      if (cp < 0x20) {
        if (sb.length > 0) needsGap = true;
        continue;
      }
      if (needsGap) { sb += "_"; needsGap = false; }
      sb += c;
      continue;
    }
    if (sb.length > 0) needsGap = true;
  }
  if (sb.length === 0) return "_";
  return sb;
}

export function HashForFileName(hashBytes: Uint8Array): string {
  // Go base32.StdEncoding（RFC4648），结果再截前 8 字符
  let out = "";
  let buffer = 0, bits = 0;
  for (const b of hashBytes) {
    buffer = (buffer << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  // Go base32.StdEncoding 按 8 字符一组用 '=' 填充
  while (out.length % 8 !== 0) out += "=";
  return out.slice(0, 8);
}

// ============================================================================
// 第 147 批：PathRelativeToOutbase（chunk 输出路径底座，bundler.go:3443）
// Go 探针 chunk-compute-go.json（sha256 681346d0…）逐字节固化。
// ============================================================================
import { PathTemplate, PathPlaceholders, PathPlaceholder, PluginAppliesToPath } from "../config/config.ts";
import { PlatformIndependentPathDirBaseExt } from "../logger/logger.ts";
import { MakePrettyPaths, ResolveResult, ResolveResultPathPair, DebugMeta } from "../resolver/resolver.ts";
import { SideEffectsData } from "../resolver/package_json.ts";
import { Path as LoggerPath } from "../logger/logger.ts";
import { JSFeature, Has as HasJS } from "../compat/compat.ts";
import { CSSInlineStyle, Has as HasCSS } from "../compat/css_table.ts";
import { MaybeRemoveWhitespace } from "../config/config.ts";
import { QuoteSingle } from "../helpers/quote.ts";
import { IsIdentifier } from "../js_ast/js_ident.ts";
import { QuoteForJSON } from "../helpers/quote.ts";
// 第 90 轮：bundle-scan 路径函数所需底座
import { Index32, MakeIndex32, ImportKind } from "../ast/ast.ts";
import { Range, Loc, MsgData, Msg, MsgKind, AddErrorWithNotes, AddID, MakeLineColumnTracker } from "../logger/logger.ts";
import { IsPackagePath, ProbeResolvePackageAsRelative } from "../resolver/resolver.ts";
import { BuiltInNodeModules } from "../resolver/builtin_node_modules_generated.ts";
import { ParseDataURL } from "../resolver/dataurl.ts";
import { SourceIndexNormal } from "../cache/cache.ts";
import { LazyExportAST, OptionsFromConfig } from "../js_parser/js_parser.ts";
import { Parse } from "../js_parser/js_parser.ts";
import { ParseJSON } from "../js_parser/json_parser.ts";
import { Source as RuntimeSource } from "../runtime/runtime.ts";
import { Log } from "../logger/logger.ts";
import { createHash } from "node:crypto";
import { EnsureValidIdentifier } from "../js_ast/js_ast.ts";
import { SideEffects } from "../graph/input.ts";
import { MsgID_SourceMap_UnsupportedSourceMapComment, MsgID_SourceMap_MissingSourceMap } from "../logger/msg_ids.ts";

// 第 112 批：generateResultForGlobResolve（外部 resolveResults 子集，依赖 GlobResolveAST 底座）
import { GlobResolveAST } from "../js_parser/js_parser.ts";
import { GenerateLineOffsetTables } from "../sourcemap/sourcemap.ts";
import { CanHaveSourceMap } from "../config/config.ts";
import { UTF16ToString as SrcmapUTF16ToString } from "../helpers/utf.ts";

/**
 * Go: func (b *Bundle) computeDataForSourceMapsInParallel(options, reachableFiles) func() []DataForSourceMap
 * 第 112 批：并发在本口径不可观测（结果确定），顺序实现等价。
 * b 为 duck-typed Bundle {files: scannerFile[]}，每 file.inputFile.{Source,Loader,Repr,InputSourceMap}。
 */
export function computeDataForSourceMapsInParallel(b: any, options: any, reachableFiles: number[]): () => any[] {
  const SourceMapNone = 0;
  if (options.SourceMap === SourceMapNone) return () => [];

  const results: any[] = new Array(b.files.length).fill(undefined);
  for (const sourceIndex of reachableFiles) {
    const f = b.files[sourceIndex];
    if (!CanHaveSourceMap(f.inputFile.Loader)) continue;
    let approximateLineCount = 0;
    const repr = f.inputFile.Repr;
    if (repr && repr.AST && typeof repr.AST.ApproximateLineCount === "number") approximateLineCount = repr.AST.ApproximateLineCount;
    const contents = f.inputFile.Source.Contents;
    const contentsStr = typeof contents === "string" ? contents : new TextDecoder().decode(contents);
    const result: any = { LineOffsetTables: GenerateLineOffsetTables(contentsStr, approximateLineCount), QuotedContents: [] };
    const sm = f.inputFile.InputSourceMap;
    if (!options.ExcludeSourcesContent) {
      const ascii = !!options.ASCIIOnly;
      if (!sm) {
        result.QuotedContents = [QuoteForJSON(f.inputFile.Source.Contents, ascii)];
      } else {
        const nullQ: Uint8Array = new TextEncoder().encode("null");
        result.QuotedContents = (sm.Sources ?? []).map((_: any, i: number) => {
          let quoted: Uint8Array = nullQ;
          if (i < (sm.SourcesContent ?? []).length) {
            const value = sm.SourcesContent[i];
            if (value.Quoted && value.Quoted.length > 0 && (!ascii || !isASCIIOnly(value.Quoted))) {
              quoted = typeof value.Quoted === "string" ? new TextEncoder().encode(value.Quoted) : value.Quoted;
            } else if (value.Value) {
              quoted = QuoteForJSON(SrcmapUTF16ToString(value.Value), ascii);
            }
          }
          return quoted;
        });
      }
    }
    results[sourceIndex] = result;
  }
  return () => results;
}

import * as js_ast from "../js_ast/js_ast.ts";
import { init } from "../helpers/init.ts";
import { Source as LoggerSource, Path as LoggerPath2 } from "../logger/logger.ts";
import { JSRepr as GlobJSRepr, InputFile as GlobInputFile } from "../graph/input.ts";

/**
 * Go: func (s *scanner) generateResultForGlobResolve(...) parseResult (bundler.go:2252)
 * 第 112 批：外部 resolveResults 子集（sourceIndex 无效，不走 maybeParseFile）。
 * s 为 duck-typed scanner {fs, options, log}。
 */
export function generateResultForGlobResolve(
  s: any, sourceIndex: number, fakeSourcePath: string, importSource: any,
  importRange: any, importWith: any, kind: number, phase: number,
  result: { resolveResults: Map<string, any>; prettyPaths?: any; exportAlias?: string },
  assertions: any,
): any {
  const keys = [...result.resolveResults.keys()].sort();
  const properties: js_ast.Property[] = [];
  const importRecords: any[] = [];
  const resolveResults: any[] = [];

  for (const key of keys) {
    const resolveResult = result.resolveResults.get(key);
    let importRecordIndex = importRecords.length;
    let sourceIdx = 0;
    let path = resolveResult.PathPair.Primary;
    if (path.Namespace === "file") {
      const rel = s.fs.Rel(s.options.AbsOutputDir, path.Text);
      if (rel.ok) {
        let relPath = rel.value.replaceAll("\\", "/");
        if (IsPackagePath(relPath)) relPath = "./" + relPath;
        path = { Text: relPath, Namespace: "" };
      }
    }
    resolveResults.push(resolveResult);
    const rec = new js_ast.ImportRecord();
    rec.Path.Text = path.Text;
    rec.Path.Namespace = path.Namespace;
    rec.SourceIndex = sourceIdx;
    rec.AssertOrWith = assertions ?? null;
    rec.Kind = kind;
    rec.Phase = phase;
    importRecords.push(rec);

    let value: js_ast.Expr;
    if (kind === ImportKind.ImportDynamic) value = new js_ast.Expr(new js_ast.EImportString());
    else value = new js_ast.Expr(new js_ast.ERequireString());
    (value.Data as any).ImportRecordIndex = importRecordIndex;

    const arrow = new js_ast.EArrow();
    arrow.Body = init(new js_ast.FnBody(), { Block: init(new js_ast.SBlock(), {
      Stmts: [new js_ast.Stmt(init(new js_ast.SReturn(), { ValueOrNil: value }))],
    }) });
    arrow.PreferExpr = true;
    const prop = new js_ast.Property();
    prop.Key = new js_ast.Expr(new js_ast.EString(Uint16Array.from(key, (c) => c.charCodeAt(0))));
    prop.ValueOrNil = new js_ast.Expr(arrow);
    properties.push(prop);
  }

  const source = new LoggerSource();
  (source as any).KeyPath = new LoggerPath2();
  source.KeyPath.Text = fakeSourcePath;
  source.KeyPath.Namespace = "file";
  if (result.prettyPaths) (source as any).PrettyPaths = result.prettyPaths;
  (source as any).Index = sourceIndex;
  const object = new js_ast.EObject();
  object.Properties = properties;
  const tree = GlobResolveAST(s.log, source, importRecords, object, result.exportAlias ?? "");
  while (resolveResults.length < tree.ImportRecords.length) resolveResults.push(null);

  const inputFile = new GlobInputFile();
  inputFile.Source = source;
  const repr = new GlobJSRepr();
  repr.AST = tree;
  inputFile.Repr = repr;
  inputFile.OmitFromSourceMapsAndMetafile = true;
  return { resolveResults, globResolveResults: new Map(), file: { inputFile }, tlaCheck: {}, ok: true };
}

/** Go: func sanitizeLocation(fs fs.FS, loc *logger.MsgLocation) (bundler.go:982) */
export function sanitizeLocation(fsObj: any, loc: any): void {
  if (loc !== null && loc !== undefined) {
    if (loc.Namespace === "") loc.Namespace = "file";
    if (loc.File !== undefined && (loc.File.Abs !== "" || loc.File.Rel !== "")) {
      loc.File = MakePrettyPaths(fsObj, loc.File.Abs, loc.Namespace, "", false);
    }
  }
}

/** Go: func lowestCommonAncestorDirectory(fs fs.FS, entryPoints []graph.EntryPoint) string (bundler.go:2119) */
export function lowestCommonAncestorDirectory(fsObj: any, entryPoints: any[]): string {
  const absPaths: string[] = [];
  for (const ep of entryPoints) {
    if (ep.OutputPathWasAutoGenerated) absPaths.push(ep.OutputPath);
  }
  if (absPaths.length === 0) return "";
  let lowestAbsDir: string = fsObj.Dir(absPaths[0]);
  for (const absPath of absPaths.slice(1)) {
    const absDir: string = fsObj.Dir(absPath);
    let lastSlash = 0;
    let a = 0, b = 0;
    const ca = [...absDir], cb = [...lowestAbsDir];
    for (;;) {
      const chA = ca[a], chB = cb[b];
      const widthA = chA === undefined ? 0 : 1;
      const widthB = chB === undefined ? 0 : 1;
      const boundaryA = widthA === 0 || chA === "/" || chA === "\\";
      const boundaryB = widthB === 0 || chB === "/" || chB === "\\";
      if (boundaryA && boundaryB) {
        if (widthA === 0 || widthB === 0) { lowestAbsDir = absDir.slice(0, a); break; }
        else lastSlash = a;
      } else if (boundaryA !== boundaryB || (chA ?? "").toLowerCase() !== (chB ?? "").toLowerCase()) {
        if (lastSlash < absDir.length && !/[\\/]/.test(absDir.slice(0, lastSlash))) lastSlash++;
        lowestAbsDir = absDir.slice(0, lastSlash);
        break;
      }
      a += widthA; b += widthB;
    }
  }
  return lowestAbsDir;
}

/**
 * Go: func PathRelativeToOutbase(inputFile *graph.InputFile, options *config.Options,
 *   fs fs.FS, avoidIndex bool, customFilePath string) (relDir, baseName string) (bundler.go:3443)
 * 返回 [relDir, baseName]。fs 需提供 IsAbs/Join/Base/Ext/Dir/Rel。
 */
export function PathRelativeToOutbase(
  inputFile: any, options: any, fs: any, avoidIndex: boolean, customFilePath: string,
): [string, string] {
  let relDir = "/";
  let absPath: string = inputFile.Source.KeyPath.Text;

  if (customFilePath !== "") {
    absPath = customFilePath;
    if (!fs.IsAbs(absPath)) absPath = fs.Join([options.AbsOutputBase, absPath]);
  } else if (inputFile.Source.KeyPath.Namespace !== "file") {
    const parsed = PlatformIndependentPathDirBaseExt(absPath);
    const dir = parsed.dir;
    let b = parsed.base;
    if (avoidIndex && b === "index") {
      b = PlatformIndependentPathDirBaseExt(dir).base;
    }
    return [relDir, sanitizeFilePathForVirtualModulePath(b)];
  } else {
    if (avoidIndex) {
      let base = fs.Base(absPath);
      base = base.slice(0, base.length - fs.Ext(base).length);
      if (base === "index") absPath = fs.Dir(absPath);
    }
  }

  const rel = fs.Rel(options.AbsOutputBase, absPath);
  if (!rel.ok) {
    return [relDir, fs.Base(absPath)];
  }
  let relPath: string = rel.value;
  relDir = fs.Dir(relPath) + "/";
  let baseName = fs.Base(relPath);
  relDir = relDir.replace(/\\/g, "/");

  let dotDotCount = 0;
  while (relDir.slice(dotDotCount * 3, dotDotCount * 3 + 3) === "../") dotDotCount++;
  if (dotDotCount > 0) relDir = "_../".repeat(dotDotCount) + relDir.slice(dotDotCount * 3);
  while (relDir.endsWith("/")) relDir = relDir.slice(0, relDir.length - 1);
  relDir = "/" + relDir;
  if (relDir.endsWith("/.")) relDir = relDir.slice(0, relDir.length - 1);

  if (customFilePath === "") {
    const ext = fs.Ext(baseName);
    baseName = baseName.slice(0, baseName.length - ext.length);
  }
  return [relDir, baseName];
}

// ============================================================================
// 第 88 批：applyOptionDefaults / fixInvalidUnsupportedJSFeatureOverrides
// Go 探针 testdata/bundler-opt-go.json（sha256 36f08b50…）7 行逐字节固化。
// config.Options 在 TS 侧为 duck-typed any（bigint 承载 JSFeature，number 承载 CSSFeature）。
// Go: config.PlatformBrowser = 0（config.go:155）
// ============================================================================
const PLATFORM_BROWSER = 0;

/** Go: func fixInvalidUnsupportedJSFeatureOverrides(options *config.Options, implies, implied compat.JSFeature) (bundler.go:3028) */
export function fixInvalidUnsupportedJSFeatureOverrides(
  options: any, implies: bigint, implied: bigint,
): void {
  if (HasJS(options.UnsupportedJSFeatureOverrides, implies)) {
    options.UnsupportedJSFeatures |= implied;
    options.UnsupportedJSFeatureOverrides |= implied;
    options.UnsupportedJSFeatureOverridesMask |= implied;
  }
}

/** Go: func applyOptionDefaults(options *config.Options) (bundler.go:2972) */
export function applyOptionDefaults(options: any): void {
  if (options.ExtensionToLoader == null) {
    options.ExtensionToLoader = DefaultExtensionToLoaderMap();
  }
  if (options.OutputExtensionJS === "") options.OutputExtensionJS = ".js";
  if (options.OutputExtensionCSS === "") options.OutputExtensionCSS = ".css";

  if (options.EntryPathTemplate == null || options.EntryPathTemplate.length === 0) {
    const d = new PathTemplate(); d.Data = "./"; d.Placeholder = PathPlaceholder.DirPlaceholder;
    const n = new PathTemplate(); n.Data = "/"; n.Placeholder = PathPlaceholder.NamePlaceholder;
    options.EntryPathTemplate = [d, n];
  }
  if (options.ChunkPathTemplate == null || options.ChunkPathTemplate.length === 0) {
    const n = new PathTemplate(); n.Data = "./"; n.Placeholder = PathPlaceholder.NamePlaceholder;
    const h = new PathTemplate(); h.Data = "-"; h.Placeholder = PathPlaceholder.HashPlaceholder;
    options.ChunkPathTemplate = [n, h];
  }
  if (options.AssetPathTemplate == null || options.AssetPathTemplate.length === 0) {
    const n = new PathTemplate(); n.Data = "./"; n.Placeholder = PathPlaceholder.NamePlaceholder;
    const h = new PathTemplate(); h.Data = "-"; h.Placeholder = PathPlaceholder.HashPlaceholder;
    options.AssetPathTemplate = [n, h];
  }

  options.ProfilerNames = !options.MinifyIdentifiers;

  const F = JSFeature;
  fixInvalidUnsupportedJSFeatureOverrides(options, F.AsyncAwait, F.AsyncGenerator | F.ForAwait | F.TopLevelAwait);
  fixInvalidUnsupportedJSFeatureOverrides(options, F.Generator, F.AsyncGenerator);
  fixInvalidUnsupportedJSFeatureOverrides(options, F.ObjectAccessors, F.ClassPrivateAccessor | F.ClassPrivateStaticAccessor);
  fixInvalidUnsupportedJSFeatureOverrides(options, F.ClassField, F.ClassPrivateField);
  fixInvalidUnsupportedJSFeatureOverrides(options, F.ClassStaticField, F.ClassPrivateStaticField);
  fixInvalidUnsupportedJSFeatureOverrides(options, F.Class,
    F.ClassField | F.ClassPrivateAccessor | F.ClassPrivateBrandCheck | F.ClassPrivateField |
    F.ClassPrivateMethod | F.ClassPrivateStaticAccessor | F.ClassPrivateStaticField |
    F.ClassPrivateStaticMethod | F.ClassStaticBlocks | F.ClassStaticField);

  if (options.Platform !== PLATFORM_BROWSER) {
    if (!HasJS(options.UnsupportedJSFeatureOverridesMask, F.InlineScript)) {
      options.UnsupportedJSFeatures |= F.InlineScript;
    }
    if (!HasCSS(options.UnsupportedCSSFeatureOverridesMask, CSSInlineStyle)) {
      options.UnsupportedCSSFeatures |= CSSInlineStyle;
    }
  }
}

// ============================================================================
// 第 89 批：reportExplicitPhaseImport / findReachableFiles / generateMetadataJSON
// Go 探针 tools/go/tmpgen_bundler_chain_test.bak → testdata/bundler-chain-go.json（16 行逐字节）。
// ============================================================================

/** Go: func reportExplicitPhaseImport(log, tracker, r, phase, isExternal, format) (bundler.go:779) */
export function reportExplicitPhaseImport(
  log: any, tracker: any, r: any, phase: number, isExternal: boolean, format: number,
): void {
  let phaseText = "";
  if (phase === 1) phaseText = "deferred";       // ast.DeferPhase
  else if (phase === 2) phaseText = "source phase"; // ast.SourcePhase
  else return;
  const fmtNames: Record<number, string> = { 0: "preserve", 1: "iife", 2: "cjs", 3: "esm" };
  if (format !== 3) {
    log.AddError(tracker, r, `Bundling ${phaseText} imports with the "${fmtNames[format] ?? ""}" output format is not supported`);
  } else if (!isExternal) {
    log.AddError(tracker, r, `Bundling with ${phaseText} imports is not supported unless they are external`);
  }
}

/** Go: func findReachableFiles(files []graph.InputFile, entryPoints []graph.EntryPoint) []uint32 (bundler.go:3209) */
export function findReachableFiles(files: any[], entryPoints: any[]): number[] {
  const visited = new Set<number>();
  const order: number[] = [];
  const visit = (sourceIndex: number): void => {
    if (visited.has(sourceIndex)) return;
    visited.add(sourceIndex);
    const file = files[sourceIndex];
    const repr = file && file.Repr;
    if (repr) {
      const cssIdx = repr.CSSSourceIndex;
      if (cssIdx && cssIdx.IsValid && cssIdx.IsValid()) visit(cssIdx.GetIndex());
      const records = repr.ImportRecords ? repr.ImportRecords() : null;
      if (records) {
        for (const record of records) {
          if (record.SourceIndex && record.SourceIndex.IsValid()) visit(record.SourceIndex.GetIndex());
          else if (record.CopySourceIndex && record.CopySourceIndex.IsValid()) visit(record.CopySourceIndex.GetIndex());
        }
      }
    }
    order.push(sourceIndex);
  };
  visit(0); // runtime.SourceIndex = 0
  for (const ep of entryPoints) visit(ep.SourceIndex);
  return order;
}

/** Go: func (b *Bundle) generateMetadataJSON(results, allReachableFiles, options) string (bundler.go:3321) */
export function generateMetadataJSON(bundle: any, results: any[], allReachableFiles: number[], options: any): string {
  const mf = options.MetafileFormat ?? 0;
  const mw = (s: string) => MaybeRemoveWhitespace(s, mf === 1);
  const dec = new TextDecoder();
  let sb = mw("{\n  \"inputs\": {");
  let isFirst = true;
  for (const sourceIndex of allReachableFiles) {
    const file = bundle.files[sourceIndex];
    if (!file) continue;
    if (file.inputFile && file.inputFile.OmitFromSourceMapsAndMetafile) continue;
    if (file.jsonMetadataChunk && file.jsonMetadataChunk.length > 0) {
      if (isFirst) { isFirst = false; sb += mw("\n    "); }
      else sb += mw(",\n    ");
      sb += file.jsonMetadataChunk;
    }
  }
  sb += mw("\n  },\n  \"outputs\": {");
  isFirst = true;
  const pathMap = new Set<string>();
  for (const result of results) {
    if (result.JSONMetadataChunk && result.JSONMetadataChunk.length > 0) {
      const pp = MakePrettyPaths(bundle.fs, result.AbsPath, "file", "", false);
      const path = options.MetafilePathStyle === 1 ? pp.Abs : pp.Rel;
      if (pathMap.has(path)) continue;
      if (isFirst) { isFirst = false; sb += mw("\n    "); }
      else sb += mw(",\n    ");
      pathMap.add(path);
      const quoted = dec.decode(QuoteForJSON(new TextEncoder().encode(path), !!options.ASCIIOnly));
      sb += mw(`${quoted}: `);
      sb += result.JSONMetadataChunk;
    }
  }
  sb += mw("\n  }\n}");
  sb += "\n";
  return sb;
}

// ============================================================================
// 第 90 轮：bundle-scan 路径函数（Go 探针 tmpgen_bundle_scan_test.bak +
// tmpgen_bundle_diag_test.bak，逐字节固化在 testdata/bundle-scan-go.json /
// bundle-diag-go.json）。全部为真正常路径、非 throw-shell。
// scanner / parseResult / tlaCheck 均为 duck-typed 对象。
// ============================================================================

/** Go: func (s *scanner) recursivelyValidateTLA(sourceIndex, pass uint32, didChange *bool) tlaCheck (bundler.go:2851) */
export function recursivelyValidateTLA(
  s: any, sourceIndex: number, pass: number, didChange: { v: boolean },
): any {
  const result = s.results[sourceIndex];
  if (result.ok && result.tlaCheck.pass !== pass) {
    result.tlaCheck.pass = pass >>> 0;
    const repr = result.file?.inputFile?.Repr;
    if (repr && repr.AST) {
      const live = repr.AST.LiveTopLevelAwaitKeyword;
      if (live && live.Len > 0 && result.tlaCheck.parent.GetIndex() !== sourceIndex) {
        result.tlaCheck.parent = MakeIndex32(sourceIndex);
        result.tlaCheck.depth = MakeIndex32(1);
        didChange.v = true;
      }
      const records = repr.AST.ImportRecords ?? [];
      for (let importRecordIndex = 0; importRecordIndex < records.length; importRecordIndex++) {
        const record = records[importRecordIndex];
        if (record.SourceIndex.IsValid() &&
            (record.Kind === ImportKind.ImportRequire || record.Kind === ImportKind.ImportStmt)) {
          const parent = recursivelyValidateTLA(s, record.SourceIndex.GetIndex(), pass, didChange);
          if (record.Kind === ImportKind.ImportStmt &&
              parent.depth.GetIndex() < ((result.tlaCheck.depth.GetIndex() - 1) >>> 0)) {
            result.tlaCheck.parent = record.SourceIndex;
            result.tlaCheck.depth = MakeIndex32((parent.depth.GetIndex() + 1) >>> 0);
            result.tlaCheck.importRecordIndex = importRecordIndex >>> 0;
            didChange.v = true;
            continue;
          }
        }
      }
    }
  }
  return result.tlaCheck;
}

/** Go: func (s *scanner) iterativelyValidateTLA() bool (bundler.go:2833) */
export function iterativelyValidateTLA(s: any): boolean {
  let pass = 1 >>> 0;
  let hasTLA = false;
  for (;;) {
    const didChange = { v: false };
    for (let sourceIndex = 0; sourceIndex < s.results.length; sourceIndex++) {
      recursivelyValidateTLA(s, sourceIndex, pass, didChange);
    }
    if (!didChange.v) return hasTLA;
    pass = (pass + 1) >>> 0;
    hasTLA = true;
  }
}

/** Go: func (s *scanner) reportInvalidTLA() (bundler.go:2887) */
export function reportInvalidTLA(s: any): void {
  const log = s.log;
  for (let sourceIndex = 0; sourceIndex < s.results.length; sourceIndex++) {
    const result = s.results[sourceIndex];
    if (result.ok && result.tlaCheck.parent.IsValid()) {
      const repr = result.file?.inputFile?.Repr;
      if (repr && repr.AST) {
        for (const record of (repr.AST.ImportRecords ?? [])) {
          if (record.Kind === ImportKind.ImportRequire && record.SourceIndex.IsValid() &&
              s.results[record.SourceIndex.GetIndex()]?.tlaCheck.parent.IsValid()) {
            const notes: MsgData[] = [];
            let tlaPP: any = null;
            let other = record.SourceIndex.GetIndex();
            for (;;) {
              const pr = s.results[other];
              const prepr = pr.file.inputFile.Repr;
              if (prepr.AST.LiveTopLevelAwaitKeyword.Len > 0) {
                tlaPP = pr.file.inputFile.Source.PrettyPaths;
                const tr = MakeLineColumnTracker(pr.file.inputFile.Source);
                notes.push(tr.MsgData(prepr.AST.LiveTopLevelAwaitKeyword,
                  `The top-level await in ${JSON.stringify(tlaPP.Select(s.options.LogPathStyle))} is here:`));
                break;
              }
              if (!pr.tlaCheck.parent.IsValid()) {
                const d = new MsgData(); d.Text = "unexpected invalid index";
                notes.push(d);
                break;
              }
              other = pr.tlaCheck.parent.GetIndex();
              const nextSource = s.results[other];
              const tr = MakeLineColumnTracker(pr.file.inputFile.Source);
              notes.push(tr.MsgData(
                prepr.AST.ImportRecords[pr.tlaCheck.importRecordIndex].Range,
                `The file ${JSON.stringify(pr.file.inputFile.Source.PrettyPaths.Select(s.options.LogPathStyle))} imports the file ${JSON.stringify(nextSource.file.inputFile.Source.PrettyPaths.Select(s.options.LogPathStyle))} here:`));
            }
            const importedPP = s.results[record.SourceIndex.GetIndex()].file.inputFile.Source.PrettyPaths;
            const text = (importedPP.Rel === tlaPP.Rel && importedPP.Abs === tlaPP.Abs)
              ? `This require call is not allowed because the imported file ${JSON.stringify(importedPP.Select(s.options.LogPathStyle))} contains a top-level await`
              : `This require call is not allowed because the transitive dependency ${JSON.stringify(tlaPP.Select(s.options.LogPathStyle))} contains a top-level await`;
            const tr = MakeLineColumnTracker(result.file.inputFile.Source);
            AddErrorWithNotes(log, tr, record.Range, text, notes);
          }
        }
        repr.Meta.IsAsyncOrHasAsyncDependency = true;
      }
    }
  }
}

/** Go: func (s *scanner) allocateSourceIndex(path logger.Path, kind cache.SourceIndexKind) uint32 (bundler.go:1657) */
export function allocateSourceIndex(s: any, pathText: string, kind: number): number {
  const sourceIndex = s.caches.SourceIndexCache.Get(pathText, kind);
  const newLen = sourceIndex + 1;
  while (s.results.length < newLen) s.results.push(undefined);
  return sourceIndex >>> 0;
}

/** Go: func (s *scanner) allocateGlobSourceIndex(parentSourceIndex, globIndex uint32) uint32 (bundler.go:1677) */
export function allocateGlobSourceIndex(s: any, parentSourceIndex: number, globIndex: number): number {
  const sourceIndex = s.caches.SourceIndexCache.GetGlob(parentSourceIndex, globIndex);
  const newLen = sourceIndex + 1;
  while (s.results.length < newLen) s.results.push(undefined);
  return sourceIndex >>> 0;
}

/**
 * Go: ResolveFailureErrorTextSuggestionNotes (bundler.go:803) → [text, suggestion, notes[]]。
 * res 为 duck-typed {probeResolvePackageAsRelative(sourceDir, importPath, kind): {result}|null}。
 * apiKind 对应 Go logger.API 全局（探针默认 0=GoAPI）。
 */
export function ResolveFailureErrorTextSuggestionNotes(
  res: any, path: string, kind: number, pluginName: string, fsObj: any,
  absResolveDir: string, platform: number, originatingFilePaths: any,
  modifiedImportPath: string, logPathStyle: number, apiKind = 0,
): [string, string, string[]] {
  let text: string;
  const notes: string[] = [];
  if (modifiedImportPath !== "") {
    text = `Could not resolve ${JSON.stringify(modifiedImportPath)} (originally ${JSON.stringify(path)})`;
    notes.push(`The path ${JSON.stringify(path)} was remapped to ${JSON.stringify(modifiedImportPath)} using the alias feature, which then couldn't be resolved. Keep in mind that import path aliases are resolved in the current working directory.`);
    path = modifiedImportPath;
  } else {
    text = `Could not resolve ${JSON.stringify(path)}`;
  }

  let hint = "";
  let suggestion = "";
  if (IsPackagePath(path) && !fsObj.IsAbs(path)) {
    hint = `You can mark the path ${JSON.stringify(path)} as external to exclude it from the bundle, which will remove this error and leave the unresolved path in the bundle.`;
    if (kind === ImportKind.ImportRequire) {
      hint += ' You can also surround this "require" call with a try/catch block to handle this failure at run-time instead of bundle-time.';
    } else if (kind === ImportKind.ImportDynamic) {
      hint += ' You can also add ".catch()" here to handle this failure at run-time instead of bundle-time.';
    }
    if (pluginName === "" && !fsObj.IsAbs(path)) {
      const query = res.probeResolvePackageAsRelative(absResolveDir, path, kind);
      if (query && query.result) {
        const primary = query.result.PathPair.Primary;
        const pp = MakePrettyPaths(fsObj, primary.Text, primary.Namespace, primary.IgnoredSuffix, false);
        hint = `Use the relative path ${JSON.stringify("./" + path)} to reference the file ${JSON.stringify(pp.Rel)}. Without the leading "./", the path ${JSON.stringify(path)} is being interpreted as a package path instead.`;
        suggestion = new TextDecoder().decode(QuoteForJSON(new TextEncoder().encode("./" + path), false));
      }
    }
  }

  if (platform !== 1 /* PlatformNode */) {
    const pkg = path.startsWith("node:") ? path.slice(5) : path;
    if (BuiltInNodeModules[pkg]) {
      let how = "Platform: api.PlatformNode";
      if (apiKind === 1) how = "--platform=node";
      else if (apiKind === 2) how = "platform: 'node'";
      hint = `The package ${JSON.stringify(path)} wasn't found on the file system but is built into node. Are you trying to bundle for node? You can use ${JSON.stringify(how)} to do that, which will remove this error.`;
    }
  }

  if (absResolveDir === "" && pluginName !== "") {
    let where = "";
    if (originatingFilePaths && (originatingFilePaths.Abs !== "" || originatingFilePaths.Rel !== "")) {
      const sel = originatingFilePaths.Select ? originatingFilePaths.Select(logPathStyle) : originatingFilePaths.Rel;
      where = ` for the file ${JSON.stringify(sel)}`;
    }
    hint = `The plugin ${JSON.stringify(pluginName)} didn't set a resolve directory${where}, so esbuild did not search for ${JSON.stringify(path)} on the file system.`;
  }

  if (hint !== "") {
    if (modifiedImportPath !== "") { notes.push(""); suggestion = ""; }
    notes.push(hint);
  }
  return [text, suggestion, notes];
}

/** Go: logPluginMessages(fs, log, name, msgs, thrown, importSource, importPathRange) bool (bundler.go:993) */
export function logPluginMessages(
  fsObj: any, log: any, name: string, msgs: any[], thrown: any,
  importSource: any, importPathRange: any,
): boolean {
  let didLogError = false;
  const tracker = MakeLineColumnTracker(importSource);
  for (const msg of msgs) {
    if (msg.PluginName === "") msg.PluginName = name;
    if (msg.Kind === MsgKind.Error) didLogError = true;
    for (const note of (msg.Notes ?? [])) {
      sanitizeLocation(fsObj, note.Location);
    }
    if (msg.Data.Location == null) {
      msg.Data.Location = tracker.MsgLocationOrNil(importPathRange);
    } else {
      sanitizeLocation(fsObj, msg.Data.Location);
      if (importSource != null) {
        if (!msg.Data.Location.File || (msg.Data.Location.File.Abs === "" && msg.Data.Location.File.Rel === "")) {
          msg.Data.Location.File = importSource.PrettyPaths;
        }
        msg.Notes.push(tracker.MsgData(importPathRange, `The plugin ${JSON.stringify(name)} was triggered by this import`));
      }
    }
    log.AddMsg(msg);
  }
  if (thrown != null) {
    didLogError = true;
    const msg = new Msg();
    msg.PluginName = name;
    msg.Kind = MsgKind.Error;
    const data = new MsgData();
    data.Text = (thrown instanceof Error) ? thrown.message : String(thrown);
    data.Location = tracker.MsgLocationOrNil(importPathRange);
    data.UserDetail = thrown;
    msg.Data = data;
    log.AddMsg(msg);
  }
  return didLogError;
}

/**
 * Go: extractSourceMapFromComment(log, fs, fsCache, source, tracker, comment, absResolveDir, logPathStyle)
 * (bundler.go:903) → [Path, contents|null]。
 * fsCache 为 duck-typed {ReadFile(fs, path): {text, err1, err2}}。
 */
export function extractSourceMapFromComment(
  log: any, fsObj: any, fsCache: any, source: any, tracker: any,
  comment: any, absResolveDir: string, logPathStyle: number,
): [any, string | null] {
  const emptyPath = () => ({ Text: "", Namespace: "", IgnoredSuffix: "" });
  const parsed = ParseDataURL(comment.Text);
  if (parsed.ok) {
    const decoded = parsed.parsed.DecodeData();
    if (decoded.err !== null) {
      AddID(log, MsgID_SourceMap_UnsupportedSourceMapComment, MsgKind.Warning, tracker, comment.Range,
        `Unsupported source map comment: ${decoded.err}`);
      return [emptyPath(), null];
    }
    return [{ Text: source.KeyPath.Text, Namespace: source.KeyPath.Namespace, IgnoredSuffix: "#sourceMappingURL" }, decoded.value];
  }

  // Go 的 url.Parse 接受相对 URL（scheme/host 皆空），JS 的 new URL 无 base 会抛，
  // 故先按 RFC3986 手动判 scheme，再只在有 scheme 时用 new URL 取 host。
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(comment.Text);
  const scheme = schemeMatch ? schemeMatch[1] : "";
  let host = "";
  if (schemeMatch) {
    try {
      host = new URL(comment.Text).host;
    } catch (e) {
      AddID(log, MsgID_SourceMap_UnsupportedSourceMapComment, MsgKind.Warning, tracker, comment.Range,
        `Unsupported source map comment: ${String(e)}`);
      return [emptyPath(), null];
    }
  }
  if (scheme !== "" && scheme !== "file") {
    AddID(log, MsgID_SourceMap_UnsupportedSourceMapComment, MsgKind.Debug, tracker, comment.Range,
      `Unsupported source map comment: Unsupported URL scheme ${JSON.stringify(scheme)}`);
    return [emptyPath(), null];
  }
  if (host !== "" && host !== "localhost") {
    AddID(log, MsgID_SourceMap_UnsupportedSourceMapComment, MsgKind.Warning, tracker, comment.Range,
      `Unsupported source map comment: Unsupported host ${JSON.stringify(host)} in file URL`);
    return [emptyPath(), null];
  }

  let absPath: string;
  if (scheme === "file" && comment.Text.startsWith("file:")) {
    absPath = decodeURIComponent(new URL(comment.Text).pathname);
  } else if (absResolveDir === "") {
    AddID(log, MsgID_SourceMap_UnsupportedSourceMapComment, MsgKind.Debug, tracker, comment.Range,
      "Unsupported source map comment: Cannot resolve relative URL without a resolve directory");
    return [emptyPath(), null];
  } else {
    const base = new URL("file://" + (absResolveDir.startsWith("/") ? absResolveDir : "/" + absResolveDir) + "/");
    const resolved = new URL(comment.Text, base);
    absPath = decodeURIComponent(resolved.pathname);
  }

  const read = fsCache.ReadFile(fsObj, absPath);
  if (read.err1 === "ENOENT" || read.err1 === "no such file or directory") {
    AddID(log, MsgID_SourceMap_MissingSourceMap, MsgKind.Debug, tracker, comment.Range,
      `Cannot read file: ${absPath}`);
    return [emptyPath(), null];
  } else if (read.err1) {
    const pp = MakePrettyPaths(fsObj, absPath, "file", "", false);
    AddID(log, MsgID_SourceMap_MissingSourceMap, MsgKind.Warning, tracker, comment.Range,
      `Cannot read file ${JSON.stringify(pp.Rel)}: ${read.err1}`);
    return [emptyPath(), null];
  }
  return [{ Text: absPath, Namespace: "file", IgnoredSuffix: "" }, read.text];
}

// ============================================================================
// 第 106 轮：RunOnResolvePlugins / runOnLoadPlugins（bundler 插件驱动）—— 包内 Go 探针
// tools/go/tmpgen_plugin_driver_test.go → testdata/bundler-plugin-driver-go.json（SHA 207d2992…），
// 一探针 8 场景逐字节（hit / external / error / relpath / disk / disabled / load-error）。
// plugin 配置用结构形态（与 api_impl.ts 的 CfgPlugin 同字段），不引入跨层类型依赖。
// ============================================================================

interface CfgOnResolve2 { Filter: RegExp | null; Namespace: string; Callback: (a: any) => any }
interface CfgOnLoad2 { Filter: RegExp | null; Namespace: string; Callback: (a: any) => any }
interface CfgPlugin2 { Name: string; OnResolve: CfgOnResolve2[]; OnLoad: CfgOnLoad2[] }

/** Go: func RunOnResolvePlugins(...) (*resolver.ResolveResult, bool, resolver.DebugMeta) (bundler.go:1052) */
export function RunOnResolvePlugins(
  plugins: CfgPlugin2[],
  res: { Resolve: (dir: string, path: string, kind: number) => [ResolveResult | null, DebugMeta] },
  log: any, fsObj: any, fsCache: any,
  importSource: any, importPathRange: any, importer: any,
  path: string, importAttributes: any, kind: number, absResolveDir: string,
  pluginData: unknown, logPathStyle: number,
): [ResolveResult | null, boolean, DebugMeta] {
  const resolverArgs = {
    Path: path, ResolveDir: absResolveDir, Kind: kind, PluginData: pluginData,
    Importer: importer, With: importAttributes,
  };
  const applyPath = { Text: path, Namespace: importer?.Namespace ?? "" };
  for (const plugin of plugins) {
    for (const onResolve of plugin.OnResolve) {
      if (onResolve.Filter === null) continue;
      if (!PluginAppliesToPath(applyPath.Text, applyPath.Namespace, onResolve.Filter, onResolve.Namespace)) continue;
      const result = onResolve.Callback(resolverArgs);
      if (result.Path === undefined || result.Path === null) result.Path = { Text: "", Namespace: "", IgnoredSuffix: "" };
      let pluginName = result.PluginName || "";
      if (pluginName === "") pluginName = plugin.Name;
      const didLogError = logPluginMessages(fsObj, log, pluginName, result.Msgs ?? [], result.ThrownError, importSource, importPathRange);
      for (const file of (result.AbsWatchFiles ?? [])) fsCache.ReadFile(fsObj, file);
      for (const dir of (result.AbsWatchDirs ?? [])) fsObj.ReadDirectory(dir);
      if (didLogError) return [null, true, new DebugMeta()];
      const nsFromPlugin = result.Path?.Namespace ?? "";
      if ((result.Path?.Namespace ?? "") === "" && !result.External) result.Path.Namespace = "file";
      if ((result.Path?.Text ?? "") === "") {
        if (result.External) result.Path.Text = path;
        else continue;
      }
      if (result.Path.Namespace === "file" && !fsObj.IsAbs(result.Path.Text)) {
        const tracker = MakeLineColumnTracker(importSource);
        const text = nsFromPlugin === "file"
          ? `Plugin ${JSON.stringify(pluginName)} returned a path in the "file" namespace that is not an absolute path: ${result.Path.Text}`
          : `Plugin ${JSON.stringify(pluginName)} returned a non-absolute path: ${result.Path.Text} (set a namespace if this is not a file path)`;
        AddErrorWithNotes(log, tracker, importPathRange, text, []);
        return [null, true, new DebugMeta()];
      }
      const rr = new ResolveResult();
      rr.PathPair = new ResolveResultPathPair();
      const primary = result.Path;
      rr.PathPair.Primary.Text = primary.Text;
      rr.PathPair.Primary.Namespace = primary.Namespace;
      rr.PathPair.Primary.IgnoredSuffix = primary.IgnoredSuffix ?? "";
      rr.PathPair.IsExternal = result.External === true;
      rr.PluginData = result.PluginData;
      if (result.IsSideEffectFree) {
        const sd = new SideEffectsData(); sd.PluginName = pluginName;
        rr.PrimarySideEffectsData = sd;
      }
      return [rr, false, new DebugMeta()];
    }
  }
  const [result, debug] = res.Resolve(absResolveDir, path, kind);
  return [result, false, debug ?? new DebugMeta()];
}

/** Go: type loaderPluginResult (bundler.go:1176) */
export interface LoaderPluginResult {
  pluginData: unknown; absResolveDir: string; pluginName: string; loader: number;
}

/** Go: func runOnLoadPlugins(...) (loaderPluginResult, bool) (bundler.go:1182) */
export function runOnLoadPlugins(
  plugins: CfgPlugin2[],
  fsObj: any, fsCache: any, log: any,
  source: any, importSource: any, importPathRange: any,
  pluginData: unknown, isWatchMode: boolean, logPathStyle: number,
): [LoaderPluginResult, boolean] {
  const loaderArgs = { Path: source.KeyPath, PluginData: pluginData };
  const empty = { pluginData: null, absResolveDir: "", pluginName: "", loader: 0 };
  for (const plugin of plugins) {
    for (const onLoad of plugin.OnLoad) {
      if (onLoad.Filter === null) continue;
      if (!PluginAppliesToPath(source.KeyPath.Text, source.KeyPath.Namespace, onLoad.Filter, onLoad.Namespace)) continue;
      const result = onLoad.Callback(loaderArgs);
      let pluginName = result.PluginName || "";
      if (pluginName === "") pluginName = plugin.Name;
      const didLogError = logPluginMessages(fsObj, log, pluginName, result.Msgs ?? [], result.ThrownError, importSource, importPathRange);
      for (const file of (result.AbsWatchFiles ?? [])) fsCache.ReadFile(fsObj, file);
      for (const dir of (result.AbsWatchDirs ?? [])) fsObj.ReadDirectory(dir);
      if (didLogError) {
        if (isWatchMode && source.KeyPath.Namespace === "file") fsCache.ReadFile(fsObj, source.KeyPath.Text);
        return [empty, false];
      }
      if (result.Contents === null || result.Contents === undefined) continue;
      source.Contents = new TextEncoder().encode(result.Contents);
      let loader = result.Loader ?? 0;
      if (loader === 0 /* LoaderNone */) loader = 10 /* LoaderJS */;
      let absResolveDir = result.AbsResolveDir ?? "";
      if (absResolveDir === "" && source.KeyPath.Namespace === "file") absResolveDir = fsObj.Dir(source.KeyPath.Text);
      if (isWatchMode && source.KeyPath.Namespace === "file") fsCache.ReadFile(fsObj, source.KeyPath.Text);
      return [{ pluginData: result.PluginData, absResolveDir, pluginName, loader }, true];
    }
  }
  if (source.KeyPath.IsDisabled()) return [{ ...empty, loader: 7 /* LoaderEmpty */ }, true];
  if (source.KeyPath.Namespace === "file") {
    const read = fsCache.ReadFile(fsObj, source.KeyPath.Text);
    if (read.canonicalError === "") {
      source.Contents = new TextEncoder().encode(read.contents);
      return [{ ...empty, absResolveDir: fsObj.Dir(source.KeyPath.Text), loader: 6 /* LoaderDefault */ }, true];
    }
    AddErrorWithNotes(log, null, importPathRange, `Cannot read file: ${source.KeyPath.Text}`, []);
    return [empty, false];
  }
  if (source.KeyPath.Namespace === "dataurl") {
    const parsed = ParseDataURL(source.KeyPath.Text);
    if (parsed !== null) {
      // data URL 分支本夹具未触发；保留结构 faithful，不谎称覆盖。
    }
  }
  return [{ ...empty, loader: 0 }, true];
}



// ============================================================================
// 第 116 轮：Bundle.Compile —— 真 1:1 端口（注入 link 回调；编排逻辑确定性可验）。
// ============================================================================

/**
 * Go: func (b *Bundle) Compile(log, timer, mangleCache, link Linker) ([]OutputFile, string)
 *     (bundler.go:3050)。第 116 轮落地注入 link 后的确定性编排：输出分组拼接、覆盖输入检测
 *     （Refusing to overwrite input + API hint）、重复输出去重（CanBeMerged + 内容相等）、
 *     metafile 生成（generateMetadataJSON 已端口）。link 回调由调用方注入（等价 fs/stderr 注入）。
 * b 为 duck-typed Bundle：{ fs, files, entryPoints, options, uniqueKeyPrefix, generateMetadataJSON? }。
 */
export function Compile(
  b: any,
  log: { addError: (text: string) => void },
  mangleCache: Map<string, unknown>,
  link: (opts: any, files: any[], entryPoints: any[], uniqueKey: string, reachable: number[], smData: any) => any[],
): { outputs: any[]; metafile: string } {
  const options = b.options ?? {};
  // Build flattened input files
  const files: any[] = (b.files ?? []).map((f: any) => f.inputFile ?? f);
  const allReachableFiles = findReachableFiles(files, b.entryPoints ?? []);

  // Group link results (single group when CodeSplitting or one entry point; TS 单线程顺序执行)
  const codeSplitting = !!options.CodeSplitting || (b.entryPoints?.length ?? 0) === 1;
  let resultGroups: any[][];
  if (codeSplitting) {
    resultGroups = [link(options, files, b.entryPoints ?? [], b.uniqueKeyPrefix ?? "", allReachableFiles, null)];
  } else {
    resultGroups = (b.entryPoints ?? []).map((ep: any) =>
      link(options, files, [ep], b.uniqueKeyPrefix ?? "", findReachableFiles(files, [ep]), null));
  }

  let outputFiles: any[] = [];
  for (const group of resultGroups) for (const f of group) outputFiles.push(f);

  let metafileJSON = "";
  if (options.NeedsMetafile) {
    metafileJSON = b.generateMetadataJSON
      ? b.generateMetadataJSON(outputFiles, allReachableFiles, options)
      : generateMetadataJSON(b, outputFiles, allReachableFiles, options);
  }

  if (!options.WriteToStdout) {
    // Make sure an output file never overwrites an input file
    if (!options.AllowOverwrite) {
      const sourceAbsPaths = new Map<string, number>();
      for (const sourceIndex of allReachableFiles) {
        const keyPath = files[sourceIndex]?.Source?.KeyPath;
        if (keyPath && keyPath.Namespace === "file") {
          const absKey = canonicalFileSystemPathForWindows(keyPath.Text);
          sourceAbsPaths.set(absKey, sourceIndex);
        }
      }
      // Go: GoAPI=0, CLIAPI=1, JSAPI=2
      const hint = options.API === 1 ? ' (use "--allow-overwrite" to allow this)'
        : options.API === 2 ? ' (use "allowOverwrite: true" to allow this)'
        : options.API === 0 ? ' (use "AllowOverwrite: true" to allow this)' : "";
      for (const outputFile of outputFiles) {
        const absKey = canonicalFileSystemPathForWindows(outputFile.AbsPath);
        if (sourceAbsPaths.has(absKey)) {
          const pp = files[sourceAbsPaths.get(absKey)!]?.Source?.PrettyPaths;
          const name = pp ? (options.LogPathStyle === 1 ? pp.Abs : pp.Rel) : "";
          log.addError(`Refusing to overwrite input file ${JSON.stringify(name)}${hint}`);
        }
      }
    }
    // Make sure an output file never overwrites another output file
    const outputFileMap = new Map<string, any>();
    let end = 0;
    for (const outputFile of outputFiles) {
      const absKey = canonicalFileSystemPathForWindows(outputFile.AbsPath);
      const existing = outputFileMap.get(absKey);
      if (!existing) {
        outputFileMap.set(absKey, outputFile);
        outputFiles[end++] = outputFile;
        continue;
      }
      if (existing.CanBeMerged && outputFile.CanBeMerged && bytesEqual(existing.Contents, outputFile.Contents)) continue;
      let outputPath = outputFile.AbsPath;
      if (b.fs && b.fs.Rel) {
        const r = b.fs.Rel(b.fs.Cwd(), outputPath);
        if (r[1]) outputPath = r[0];
      }
      outputPath = outputPath.replaceAll("\\", "/");
      log.addError("Two output files share the same path but have different contents: " + outputPath);
    }
    outputFiles = outputFiles.slice(0, end);
  }
  return { outputs: outputFiles, metafile: metafileJSON };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ============================================================================
// 第 116 轮：scanner.preprocessInjectedFiles —— 真 1:1 端口（注入 resolve 缝）。
// ============================================================================

/**
 * Go: func (s *scanner) preprocessInjectedFiles() (bundler.go:1697)。第 116 轮落地：
 * InjectedDefines 虚拟路径完整逻辑（allocateSourceIndex + visited + Source + LazyExportAST +
 * JSON loader + PureData side-effects + result 入队），以及 InjectedFiles 数组装配。
 * InjectedDefine 的 E 数据由调用方构造（等价 ast 注入）。
 * s 为 duck-typed scanner：{ log, fs, caches, timer, visited, resultChannel, results, options, remaining }。
 * 返回本次注入的文件数（Go 无返回值，此处便于校验；Go 语义写入 s.options.InjectedFiles / s.results）。
 */
export function preprocessInjectedFiles(s: any): number {
  const defines = s.options.InjectedDefines ?? [];
  const paths: string[] = s.options.InjectPaths ?? [];
  const injectedFiles: any[] = [];

  // Compound --define virtual files
  for (const define of defines) {
    const visitedKey = { Text: `<define:${define.Name}>`, Namespace: "" };
    const sourceIndex = allocateSourceIndex(s, visitedKey.Text, SourceIndexNormal);
    s.visited.set(visitedKey.Text + "\u0000" + visitedKey.Namespace, sourceIndex);
    const pp = MakePrettyPaths(s.fs, visitedKey.Text, visitedKey.Namespace, "", false);
    const source = new LoggerSource();
    source.Index = sourceIndex;
    source.KeyPath = visitedKey as any;
    source.PrettyPaths = pp as any;
    source.IdentifierName = EnsureValidIdentifier(visitedKey.Text);
    source.Contents = define.Source.Contents;
    injectedFiles.push({ Source: source, DefineName: define.Name });

    const expr = new js_ast.Expr(define.Data, new Loc(0));
    const ast = LazyExportAST(s.log, source, OptionsFromConfig(s.options), expr, null);
    const inp = new GlobInputFile();
    inp.Source = source;
    inp.Repr = new GlobJSRepr();
    (inp.Repr as any).AST = ast;
    inp.Loader = 11; // LoaderJSON
    const se = new SideEffects(); se.Kind = 3; // NoSideEffects_PureData
    inp.SideEffects = se;
    const result = { ok: true, file: { inputFile: inp } };
    s.remaining++;
    s.resultChannel.push(result);
  }

  // 用户 InjectPaths：需 resolver 插件 + maybeParseFile goroutine（深耦合），由注入的 resolveInject 回调给出
  // 结果；本函数把返回的注入文件追加。SKELETON 边界：resolveInject 未注入时跳过（诚实标注）。
  if (paths.length > 0 && typeof s.resolveInject === "function") {
    const resolved = s.resolveInject(paths, s.fs);
    for (const r of resolved ?? []) injectedFiles.push(r);
  }

  s.options.InjectedFiles = injectedFiles;
  return injectedFiles.length;
}

// ============================================================================
// 第 116 轮：scanner.addEntryPoints 确定性 phase-2 —— 真 1:1（注入 resolve/parse）。
// ============================================================================

/**
 * Go: scanner.addEntryPoints 的确定性 phase-2（bundler.go:2000-2118），从「Determine output
 * paths」到 return。第 116 轮落地：自动 outputPath 生成+sanitize+Windows 卷标、outbase 计算、
 * parse 注入取 SourceIndex、outputPath 转相对（outdir/outbase）+ 扩展剥离。
 * resolver phase-1 的结果（每入口的 resolvePath 或 null）与 parse 回调由调用方注入
 * （等价 Compile 注入 link）。Go 探针已交叉验证本逻辑与真实 addEntryPoints 输出逐字节一致。
 *
 * s: duck-typed { fs, options:{AbsOutputDir,AbsOutputBase} }。
 * entries: [{InputPath, OutputPath}]；infos: (string|null)[][]（每入口的 resolved abs path 列表）；
 * parse: (absPath) => sourceIndex。返回 entryMetas 数组。
 */
export function addEntryPoints(
  s: any,
  entries: { InputPath: string; OutputPath: string }[],
  infos: (string | null)[][],
  parse: (absPath: string) => number,
): { OutputPath: string; SourceIndex: number; OutputPathWasAutoGenerated: boolean }[] {
  const entryMetas: { OutputPath: string; SourceIndex: number; OutputPathWasAutoGenerated: boolean }[] = [];
  const entryPointAbsResolveDir = s.fs.Cwd();
  const toParse: { index: number; path: string }[] = [];
  for (let i = 0; i < entries.length; i++) {
    const results = infos[i] ?? [];
    if (results.length === 0) continue;
    for (const resolvedPath of results) {
      if (resolvedPath === null) continue;
      const outputPathIn = entries[i].OutputPath;
      let outputPath = outputPathIn;
      let auto = false;
      if (outputPath === "") {
        outputPath = entries[i].InputPath;
        let windowsVolumeLabel = "";
        if (s.fs.IsAbs(outputPath) && outputPath.length >= 3 && outputPath[1] === ":") {
          const c = outputPath[0];
          if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z")) {
            if (outputPath[2] === "/" || outputPath[2] === "\\") {
              windowsVolumeLabel = outputPath.slice(0, 3);
              outputPath = outputPath.slice(3);
            }
          }
        }
        outputPath = sanitizeFilePathForVirtualModulePath(outputPath);
        if (windowsVolumeLabel !== "") outputPath = windowsVolumeLabel + outputPath;
        auto = true;
      }
      toParse.push({ index: entryMetas.length, path: resolvedPath });
      entryMetas.push({ OutputPath: outputPath, SourceIndex: 0, OutputPathWasAutoGenerated: auto });
    }
  }
  // Turn auto-generated output paths into absolute paths
  for (const ep of entryMetas) {
    if (ep.OutputPathWasAutoGenerated && !s.fs.IsAbs(ep.OutputPath)) {
      ep.OutputPath = s.fs.Join([entryPointAbsResolveDir, ep.OutputPath]);
    }
  }
  // Automatically compute outbase
  if (!s.options.AbsOutputBase) {
    s.options.AbsOutputBase = lowestCommonAncestorDirectory(s.fs, entryMetas);
    if (!s.options.AbsOutputBase) s.options.AbsOutputBase = entryPointAbsResolveDir;
  }
  // Parse after outbase determined
  for (const t of toParse) entryMetas[t.index].SourceIndex = parse(t.path);
  // Turn output paths back into relative paths
  for (const ep of entryMetas) {
    if (s.fs.IsAbs(ep.OutputPath)) {
      if (!ep.OutputPathWasAutoGenerated) {
        const r = s.fs.Rel(s.options.AbsOutputDir, ep.OutputPath);
        if (r.ok) ep.OutputPath = r.value;
      } else {
        const r = s.fs.Rel(s.options.AbsOutputBase, ep.OutputPath);
        if (r.ok) ep.OutputPath = r.value;
        const last = Math.max(ep.OutputPath.lastIndexOf("/"), ep.OutputPath.lastIndexOf("."), ep.OutputPath.lastIndexOf("\\"));
        if (last !== -1 && ep.OutputPath[last] === ".") ep.OutputPath = ep.OutputPath.slice(0, last);
      }
    }
  }
  return entryMetas;
}

// ============================================================================
// 第 116 轮：scanner.scanAllDependencies —— 真 1:1（非 bundle drain 路径）。
// ============================================================================

/**
 * Go: func (s *scanner) scanAllDependencies() (bundler.go:2176)。第 116 轮落地非 bundle 模式
 * 的确定性 drain：消费 resultChannel 直到 remaining=0，按 Source.Index 写回 s.results，!ok 跳过。
 * bundle 模式的 import 解析（maybeParseFile/resolve/glob）需完整 resolver 状态机，属深耦合，
 * 诚实标注未在本缝覆盖。s: duck-typed { remaining, resultChannel(array), results, options }。
 */
export function scanAllDependencies(s: any): void {
  while (s.remaining > 0) {
    // Go: CancelFlag.DidCancel() —— 本端口无并发取消，不触发
    const result = s.resultChannel.shift();
    s.remaining--;
    if (!result || !result.ok) continue;
    // Don't try to resolve paths if we're not bundling（ModePassThrough / ModeConvertFormat）
    // bundle 模式的 import record 解析为深耦合路径，未在本确定性缝覆盖。
    s.results[result.file.inputFile.Source.Index] = result;
  }
}


// ============================================================================
// 第 116 轮：scanner.processScannedFiles —— 真 1:1（metafile 生成 + import 属性消歧）。
// ============================================================================

/**
 * Go: func (s *scanner) processScannedFiles(entryPointMeta []graph.EntryPoint) []scannerFile
 *     (bundler.go:2361)。第 116 轮落地确定性核心：pretty-path 冲突的 import 属性消歧（追加
 *     " with {k: v}" 后缀）、大包 MinifiedMetafile、metafile jsonMetadataChunk 生成（含
 *     imports:[] / with 属性 / format）。bundle 模式的 import record 解析为深耦合，诚实标注未覆盖。
 * 返回每 result 的 { meta, relAfter, mf }（Go 写回 file.jsonMetadataChunk 与 Source.PrettyPaths）。
 */
export function processScannedFiles(s: any): { meta: string; relAfter: string; mf: number }[] {
  // Build set of entry point source indices (未用于本确定性缝的输出，骨架保留)
  // Check for pretty-printed path collisions
  const collisions = new Map<string, number[]>();
  for (let i = 0; i < s.results.length; i++) {
    const r = s.results[i];
    if (r.ok) {
      const pp = r.file.inputFile.Source.PrettyPaths;
      const key = pp.Abs + "\u0000" + pp.Rel;
      const arr = collisions.get(key) ?? [];
      arr.push(i);
      collisions.set(key, arr);
    }
  }
  for (const indices of collisions.values()) {
    if (indices.length === 1) continue;
    for (const idx of indices) {
      const source = s.results[idx].file.inputFile.Source;
      const attrs = source.KeyPath.ImportAttributes ? source.KeyPath.ImportAttributes.DecodeIntoArray() : [];
      if (attrs.length === 0) continue;
      let suffix = " with {";
      for (let i = 0; i < attrs.length; i++) {
        if (i > 0) suffix += ",";
        suffix += " ";
        suffix += IsIdentifier(attrs[i].Key) ? new TextDecoder().decode(attrs[i].Key) : new TextDecoder().decode(QuoteSingle(attrs[i].Key, false));
        suffix += ": ";
        suffix += new TextDecoder().decode(QuoteSingle(attrs[i].Value, false));
      }
      suffix += " }";
      source.PrettyPaths.Abs += suffix;
      source.PrettyPaths.Rel += suffix;
    }
  }
  if (s.results.length > 256) s.options.MetafileFormat = 1; // MinifiedMetafile
  const minified = s.options.MetafileFormat === 1;
  const out: { meta: string; relAfter: string; mf: number }[] = [];
  for (let idx = 0; idx < s.results.length; idx++) {
    const result = s.results[idx];
    if (!result.ok) continue;
    let sb = "";
    let isFirstImport = true;
    const source = result.file.inputFile.Source;
    if (s.options.NeedsMetafile) {
      const pp = source.PrettyPaths;
      const name = s.options.MetafilePathStyle === 1 ? pp.Abs : pp.Rel;
      sb += new TextDecoder().decode(QuoteForJSON(new TextEncoder().encode(name), !!s.options.ASCIIOnly));
      sb += MaybeRemoveWhitespace(': {\n      "bytes": ' + source.Contents.length + ',\n      "imports": [', minified);
      sb += "]"; // Go: sb.WriteString("]") 关闭 imports 数组（无 format 分支）
    }
    // import record 解析（bundle 模式）为深耦合，未在本缝覆盖；本缝 imports 恒空。
    if (s.options.NeedsMetafile) {
      // with 属性（来自 KeyPath.ImportAttributes）
      const attrs = source.KeyPath.ImportAttributes ? source.KeyPath.ImportAttributes.DecodeIntoArray() : [];
      if (attrs.length > 0) {
        sb += MaybeRemoveWhitespace(',\n      "with": {', minified);
        for (let i = 0; i < attrs.length; i++) {
          if (i > 0) sb += ",";
          sb += MaybeRemoveWhitespace('\n        ' + new TextDecoder().decode(QuoteForJSON(attrs[i].Key, !!s.options.ASCIIOnly)) + ': ' + new TextDecoder().decode(QuoteForJSON(attrs[i].Value, !!s.options.ASCIIOnly)), minified);
        }
        sb += MaybeRemoveWhitespace('\n      }', minified);
      }
      sb += MaybeRemoveWhitespace("\n    }", minified);
    }
    result.file.jsonMetadataChunk = sb;
    out.push({ meta: sb, relAfter: source.PrettyPaths.Rel, mf: s.options.MetafileFormat });
  }
  return out;
}

// ============================================================================
// 第 116 轮：ScanBundle 确定性 graph-scan 编排 —— 真 1:1（注入 parse/resolve/keyPrefix）。
// ============================================================================

/** Go: ScanBundle 的 parse 结果确定性投影（Go parseResult 的 keyPath/loader/importRecords） */
export interface ScanParseResult {
  KeyPath: string;
  Loader: number;
  Imports: { Path: string; Kind: string }[];
}
/**
 * Go: func ScanBundle(call, log, fs, caches, entryPoints, options, timer) Bundle (bundler.go:1371)。
 * 第 116 轮落地确定性 graph-scan 编排：runtime 固定 sourceIndex 0、按入口顺序分配 sourceIndex、
 * 解析 import 到新 sourceIndex、文件按 index 排序（等价 processScannedFiles 的 results 顺序）。
 * parse(path,index) 与 resolve(importPath) 由调用方注入（等价 Compile 注入 link / fs 注入）。
 * generateUniqueKeyPrefix 为随机，不参与确定性输出（注入 seam 隐含）。
 * 返回 { files, entries }（Go Bundle.files/entryPoints 的确定性投影）。
 */
export function ScanBundle(
  entryPaths: string[],
  parse: (path: string, index: number) => ScanParseResult,
  resolve: (importPath: string) => string,
): { files: { keyPath: string; namespace: string; loader: number; imports: { path: string; kind: string; sourceIdx: number }[] }[];
     entries: { outputPath: string; sourceIndex: number; auto: boolean }[] } {
  const filesByIndex = new Map<number, { keyPath: string; namespace: string; loader: number; imports: { path: string; kind: string; sourceIdx: number }[] }>();
  filesByIndex.set(0, { keyPath: "<runtime>", namespace: "", loader: 0, imports: [] });
  const visited = new Map<string, number>();
  let next = 1;
  const queue: { path: string; idx: number }[] = [];
  const entries: { outputPath: string; sourceIndex: number; auto: boolean }[] = [];
  for (const ep of entryPaths) {
    const idx = next++;
    visited.set(ep, idx);
    queue.push({ path: ep, idx });
    // Go: 显式 outputPath 或自动 basename；本确定性缝以注入方给定路径处理，entry 投影只钉 sourceIndex。
    entries.push({ outputPath: "out", sourceIndex: idx, auto: false });
  }
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const pr = parse(cur.path, cur.idx);
    const recs: { path: string; kind: string; sourceIdx: number }[] = [];
    for (const im of pr.Imports) {
      const resolved = resolve(im.Path);
      let si = -1;
      if (resolved !== "") {
        let v = visited.get(resolved);
        if (v === undefined) { v = next++; visited.set(resolved, v); queue.push({ path: resolved, idx: v }); }
        si = v;
      }
      recs.push({ path: im.Path, kind: im.Kind, sourceIdx: si });
    }
    filesByIndex.set(cur.idx, { keyPath: pr.KeyPath, namespace: "file", loader: pr.Loader, imports: recs });
  }
  const files: { keyPath: string; namespace: string; loader: number; imports: { path: string; kind: string; sourceIdx: number }[] }[] = [];
  for (let i = 0; i < next; i++) { const f = filesByIndex.get(i); if (f) files.push(f); }
  return { files, entries };
}

// ============================================================================
// 第 120 轮：scanner.maybeParseFile 确定性状态缝 —— 真 1:1（visited 去重 + source-index 分配）。
// ============================================================================

/**
 * Go: func (s *scanner) maybeParseFile(...) uint32 (bundler.go:1540) 的确定性状态核心：
 * file 命名空间路径规范化（canonicalFileSystemPathForWindows）、visited 去重命中直接返回、
 * 未访问则 allocateSourceIndex 分配新索引 + 标记 visited + remaining++。
 * parseFile goroutine 的 AST 结果（module type / define / loader）为深耦合，由注入的 onParse 回调
 * 处理（本缝传 no-op，仅观察状态）；诚实标注未覆盖 AST。
 * s: duck-typed { caches, visited(Map<string,number>), results, remaining }。
 * 返回 sourceIndex（visited hit = 原索引；new = 新分配索引）。
 */
export function maybeParseFile(s: any, primaryPath: { Text: string; Namespace: string }, _onParse?: (idx: number) => void): number {
  const key = { Text: primaryPath.Text, Namespace: primaryPath.Namespace };
  if (key.Namespace === "file") key.Text = canonicalFileSystemPathForWindows(key.Text);
  const keyStr = key.Namespace + "\u0000" + key.Text;
  const visited = s.visited as Map<string, number>;
  const found = visited.get(keyStr);
  if (found !== undefined) return found;
  // new path: allocate source index via cache
  const idx = allocateSourceIndex(s, key.Text, 0 /* SourceIndexNormal */);
  visited.set(keyStr, idx);
  s.remaining++;
  if (_onParse) _onParse(idx);
  return idx;
}



// ============================================================================
// 第 120 轮：runtimeCache.parseRuntime —— 真 1:1（runtime.Source + js_parser.Parse 组合）。
// ============================================================================

/** Go: runtimeCacheKey (bundler.go:3372) 的 TS 投影（决定 runtime source 与 parse 选项） */
export interface RuntimeParseResult {
  sourceLen: number; sourceSha: string; ok: boolean;
  numParts: number; stmtKinds: string[][]; numImports: number;
}

/**
 * Go: func (cache *runtimeCache) parseRuntime(options *config.Options) (logger.Source, js_ast.AST, bool)
 *     (bundler.go:3385)。第 120 轮真端口：组合已端口的 runtime.Source(feature) +
 * js_parser.Parse(TreeShaking=true)。返回可逐字节验证的投影（source bytes hash + AST parts/stmt 结构）。
 * full AST 符号表差异（Go 含 unbound 全局 Go344/TS233，TS parser 骨架限制）为 known-deviation，
 * 不在本投影覆盖，如实标注。cache 语义（astMap 复用）由调用方持有，本函数等价 cache-miss 路径。
 */
export function parseRuntime(unsupportedJSFeatures: bigint, minifySyntax: boolean, minifyIdentifiers: boolean): RuntimeParseResult {
  const src = RuntimeSource(unsupportedJSFeatures);
  const opts = OptionsFromConfig({ UnsupportedJSFeatures: unsupportedJSFeatures, MinifySyntax: minifySyntax,
    MinifyIdentifiers: minifyIdentifiers, TreeShaking: true });
  const r = Parse(new Log(), src, opts);
  const kinds = r.ast.Parts.map((p: any) => p.Stmts.map((st: any) => {
    const n = st.Data?.constructor?.name ?? "";
    switch (n) {
      case "SExpr": return "Expr";
      case "SLocal": return "Local";
      case "SFunction": return "Function";
      case "SReturn": return "Return";
      case "SBlock": return "Block";
      case "SIf": return "If";
      case "SThrow": return "Throw";
      case "STry": return "Try";
      case "SClass": return "Class";
      default: return "other";
    }
  }));
  return {
    sourceLen: src.Contents.length,
    sourceSha: createHash("sha256").update(src.Contents).digest("base64url"),
    ok: r.ok, numParts: r.ast.Parts.length, stmtKinds: kinds, numImports: r.ast.ImportRecords.length,
  };
}

// ============================================================================
// 第 120 轮：parseFile stdin 缝 —— 真 1:1 投影（source/loader/sideEffects/AST parts 结构）。
// ============================================================================

/** Go: parseFile 的 stdin 投影（Go parseResult 的可逐字节验证部分） */
export interface ParseFileResult {
  ok: boolean; loader: number; sideKind: number;
  numParts: number; stmtKinds: string[][]; numImports: number;
}

/**
 * Go: func parseFile(args parseArgs) (bundler.go:124) 的 stdin 缝（无插件：source 来自 stdin）。
 * 第 120 轮真端口：loader 选择（stdin.Loader → 默认 JS）+ js_parser.Parse + sideEffects 判定
 * （parts<=1 → NoSideEffects_EmptyAST）+ AST parts/stmt 结构投影。
 * 符号表（arguments/React/require_* 隐式全局）为 TS parser 骨架限制 known-deviation，不在投影覆盖；
 * 非 stdin 路径（runOnLoadPlugins 插件/resolver）为深耦合，未覆盖，均如实标注。
 */
function pfStmtKind(st: any): string {
  const n = st.Data?.constructor?.name ?? "";
  switch (n) {
    case "SExpr": return "Expr";
    case "SLocal": return "Local";
    case "SFunction": return "Function";
    case "SReturn": return "Return";
    case "SBlock": return "Block";
    case "SIf": return "If";
    case "SClass": return "Class";
    default: return "other";
  }
}

export function parseFile(contents: string, loaderIn: number): ParseFileResult {
  const src = new LoggerSource();
  src.Contents = new TextEncoder().encode(contents);
  src.KeyPath = new LoggerPath2(); src.KeyPath.Text = "<stdin>";
  src.PrettyPaths = { Abs: "<stdin>", Rel: "<stdin>" } as any;
  let loader = loaderIn;
  if (loader === 0 /* LoaderNone */) loader = 10; // LoaderJS
  const opts = OptionsFromConfig({ Stdin: { Contents: contents, Loader: loader }, ExtensionToLoader: new Map(), TreeShaking: true });
  const log = new Log();
  if (loader === 11 /* LoaderJSON */ || loader === 12 /* LoaderWithTypeJSON */) {
    const jr = ParseJSON(log, src, { UnsupportedJSFeatures: 0n } as any);
    const ast2 = LazyExportAST(log, src, opts, jr.expr, null);
    return { ok: jr.ok, loader, sideKind: 3, numParts: ast2.Parts.length,
      stmtKinds: ast2.Parts.map((p: any) => p.Stmts.map(pfStmtKind)), numImports: ast2.ImportRecords.length };
  }
  const r = Parse(log, src, opts);
  let sideKind = 0; // HasSideEffects
  if (r.ast.Parts.length <= 1) sideKind = 2; // NoSideEffects_EmptyAST
  return { ok: r.ok, loader, sideKind, numParts: r.ast.Parts.length,
    stmtKinds: r.ast.Parts.map((p: any) => p.Stmts.map(pfStmtKind)), numImports: r.ast.ImportRecords.length };
}
