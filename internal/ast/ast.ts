// 1:1 移植自 esbuild internal/ast/ast.go（v0.28.2，commit f6058f83）
//
// 依赖：`../logger/logger.ts`（`Loc`/`Range`，已是真实现，不是桩）、`../helpers/utf.ts`。
//
// DEVIATION: Go 的 `type ImportKind uint8` + iota 常量，在 TS 里用「const 对象 + 同名
// 数字类型」表达（node --experimental-strip-types 不支持 enum，enum 不是可擦除语法）。
// 数值与 Go 的 iota 逐一对应，行为等价；`uint8` 的截断语义在 TS 中不存在，故省去。

import { UTF16EqualsString } from "../helpers/utf.ts";
import { Loc } from "../logger/logger.ts";

/** Go: type ImportKind uint8 */
export type ImportKind = number;
export const ImportKind = {
  /** Go: ImportEntryPoint —— An entry point provided by the user */
  ImportEntryPoint: 0,
  /** Go: ImportStmt —— An ES6 import or re-export statement */
  ImportStmt: 1,
  /** Go: ImportRequire —— A call to "require()" */
  ImportRequire: 2,
  /** Go: ImportDynamic —— An "import()" expression with a string argument */
  ImportDynamic: 3,
  /** Go: ImportRequireResolve —— A call to "require.resolve()" */
  ImportRequireResolve: 4,
  /** Go: ImportAt —— A CSS "@import" rule */
  ImportAt: 5,
  /** Go: ImportComposesFrom —— A CSS "composes" declaration */
  ImportComposesFrom: 6,
  /** Go: ImportURL —— A CSS "url(...)" token */
  ImportURL: 7,
} as const;

/** Go: func (kind ImportKind) StringForMetafile() string */
export function StringForMetafile(kind: ImportKind): string {
  switch (kind) {
    case ImportKind.ImportStmt:
      return "import-statement";
    case ImportKind.ImportRequire:
      return "require-call";
    case ImportKind.ImportDynamic:
      return "dynamic-import";
    case ImportKind.ImportRequireResolve:
      return "require-resolve";
    case ImportKind.ImportAt:
      return "import-rule";
    case ImportKind.ImportComposesFrom:
      return "composes-from";
    case ImportKind.ImportURL:
      return "url-token";
    case ImportKind.ImportEntryPoint:
      return "entry-point";
    default:
      // Go: panic("Internal error")
      throw new Error("Internal error");
  }
}

/** Go: func (kind ImportKind) IsFromCSS() bool */
export function IsFromCSS(kind: ImportKind): boolean {
  switch (kind) {
    case ImportKind.ImportAt:
    case ImportKind.ImportComposesFrom:
    case ImportKind.ImportURL:
      return true;
  }
  return false;
}

/** Go: func (kind ImportKind) MustResolveToCSS() bool */
export function MustResolveToCSS(kind: ImportKind): boolean {
  switch (kind) {
    case ImportKind.ImportAt:
    case ImportKind.ImportComposesFrom:
      return true;
  }
  return false;
}

/**
 * Go: type ImportPhase uint8
 *
 * 第 12 次推进补（js_ast.EImportCall.Phase 需要）：与 Go 的 iota 顺序一致。
 */
export type ImportPhase = number;
export const ImportPhase = {
  EvaluationPhase: 0,

  // See: https://github.com/tc39/proposal-defer-import-eval
  DeferPhase: 1,

  // See: https://github.com/tc39/proposal-source-phase-imports
  SourcePhase: 2,
} as const;

