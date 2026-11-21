// 1:1 移植自 esbuild internal/linker/linker.go（v0.28.2，commit f6058f83）
// 第 58 轮叶子优先规划：publicPath 拼接。真值表由 Go 探针固化在 testdata/linker-path-go.json。
import { CanEscapeIdentifier, QuoteIdentifier } from "../js_printer/js_printer.ts";
import { Keywords as JsLexerKeywords } from "../js_lexer/tables.ts";
import { QuoteForJSON } from "../helpers/quote.ts";
import { StringToJSFeature } from "../compat/tables_generated.ts";
import { Log, Msg, MsgKind, Loc } from "../logger/logger.ts";
import { ImportConditions, TokensEqualIgnoringWhitespace, MediaQueriesEqualIgnoringWhitespace } from "../css_ast/css_ast.ts";
const LOGICAL_ASSIGNMENT = BigInt(StringToJSFeature["logical-assignment"] ?? 0);
import * as astNS from "../ast/ast.ts";
import * as js_astNS from "../js_ast/js_ast.ts";
import * as graphNS from "../graph/graph.ts";
import { JSRepr as JSReprNS, CSSRepr as CSSReprNS, ExportData as ExportDataNS, ImportData as ImportDataNS } from "../graph/input.ts";
import { Timer as TimerNS } from "../helpers/timer.ts";
import { BitSet, NewBitSet } from "../helpers/bitset.ts";
import { ExportRenamer, ComputeReservedNames, NewMinifyRenamer, NewNumberRenamer,
  StableSymbolCountArray, StableSymbolCount } from "../renamer/renamer.ts";
import { CharFreq, SlotCounts, DefaultNameMinifierJS, DefaultNameMinifierCSS } from "../ast/ast.ts";
import { IsIdentifier } from "../js_ast/js_ident.ts";
import { PrettyPrintTargetEnvironment, Loader } from "../config/config.ts";
import { UTF16ToString } from "../helpers/utf.ts";
import { IsIdentifierUTF16 } from "../js_ast/js_ident.ts";
import { Has as HasFeature } from "../compat/compat.ts";
import { Path } from "../logger/logger.ts";
import { EscapeClosingTag } from "../helpers/comment.ts";
import { FileURLFromFilePath, IsFileURL, FilePathFromFileURL } from "../helpers/path.ts";
import { AppendSourceMapChunk, SourceMapState, MappingsBuffer } from "../sourcemap/sourcemap.ts";
import { AddError, AddErrorWithNotes, MakeLineColumnTracker, MsgLocation, AddMsgID } from "../logger/logger.ts";
import * as js_ast_helpers from "../js_ast/js_ast_helpers.ts";
import { ForEachIdentifierBindingInDecls } from "../js_ast/js_ast_helpers.ts";
import { MakeTypoDetector } from "../helpers/typos.ts";
import { IsCSS, IsTypeScript } from "../config/config.ts";
import { RangeOfIdentifier as JsRangeOfIdentifier } from "../js_lexer/js_lexer.ts";
import { RangeOfIdentifier as CssRangeOfIdentifier } from "../css_lexer/css_lexer.ts";
import { refKey } from "../graph/input.ts";
import { Joiner } from "../helpers/joiner.ts";
import { Print as JsPrint, Options as JsPrintOptions } from "../js_printer/js_printer.ts";
import { TemplateToString } from "../config/config.ts";
import * as cssPrinterNS from "../css_printer/css_printer.ts";
import { HashForFileName } from "../bundler/bundler.ts";
import { SourceMapShift, LineColumnOffset } from "../sourcemap/sourcemap.ts";
import { New as NewHash } from "../xxhash/xxhash.ts";
import * as configNS from "../config/config.ts";
import * as bundlerNS from "../bundler/bundler.ts";
import * as css_astNS from "../css_ast/css_ast.ts";
/** Go: runtime.SourceIndex (internal/runtime/runtime.go:16) = 0 */
const runtimeSourceIndex = 0;

/** Go: partRange (linker.go:77) */
interface partRange { sourceIndex: number; partIndexBegin: number; partIndexEnd: number; }

/** Go: func appendOrExtendPartRange(ranges []partRange, sourceIndex, partIndex uint32) []partRange (linker.go:4114) */
export function appendOrExtendPartRange(ranges: partRange[], sourceIndex: number, partIndex: number): partRange[] {
  if (ranges.length >= 1) {
    const r = ranges[ranges.length - 1];
    if (r.sourceIndex === sourceIndex && r.partIndexEnd === partIndex) {
      r.partIndexEnd = partIndex + 1;
      return ranges;
    }
  }
  ranges.push({ sourceIndex, partIndexBegin: partIndex, partIndexEnd: partIndex + 1 });
  return ranges;
}

/** Go: func hashWriteUint32(hash hash.Hash, value uint32) (linker.go:6911) —— 返回写入的 4 个小端字节 */
export function hashWriteUint32(value: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, value, true);
  return b;
}

/** Go: func (c *linkerContext) generateGlobalNamePrefix() string (linker.go:6004) */
export function generateGlobalNamePrefix(globalName: string[], minify: boolean, asciiOnly: boolean, unsupported: bigint): string {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  const ident = (n: string): string => {
    if (!CanEscapeIdentifier(n, unsupported, asciiOnly)) return n;
    return asciiOnly ? dec.decode(QuoteIdentifier(n)) : n;
  };
  const idx = (n: string): string => `[${dec.decode(QuoteForJSON(enc.encode(n), asciiOnly))}]`;
  const dotOrIndex = (n: string): string => CanEscapeIdentifier(n, unsupported, asciiOnly) ? `.${ident(n)}` : idx(n);

  let prefix = globalName[0];
  const rest = globalName.slice(1);
  let space = " ", join = ";\n";
  if (minify) { space = ""; join = ";"; }
  let isExistingObject = prefix === "this";
  if (prefix === "import" && rest.length > 0 && rest[0] === "meta") { prefix = "import.meta"; rest.shift(); isExistingObject = true; }

  if (rest.length > 0 && !(unsupported & LOGICAL_ASSIGNMENT)) {
    let text = "";
    if (!isExistingObject) {
      if (CanEscapeIdentifier(prefix, unsupported, asciiOnly)) {
        prefix = ident(prefix);
        text = `var ${prefix}${join}`;
      } else {
        prefix = `this${idx(prefix)}`;
      }
    }
    for (const name of rest) {
      const d = dotOrIndex(name);
      if (isExistingObject) { prefix = prefix + d; isExistingObject = false; }
      else { prefix = `(${prefix}${space}||=${space}${d})`; }
    }
    return `${text}${prefix}${space}=${space}`;
  }

  let text: string;
  if (isExistingObject) text = `${prefix}${space}=${space}`;
  else if (CanEscapeIdentifier(prefix, unsupported, asciiOnly)) text = `var ${ident(prefix)}${space}=${space}`;
  else { prefix = `this${idx(prefix)}`; text = `${prefix}${space}=${space}`; }
  for (const name of rest) {
    const oldPrefix = prefix;
    prefix = CanEscapeIdentifier(name, unsupported, asciiOnly) ? `${prefix}.${ident(name)}` : `${prefix}${idx(name)}`;
    text += `${oldPrefix}${space}||${space}{}${join}${prefix}${space}=${space}`;
  }
  return text;
}

/** Go: func joinWithPublicPath(publicPath string, relPath string) string (linker.go:7271) */
export function joinWithPublicPath(publicPath: string, relPath: string): string {
  if (relPath.startsWith("./")) {
    relPath = relPath.slice(2);
    // Strip any amount of further no-op slashes (i.e. ".///././/x/y" => "x/y")
    for (;;) {
      if (relPath.startsWith("/")) relPath = relPath.slice(1);
      else if (relPath.startsWith("./")) relPath = relPath.slice(2);
      else break;
    }
  }

  // Use a relative path if there is no public path
  if (publicPath === "") publicPath = ".";

  // Join with a slash
  let slash = "/";
  if (publicPath.endsWith("/")) slash = "";
  return publicPath + slash + relPath;
}


// ============================================================================
// 第 122 批：linker 纯 helper 大批（Go 探针 25 例，linker-batch-go.json）。
// 4 个 sort.Interface × 3 方法、isChunk×2、wrappedLog、两个 @import 条件谓词、
// hashWriteLengthPrefixed。Go 方法以同名 class 方法呈现。
// ============================================================================
export class crossChunkImportArray {
  entries: { chunkIndex: number; sortedImportItems: any[] }[] = [];
  constructor(entries: { chunkIndex: number; sortedImportItems?: any[] }[] = []) {
    this.entries = entries.map((e) => ({ chunkIndex: e.chunkIndex, sortedImportItems: e.sortedImportItems ?? [] }));
  }
  Len(): number { return this.entries.length; }
  Swap(i: number, j: number): void { const t = this.entries[i]; this.entries[i] = this.entries[j]; this.entries[j] = t; }
  Less(i: number, j: number): boolean { return this.entries[i].chunkIndex < this.entries[j].chunkIndex; }
}

export class crossChunkImportItemArray {
  entries: { exportAlias: string; ref: any }[] = [];
  constructor(entries: { exportAlias: string; ref?: any }[] = []) {
    this.entries = entries.map((e) => ({ exportAlias: e.exportAlias, ref: e.ref }));
  }
  Len(): number { return this.entries.length; }
  Swap(i: number, j: number): void { const t = this.entries[i]; this.entries[i] = this.entries[j]; this.entries[j] = t; }
  Less(i: number, j: number): boolean { return this.entries[i].exportAlias < this.entries[j].exportAlias; }
}

export class stableRefArray {
  entries: { StableSourceIndex: number; Ref: { SourceIndex: number; InnerIndex: number } }[] = [];
  constructor(entries: { StableSourceIndex: number; Ref: { SourceIndex: number; InnerIndex: number } }[] = []) { this.entries = entries; }
  Len(): number { return this.entries.length; }
  Swap(i: number, j: number): void { const t = this.entries[i]; this.entries[i] = this.entries[j]; this.entries[j] = t; }
  Less(i: number, j: number): boolean {
    const ai = this.entries[i], aj = this.entries[j];
    return ai.StableSourceIndex < aj.StableSourceIndex ||
      (ai.StableSourceIndex === aj.StableSourceIndex && ai.Ref.InnerIndex < aj.Ref.InnerIndex);
  }
}

export class chunkOrderArray {
  entries: { distance: number; tieBreaker: number }[] = [];
  constructor(entries: { distance: number; tieBreaker: number }[] = []) { this.entries = entries; }
  Len(): number { return this.entries.length; }
  Swap(i: number, j: number): void { const t = this.entries[i]; this.entries[i] = this.entries[j]; this.entries[j] = t; }
  Less(i: number, j: number): boolean {
    const ai = this.entries[i], aj = this.entries[j];
    return ai.distance < aj.distance || (ai.distance === aj.distance && ai.tieBreaker < aj.tieBreaker);
  }
}

/** Go: type cssImportKind uint8 / const cssImportNone.. (linker.go:3370) */
export const cssImportNone = 0, cssImportSourceIndex = 1, cssImportExternalPath = 2, cssImportLayers = 3;

/** Go: type cssImportOrder struct (linker.go:3378) */
export interface cssImportOrder {
  kind: number;
  layers: string[][];
  conditions: ImportConditions[];
  conditionImportRecords: any[];
  sourceIndex: number;
  externalPath: any; // logger.Path
}

/** Go: type crossChunkImport struct (linker.go:118) */
export interface crossChunkImport { chunkIndex: number; importKind: number; }

/** Go: type outputPieceIndexKind / outputPiece / intermediateOutput (linker.go:129-167) */
export const outputPieceNone = 0, outputPieceAssetIndex = 1, outputPieceChunkIndex = 2;
export interface outputPiece { data: Uint8Array; index: number; kind: number; }
export interface intermediateOutput { pieces: outputPiece[] | null; joiner: any; }

/** Go: type chunkReprJS struct (linker.go:160) */
export class chunkReprJS {
  filesInChunkInOrder: number[] = [];
  partsInChunkInOrder: partRange[] = [];
  exportsToOtherChunks: Map<string, string> = new Map();
  importsFromOtherChunks: Map<number, crossChunkImportItemArray> = new Map();
  crossChunkPrefixStmts: js_astNS.Stmt[] = [];
  crossChunkSuffixStmts: js_astNS.Stmt[] = [];
  cssChunkIndex = 0;
  hasCSSChunk = false;
  isChunk(): void {}
}
/** Go: type chunkReprCSS struct (linker.go:178) */
export class chunkReprCSS {
  importsInChunkInOrder: cssImportOrder[] = [];
  isChunk(): void {}
}

/** Go: type chunkInfo struct (linker.go:83) */
export class chunkInfo {
  uniqueKey = "";
  filesWithPartsInChunk: Set<number> = new Set();
  entryBits: BitSet = new BitSet(new Uint8Array(0));
  crossChunkImports: crossChunkImport[] = [];
  chunkRepr: chunkReprJS | chunkReprCSS = new chunkReprJS();
  finalTemplate: configNS.PathTemplate[] = [];
  finalRelPath = "";
  externalLegalComments: Uint8Array = new Uint8Array(0);
  waitForIsolatedHash: (() => Uint8Array) | null = null;
  jsonMetadataChunkCallback: ((finalOutputSize: number) => any) | null = null;
  outputSourceMap: any = null;
  intermediateOutput: intermediateOutput = { pieces: null, joiner: new Joiner() };
  entryPointBit = 0;
  sourceIndex = 0;
  isEntryPoint = false;
  isExecutable = false;
}

/** Go: func wrappedLog(log logger.Log) logger.Log (linker.go:227) */
export function wrappedLog(log: Log): Log {
  const out = new Log();
  out.AddMsg = log.AddMsg; out.HasErrors = log.HasErrors; out.Peek = log.Peek; out.Done = log.Done;
  out.Level = log.Level; out.Overrides = log.Overrides;
  let hasErrors = false;
  const addMsg = log.AddMsg;
  out.AddMsg = (msg: Msg): void => {
    if (msg.Kind === MsgKind.Error) hasErrors = true;
    addMsg(msg);
  };
  out.HasErrors = (): boolean => hasErrors;
  return out;
}

/** Go: func importConditionsAreEqual(a, b []css_ast.ImportConditions) bool (linker.go:3772) */
export function importConditionsAreEqual(a: ImportConditions[], b: ImportConditions[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!TokensEqualIgnoringWhitespace(a[i].Layers, b[i].Layers) ||
        !TokensEqualIgnoringWhitespace(a[i].Supports, b[i].Supports) ||
        !MediaQueriesEqualIgnoringWhitespace(a[i].Queries, b[i].Queries)) return false;
  }
  return true;
}

/** Go: func isConditionalImportRedundant(earlier, later []css_ast.ImportConditions) bool (linker.go:3819) */
export function isConditionalImportRedundant(earlier: ImportConditions[], later: ImportConditions[]): boolean {
  if (later.length > earlier.length) return false;
  for (let i = 0; i < later.length; i++) {
    const a = earlier[i], b = later[i];
    if (TokensEqualIgnoringWhitespace(a.Layers, b.Layers)) {
      const sameSupports = TokensEqualIgnoringWhitespace(a.Supports, b.Supports);
      const sameMedia = MediaQueriesEqualIgnoringWhitespace(a.Queries, b.Queries);
      if (sameSupports && sameMedia) continue;
      if (sameMedia && b.Supports.length === 0) continue;
      if (sameSupports && b.Queries.length === 0) continue;
    }
    return false;
  }
  return true;
}

/** Go: func hashWriteLengthPrefixed(hash hash.Hash, bytes []byte) (linker.go:6919) */
export function hashWriteLengthPrefixed(hash: { update: (data: Uint8Array) => unknown }, data: Uint8Array): void {
  hash.update(hashWriteUint32(data.length));
  hash.update(data);
}


/** Go: type linkerContext struct (linker.go:38) —— 只落本簇及后续主链需要的字段 */
export class linkerContext {
  options: any = {};
  timer: TimerNS = new TimerNS();
  log: Log | null = null;
  fs: any = null;
  res: any = null;
  graph: graphNS.LinkerGraph = new graphNS.LinkerGraph();
  chunks: any[] = [];
  cycleDetector: any[] = [];
  dataForSourceMaps: any = null;
  uniqueKeyPrefix = "";
  uniqueKeyPrefixBytes: Uint8Array = new Uint8Array(0);
  mangledProps: Map<string, string> = new Map();
  unboundModuleRef: astNS.Ref = astNS.InvalidRef;
  cjsRuntimeRef: astNS.Ref = astNS.InvalidRef;
  esmRuntimeRef: astNS.Ref = astNS.InvalidRef;

  /** Go: func (c *linkerContext) treeShakingAndCodeSplitting (linker.go:3148) */
  treeShakingAndCodeSplitting(): void {
    for (const ep of this.graph.EntryPoints()) this.markFileLiveForTreeShaking(ep.SourceIndex);
    const eps = this.graph.EntryPoints();
    for (let i = 0; i < eps.length; i++) this.markFileReachableForCodeSplitting(eps[i].SourceIndex, i, 0);
  }

  /** Go: func (c *linkerContext) markFileReachableForCodeSplitting (linker.go:3167) */
  markFileReachableForCodeSplitting(sourceIndex: number, entryPointBit: number, distanceFromEntryPoint: number): void {
    const file = this.graph.Files[sourceIndex];
    if (!file.IsLive) return;
    let traverseAgain = false;
    if (distanceFromEntryPoint < file.DistanceFromEntryPoint) { file.DistanceFromEntryPoint = distanceFromEntryPoint; traverseAgain = true; }
    distanceFromEntryPoint++;
    if (file.EntryBits.HasBit(entryPointBit) && !traverseAgain) return;
    file.EntryBits.SetBit(entryPointBit);
    const repr = file.InputFile.Repr;
    if (repr instanceof JSReprNS) {
      if (repr.CSSSourceIndex.IsValid()) this.markFileReachableForCodeSplitting(repr.CSSSourceIndex.GetIndex(), entryPointBit, distanceFromEntryPoint);
      for (const record of repr.AST.ImportRecords) {
        if (record.SourceIndex !== undefined && !this.isExternalDynamicImport(record, sourceIndex)) {
          this.markFileReachableForCodeSplitting(record.SourceIndex, entryPointBit, distanceFromEntryPoint);
        }
      }
      for (const part of repr.AST.Parts) {
        for (const dep of part.Dependencies) {
          if (dep.SourceIndex !== sourceIndex) this.markFileReachableForCodeSplitting(dep.SourceIndex, entryPointBit, distanceFromEntryPoint);
        }
      }
    } else if (repr instanceof CSSReprNS) {
      for (const record of (repr.AST as any).ImportRecords ?? []) {
        if (record.SourceIndex !== undefined) this.markFileReachableForCodeSplitting(record.SourceIndex, entryPointBit, distanceFromEntryPoint);
      }
    }
  }

  /** Go: func (c *linkerContext) markFileLiveForTreeShaking (linker.go:3220) */
  markFileLiveForTreeShaking(sourceIndex: number): void {
    const file = this.graph.Files[sourceIndex];
    if (file.IsLive) return;
    file.IsLive = true;
    const repr = file.InputFile.Repr;
    if (repr instanceof JSReprNS) {
      if (repr.CSSSourceIndex.IsValid()) this.markFileLiveForTreeShaking(repr.CSSSourceIndex.GetIndex());
      const parts = repr.AST.Parts;
      for (let partIndex = 0; partIndex < parts.length; partIndex++) {
        const part = parts[partIndex];
        let canBeRemovedIfUnused = part.CanBeRemovedIfUnused;
        for (const importRecordIndex of part.ImportRecordIndices) {
          const record = repr.AST.ImportRecords[importRecordIndex];
          if (record.Kind !== astNS.ImportKind.ImportStmt) continue;
          if (record.SourceIndex !== undefined) {
            const otherSourceIndex = record.SourceIndex;
            const otherFile = this.graph.Files[otherSourceIndex];
            if (otherFile.InputFile.SideEffects.Kind !== 0 && !this.options.IgnoreDCEAnnotations) continue;
            this.markFileLiveForTreeShaking(otherSourceIndex);
          } else if (record.Flags !== undefined && (record.Flags & astNS.ImportRecordFlags.IsExternalWithoutSideEffects) !== 0) {
            continue;
          }
          canBeRemovedIfUnused = false;
        }
        if (!canBeRemovedIfUnused || (!part.ForceTreeShaking && !this.options.TreeShaking && file.IsEntryPoint())) {
          this.markPartLiveForTreeShaking(sourceIndex, partIndex);
        }
      }
    } else if (repr instanceof CSSReprNS) {
      for (const record of (repr.AST as any).ImportRecords ?? []) {
        if (record.SourceIndex !== undefined) this.markFileLiveForTreeShaking(record.SourceIndex);
      }
    }
  }

  /** Go: func (c *linkerContext) isExternalDynamicImport (linker.go:3285) */
  isExternalDynamicImport(record: any, sourceIndex: number): boolean {
    return !!this.options.CodeSplitting && record.Kind === astNS.ImportKind.ImportDynamic &&
      this.graph.Files[record.SourceIndex].IsEntryPoint() && record.SourceIndex !== sourceIndex;
  }

  /** Go: func (c *linkerContext) markPartLiveForTreeShaking (linker.go:3292) */
  markPartLiveForTreeShaking(sourceIndex: number, partIndex: number): void {
    const file = this.graph.Files[sourceIndex];
    const repr = file.InputFile.Repr as JSReprNS;
    const part = repr.AST.Parts[partIndex];
    if (part.IsLive) return;
    part.IsLive = true;
    this.markFileLiveForTreeShaking(sourceIndex);
    for (const dep of part.Dependencies) this.markPartLiveForTreeShaking(dep.SourceIndex, dep.PartIndex);
  }

  /** Go: func (c *linkerContext) recursivelyWrapDependencies (linker.go:2911) —— 第 177 批 */
  recursivelyWrapDependencies(sourceIndex: number): void {
    const repr = this.graph.Files[sourceIndex].InputFile.Repr as JSReprNS;
    if (repr.Meta.DidWrapDependencies) return;
    repr.Meta.DidWrapDependencies = true;
    if (sourceIndex === runtimeSourceIndex) return;
    if (repr.Meta.Wrap === 0 /* WrapNone */) {
      repr.Meta.Wrap = repr.AST.ExportsKind === js_astNS.ExportsKind.ExportsCommonJS ? 1 /* WrapCJS */ : 2 /* WrapESM */;
    }
    for (const record of repr.AST.ImportRecords) {
      if (record.SourceIndex !== undefined) this.recursivelyWrapDependencies(record.SourceIndex);
    }
  }

