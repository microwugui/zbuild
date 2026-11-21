// 1:1 移植自 esbuild internal/renamer/renamer.go（v0.28.2，commit f6058f83）
// 第 52 轮叶子优先规划：导出/编号重命名器的命名助手。真值表由 Go 探针固化在 testdata/renamer-name-go.json。
import { DefaultNameMinifierJS, FollowSymbols, Get, Index32, InvalidRef, MakeIndex32, NameMinifier, Ref, SlotCounts, SlotNamespace, Symbol as ASymbol, SymbolFlags, SymbolKind, SymbolMap } from "../ast/ast.ts";
import { Scope, SymbolUse } from "../js_ast/js_ast.ts";
import { Keywords, StrictModeReservedWords } from "../js_lexer/tables.ts";
import { ForceValidIdentifier, IsIdentifier } from "../js_ast/js_ident.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Go: type nameUse uint8 (renamer.go:556) */
export const nameUse = {
  nameUnused: 0,
  nameUsed: 1,
  nameUsedInSameScope: 2,
} as const;

/** Go: type ExportRenamer struct (renamer.go:632) */
export class ExportRenamer {
  used: Map<string, number> | null = null;
  count: number = 0;

  /** Go: func (r *ExportRenamer) NextRenamedName(name string) string (renamer.go:638) */
  NextRenamedName(name: string): string {
    if (this.used === null) this.used = new Map<string, number>();
    const used = this.used;
    let tries = used.get(name);
    if (tries !== undefined) {
      const prefix = name;
      for (;;) {
        tries++;
        name = prefix + String(tries);
        if (!used.has(name)) break;
      }
      used.set(name, tries);
    } else {
      used.set(name, 1);
    }
    return name;
  }

  /** Go: func (r *ExportRenamer) NextMinifiedName() string (renamer.go:658) */
  NextMinifiedName(): string {
    const name = DefaultNameMinifierJS.NumberToMinifiedName(this.count);
    this.count++;
    return name;
  }
}

/** Go: type numberScope struct (renamer.go:544) */
export class numberScope {
  parent: numberScope | null = null;
  nameCounts: Map<string, number> = new Map<string, number>();

  /** Go: func (s *numberScope) findNameUse(name string) nameUse (renamer.go:564) */
  findNameUse(name: string): number {
    const original = this;
    let s: numberScope | null = this;
    for (;;) {
      if (s.nameCounts.has(name)) return s === original ? nameUse.nameUsedInSameScope : nameUse.nameUsed;
      s = s.parent;
      if (s === null) return nameUse.nameUnused;
    }
  }

  /** Go: func (s *numberScope) findUnusedName(name string, ns ast.SlotNamespace) string (renamer.go:580) */
  findUnusedName(name: string, ns: number): string {
    const SlotPrivateName = 2;
    if (ns === SlotPrivateName) {
      const id = name.slice(1);
      if (!IsIdentifier(enc.encode(id))) name = dec.decode(ForceValidIdentifier(enc.encode("#"), enc.encode(id)));
    } else {
      if (!IsIdentifier(enc.encode(name))) name = dec.decode(ForceValidIdentifier(new Uint8Array(0), enc.encode(name)));
    }

    const use = this.findNameUse(name);
    if (use !== nameUse.nameUnused) {
      let tries = 1;
      if (use === nameUse.nameUsedInSameScope) tries = this.nameCounts.get(name)!;
      const prefix = name;
      for (;;) {
        tries++;
        name = prefix + String(tries);
        if (this.findNameUse(name) === nameUse.nameUnused) {
          if (use === nameUse.nameUsedInSameScope) this.nameCounts.set(prefix, tries);
          break;
        }
      }
    }

    this.nameCounts.set(name, 1);
    return name;
  }
}

/** Go: type StableSymbolCount struct (renamer.go:148) */
export class StableSymbolCount {
  StableSourceIndex: number = 0;
  RefSourceIndex: number = 0; // 忠实复刻 Go StableSymbolCount.Ref 的 SourceIndex（多源打包时非 0）
  RefInnerIndex: number = 0;
  Count: number = 0;
}

