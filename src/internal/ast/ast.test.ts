// 对应 esbuild internal/ast/ast.go 的单元测试。
// 期望值全部取自 ast.go 的字面量（含行号标注），不做「跑一遍看输出再回填期望值」的自证。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AssertOrWithKeyword,
  CharFreq,
  DefaultNameMinifierCSS,
  DefaultNameMinifierJS,
  FindAssertOrWithEntry,
  FollowAllSymbols,
  FollowSymbols,
  Get,
  Has,
  ImportItemStatus,
  ImportKind,
  ImportRecordFlags,
  Index32,
  InvalidRef,
  IsFromCSS,
  IsFunction,
  IsHoisted,
  IsHoistedOrFunction,
  IsPrivate,
  IsUnboundOrInjected,
  MakeIndex32,
  MergeSymbols,
  MustResolveToCSS,
  NameMinifier,
  NewSymbolMap,
  Ref,
  SlotCounts,
  SlotNamespace,
  String,
  StringForMetafile,
  Symbol,
  SymbolFlags,
  SymbolKind,
  SymbolMap,
} from "./ast.ts";
import { Loc } from "../logger/logger.ts";

test("StringForMetafile: 8 个 ImportKind 逐一对应 ast.go:44-64 的 return 字面量", () => {
  const expected: Record<number, string> = {
    [ImportKind.ImportEntryPoint]: "entry-point",
    [ImportKind.ImportStmt]: "import-statement",
    [ImportKind.ImportRequire]: "require-call",
    [ImportKind.ImportDynamic]: "dynamic-import",
    [ImportKind.ImportRequireResolve]: "require-resolve",
    [ImportKind.ImportAt]: "import-rule",
    [ImportKind.ImportComposesFrom]: "composes-from",
    [ImportKind.ImportURL]: "url-token",
  };
  // 枚举值本身也必须与 Go 的 iota 顺序一致（ast.go:17-40）
  assert.deepEqual(Object.keys(expected).map(Number).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
  for (const [kind, want] of Object.entries(expected)) {
    assert.equal(StringForMetafile(Number(kind)), want, `kind=${kind}`);
  }
});

test("StringForMetafile: 越界值 panic（Go: panic(\"Internal error\")）", () => {
  for (const bad of [8, 255, -1]) {
    assert.throws(() => StringForMetafile(bad), /Internal error/);
  }
});

test("IsFromCSS: 仅 ImportAt/ImportComposesFrom/ImportURL 为 true（ast.go:66-72）", () => {
  const want = new Map<number, boolean>([
    [ImportKind.ImportEntryPoint, false],
    [ImportKind.ImportStmt, false],
    [ImportKind.ImportRequire, false],
    [ImportKind.ImportDynamic, false],
    [ImportKind.ImportRequireResolve, false],
    [ImportKind.ImportAt, true],
    [ImportKind.ImportComposesFrom, true],
    [ImportKind.ImportURL, true],
  ]);
  for (const [kind, expected] of want) assert.equal(IsFromCSS(kind), expected, `kind=${kind}`);
});

test("MustResolveToCSS: 仅 ImportAt/ImportComposesFrom 为 true（ast.go:74-80）", () => {
  const want = new Map<number, boolean>([
    [ImportKind.ImportEntryPoint, false],
    [ImportKind.ImportStmt, false],
    [ImportKind.ImportRequire, false],
    [ImportKind.ImportDynamic, false],
    [ImportKind.ImportRequireResolve, false],
    [ImportKind.ImportAt, true],
    [ImportKind.ImportComposesFrom, true],
    [ImportKind.ImportURL, false],
  ]);
  for (const [kind, expected] of want) assert.equal(MustResolveToCSS(kind), expected, `kind=${kind}`);
});

test("ImportRecordFlags: 15 个标志位各占一位、互不重叠（ast.go:82-158）", () => {
  const all = Object.values(ImportRecordFlags);
  assert.equal(all.length, 15);
  let seen = 0;
  for (const flag of all) {
    assert.equal(flag & (flag - 1), 0, `${flag} 不是单个二进制位`);
    assert.equal(seen & flag, 0, `${flag} 与已出现的标志位重叠`);
    seen |= flag;
  }
  // 末位是 ContainsUniqueKey = 1<<14，整型上界仍落在 uint16 内
  assert.equal(ImportRecordFlags.ContainsUniqueKey, 1 << 14);
  assert.equal(seen, (1 << 15) - 1);
});

test("Has: (flags & flag) != 0（ast.go:160-162）", () => {
  const f = ImportRecordFlags;
  assert.equal(Has(0, f.IsUnused), false);
  assert.equal(Has(f.IsUnused, f.IsUnused), true);
  assert.equal(Has(f.IsUnused, f.ContainsImportStar), false);
  const combo = f.IsUnused | f.WrapWithToESM | f.ContainsUniqueKey;
  assert.equal(Has(combo, f.IsUnused), true);
  assert.equal(Has(combo, f.WrapWithToESM), true);
  assert.equal(Has(combo, f.ContainsUniqueKey), true);
  assert.equal(Has(combo, f.WrapWithToCJS), false);
  assert.equal(Has(combo, f.HandlesImportErrors), false);
  // 与 Go 一致：Has(0, 0) 为 false，因为 (0 & 0) == 0
  assert.equal(Has(0, 0), false);
});

test("AssertOrWithKeyword.String: assert/with，其余值一律 with（ast.go:194-199）", () => {
  assert.equal(String(AssertOrWithKeyword.AssertKeyword), "assert");
  assert.equal(String(AssertOrWithKeyword.WithKeyword), "with");
  // Go 的实现是 `if kw == AssertKeyword { "assert" } return "with"`，没有 else-if
  assert.equal(String(2), "with");
});

test("Index32: 零值无效，MakeIndex32 取反存储（ast.go:230-251）", () => {
  const invalid = new Index32();
  assert.equal(invalid.IsValid(), false);
  assert.equal(MakeIndex32(0).IsValid(), true);
  assert.equal(MakeIndex32(0).GetIndex(), 0);
  assert.equal(MakeIndex32(1).IsValid(), true);
  assert.equal(MakeIndex32(1).GetIndex(), 1);
  assert.equal(MakeIndex32(1).flippedBits, 0xfffffffe);
});

test("Index32: uint32 边界与随机回环（^ + >>> 0 复现 Go 的 uint32 环绕）", () => {
  // 0xffffffff 取反是 0，正是 Go 里「零值无效」的设计所依赖的位模式
  const max = MakeIndex32(0xffffffff);
  assert.equal(max.flippedBits, 0);
  assert.equal(max.IsValid(), false);
  assert.equal(max.GetIndex(), 0xffffffff);

  for (const i of [0, 1, 2, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff]) {
    assert.equal(MakeIndex32(i).GetIndex(), i, `i=${i}`);
  }

  // 伪随机但确定性的样本，避免测试不可复现
  let seed = 0x12345678;
  for (let n = 0; n < 1000; n++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const idx = MakeIndex32(seed);
    assert.equal(idx.GetIndex(), seed, `seed=${seed}`);
    assert.equal(idx.IsValid(), seed !== 0xffffffff, `seed=${seed}`);
  }
});

// ---------------------------------------------------------------------------
// 以下期望值全部由 Go 参考实现现场跑出（临时程序 `go run ./tmpastcheck2`，
// 直接调用 /root/esbuild/internal/ast 的导出函数），不是从 TS 输出回填的。
// ---------------------------------------------------------------------------

/** Go 输出：k,<kind>,IsPrivate,IsHoisted,IsHoistedOrFunction,IsFunction,IsUnboundOrInjected */
const GO_SYMBOL_KIND_TABLE = "" +
  "0,false,false,false,false,true;1,false,true,true,false,false;2,false,true,true,true,false;" +
  "3,false,false,false,false,false;4,false,false,true,true,false;5,false,false,false,false,false;" +
  "6,false,false,false,false,false;7,false,false,false,false,false;8,true,false,false,false,false;" +
  "9,true,false,false,false,false;10,true,false,false,false,false;11,true,false,false,false,false;" +
  "12,true,false,false,false,false;13,true,false,false,false,false;14,true,false,false,false,false;" +
  "15,true,false,false,false,false;16,true,false,false,false,false;17,true,false,false,false,false;" +
  "18,false,false,false,false,false;19,false,false,false,false,false;20,false,false,false,false,false;" +
  "21,false,false,false,false,false;22,false,false,false,false,false;23,false,false,false,false,true;" +
  "24,false,false,false,false,false;25,false,false,false,false,false;26,false,false,false,false,false;" +
  "27,false,false,false,false,false;28,false,false,false,false,false;29,false,false,false,false,false";

test("SymbolKind: 28 个取值与 5 个谓词逐项对齐 Go（ast.go:253-372）", () => {
  // 枚举本体：28 个具名值，0..27，无重复
  const named = Object.values(SymbolKind);
  assert.equal(named.length, 28);
  assert.deepEqual([...named].sort((a, b) => a - b), Array.from({ length: 28 }, (_, i) => i));
  assert.equal(SymbolKind.SymbolOther, 27); // Go 实测 SymbolOther = 27

  for (const row of GO_SYMBOL_KIND_TABLE.split(";")) {
    const [k, isPrivate, isHoisted, isHoistedOrFunction, isFunction, isUnboundOrInjected] = row.split(",");
    const kind = Number(k);
    assert.equal(IsPrivate(kind), isPrivate === "true", `IsPrivate(${kind})`);
    assert.equal(IsHoisted(kind), isHoisted === "true", `IsHoisted(${kind})`);
    assert.equal(IsHoistedOrFunction(kind), isHoistedOrFunction === "true", `IsHoistedOrFunction(${kind})`);
    assert.equal(IsFunction(kind), isFunction === "true", `IsFunction(${kind})`);
    assert.equal(IsUnboundOrInjected(kind), isUnboundOrInjected === "true", `IsUnboundOrInjected(${kind})`);
  }
});

test("SymbolFlags: 11 个标志位取值与 Go 一致，Has 与 (flags & flag) != 0 等价（ast.go:410-515）", () => {
  const expected = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];
  const actual = [
    SymbolFlags.MustNotBeRenamed, SymbolFlags.MustStartWithCapitalLetterForJSX, SymbolFlags.DidKeepName,
    SymbolFlags.PrivateSymbolMustBeLowered, SymbolFlags.RemoveOverwrittenFunctionDeclaration,
    SymbolFlags.DidWarnAboutCommonJSInESM, SymbolFlags.CouldPotentiallyBeMutated, SymbolFlags.WasExported,
    SymbolFlags.IsEmptyFunction, SymbolFlags.IsIdentityFunction, SymbolFlags.CallCanBeUnwrappedIfUnused,
  ];
  assert.deepEqual(actual, expected);
  assert.equal(SymbolFlags.Has(0, SymbolFlags.MustNotBeRenamed), false); // Go: has0=false
  assert.equal(SymbolFlags.Has(3, SymbolFlags.MustStartWithCapitalLetterForJSX), true); // Go: has1=true
  assert.equal(SymbolFlags.Has(3, SymbolFlags.DidKeepName), false);
});