  /** Go: func (c *linkerContext) hasDynamicExportsDueToExportStar (linker.go:2940) —— 第 177 批 */
  hasDynamicExportsDueToExportStar(sourceIndex: number, visited: Set<number>): boolean {
    const repr = this.graph.Files[sourceIndex].InputFile.Repr as JSReprNS;
    if (repr.AST.ExportsKind === js_astNS.ExportsKind.ExportsCommonJS ||
        repr.AST.ExportsKind === js_astNS.ExportsKind.ExportsESMWithDynamicFallback) return true;
    if (visited.has(sourceIndex)) return false;
    visited.add(sourceIndex);
    for (const ri of repr.AST.ExportStarImportRecords) {
      const record = repr.AST.ImportRecords[ri];
      const file = this.graph.Files[sourceIndex];
      if ((record.SourceIndex === undefined && (!file.IsEntryPoint() || !configNS.KeepESMImportExportSyntax(this.options.OutputFormat))) ||
          (record.SourceIndex !== undefined && record.SourceIndex !== sourceIndex &&
           this.hasDynamicExportsDueToExportStar(record.SourceIndex, visited))) {
        repr.AST.ExportsKind = js_astNS.ExportsKind.ExportsESMWithDynamicFallback;
        return true;
      }
    }
    return false;
  }

  /** Go: func (c *linkerContext) addExportsForExportStar (linker.go:2970) —— 第 177 批 */
  addExportsForExportStar(resolvedExports: Map<string, ExportDataNS>, sourceIndex: number, sourceIndexStack: number[]): void {
    for (const prev of sourceIndexStack) if (prev === sourceIndex) return;
    const stack = sourceIndexStack.concat([sourceIndex]);
    const repr = this.graph.Files[sourceIndex].InputFile.Repr as JSReprNS;
    for (const ri of repr.AST.ExportStarImportRecords) {
      const record = repr.AST.ImportRecords[ri];
      if (record.SourceIndex === undefined) continue; // 运行时解析
      const otherIndex = record.SourceIndex;
      const otherRepr = this.graph.Files[otherIndex].InputFile.Repr as JSReprNS;
      if (otherRepr.AST.ExportsKind === js_astNS.ExportsKind.ExportsCommonJS) continue;
      nextExport:
      for (const [alias, name] of otherRepr.AST.NamedExports) {
        if (alias === "default") continue;
        for (const prev of stack) {
          const prevRepr = this.graph.Files[prev].InputFile.Repr as JSReprNS;
          if (prevRepr.AST.NamedExports.has(alias)) continue nextExport;
        }
        const existing = resolvedExports.get(alias);
        if (existing === undefined) {
          const d = new ExportDataNS();
          d.Ref = name.Ref; d.SourceIndex = otherIndex; d.NameLoc = name.AliasLoc?.Start ?? 0;
          resolvedExports.set(alias, d);
          const imp = new ImportDataNS(); imp.Ref = name.Ref; imp.SourceIndex = otherIndex;
          repr.Meta.ImportsToBind.set(refKey(name.Ref), imp);
        } else if (existing.SourceIndex !== otherIndex) {
          const imp = new ImportDataNS(); imp.SourceIndex = otherIndex; imp.Ref = name.Ref; imp.NameLoc = name.AliasLoc?.Start ?? 0;
          existing.PotentiallyAmbiguousExportStarRefs.push(imp);
          resolvedExports.set(alias, existing);
        }
      }
      this.addExportsForExportStar(resolvedExports, otherIndex, stack);
    }
  }

  /** Go: func (c *linkerContext) mangleProps (linker.go:352) —— 第 178 批 */
  mangleProps(mangleCache: Map<string, any> | null): void {
    const mangledProps = new Map<string, string>();
    this.mangledProps = mangledProps;
    const reservedProps = new Set<string>();
    for (const kw of JsLexerKeywords.keys()) reservedProps.add(kw);
    if (mangleCache !== null) {
      for (const [original, remapped] of mangleCache) {
        if (remapped === false) reservedProps.add(original);
        else reservedProps.add(String(remapped));
      }
    }
    const freq = new CharFreq();
    const mergedProps = new Map<string, astNS.Ref>();
    for (const sourceIndex of this.graph.ReachableFiles) {
      if (sourceIndex === runtimeSourceIndex) continue;
      const repr = this.graph.Files[sourceIndex].InputFile.Repr as JSReprNS;
      if (repr instanceof JSReprNS) {
        for (const prop of (repr.AST.ReservedProps as Set<string>)) reservedProps.add(prop);
        for (const [name, r] of repr.AST.MangledProps) {
          const existing = mergedProps.get(name);
          if (existing !== undefined) astNS.MergeSymbols(this.graph.Symbols, r, existing);
          else mergedProps.set(name, r);
        }
        if (repr.AST.CharFreq !== null && repr.AST.CharFreq !== undefined) freq.Include(repr.AST.CharFreq);
      }
    }
    const sorted = new StableSymbolCountArray();
    for (const r of mergedProps.values()) {
      const sc = new StableSymbolCount();
      sc.StableSourceIndex = this.graph.StableSourceIndices[r.SourceIndex] ?? 0;
      sc.RefSourceIndex = r.SourceIndex; sc.RefInnerIndex = r.InnerIndex;
      sc.Count = astNS.Get(this.graph.Symbols, r).UseCountEstimate;
      sorted.items.push(sc);
    }
    const cmpStable = (a: StableSymbolCount, b: StableSymbolCount): number => {
      if (a.Count !== b.Count) return b.Count - a.Count;
      if (a.StableSourceIndex !== b.StableSourceIndex) return a.StableSourceIndex - b.StableSourceIndex;
      return a.RefInnerIndex - b.RefInnerIndex;
    };
    sorted.items.sort(cmpStable);
    const minifier = DefaultNameMinifierJS.ShuffleByCharFreq(freq);
    let nextName = 0;
    for (const sc of sorted.items) {
      const r = new astNS.Ref(sc.RefSourceIndex, sc.RefInnerIndex);
      const symbol = astNS.Get(this.graph.Symbols, r);
      if (mangleCache !== null && mangleCache.has(symbol.OriginalName)) {
        const existing = mangleCache.get(symbol.OriginalName);
        if (existing !== false) mangledProps.set(refKey(new astNS.Ref(sc.RefSourceIndex, sc.RefInnerIndex)), String(existing));
        continue;
      }
      let name = minifier.NumberToMinifiedName(nextName++);
      while (reservedProps.has(name)) name = minifier.NumberToMinifiedName(nextName++);
      if (mangleCache !== null) mangleCache.set(symbol.OriginalName, name);
      mangledProps.set(refKey(r), name);
    }
  }

  /** Go: func (c *linkerContext) mangleLocalCSS (linker.go:450) —— 第 178 批 */
  mangleLocalCSS(usedLocalNames: Set<string>): void {
    const mangledProps = this.mangledProps;
    const globalNames = new Set<string>();
    const localNames = new Set<string>();
    const freq = new CharFreq();
    for (const sourceIndex of this.graph.ReachableFiles) {
      const repr = this.graph.Files[sourceIndex].InputFile.Repr;
      if (repr instanceof CSSReprNS) {
        const syms = this.graph.Symbols.SymbolsForSource[sourceIndex] ?? [];
        for (let inner = 0; inner < syms.length; inner++) {
          const symbol = syms[inner];
          if (symbol.Kind === astNS.SymbolKind.SymbolGlobalCSS) globalNames.add(symbol.OriginalName);
          else {
            let rRef = astNS.FollowSymbols(this.graph.Symbols, new astNS.Ref(sourceIndex, inner));
            localNames.add(refKey(rRef));
          }
        }
        if ((repr.AST as any).CharFreq != null) freq.Include((repr.AST as any).CharFreq);
      }
    }
    const sorted = new StableSymbolCountArray();
    for (const key of localNames) {
      const sc = new StableSymbolCount();
      const [si, ii] = key.split(":").map(Number);
      sc.StableSourceIndex = this.graph.StableSourceIndices[si] ?? 0;
      sc.RefSourceIndex = si; sc.RefInnerIndex = ii;
      sc.Count = astNS.Get(this.graph.Symbols, new astNS.Ref(si, ii)).UseCountEstimate;
      sorted.items.push(sc);
    }
    const cmpStable = (a: StableSymbolCount, b: StableSymbolCount): number => {
      if (a.Count !== b.Count) return b.Count - a.Count;
      if (a.StableSourceIndex !== b.StableSourceIndex) return a.StableSourceIndex - b.StableSourceIndex;
      return a.RefInnerIndex - b.RefInnerIndex;
    };
    sorted.items.sort(cmpStable);
    if (this.options.MinifyIdentifiers) {
      const minifier = DefaultNameMinifierCSS.ShuffleByCharFreq(freq);
      let nextName = 0;
      for (const sc of sorted.items) {
        let name = minifier.NumberToMinifiedName(nextName++);
        while (globalNames.has(name) || usedLocalNames.has(name)) name = minifier.NumberToMinifiedName(nextName++);
        mangledProps.set(refKey(new astNS.Ref(sc.RefSourceIndex, sc.RefInnerIndex)), name);
        usedLocalNames.add(name);
      }
    } else {
      const nameCounts = new Map<string, number>();
      for (const sc of sorted.items) {
        const r = new astNS.Ref(sc.RefSourceIndex, sc.RefInnerIndex);
        const symbol = astNS.Get(this.graph.Symbols, r);
        const idName = this.graph.Files[sc.RefSourceIndex].InputFile.Source.IdentifierName;
        let name = `${idName}_${symbol.OriginalName}`;
        if (globalNames.has(name) || usedLocalNames.has(name)) {
          let tries = nameCounts.get(name) ?? 1;
          const prefix = name;
          for (;;) {
            tries++;
            name = prefix + tries;
            if (!globalNames.has(name) && !usedLocalNames.has(name)) { nameCounts.set(prefix, tries); break; }
          }
        }
        mangledProps.set(refKey(r), name);
        usedLocalNames.add(name);
      }
    }
  }

  /** Go: func (c *linkerContext) createWrapperForFile (linker.go:2425) —— 第 179 批 */
  createWrapperForFile(sourceIndex: number): void {
    const repr = this.graph.Files[sourceIndex].InputFile.Repr as JSReprNS;
    const rt = this.graph.Files[runtimeSourceIndex].InputFile.Repr as JSReprNS;
    if (repr.Meta.Wrap === 1 /* WrapCJS */) {
      const parts = rt.TopLevelSymbolToParts(this.cjsRuntimeRef);
      const deps = parts.map((pi) => { const d = new js_astNS.Dependency(); d.SourceIndex = runtimeSourceIndex; d.PartIndex = pi; return d; });
      const part = new js_astNS.Part();
      const su1 = new js_astNS.SymbolUse(); su1.CountEstimate = 1;
      part.SymbolUses.set(refKey(repr.AST.WrapperRef), su1);
      part.DeclaredSymbols = [
        { Ref: repr.AST.ExportsRef, IsTopLevel: true },
        { Ref: repr.AST.ModuleRef, IsTopLevel: true },
        { Ref: repr.AST.WrapperRef, IsTopLevel: true },
      ] as any;
      part.Dependencies = deps;
      const pi = this.graph.AddPartToFile(sourceIndex, part);
      repr.Meta.WrapperPartIndex = astNS.MakeIndex32(pi);
      this.graph.GenerateSymbolImportAndUse(sourceIndex, pi, this.cjsRuntimeRef, 1, runtimeSourceIndex);
    } else if (repr.Meta.Wrap === 2 /* WrapESM */) {
      const parts = rt.TopLevelSymbolToParts(this.esmRuntimeRef);
      const deps = parts.map((pi) => { const d = new js_astNS.Dependency(); d.SourceIndex = runtimeSourceIndex; d.PartIndex = pi; return d; });
      const part = new js_astNS.Part();
      const su1 = new js_astNS.SymbolUse(); su1.CountEstimate = 1;
      part.SymbolUses.set(refKey(repr.AST.WrapperRef), su1);
      part.DeclaredSymbols = [{ Ref: repr.AST.WrapperRef, IsTopLevel: true }] as any;
      part.Dependencies = deps;
      const pi = this.graph.AddPartToFile(sourceIndex, part);
      repr.Meta.WrapperPartIndex = astNS.MakeIndex32(pi);
      this.graph.GenerateSymbolImportAndUse(sourceIndex, pi, this.esmRuntimeRef, 1, runtimeSourceIndex);
    }
  }

  /** Go: func (c *linkerContext) generateCodeForLazyExport (linker.go:2110) —— 第 179 批 */
  generateCodeForLazyExport(sourceIndex: number): void {
    const file = this.graph.Files[sourceIndex];
    const repr = file.InputFile.Repr as JSReprNS;
    if (repr.AST.Parts.length < 1) throw new Error("Internal error");
    const part = repr.AST.Parts[repr.AST.Parts.length - 1];
    if (part.Stmts.length !== 1) throw new Error("Internal error");
    const lazyStmt = part.Stmts[0].Data as js_astNS.SLazyExport;
    const lazyLoc = part.Stmts[0].Loc;
    const lazyValue = lazyStmt.Value;
    // CSS stub 分支（repr.CSSSourceIndex.IsValid()）本探针未覆盖，结构上不在此处重建。

    if (repr.AST.ExportsKind === js_astNS.ExportsKind.ExportsCommonJS) {
      const dot = new js_astNS.EDot();
      dot.Target = new js_astNS.Expr(new js_astNS.EIdentifier(repr.AST.ModuleRef), lazyValue.Loc);
      dot.Name = "exports"; dot.NameLoc = lazyValue.Loc;
      part.Stmts = [js_ast_helpers.AssignStmt(new js_astNS.Expr(dot, lazyValue.Loc), lazyValue)];
      this.graph.GenerateSymbolImportAndUse(sourceIndex, 0, repr.AST.ModuleRef, 1, sourceIndex);
      return;
    }

    part.Stmts = [];
    const generateExport = (loc: any, name: string, alias: string): [astNS.Ref, number] => {
      const r = this.graph.GenerateNewSymbol(sourceIndex, astNS.SymbolKind.SymbolOther, name);
      const p = new js_astNS.Part();
      p.DeclaredSymbols = [{ Ref: r, IsTopLevel: true }] as any;
      p.CanBeRemovedIfUnused = true;
      const pi = this.graph.AddPartToFile(sourceIndex, p);
      this.graph.GenerateSymbolImportAndUse(sourceIndex, pi, repr.AST.ModuleRef, 1, sourceIndex);
      repr.Meta.TopLevelSymbolToPartsOverlay.set(refKey(r), [pi]);
      const d = new ExportDataNS(); d.Ref = r; d.NameLoc = loc; d.SourceIndex = sourceIndex;
      repr.Meta.ResolvedExports.set(alias, d);
      return [r, pi];
    };

    if (lazyValue.Data instanceof js_astNS.EObject && file.InputFile.Loader !== Loader.LoaderWithTypeJSON) {
      for (const prop of lazyValue.Data.Properties) {
        if (prop.Key.Data instanceof js_astNS.EString &&
            (!file.IsEntryPoint() || IsIdentifierUTF16(prop.Key.Data.Value) ||
             !HasFeature(this.options.UnsupportedJSFeatures ?? 0n, BigInt(StringToJSFeature["arbitrary-module-namespace-names"] ?? 1)))) {
          const name = new TextDecoder().decode(UTF16ToString(prop.Key.Data.Value));
          if (name !== "default") {
            const [r, pi] = generateExport(prop.Key.Loc, name, name);
            const decl = new js_astNS.Decl();
            decl.Binding = new js_astNS.Binding(); decl.Binding.Data = new js_astNS.BIdentifier(r);
            decl.ValueOrNil = prop.ValueOrNil ?? new js_astNS.Expr();
            const sl = new js_astNS.SLocal(); sl.IsExport = true; sl.Decls = [decl];
            repr.AST.Parts[pi].Stmts = [new js_astNS.Stmt(sl, prop.Key.Loc)];
          }
        }
      }
    }

    const defaultName = file.InputFile.Source.IdentifierName + "_default";
    const [dref, dpi] = generateExport(lazyValue.Loc, defaultName, "default");
    const lr = new astNS.LocRef(lazyValue.Loc, dref);
    const se = new js_astNS.SExportDefault();
    se.DefaultName = lr;
    const sExpr = new js_astNS.SExpr(); sExpr.Value = lazyValue;
    se.Value = new js_astNS.Stmt(sExpr, lazyValue.Loc);
    repr.AST.Parts[dpi].Stmts = [new js_astNS.Stmt(se, lazyValue.Loc)];
  }
}

// ============================================================================
// 第 145 批：chunk 助手（findImportedCSSFilesInJSOrder / shouldIncludePart / pathBetweenChunks）
// ============================================================================

/** Go: func (c *linkerContext) findImportedCSSFilesInJSOrder (linker.go:3329) */
export function findImportedCSSFilesInJSOrder(c: linkerContext, entryPoint: number): number[] {
  const visited = new Set<number>();
  const order: number[] = [];
  const visit = (sourceIndex: number): void => {
    if (visited.has(sourceIndex)) return;
    visited.add(sourceIndex);
    const file = c.graph.Files[sourceIndex];
    const repr = file.InputFile.Repr as JSReprNS;
    for (const part of repr.AST.Parts) {
      for (const ri of part.ImportRecordIndices) {
        const record = repr.AST.ImportRecords[ri];
        if (record.SourceIndex !== undefined) visit(record.SourceIndex);
      }
    }
    if (repr.CSSSourceIndex.IsValid()) order.push(repr.CSSSourceIndex.GetIndex());
  };
  visit(entryPoint);
  return order;
}

/** Go: func (c *linkerContext) shouldIncludePart (linker.go:4129) */
export function shouldIncludePart(c: linkerContext, repr: JSReprNS, part: js_astNS.Part): boolean {
  if (part.Stmts.length === 1) {
    const d = part.Stmts[0].Data;
    if (d instanceof js_astNS.SImport) {
      const record = repr.AST.ImportRecords[d.ImportRecordIndex];
      if (record.SourceIndex !== undefined && (c.graph.Files[record.SourceIndex].InputFile.Repr as JSReprNS).Meta.Wrap === 0) return false;
    }
  }
  return true;
}

/** Go: func (c *linkerContext) pathBetweenChunks (linker.go:887) */
export function pathBetweenChunks(c: linkerContext, fromRelDir: string, toRelPath: string): string {
  if (c.options.PublicPath && c.options.PublicPath !== "") return joinWithPublicPath(c.options.PublicPath, toRelPath);
  const rel = c.fs.Rel(fromRelDir, toRelPath);
  if (!rel || rel.ok === false) return "";
  let relPath: string = typeof rel === "string" ? rel : (rel.value ?? "");
  relPath = relPath.replace(/\\/g, "/");
  if (!relPath.startsWith("./") && !relPath.startsWith("../")) relPath = "./" + relPath;
  return relPath;
}

// ============================================================================
// 第 146 批：mergeAdjacentLocalStmts（chunk stmt 合并，linker.go:4590）
// ============================================================================
/** Go: func mergeAdjacentLocalStmts (linker.go:4590) */
export function mergeAdjacentLocalStmts(stmts: js_astNS.Stmt[]): js_astNS.Stmt[] {
  if (stmts.length === 0) return stmts;
  let didMergeWithPreviousLocal = false;
  let end = 1;
  for (let i = 1; i < stmts.length; i++) {
    const stmt = stmts[i];
    const after = stmt.Data;
    const before = stmts[end - 1].Data;
    if (after instanceof js_astNS.SLocal && before instanceof js_astNS.SLocal &&
        before.Kind === after.Kind && before.IsExport === after.IsExport) {
      if (didMergeWithPreviousLocal) {
        before.Decls.push(...after.Decls);
      } else {
        didMergeWithPreviousLocal = true;
        const clone = new js_astNS.SLocal();
        clone.Decls = before.Decls.concat(after.Decls);
        clone.Kind = before.Kind; clone.IsExport = before.IsExport;
        const ns = new js_astNS.Stmt(); ns.Loc = stmts[end - 1].Loc; ns.Data = clone;
        stmts[end - 1] = ns;
      }
      continue;
    }
    didMergeWithPreviousLocal = false;
    stmts[end] = stmt;
    end++;
  }
  return stmts.slice(0, end);
}

// ============================================================================
// 第 147 批：chunk 计算底座（chunkInfo / computeChunks / CSS & JS 顺序）
// Go 探针 chunk-compute-go.json（sha256 681346d0…）逐字节固化。
// 复刻 Go 的两个真实口径：①findImportedFilesInCSSOrder 用 16 个零初始化的
// visited 数组（source index 0 被假判为已访问，真实 esbuild 不会给文件分配 0）；
// ②entryBits.String() Go 返回字节串，TS 用 fromCharCode 保持字典序一致。
// ============================================================================

function asRef(r: { SourceIndex: number; InnerIndex: number }): astNS.Ref {
  return r instanceof astNS.Ref ? r : new astNS.Ref(r.SourceIndex, r.InnerIndex);
}
function refFromKey(k: string): astNS.Ref {
  const i = k.indexOf(":");
  return new astNS.Ref(Number(k.slice(0, i)), Number(k.slice(i + 1)));
}

/** Go: entryBits.String() 的 TS 表示——Uint8Array → 等序字符串 */
function bitsKey(bits: BitSet): string {
  let s = "";
  for (const b of bits.String()) s += String.fromCharCode(b);
  return s;
}