/** Go: type StableSymbolCountArray []StableSymbolCount (renamer.go:154) */
export class StableSymbolCountArray {
  items: StableSymbolCount[];
  constructor(items: StableSymbolCount[] = []) { this.items = items; }
  /** Go: func (a StableSymbolCountArray) Len() int (renamer.go:157) */
  Len(): number { return this.items.length; }
  /** Go: func (a StableSymbolCountArray) Swap(i, j int) (renamer.go:158) */
  Swap(i: number, j: number): void { const t = this.items[i]; this.items[i] = this.items[j]; this.items[j] = t; }
  /** Go: func (a StableSymbolCountArray) Less(i, j int) bool (renamer.go:160) */
  Less(i: number, j: number): boolean {
    const ai = this.items[i], aj = this.items[j];
    if (ai.Count > aj.Count) return true;
    if (ai.Count < aj.Count) return false;
    if (ai.StableSourceIndex < aj.StableSourceIndex) return true;
    if (ai.StableSourceIndex > aj.StableSourceIndex) return false;
    return ai.RefInnerIndex < aj.RefInnerIndex;
  }
}

/** Go: type slotAndCount struct (renamer.go:387) */
export class slotAndCount {
  slot: number = 0;
  count: number = 0;
}

/** Go: type slotAndCountArray []slotAndCount (renamer.go:391) */
export class slotAndCountArray {
  items: slotAndCount[];
  constructor(items: slotAndCount[] = []) { this.items = items; }
  /** Go: func (a slotAndCountArray) Len() int (renamer.go:393) */
  Len(): number { return this.items.length; }
  /** Go: func (a slotAndCountArray) Swap(i, j int) (renamer.go:394) */
  Swap(i: number, j: number): void { const t = this.items[i]; this.items[i] = this.items[j]; this.items[j] = t; }
  /** Go: func (a slotAndCountArray) Less(i, j int) bool (renamer.go:395) */
  Less(i: number, j: number): boolean {
    const ai = this.items[i], aj = this.items[j];
    return ai.count > aj.count || (ai.count === aj.count && ai.slot < aj.slot);
  }
}

/** Go: type symbolSlot struct (renamer.go:79) */
export interface symbolSlot { name: string; count: number; needsCapitalForJSX: number; }
const makeSlots = (n: number): symbolSlot[] => Array.from({ length: n }, () => ({ name: "", count: 0, needsCapitalForJSX: 0 }));
const refKey = (r: Ref): string => `${r.SourceIndex}:${r.InnerIndex}`;

/** Go: type noOpRenamer struct (renamer.go:66) */
export class noOpRenamer {
  symbols: SymbolMap;
  constructor(symbols: SymbolMap) { this.symbols = symbols; }
  /** Go: func (r *noOpRenamer) NameForSymbol(ref ast.Ref) string (renamer.go:76) */
  NameForSymbol(ref: Ref): string {
    ref = FollowSymbols(this.symbols, ref);
    return Get(this.symbols, ref).OriginalName;
  }
}
/** Go: func NewNoOpRenamer(symbols ast.SymbolMap) Renamer (renamer.go:70) */
export function NewNoOpRenamer(symbols: SymbolMap): noOpRenamer { return new noOpRenamer(symbols); }

/** Go: type MinifyRenamer struct (renamer.go:81) */
export class MinifyRenamer {
  reservedNames: Map<string, number>;
  slots: symbolSlot[][];
  topLevelSymbolToSlot: Map<string, number>;
  symbols: SymbolMap;
  constructor(symbols: SymbolMap, firstTopLevelSlots: number[], reservedNames: Map<string, number>) {
    this.symbols = symbols;
    this.reservedNames = reservedNames;
    this.slots = [
      makeSlots(firstTopLevelSlots[0]), makeSlots(firstTopLevelSlots[1]),
      makeSlots(firstTopLevelSlots[2]), makeSlots(firstTopLevelSlots[3]),
    ];
    this.topLevelSymbolToSlot = new Map<string, number>();
  }
  /** Go: func (r *MinifyRenamer) NameForSymbol(ref ast.Ref) string (renamer.go:111) */
  NameForSymbol(ref: Ref): string {
    ref = FollowSymbols(this.symbols, ref);
    const symbol = Get(this.symbols, ref);
    const ns = symbol.SlotNamespace();
    if (ns === SlotNamespace.SlotMustNotBeRenamed) return symbol.OriginalName;
    let i = symbol.NestedScopeSlot;
    if (!i.IsValid()) {
      const index = this.topLevelSymbolToSlot.get(refKey(ref));
      if (index === undefined) return symbol.OriginalName;
      i = MakeIndex32(index);
    }
    return this.slots[ns][i.GetIndex()].name;
  }