/** Go: type ImportRecordFlags uint16 */
export type ImportRecordFlags = number;
export const ImportRecordFlags = {
  /** Go: IsUnused —— the parser created an import record and decides it isn't needed */
  IsUnused: 1 << 0,
  /** Go: ContainsImportStar —— the import contains syntax like "* as ns" */
  ContainsImportStar: 1 << 1,
  /** Go: ContainsDefaultAlias —— the import contains an import for the alias "default" */
  ContainsDefaultAlias: 1 << 2,
  /** Go: ContainsESModuleAlias —— the import contains an import for the alias "__esModule" */
  ContainsESModuleAlias: 1 << 3,
  /** Go: CallsRunTimeReExportFn —— "export * from" evaluated by "__reExport()" */
  CallsRunTimeReExportFn: 1 << 4,
  /** Go: WrapWithToESM —— wrap this call to "require()" in "__toESM(...)" */
  WrapWithToESM: 1 << 5,
  /** Go: WrapWithToCJS —— wrap this ESM exports object in "__toCJS(...)" */
  WrapWithToCJS: 1 << 6,
  /** Go: CallRuntimeRequire —— use the runtime "__require()" instead of "require()" */
  CallRuntimeRequire: 1 << 7,
  /** Go: HandlesImportErrors —— the import is inside a try/catch or a .catch() handler */
  HandlesImportErrors: 1 << 8,
  /** Go: WasOriginallyBareImport —— originally written as a bare "import 'file'" statement */
  WasOriginallyBareImport: 1 << 9,
  /** Go: IsExternalWithoutSideEffects —— this import can be removed if it's unused */
  IsExternalWithoutSideEffects: 1 << 10,
  /** Go: AssertTypeJSON —— "assert { type: 'json' }" was present */
  AssertTypeJSON: 1 << 11,
  /** Go: ShouldNotBeExternalInMetafile —— do not generate "external": true in the metafile */
  ShouldNotBeExternalInMetafile: 1 << 12,
  /** Go: WasLoadedWithEmptyLoader —— CSS "@import" of an empty file should be removed */
  WasLoadedWithEmptyLoader: 1 << 13,
  /** Go: ContainsUniqueKey —— unique keys must not ever be split apart */
  ContainsUniqueKey: 1 << 14,
} as const;

/** Go: func (flags ImportRecordFlags) Has(flag ImportRecordFlags) bool */
export function Has(flags: ImportRecordFlags, flag: ImportRecordFlags): boolean {
  // Go: return (flags & flag) != 0
  return (flags & flag) !== 0;
}

/** Go: type AssertOrWithKeyword uint8 */
export type AssertOrWithKeyword = number;
export const AssertOrWithKeyword = {
  /** Go: AssertKeyword */
  AssertKeyword: 0,
  /** Go: WithKeyword */
  WithKeyword: 1,
} as const;

/** Go: func (kw AssertOrWithKeyword) String() string */
export function String(kw: AssertOrWithKeyword): string {
  if (kw === AssertOrWithKeyword.AssertKeyword) return "assert";
  return "with";
}

/**
 * Go: type Index32 struct { flippedBits uint32 }
 *
 * This stores a 32-bit index where the zero value is an invalid index.
 * TS 用 `>>> 0` 复现 `uint32` 的环绕语义（Go 的 ^ 对 uint32 是按位取反后仍是 uint32）。
 */
export class Index32 {
  flippedBits: number;

  constructor(flippedBits: number = 0) {
    this.flippedBits = flippedBits >>> 0;
  }

  /** Go: func (i Index32) IsValid() bool */
  IsValid(): boolean {
    return this.flippedBits !== 0;
  }

  /** Go: func (i Index32) GetIndex() uint32 */
  GetIndex(): number {
    return ~this.flippedBits >>> 0;
  }
}

/** Go: func MakeIndex32(index uint32) Index32 */
export function MakeIndex32(index: number): Index32 {
  return new Index32(~index >>> 0);
}

