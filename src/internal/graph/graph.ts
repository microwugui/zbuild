// 1:1 移植自 esbuild internal/graph/graph.go（v0.28.2，commit f6058f83）
// 第 44 轮入口判定 + 第 143 批 LinkerGraph 底座（symbol/全局分配 + part→symbol + chunk 图）。
import * as ast from "../ast/ast.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import { BitSet, NewBitSet } from "../helpers/bitset.ts";
import { Source, LineColumnTracker, MakeLineColumnTracker } from "../logger/logger.ts";
import { InputFile, EntryPoint, JSRepr, JSReprMeta, CSSRepr, refKey } from "./input.ts";
import { CSSAST } from "../css_ast/css_ast.ts";
import { SymbolFlags } from "../ast/ast.ts";

/** Go: entryPointKind (graph.go:27) */
export const entryPointNone = 0;
export const entryPointUserSpecified = 1;
export const entryPointDynamicImport = 2;

/** Go: type LinkerFile struct (graph.go:33) —— 全字段 */
export class LinkerFile {
  EntryBits: BitSet = new BitSet(new Uint8Array(0));
  lazyLineColumnTracker: LineColumnTracker | null = null;
  InputFile: InputFile = new InputFile();
  DistanceFromEntryPoint = 0;
  EntryPointChunkIndex = 0;
  entryPointKind = entryPointNone;
  IsLive = false;

  /** Go: func (f *LinkerFile) IsEntryPoint() bool (graph.go:65) */
  IsEntryPoint(): boolean { return this.entryPointKind !== entryPointNone; }
  /** Go: func (f *LinkerFile) IsUserSpecifiedEntryPoint() bool (graph.go:69) */
  IsUserSpecifiedEntryPoint(): boolean { return this.entryPointKind === entryPointUserSpecified; }

  /** Go: func (f *LinkerFile) LineColumnTracker() *logger.LineColumnTracker (graph.go:75) */
  LineColumnTracker(): LineColumnTracker {
    if (this.lazyLineColumnTracker === null) this.lazyLineColumnTracker = MakeLineColumnTracker(this.InputFile.Source);
    return this.lazyLineColumnTracker;
  }
}

/** Go: type LinkerGraph struct (graph.go:97) */
export class LinkerGraph {
  Files: LinkerFile[] = [];
  entryPoints: EntryPoint[] = [];
  Symbols: ast.SymbolMap = new ast.SymbolMap();
  TSEnums: Map<string, Map<string, any>> | null = null;
  ConstValues: Map<string, any> | null = null;
  ReachableFiles: number[] = [];
  StableSourceIndices: number[] = [];

  /** Go: func (g *LinkerGraph) EntryPoints() []EntryPoint (graph.go:317) */
  EntryPoints(): EntryPoint[] { return this.entryPoints; }

  /** Go: func (g *LinkerGraph) AddPartToFile (graph.go:321) */
  AddPartToFile(sourceIndex: number, part: js_ast.Part): number {
    if (!(part.SymbolUses instanceof Map)) part.SymbolUses = new Map();
    const repr = this.Files[sourceIndex].InputFile.Repr as JSRepr;
    const partIndex = repr.AST.Parts.length;
    repr.AST.Parts.push(part);
    for (const declared of part.DeclaredSymbols) {
      if (declared.IsTopLevel) {
        const key = refKey(declared.Ref);
        let partIndices = repr.Meta.TopLevelSymbolToPartsOverlay.get(key);
        if (partIndices === undefined) {
          partIndices = (repr.AST.TopLevelSymbolToPartsFromParser.get(key) ?? []).slice();
        }
        partIndices = partIndices.slice();
        partIndices.push(partIndex);
        repr.Meta.TopLevelSymbolToPartsOverlay.set(key, partIndices);
      }
    }
    return partIndex;
  }

  /** Go: func (g *LinkerGraph) GenerateNewSymbol (graph.go:354) */
  GenerateNewSymbol(sourceIndex: number, kind: number, originalName: string): ast.Ref {
    const sourceSymbols = this.Symbols.SymbolsForSource[sourceIndex] as ast.Symbol[];
    const ref = new ast.Ref(sourceIndex, sourceSymbols.length);
    const sym = new ast.Symbol(); sym.Kind = kind; sym.OriginalName = originalName; sym.Link = ast.InvalidRef;
    sourceSymbols.push(sym);
    const repr = this.Files[sourceIndex].InputFile.Repr as JSRepr;
    repr.AST.ModuleScope!.Generated.push(ref);
    return ref;
  }