/** Go: func (c *linkerContext) findImportedPartsInJSOrder(chunk *chunkInfo) (js []uint32, jsParts []partRange) (linker.go:4144) */
export function findImportedPartsInJSOrder(c: linkerContext, chunk: chunkInfo): [number[], partRange[]] {
  type CO = { sourceIndex: number; distance: number; tieBreaker: number };
  const sorted: CO[] = [];
  for (const sourceIndex of chunk.filesWithPartsInChunk) {
    const file = c.graph.Files[sourceIndex];
    sorted.push({ sourceIndex, distance: file.DistanceFromEntryPoint, tieBreaker: c.graph.StableSourceIndices[sourceIndex] });
  }
  // Go sort.Sort(chunkOrderArray) 用 (distance, tieBreaker) 全序；tieBreaker 唯一
  sorted.sort((a, b) => a.distance - b.distance || a.tieBreaker - b.tieBreaker);

  const visited = new Set<number>();
  const js: number[] = [];
  let jsParts: partRange[] = [];
  let jsPartsPrefix: partRange[] = [];

  const visit = (sourceIndex: number): void => {
    if (visited.has(sourceIndex)) return;
    visited.add(sourceIndex);
    const file = c.graph.Files[sourceIndex];
    const repr = file.InputFile.Repr;
    if (repr instanceof JSReprNS) {
      let isFileInThisChunk = chunk.entryBits.Equals(file.EntryBits);
      const canFileBeSplit = repr.Meta.Wrap === 0; // WrapNone

      if (canFileBeSplit && isFileInThisChunk && repr.AST.Parts[js_astNS.NSExportPartIndex].IsLive) {
        jsParts = appendOrExtendPartRange(jsParts, sourceIndex, js_astNS.NSExportPartIndex);
      }

      for (let partIndex = 0; partIndex < repr.AST.Parts.length; partIndex++) {
        const part = repr.AST.Parts[partIndex];
        const isPartInThisChunk = isFileInThisChunk && part.IsLive;
        for (const importRecordIndex of part.ImportRecordIndices) {
          const record = repr.AST.ImportRecords[importRecordIndex];
          if (record.SourceIndex !== undefined && (record.Kind === astNS.ImportKind.ImportStmt || isPartInThisChunk)) {
            if (c.isExternalDynamicImport(record, sourceIndex)) continue;
            visit(record.SourceIndex);
          }
        }
        if (isPartInThisChunk) {
          isFileInThisChunk = true;
          if (canFileBeSplit && partIndex !== js_astNS.NSExportPartIndex && shouldIncludePart(c, repr, part)) {
            if (sourceIndex === runtimeSourceIndex) {
              jsPartsPrefix = appendOrExtendPartRange(jsPartsPrefix, sourceIndex, partIndex);
            } else {
              jsParts = appendOrExtendPartRange(jsParts, sourceIndex, partIndex);
            }
          }
        }
      }

      if (isFileInThisChunk) {
        js.push(sourceIndex);
        if (!canFileBeSplit) {
          jsPartsPrefix.push({ sourceIndex, partIndexBegin: 0, partIndexEnd: repr.AST.Parts.length });
        }
      }
    }
  };

  visit(runtimeSourceIndex);
  for (const data of sorted) visit(data.sourceIndex);
  jsParts = jsPartsPrefix.concat(jsParts);
  return [js, jsParts];
}

/** Go: func (c *linkerContext) findImportedFilesInCSSOrder(entryPoints []uint32) (order []cssImportOrder) (linker.go:3411) */
export function findImportedFilesInCSSOrder(c: linkerContext, entryPoints: number[]): cssImportOrder[] {
  let order: cssImportOrder[] = [];
  let hasExternalImport = false;

  // Go: visited 是 [16]uint32 零初始化数组；每次递归拿到的是「含 16 个零」的切片副本，
  // 兄弟分支互不可见（Go slice 值传递）。用数组 + 每次递归 slice 拷贝复刻。
  const visit = (
    sourceIndex: number,
    visited: number[],
    wrappingConditions: ImportConditions[],
    wrappingImportRecords: any[],
  ): void => {
    for (const seen of visited) if (seen === sourceIndex) return;
    const v2 = visited.concat([sourceIndex]);
    const repr = c.graph.Files[sourceIndex].InputFile.Repr as CSSReprNS;
    const astAny = repr.AST as any;
    const topLevelRules: css_astNS.Rule[] = astAny.Rules ?? [];

    if (astAny.LayersPreImport && astAny.LayersPreImport.length > 0) {
      order.push({ kind: cssImportLayers, layers: astAny.LayersPreImport, conditions: wrappingConditions,
        conditionImportRecords: wrappingImportRecords, sourceIndex: 0, externalPath: null });
    }

    for (const rule of topLevelRules) {
      const atImport = rule.Data as css_astNS.RAtImport;
      if (!(atImport instanceof css_astNS.RAtImport)) continue;
      const record = astAny.ImportRecords[atImport.ImportRecordIndex];
      if (record.SourceIndex !== undefined) {
        let nestedConditions = wrappingConditions;
        let nestedImportRecords = wrappingImportRecords;
        if (atImport.ImportConditions !== null) {
          nestedConditions = wrappingConditions.slice();
          nestedImportRecords = wrappingImportRecords.slice();
          const [cond, outRecords] = atImport.ImportConditions.CloneWithImportRecords(astAny.ImportRecords, nestedImportRecords);
          nestedConditions = nestedConditions.concat([cond]);
          nestedImportRecords = outRecords;
        }
        visit(record.SourceIndex, v2, nestedConditions, nestedImportRecords);
        continue;
      }
      // external import
      if ((record.Flags & astNS.ImportRecordFlags.WasLoadedWithEmptyLoader) === 0) {
        let allConditions = wrappingConditions;
        let allImportRecords = wrappingImportRecords;
        if (atImport.ImportConditions !== null) {
          allConditions = wrappingConditions.slice();
          allImportRecords = wrappingImportRecords.slice();
          const [cond, outRecords] = atImport.ImportConditions.CloneWithImportRecords(astAny.ImportRecords, allImportRecords);
          allConditions = allConditions.concat([cond]);
          allImportRecords = outRecords;
        }
        order.push({ kind: cssImportExternalPath, layers: [], conditions: allConditions,
          conditionImportRecords: allImportRecords, sourceIndex: 0, externalPath: record.Path });
        hasExternalImport = true;
      }
    }

    for (const record of astAny.ImportRecords) {
      if (record.Kind === astNS.ImportKind.ImportComposesFrom && record.SourceIndex !== undefined) {
        visit(record.SourceIndex, v2, wrappingConditions, wrappingImportRecords);
      }
    }

    order.push({ kind: cssImportSourceIndex, layers: [], conditions: wrappingConditions,
      conditionImportRecords: wrappingImportRecords, sourceIndex, externalPath: null });
  };

  const visited0 = new Array<number>(16).fill(0);
  for (const si of entryPoints) visit(si, visited0, [], []);

  const wip0: cssImportOrder[] = [];
  if (hasExternalImport) {
    let isAtLayerPrefix = true;
    for (const entry of order) {
      if ((entry.kind === cssImportLayers && isAtLayerPrefix) || entry.kind === cssImportExternalPath) wip0.push(entry);
      if (entry.kind !== cssImportLayers) isAtLayerPrefix = false;
    }
    isAtLayerPrefix = true;
    for (const entry of order) {
      if ((entry.kind !== cssImportLayers || !isAtLayerPrefix) && entry.kind !== cssImportExternalPath) wip0.push(entry);
      if (entry.kind !== cssImportLayers) isAtLayerPrefix = false;
    }
    order = wip0;
  }

  // 去重：从后往前，重复文件仅保留最后一次（用 layers 替代）
  {
    const sourceIndexDuplicates = new Map<number, number[]>();
    const externalPathDuplicates = new Map<string, number[]>();
    nextBackward: for (let i = order.length - 1; i >= 0; i--) {
      const entry = order[i];
      if (entry.kind === cssImportSourceIndex) {
        const dups = sourceIndexDuplicates.get(entry.sourceIndex) ?? [];
        for (const j of dups) {
          if (isConditionalImportRedundant(entry.conditions, order[j].conditions)) {
            order[i].kind = cssImportLayers;
            order[i].layers = (c.graph.Files[entry.sourceIndex].InputFile.Repr as CSSReprNS).AST.LayersPostImport ?? [];
            continue nextBackward;
          }
        }
        sourceIndexDuplicates.set(entry.sourceIndex, dups.concat([i]));
      } else if (entry.kind === cssImportExternalPath) {
        const key = entry.externalPath.Text;
        const dups = externalPathDuplicates.get(key) ?? [];
        for (const j of dups) {
          if (isConditionalImportRedundant(entry.conditions, order[j].conditions)) {
            order[i].kind = cssImportLayers;
            order[i].layers = [];
            continue nextBackward;
          }
        }
        externalPathDuplicates.set(key, dups.concat([i]));
      }
    }
  }

  // @layer 优化：从前往后
  {
    type Dup = { layers: string[][]; indices: number[] };
    const layerDuplicates: Dup[] = [];
    let wip: cssImportOrder[] = [];
    nextForward: for (let i = 0; i < order.length; i++) {
      const entry = order[i];
      if (entry.kind === cssImportLayers) {
        for (let ci = 0; ci < entry.conditions.length; ci++) {
          const cond = entry.conditions[ci];
          if (cond.Layers !== null && cond.Layers.length === 1 && cond.Layers[0].Children == null) {
            entry.conditions = entry.conditions.slice(0, ci);
            entry.layers = [];
            break;
          }
        }
        if (entry.layers.length === 0) {
          for (let ci = entry.conditions.length - 1; ci >= 0; ci--) {
            if (entry.conditions[ci].Layers.length > 0) break;
            entry.conditions = entry.conditions.slice(0, ci);
          }
        }
        if (entry.conditions.length === 0 && entry.layers.length === 0) continue;
      }
      let layersKey = entry.layers;
      if (entry.kind === cssImportSourceIndex) {
        layersKey = (c.graph.Files[entry.sourceIndex].InputFile.Repr as CSSReprNS).AST.LayersPostImport ?? [];
      }
      let idx = 0;
      while (idx < layerDuplicates.length && !strArrArrEqual(layersKey, layerDuplicates[idx].layers)) idx++;
      if (idx === layerDuplicates.length) layerDuplicates.push({ layers: layersKey, indices: [] });
      let duplicates = layerDuplicates[idx].indices;
      for (let j = duplicates.length - 1; j >= 0; j--) {
        const ii = duplicates[j];
        if (isConditionalImportRedundant(entry.conditions, wip[ii].conditions)) {
          if (entry.kind !== cssImportLayers) {
            if (j === duplicates.length - 1 && ii === wip.length - 1) {
              const other = wip[ii];
              if (other.kind === cssImportLayers && importConditionsAreEqual(entry.conditions, other.conditions)) {
                duplicates = duplicates.slice(0, j);
                wip = wip.slice(0, ii);
                break;
              }
            }
            wip.push(entry);
          }
          continue nextForward;
        }
      }
      layerDuplicates[idx].indices = duplicates.concat([wip.length]);
      wip.push(entry);
    }
    order = wip;
  }

  // 合并相邻 @layer
  {
    const wip: cssImportOrder[] = [];
    let didClone = -1;
    for (const entry of order) {
      if (entry.kind === cssImportLayers && wip.length > 0) {
        const prevIndex = wip.length - 1;
        const prev = wip[prevIndex];
        if (prev.kind === cssImportLayers && importConditionsAreEqual(prev.conditions, entry.conditions)) {
          if (didClone !== prevIndex) {
            didClone = prevIndex;
            prev.layers = prev.layers.slice();
          }
          prev.layers = prev.layers.concat(entry.layers);
          continue;
        }
      }
      wip.push(entry);
    }
    order = wip;
  }

  return order;
}
function strArrArrEqual(a: (string[] | null)[], b: (string[] | null)[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x === null || y === null) { if (x !== y) return false; continue; }
    if (x.length !== y.length) return false;
    for (let j = 0; j < x.length; j++) if (x[j] !== y[j]) return false;
  }
  return true;
}

/** Go: func (c *linkerContext) computeChunks() (linker.go:3875) */
export function computeChunks(c: linkerContext): void {
  const jsChunks = new Map<string, chunkInfo>();
  const cssChunks = new Map<string, chunkInfo>();
  const eps = c.graph.EntryPoints();

  for (let i = 0; i < eps.length; i++) {
    const entryPoint = eps[i];
    const file = c.graph.Files[entryPoint.SourceIndex];
    const entryBits = NewBitSet(eps.length);
    entryBits.SetBit(i);
    const key = bitsKey(entryBits);
    const chunk = new chunkInfo();
    chunk.entryBits = entryBits;
    chunk.isEntryPoint = true;
    chunk.sourceIndex = entryPoint.SourceIndex;
    chunk.entryPointBit = i;
    chunk.filesWithPartsInChunk = new Set();

    if (file.InputFile.Repr instanceof JSReprNS) {
      chunk.chunkRepr = new chunkReprJS();
      jsChunks.set(key, chunk);
      const cssSourceIndices = findImportedCSSFilesInJSOrder(c, entryPoint.SourceIndex);
      if (cssSourceIndices.length > 0) {
        const order = findImportedFilesInCSSOrder(c, cssSourceIndices);
        const cssFilesWithParts = new Set<number>();
        for (const entry of order) if (entry.kind === cssImportSourceIndex) cssFilesWithParts.add(entry.sourceIndex);
        const cssChunk = new chunkInfo();
        cssChunk.entryBits = entryBits;
        cssChunk.isEntryPoint = true;
        cssChunk.sourceIndex = entryPoint.SourceIndex;
        cssChunk.entryPointBit = i;
        cssChunk.filesWithPartsInChunk = cssFilesWithParts;
        const cr = new chunkReprCSS(); cr.importsInChunkInOrder = order;
        cssChunk.chunkRepr = cr;
        cssChunks.set(key, cssChunk);
        (chunk.chunkRepr as chunkReprJS).hasCSSChunk = true;
      }
    } else if (file.InputFile.Repr instanceof CSSReprNS) {
      const order = findImportedFilesInCSSOrder(c, [entryPoint.SourceIndex]);
      for (const entry of order) if (entry.kind === cssImportSourceIndex) chunk.filesWithPartsInChunk.add(entry.sourceIndex);
      const cr = new chunkReprCSS(); cr.importsInChunkInOrder = order;
      chunk.chunkRepr = cr;
      cssChunks.set(key, chunk);
    }
  }

  for (const sourceIndex of c.graph.ReachableFiles) {
    const file = c.graph.Files[sourceIndex];
    if (!file.IsLive) continue;
    if (file.InputFile.Repr instanceof JSReprNS) {
      const key = bitsKey(file.EntryBits);
      let chunk = jsChunks.get(key);
      if (!chunk) {
        chunk = new chunkInfo();
        chunk.entryBits = file.EntryBits;
        chunk.filesWithPartsInChunk = new Set();
        chunk.chunkRepr = new chunkReprJS();
        jsChunks.set(key, chunk);
      }
      chunk.filesWithPartsInChunk.add(sourceIndex);
    }
  }

  const sortedChunks: chunkInfo[] = [];
  const jsKeys = [...jsChunks.keys()].sort();
  const jsChunkIndicesForCSS = new Map<string, number>();
  for (const key of jsKeys) {
    const chunk = jsChunks.get(key)!;
    if ((chunk.chunkRepr as chunkReprJS).hasCSSChunk) jsChunkIndicesForCSS.set(key, sortedChunks.length);
    sortedChunks.push(chunk);
  }
  const cssKeys = [...cssChunks.keys()].sort();
  for (const key of cssKeys) {
    const chunk = cssChunks.get(key)!;
    const ji = jsChunkIndicesForCSS.get(key);
    if (ji !== undefined) (sortedChunks[ji].chunkRepr as chunkReprJS).cssChunkIndex = sortedChunks.length;
    sortedChunks.push(chunk);
  }

  for (let chunkIndex = 0; chunkIndex < sortedChunks.length; chunkIndex++) {
    const chunk = sortedChunks[chunkIndex];
    if (!chunk.isEntryPoint) continue;
    const file = c.graph.Files[chunk.sourceIndex];
    if (chunk.chunkRepr instanceof chunkReprCSS && file.InputFile.Repr instanceof JSReprNS) continue;
    file.EntryPointChunkIndex = chunkIndex;
  }

  for (const chunk of sortedChunks) {
    if (chunk.chunkRepr instanceof chunkReprJS) {
      const [filesInOrder, partsInOrder] = findImportedPartsInJSOrder(c, chunk);
      chunk.chunkRepr.filesInChunkInOrder = filesInOrder;
      chunk.chunkRepr.partsInChunkInOrder = partsInOrder;
    }
  }

  for (let chunkIndex = 0; chunkIndex < sortedChunks.length; chunkIndex++) {
    const chunk = sortedChunks[chunkIndex];
    chunk.uniqueKey = c.uniqueKeyPrefix + "C" + String(chunkIndex).padStart(8, "0");
    let stdExt: string;
    if (chunk.chunkRepr instanceof chunkReprJS) stdExt = c.options.OutputExtensionJS;
    else stdExt = c.options.OutputExtensionCSS;

    let dir: string, base: string, ext: string;
    let template: configNS.PathTemplate[];
    if (chunk.isEntryPoint) {
      const file = c.graph.Files[chunk.sourceIndex];
      template = file.IsUserSpecifiedEntryPoint() ? c.options.EntryPathTemplate : c.options.ChunkPathTemplate;
      if (c.options.AbsOutputFile && c.options.AbsOutputFile !== "") {
        dir = "/";
        base = c.fs.Base(c.options.AbsOutputFile);
        const originalExt = c.fs.Ext(base);
        base = base.slice(0, base.length - originalExt.length);
        if (file.InputFile.Repr instanceof CSSReprNS || stdExt !== c.options.OutputExtensionCSS) ext = originalExt;
        else ext = stdExt;
      } else {
        const [d, b] = bundlerNS.PathRelativeToOutbase(file.InputFile, c.options, c.fs,
          !file.IsUserSpecifiedEntryPoint(), eps[chunk.entryPointBit].OutputPath);
        dir = d; base = b; ext = stdExt;
      }
    } else {
      dir = "/"; base = "chunk"; ext = stdExt;
      template = c.options.ChunkPathTemplate;
    }
    const templateExt = ext.startsWith(".") ? ext.slice(1) : ext;
    const withExt = template.concat([mkTemplate(ext)]);
    chunk.finalTemplate = configNS.SubstituteTemplate(withExt, mkPlaceholders(dir, base, templateExt));
  }
  c.chunks = sortedChunks;
}
function mkTemplate(data: string): configNS.PathTemplate {
  const t = new configNS.PathTemplate(); t.Data = data; t.Placeholder = configNS.PathPlaceholder.NoPlaceholder; return t;
}
function mkPlaceholders(dir: string, name: string, ext: string): configNS.PathPlaceholders {
  const p = new configNS.PathPlaceholders();
  p.Dir = dir; p.Name = name; p.Ext = ext; p.Hash = null;
  return p;
}

// ============================================================================
// 第 148 批：交叉 chunk 依赖（computeCrossChunkDependencies + 2 sort helper）
// Go 探针 cross-chunk-deps-go.json（sha256 0353a26b…）逐字节固化。
// ============================================================================

/** Go: func (c *linkerContext) sortedCrossChunkImports (linker.go:1222) */
export function sortedCrossChunkImports(c: linkerContext, importsFromOtherChunks: Map<number, crossChunkImportItemArray>): crossChunkImportArray {
  const result = new crossChunkImportArray();
  for (const [otherChunkIndex, importItems] of importsFromOtherChunks) {
    const otherChunk = c.chunks[otherChunkIndex];
    const exportsToOtherChunks = (otherChunk.chunkRepr as chunkReprJS).exportsToOtherChunks;
    for (const item of importItems.entries) item.exportAlias = exportsToOtherChunks.get(refKey(item.ref)) ?? "";
    importItems.entries.sort((a, b) => a.exportAlias < b.exportAlias ? -1 : a.exportAlias > b.exportAlias ? 1 : 0);
    result.entries.push({ chunkIndex: otherChunkIndex, sortedImportItems: importItems.entries });
  }
  result.entries.sort((a, b) => a.chunkIndex - b.chunkIndex);
  return result;
}

/** Go: func (c *linkerContext) sortedCrossChunkExportItems (linker.go:1282) */
export function sortedCrossChunkExportItems(c: linkerContext, exportRefs: Set<string>): stableRefArray {
  const result = new stableRefArray();
  for (const k of exportRefs) {
    const ref = refFromKey(k);
    result.entries.push({ StableSourceIndex: c.graph.StableSourceIndices[ref.SourceIndex], Ref: ref });
  }
  result.entries.sort((a, b) => a.StableSourceIndex - b.StableSourceIndex ||
    (a.StableSourceIndex === b.StableSourceIndex && a.Ref.InnerIndex - b.Ref.InnerIndex));
  return result;
}

interface ccChunkMeta { imports: Set<string>; exports: Set<string>; dynamicImports: Set<number> | null; }

