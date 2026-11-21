// 1:1 移植自 esbuild internal/compat/js_table.go（v0.28.2，commit f6058f83）
//
// 本轮只落 `js_ast_helpers` 的硬依赖子集：JSFeature 位掩码 + Has。
// 三个常量由 Go 探针实测（/root/esbuild/tmpcompat）：
//   NullishCoalescing         = 4398046511104   = 1<<42
//   OptionalChain             = 140737488355328 = 1<<47
//   TypeofExoticObjectIsObject= 288230376151711744 = 1<<58
//
// Go 的 JSFeature 是 uint64，TS 的 number 位运算只有 32 位，超过 31 的位会溢出，
// 所以这里用 bigint 承载（与 uint64 一一对应）。M3 补全 compat 包时沿用该表示。
//
// DEVIATION：Go 的 `features.Has(feature)` 是方法，TS 侧改为函数 `Has(features, feature)`
// （bigint 不能挂方法；调用点写作 `Has(unsupportedFeatures, JSFeature.OptionalChain)`）。

/** Go: type JSFeature uint64 (js_table.go:60) */
export type JSFeature = bigint;

export const JSFeature = {
  /** Go: NullishCoalescing (js_table.go:105) —— 第 42 位 */
  NullishCoalescing: 1n << 42n,
  /** Go: OptionalChain (js_table.go:110) —— 第 47 位 */
  OptionalChain: 1n << 47n,
  /** Go: ImportMeta (js_table.go:97) —— 第 34 位（Go 实测 17179869184） */
  ImportMeta: 1n << 34n,
  /** Go: TypeofExoticObjectIsObject (js_table.go:121) —— 第 58 位 */
  TypeofExoticObjectIsObject: 1n << 58n,
  /** Go: TemplateLiteral (js_table.go:119) —— 第 56 位（Go 探针实测 72057594037927936 = 2^56） */
  TemplateLiteral: 1n << 56n,
  /** Go: UnicodeEscapes (js_table.go:122) —— 第 59 位（Go 探针实测 576460752303423488 = 2^59） */
  UnicodeEscapes: 1n << 59n,
  /** Go: Using (js_table.go:123) —— 第 60 位（js_table.go iota 顺序实测：Using 紧随 UnicodeEscapes）。第 109 批 lower-using 端口。 */
  Using: 1n << 60n,
  /** Go: DynamicImport (js_table.go:88) —— 第 21 位（Go 探针实测 2097152 = 2^21）。第 111 批 import-record 底座。 */
  DynamicImport: 1n << 21n,
  /** Go: ObjectExtensions (js_table.go:107) —— 第 44 位（Go 探针 tmpcompatx 实测 17592186044416 = 2^44） */
  ObjectExtensions: 1n << 44n,
  /** Go: ConstAndLet (js_table.go:88) —— 第 17 位（Go 探针 tmpcompaty 实测 131072 = 2^17） */
  ConstAndLet: 1n << 17n,
  /** Go: ExportStarAs (js_table.go:86) —— 第 23 位（Go 探针实测 8388608 = 2^23） */
  ExportStarAs: 1n << 23n,
  /** Go: ImportAssertions (js_table.go:94) —— 第 31 位（Go 探针实测 2147483648 = 2^31） */
  ImportAssertions: 1n << 31n,
  /** Go: ImportAttributes (js_table.go:95) —— 第 32 位（Go 探针实测 4294967296 = 2^32） */
  ImportAttributes: 1n << 32n,
  /** Go: Class (js_table.go:72) —— 第 6 位（Go 探针实测 64 = 2^6） */
  Class: 1n << 6n,
  /** Go: ClassField (js_table.go:76) —— 第 7 位（Go 探针实测 128 = 2^7） */
  ClassField: 1n << 7n,
  /** Go: ClassPrivateField (js_table.go:78) —— 第 10 位（Go 探针实测 1024 = 2^10） */
  ClassPrivateField: 1n << 10n,
  /** Go: ClassPrivateAccessor (js_table.go:71) —— 第 8 位（Go 探针 tmpprobebits 实测 256 = 2^8） */
  ClassPrivateAccessor: 1n << 8n,
  /** Go: ClassPrivateMethod (js_table.go:74) —— 第 11 位（Go 探针 tmpprobebits 实测 2048 = 2^11） */
  ClassPrivateMethod: 1n << 11n,
  /** Go: ClassPrivateStaticAccessor (js_table.go:75) —— 第 12 位（Go 探针 tmpprobebits 实测 4096 = 2^12） */
  ClassPrivateStaticAccessor: 1n << 12n,
  /** Go: ClassPrivateStaticMethod (js_table.go:77) —— 第 14 位（Go 探针 tmpprobebits 实测 16384 = 2^14） */
  ClassPrivateStaticMethod: 1n << 14n,
  /** Go: ClassStaticField (js_table.go:92) —— 第 16 位（Go 探针实测 65536 = 2^16） */
  ClassStaticField: 1n << 16n,
  /** Go: ClassPrivateStaticField (js_table.go:84) —— 第 13 位（Go 探针实测 8192 = 2^13） */
  ClassPrivateStaticField: 1n << 13n,
  /** Go: ClassStaticBlocks (js_table.go:90) —— 第 15 位（Go 探针实测 32768 = 2^15） */
  ClassStaticBlocks: 1n << 15n,
  /** Go: RegexpLookbehindAssertions —— 第 49 位（Go 探针实测 562949953421312） */
  RegexpLookbehindAssertions: 1n << 49n,
  /** Go: RegexpNamedCaptureGroups —— 第 51 位（Go 探针实测 2251799813685248） */
  RegexpNamedCaptureGroups: 1n << 51n,
  /** Go: RegexpUnicodePropertyEscapes —— 第 54 位（Go 探针实测 18014398509481984） */
  RegexpUnicodePropertyEscapes: 1n << 54n,
  /** Go: RegexpDotAllFlag —— 第 48 位（Go 探针实测 281474976710656） */
  RegexpDotAllFlag: 1n << 48n,
  /** Go: RegexpStickyAndUnicodeFlags —— 第 53 位（Go 探针实测 9007199254740992） */
  RegexpStickyAndUnicodeFlags: 1n << 53n,
  /** Go: RegexpMatchIndices —— 第 50 位（Go 探针实测 1125899906842624） */
  RegexpMatchIndices: 1n << 50n,
  /** Go: RegexpSetNotation —— 第 52 位（Go 探针实测 4503599627370496） */
  RegexpSetNotation: 1n << 52n,
  /** Go: Bigint (js_table.go:68) —— 第 5 位（Go 探针 tmpfeat 实测 32 = 2^5） */
  Bigint: 1n << 5n,
  /** 以下位由 Go 探针 tmpgenbits 实测（v0.28.2 js_table.go iota 顺序） */
  AsyncAwait: 1n << 3n,
  AsyncGenerator: 1n << 4n,
  ArraySpread: 1n << 1n,
  /** Go: Arrow (js_table.go:62) —— 第 2 位（Go 探针 tmpgenbits 实测） */
  Arrow: 1n << 2n,
  DefaultArgument: 1n << 19n,
  Destructuring: 1n << 20n,
  ExponentOperator: 1n << 22n,
  ForOf: 1n << 25n,
  ForAwait: 1n << 24n,
  Generator: 1n << 29n,
  LogicalAssignment: 1n << 37n,
  NestedRestBinding: 1n << 38n,
  NewTarget: 1n << 39n,
  ObjectAccessors: 1n << 43n,
  ObjectRestSpread: 1n << 45n,
  RestArgument: 1n << 55n,
  TopLevelAwait: 1n << 57n,
  ImportDefer: 1n << 33n,
  ImportSource: 1n << 35n,
  /** Go: InlineScript (js_table.go:100) —— 第 36 位（Go 探针实测 68719476736 = 2^36） */
  InlineScript: 1n << 36n,
  /** Go: ClassPrivateBrandCheck (js_table.go:76) —— 第 9 位（Go 探针实测 512 = 2^9） */
  ClassPrivateBrandCheck: 1n << 9n,
};