/** Go: type SymbolKind uint8 */
export type SymbolKind = number;
export const SymbolKind = {
  /** Go: SymbolUnbound —— isn't declared in the file it's referenced in */
  SymbolUnbound: 0,
  /** Go: SymbolHoisted —— function args / function statements / "var" */
  SymbolHoisted: 1,
  /** Go: SymbolHoistedFunction */
  SymbolHoistedFunction: 2,
  /** Go: SymbolCatchIdentifier —— catch variables declared using an identifier */
  SymbolCatchIdentifier: 3,
  /** Go: SymbolGeneratorOrAsyncFunction */
  SymbolGeneratorOrAsyncFunction: 4,
  /** Go: SymbolArguments —— the special "arguments" variable */
  SymbolArguments: 5,
  /** Go: SymbolClass */
  SymbolClass: 6,
  /** Go: SymbolClassInComputedPropertyKey */
  SymbolClassInComputedPropertyKey: 7,
  /** Go: SymbolPrivateField —— a class-private identifier ("#foo") */
  SymbolPrivateField: 8,
  SymbolPrivateMethod: 9,
  SymbolPrivateGet: 10,
  SymbolPrivateSet: 11,
  SymbolPrivateGetSetPair: 12,
  SymbolPrivateStaticField: 13,
  SymbolPrivateStaticMethod: 14,
  SymbolPrivateStaticGet: 15,
  SymbolPrivateStaticSet: 16,
  SymbolPrivateStaticGetSetPair: 17,
  /** Go: SymbolLabel —— labels are in their own namespace */
  SymbolLabel: 18,
  /** Go: SymbolTSEnum */
  SymbolTSEnum: 19,
  /** Go: SymbolTSNamespace */
  SymbolTSNamespace: 20,
  /** Go: SymbolImport */
  SymbolImport: 21,
  /** Go: SymbolConst —— assigning throws a TypeError at runtime */
  SymbolConst: 22,
  /** Go: SymbolInjected —— can be overridden by provided defines */
  SymbolInjected: 23,
  /** Go: SymbolMangledProp —— properties can optionally be renamed to shorter names */
  SymbolMangledProp: 24,
  /** Go: SymbolGlobalCSS —— CSS identifiers that are never renamed */
  SymbolGlobalCSS: 25,
  /** Go: SymbolLocalCSS —— CSS identifiers renamed to be unique to their file */
  SymbolLocalCSS: 26,
  /** Go: SymbolOther */
  SymbolOther: 27,
} as const;

/** Go: func (kind SymbolKind) IsPrivate() bool */
export function IsPrivate(kind: SymbolKind): boolean {
  return kind >= SymbolKind.SymbolPrivateField && kind <= SymbolKind.SymbolPrivateStaticGetSetPair;
}

/** Go: func (kind SymbolKind) IsHoisted() bool */
export function IsHoisted(kind: SymbolKind): boolean {
  return kind === SymbolKind.SymbolHoisted || kind === SymbolKind.SymbolHoistedFunction;
}

/** Go: func (kind SymbolKind) IsHoistedOrFunction() bool */
export function IsHoistedOrFunction(kind: SymbolKind): boolean {
  return IsHoisted(kind) || kind === SymbolKind.SymbolGeneratorOrAsyncFunction;
}

/** Go: func (kind SymbolKind) IsFunction() bool */
export function IsFunction(kind: SymbolKind): boolean {
  return kind === SymbolKind.SymbolHoistedFunction || kind === SymbolKind.SymbolGeneratorOrAsyncFunction;
}

/** Go: func (kind SymbolKind) IsUnboundOrInjected() bool */
export function IsUnboundOrInjected(kind: SymbolKind): boolean {
  return kind === SymbolKind.SymbolUnbound || kind === SymbolKind.SymbolInjected;
}