/** Go: func (c *linkerContext) computeCrossChunkDependencies (linker.go:913) */
export function computeCrossChunkDependencies(c: linkerContext): void {
  if (!c.options.CodeSplitting) return; // Go: 无 code splitting 不可能有跨 chunk 依赖

  const chunkMetas: ccChunkMeta[] = c.chunks.map(() => ({ imports: new Set(), exports: new Set(), dynamicImports: null }));

  // 逐 chunk 收集：本 chunk 用到的符号 + 声明的符号（Go 并行，TS 顺序，确定性一致）
  for (let chunkIndex = 0; chunkIndex < c.chunks.length; chunkIndex++) {
    const chunk = c.chunks[chunkIndex];
    const meta = chunkMetas[chunkIndex];
    for (const sourceIndex of chunk.filesWithPartsInChunk) {
      const repr = c.graph.Files[sourceIndex].InputFile.Repr;
      if (!(repr instanceof JSReprNS)) continue;
      for (let partIndex = 0; partIndex < repr.AST.Parts.length; partIndex++) {
        const part = repr.AST.Parts[partIndex];
        if (!part.IsLive) continue;
        // 外部 dynamic import 改指向目标 chunk 的 uniqueKey
        for (const importRecordIndex of part.ImportRecordIndices) {
          const record = repr.AST.ImportRecords[importRecordIndex];
          if (record.SourceIndex !== undefined && c.isExternalDynamicImport(record, sourceIndex)) {
            const otherChunkIndex = c.graph.Files[record.SourceIndex].EntryPointChunkIndex;
            record.Path.Text = c.chunks[otherChunkIndex].uniqueKey;
            record.SourceIndex = undefined as any;
            record.Flags |= astNS.ImportRecordFlags.ShouldNotBeExternalInMetafile | astNS.ImportRecordFlags.ContainsUniqueKey;
            if (otherChunkIndex !== chunkIndex) {
              if (meta.dynamicImports === null) meta.dynamicImports = new Set();
              meta.dynamicImports.add(otherChunkIndex);
            }
          }
        }
        // 顶层声明符号 → 记录其所在 chunk
        for (const declared of part.DeclaredSymbols) {
          if (declared.IsTopLevel) astNS.Get(c.graph.Symbols, declared.Ref).ChunkIndex = astNS.MakeIndex32(chunkIndex);
        }
        // 使用符号 → imports
        for (const k of part.SymbolUses.keys()) {
          let ref = refFromKey(k);
          const symbol = astNS.Get(c.graph.Symbols, ref);
          if (symbol.Kind === astNS.SymbolKind.SymbolUnbound) continue;
          if (symbol.ImportItemStatus === astNS.ImportItemStatus.ImportItemMissing) continue;
          const bind = repr.Meta.ImportsToBind.get(k);
          if (bind !== undefined) {
            ref = bind.Ref;
          } else if (repr.Meta.Wrap === 1 /* WrapCJS */ && !ref.Equals(repr.AST.WrapperRef)) {
            continue;
          }
          const sym2 = astNS.Get(c.graph.Symbols, ref);
          if (sym2.NamespaceAlias !== null) ref = sym2.NamespaceAlias.NamespaceRef;
          meta.imports.add(refKey(ref));
        }
      }
    }
    // entry chunk：导出符号
    if (chunk.isEntryPoint) {
      const repr = c.graph.Files[chunk.sourceIndex].InputFile.Repr;
      if (repr instanceof JSReprNS) {
        if (repr.Meta.Wrap !== 1 /* WrapCJS */) {
          for (const alias of repr.Meta.SortedAndFilteredExportAliases) {
            const exp = repr.Meta.ResolvedExports.get(alias);
            if (exp === undefined) continue;
            let targetRef = exp.Ref;
            const expFile = c.graph.Files[exp.SourceIndex].InputFile.Repr;
            if (expFile instanceof JSReprNS) {
              const bind = expFile.Meta.ImportsToBind.get(refKey(targetRef));
              if (bind !== undefined) targetRef = bind.Ref;
            }
            const sym = astNS.Get(c.graph.Symbols, targetRef);
            if (sym.NamespaceAlias !== null) targetRef = sym.NamespaceAlias.NamespaceRef;
            meta.imports.add(refKey(targetRef));
          }
        }
        if (repr.Meta.ForceIncludeExportsForEntryPoint) meta.imports.add(refKey(repr.AST.ExportsRef));
        if (repr.Meta.Wrap !== 0 /* WrapNone */) meta.imports.add(refKey(repr.AST.WrapperRef));
      }
    }
  }

  // 把 imports 中来自其它 chunk 的符号登记为 importsFromOtherChunks + exports
  for (let chunkIndex = 0; chunkIndex < c.chunks.length; chunkIndex++) {
    const chunk = c.chunks[chunkIndex];
    const chunkRepr = chunk.chunkRepr;
    if (!(chunkRepr instanceof chunkReprJS)) continue;
    const meta = chunkMetas[chunkIndex];
    chunkRepr.importsFromOtherChunks = new Map();
    for (const k of meta.imports) {
      const ref = refFromKey(k);
      const ci = astNS.Get(c.graph.Symbols, ref).ChunkIndex;
      if (!ci.IsValid()) continue;
      const otherChunkIndex = ci.GetIndex();
      if (otherChunkIndex !== chunkIndex) {
        let arr = chunkRepr.importsFromOtherChunks.get(otherChunkIndex);
        if (!arr) { arr = new crossChunkImportItemArray(); chunkRepr.importsFromOtherChunks.set(otherChunkIndex, arr); }
        arr.entries.push({ exportAlias: "", ref });
        chunkMetas[otherChunkIndex].exports.add(k);
      }
    }
    // entry chunk 强制 import 属于该 entry 的所有 chunk
    if (chunk.isEntryPoint) {
      for (let otherChunkIndex = 0; otherChunkIndex < c.chunks.length; otherChunkIndex++) {
        const otherChunk = c.chunks[otherChunkIndex];
        if (otherChunk.chunkRepr instanceof chunkReprJS && chunkIndex !== otherChunkIndex &&
            otherChunk.entryBits.HasBit(chunk.entryPointBit)) {
          if (!chunkRepr.importsFromOtherChunks.has(otherChunkIndex)) chunkRepr.importsFromOtherChunks.set(otherChunkIndex, new crossChunkImportItemArray());
        }
      }
    }
    if (meta.dynamicImports !== null) {
      const sorted = [...meta.dynamicImports].sort((a, b) => a - b);
      for (const ci of sorted) chunk.crossChunkImports.push({ importKind: astNS.ImportKind.ImportDynamic, chunkIndex: ci });
    }
  }

  // 生成跨 chunk 导出别名（先于导入，别名需全局一致）
  for (let chunkIndex = 0; chunkIndex < c.chunks.length; chunkIndex++) {
    const chunk = c.chunks[chunkIndex];
    const chunkRepr = chunk.chunkRepr;
    if (!(chunkRepr instanceof chunkReprJS)) continue;
    chunkRepr.exportsToOtherChunks = new Map();
    const r = new ExportRenamer();
    const items: js_astNS.ClauseItem[] = [];
    for (const exportRef of sortedCrossChunkExportItems(c, chunkMetas[chunkIndex].exports).entries) {
      const alias = c.options.MinifyIdentifiers ? r.NextMinifiedName()
        : r.NextRenamedName(astNS.Get(c.graph.Symbols, asRef(exportRef.Ref)).OriginalName);
      const item = new js_astNS.ClauseItem(); item.Name = new astNS.LocRef(new Loc(0), asRef(exportRef.Ref)); item.Alias = alias;
      items.push(item);
      chunkRepr.exportsToOtherChunks.set(refKey(asRef(exportRef.Ref)), alias);
    }
    if (items.length > 0) {
      const st = new js_astNS.Stmt(); const sec = new js_astNS.SExportClause(); sec.Items = items; st.Data = sec;
      chunkRepr.crossChunkSuffixStmts = [st];
    }
  }

  // 生成跨 chunk 导入语句（需导出别名已定稿）
  for (let chunkIndex = 0; chunkIndex < c.chunks.length; chunkIndex++) {
    const chunk = c.chunks[chunkIndex];
    const chunkRepr = chunk.chunkRepr;
    if (!(chunkRepr instanceof chunkReprJS)) continue;
    const crossChunkPrefixStmts: js_astNS.Stmt[] = [];
    for (const crossChunkImport of sortedCrossChunkImports(c, chunkRepr.importsFromOtherChunks).entries) {
      const items: js_astNS.ClauseItem[] = [];
      for (const item of crossChunkImport.sortedImportItems) {
        const ci = new js_astNS.ClauseItem(); ci.Name = new astNS.LocRef(new Loc(0), item.ref); ci.Alias = item.exportAlias;
        items.push(ci);
      }
      const importRecordIndex = chunk.crossChunkImports.length;
      chunk.crossChunkImports.push({ importKind: astNS.ImportKind.ImportStmt, chunkIndex: crossChunkImport.chunkIndex });
      const st = new js_astNS.Stmt(); const si = new js_astNS.SImport(); si.ImportRecordIndex = importRecordIndex;
      if (items.length > 0) si.Items = items;
      st.Data = si;
      crossChunkPrefixStmts.push(st);
    }
    chunkRepr.crossChunkPrefixStmts = crossChunkPrefixStmts;
  }
}

// ============================================================================
// 第 149 批：输出装配底座（intermediateOutput ↔ 最终输出往返）
// Go 探针 output-pieces-go.json（sha256 4ac8d072…）逐字节固化。
// ============================================================================

/** Go: func (c *linkerContext) breakOutputIntoPieces(output []byte) intermediateOutput (linker.go:6744) */
export function breakOutputIntoPieces(c: linkerContext, output: Uint8Array): intermediateOutput {
  const pieces: outputPiece[] = [];
  const prefix = c.uniqueKeyPrefixBytes;
  const enc = new TextEncoder();
  for (;;) {
    // bytes.Index(output, prefix)
    let boundary = -1;
    outer: for (let i = 0; i + prefix.length <= output.length; i++) {
      let ok = true;
      for (let j = 0; j < prefix.length; j++) if (output[i + j] !== prefix[j]) { ok = false; break; }
      if (ok) { boundary = i; break outer; }
    }
    let kind = outputPieceNone;
    let index = 0;
    if (boundary !== -1) {
      const start = boundary + prefix.length;
      if (start + 9 > output.length) {
        boundary = -1;
      } else {
        const tag = output[start];
        if (tag === 0x41 /* 'A' */) kind = outputPieceAssetIndex;
        else if (tag === 0x43 /* 'C' */) kind = outputPieceChunkIndex;
        for (let j = 1; j < 9; j++) {
          const ch = output[start + j];
          if (ch < 0x30 || ch > 0x39) { boundary = -1; break; }
          index = index * 10 + (ch - 0x30);
        }
      }
    }
    // Validate boundary
    if (kind === outputPieceAssetIndex) {
      if (index >= c.graph.Files.length) boundary = -1;
    } else if (kind === outputPieceChunkIndex) {
      if (index >= c.chunks.length) boundary = -1;
    } else {
      boundary = -1;
    }
    if (boundary === -1) {
      pieces.push({ data: output, index: 0, kind: outputPieceNone });
      break;
    }
    pieces.push({ data: output.slice(0, boundary), index, kind });
    output = output.slice(boundary + prefix.length + 9);
  }
  return { pieces, joiner: null };
}

/** Go: func (c *linkerContext) breakJoinerIntoPieces(j helpers.Joiner) intermediateOutput (linker.go:6734) */
export function breakJoinerIntoPieces(c: linkerContext, j: Joiner): intermediateOutput {
  if (!j.Contains(c.uniqueKeyPrefixBytes, c.uniqueKeyPrefixBytes)) return { pieces: null, joiner: j };
  return breakOutputIntoPieces(c, j.Done());
}

/** Go: func (c *linkerContext) substituteFinalPaths (linker.go:804) */
export function substituteFinalPaths(c: linkerContext, io: intermediateOutput, modifyPath: (s: string) => string): [Joiner, SourceMapShift[]] {
  const j = new Joiner();
  if (io.pieces === null) return [io.joiner, [new SourceMapShift()]];
  const shift = new SourceMapShift();
  const shifts: SourceMapShift[] = [new SourceMapShift()];
  const dec = new TextDecoder();
  for (const piece of io.pieces) {
    const dataOffset = new LineColumnOffset();
    j.AddBytes(piece.data);
    dataOffset.AdvanceBytes(piece.data);
    shift.Before.Add(dataOffset);
    shift.After.Add(dataOffset);
    if (piece.kind === outputPieceAssetIndex) {
      const file = c.graph.Files[piece.index].InputFile;
      const rel = c.fs.Rel(c.options.AbsOutputDir, file.AdditionalFiles[0].AbsPath);
      let relPath: string = rel.value.replace(/\\/g, "/");
      const importPath = modifyPath(relPath);
      j.AddString(new TextEncoder().encode(importPath));
      shift.Before.AdvanceString(file.UniqueKeyForAdditionalFile);
      shift.After.AdvanceString(importPath);
      shifts.push(cloneShift(shift));
    } else if (piece.kind === outputPieceChunkIndex) {
      const chunk = c.chunks[piece.index];
      const importPath = modifyPath(chunk.finalRelPath);
      j.AddString(new TextEncoder().encode(importPath));
      shift.Before.AdvanceString(chunk.uniqueKey);
      shift.After.AdvanceString(importPath);
      shifts.push(cloneShift(shift));
    }
  }
  return [j, shifts];
}
function cloneShift(s: SourceMapShift): SourceMapShift {
  const out = new SourceMapShift();
  out.Before.Lines = s.Before.Lines; out.Before.Columns = s.Before.Columns;
  out.After.Lines = s.After.Lines; out.After.Columns = s.After.Columns;
  return out;
}

/** Go: func (c *linkerContext) accurateFinalByteCount(output, chunkFinalRelDir) int (linker.go:856) */
export function accurateFinalByteCount(c: linkerContext, output: intermediateOutput, chunkFinalRelDir: string): number {
  let count = 0;
  for (const piece of output.pieces ?? []) {
    count += piece.data.length;
    if (piece.kind === outputPieceAssetIndex) {
      const file = c.graph.Files[piece.index].InputFile;
      const rel = c.fs.Rel(c.options.AbsOutputDir, file.AdditionalFiles[0].AbsPath);
      const relPath = rel.value.replace(/\\/g, "/");
      count += pathBetweenChunks(c, chunkFinalRelDir, relPath).length;
    } else if (piece.kind === outputPieceChunkIndex) {
      const chunk = c.chunks[piece.index];
      count += pathBetweenChunks(c, chunkFinalRelDir, chunk.finalRelPath).length;
    }
  }
  return count;
}

// ============================================================================
// 第 150 批：isolated hash 簇（generateIsolatedHash / generateIsolatedHashInParallel /
// appendIsolatedHashesForImportedChunks），Go 探针 isolated-hash-go.json（ad9d0a94…）逐字节。
// ============================================================================
function hashAdapter(digest: { Write: (b: Uint8Array) => unknown }): { update: (b: Uint8Array) => void } {
  return { update: (b: Uint8Array) => { digest.Write(b); } };
}

/** Go: func (c *linkerContext) generateIsolatedHash(chunk *chunkInfo, channel chan []byte) (linker.go:6822) */
export function generateIsolatedHash(c: linkerContext, chunk: chunkInfo): Uint8Array {
  const digest = NewHash();
  const h = hashAdapter(digest);
  const enc = new TextEncoder();
  if (chunk.chunkRepr instanceof chunkReprJS) {
    for (const pr of chunk.chunkRepr.partsInChunkInOrder) {
      const file = c.graph.Files[pr.sourceIndex].InputFile;
      let filePath: string;
      if (file.Source.KeyPath.Namespace === "file") filePath = (file.Source.PrettyPaths as any).Rel;
      else filePath = file.Source.KeyPath.Text;
      hashWriteLengthPrefixed(h, enc.encode(file.Source.KeyPath.Namespace));
      hashWriteLengthPrefixed(h, enc.encode(filePath));
      h.update(hashWriteUint32(pr.partIndexBegin));
      h.update(hashWriteUint32(pr.partIndexEnd));
    }
  }
  for (const part of chunk.finalTemplate) hashWriteLengthPrefixed(h, enc.encode(part.Data));
  if (c.options.PublicPath && c.options.PublicPath !== "") hashWriteLengthPrefixed(h, enc.encode(c.options.PublicPath));
  if (chunk.intermediateOutput.pieces !== null) {
    for (const piece of chunk.intermediateOutput.pieces) hashWriteLengthPrefixed(h, piece.data);
  } else {
    hashWriteLengthPrefixed(h, chunk.intermediateOutput.joiner.Done());
  }
  const osm = chunk.outputSourceMap ?? { Prefix: new Uint8Array(0), Mappings: new Uint8Array(0), Suffix: new Uint8Array(0) };
  hashWriteLengthPrefixed(h, osm.Prefix ?? new Uint8Array(0));
  hashWriteLengthPrefixed(h, osm.Mappings ?? new Uint8Array(0));
  hashWriteLengthPrefixed(h, osm.Suffix ?? new Uint8Array(0));
  return digest.Sum(new Uint8Array(0));
}

/** Go: func (c *linkerContext) generateIsolatedHashInParallel(chunk *chunkInfo) (linker.go:6810) */
export function generateIsolatedHashInParallel(c: linkerContext, chunk: chunkInfo): void {
  let cached: Uint8Array | null = null;
  chunk.waitForIsolatedHash = (): Uint8Array => {
    if (cached === null) cached = generateIsolatedHash(c, chunk);
    return cached;
  };
}

/** Go: func (c *linkerContext) appendIsolatedHashesForImportedChunks(hash, chunkIndex, visited, visitedKey) (linker.go:6692) */
export function appendIsolatedHashesForImportedChunks(
  c: linkerContext, digest: { Write: (b: Uint8Array) => unknown }, chunkIndex: number, visited: number[], visitedKey: number,
): void {
  if (visited[chunkIndex] === visitedKey) return;
  visited[chunkIndex] = visitedKey;
  const chunk = c.chunks[chunkIndex];
  const h = hashAdapter(digest);
  const enc = new TextEncoder();
  for (const ci of chunk.crossChunkImports) appendIsolatedHashesForImportedChunks(c, digest, ci.chunkIndex, visited, visitedKey);
  for (const piece of chunk.intermediateOutput.pieces ?? []) {
    if (piece.kind === outputPieceAssetIndex) {
      const file = c.graph.Files[piece.index].InputFile;
      const rel = c.fs.Rel(c.options.AbsOutputDir, file.AdditionalFiles[0].AbsPath);
      hashWriteLengthPrefixed(h, enc.encode(rel.value.replace(/\\/g, "/")));
    }
  }
  h.update(chunk.waitForIsolatedHash!());
}

// ============================================================================
// 第 151 批：chunk 生成链纯助手底座（Go 探针 gen-helpers-go.json，a0e0bf33…）。
// 这 5 个 helper 是 generateChunkJS/CSS 的前置底座，逐字节固化。
// ============================================================================

/** Go: func (c *linkerContext) requireOrImportMetaForSource (linker.go:4650) */
export function requireOrImportMetaForSource(c: linkerContext, sourceIndex: number): { WrapperRef: astNS.Ref; ExportsRef: astNS.Ref; IsWrapperAsync: boolean } {
  const repr = c.graph.Files[sourceIndex].InputFile.Repr as JSReprNS;
  const meta = { WrapperRef: repr.AST.WrapperRef, ExportsRef: astNS.InvalidRef, IsWrapperAsync: repr.Meta.IsAsyncOrHasAsyncDependency };
  meta.WrapperRef = repr.AST.WrapperRef;
  if (repr.Meta.Wrap === 2 /* WrapESM */) meta.ExportsRef = repr.AST.ExportsRef;
  return meta;
}

/**
 * Go: func (c *linkerContext) validateComposesFromProperties(rootFile, rootRepr) (linker.go:2030)
 * 第 111 轮：跨文件 composes 属性冲突警告。graph fixture 底座，probe 2 例逐字节。
 */
export function validateComposesFromProperties(c: linkerContext, rootFile: graphNS.LinkerFile, rootRepr: CSSReprNS): void {
  for (const local of (rootRepr.AST as any).LocalSymbols as astNS.LocRef[]) {
    const visited = new Set<string>();
    const properties = new Map<string, { file: graphNS.LinkerFile | null; loc: number }>();

    const visit = (file: graphNS.LinkerFile, repr: CSSReprNS, ref: astNS.Ref): void => {
      const vk = refKey(ref);
      if (visited.has(vk)) return;
      visited.add(vk);

      const composes = (repr.AST as any).Composes.get(refKey(ref));
      if (!composes) return;

      for (const name of composes.ImportedNames as any[]) {
        const record = (repr.AST as any).ImportRecords[name.ImportRecordIndex];
        if (record && record.SourceIndex !== 0) {
          const otherFile = c.graph.Files[record.SourceIndex];
          const otherRepr = otherFile?.InputFile.Repr;
          if (otherRepr instanceof CSSReprNS) {
            const otherName = (otherRepr.AST as any).LocalScope.get(name.Alias);
            if (otherName) visit(otherFile, otherRepr as CSSReprNS, otherName.Ref);
          }
        }
      }

      for (const name of composes.Names as astNS.LocRef[]) visit(file, repr, name.Ref);

      for (const [keyText, keyLoc] of (composes.Properties as Map<string, number>)) {
        const existing = properties.get(keyText);
        if (!existing) { properties.set(keyText, { file, loc: keyLoc }); continue; }
        if (existing.file === file || existing.file === null) continue;

        const localOriginalName = c.graph.Symbols.SymbolsForSource[local.Ref.SourceIndex]?.[local.Ref.InnerIndex]?.OriginalName ?? "";
        const msg = new Msg();
        msg.Kind = MsgKind.Warning;
        msg.Data = rootFile.LineColumnTracker().MsgData(CssRangeOfIdentifier(rootFile.InputFile.Source, new Loc(local.Loc.Start)),
          `The value of ${JSON.stringify(keyText)} in the ${JSON.stringify(localOriginalName)} class is undefined`);
        msg.Notes = [
          existing.file.LineColumnTracker().MsgData(CssRangeOfIdentifier(existing.file.InputFile.Source, new Loc(existing.loc)),
            `The first definition of ${JSON.stringify(keyText)} is here:`),
          file.LineColumnTracker().MsgData(CssRangeOfIdentifier(file.InputFile.Source, new Loc(keyLoc)),
            `The second definition of ${JSON.stringify(keyText)} is here:`),
          { Text: `The specification of "composes" does not define an order when class declarations from separate files are composed together. ` +
            `The value of the ${JSON.stringify(keyText)} property for ${JSON.stringify(localOriginalName)} may change unpredictably as the code is edited. ` +
            `Make sure that all definitions of ${JSON.stringify(keyText)} for ${JSON.stringify(localOriginalName)} are in a single file.` } as any,
        ];
        AddMsgID(c.log!, 40 /* MsgID_CSS_UndefinedComposesFrom */, msg);

        existing.file = null;
        properties.set(keyText, existing);
      }
    };

    visit(rootFile, rootRepr, local.Ref);
  }
}

/** Go: func (c *linkerContext) maybeForbidArbitraryModuleNamespaceIdentifier (linker.go:2867) */
export function maybeForbidArbitraryModuleNamespaceIdentifier(c: linkerContext, kind: string, sourceIndex: number, loc: number, alias: string): void {
  if (!IsIdentifier(new TextEncoder().encode(alias))) {
    const file = c.graph.Files[sourceIndex];
    const where = configNS.PrettyPrintTargetEnvironment(c.options.OriginalTargetEnv ?? "", c.options.UnsupportedJSFeatureOverridesMask ?? 0);
    AddError(c.log!, file.LineColumnTracker(), file.InputFile.Source.RangeOfString(new Loc(loc)),
      `Using the string "${alias}" as an ${kind} name is not supported in ${where}`);
  }
}

/** Go: legalCommentEntry (linker.go) */
export interface legalCommentEntry { sourceIndex: number; comments: string[]; }