/** Go: func (features JSFeature) Has(feature JSFeature) bool (js_table.go:190) */
export function Has(features: JSFeature, feature: JSFeature): boolean {
  return (features & feature) !== 0n;
}

// --- 第 44 轮叶子优先：版本/引擎字符串 + 覆盖（js_table.go / compat.go）---

/** Go: Engine 枚举 (js_table.go) —— Go 探针实测 */
export const Engine = {
  Chrome: 0, Deno: 1, Edge: 2, ES: 3, Firefox: 4, Hermes: 5, IE: 6, IOS: 7, Node: 8, Opera: 9, Safari: 11,
} as const;

/** Go: func (e Engine) String() string (js_table.go:22) */
export function EngineString(e: number): string {
  const names: Record<number, string> = { 0: "chrome", 1: "deno", 2: "edge", 3: "es", 4: "firefox", 5: "hermes", 6: "ie", 7: "ios", 8: "node", 9: "opera", 11: "safari" };
  return names[e] ?? "";
}

/** Go: func (features JSFeature) ApplyOverrides(overrides JSFeature, mask JSFeature) JSFeature (js_table.go:194) */
export function ApplyOverrides(features: JSFeature, overrides: JSFeature, mask: JSFeature): JSFeature {
  return (features & ~mask) | (overrides & mask);
}