/** Go: type SymbolFlags uint16 */
export type SymbolFlags = number;
export const SymbolFlags = {
  /** Go: MustNotBeRenamed */
  MustNotBeRenamed: 1 << 0,
  /** Go: MustStartWithCapitalLetterForJSX */
  MustStartWithCapitalLetterForJSX: 1 << 1,
  /** Go: DidKeepName —— target of a "__name" helper call */
  DidKeepName: 1 << 2,
  /** Go: PrivateSymbolMustBeLowered */
  PrivateSymbolMustBeLowered: 1 << 3,
  /** Go: RemoveOverwrittenFunctionDeclaration */
  RemoveOverwrittenFunctionDeclaration: 1 << 4,
  /** Go: DidWarnAboutCommonJSInESM */
  DidWarnAboutCommonJSInESM: 1 << 5,
  /** Go: CouldPotentiallyBeMutated */
  CouldPotentiallyBeMutated: 1 << 6,
  /** Go: WasExported */
  WasExported: 1 << 7,
  /** Go: IsEmptyFunction */
  IsEmptyFunction: 1 << 8,
  /** Go: IsIdentityFunction */
  IsIdentityFunction: 1 << 9,
  /** Go: CallCanBeUnwrappedIfUnused */
  CallCanBeUnwrappedIfUnused: 1 << 10,

  /** Go: func (flags SymbolFlags) Has(flag SymbolFlags) bool */
  Has(flags: SymbolFlags, flag: SymbolFlags): boolean {
    return (flags & flag) !== 0;
  },
} as const;

/** Go: type SlotNamespace uint8 */
export type SlotNamespace = number;
export const SlotNamespace = {
  SlotDefault: 0,
  SlotLabel: 1,
  SlotPrivateName: 2,
  SlotMangledProp: 3,
  SlotMustNotBeRenamed: 4,
} as const;

/** Go: type SlotCounts [4]uint32 */
export class SlotCounts {
  values: number[];

  constructor(values?: number[]) {
    this.values = (values ?? [0, 0, 0, 0]).map((v) => v >>> 0);
  }

  /** Go: func (a *SlotCounts) UnionMax(b SlotCounts) —— 就地取每槽最大值 */
  UnionMax(b: SlotCounts): void {
    for (let i = 0; i < 4; i++) {
      if (this.values[i] < b.values[i]) this.values[i] = b.values[i];
    }
  }
}

/** Go: type CharFreq [64]int32 —— histogram of character frequencies for minification */
export class CharFreq {
  values: Int32Array;

  constructor(values?: Int32Array) {
    this.values = values ?? new Int32Array(64);
  }

  /** Go: func (freq *CharFreq) Scan(text string, delta int32) */
  Scan(text: string, delta: number): void {
    if (delta === 0) return;

    // 与 Go 一致：只统计 ASCII 可被压缩为标识符的字符；这是合法的偏差（Go 按 UTF-8 字节遍历）
    for (let i = 0, n = text.length; i < n; i++) {
      const c = text.charCodeAt(i);
      if (c >= 0x61 && c <= 0x7a) {
        // 'a'..'z' -> 0..25
        this.values[c - 0x61] = (this.values[c - 0x61] + delta) | 0;
      } else if (c >= 0x41 && c <= 0x5a) {
        // 'A'..'Z' -> 26..51
        this.values[c - 0x41 + 26] = (this.values[c - 0x41 + 26] + delta) | 0;
      } else if (c >= 0x30 && c <= 0x39) {
        // '0'..'9' -> 52..61
        this.values[c - 0x30 + 52] = (this.values[c - 0x30 + 52] + delta) | 0;
      } else if (c === 0x5f) {
        // '_' -> 62
        this.values[62] = (this.values[62] + delta) | 0;
      } else if (c === 0x24) {
        // '$' -> 63
        this.values[63] = (this.values[63] + delta) | 0;
      }
    }
  }

  /** Go: func (freq *CharFreq) Include(other *CharFreq) */
  Include(other: CharFreq): void {
    for (let i = 0; i < 64; i++) {
      this.values[i] = (this.values[i] + other.values[i]) | 0;
    }
  }
}

/** Go: type charAndCount struct { char string; count int32; index byte } */
export interface charAndCount {
  char: string;
  count: number;
  index: number;
}

/**
 * Go: type charAndCountArray []charAndCount —— 这个类型只是为了用 Go 自带的 sort
 *
 * DEVIATION: Go 用 `sort.Sort` 加 Len/Swap/Less 三个方法；TS 侧方法名与语义逐一对应，
 * 排序入口由调用方用 `Array.prototype.sort` 配 `Less` 完成（V8 的 sort 是稳定排序，
 * 而此处的比较器只有「count 相同且 index 相同」时才不构成全序，见 ShuffleByCharFreq）。
 */