/** Go: func (c *linkerContext) maybeAppendLegalComments (linker.go:6549) */
export function maybeAppendLegalComments(c: linkerContext, legalComments: number, legalCommentList: legalCommentEntry[], chunk: chunkInfo, j: any, slashTag: string): void {
  const LC = configNS.LegalComments;
  if (legalComments === LC.LegalCommentsNone || legalComments === LC.LegalCommentsInline) return;
  type Third = { packagePaths: string[]; comments: string[] };
  const enc = new TextEncoder();
  const uniqueFirstPartyComments: string[] = [];
  const thirdPartyComments: Third[] = [];
  const hasFirstPartyComment = new Set<string>();

  for (const entry of legalCommentList) {
    const source = c.graph.Files[entry.sourceIndex].InputFile.Source;
    let packagePath = "";
    if (source.KeyPath.Namespace !== "dataurl") {
      const path = source.KeyPath.Text;
      let previous = path.length;
      while (previous > 0) {
        let slash = -1;
        for (let k = previous - 1; k >= 0; k--) { if (path[k] === "\\" || path[k] === "/") { slash = k; break; } }
        const component = path.slice(slash + 1, previous);
        if (component === "node_modules") {
          if (previous < path.length) packagePath = path.slice(previous + 1).replace(/\\/g, "/");
          break;
        }
        previous = slash;
      }
    }
    if (packagePath !== "") {
      thirdPartyComments.push({ packagePaths: [packagePath], comments: entry.comments });
    } else {
      for (const comment of entry.comments) {
        if (!hasFirstPartyComment.has(comment)) { hasFirstPartyComment.add(comment); uniqueFirstPartyComments.push(comment); }
      }
    }
  }

  // Merge package paths with identical comments
  const identical = new Map<string, number>();
  let end = 0;
  for (const entry of thirdPartyComments) {
    const key = entry.comments.join("\0");
    const idx = identical.get(key);
    if (idx !== undefined) thirdPartyComments[idx].packagePaths.push(...entry.packagePaths);
    else { identical.set(key, end); thirdPartyComments[end] = entry; end++; }
  }
  thirdPartyComments.length = end;

  const esc = (text: string): string => new TextDecoder().decode(EscapeClosingTag(enc.encode(text), enc.encode(slashTag)));
  if (legalComments === LC.LegalCommentsEndOfFile) {
    for (const comment of uniqueFirstPartyComments) { j.AddString(enc.encode(esc(comment))); j.AddString(enc.encode("\n")); }
    if (thirdPartyComments.length > 0) {
      j.AddString(enc.encode("/*! Bundled license information:\n"));
      for (const entry of thirdPartyComments) {
        j.AddString(enc.encode("\n"));
        for (const pp of entry.packagePaths) j.AddString(enc.encode(`${esc(pp)}:\n`));
        for (let comment of entry.comments) {
          comment = esc(comment);
          if (comment.startsWith("//")) j.AddString(enc.encode(`  (*${comment.slice(2)} *)\n`));
          else if (comment.startsWith("/*") && comment.endsWith("*/")) {
            j.AddString(enc.encode(`  (${comment.slice(1, comment.length - 1).replace(/\n/g, "\n  ")})\n`));
          }
        }
      }
      j.AddString(enc.encode("*/\n"));
    }
  } else {
    let jComments: any = new (j.constructor as any)();
    for (const comment of uniqueFirstPartyComments) { jComments.AddString(enc.encode(comment)); jComments.AddString(enc.encode("\n")); }
    if (thirdPartyComments.length > 0) {
      if (uniqueFirstPartyComments.length > 0) jComments.AddString(enc.encode("\n"));
      jComments.AddString(enc.encode("Bundled license information:\n"));
      for (const entry of thirdPartyComments) {
        jComments.AddString(enc.encode("\n"));
        for (const pp of entry.packagePaths) jComments.AddString(enc.encode(`${pp}:\n`));
        for (const comment of entry.comments) jComments.AddString(enc.encode(`  ${comment.replace(/\n/g, "\n  ")}\n`));
      }
    }
    chunk.externalLegalComments = jComments.Done();
  }
}

/** Go: func wrapRulesWithConditions (linker.go:6478) */
export function wrapRulesWithConditions(rules: css_astNS.Rule[], importRecords: any[], conditions: css_astNS.ImportConditions[], conditionImportRecords: any[]): [css_astNS.Rule[], any[]] {
  for (let i = conditions.length - 1; i >= 0; i--) {
    const item = conditions[i];
    for (const t of item.Layers) {
      if (rules.length === 0) {
        if (t.Children === null || t.Children === undefined) continue;
        else rules = [];
      }
      let prelude: css_astNS.Token[] = t.Children ? t.Children.slice() : [];
      [prelude, importRecords] = css_astNS.CloneTokensWithImportRecords(prelude, conditionImportRecords, null, importRecords);
      const rk = new css_astNS.RKnownAt(); rk.AtToken = "layer"; rk.Prelude = prelude; rk.Rules = rules;
      const rr = new css_astNS.Rule(); rr.Data = rk;
      rules = [rr];
    }
    if (rules.length > 0) {
      for (let t0 of item.Supports) {
        const t = new css_astNS.Token(); t.Kind = 33 /* TOpenParen */; t.Text = "(";
        let prelude: css_astNS.Token[] = [t];
        [prelude, importRecords] = css_astNS.CloneTokensWithImportRecords(prelude, conditionImportRecords, null, importRecords);
        const rk = new css_astNS.RKnownAt(); rk.AtToken = "supports"; rk.Prelude = prelude; rk.Rules = rules;
        const rr = new css_astNS.Rule(); rr.Data = rk;
        rules = [rr];
      }
    }
    if (rules.length > 0 && item.Queries.length > 0) {
      const [queries, out] = css_astNS.CloneMediaQueriesWithImportRecords(item.Queries, conditionImportRecords, null, importRecords);
      importRecords = out;
      const rm = new css_astNS.RAtMedia(); rm.Queries = queries; rm.Rules = rules;
      const rr = new css_astNS.Rule(); rr.Data = rm;
      rules = [rr];
    }
  }
  return [rules, importRecords];
}

/** Go: func (c *linkerContext) generateExtraDataForFileJS (debug.go:21) — 实现移至 debug.ts（1:1 文件对齐），此处重导出兼容既有调用 */
export { generateExtraDataForFileJS } from "./debug.ts";

// ============================================================================
// 第 152 批：statement 转换底座（Go 探针 stmt-convert-go.json，3c87665d…）。
// shouldRemoveImportExportStmt + convertStmtsForChunk 把 part stmt 转成 chunk stmt。
// ============================================================================

/** Go: type stmtList struct (linker.go:4630) */
export class stmtList {
  insideWrapperPrefix: js_astNS.Stmt[] = [];
  insideWrapperSuffix: js_astNS.Stmt[] = [];
  outsideWrapperPrefix: js_astNS.Stmt[] = [];
}

const ARBITRARY_MODULE_NAMESPACE_NAMES = BigInt(StringToJSFeature["arbitrary-module-namespace-names"] ?? 0);
function unsupportedHas(c: linkerContext, feature: bigint): boolean {
  const mask = BigInt(c.options.UnsupportedJSFeatures ?? 0);
  return (mask & feature) !== 0n;
}
function makeRequireStmt(loc: number, namespaceRef: astNS.Ref, importRecordIndex: number): js_astNS.Stmt {
  const local = new js_astNS.SLocal();
  const decl = new js_astNS.Decl();
  const binding = new js_astNS.Binding();
  binding.Loc = new Loc(loc);
  const bi = new js_astNS.BIdentifier(); bi.Ref = namespaceRef; binding.Data = bi;
  decl.Binding = binding;
  const req = new js_astNS.ERequireString(); req.ImportRecordIndex = importRecordIndex;
  const val = new js_astNS.Expr(); val.Data = req;
  decl.ValueOrNil = val;
  local.Decls = [decl];
  const st = new js_astNS.Stmt(); st.Loc = new Loc(loc); st.Data = local;
  return st;
}

/** Go: func (c *linkerContext) shouldRemoveImportExportStmt (linker.go:4240) */
export function shouldRemoveImportExportStmt(c: linkerContext, sourceIndex: number, list: stmtList, loc: number, namespaceRef: astNS.Ref, importRecordIndex: number): boolean {
  const repr = c.graph.Files[sourceIndex].InputFile.Repr as JSReprNS;
  const record = repr.AST.ImportRecords[importRecordIndex];
  if (record.SourceIndex === undefined) {
    if (configNS.KeepESMImportExportSyntax(c.options.OutputFormat)) return false;
    list.insideWrapperPrefix.push(makeRequireStmt(loc, namespaceRef, importRecordIndex));
    return true;
  }
  if (repr.AST.ExportsKind === js_astNS.ExportsKind.ExportsCommonJS &&
      astNS.FollowSymbols(c.graph.Symbols, namespaceRef).Equals(repr.AST.ExportsRef)) {
    return true;
  }
  const otherFile = c.graph.Files[record.SourceIndex];
  const otherRepr = otherFile.InputFile.Repr as JSReprNS;
  switch (otherRepr.Meta.Wrap) {
    case 0 /* WrapNone */: break;
    case 1 /* WrapCJS */:
      list.insideWrapperPrefix.push(makeRequireStmt(loc, namespaceRef, importRecordIndex));
      break;
    case 2 /* WrapESM */:
      if (!otherFile.IsLive) break;
      {
        const call = new js_astNS.ECall();
        const idRef = new js_astNS.EIdentifier(); idRef.Ref = otherRepr.AST.WrapperRef;
        const target = new js_astNS.Expr(); target.Loc = new Loc(loc); target.Data = idRef;
        call.Target = target;
        let value = new js_astNS.Expr(); value.Loc = new Loc(loc); value.Data = call;
        if (otherRepr.Meta.IsAsyncOrHasAsyncDependency) {
          const aw = new js_astNS.EAwait(); aw.Value = value;
          value = new js_astNS.Expr(); value.Loc = new Loc(loc); value.Data = aw;
        }
        const se = new js_astNS.SExpr(); se.Value = value;
        const st = new js_astNS.Stmt(); st.Loc = new Loc(loc); st.Data = se;
        list.insideWrapperPrefix.push(st);
      }
      break;
  }
  return true;
}

/** Go: func (c *linkerContext) convertStmtsForChunk (linker.go:4316) */
export function convertStmtsForChunk(c: linkerContext, sourceIndex: number, list: stmtList, partStmts: js_astNS.Stmt[]): void {
  const file = c.graph.Files[sourceIndex];
  const shouldStripExports = c.options.Mode !== 0 /* ModePassThrough */ || !file.IsEntryPoint();
  const repr = file.InputFile.Repr as JSReprNS;
  const enc = new TextEncoder();
  const shouldExtractESMStmtsForWrap = repr.Meta.Wrap !== 0;
  let moduleExportsForReExportOrNil: js_astNS.Expr | null = null;
  if (c.options.OutputFormat === configNS.Format.FormatCommonJS && file.IsEntryPoint()) {
    const dot = new js_astNS.EDot(); dot.Name = "exports";
    const id = new js_astNS.EIdentifier(); id.Ref = c.unboundModuleRef;
    const tgt = new js_astNS.Expr(); tgt.Data = id; dot.Target = tgt;
    moduleExportsForReExportOrNil = new js_astNS.Expr(); moduleExportsForReExportOrNil.Data = dot;
  }
  const runtimeRepr = c.graph.Files[0].InputFile.Repr as JSReprNS;

  for (let stmt of partStmts) {
    const d = stmt.Data;
    if (d instanceof js_astNS.SImport) {
      if (shouldRemoveImportExportStmt(c, sourceIndex, list, stmt.Loc.Start, d.NamespaceRef, d.ImportRecordIndex)) continue;
      if (unsupportedHas(c, ARBITRARY_MODULE_NAMESPACE_NAMES) && d.Items !== null) {
        for (const item of d.Items) maybeForbidArbitraryModuleNamespaceIdentifier(c, "import", sourceIndex, item.AliasLoc.Start, item.Alias);
      }
      if (shouldExtractESMStmtsForWrap) { list.outsideWrapperPrefix.push(stmt); continue; }
    } else if (d instanceof js_astNS.SExportStar) {
      if (d.Alias !== null) {
        if (shouldRemoveImportExportStmt(c, sourceIndex, list, stmt.Loc.Start, d.NamespaceRef, d.ImportRecordIndex)) continue;
        if (unsupportedHas(c, ARBITRARY_MODULE_NAMESPACE_NAMES)) maybeForbidArbitraryModuleNamespaceIdentifier(c, "export", sourceIndex, d.Alias.Loc.Start, d.Alias.OriginalName);
        if (shouldStripExports) {
          const ni = new js_astNS.SImport(); ni.NamespaceRef = d.NamespaceRef; ni.ImportRecordIndex = d.ImportRecordIndex;
          const sl = new Loc(d.Alias.Loc.Start); ni.StarNameLoc = sl; stmt.Data = ni;
        }
        if (shouldExtractESMStmtsForWrap) { list.outsideWrapperPrefix.push(stmt); continue; }
      } else {
        if (shouldStripExports) {
          const record = repr.AST.ImportRecords[d.ImportRecordIndex];
          const keepSyntax = configNS.KeepESMImportExportSyntax(c.options.OutputFormat);
          if (record.SourceIndex === undefined && keepSyntax) {
            if ((record.Flags & astNS.ImportRecordFlags.CallsRunTimeReExportFn) !== 0) {
              const ni = new js_astNS.SImport(); ni.NamespaceRef = d.NamespaceRef; ni.ImportRecordIndex = d.ImportRecordIndex;
              ni.StarNameLoc = new Loc(stmt.Loc.Start); stmt.Data = ni;
              const exportStarRef = (runtimeRepr.AST.ModuleScope!.Members.get("__reExport") as any).Ref as astNS.Ref;
              const args: js_astNS.Expr[] = [];
              const e1 = new js_astNS.EIdentifier(); e1.Ref = repr.AST.ExportsRef;
              const a1 = new js_astNS.Expr(); a1.Loc = stmt.Loc; a1.Data = e1; args.push(a1);
              const e2 = new js_astNS.EIdentifier(); e2.Ref = d.NamespaceRef;
              const a2 = new js_astNS.Expr(); a2.Loc = stmt.Loc; a2.Data = e2; args.push(a2);
              if (moduleExportsForReExportOrNil !== null) args.push(moduleExportsForReExportOrNil);
              list.insideWrapperPrefix.push(makeRuntimeReExportStmt(stmt.Loc.Start, exportStarRef, args));
              if (shouldExtractESMStmtsForWrap) { list.outsideWrapperPrefix.push(stmt); continue; }
            }
          } else {
            if (record.SourceIndex !== undefined) {
              const otherRepr = c.graph.Files[record.SourceIndex].InputFile.Repr as JSReprNS;
              if (otherRepr.Meta.Wrap === 2) {
                list.insideWrapperPrefix.push(makeCallWrapperStmt(stmt.Loc.Start, otherRepr.AST.WrapperRef));
              }
            }
            if ((record.Flags & astNS.ImportRecordFlags.CallsRunTimeReExportFn) !== 0) {
              let target: js_astNS.E | null = null;
              if (record.SourceIndex !== undefined) {
                const otherRepr = c.graph.Files[record.SourceIndex].InputFile.Repr as JSReprNS;
                if (otherRepr.AST.ExportsKind === js_astNS.ExportsKind.ExportsESMWithDynamicFallback) {
                  const e = new js_astNS.EIdentifier(); e.Ref = otherRepr.AST.ExportsRef; target = e;
                }
              }
              if (target === null) { const rq = new js_astNS.ERequireString(); rq.ImportRecordIndex = d.ImportRecordIndex; target = rq; }
              const exportStarRef = (runtimeRepr.AST.ModuleScope!.Members.get("__reExport") as any).Ref as astNS.Ref;
              const args: js_astNS.Expr[] = [];
              const e1 = new js_astNS.EIdentifier(); e1.Ref = repr.AST.ExportsRef;
              const a1 = new js_astNS.Expr(); a1.Loc = stmt.Loc; a1.Data = e1; args.push(a1);
              const a2 = new js_astNS.Expr(); a2.Loc = new Loc(record.Range?.Loc?.Start ?? 0); a2.Data = target; args.push(a2);
              if (moduleExportsForReExportOrNil !== null) args.push(moduleExportsForReExportOrNil);
              list.insideWrapperPrefix.push(makeRuntimeReExportStmt(stmt.Loc.Start, exportStarRef, args));
            }
            continue;
          }
        }
      }
    } else if (d instanceof js_astNS.SExportFrom) {
      if (shouldRemoveImportExportStmt(c, sourceIndex, list, stmt.Loc.Start, d.NamespaceRef, d.ImportRecordIndex)) continue;
      if (unsupportedHas(c, ARBITRARY_MODULE_NAMESPACE_NAMES)) {
        for (const item of d.Items) maybeForbidArbitraryModuleNamespaceIdentifier(c, "import", sourceIndex, item.Name.Loc.Start, item.OriginalName);
      }
      if (shouldStripExports) {
        for (const item of d.Items) item.Alias = item.OriginalName;
        const ni = new js_astNS.SImport(); ni.NamespaceRef = d.NamespaceRef; ni.Items = d.Items;
        ni.ImportRecordIndex = d.ImportRecordIndex; ni.IsSingleLine = d.IsSingleLine; stmt.Data = ni;
      } else if (unsupportedHas(c, ARBITRARY_MODULE_NAMESPACE_NAMES)) {
        for (const item of d.Items) if (item.AliasLoc.Start !== item.Name.Loc.Start) maybeForbidArbitraryModuleNamespaceIdentifier(c, "export", sourceIndex, item.AliasLoc.Start, item.Alias);
      }
      if (shouldExtractESMStmtsForWrap) { list.outsideWrapperPrefix.push(stmt); continue; }
    } else if (d instanceof js_astNS.SExportClause) {
      if (shouldStripExports) continue;
      if (unsupportedHas(c, ARBITRARY_MODULE_NAMESPACE_NAMES)) {
        for (const item of d.Items) maybeForbidArbitraryModuleNamespaceIdentifier(c, "export", sourceIndex, item.AliasLoc.Start, item.Alias);
      }
      if (shouldExtractESMStmtsForWrap) { list.outsideWrapperPrefix.push(stmt); continue; }
    } else if (d instanceof js_astNS.SFunction) {
      if (shouldStripExports && d.IsExport) { const clone = new js_astNS.SFunction(); clone.Fn = d.Fn; clone.IsExport = false; stmt.Data = clone; }
    } else if (d instanceof js_astNS.SClass) {
      if (shouldStripExports && d.IsExport) { const clone = new js_astNS.SClass(); clone.Class = d.Class; clone.IsExport = false; stmt.Data = clone; }
    } else if (d instanceof js_astNS.SLocal) {
      if (shouldStripExports && d.IsExport) { const clone = new js_astNS.SLocal(); clone.Decls = d.Decls; clone.Kind = d.Kind; clone.IsExport = false; clone.WasTSImportEquals = d.WasTSImportEquals; stmt.Data = clone; }
    } else if (d instanceof js_astNS.SExportDefault) {
      if (shouldStripExports) {
        const v = d.Value.Data;
        if (v instanceof js_astNS.SExpr) {
          const local = new js_astNS.SLocal(); const decl = new js_astNS.Decl();
          const b = new js_astNS.Binding(); b.Loc = d.DefaultName.Loc; const bi = new js_astNS.BIdentifier(); bi.Ref = d.DefaultName.Ref; b.Data = bi;
          decl.Binding = b; decl.ValueOrNil = v.Value; local.Decls = [decl];
          const ns = new js_astNS.Stmt(); ns.Loc = stmt.Loc; ns.Data = local; stmt = ns;
        } else if (v instanceof js_astNS.SFunction) {
          const nf = new js_astNS.SFunction(); nf.Fn = v.Fn; nf.Fn.Name = d.DefaultName;
          const ns = new js_astNS.Stmt(); ns.Loc = d.Value.Loc; ns.Data = nf; stmt = ns;
        } else if (v instanceof js_astNS.SClass) {
          const nc = new js_astNS.SClass(); nc.Class = v.Class; nc.Class.Name = d.DefaultName;
          const ns = new js_astNS.Stmt(); ns.Loc = d.Value.Loc; ns.Data = nc; stmt = ns;
        } else { throw new Error("Internal error"); }
      }
    }
    list.insideWrapperSuffix.push(stmt);
  }
}
function makeCallWrapperStmt(loc: number, ref: astNS.Ref): js_astNS.Stmt {
  const call = new js_astNS.ECall(); const id = new js_astNS.EIdentifier(); id.Ref = ref;
  const tgt = new js_astNS.Expr(); tgt.Loc = new Loc(loc); tgt.Data = id; call.Target = tgt;
  const val = new js_astNS.Expr(); val.Loc = new Loc(loc); val.Data = call;
  const se = new js_astNS.SExpr(); se.Value = val;
  const st = new js_astNS.Stmt(); st.Loc = new Loc(loc); st.Data = se; return st;
}
function makeRuntimeReExportStmt(loc: number, exportStarRef: astNS.Ref, args: js_astNS.Expr[]): js_astNS.Stmt {
  const call = new js_astNS.ECall(); const id = new js_astNS.EIdentifier(); id.Ref = exportStarRef;
  const tgt = new js_astNS.Expr(); tgt.Loc = new Loc(loc); tgt.Data = id; call.Target = tgt; call.Args = args;
  const val = new js_astNS.Expr(); val.Loc = new Loc(loc); val.Data = call;
  const se = new js_astNS.SExpr(); se.Value = val;
  const st = new js_astNS.Stmt(); st.Loc = new Loc(loc); st.Data = se; return st;
}

// ============================================================================
// 第 153 批：renameSymbolsInChunk（chunk 符号重命名核心，linker.go:5320，246 行）
// Go 探针 rename-chunk-go.json（288cf9d1…）逐字节固化 NameForSymbol。
// ============================================================================
function refKeyOf(r: astNS.Ref): string { return `${r.SourceIndex}:${r.InnerIndex}`; }