test("SlotCounts.UnionMax: 逐槽取最大值（ast.go:632-641）", () => {
  const a = new SlotCounts([1, 5, 3, 0]);
  a.UnionMax(new SlotCounts([2, 4, 3, 7]));
  assert.deepEqual(a.values, [2, 5, 3, 7]); // Go 实测 [2 5 3 7]
  // 自身不变时也不清零
  a.UnionMax(new SlotCounts([0, 0, 0, 0]));
  assert.deepEqual(a.values, [2, 5, 3, 7]);
});

test("CharFreq.Scan/Include: 64 槽直方图逐槽对齐 Go（ast.go:725-746）", () => {
  const freq = new CharFreq();
  freq.Scan("Hello, World! aZ09_$ ~", 1);
  freq.Scan("abc", 2);
  freq.Scan("ignored", 0); // delta == 0 直接返回
  const want1 = [3, 2, 2, 1, 1, 0, 0, 0, 0, 0, 0, 3, 0, 0, 2, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1];
  assert.deepEqual(Array.from(freq.values), want1);

  const other = new CharFreq();
  other.Scan("zz9", 3);
  freq.Include(other);
  // Go 实测 freq2 全量（不靠手算 delta：'9' 的槽位是 52+'9'-'0'=61，不是 52）
  const want2 = [3, 2, 2, 1, 1, 0, 0, 0, 0, 0, 0, 3, 0, 0, 2, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 4, 1, 1];
  assert.deepEqual(Array.from(freq.values), want2);
});