export class charAndCountArray {
  items: charAndCount[];

  constructor(length: number) {
    this.items = new Array(length);
    for (let i = 0; i < length; i++) this.items[i] = { char: "", count: 0, index: 0 };
  }

  /** Go: func (a charAndCountArray) Len() int */
  Len(): number {
    return this.items.length;
  }

  /** Go: func (a charAndCountArray) Swap(i int, j int) */
  Swap(i: number, j: number): void {
    const t = this.items[i];
    this.items[i] = this.items[j];
    this.items[j] = t;
  }

  /** Go: func (a charAndCountArray) Less(i int, j int) bool */
  Less(i: number, j: number): boolean {
    const ai = this.items[i];
    const aj = this.items[j];
    return ai.count > aj.count || (ai.count === aj.count && ai.index < aj.index);
  }
}

/**
 * DEVIATION: Go 用 `sort.Sort(array)`（pdqsort）；这里用插入排序，但走同一套
 * Len/Swap/Less，比较器在真实条目上构成全序（index 唯一），因此排序结果相同。
 * 等价性由上面的「前 60 个名字与 Go 逐字一致」测试钉住。
 */
function sortCharAndCountArray(array: charAndCountArray): void {
  for (let i = 1; i < array.Len(); i++) {
    for (let j = i; j > 0 && array.Less(j, j - 1); j--) array.Swap(j, j - 1);
  }
}

/** Go: type NameMinifier struct { head string; tail string } */
export class NameMinifier {
  head: string;
  tail: string;

  constructor(head = "", tail = "") {
    this.head = head;
    this.tail = tail;
  }

  /** Go: func (source NameMinifier) ShuffleByCharFreq(freq CharFreq) NameMinifier */
  ShuffleByCharFreq(freq: CharFreq): NameMinifier {
    // Sort the histogram in descending order by count
    const array = new charAndCountArray(64);
    for (let i = 0; i < this.tail.length; i++) {
      array.items[i] = { char: this.tail[i], index: i, count: freq.values[i] };
    }
    // Go: sort.Sort(array)
    sortCharAndCountArray(array);

    // Compute the identifier start and identifier continue sequences
    let head = "";
    let tail = "";
    for (const item of array.items) {
      if (item.char < "0" || item.char > "9") head += item.char;
      tail += item.char;
    }
    return new NameMinifier(head, tail);
  }

  /** Go: func (minifier NameMinifier) NumberToMinifiedName(i int) string */
  NumberToMinifiedName(i: number): string {
    const n_head = this.head.length;
    const n_tail = this.tail.length;

    let j = i % n_head;
    let name = this.head[j];
    i = Math.floor(i / n_head);

    while (i > 0) {
      i--;
      j = i % n_tail;
      name += this.tail[j];
      i = Math.floor(i / n_tail);
    }

    return name;
  }
}

/** Go: var DefaultNameMinifierJS */
export const DefaultNameMinifierJS = new NameMinifier(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$",
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$",
);

/** Go: var DefaultNameMinifierCSS */
export const DefaultNameMinifierCSS = new NameMinifier(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_",
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_",
);

/** Go: type ImportItemStatus uint8 */
export type ImportItemStatus = number;
export const ImportItemStatus = {
  ImportItemNone: 0,
  /** Go: ImportItemGenerated —— the linker doesn't report import/export mismatch errors */
  ImportItemGenerated: 1,
  /** Go: ImportItemMissing —— the printer will replace this import with "undefined" */
  ImportItemMissing: 2,
} as const;

/**
 * Go: type Ref struct { SourceIndex uint32; InnerIndex uint32 }
 *
 * DEVIATION: Go 用 `==` 比较 Ref 值；TS 的 class 按引用比较，故提供 `Equals`。
 * `InvalidRef` 是共享的不可变对象（Ref 无就地修改方法），可安全共用。
 */
export class Ref {
  SourceIndex: number;
  InnerIndex: number;