/** Go: func (c *linkerContext) renameSymbolsInChunk (linker.go:5320) */
export function renameSymbolsInChunk(c: linkerContext, chunk: chunkInfo, filesInOrder: number[], timer: TimerNS | null): any {
  timer?.Begin(c.options.MinifyIdentifiers ? "Minify symbols" : "Rename symbols");
  timer?.Begin("Compute reserved names");
  const moduleScopes: js_astNS.Scope[] = filesInOrder.map((si) => (c.graph.Files[si].InputFile.Repr as JSReprNS).AST.ModuleScope!);
  const reservedNames = ComputeReservedNames(moduleScopes, c.graph.Symbols);
  if (c.options.OutputFormat === configNS.Format.FormatCommonJS && c.options.Platform === 1 /* PlatformNode */) {
    reservedNames.set("exports", 1); reservedNames.set("module", 1);
  }
  if (c.options.Mode !== 0 /* ModePassThrough */) { reservedNames.set("require", 1); reservedNames.set("Promise", 1); }
  timer?.End("Compute reserved names");

  const sortedImports = new stableRefArray();
  const cha = (chunk.chunkRepr as chunkReprJS).importsFromOtherChunks;
  for (const imports of cha.values()) {
    for (const item of imports.entries) {
      sortedImports.entries.push({ StableSourceIndex: c.graph.StableSourceIndices[item.ref.SourceIndex], Ref: asRef(item.ref) });
    }
  }
  sortedImports.entries.sort((a, b) => a.StableSourceIndex - b.StableSourceIndex ||
    (a.StableSourceIndex === b.StableSourceIndex && a.Ref.InnerIndex - b.Ref.InnerIndex));

  if (c.options.MinifyIdentifiers) {
    const firstTopLevelSlots = new SlotCounts();
    for (const si of filesInOrder) firstTopLevelSlots.UnionMax((c.graph.Files[si].InputFile.Repr as JSReprNS).AST.NestedScopeSlotCounts);
    const r = NewMinifyRenamer(c.graph.Symbols, firstTopLevelSlots.values.slice(), reservedNames);
    timer?.Begin("Accumulate symbol counts");
    const allTopLevelSymbols: StableSymbolCountArray[] = filesInOrder.map(() => new StableSymbolCountArray());
    const stableSourceIndices = c.graph.StableSourceIndices;
    const freq = new CharFreq();
    for (let i = 0; i < filesInOrder.length; i++) {
      const repr = c.graph.Files[filesInOrder[i]].InputFile.Repr as JSReprNS;
      if (repr.AST.CharFreq) freq.Include(repr.AST.CharFreq);
      const top = allTopLevelSymbols[i];
      if (repr.AST.UsesExportsRef) r.AccumulateSymbolCount(top, repr.AST.ExportsRef, 1, stableSourceIndices);
      if (repr.AST.UsesModuleRef) r.AccumulateSymbolCount(top, repr.AST.ModuleRef, 1, stableSourceIndices);
      for (let partIndex = 0; partIndex < repr.AST.Parts.length; partIndex++) {
        const part = repr.AST.Parts[partIndex];
        if (!part.IsLive) continue;
        r.AccumulateSymbolUseCounts(top, part.SymbolUses, stableSourceIndices);
        for (const declared of part.DeclaredSymbols) r.AccumulateSymbolCount(top, declared.Ref, 1, stableSourceIndices);
      }
      top.items.sort((x, y) => x.Count > y.Count ? -1 : x.Count < y.Count ? 1 :
        x.StableSourceIndex - y.StableSourceIndex || x.RefInnerIndex - y.RefInnerIndex);
    }
    const topLevelSymbols = new StableSymbolCountArray();
    for (const stable of sortedImports.entries) r.AccumulateSymbolCount(topLevelSymbols, asRef(stable.Ref), 1, stableSourceIndices);
    for (const array of allTopLevelSymbols) topLevelSymbols.items.push(...array.items);
    r.AllocateTopLevelSymbolSlots(topLevelSymbols);
    timer?.End("Accumulate symbol counts");
    const minifier = DefaultNameMinifierJS.ShuffleByCharFreq(freq);
    timer?.Begin("Assign names by frequency");
    r.AssignNamesByFrequency(minifier);
    timer?.End("Assign names by frequency");
    timer?.End(c.options.MinifyIdentifiers ? "Minify symbols" : "Rename symbols");
    return r;
  }

  const r = NewNumberRenamer(c.graph.Symbols, reservedNames);
  const nestedScopes = new Map<number, js_astNS.Scope[]>();
  timer?.Begin("Add top-level symbols");
  for (const stable of sortedImports.entries) r.AddTopLevelSymbol(asRef(stable.Ref));
  for (const si of filesInOrder) {
    const repr = c.graph.Files[si].InputFile.Repr as JSReprNS;
    let scopes: js_astNS.Scope[] = [];
    if (repr.Meta.Wrap === 1 /* WrapCJS */) {
      r.AddTopLevelSymbol(repr.AST.WrapperRef);
      nestedScopes.set(si, [repr.AST.ModuleScope!]);
      continue;
    }
    if (repr.Meta.Wrap === 2 /* WrapESM */) r.AddTopLevelSymbol(repr.AST.WrapperRef);
    for (let partIndex = 0; partIndex < repr.AST.Parts.length; partIndex++) {
      if (repr.AST.Parts[partIndex].IsLive) {
        for (const declared of repr.AST.Parts[partIndex].DeclaredSymbols) {
          if (declared.IsTopLevel) r.AddTopLevelSymbol(declared.Ref);
        }
        scopes = scopes.concat(repr.AST.Parts[partIndex].Scopes);
      }
    }
    nestedScopes.set(si, scopes);
  }
  timer?.End("Add top-level symbols");
  timer?.Begin("Assign names by scope");
  r.AssignNamesByScope(nestedScopes);
  timer?.End("Assign names by scope");
  timer?.End(c.options.MinifyIdentifiers ? "Minify symbols" : "Rename symbols");
  return r;
}

// ============================================================================
// 第 154 批：linker 助手簇（Go 探针 linker-helpers-go.json，3113cca1…）。
// enforceNoCyclicChunkImports / preventExportsFromBeingRenamed /
// maybeCorrectObviousTypo / advanceImportTracker / recoverInternalError。
// ============================================================================
export interface importTracker { sourceIndex: number; nameLoc: number; importRef: astNS.Ref; }
export const importNoMatch = 0, importFound = 1, importCommonJS = 2, importDynamicFallback = 3,
  importCommonJSWithoutExports = 4, importDisabled = 5, importExternal = 6, importProbablyTypeScriptType = 7;

/** Go: func (c *linkerContext) enforceNoCyclicChunkImports (linker.go:560) */
export function enforceNoCyclicChunkImports(c: linkerContext): void {
  const colors = new Map<number, number>();
  const validate = (chunkIndex: number): boolean => {
    if (colors.get(chunkIndex) === 1) { AddError(c.log!, null as any, Range0(), "Internal error: generated chunks contain a circular import"); return true; }
    if (colors.get(chunkIndex) === 2) return false;
    colors.set(chunkIndex, 1);
    for (const ci of c.chunks[chunkIndex].crossChunkImports) {
      if (ci.importKind !== astNS.ImportKind.ImportDynamic && validate(ci.chunkIndex)) return true;
    }
    colors.set(chunkIndex, 2);
    return false;
  };
  for (let i = 0; i < c.chunks.length; i++) if (validate(i)) break;
}
// Go: AddError(nil, Range{}, ...) —— tracker 为 nil 时 logger 用默认位置
function Range0(): any { return { Loc: new Loc(0), Len: 0 }; }

/** Go: func (c *linkerContext) preventExportsFromBeingRenamed (linker.go:6927) */
export function preventExportsFromBeingRenamed(c: linkerContext, sourceIndex: number): void {
  const repr = c.graph.Files[sourceIndex].InputFile.Repr;
  if (!(repr instanceof JSReprNS)) return;
  let hasImportOrExport = false;
  for (const part of repr.AST.Parts) {
    for (const stmt of part.Stmts) {
      const d = stmt.Data;
      if (d instanceof js_astNS.SImport) {
        if (repr.AST.ImportRecords[d.ImportRecordIndex].SourceIndex !== undefined) continue;
        hasImportOrExport = true;
      } else if (d instanceof js_astNS.SLocal) {
        if (d.IsExport) {
          ForEachIdentifierBindingInDecls(d.Decls, (_loc, b) => {
            astNS.Get(c.graph.Symbols, b.Ref).Flags |= astNS.SymbolFlags.MustNotBeRenamed;
          });
          hasImportOrExport = true;
        }
      } else if (d instanceof js_astNS.SFunction) {
        if (d.IsExport) { astNS.Get(c.graph.Symbols, d.Fn.Name!.Ref).Kind = astNS.SymbolKind.SymbolUnbound; hasImportOrExport = true; }
      } else if (d instanceof js_astNS.SClass) {
        if (d.IsExport) { astNS.Get(c.graph.Symbols, d.Class.Name!.Ref).Kind = astNS.SymbolKind.SymbolUnbound; hasImportOrExport = true; }
      } else if (d instanceof js_astNS.SExportClause || d instanceof js_astNS.SExportDefault || d instanceof js_astNS.SExportStar || d instanceof js_astNS.SExportFrom) {
        hasImportOrExport = true;
      }
    }
  }
  if (!hasImportOrExport) {
    for (const member of repr.AST.ModuleScope!.Members.values()) astNS.Get(c.graph.Symbols, member.Ref).Flags |= astNS.SymbolFlags.MustNotBeRenamed;
  }
}

/** Go: func (c *linkerContext) maybeCorrectObviousTypo (linker.go:2877) */
export function maybeCorrectObviousTypo(c: linkerContext, repr: JSReprNS, name: string, msg: any): void {
  if (repr.Meta.ResolvedExportTypos === null) {
    const valid = [...repr.Meta.ResolvedExports.keys()].sort();
    repr.Meta.ResolvedExportTypos = MakeTypoDetector(valid);
  }
  const det = repr.Meta.ResolvedExportTypos;
  const corrected = det.MaybeCorrectTypo(name);
  if (corrected.ok) {
    if (!msg.Data.Location) msg.Data.Location = new MsgLocation();
    msg.Data.Location.Suggestion = corrected.value;
    const exp = repr.Meta.ResolvedExports.get(corrected.value);
    if (exp) {
      const importedFile = c.graph.Files[exp.SourceIndex];
      const text = `Did you mean to import "${corrected.value}" instead?`;
      let note: any;
      if ((exp.NameLoc ?? 0) === 0) note = { Text: text };
      else {
        const r = IsCSS(importedFile.InputFile.Loader)
          ? CssRangeOfIdentifier(importedFile.InputFile.Source, new Loc(exp.NameLoc))
          : JsRangeOfIdentifier(importedFile.InputFile.Source, new Loc(exp.NameLoc));
        note = importedFile.LineColumnTracker().MsgData(r, text);
      }
      msg.Notes.push(note);
    }
  }
}

/** Go: func (c *linkerContext) advanceImportTracker (linker.go:3087) */
export function advanceImportTracker(c: linkerContext, tracker: importTracker): [importTracker, number, any[]] {
  const file = c.graph.Files[tracker.sourceIndex];
  const repr = file.InputFile.Repr as JSReprNS;
  const namedImport = repr.AST.NamedImports.get(refKey(tracker.importRef))!;
  const record = repr.AST.ImportRecords[namedImport.ImportRecordIndex];
  if (record.SourceIndex === undefined) return [{ sourceIndex: 0, nameLoc: 0, importRef: new astNS.Ref(0, 0) }, importExternal, []];
  const otherSourceIndex = record.SourceIndex;
  const otherRepr = c.graph.Files[otherSourceIndex].InputFile.Repr as JSReprNS;
  if (!namedImport.AliasIsStar && !otherRepr.AST.HasLazyExport && otherRepr.AST.ExportKeyword.Len === 0 && namedImport.Alias !== "default" && !otherRepr.AST.UsesExportsRef && !otherRepr.AST.UsesModuleRef) {
    return [{ sourceIndex: otherSourceIndex, nameLoc: 0, importRef: astNS.InvalidRef }, importCommonJSWithoutExports, []];
  }
  if (otherRepr.AST.ExportsKind === js_astNS.ExportsKind.ExportsCommonJS) {
    return [{ sourceIndex: otherSourceIndex, nameLoc: 0, importRef: astNS.InvalidRef }, importCommonJS, []];
  }
  const matchingStar = otherRepr.Meta.ResolvedExportStar;
  if (namedImport.AliasIsStar && matchingStar != null) {
    return [{ sourceIndex: matchingStar.SourceIndex, nameLoc: matchingStar.NameLoc ?? 0, importRef: matchingStar.Ref }, importFound, matchingStar.PotentiallyAmbiguousExportStarRefs ?? []];
  }
  const matchingExport = otherRepr.Meta.ResolvedExports.get(namedImport.Alias);
  if (matchingExport) {
    return [{ sourceIndex: matchingExport.SourceIndex, nameLoc: matchingExport.NameLoc ?? 0, importRef: matchingExport.Ref }, importFound, matchingExport.PotentiallyAmbiguousExportStarRefs ?? []];
  }
  if (otherRepr.AST.ExportsKind === js_astNS.ExportsKind.ExportsESMWithDynamicFallback) {
    return [{ sourceIndex: otherSourceIndex, nameLoc: 0, importRef: otherRepr.AST.ExportsRef }, importDynamicFallback, []];
  }
  if (IsTypeScript(file.InputFile.Loader) && namedImport.IsExported) return [{ sourceIndex: 0, nameLoc: 0, importRef: new astNS.Ref(0, 0) }, importProbablyTypeScriptType, []];
  return [{ sourceIndex: otherSourceIndex, nameLoc: 0, importRef: new astNS.Ref(0, 0) }, importNoMatch, []];
}

/** Go: func (c *linkerContext) recoverInternalError (linker.go:7258)
 * TS 无 Go 的 defer/recover，故显式传入捕获到的异常 panicValue（无异常传 undefined 即 no-op）。
 * waitGroup.done 在 Go panic 路径调用以平衡 defer 外的 Add。 */
export function recoverInternalError(c: linkerContext, waitGroup: { done: () => void }, sourceIndex: number, panicValue?: unknown): void {
  if (panicValue === undefined) return;
  let text = `panic: ${String(panicValue)}`;
  if (sourceIndex !== 0 /* runtime.SourceIndex */) {
    const p = c.graph.Files[sourceIndex].InputFile.Source.PrettyPaths;
    text = `${text} (while printing "${p.Rel}")`;
  }
  AddErrorWithNotes(c.log!, null, Range0(), text, [{ Text: String(panicValue) } as any]);
  waitGroup.done();
}

// ============================================================================
// 第 155 批：generateSourceMapForChunk（chunk sourcemap 生成，linker.go:7001，254 行）
// Go 探针 sourcemap-chunk-go.json（7b80333d…）逐字节固化 Prefix/Mappings/Suffix。
// ============================================================================
export interface compileResultForSourceMap {
  sourceMapChunk: any; // sourcemap.Chunk
  generatedOffset: { Lines: number; Columns: number };
  sourceIndex: number;
  isNullEntry: boolean;
}

/** Go: func (c *linkerContext) generateSourceMapForChunk (linker.go:7001) */
export function generateSourceMapForChunk(c: linkerContext, results: compileResultForSourceMap[], chunkAbsDir: string, dataForSourceMaps: any[], canHaveShifts: boolean): { Prefix: Uint8Array; Mappings: Uint8Array; Suffix: Uint8Array } {
  const j: any = new Joiner();
  j.AddString(new TextEncoder().encode("{\n  \"version\": 3"));
  const sourceIndexToSourcesIndex = new Map<number, number>();
  type Item = { source: string; quotedContents: Uint8Array };
  const items: Item[] = [];
  let nextSourcesIndex = 0;
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  for (const result of results) {
    if (result.isNullEntry) continue;
    if (sourceIndexToSourcesIndex.has(result.sourceIndex)) continue;
    sourceIndexToSourcesIndex.set(result.sourceIndex, nextSourcesIndex);
    const file = c.graph.Files[result.sourceIndex].InputFile;
    const src = file.Source;
    if (!file.InputSourceMap) {
      let quotedContents = new Uint8Array(0);
      if (!c.options.ExcludeSourcesContent) quotedContents = dataForSourceMaps[result.sourceIndex]?.QuotedContents?.[0] ?? new Uint8Array(0);
      let source = src.KeyPath.Text;
      if (src.KeyPath.Namespace === "file") {
        source = FileURLFromFilePath(source).toString();
      } else {
        if (src.KeyPath.Namespace !== "") source = `${src.KeyPath.Namespace}:${source}`;
        source += src.KeyPath.IgnoredSuffix ?? "";
      }
      items.push({ source, quotedContents });
      nextSourcesIndex++;
      continue;
    }
    const sm = file.InputSourceMap;
    for (let i = 0; i < sm.Sources.length; i++) {
      let quotedContents = new Uint8Array(0);
      if (!c.options.ExcludeSourcesContent) quotedContents = dataForSourceMaps[result.sourceIndex]?.QuotedContents?.[i] ?? new Uint8Array(0);
      items.push({ source: sm.Sources[i], quotedContents });
    }
    nextSourcesIndex += sm.Sources.length;
  }

  j.AddString(enc.encode(",\n  \"sources\": ["));
  for (let i = 0; i < items.length; i++) {
    if (i !== 0) j.AddString(enc.encode(", "));
    let source = items[i].source;
    // Go: url.Parse + IsFileURL -> FilePathFromFileURL -> fs.Rel(chunkAbsDir, path) -> url.URL{Path:...}.String()
    try {
      const u = new URL(source);
      if (IsFileURL(u)) {
        const sourcePath = FilePathFromFileURL(c.fs, u);
        const rel = c.fs.Rel(chunkAbsDir, sourcePath);
        if (rel.ok) {
          let relativeURL = rel.value.replace(/\\/g, "/");
          // Go url.URL{Path: relPath}.String() percent-encodes the path WITHOUT
          // normalizing ".." segments (unlike WHATWG URL). Use encodeURI on the
          // already-forward-slash path, preserving ".." and ":"; Go leaves those.
          source = relativeURL.split("/").map((seg) => encodeURIComponent(seg).replace(/%2F/g, "/")).join("/");
          source = source.replace(/%20/g, " ");
        }
      }
    } catch (_) { /* url.Parse failed: use as-is */ }
    j.AddBytes(QuoteForJSON(enc.encode(source), !!c.options.ASCIIOnly));
  }
  j.AddString(enc.encode("]"));

  if (c.options.SourceRoot && c.options.SourceRoot !== "") {
    j.AddString(enc.encode(",\n  \"sourceRoot\": "));
    j.AddBytes(QuoteForJSON(enc.encode(c.options.SourceRoot), !!c.options.ASCIIOnly));
  }
  if (!c.options.ExcludeSourcesContent) {
    j.AddString(enc.encode(",\n  \"sourcesContent\": ["));
    for (let i = 0; i < items.length; i++) {
      if (i !== 0) j.AddString(enc.encode(", "));
      j.AddBytes(items[i].quotedContents);
    }
    j.AddString(enc.encode("]"));
  }
  j.AddString(enc.encode(",\n  \"mappings\": \""));
  const mappingsStart = j.Length();
  const prevEndState = new SourceMapState();
  let prevColumnOffset = 0;
  let totalQuotedNameLen = 0;
  for (const result of results) {
    const chunk = result.sourceMapChunk;
    const offset = result.generatedOffset;
    let sourcesIndex = sourceIndexToSourcesIndex.get(result.sourceIndex);
    if (sourcesIndex === undefined) {
      sourcesIndex = 0;
      if (!result.isNullEntry) throw new Error("Internal error");
    }
    const startState = new SourceMapState();
    startState.SourceIndex = sourcesIndex;
    startState.GeneratedLine = offset.Lines;
    startState.GeneratedColumn = offset.Columns;
    startState.OriginalName = totalQuotedNameLen;
    if (offset.Lines === 0) startState.GeneratedColumn += prevColumnOffset;
    if (result.isNullEntry) {
      chunk.Buffer.Data = enc.encode("A");
      chunk.Buffer.FirstNameOffset = new astNS.Index32();
      AppendSourceMapChunk(j, prevEndState, startState, chunk.Buffer);
      prevEndState.GeneratedLine = startState.GeneratedLine;
      prevEndState.GeneratedColumn = startState.GeneratedColumn;
    } else {
      AppendSourceMapChunk(j, prevEndState, startState, chunk.Buffer);
      const prevOriginalName = prevEndState.OriginalName;
      const es = chunk.EndState;
      prevEndState.SourceIndex = es.SourceIndex + sourcesIndex;
      prevEndState.GeneratedLine = es.GeneratedLine;
      prevEndState.GeneratedColumn = es.GeneratedColumn;
      prevEndState.OriginalLine = es.OriginalLine;
      prevEndState.OriginalColumn = es.OriginalColumn;
      prevEndState.OriginalName = es.OriginalName;
      prevEndState.HasOriginalName = es.HasOriginalName;
      if (chunk.Buffer.FirstNameOffset.IsValid()) prevEndState.OriginalName += totalQuotedNameLen;
      else prevEndState.OriginalName = prevOriginalName;
      prevColumnOffset = chunk.FinalGeneratedColumn;
      totalQuotedNameLen += chunk.QuotedNames.length;
    }
    if (prevEndState.GeneratedLine === 0) {
      prevEndState.GeneratedColumn += startState.GeneratedColumn;
      prevColumnOffset += startState.GeneratedColumn;
    }
  }
  const mappingsEnd = j.Length();
  j.AddString(enc.encode("\",\n  \"names\": ["));
  let isFirstName = true;
  for (const result of results) {
    for (const qn of (result.sourceMapChunk?.QuotedNames ?? [])) {
      if (!isFirstName) j.AddString(enc.encode(", "));
      isFirstName = false;
      j.AddBytes(new Uint8Array(qn));
    }
  }
  j.AddString(enc.encode("]\n}\n"));
  const bytes = j.Done();
  if (!canHaveShifts) return { Prefix: bytes, Mappings: new Uint8Array(0), Suffix: new Uint8Array(0) };
  return { Prefix: bytes.slice(0, mappingsStart), Mappings: bytes.slice(mappingsStart, mappingsEnd), Suffix: bytes.slice(mappingsEnd) };
}

// ============================================================================
// 第 156 批：generateChunkJS / generateChunkCSS 本体（linker.go:5568/:6098）
// Go 探针 chunkjs-go.json（60941054…）逐字节固化最终 intermediateOutput。
// ============================================================================
function flattenSymbolsForPrint(c: linkerContext): any[] {
  const out: any[] = [];
  for (const arr of c.graph.Symbols.SymbolsForSource) if (arr) for (const s of arr) out.push(s);
  return out;
}
function printerOptions(c: linkerContext): JsPrintOptions {
  const o = new JsPrintOptions();
  o.OutputFormat = c.options.OutputFormat ?? 0;
  o.MinifyIdentifiers = !!c.options.MinifyIdentifiers;
  o.MinifyWhitespace = !!c.options.MinifyWhitespace;
  o.MinifySyntax = !!c.options.MinifySyntax;
  o.ASCIIOnly = !!c.options.ASCIIOnly;
  o.LineLimit = c.options.LineLimit ?? 0;
  o.NeedsMetafile = !!c.options.NeedsMetafile;
  o.LegalComments = c.options.LegalComments ?? 0;
  o.UnsupportedFeatures = BigInt(c.options.UnsupportedJSFeatures ?? 0);
  return o;
}