  /** Go: func (r *MinifyRenamer) AccumulateSymbolUseCounts(topLevelSymbols *StableSymbolCountArray, symbolUses map[ast.Ref]js_ast.SymbolUse, stableSourceIndices []uint32) (renamer.go:177) */
  AccumulateSymbolUseCounts(topLevelSymbols: StableSymbolCountArray, symbolUses: Map<string, SymbolUse>, stableSourceIndices: number[]): void {
    for (const [key, use] of symbolUses) {
      const p = key.lastIndexOf(":");
      this.AccumulateSymbolCount(topLevelSymbols, new Ref(Number(key.slice(0, p)), Number(key.slice(p + 1))), use.CountEstimate, stableSourceIndices);
    }
  }

  /** Go: func (r *MinifyRenamer) AccumulateSymbolCount(topLevelSymbols *StableSymbolCountArray, ref ast.Ref, count uint32, stableSourceIndices []uint32) (renamer.go:189) */
  AccumulateSymbolCount(topLevelSymbols: StableSymbolCountArray, ref: Ref, count: number, stableSourceIndices: number[]): void {
    ref = FollowSymbols(this.symbols, ref);
    let symbol = Get(this.symbols, ref);
    while (symbol.NamespaceAlias !== null) {
      ref = FollowSymbols(this.symbols, symbol.NamespaceAlias.NamespaceRef);
      symbol = Get(this.symbols, ref);
    }
    const ns = symbol.SlotNamespace();
    if (ns === SlotNamespace.SlotMustNotBeRenamed) return;

    if (symbol.NestedScopeSlot.IsValid()) {
      const slot = this.slots[ns][symbol.NestedScopeSlot.GetIndex()];
      slot.count += count;
      if (SymbolFlags.Has(symbol.Flags, SymbolFlags.MustStartWithCapitalLetterForJSX)) slot.needsCapitalForJSX = 1;
      return;
    }

    const sc = new StableSymbolCount();
    sc.StableSourceIndex = stableSourceIndices[ref.SourceIndex];
    sc.RefSourceIndex = ref.SourceIndex;
    sc.RefInnerIndex = ref.InnerIndex;
    sc.Count = count;
    topLevelSymbols.items.push(sc);
  }

  /** Go: func (r *MinifyRenamer) AllocateTopLevelSymbolSlots(topLevelSymbols StableSymbolCountArray) (renamer.go:235) */
  AllocateTopLevelSymbolSlots(topLevelSymbols: StableSymbolCountArray): void {
    for (const stable of topLevelSymbols.items) {
      const symbol = Get(this.symbols, new Ref(stable.RefSourceIndex, stable.RefInnerIndex));
      const slots = this.slots[symbol.SlotNamespace()];
      const key = `${stable.RefSourceIndex}:${stable.RefInnerIndex}`;
      const existing = this.topLevelSymbolToSlot.get(key);
      if (existing !== undefined) {
        const slot = slots[existing];
        slot.count += stable.Count;
        if (SymbolFlags.Has(symbol.Flags, SymbolFlags.MustStartWithCapitalLetterForJSX)) slot.needsCapitalForJSX = 1;
      } else {
        const needsCapital = SymbolFlags.Has(symbol.Flags, SymbolFlags.MustStartWithCapitalLetterForJSX) ? 1 : 0;
        const i = slots.length;
        slots.push({ name: "", count: stable.Count, needsCapitalForJSX: needsCapital });
        this.topLevelSymbolToSlot.set(key, i);
      }
    }
  }