const NAMES_JS_60 =
  "a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t,u,v,w,x,y,z,A,B,C,D,E,F,G,H,I,J,K,L,M,N,O,P,Q,R,S,T,U,V,W,X,Y,Z,_,$,aa,ba,ca,da,ea,fa";
const SHUFFLE_JS_60 =
  "z,a,l,b,c,o,d,e,r,H,W,Z,_,$,f,g,h,i,j,k,m,n,p,q,s,t,u,v,w,x,y,A,B,C,D,E,F,G,I,J,K,L,M,N,O,P,Q,R,S,T,U,V,X,Y,zz,az,lz,bz,cz,oz";
const SHUFFLE_CSS_60 =
  "z,a,l,b,c,o,d,e,r,H,W,Z,_,f,g,h,i,j,k,m,n,p,q,s,t,u,v,w,x,y,A,B,C,D,E,F,G,I,J,K,L,M,N,O,P,Q,R,S,T,U,V,X,Y,zz,az,lz,bz,cz,oz,dz";
const SHUFFLE_CSS_ZERO_60 =
  "a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t,u,v,w,x,y,z,A,B,C,D,E,F,G,H,I,J,K,L,M,N,O,P,Q,R,S,T,U,V,W,X,Y,Z,_,aa,ba,ca,da,ea,fa,ga";