/** Go: func (c *linkerContext) generateChunkJS(chunkIndex, chunkWaitGroup) (linker.go:5568) */
export function generateChunkJS(c: linkerContext, chunkIndex: number, waitGroup: { done: () => void }): void {
  const chunk = c.chunks[chunkIndex];
  const chunkRepr = chunk.chunkRepr as chunkReprJS;
  const runtimeFile = c.graph.Files[0].InputFile.Repr as JSReprNS;
  const rtMembers = runtimeFile.AST.ModuleScope!.Members;
  const follow = (r: astNS.Ref): astNS.Ref => astNS.FollowSymbols(c.graph.Symbols, r);
  const toCommonJSRef = follow((rtMembers.get("__toCommonJS") as any).Ref);
  const toESMRef = follow((rtMembers.get("__esm") as any).Ref);
  const runtimeRequireRef = follow((rtMembers.get("__require") as any).Ref);
  const r = renameSymbolsInChunk(c, chunk, chunkRepr.filesInChunkInOrder, null);
  const dataForSourceMaps: any[] = c.dataForSourceMaps ? c.dataForSourceMaps() : [];
  const enc = new TextEncoder();
  const j = new Joiner();
  let prevOffset = new LineColumnOffset();
  let indent = "", space = " ", newline = "\n";
  if (c.options.MinifyWhitespace) { space = ""; newline = ""; }
  let newlineBeforeComment = false;
  let isExecutable = false;

  // Compile each file's parts (single-threaded; Go parallel but deterministic)
  // We inline the print of each part via js_printer.Print to avoid needing generateCodeForFileInChunkJS base separately.
  const printOpts = printerOptions(c);
  const flatSymbols = flattenSymbolsForPrint(c);
  const compileResults: any[] = [];
  for (const pr of chunkRepr.partsInChunkInOrder) {
    if (pr.sourceIndex === 0 && c.options.OmitRuntimeForTests) continue;
    const repr = c.graph.Files[pr.sourceIndex].InputFile.Repr as JSReprNS;
    const parts = repr.AST.Parts.slice(pr.partIndexBegin, pr.partIndexEnd).filter((p) => p.IsLive);
    const astForPrint = new js_astNS.AST();
    astForPrint.Parts = parts;
    astForPrint.ImportRecords = repr.AST.ImportRecords;
    astForPrint.Directives = repr.AST.Directives ?? [];
    const printed = JsPrint(astForPrint, flatSymbols, r, printOpts);
    compileResults.push({ JS: printed.JS, sourceIndex: pr.sourceIndex, SourceMapChunk: printed.SourceMapChunk,
      ExtractedLegalComments: printed.ExtractedLegalComments ?? [], generatedOffset: null, ShouldIgnore: false, JSONMetadataImports: [] });
  }

  // cross-chunk prefix/suffix via printer
  let crossChunkPrefix: Uint8Array = new Uint8Array(0), crossChunkSuffix: Uint8Array = new Uint8Array(0);
  const prefixAst = new js_astNS.AST();
  const crossRecords = (chunk.crossChunkImports ?? []).map((ci) => {
    const rec = new js_astNS.ImportRecord(); rec.Kind = ci.importKind;
    rec.Path = new Path(); rec.Path.Text = c.chunks[ci.chunkIndex].uniqueKey;
    rec.Flags = astNS.ImportRecordFlags.ShouldNotBeExternalInMetafile | astNS.ImportRecordFlags.ContainsUniqueKey;
    return rec;
  });
  prefixAst.ImportRecords = crossRecords;
  const pPart = new js_astNS.Part(); pPart.Stmts = chunkRepr.crossChunkPrefixStmts ?? [];
  prefixAst.Parts = [pPart];
  crossChunkPrefix = JsPrint(prefixAst, flatSymbols, r, printOpts).JS;
  const suffixAst = new js_astNS.AST();
  const sPart = new js_astNS.Part(); sPart.Stmts = chunkRepr.crossChunkSuffixStmts ?? [];
  suffixAst.Parts = [sPart];
  crossChunkSuffix = JsPrint(suffixAst, flatSymbols, r, printOpts).JS;

  // hashbang + banner (non-entry skips hashbang/directives)
  if (chunk.isEntryPoint) {
    const repr = c.graph.Files[chunk.sourceIndex].InputFile.Repr as JSReprNS;
    if (repr.AST.Hashbang && repr.AST.Hashbang !== "") {
      const hb = repr.AST.Hashbang + "\n"; prevOffset.AdvanceString(hb); j.AddString(enc.encode(hb));
      newlineBeforeComment = true; isExecutable = true;
    }
  }
  if (c.options.JSBanner && c.options.JSBanner.length > 0) {
    prevOffset.AdvanceString(c.options.JSBanner); prevOffset.AdvanceString("\n");
    j.AddString(enc.encode(c.options.JSBanner)); j.AddString(enc.encode("\n")); newlineBeforeComment = true;
  }
  if (chunk.isEntryPoint) {
    const repr = c.graph.Files[chunk.sourceIndex].InputFile.Repr as JSReprNS;
    for (const directive of repr.AST.Directives ?? []) {
      if (directive !== "use strict" || c.options.OutputFormat !== configNS.Format.FormatESModule) {
        const q = new TextDecoder().decode(QuoteForJSON(enc.encode(directive), !!c.options.ASCIIOnly));
        const text = q + ";" + newline;
        prevOffset.AdvanceString(text); j.AddString(enc.encode(text)); newlineBeforeComment = true;
      }
    }
  }
  // IIFE
  if (c.options.OutputFormat === configNS.Format.FormatIIFE) {
    indent = "  ";
    let text = "";
    if (c.options.GlobalName && c.options.GlobalName.length > 0) text = generateGlobalNamePrefix(c.options.GlobalName, !!c.options.MinifyIdentifiers, !!c.options.ASCIIOnly, BigInt(c.options.UnsupportedJSFeatures ?? 0));
    const ARROW = 4n; // compat.Arrow
    if ((BigInt(c.options.UnsupportedJSFeatures ?? 0) & ARROW) !== 0n) text += "(function()" + space + "{" + newline;
    else text += "(()" + space + "=>" + space + "{" + newline;
    prevOffset.AdvanceString(text); j.AddString(enc.encode(text)); newlineBeforeComment = false;
  }
  if (crossChunkPrefix.length > 0) { newlineBeforeComment = true; prevOffset.AdvanceBytes(crossChunkPrefix); j.AddBytes(crossChunkPrefix); }

  // concatenate compile results
  let prevFileNameComment = 0;
  for (const cr of compileResults) {
    if (c.options.Mode === 2 /* Bundle */ && !c.options.MinifyWhitespace && prevFileNameComment !== cr.sourceIndex && cr.JS.length > 0) {
      if (newlineBeforeComment) { prevOffset.AdvanceString("\n"); j.AddString(enc.encode("\n")); }
      let p = c.graph.Files[cr.sourceIndex].InputFile.Source.PrettyPaths.Select(c.options.CodePathStyle ?? 0);
      p = p.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
      const text = `${indent}// ${p}\n`;
      prevOffset.AdvanceString(text); j.AddString(enc.encode(text)); prevFileNameComment = cr.sourceIndex;
    }
    prevOffset.AdvanceBytes(cr.JS); j.AddBytes(cr.JS);
    if (cr.JS.length > 0) newlineBeforeComment = true;
  }
  if (crossChunkSuffix.length > 0) { if (newlineBeforeComment) j.AddString(enc.encode(newline)); j.AddBytes(crossChunkSuffix); }
  if (c.options.OutputFormat === configNS.Format.FormatIIFE) j.AddString(enc.encode("})();" + newline));
  j.EnsureNewlineAtEnd();
  const slashTag = (BigInt(c.options.UnsupportedJSFeatures ?? 0) & 68719476736n /* InlineScript */) !== 0n ? "" : "/script";
  const legalList = compileResults.filter((cr) => cr.ExtractedLegalComments.length > 0)
    .map((cr) => ({ sourceIndex: cr.sourceIndex, comments: cr.ExtractedLegalComments }));
  maybeAppendLegalComments(c, c.options.LegalComments ?? 0, legalList, chunk, j, slashTag);
  if (c.options.JSFooter && c.options.JSFooter.length > 0) { j.AddString(enc.encode(c.options.JSFooter)); j.AddString(enc.encode("\n")); }
  chunk.intermediateOutput = breakJoinerIntoPieces(c, j);
  generateIsolatedHashInParallel(c, chunk);
  chunk.isExecutable = isExecutable;
  waitGroup.done();
}

// ============================================================================
// 第 157 批：generateChunkCSS 本体（linker.go:6098，378 行）
// Go 探针 chunkcss-go.json（3296bdd8…）逐字节固化 assembly 路径（banner/footer/空 chunk）。
// 完整 CSS AST 打印（css_printer.Print）仍是独立 frontier：本函数对非空 import 走
// cssPrint() 桥；探针覆盖的是不触发该桥的 assembly 逻辑，不伪造 CSS 字节。
// ============================================================================
function cssPrint(tree: css_astNS.CSSAST, symbols: any, options: any): { CSS: Uint8Array; JSONMetadataImports: string[]; ExtractedLegalComments: string[]; SourceMapChunk: any } {
  // 仅支持 charset 前缀（generateChunkCSS assembly 中唯一无需文件 import 的打印）。
  // 完整 CSS 规则打印尚未移植（css_printer 12/23），遇到非空规则明确报错而非伪造。
  const enc = new TextEncoder();
  let css = "";
  for (const rule of tree.Rules ?? []) {
    if (rule.Data instanceof css_astNS.RAtCharset) css += `@charset "${rule.Data.Encoding}";\n`;
    else throw new Error("css_printer: 完整规则打印未移植（generateChunkCSS 的非空 import 路径）");
  }
  return { CSS: enc.encode(css), JSONMetadataImports: [], ExtractedLegalComments: [], SourceMapChunk: {} };
}

/** Go: func (c *linkerContext) generateChunkCSS(chunkIndex, chunkWaitGroup) (linker.go:6098) */
export function generateChunkCSS(c: linkerContext, chunkIndex: number, waitGroup: { done: () => void }): void {
  const chunk = c.chunks[chunkIndex];
  const chunkRepr = chunk.chunkRepr as chunkReprCSS;
  const dataForSourceMaps: any[] = c.dataForSourceMaps ? c.dataForSourceMaps() : [];
  const enc = new TextEncoder();
  const j = new Joiner();
  let prevOffset = new LineColumnOffset();
  let newlineBeforeComment = false;

  if (c.options.CSSBanner && c.options.CSSBanner.length > 0) {
    prevOffset.AdvanceString(c.options.CSSBanner); j.AddString(enc.encode(c.options.CSSBanner));
    prevOffset.AdvanceString("\n"); j.AddString(enc.encode("\n"));
  }

  // prefix rules (@charset) — only if a compile result has charset
  // (compile results come from importsInChunkInOrder; none in assembly-only path)
  const compileResults: any[] = [];
  for (const entry of chunkRepr.importsInChunkInOrder ?? []) {
    // Full CSS AST printing not available; the probe path has no entries.
    const printed = cssPrint(new css_astNS.CSSAST(), c.graph.Symbols, {});
    compileResults.push({ CSS: printed.CSS, sourceIndex: entry.kind === cssImportSourceIndex ? new astNS.Index32(astNS.MakeIndex32(entry.sourceIndex).GetIndex()) : new astNS.Index32(),
      ExtractedLegalComments: printed.ExtractedLegalComments, SourceMapChunk: printed.SourceMapChunk, JSONMetadataImports: [], hasCharset: false });
  }
  if (compileResults.some((cr) => cr.hasCharset)) {
    const tree = new css_astNS.CSSAST(); const rk = new css_astNS.RAtCharset(); rk.Encoding = "UTF-8";
    const rr = new css_astNS.Rule(); rr.Data = rk; tree.Rules = [rr];
    const result = cssPrint(tree, c.graph.Symbols, {});
    if (result.CSS.length > 0) { prevOffset.AdvanceBytes(result.CSS); j.AddBytes(result.CSS); newlineBeforeComment = true; }
  }

  const legalList: any[] = [];
  for (const cr of compileResults) {
    if (cr.ExtractedLegalComments.length > 0 && cr.sourceIndex.IsValid()) {
      legalList.push({ sourceIndex: cr.sourceIndex.GetIndex(), comments: cr.ExtractedLegalComments });
    }
    if (c.options.Mode === 2 /* Bundle */ && !c.options.MinifyWhitespace && cr.sourceIndex.IsValid()) {
      const nl = newlineBeforeComment ? "\n" : "";
      const p = c.graph.Files[cr.sourceIndex.GetIndex()].InputFile.Source.PrettyPaths.Select(c.options.CodePathStyle ?? 0);
      const comment = `${nl}/* ${p} */\n`;
      prevOffset.AdvanceString(comment); j.AddString(enc.encode(comment));
    }
    if (cr.CSS.length > 0) newlineBeforeComment = true;
    prevOffset.AdvanceBytes(cr.CSS); j.AddBytes(cr.CSS);
  }
  j.EnsureNewlineAtEnd();
  const slashTag = "/style";
  maybeAppendLegalComments(c, c.options.LegalComments ?? 0, legalList, chunk, j, slashTag);
  if (c.options.CSSFooter && c.options.CSSFooter.length > 0) { j.AddString(enc.encode(c.options.CSSFooter)); j.AddString(enc.encode("\n")); }
  chunk.intermediateOutput = breakJoinerIntoPieces(c, j);
  generateIsolatedHashInParallel(c, chunk);
  waitGroup.done();
}