  /** Go: func (g *LinkerGraph) GenerateSymbolImportAndUse (graph.go:373) */
  GenerateSymbolImportAndUse(sourceIndex: number, partIndex: number, ref: ast.Ref, useCount: number, sourceIndexToImportFrom: number): void {
    if (useCount === 0) return;
    const repr = this.Files[sourceIndex].InputFile.Repr as JSRepr;
    const part = repr.AST.Parts[partIndex];
    const key = refKey(ref);
    const use = part.SymbolUses.get(key) ?? new js_ast.SymbolUse();
    use.CountEstimate += useCount;
    part.SymbolUses.set(key, use);
    if (ref.Equals(repr.AST.ExportsRef)) repr.AST.UsesExportsRef = true;
    if (ref.Equals(repr.AST.ModuleRef)) repr.AST.UsesModuleRef = true;
    if (sourceIndexToImportFrom !== sourceIndex) {
      const d = new ImportData(); d.SourceIndex = sourceIndexToImportFrom; d.Ref = ref;
      repr.Meta.ImportsToBind.set(key, d);
    }
    const targetRepr = this.Files[sourceIndexToImportFrom].InputFile.Repr as JSRepr;
    for (const p of targetRepr.TopLevelSymbolToParts(ref)) {
      const dep = new js_ast.Dependency(); dep.SourceIndex = sourceIndexToImportFrom; dep.PartIndex = p;
      part.Dependencies.push(dep);
    }
  }

  /** Go: func (g *LinkerGraph) GenerateRuntimeSymbolImportAndUse (graph.go:418) */
  GenerateRuntimeSymbolImportAndUse(sourceIndex: number, partIndex: number, name: string, useCount: number): void {
    if (useCount === 0) return;
    // runtime source index = 0; ref from NamedExports[name]
    const runtimeRepr = this.Files[0].InputFile.Repr as JSRepr;
    const ref = (runtimeRepr.AST.NamedExports.get(name) ?? new js_ast.NamedExport()).Ref;
    this.GenerateSymbolImportAndUse(sourceIndex, partIndex, ref, useCount, 0);
  }
}
import { ImportData, ExportData } from "./input.ts";