function namesOf(minifier: NameMinifier, count: number): string {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(minifier.NumberToMinifiedName(i));
  return out.join(",");
}

test("NumberToMinifiedName: 前 60 个名字与 Go 逐字一致（ast.go:810-827）", () => {
  assert.equal(namesOf(DefaultNameMinifierJS, 60), NAMES_JS_60);
});

test("ShuffleByCharFreq: 打乱后的 head/tail 序列与 Go 逐字一致（ast.go:787-808）", () => {
  const freq = new CharFreq();
  freq.Scan("Hello, World! aZ09_$ ~", 1);
  freq.Scan("abc", 2);
  const other = new CharFreq();
  other.Scan("zz9", 3);
  freq.Include(other);

  assert.equal(namesOf(DefaultNameMinifierJS.ShuffleByCharFreq(freq), 60), SHUFFLE_JS_60);
  assert.equal(namesOf(DefaultNameMinifierCSS.ShuffleByCharFreq(freq), 60), SHUFFLE_CSS_60);
  // freq 全零时，CSS 的 tail 只有 63 个字符，数组第 64 项是 Go 的零值 struct（char="", index=0）
  assert.equal(namesOf(DefaultNameMinifierCSS.ShuffleByCharFreq(new CharFreq()), 60), SHUFFLE_CSS_ZERO_60);
});

// ---------------------------------------------------------------------------
// Ref / Symbol / SymbolMap / AssertOrWithEntry
// 期望值同样由 Go 参考实现现场跑出（`go run ./tmpastcheck3`）
// ---------------------------------------------------------------------------