  constructor(SourceIndex: number = 0, InnerIndex: number = 0) {
    this.SourceIndex = SourceIndex >>> 0;
    this.InnerIndex = InnerIndex >>> 0;
  }

  Equals(other: Ref): boolean {
    return this.SourceIndex === other.SourceIndex && this.InnerIndex === other.InnerIndex;
  }
}

/** Go: type LocRef struct { Loc logger.Loc; Ref Ref } */
export class LocRef {
  Loc: Loc;
  Ref: Ref;

  constructor(loc: Loc = new Loc(0), ref: Ref = new Ref(0, 0)) {
    this.Loc = loc;
    this.Ref = ref;
  }
}

/** Go: var InvalidRef = Ref{^uint32(0), ^uint32(0)} */
export const InvalidRef = new Ref(0xffffffff, 0xffffffff);

/** Go: type NamespaceAlias struct { Alias string; NamespaceRef Ref } */
export class NamespaceAlias {
  Alias: string;
  NamespaceRef: Ref;

  constructor(Alias: string = "", NamespaceRef: Ref = InvalidRef) {
    this.Alias = Alias;
    this.NamespaceRef = NamespaceRef;
  }
}

/**
 * Go: type Symbol struct {...}
 *
 * "Note: the order of values in this struct matters to reduce struct size." —— TS 无此约束。
 * 字段名与 Go 一致（含首字母大写），方便与 `MergeContentsWith` / `SlotNamespace` 对照。
 */
export class Symbol {
  NamespaceAlias: NamespaceAlias | null = null;
  OriginalName = "";
  // Go 的零值是 Ref{0,0}（不是 InvalidRef）；使用时必须像 Go 侧一样显式初始化。
  // 这里刻意不复用 InvalidRef，以免「TS 能跑、Go 会递归到爆栈」的隐性偏差。
  Link: Ref = new Ref(0, 0);
  UseCountEstimate = 0;
  ChunkIndex = new Index32();
  NestedScopeSlot = new Index32();
  Flags: SymbolFlags = 0;
  Kind: SymbolKind = 0;
  ImportItemStatus: ImportItemStatus = ImportItemStatus.ImportItemNone;

  /** Go: func (newSymbol *Symbol) MergeContentsWith(oldSymbol *Symbol) */
  MergeContentsWith(oldSymbol: Symbol): void {
    this.UseCountEstimate += oldSymbol.UseCountEstimate;
    if (
      SymbolFlags.Has(oldSymbol.Flags, SymbolFlags.MustNotBeRenamed) &&
      !SymbolFlags.Has(this.Flags, SymbolFlags.MustNotBeRenamed)
    ) {
      this.OriginalName = oldSymbol.OriginalName;
      this.Flags |= SymbolFlags.MustNotBeRenamed;
    }
    if (SymbolFlags.Has(oldSymbol.Flags, SymbolFlags.MustStartWithCapitalLetterForJSX)) {
      this.Flags |= SymbolFlags.MustStartWithCapitalLetterForJSX;
    }
  }

  /** Go: func (s *Symbol) SlotNamespace() SlotNamespace */
  SlotNamespace(): SlotNamespace {
    if (this.Kind === SymbolKind.SymbolUnbound || SymbolFlags.Has(this.Flags, SymbolFlags.MustNotBeRenamed)) {
      return SlotNamespace.SlotMustNotBeRenamed;
    }
    if (IsPrivate(this.Kind)) return SlotNamespace.SlotPrivateName;
    if (this.Kind === SymbolKind.SymbolLabel) return SlotNamespace.SlotLabel;
    if (this.Kind === SymbolKind.SymbolMangledProp) return SlotNamespace.SlotMangledProp;
    return SlotNamespace.SlotDefault;
  }
}

/** Go: type SymbolMap struct { SymbolsForSource [][]Symbol } */
export class SymbolMap {
  SymbolsForSource: (Symbol[] | undefined)[];

  constructor(SymbolsForSource: (Symbol[] | undefined)[] = []) {
    this.SymbolsForSource = SymbolsForSource;
  }
}