/** Go: func CloneLinkerGraph (graph.go:126) —— 底座版：clone symbols/parts/importRecords/exports/scope，建 stable 索引 */
export function CloneLinkerGraph(
  inputFiles: InputFile[], reachableFiles: number[], originalEntryPoints: EntryPoint[], codeSplitting: boolean,
): LinkerGraph {
  const entryPoints = originalEntryPoints.slice();
  const symbols = ast.NewSymbolMap(inputFiles.length);
  const files: LinkerFile[] = new Array(inputFiles.length).fill(null).map(() => new LinkerFile());
  for (const ep of entryPoints) files[ep.SourceIndex].entryPointKind = entryPointUserSpecified;

  const dynamicImportEntryPoints: number[] = [];
  const stableSourceIndices: number[] = new Array(inputFiles.length).fill(0);
  for (let stableIndex = 0; stableIndex < reachableFiles.length; stableIndex++) {
    const sourceIndex = reachableFiles[stableIndex];
    stableSourceIndices[sourceIndex] = stableIndex;
    const file = files[sourceIndex];
    const inputCopy = new InputFile(); Object.assign(inputCopy, inputFiles[sourceIndex]);
    file.InputFile = inputCopy;
    const repr = file.InputFile.Repr;
    if (repr instanceof JSRepr) {
      const clone = cloneJSRepr(repr);
      file.InputFile.Repr = clone;
      const fileSymbols = clone.AST.Symbols.slice();
      symbols.SymbolsForSource[sourceIndex] = fileSymbols;
      clone.AST.Symbols = [];
      if (codeSplitting) {
        for (const rec of clone.AST.ImportRecords) {
          if (rec.SourceIndex !== undefined && rec.Kind === 3 /* ImportDynamic */) {
            dynamicImportEntryPoints.push(rec.SourceIndex);
            rec.AssertOrWith = null;
          }
        }
      }
      const resolvedExports = new Map<string, ExportData>();
      for (const [alias, name] of clone.AST.NamedExports) {
        const e = new ExportData(); e.Ref = name.Ref; e.SourceIndex = sourceIndex; e.NameLoc = name.AliasLoc?.Start ?? 0;
        resolvedExports.set(alias, e);
      }
      clone.Meta.ResolvedExports = resolvedExports;
    } else if (repr instanceof CSSRepr) {
      const clone = new CSSRepr(); Object.assign(clone, repr);
      const ca = new CSSAST(); Object.assign(ca, repr.AST); ca.ImportRecords = (repr.AST as any).ImportRecords ? (repr.AST as any).ImportRecords.slice() : []; clone.AST = ca as any;
      file.InputFile.Repr = clone;
      const fileSymbols = (clone.AST as any).Symbols ? (clone.AST as any).Symbols.slice() : [];
      symbols.SymbolsForSource[sourceIndex] = fileSymbols;
      (clone.AST as any).ImportRecords = ((clone.AST as any).ImportRecords ?? []).slice();
    }
    file.DistanceFromEntryPoint = 0xFFFFFFFF;
  }

  const stableEntryPoints: number[] = [];
  for (const si of dynamicImportEntryPoints) {
    const other = files[si];
    if (other.entryPointKind === entryPointNone) {
      stableEntryPoints.push(stableSourceIndices[si]);
      other.entryPointKind = entryPointDynamicImport;
    }
  }
  stableEntryPoints.sort((a, b) => a - b);
  for (const stableIndex of stableEntryPoints) entryPoints.push(EntryPointWithSource(reachableFiles[stableIndex]));

  let tsEnums: Map<string, Map<string, any>> | null = null;
  let constValues: Map<string, any> | null = null;
  const bitCount = entryPoints.length;
  for (const sourceIndex of reachableFiles) {
    const file = files[sourceIndex];
    file.EntryBits = NewBitSet(bitCount);
    const repr = file.InputFile.Repr;
    if (repr instanceof JSRepr) {
      if (repr.AST.TSEnums.size > 0) { if (tsEnums === null) tsEnums = new Map(); for (const [k, v] of repr.AST.TSEnums) tsEnums.set(k, v); }
      if (repr.AST.ConstValues.size > 0) { if (constValues === null) constValues = new Map(); for (const [k, v] of repr.AST.ConstValues) constValues.set(k, v); }
    }
  }

  const g = new LinkerGraph();
  g.Symbols = symbols; g.TSEnums = tsEnums; g.ConstValues = constValues;
  g.entryPoints = entryPoints; g.Files = files;
  g.ReachableFiles = reachableFiles; g.StableSourceIndices = stableSourceIndices;
  return g;
}

function EntryPointWithSource(sourceIndex: number): EntryPoint {
  const ep = new EntryPoint(); ep.SourceIndex = sourceIndex; return ep;
}

function cloneJSRepr(repr: JSRepr): JSRepr {
  const c = new JSRepr();
  c.CSSSourceIndex = repr.CSSSourceIndex;
  const a = new js_ast.AST(); Object.assign(a, repr.AST);
  a.Symbols = repr.AST.Symbols.slice();
  a.Parts = repr.AST.Parts.map((p) => { const np = new js_ast.Part(); Object.assign(np, p); np.SymbolUses = new Map(p.SymbolUses); np.Dependencies = p.Dependencies.slice(); np.DeclaredSymbols = p.DeclaredSymbols.slice(); return np; });
  a.ImportRecords = repr.AST.ImportRecords.slice();
  a.NamedImports = new Map(repr.AST.NamedImports);
  a.NamedExports = new Map(repr.AST.NamedExports);
  if (repr.AST.ModuleScope) { const sc = new js_ast.Scope(); Object.assign(sc, repr.AST.ModuleScope); sc.Generated = repr.AST.ModuleScope.Generated.slice(); a.ModuleScope = sc; }
  c.AST = a;
  const m = new JSReprMeta();
  m.IsProbablyTypeScriptType = new Map(); m.ImportsToBind = new Map(); m.TopLevelSymbolToPartsOverlay = new Map();
  c.Meta = m;
  return c;
}