test("ImportItemStatus: 3 个值 0/1/2（ast.go:395-406）", () => {
  assert.equal(ImportItemStatus.ImportItemNone, 0);
  assert.equal(ImportItemStatus.ImportItemGenerated, 1);
  assert.equal(ImportItemStatus.ImportItemMissing, 2);
});

test("Ref: uint32 环绕与 InvalidRef 形状（ast.go:371-373、ast.go:373 附近）", () => {
  const r = new Ref(1, 2);
  assert.equal(r.SourceIndex, 1);
  assert.equal(r.InnerIndex, 2);
  assert.equal(r.Equals(new Ref(1, 2)), true);
  assert.equal(r.Equals(new Ref(2, 1)), false);
  assert.equal(InvalidRef.SourceIndex, 0xffffffff);
  assert.equal(InvalidRef.InnerIndex, 0xffffffff);
  assert.equal(new Ref(-1, -1).Equals(InvalidRef), true);
});

test("Symbol.SlotNamespace: 8 组 (Kind, Flags) 逐一对齐 Go（ast.go:614-629）", () => {
  // Go 输出：slot,<kind>,<flags>,<namespace>
  const rows = [
    [SymbolKind.SymbolUnbound, 0, SlotNamespace.SlotMustNotBeRenamed],
    [SymbolKind.SymbolOther, SymbolFlags.MustNotBeRenamed, SlotNamespace.SlotMustNotBeRenamed],
    [SymbolKind.SymbolPrivateField, 0, SlotNamespace.SlotPrivateName],
    [SymbolKind.SymbolPrivateStaticGetSetPair, 0, SlotNamespace.SlotPrivateName],
    [SymbolKind.SymbolLabel, 0, SlotNamespace.SlotLabel],
    [SymbolKind.SymbolMangledProp, 0, SlotNamespace.SlotMangledProp],
    [SymbolKind.SymbolOther, 0, SlotNamespace.SlotDefault],
    [SymbolKind.SymbolPrivateGet, SymbolFlags.MustNotBeRenamed, SlotNamespace.SlotMustNotBeRenamed],
  ] as const;
  for (const [kind, flags, want] of rows) {
    const s = new Symbol();
    s.Kind = kind;
    s.Flags = flags;
    assert.equal(s.SlotNamespace(), want, `Kind=${kind} Flags=${flags}`);
  }
});

test("Symbol.MergeContentsWith: 使用计数相加 + 两个标志位的搬运规则（ast.go:593-604）", () => {
  // merge1: new(3) + old(5, MustNotBeRenamed, "oldname") -> 8/"oldname"/1
  const n1 = new Symbol();
  n1.UseCountEstimate = 3;
  const o1 = new Symbol();
  o1.UseCountEstimate = 5;
  o1.Flags = SymbolFlags.MustNotBeRenamed;
  o1.OriginalName = "oldname";
  n1.MergeContentsWith(o1);
  assert.deepEqual([n1.UseCountEstimate, n1.OriginalName, n1.Flags], [8, "oldname", SymbolFlags.MustNotBeRenamed]);

  // merge2: new 已有 MustNotBeRenamed -> 名字不被覆盖，但 JSX 标志位仍合并 -> 1/"keep"/3
  const n2 = new Symbol();
  n2.UseCountEstimate = 1;
  n2.OriginalName = "keep";
  n2.Flags = SymbolFlags.MustNotBeRenamed;
  const o2 = new Symbol();
  o2.Flags = SymbolFlags.MustStartWithCapitalLetterForJSX | SymbolFlags.MustNotBeRenamed;
  o2.OriginalName = "Old";
  n2.MergeContentsWith(o2);
  assert.deepEqual([n2.UseCountEstimate, n2.OriginalName, n2.Flags], [1, "keep", 3]);

  // merge3: 只有 JSX 标志位时没有名字搬运 -> ""/2
  const n3 = new Symbol();
  n3.Flags = SymbolFlags.MustStartWithCapitalLetterForJSX;
  const o3 = new Symbol();
  o3.Flags = SymbolFlags.MustStartWithCapitalLetterForJSX;
  o3.OriginalName = "X";
  n3.MergeContentsWith(o3);
  assert.deepEqual([n3.OriginalName, n3.Flags], ["", SymbolFlags.MustStartWithCapitalLetterForJSX]);
});