  /** Go: func (r *MinifyRenamer) AssignNamesByFrequency(minifier *ast.NameMinifier) (renamer.go:260) */
  AssignNamesByFrequency(minifier: NameMinifier): void {
    for (let ns = 0; ns < this.slots.length; ns++) {
      const slots = this.slots[ns];
      const sorted = new slotAndCountArray(slots.map((item, i) => {
        const s = new slotAndCount(); s.slot = i; s.count = item.count; return s;
      }));
      sorted.items.sort((a, b) => a.count > b.count ? -1 : a.count < b.count ? 1 : a.slot - b.slot);
      let nextName = 0;
      for (const data of sorted.items) {
        const slot = slots[data.slot];
        let name = minifier.NumberToMinifiedName(nextName); nextName++;
        if (ns === SlotNamespace.SlotDefault) {
          while ((this.reservedNames.get(name) ?? 0) !== 0) { name = minifier.NumberToMinifiedName(nextName); nextName++; }
          if (slot.needsCapitalForJSX !== 0) {
            while (name.charCodeAt(0) >= 0x61 && name.charCodeAt(0) <= 0x7a) { name = minifier.NumberToMinifiedName(nextName); nextName++; }
          }
        } else if (ns === SlotNamespace.SlotLabel) {
          while (Keywords.has(name)) { name = minifier.NumberToMinifiedName(nextName); nextName++; }
        }
        if (ns === SlotNamespace.SlotPrivateName) name = "#" + name;
        slot.name = name;
      }
    }
  }
}
/** Go: func NewMinifyRenamer(symbols, firstTopLevelSlots, reservedNames) *MinifyRenamer (renamer.go:97) */
export function NewMinifyRenamer(symbols: SymbolMap, firstTopLevelSlots: number[], reservedNames: Map<string, number>): MinifyRenamer {
  return new MinifyRenamer(symbols, firstTopLevelSlots, reservedNames);
}

/** Go: type NumberRenamer struct (renamer.go:403) */
export class NumberRenamer {
  symbols: SymbolMap;
  root: numberScope;
  names: (string[] | undefined)[];
  constructor(symbols: SymbolMap, reservedNames: Map<string, number>) {
    this.symbols = symbols;
    this.names = new Array(symbols.SymbolsForSource.length);
    this.root = new numberScope();
    this.root.nameCounts = new Map(reservedNames);
  }
  /** Go: func (r *NumberRenamer) NameForSymbol(ref ast.Ref) string (renamer.go:417) */
  NameForSymbol(ref: Ref): string {
    ref = FollowSymbols(this.symbols, ref);
    const inner = this.names[ref.SourceIndex];
    if (inner !== undefined && inner[ref.InnerIndex] !== undefined && inner[ref.InnerIndex] !== "") return inner[ref.InnerIndex];
    return Get(this.symbols, ref).OriginalName;
  }

  /** Go: func (r *NumberRenamer) AddTopLevelSymbol(ref ast.Ref) (renamer.go:427) */
  AddTopLevelSymbol(ref: Ref): void { this.assignName(this.root, ref); }

  /** Go: func (r *NumberRenamer) assignName(scope *numberScope, ref ast.Ref) (renamer.go:431) */
  assignName(scope: numberScope, ref: Ref): void {
    ref = FollowSymbols(this.symbols, ref);
    const inner = this.names[ref.SourceIndex];
    if (inner !== undefined && inner[ref.InnerIndex] !== undefined && inner[ref.InnerIndex] !== "") return;

    const symbol = Get(this.symbols, ref);
    const ns = symbol.SlotNamespace();
    if (ns !== SlotNamespace.SlotDefault && ns !== SlotNamespace.SlotPrivateName) return;

    let originalName = symbol.OriginalName;
    if (SymbolFlags.Has(symbol.Flags, SymbolFlags.MustStartWithCapitalLetterForJSX)) {
      const first = originalName.charCodeAt(0);
      if (first >= 0x61 && first <= 0x7a) {
        originalName = String.fromCharCode(first + (0x41 - 0x61)) + originalName.slice(1);
      }
    }

    const name = scope.findUnusedName(originalName, ns);
    let target = inner;
    if (target === undefined) {
      target = new Array(this.symbols.SymbolsForSource[ref.SourceIndex]?.length ?? 0);
      this.names[ref.SourceIndex] = target;
    }
    target[ref.InnerIndex] = name;
  }