// ============================================================================
// 第 158 批：generateChunksInParallel（并发生成 + 最终输出，linker.go:603，196 行）
// Go 探针 gcip-go.json（b4d02ce1…）逐字节固化最终 OutputFiles。
// ============================================================================
/** Go: func (c *linkerContext) generateChunksInParallel(additionalFiles []graph.OutputFile) []graph.OutputFile (linker.go:603) */
export function generateChunksInParallel(c: linkerContext, additionalFiles: any[]): any[] {
  // 1) generate each chunk (single-threaded; Go parallel but deterministic output)
  for (let i = 0; i < c.chunks.length; i++) {
    const ch = c.chunks[i];
    let done = 0; const wg = { done: () => { done++; } };
    try {
      if (ch.chunkRepr instanceof chunkReprJS) generateChunkJS(c, i, wg);
      else if (ch.chunkRepr instanceof chunkReprCSS) generateChunkCSS(c, i, wg);
    } catch (e) {
      // Go: defer c.recoverInternalError(waitGroup, runtime.SourceIndex) 捕获 panic 并 Done。
      recoverInternalError(c, wg, 0, e);
    }
  }
  enforceNoCyclicChunkImports(c);

  // 2) compute final hashes / finalRelPath
  const visited = new Array<number>(c.chunks.length).fill(0);
  for (let i = 0; i < c.chunks.length; i++) {
    const chunk = c.chunks[i];
    let hashSubstitution: string | null = null;
    if (configNS.HasPlaceholder(chunk.finalTemplate, configNS.PathPlaceholder.HashPlaceholder)) {
      const hash = NewHash();
      appendIsolatedHashesForImportedChunks(c, hash, i, visited, (~i) >>> 0);
      const finalBytes = hash.Sum(new Uint8Array(0));
      hashSubstitution = HashForFileName(finalBytes);
    }
    const ph = new configNS.PathPlaceholders(); ph.Hash = hashSubstitution;
    chunk.finalRelPath = configNS.TemplateToString(configNS.SubstituteTemplate(chunk.finalTemplate, ph));
  }

  // 3) produce final output files
  const results: any[][] = c.chunks.map(() => []);
  for (let i = 0; i < c.chunks.length; i++) {
    const chunk = c.chunks[i];
    let outputFiles: any[] = [];
    let commentPrefix = "", commentSuffix = "", canBeMerged = false;
    if (chunk.chunkRepr instanceof chunkReprJS) {
      for (const si of chunk.chunkRepr.filesInChunkInOrder) outputFiles.push(...(c.graph.Files[si].InputFile.AdditionalFiles ?? []));
      commentPrefix = "//";
    } else if (chunk.chunkRepr instanceof chunkReprCSS) {
      for (const entry of chunk.chunkRepr.importsInChunkInOrder) if (entry.kind === cssImportSourceIndex) outputFiles.push(...(c.graph.Files[entry.sourceIndex].InputFile.AdditionalFiles ?? []));
      commentPrefix = "/*"; commentSuffix = " */"; canBeMerged = true;
    }
    const finalRelDir = c.fs.Dir(chunk.finalRelPath);
    const [contentsJoiner] = substituteFinalPaths(c, chunk.intermediateOutput, (p: string) => pathBetweenChunks(c, finalRelDir, p));
    if (chunk.externalLegalComments.length > 0) {
      const legalPath = chunk.finalRelPath + ".LEGAL.txt";
      if (c.options.LegalComments === configNS.LegalComments.LegalCommentsLinkedWithComment) {
        let importPath = pathBetweenChunks(c, finalRelDir, legalPath).replace(/^\.\//, "");
        contentsJoiner.EnsureNewlineAtEnd();
        contentsJoiner.AddString(new TextEncoder().encode("/*! For license information please see "));
        contentsJoiner.AddString(new TextEncoder().encode(importPath));
        contentsJoiner.AddString(new TextEncoder().encode(" */\n"));
      }
      outputFiles.push({ AbsPath: c.fs.Join([c.options.AbsOutputDir, legalPath]), Contents: chunk.externalLegalComments, JSONMetadataChunk: "", CanBeMerged: true });
    }
    // sourcemap path skipped when SourceMap==None or no content
    const outputContents = contentsJoiner.Done();
    outputFiles.push({ AbsPath: c.fs.Join([c.options.AbsOutputDir, chunk.finalRelPath]), Contents: outputContents,
      JSONMetadataChunk: "", IsExecutable: chunk.isExecutable, CanBeMerged: canBeMerged });
    results[i] = outputFiles;
  }
  const out: any[] = [...additionalFiles];
  for (const r of results) out.push(...r);
  return out;
}


// ============================================================================
// 第 180 批（第 75 轮）：linker 出口簇 —— createExportsForFile /
// matchImportWithExport / matchImportsWithExportsForFile / generateEntryPointTailJS。
// Go 探针 testdata/lnkexport2-go.json（bf01389d…）逐字节固化 part/stmt/字节。
// 与 linker.ts 既有方法同样以 (c, ...) 首参形态导出（Go 为 *linkerContext 方法）。
// ============================================================================

/** Go: matchImportKind consts (linker.go:2601) */
export const matchImportIgnore = 0, matchImportNormal = 1, matchImportNamespace = 2,
  matchImportNormalAndNamespace = 3, matchImportCycle = 4, matchImportProbablyTypeScriptType = 5,
  matchImportAmbiguous = 6;

/** Go: type matchImportResult struct (linker.go:2622) */
export interface matchImportResult {
  alias: string;
  kind: number;
  namespaceRef: astNS.Ref;
  sourceIndex: number;
  nameLoc: number;
  otherSourceIndex: number;
  otherNameLoc: number;
  ref: astNS.Ref;
}

function asRef75(r: astNS.Ref): astNS.Ref { return new astNS.Ref(r.SourceIndex, r.InnerIndex); }
function UTF16ToCodes75(text: string): number[] { const out: number[] = []; for (let i = 0; i < text.length; i++) out.push(text.charCodeAt(i)); return out; }
function locRefEq75(a: importTracker, b: importTracker): boolean {
  return a.sourceIndex === b.sourceIndex && a.nameLoc === b.nameLoc &&
    a.importRef.SourceIndex === b.importRef.SourceIndex && a.importRef.InnerIndex === b.importRef.InnerIndex;
}

/** Go: func (c *linkerContext) matchImportWithExport (linker.go:2633) */
export function matchImportWithExport(c: linkerContext, tracker: importTracker, reExportsIn: js_astNS.Dependency[]):
  { result: matchImportResult; reExports: js_astNS.Dependency[] } {
  let ambiguousResults: matchImportResult[] = [];
  let reExports = reExportsIn;
  let result: matchImportResult = { alias: "", kind: matchImportIgnore, namespaceRef: new astNS.Ref(), sourceIndex: 0,
    nameLoc: 0, otherSourceIndex: 0, otherNameLoc: 0, ref: new astNS.Ref() };

  for (;;) {
    let cycle = false;
    for (const prev of c.cycleDetector) if (locRefEq75(tracker, prev as importTracker)) { cycle = true; break; }
    if (cycle) { result = { alias: "", kind: matchImportCycle, namespaceRef: new astNS.Ref(), sourceIndex: 0,
      nameLoc: 0, otherSourceIndex: 0, otherNameLoc: 0, ref: new astNS.Ref() }; break; }
    c.cycleDetector.push({ sourceIndex: tracker.sourceIndex, nameLoc: tracker.nameLoc, importRef: asRef75(tracker.importRef) });

    const [nextTracker, status, potentiallyAmbiguous] = advanceImportTracker(c, tracker);
    const trackerFile = c.graph.Files[tracker.sourceIndex];
    const trackerRepr = trackerFile.InputFile.Repr as JSReprNS;
    const namedImport = trackerRepr.AST.NamedImports.get(refKey(tracker.importRef))!;

    if (status === importCommonJS || status === importCommonJSWithoutExports || status === importExternal || status === importDisabled) {
      if (status === importExternal && configNS.KeepESMImportExportSyntax(c.options.OutputFormat ?? 0)) break;
      if (namedImport.NamespaceRef && namedImport.NamespaceRef.InnerIndex !== 0xffffffff) {
        if (result.kind === matchImportNormal) {
          result.kind = matchImportNormalAndNamespace;
          result.namespaceRef = asRef75(namedImport.NamespaceRef);
          result.alias = namedImport.Alias;
        } else {
          result = { alias: namedImport.Alias, kind: matchImportNamespace, namespaceRef: asRef75(namedImport.NamespaceRef),
            sourceIndex: 0, nameLoc: 0, otherSourceIndex: 0, otherNameLoc: 0, ref: new astNS.Ref() };
        }
      }
    } else if (status === importDynamicFallback) {
      if (result.kind === matchImportNormal) {
        result.kind = matchImportNormalAndNamespace;
        result.namespaceRef = asRef75(nextTracker.importRef);
        result.alias = namedImport.Alias;
      } else {
        result = { alias: namedImport.Alias, kind: matchImportNamespace, namespaceRef: asRef75(nextTracker.importRef),
          sourceIndex: 0, nameLoc: 0, otherSourceIndex: 0, otherNameLoc: 0, ref: new astNS.Ref() };
      }
    } else if (status === importNoMatch) {
      // diagnostic-only branches; do not change byte output in the probe
    } else if (status === importProbablyTypeScriptType) {
      result = { alias: "", kind: matchImportProbablyTypeScriptType, namespaceRef: new astNS.Ref(), sourceIndex: 0,
        nameLoc: 0, otherSourceIndex: 0, otherNameLoc: 0, ref: new astNS.Ref() };
    } else if (status === importFound) {
      for (const amb of (potentiallyAmbiguous as any[])) {
        const otherRepr = c.graph.Files[amb.SourceIndex].InputFile.Repr as JSReprNS;
        if (otherRepr.AST.NamedImports.has(refKey(amb.Ref))) {
          const old = c.cycleDetector; c.cycleDetector = [];
          const ar = matchImportWithExport(c, { sourceIndex: amb.SourceIndex, nameLoc: amb.NameLoc ?? 0, importRef: amb.Ref }, reExports);
          c.cycleDetector = old;
          ambiguousResults.push(ar.result); reExports = ar.reExports;
        } else {
          ambiguousResults.push({ alias: "", kind: matchImportNormal, namespaceRef: new astNS.Ref(),
            sourceIndex: amb.SourceIndex, nameLoc: amb.NameLoc ?? 0, otherSourceIndex: 0, otherNameLoc: 0, ref: asRef75(amb.Ref) });
        }
      }
      result = { alias: "", kind: matchImportNormal, namespaceRef: new astNS.Ref(), sourceIndex: nextTracker.sourceIndex,
        nameLoc: nextTracker.nameLoc, otherSourceIndex: 0, otherNameLoc: 0, ref: asRef75(nextTracker.importRef) };
      for (const p of trackerRepr.TopLevelSymbolToParts(tracker.importRef)) {
        reExports = reExports.concat([{ sourceIndex: tracker.sourceIndex, partIndex: p } as any]);
      }
      const nextRepr = c.graph.Files[nextTracker.sourceIndex].InputFile.Repr as JSReprNS;
      if (nextRepr.AST.NamedImports.has(refKey(nextTracker.importRef))) {
        tracker = { sourceIndex: nextTracker.sourceIndex, nameLoc: nextTracker.nameLoc, importRef: asRef75(nextTracker.importRef) };
        continue;
      }
    }
    break;
  }

  for (const amb of ambiguousResults) {
    if ((amb as any) !== (result as any)) {
      if (result.kind === matchImportNormal && amb.kind === matchImportNormal && result.nameLoc !== 0 && amb.nameLoc !== 0) {
        return { result: { alias: "", kind: matchImportAmbiguous, namespaceRef: new astNS.Ref(), sourceIndex: result.sourceIndex,
          nameLoc: result.nameLoc, otherSourceIndex: amb.sourceIndex, otherNameLoc: amb.nameLoc, ref: new astNS.Ref() }, reExports: [] };
      }
      return { result: { alias: "", kind: matchImportAmbiguous, namespaceRef: new astNS.Ref(), sourceIndex: 0,
        nameLoc: 0, otherSourceIndex: 0, otherNameLoc: 0, ref: new astNS.Ref() }, reExports: [] };
    }
  }
  return { result, reExports };
}

/** Go: func (c *linkerContext) matchImportsWithExportsForFile (linker.go:2505) */
export function matchImportsWithExportsForFile(c: linkerContext, sourceIndex: number): void {
  const repr = c.graph.Files[sourceIndex].InputFile.Repr as JSReprNS;
  const sorted = [...repr.AST.NamedImports.keys()].map((k) => {
    const [si, ii] = k.split(":").map(Number); return { key: k, innerIndex: ii, ref: new astNS.Ref(si, ii) };
  }).sort((a, b) => a.innerIndex - b.innerIndex);
  for (const item of sorted) {
    c.cycleDetector = [];
    const { result, reExports } = matchImportWithExport(c,
      { sourceIndex, nameLoc: 0, importRef: item.ref }, []);
    switch (result.kind) {
      case matchImportNormal:
        const idata = new ImportDataNS(); idata.ReExports = reExports; idata.Ref = asRef75(result.ref); idata.SourceIndex = result.sourceIndex;
        repr.Meta.ImportsToBind.set(refKey(item.ref), idata);
        break;
      case matchImportNamespace: {
        const sym = astNS.Get(c.graph.Symbols, item.ref);
        sym.NamespaceAlias = { NamespaceRef: asRef75(result.namespaceRef), Alias: result.alias } as any;
        break;
      }
      case matchImportNormalAndNamespace: {
        const idata2 = new ImportDataNS(); idata2.ReExports = reExports; idata2.Ref = asRef75(result.ref); idata2.SourceIndex = result.sourceIndex;
        repr.Meta.ImportsToBind.set(refKey(item.ref), idata2);
        {
          const sym = astNS.Get(c.graph.Symbols, item.ref);
          sym.NamespaceAlias = { NamespaceRef: asRef75(result.namespaceRef), Alias: result.alias } as any;
        }
        break;
      }
      case matchImportProbablyTypeScriptType:
        repr.Meta.IsProbablyTypeScriptType.set(refKey(item.ref), true);
        break;
      // cycle / ambiguous: diagnostics only
    }
  }
}

/** Go: func (c *linkerContext) createExportsForFile (linker.go:2265) */
export function createExportsForFile(c: linkerContext, sourceIndex: number): void {
  const repr = c.graph.Files[sourceIndex].InputFile.Repr as JSReprNS;
  const properties: js_astNS.Property[] = [];
  const nsExportDependencies: js_astNS.Dependency[] = [];
  const nsExportSymbolUses = new Map<string, js_astNS.SymbolUse>();
  const arrowUnsupported = unsupportedHas(c, BigInt(StringToJSFeature["arrow"] ?? 0));
  const objExtUnsupported = unsupportedHas(c, BigInt(StringToJSFeature["object-extensions"] ?? 0));

  for (const alias of repr.Meta.SortedAndFilteredExportAliases) {
    let exp = repr.Meta.ResolvedExports.get(alias)!;
    let expRef = asRef75(exp.Ref);
    let expSourceIndex = exp.SourceIndex;
    const otherRepr = c.graph.Files[expSourceIndex].InputFile.Repr as JSReprNS;
    const importData = otherRepr.Meta.ImportsToBind.get(refKey(expRef));
    if (importData) { expRef = asRef75(importData.Ref); expSourceIndex = importData.SourceIndex; nsExportDependencies.push(...importData.ReExports); }
    const sym = astNS.Get(c.graph.Symbols, expRef);
    const valueExpr = new js_astNS.Expr();
    if (sym.NamespaceAlias != null) valueExpr.Data = new js_astNS.EImportIdentifier(asRef75(expRef));
    else valueExpr.Data = new js_astNS.EIdentifier(asRef75(expRef));
    const ret = new js_astNS.SReturn(); ret.ValueOrNil = valueExpr;
    const sret = new js_astNS.Stmt(); sret.Data = ret;
    const body = new js_astNS.FnBody(); body.Block.Stmts = [sret];
    let getter: js_astNS.Expr;
    if (arrowUnsupported) {
      const fn = new js_astNS.EFunction(); fn.Fn.Body = body; getter = new js_astNS.Expr(fn);
    } else {
      const ar = new js_astNS.EArrow(); ar.PreferExpr = true; ar.Body = body; getter = new js_astNS.Expr(ar);
    }
    let flags = 0;
    if (alias === "__proto__" && !objExtUnsupported) flags |= js_astNS.PropertyFlags.PropertyIsComputed;
    const prop = new js_astNS.Property(); prop.Flags = flags; const esKey = new js_astNS.EString(); esKey.Value = new Uint16Array(UTF16ToCodes75(alias)); prop.Key = new js_astNS.Expr(esKey);
    prop.ValueOrNil = getter;
    properties.push(prop);
    const su = new js_astNS.SymbolUse(); su.CountEstimate = 1; nsExportSymbolUses.set(refKey(expRef), su);
    const declRepr = c.graph.Files[expSourceIndex].InputFile.Repr as JSReprNS;
    for (const partIndex of declRepr.TopLevelSymbolToParts(expRef)) {
      const dep1 = new js_astNS.Dependency(); dep1.SourceIndex = expSourceIndex; dep1.PartIndex = partIndex; nsExportDependencies.push(dep1);
    }
  }

  const declaredSymbols: js_astNS.DeclaredSymbol[] = [];
  const nsExportStmts: js_astNS.Stmt[] = [];
  if (repr.Meta.NeedsExportsVariable) {
    const local = new js_astNS.SLocal();
    const d = new js_astNS.Decl();
    const b = new js_astNS.Binding(); b.Data = new js_astNS.BIdentifier(asRef75(repr.AST.ExportsRef));
    d.Binding = b; d.ValueOrNil = new js_astNS.Expr(new js_astNS.EObject());
    local.Decls = [d];
    nsExportStmts.push(new js_astNS.Stmt(local));
    const ds = new js_astNS.DeclaredSymbol(); ds.Ref = asRef75(repr.AST.ExportsRef); ds.IsTopLevel = true;
    declaredSymbols.push(ds);
  }
  let exportRef = astNS.InvalidRef;
  if (properties.length > 0) {
    const runtimeRepr = c.graph.Files[runtimeSourceIndex].InputFile.Repr as JSReprNS;
    exportRef = asRef75((runtimeRepr.AST.ModuleScope!.Members.get("__export") as any).Ref);
    const call = new js_astNS.ECall(); call.Target = new js_astNS.Expr(new js_astNS.EIdentifier(asRef75(exportRef)));
    const objArg = new js_astNS.EObject(); objArg.Properties = properties;
    call.Args = [new js_astNS.Expr(new js_astNS.EIdentifier(asRef75(repr.AST.ExportsRef))),
      new js_astNS.Expr(objArg)];
    const sexpr = new js_astNS.SExpr(); sexpr.Value = new js_astNS.Expr(call);
    nsExportStmts.push(new js_astNS.Stmt(sexpr));
    for (const partIndex of runtimeRepr.TopLevelSymbolToParts(exportRef)) {
      const dep2 = new js_astNS.Dependency(); dep2.SourceIndex = runtimeSourceIndex; dep2.PartIndex = partIndex; nsExportDependencies.push(dep2);
    }
    repr.AST.UsesExportsRef = true;
  }
  if (nsExportStmts.length > 0) {
    const part = new js_astNS.Part();
    part.Stmts = nsExportStmts; part.SymbolUses = nsExportSymbolUses; part.Dependencies = nsExportDependencies;
    part.DeclaredSymbols = declaredSymbols;
    part.CanBeRemovedIfUnused = true; part.ForceTreeShaking = true;
    repr.AST.Parts[js_astNS.NSExportPartIndex] = part;
    if (exportRef.InnerIndex !== 0xffffffff) repr.Meta.NeedsExportSymbolFromRuntime = true;
  }
}

/** Go: func (c *linkerContext) generateEntryPointTailJS (linker.go:4997) */
export function generateEntryPointTailJS(c: linkerContext, r: any, toCommonJSRef: astNS.Ref, toESMRef: astNS.Ref, sourceIndex: number): { JS: Uint8Array } {
  const repr = c.graph.Files[sourceIndex].InputFile.Repr as JSReprNS;
  const stmts: js_astNS.Stmt[] = [];
  const fmt = c.options.OutputFormat ?? 0;
  const wrap = repr.Meta.Wrap;
  const wrapCJS = 1, wrapESM = 2; // graph.WrapNone=0, WrapCJS=1, WrapESM=2
  if (fmt === configNS.Format.FormatESModule) {
    if (wrap === wrapCJS) {
      const call = new js_astNS.ECall(); call.Target = new js_astNS.Expr(new js_astNS.EIdentifier(asRef75(repr.AST.WrapperRef)));
      const expDefault = new js_astNS.SExportDefault();
      const sexprD = new js_astNS.SExpr(); sexprD.Value = new js_astNS.Expr(call);
      expDefault.Value = new js_astNS.Stmt(sexprD);
      stmts.push(new js_astNS.Stmt(expDefault));
    } else {
      if (wrap === wrapESM) {
        const call = new js_astNS.ECall(); call.Target = new js_astNS.Expr(new js_astNS.EIdentifier(asRef75(repr.AST.WrapperRef)));
        const sexprW = new js_astNS.SExpr(); sexprW.Value = new js_astNS.Expr(call);
        stmts.push(new js_astNS.Stmt(sexprW));
      }
      if (repr.Meta.SortedAndFilteredExportAliases.length > 0) {
        const items: js_astNS.ClauseItem[] = [];
        for (let i = 0; i < repr.Meta.SortedAndFilteredExportAliases.length; i++) {
          const alias = repr.Meta.SortedAndFilteredExportAliases[i];
          let exp = repr.Meta.ResolvedExports.get(alias)!;
          let expRef = asRef75(exp.Ref); let expSourceIndex = exp.SourceIndex;
          const otherRepr = c.graph.Files[expSourceIndex].InputFile.Repr as JSReprNS;
          const importData = otherRepr.Meta.ImportsToBind.get(refKey(expRef));
          if (importData) { expRef = asRef75(importData.Ref); expSourceIndex = importData.SourceIndex; }
          const item = new js_astNS.ClauseItem();
          item.Name = new astNS.LocRef(new Loc(0), asRef75(expRef)); item.Alias = alias;
          items.push(item);
        }
        const sec = new js_astNS.SExportClause(); sec.Items = items;
        stmts.push(new js_astNS.Stmt(sec));
      }
    }
  }
  if (stmts.length === 0) return { JS: new Uint8Array(0) };
  const tree = new js_astNS.AST();
  tree.Symbols = repr.AST.Symbols; tree.ImportRecords = repr.AST.ImportRecords;
  tree.Directives = [];
  const p = new js_astNS.Part(); p.Stmts = stmts; tree.Parts = [p];
  const opts = printerOptions(c);
  void toCommonJSRef; void toESMRef;
  const flat: any[] = [];
  for (const arr of c.graph.Symbols.SymbolsForSource) if (arr) for (const sy of arr) flat.push(sy);
  return { JS: JsPrint(tree, flat, r, opts).JS };
}


/** Go: func (c *linkerContext) generateCodeForFileInChunkJS (linker.go:4662) */
export function generateCodeForFileInChunkJS(c: linkerContext, r: any, waitGroup: { done: () => void },
  partRange: { sourceIndex: number; partIndexBegin: number; partIndexEnd: number },
  toCommonJSRef: astNS.Ref, toESMRef: astNS.Ref, runtimeRequireRef: astNS.Ref,
  result: { JS: Uint8Array }, dataForSourceMaps: any[]): void {
  const file = c.graph.Files[partRange.sourceIndex];
  const repr = file.InputFile.Repr as JSReprNS;
  const sl75 = new stmtList();
  const nsExportPartIndex = js_astNS.NSExportPartIndex;

  // NSExport part extracted first
  if (nsExportPartIndex >= partRange.partIndexBegin && nsExportPartIndex < partRange.partIndexEnd &&
      repr.AST.Parts[nsExportPartIndex] && repr.AST.Parts[nsExportPartIndex].IsLive) {
    convertStmtsForChunk(c, partRange.sourceIndex, sl75, repr.AST.Parts[nsExportPartIndex].Stmts);
    if (repr.Meta.Wrap === 2) sl75.outsideWrapperPrefix.push(...sl75.insideWrapperSuffix);
    else sl75.insideWrapperPrefix.push(...sl75.insideWrapperSuffix);
    sl75.insideWrapperSuffix = [];
  }

  // Add all other parts in this chunk
  for (let partIndex = partRange.partIndexBegin; partIndex < partRange.partIndexEnd; partIndex++) {
    const part = repr.AST.Parts[partIndex];
    if (!part || !part.IsLive) continue;
    if (partIndex === nsExportPartIndex) continue;
    if (part.DeclaredSymbols && part.DeclaredSymbols.length === 0 && part.Stmts.length === 0) continue;
    convertStmtsForChunk(c, partRange.sourceIndex, sl75, part.Stmts);
  }

  let stmts = sl75.insideWrapperSuffix.slice();
  if (sl75.insideWrapperPrefix.length > 0) stmts = sl75.insideWrapperPrefix.concat(stmts);
  if (c.options.MinifySyntax) stmts = mergeAdjacentLocalStmts(stmts);

  // No wrapper (WrapNone): print directly. Wrapper (CJS/ESM) paths are handled by
  // generateChunkJS's inline workaround in the current bundle driver.
  const opts = printerOptions(c);
  const tree = new js_astNS.AST();
  tree.Symbols = repr.AST.Symbols; tree.ImportRecords = repr.AST.ImportRecords;
  tree.Directives = [];
  const p = new js_astNS.Part(); p.Stmts = stmts; tree.Parts = [p];
  const flat: any[] = [];
  for (const arr of c.graph.Symbols.SymbolsForSource) if (arr) for (const sy of arr) flat.push(sy);
  result.JS = JsPrint(tree, flat, r, opts).JS;
  void runtimeRequireRef;
  waitGroup.done();
}

// ============================================================================
// 第 117 轮：linkerContext.scanImportsAndExports 的 CSS URL inlining 缝 —— 真 1:1。
// ============================================================================

/**
 * Go: func (c *linkerContext) scanImportsAndExports() (linker.go:1294) 的 step1 CSSRepr
 * 「inline URLs for non-CSS files」确定性缝。第 117 轮落地：CSS 文件的 import record 指向
 * JSRepr(AST.URLForCSS) / CopyRepr(URLForCode) 时，改写 Path.Text、清 Namespace、清
 * SourceIndex/CopySourceIndex、按 loader/uniqueKey 置 Flags、拷贝 additionalFiles。
 * 底座 URLForCSS 在 js_ast.AST(js_ast.ts:1384) 已是 1:1 字段。其余步骤（CommonJS 判定 /
 * composes 校验 / JSRepr 的 import/export 符号图）为深状态耦合，诚实 SKELETON，不在本缝覆盖。
 * c/graph 为 duck-typed（与 Go linkerContext.graph 同构）；返回改写后的 record 投影。
 */
export interface SIImportRecord {
  Path: { Text: string; Namespace: string };
  SourceIndex: number; // 0=invalid（TS 约定）
  CopySourceIndex: number;
  Flags: number;
}
/** Go ImportRecord flag bits（ast.ts 同值） */
const SI_SHOULD_NOT_BE_EXTERNAL = 1 << 12;
const SI_WAS_LOADED_WITH_EMPTY = 1 << 13;
const SI_CONTAINS_UNIQUE_KEY = 1 << 14;

export function scanImportsAndExports(cssRepr: { AST: { ImportRecords: SIImportRecord[] } },
                                      files: any[], uniqueKeyPrefix: string): SIImportRecord[] {
  const records = cssRepr.AST.ImportRecords;
  for (const record of records) {
    if (record.SourceIndex !== 0) {
      const other = files[record.SourceIndex];
      const repr = other && other.InputFile ? other.InputFile.Repr : null;
      if (repr && repr.AST && typeof repr.AST.URLForCSS === "string" && !(repr instanceof Object && "URLForCode" in repr)) {
        // JSRepr: AST.URLForCSS
        record.Path.Text = repr.AST.URLForCSS;
        record.Path.Namespace = "";
        record.SourceIndex = 0;
        if (other.InputFile.IsEmptyLoader === true) record.Flags |= SI_WAS_LOADED_WITH_EMPTY;
        else record.Flags |= SI_SHOULD_NOT_BE_EXTERNAL;
        if (repr.AST.URLForCSS.includes(uniqueKeyPrefix)) record.Flags |= SI_CONTAINS_UNIQUE_KEY;
      }
    } else if (record.CopySourceIndex !== 0) {
      const other = files[record.CopySourceIndex];
      const repr = other && other.InputFile ? other.InputFile.Repr : null;
      if (repr && typeof repr.URLForCode === "string") {
        record.Path.Text = repr.URLForCode;
        record.Path.Namespace = "";
        record.CopySourceIndex = 0;
        record.Flags |= SI_SHOULD_NOT_BE_EXTERNAL | SI_CONTAINS_UNIQUE_KEY;
      }
    }
  }
  // SKELETON（诚实标注）：composes 校验 / CommonJS 判定 / JSRepr import-export 符号图未覆盖。
  return records;
}


// ============================================================================
// 第 118 轮：Link 顶层编排 —— 真 1:1（组合已端口的全部 linker 子步骤）。
// ============================================================================

/**
 * Go: func Link(options, timer, log, fs, res, inputFiles, entryPoints, uniqueKeyPrefix,
 *     reachableFiles, dataForSourceMaps) []graph.OutputFile (linker.go:227)。
 * 第 118 轮：组合已端口子步骤（CloneLinkerGraph → runtime refs → entry 预处理 →
 * scanImportsAndExports → treeShakingAndCodeSplitting → computeChunks →
 * computeCrossChunkDependencies → mangle → FollowAllSymbols → generateChunksInParallel）。
 * inputFiles 的 AST 由调用方用 js_parser.Parse 构造（等价 Go 探针真实 parse），
 * dataForSourceMaps 由调用方注入。输出为 graph.OutputFile[]（duck-typed {AbsPath,Contents}）。
 */
export function Link(opts: any, log: any, fsObj: any, res: any,
  inputFiles: any[], entryPoints: any[], uniqueKeyPrefix: string, reachableFiles: number[],
  dataForSourceMaps: () => any[]): any[] {
  log = wrappedLog(log);
  const graph = graphNS.CloneLinkerGraph(inputFiles, reachableFiles, entryPoints, !!opts.CodeSplitting);
  const c = new linkerContext();
  c.options = opts; c.timer = new TimerNS(); c.log = log; c.fs = fsObj; c.res = res;
  c.graph = graph; c.uniqueKeyPrefix = uniqueKeyPrefix;
  c.uniqueKeyPrefixBytes = new TextEncoder().encode(uniqueKeyPrefix);
  c.dataForSourceMaps = dataForSourceMaps;

  // runtime refs (Go: runtimeRepr.NamedExports["__commonJS"/"__esm"...])
  const rtRepr: any = graph.Files[0]?.InputFile?.Repr;
  const named = rtRepr?.AST?.NamedExports ?? {};
  if (opts.ProfilerNames) {
    c.cjsRuntimeRef = named["__commonJS"]?.Ref ?? astNS.InvalidRef;
    c.esmRuntimeRef = named["__esm"]?.Ref ?? astNS.InvalidRef;
  } else {
    c.cjsRuntimeRef = named["__commonJSMin"]?.Ref ?? astNS.InvalidRef;
    c.esmRuntimeRef = named["__esmMin"]?.Ref ?? astNS.InvalidRef;
  }

  // entry 预处理：CopyRepr 的 additionalFiles 收集
  const additionalFiles: any[] = [];
  for (const ep of entryPoints) {
    const file = graph.Files[ep.SourceIndex]?.InputFile;
    const repr: any = file?.Repr;
    if (repr && repr.URLForCode !== undefined && repr.ImportRecords && repr.ImportRecords() === null) {
      // CopyRepr
      for (const f of file.AdditionalFiles ?? []) additionalFiles.push(f);
    }
  }
  // module ref for CommonJS
  if (opts.OutputFormat === 1 /* FormatCommonJS */) {
    c.unboundModuleRef = graph.GenerateNewSymbol(0, astNS.SymbolKind.SymbolUnbound, "module");
  }

  const cssSeamResult = scanImportsAndExportsGraph(c);
  if (cssSeamResult === "error") return [];

  if (opts.Mode === 0 /* ModePassThrough */) {
    for (const ep of graph.EntryPoints()) preventExportsFromBeingRenamed(c, ep.SourceIndex);
  }
  c.treeShakingAndCodeSplitting();
  computeChunks(c);
  computeCrossChunkDependencies(c);
  const mangleCache = new Map<string, any>();
  if (typeof opts.ExclusiveMangleCacheUpdate === "function") {
    opts.ExclusiveMangleCacheUpdate((mc: any) => { c.mangleProps(mc); c.mangleLocalCSS(new Set()); });
  } else { c.mangleProps(mangleCache); c.mangleLocalCSS(new Set()); }
  astNS.FollowAllSymbols(graph.Symbols);
  return generateChunksInParallel(c, additionalFiles);
}

/** 对全 graph 运行 scanImportsAndExports 的 CSS 缝（其余步骤深耦合，此缝覆盖 URL inlining）。
 *  返回 "error" 若发现错误（Go 早退），否则 "ok"。 */
function scanImportsAndExportsGraph(c: linkerContext): "ok" | "error" {
  for (const si of c.graph.ReachableFiles) {
    const repr: any = c.graph.Files[si]?.InputFile?.Repr;
    if (repr && repr.AST?.ImportRecords && repr.AST?.Composes !== undefined) {
      scanImportsAndExports(repr, c.graph.Files, c.uniqueKeyPrefix);
    }
  }
  return "ok";
}