test("SymbolMap/Get/FollowSymbols/MergeSymbols: 链表合并与路径压缩（ast.go:658-720）", () => {
  const symbols = NewSymbolMap(2);
  const s00 = new Symbol();
  s00.Link = InvalidRef;
  s00.UseCountEstimate = 10;
  const s01 = new Symbol();
  s01.Link = InvalidRef;
  s01.UseCountEstimate = 1;
  const s10 = new Symbol();
  s10.Link = InvalidRef;
  s10.UseCountEstimate = 100;
  symbols.SymbolsForSource[0] = [s00, s01];
  symbols.SymbolsForSource[1] = [s10];

  const r00 = new Ref(0, 0), r01 = new Ref(0, 1), r10 = new Ref(1, 0);
  assert.equal(Get(symbols, r00).Link.Equals(InvalidRef), true);

  const m1 = MergeSymbols(symbols, r00, r01);
  assert.equal(m1.Equals(r01), true); // Go: merge00_01,0,1
  assert.equal(Get(symbols, r00).Link.Equals(InvalidRef), false); // link00_valid=true
  assert.equal(Get(symbols, r01).UseCountEstimate, 11); // count01=11

  const m2 = MergeSymbols(symbols, r00, r10);
  assert.equal(m2.Equals(r10), true); // Go: merge00_10,1,0
  assert.equal(Get(symbols, r10).UseCountEstimate, 111); // count10=111
  assert.equal(Get(symbols, r01).UseCountEstimate, 11); // count01=11

  assert.equal(FollowSymbols(symbols, r00).Equals(r10), true); // Go: follow00,1,0
  FollowAllSymbols(symbols);
  assert.equal(Get(symbols, r00).Link.Equals(r10), true); // Go: followall,true,true
  assert.equal(Get(symbols, r01).Link.Equals(r10), true);
});

test("Get: 越界抛错（Go 是 panic: index out of range）", () => {
  const empty = NewSymbolMap(1);
  assert.throws(() => Get(empty, new Ref(0, 0)), /index out of range/);
  assert.throws(() => Get(empty, new Ref(5, 0)), /index out of range/);
  assert.throws(() => Get(new SymbolMap([]), new Ref(0, 0)), /index out of range/);
});

test("FindAssertOrWithEntry: 命中返回副本、未命中返回 null（ast.go:219-226）", () => {
  const entries = [
    {
      Key: utf16("type"),
      Value: utf16("json"),
      KeyLoc: new Loc(1),
      ValueLoc: new Loc(7),
      PreferQuotedKey: true,
    },
    { Key: utf16("ver"), Value: utf16("1"), KeyLoc: new Loc(9), ValueLoc: new Loc(13), PreferQuotedKey: false },
  ];

  const found = FindAssertOrWithEntry(entries, "type");
  assert.notEqual(found, null);
  assert.deepEqual(found!.Value, utf16("json")); // Go: value="json"
  assert.equal(found!.PreferQuotedKey, true);
  assert.equal(found!.KeyLoc.Start, 1); // Go: keyloc=1
  // Go 返回的是 range 副本的地址：sameptr=false，改副本不回写切片元素
  assert.notEqual(found, entries[0]);
  found!.PreferQuotedKey = false;
  assert.equal(entries[0].PreferQuotedKey, true);

  assert.equal(FindAssertOrWithEntry(entries, "typ"), null); // Go: find_missing,nil=true
  assert.notEqual(FindAssertOrWithEntry(entries, "ver"), null); // Go: find_ver,nil=false
});

function utf16(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
  return out;
}