  /** Go: func (r *NumberRenamer) assignNamesInScope(scope *js_ast.Scope, sourceIndex uint32, parent *numberScope, sorted *[]int) *numberScope (renamer.go:475) */
  assignNamesInScope(scope: Scope, sourceIndex: number, parent: numberScope, sorted: number[]): numberScope {
    const s = new numberScope();
    s.parent = parent;
    s.nameCounts = new Map<string, number>();
    if (scope.Members.size > 0) {
      sorted.length = 0;
      for (const member of scope.Members.values()) sorted.push(member.Ref.InnerIndex);
      sorted.sort((a, b) => a - b);
      for (const innerIndex of sorted) this.assignName(s, new Ref(sourceIndex, innerIndex));
    }
    for (const ref of scope.Generated) this.assignName(s, ref);
    return s;
  }

  /** Go: func (r *NumberRenamer) assignNamesRecursive(scope *js_ast.Scope, sourceIndex uint32, parent *numberScope, sorted *[]int) (renamer.go:500) */
  assignNamesRecursive(scope: Scope, sourceIndex: number, parent: numberScope, sorted: number[]): void {
    for (;;) {
      if (scope.Members.size > 0 || scope.Generated.length > 0) {
        parent = this.assignNamesInScope(scope, sourceIndex, parent, sorted);
      }
      if (scope.Children.length === 1) {
        scope = scope.Children[0];
      } else break;
    }
    for (const child of scope.Children) this.assignNamesRecursive(child, sourceIndex, parent, sorted);
  }

  /** Go: func (r *NumberRenamer) AssignNamesByScope(nestedScopes map[uint32][]*js_ast.Scope) (renamer.go:526) */
  AssignNamesByScope(nestedScopes: Map<number, Scope[]>): void {
    for (const [sourceIndex, scopes] of nestedScopes) {
      const sorted: number[] = [];
      for (const scope of scopes) this.assignNamesRecursive(scope, sourceIndex, this.root, sorted);
    }
  }
}
/** Go: func NewNumberRenamer(symbols ast.SymbolMap, reservedNames map[string]uint32) *NumberRenamer (renamer.go:409) */
export function NewNumberRenamer(symbols: SymbolMap, reservedNames: Map<string, number>): NumberRenamer {
  return new NumberRenamer(symbols, reservedNames);
}

/** Go: func ComputeReservedNames(moduleScopes []*js_ast.Scope, symbols ast.SymbolMap) map[string]uint32 (renamer.go:15) */
export function ComputeReservedNames(moduleScopes: Scope[], symbols: SymbolMap): Map<string, number> {
  const names = new Map<string, number>();
  for (const k of Keywords.keys()) names.set(k, 1);
  for (const k of StrictModeReservedWords) names.set(k, 1);
  for (const scope of moduleScopes) computeReservedNamesForScope(scope, symbols, names);
  return names;
}

/** Go: func computeReservedNamesForScope(scope *js_ast.Scope, symbols ast.SymbolMap, names map[string]uint32) (renamer.go:34) */
export function computeReservedNamesForScope(scope: Scope, symbols: SymbolMap, names: Map<string, number>): void {
  for (const member of scope.Members.values()) {
    const symbol = Get(symbols, member.Ref);
    if (symbol.Kind === SymbolKind.SymbolUnbound || SymbolFlags.Has(symbol.Flags, SymbolFlags.MustNotBeRenamed)) names.set(symbol.OriginalName, 1);
  }
  for (const ref of scope.Generated) {
    const symbol = Get(symbols, ref);
    if (symbol.Kind === SymbolKind.SymbolUnbound || SymbolFlags.Has(symbol.Flags, SymbolFlags.MustNotBeRenamed)) names.set(symbol.OriginalName, 1);
  }
  if (scope.ContainsDirectEval) {
    for (const child of scope.Children) {
      if (child.ContainsDirectEval) computeReservedNamesForScope(child, symbols, names);
    }
  }
}