/** Go: func NewSymbolMap(sourceCount int) SymbolMap { return SymbolMap{make([][]Symbol, sourceCount)} } */
export function NewSymbolMap(sourceCount: number): SymbolMap {
  // Go 的内层切片是 nil（len 0）；TS 用稀疏数组表示，Get 越界时会抛错（对应 Go 的 panic）
  return new SymbolMap(new Array(sourceCount));
}

/**
 * Go: func (sm SymbolMap) Get(ref Ref) *Symbol
 *
 * Go 越界是 panic: index out of range；TS 抛错。
 */
export function Get(sm: SymbolMap, ref: Ref): Symbol {
  const inner = sm.SymbolsForSource[ref.SourceIndex];
  if (inner === undefined) throw new Error("runtime error: index out of range");
  const symbol = inner[ref.InnerIndex];
  if (symbol === undefined) throw new Error("runtime error: index out of range");
  return symbol;
}

/** Go: func FollowSymbols(symbols SymbolMap, ref Ref) Ref */
export function FollowSymbols(symbols: SymbolMap, ref: Ref): Ref {
  const symbol = Get(symbols, ref);
  if (symbol.Link.Equals(InvalidRef)) return ref;

  const link = FollowSymbols(symbols, symbol.Link);

  // Only write if needed to avoid concurrent map update hazards
  if (!symbol.Link.Equals(link)) symbol.Link = link;

  return link;
}

/** Go: func FollowAllSymbols(symbols SymbolMap) */
export function FollowAllSymbols(symbols: SymbolMap): void {
  for (let sourceIndex = 0; sourceIndex < symbols.SymbolsForSource.length; sourceIndex++) {
    const inner = symbols.SymbolsForSource[sourceIndex];
    if (inner === undefined) continue;
    for (let symbolIndex = 0; symbolIndex < inner.length; symbolIndex++) {
      FollowSymbols(symbols, new Ref(sourceIndex, symbolIndex));
    }
  }
}

/** Go: func MergeSymbols(symbols SymbolMap, old Ref, new Ref) Ref */
export function MergeSymbols(symbols: SymbolMap, old: Ref, new_: Ref): Ref {
  if (old.Equals(new_)) return new_;

  const oldSymbol = Get(symbols, old);
  if (!oldSymbol.Link.Equals(InvalidRef)) {
    oldSymbol.Link = MergeSymbols(symbols, oldSymbol.Link, new_);
    return oldSymbol.Link;
  }

  const newSymbol = Get(symbols, new_);
  if (!newSymbol.Link.Equals(InvalidRef)) {
    newSymbol.Link = MergeSymbols(symbols, old, newSymbol.Link);
    return newSymbol.Link;
  }

  oldSymbol.Link = new_;
  newSymbol.MergeContentsWith(oldSymbol);
  return new_;
}

/** Go: type AssertOrWithEntry struct { Key []uint16; Value []uint16; KeyLoc/ValueLoc logger.Loc; PreferQuotedKey bool } */
export interface AssertOrWithEntry {
  /** An identifier or a string */
  Key: number[];
  /** Always a string */
  Value: number[];
  KeyLoc: Loc;
  ValueLoc: Loc;
  PreferQuotedKey: boolean;
}

/**
 * Go: func FindAssertOrWithEntry(assertions []AssertOrWithEntry, name string) *AssertOrWithEntry
 *
 * 注意 Go 的写法是 `for _, assertion := range assertions { return &assertion }`，
 * 返回的是 **range 副本的地址**，改它不会回写切片元素。这里同样返回浅拷贝，保留该语义。
 */
export function FindAssertOrWithEntry(assertions: AssertOrWithEntry[], name: string): AssertOrWithEntry | null {
  const nameBytes = new TextEncoder().encode(name);
  for (const assertion of assertions) {
    if (UTF16EqualsString(assertion.Key, nameBytes)) {
      return { ...assertion };
    }
  }
  return null;
}