/** Go: func (v Semver) String() string (compat.go:22) */
export function SemverString(v: Semver): string {
  return v.Parts.join(".") + v.PreRelease;
}

// --- 第 44 轮叶子优先：语义化版本比较（compat.go）---

/** Go: type Semver struct (compat.go:16) */
export class Semver {
  Parts: number[] = [];
  PreRelease: string = "";

  /** Go: func (v Semver) String() string (compat.go:22) */
  String(): string {
    return this.Parts.join(".") + this.PreRelease;
  }
}

/** Go: type v struct (compat.go:10) */
export class V {
  major: number = 0;
  minor: number = 0;
  patch: number = 0;
}

/** Go: func compareVersions(a v, b Semver) int (compat.go:37) */
export function compareVersions(a: V, b: Semver): number {
  let diff = a.major;
  if (b.Parts.length > 0) diff -= b.Parts[0];
  if (diff === 0) {
    diff = a.minor;
    if (b.Parts.length > 1) diff -= b.Parts[1];
  }
  if (diff === 0) {
    diff = a.patch;
    if (b.Parts.length > 2) diff -= b.Parts[2];
  }
  if (diff === 0 && b.PreRelease.length !== 0) return 1;
  return diff;
}

/** Go: type versionRange struct (compat.go) */
export class versionRange {
  start: V = new V();
  end: V = new V();
}

/** Go: func isVersionSupported(ranges []versionRange, version Semver) bool (compat.go:152) */
export function isVersionSupported(ranges: versionRange[], version: Semver): boolean {
  for (const r of ranges) {
    if (compareVersions(r.start, version) <= 0 &&
        (r.end.major === 0 && r.end.minor === 0 && r.end.patch === 0 || compareVersions(r.end, version) > 0)) {
      return true;
    }
  }
  return false;
}

/** Go: func splitOffNextPreReleasePart(text string) (head string, tail string) (compat.go:129) */
export function splitOffNextPreReleasePart(text: string): [string, string] {
  const i = text.indexOf(".");
  if (i !== -1) return [text.slice(0, i), text.slice(i + 1)];
  return [text, ""];
}

/** Go: func preReleasePartToNumber(text string) (int, bool) (compat.go:136) */
export function preReleasePartToNumber(text: string): { value: number; ok: boolean } {
  if (text === "") return { value: 0, ok: false };
  for (const c of text) if (c < "0" || c > "9") return { value: 0, ok: false };
  return { value: parseInt(text, 10), ok: true };
}

/** Go: func SymbolFeature(kind ast.SymbolKind) JSFeature (compat.go:161) */
export function SymbolFeature(kind: number): bigint {
  switch (kind) {
    case 8: return 1024n;   // SymbolPrivateField → ClassPrivateField
    case 9: return 2048n;   // SymbolPrivateMethod → ClassPrivateMethod
    case 10: case 11: case 12: return 256n; // PrivateGet/Set/GetSetPair → ClassPrivateAccessor
    case 13: return 8192n;  // SymbolPrivateStaticField
    case 14: return 16384n; // SymbolPrivateStaticMethod
    case 15: case 16: case 17: return 4096n; // PrivateStaticGet/Set/GetSetPair
    default: return 0n;
  }
}

/** Go: func CompareSemver(a Semver, b Semver) int (compat.go:60) */
export function CompareSemver(a: Semver, b: Semver): number {
  const an = a.Parts.length, bn = b.Parts.length;
  const n = Math.max(an, bn);
  for (let i = 0; i < n; i++) {
    const ai = i < an ? a.Parts[i] : 0, bi = i < bn ? b.Parts[i] : 0;
    if (ai !== bi) return ai - bi;
  }
  if ((a.PreRelease !== "") !== (b.PreRelease !== "")) return b.PreRelease.length - a.PreRelease.length;
  let aTail = a.PreRelease.startsWith("-") ? a.PreRelease.slice(1) : a.PreRelease;
  let bTail = b.PreRelease.startsWith("-") ? b.PreRelease.slice(1) : b.PreRelease;
  while (aTail !== "" && bTail !== "") {
    const [aHead, aRest] = splitOffNextPreReleasePart(aTail);
    const [bHead, bRest] = splitOffNextPreReleasePart(bTail);
    aTail = aRest; bTail = bRest;
    if (aHead === bHead) continue;
    const anum = preReleasePartToNumber(aHead), bnum = preReleasePartToNumber(bHead);
    if (!anum.ok && !bnum.ok) return aHead < bHead ? -1 : 1;
    else if (anum.ok && bnum.ok) {
      if (anum.value !== bnum.value) return anum.value - bnum.value;
      return aHead.length - bHead.length;
    } else return anum.ok ? -1 : 1;
  }
  return aTail.length - bTail.length;
}