/** Go: func AssignNestedScopeSlots(moduleScope *js_ast.Scope, symbols []ast.Symbol) (slotCounts ast.SlotCounts) (renamer.go:314) */
export function AssignNestedScopeSlots(moduleScope: Scope, symbols: ASymbol[]): SlotCounts {
  const slotCounts = new SlotCounts();
  const validSlot = MakeIndex32(1);
  for (const member of moduleScope.Members.values()) symbols[member.Ref.InnerIndex].NestedScopeSlot = validSlot;
  for (const ref of moduleScope.Generated) symbols[ref.InnerIndex].NestedScopeSlot = validSlot;
  for (const child of moduleScope.Children) slotCounts.UnionMax(assignNestedScopeSlotsHelper(child, symbols, new SlotCounts()));
  for (const member of moduleScope.Members.values()) symbols[member.Ref.InnerIndex].NestedScopeSlot = new Index32();
  for (const ref of moduleScope.Generated) symbols[ref.InnerIndex].NestedScopeSlot = new Index32();
  return slotCounts;
}

/** Go: func assignNestedScopeSlotsHelper(scope *js_ast.Scope, symbols []ast.Symbol, slot ast.SlotCounts) ast.SlotCounts (renamer.go:344) */
export function assignNestedScopeSlotsHelper(scope: Scope, symbols: ASymbol[], slot: SlotCounts): SlotCounts {
  const sortedMembers: number[] = [];
  for (const member of scope.Members.values()) sortedMembers.push(member.Ref.InnerIndex);
  sortedMembers.sort((a, b) => a - b);
  for (const innerIndex of sortedMembers) {
    const symbol = symbols[innerIndex];
    const ns = symbol.SlotNamespace();
    if (ns !== SlotNamespace.SlotMustNotBeRenamed && !symbol.NestedScopeSlot.IsValid()) {
      symbol.NestedScopeSlot = MakeIndex32(slot.values[ns]);
      slot.values[ns]++;
    }
  }
  for (const ref of scope.Generated) {
    const symbol = symbols[ref.InnerIndex];
    const ns = symbol.SlotNamespace();
    if (ns !== SlotNamespace.SlotMustNotBeRenamed && !symbol.NestedScopeSlot.IsValid()) {
      symbol.NestedScopeSlot = MakeIndex32(slot.values[ns]);
      slot.values[ns]++;
    }
  }
  if (!scope.Label.Ref.Equals(InvalidRef)) {
    const symbol = symbols[scope.Label.Ref.InnerIndex];
    symbol.NestedScopeSlot = MakeIndex32(slot.values[SlotNamespace.SlotLabel]);
    slot.values[SlotNamespace.SlotLabel]++;
  }
  const slotCounts = slot;
  for (const child of scope.Children) slotCounts.UnionMax(assignNestedScopeSlotsHelper(child, symbols, slot));
  return slotCounts;
}

// ============================================================================
// 第 93 轮：ComputeReservedNames + linker.renameSymbolsInChunk 的保留名追加。
// Go 探针 tools/go/tmpgen_reserved_test.bak → testdata/reserved-names-go.json（4 组 mode/format/platform）。
// 这是 renamer 层解决 document→document2 冲突的底座：所有 unbound 全局名一律保留，
// 绝不因「同名局部变量存在」而删除（旧 bundle 驱动的 delete-declared hack 是错的）。
// ============================================================================

/**
 * Go: ComputeReservedNames(moduleScopes, symbols) + linker.go:5340-5345 追加。
 * @param mode config.Mode（0 passthrough / 1 convert / 2 bundle）
 * @param format config.Format（0 preserve / 1 iife / 2 cjs / 3 esm）
 * @param platform config.Platform（0 browser / 1 node / 2 neutral）
 */
export function computeChunkReservedNames(
  moduleScopes: Scope[], symbols: SymbolMap, mode: number, format: number, platform: number,
): Map<string, number> {
  const names = ComputeReservedNames(moduleScopes, symbols);
  // linker.go:5340 —— cjs+node 下避免 node 对 exports/module 的静态误判
  if (format === 2 /* FormatCommonJS */ && platform === 1 /* PlatformNode */) {
    names.set("exports", 1); names.set("module", 1);
  }
  // linker.go:5344 —— bundling 实现所需空闲名
  if (mode !== 0 /* ModePassThrough */) {
    names.set("require", 1); names.set("Promise", 1);
  }
  return names;
}

