// 1:1 移植自 esbuild internal/js_parser/js_parser.go（v0.28.2，commit f6058f83）
//
// ⚠️ 这是**骨架子集**（第 12 次推进），不是全量 parser。目的有两个：
//   1. 让 `Parse` → `parseStmtsUpTo` → `parseStmt` → `parseExpr` → `parsePrefix`/`parseSuffix`
//      的真实调用链跑起来，从而驱动 js_lexer 里只能由 parser 触发的路径
//      （`ScanRegExp` / `RescanCloseBraceAsTemplateToken` / JSX 三个 Next* / Expect* 系）；
//   2. 产出的 AST 与 Go 的 `js_parser.Parse` **逐节点比对**（Go 探针 dump，见
//      testdata/js_parser/ast-dump.json）。
//
// 已支持（且与 Go 的输出做过差分）：
//   - 语句：空语句、块、`var`/`let`/`const`（仅标识符绑定 + 可选初始化）、表达式语句、
//     `if`/`else`、`return`、`function` 声明、`debugger`
//   - 表达式：数字/大整数/字符串/无替换模板/带替换模板/正则/true/false/null/this、
//     标识符、数组字面量、括号、一元（+ - ~ ! void typeof delete ++ --）、二元（+ - * / % **
//     < <= > >= == != === !== && || ?? | & ^ << >> >>>）、赋值（= += -= *= /=）、
//     调用、成员访问（. 与 []）、函数声明、JSX 元素（属性 + 文本 + 子元素 + `{expr}`）
//
// **明确未移植**（遇到即 `Unexpected()` / `Expected()` 抛 LexerPanic，绝不静默吞掉）：
//   对象字面量、箭头函数、class、import/export、for/while/do/switch/try/with/throw/break/continue、
//   标签、解构绑定、默认参数、rest/spread 参数、可选链 `?.`、条件运算符 `?:`、
//   TS 语法、JSX preserve 模式、以及 Go 的 visit pass（作用域提升/符号重命名/常量折叠）。
//   这些在 PLAN.md「第 12 次推进」§3 里逐条登记。
//
// 与 Go 的两处**结构性差异**（骨架阶段的刻意简化，均已登记）：
//   1. Go 是「两趟」：parse pass 用 `storeNameInRef` 存名字，visit pass 才解析成符号。
//      骨架只有 parse pass，遇到标识符立刻 `findSymbol`/建 unbound 符号。
//   2. `declareSymbol` 的 `canMergeSymbols`（Go 的全部合并规则）未移植；骨架保留首个同名符号。

import {
  AddError,
  AddErrorWithNotes,
  AddID,
  AddIDWithNotes,
  AddMsgID,
  GenerateStringInJSTable,
  Loc,
  MakeLineColumnTracker,
  NewStringInJSLog,
  RemapStringInJSLoc,
  Msg,
  MsgKind,
  MsgData,
  Path,
  Range,
  Log,
  Source,
  type LineColumnTracker,
  type StringInJSTableEntry,
} from "../logger/logger.ts";
import { MsgID_JS_AssertToWith, MsgID_JS_CallImportNamespace, MsgID_JS_AssignToDefine, MsgID_JS_DuplicateCase, MsgID_JS_DuplicateClassMember, MsgID_JS_DuplicateObjectKey, MsgID_JS_EqualsNaN, MsgID_JS_EqualsNegativeZero, MsgID_JS_EqualsNewObject, MsgID_JS_ImpossibleTypeof, MsgID_JS_UnsupportedJSXComment, MsgID_JS_UnsupportedRegExp } from "../logger/msg_ids.ts";
import { ContainsNonBMPCodePoint, StringToUTF16, UTF16EqualsString, UTF16ToString, UTF16ToStringWithValidation } from "../helpers/utf.ts";
import { IsInsideNodeModules } from "../helpers/path.ts";
import { QuoteSingle } from "../helpers/quote.ts";
import { StringArraysEqual } from "../helpers/strings.ts";
import { HashCombine, HashCombineString } from "../helpers/hash.ts";
import { init } from "../helpers/init.ts";
import { DefaultNameMinifierJS, ImportKind, ImportPhase, ImportRecordFlags, InvalidRef, LocRef, Ref, Symbol, SymbolKind } from "../ast/ast.ts";
import * as ast from "../ast/ast.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import {
  classLoweringInfo, computeClassLoweringInfo, privateSymbolNeedsToBeLowered,
  lowerPrivateGet, lowerPrivateSet, lowerPrivateSetUnOp, lowerPrivateSetBinOp, lowerPrivateBrandCheck,
  extractPrivateIndex, extractSuperProperty, shouldLowerSuperPropertyAccess,
  lowerSuperPropertyGet, lowerSuperPropertySet, lowerSuperPropertySetBinOp,
  callSuperPropertyWrapper, lowerSuperPropertyOrPrivateInAssign, maybeLowerSuperPropertyGetInsideCall,
  lowerClass,
} from "./js_parser_lower_class.ts";
import { IsIdentifier, IsIdentifierContinue } from "../js_ast/js_ident.ts";
import * as js_ast_helpers from "../js_ast/js_ast_helpers.ts";
import { CommentBefore, KeyOrValue, Lexer, LexerPanic, MaybeSubstring, RangeOfIdentifier, RangeOfImportAssertOrWith } from "../js_lexer/js_lexer.ts";
import { T, Keywords, StrictModeReservedWords } from "../js_lexer/tables.ts";
import { JSONOptions, ParseJSON, isValidJSON } from "./json_parser.ts";
import { Has as HasFeature, JSFeature } from "../compat/compat.ts";
import {
  markStrictModeFeature, strictModeFeature, whyESM,
  lowerNullishCoalescing, lowerAssignmentOperator, lowerExponentiationAssignmentOperator,
  lowerNullishCoalescingAssignmentOperator, lowerLogicalAssignmentOperator, maybeLowerSetBinOp,
  lowerObjectSpread, lowerObjectRestInDecls, lowerObjectRestInForLoopInit, lowerObjectRestInCatchBinding,
  lowerOptionalChain, lowerParenthesizedOptionalChain, lowerAssign, objRestMode,
  lowerFunction, maybeLowerAwait, lowerForAwaitLoop, markAsyncFn, captureThis, captureArguments,
  shouldLowerUsingDeclarations, lowerUsingDeclarationContext, lowerUsingDeclarationInForOf, lowerTemplateLiteral,
} from "./js_parser_lower.ts";
import {
  parseTypeScriptImportEqualsStmt, parseTypeScriptEnumStmt, parseTypeScriptNamespaceStmt,
  generateClosureForTypeScriptEnum, generateClosureForTypeScriptNamespaceOrEnum, wrapInlinedEnum,
} from "./ts_parser.ts";

const decoder = new TextDecoder();

function bytesToString(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** 构造 js_ast.Expr（Go 结构体字面量 `js_ast.Expr{Loc: ..., Data: ...}`） */
function mkExpr(data: js_ast.E | null, loc: Loc): js_ast.Expr {
  return new js_ast.Expr(data, loc);
}

/** Go: helpers.StringToUTF16(string) → Uint16Array（AST 的 EString.Value 类型） */
function utf16FromString(text: string): Uint16Array {
  return new Uint16Array(StringToUTF16(new TextEncoder().encode(text)));
}

/** Go: func remapExprLocsInJSON(expr *js_ast.Expr, table []logger.StringInJSTableEntry) (js_parser.go:16598) */
export function remapExprLocsInJSON(expr: js_ast.Expr, table: StringInJSTableEntry[]): void {
  expr.Loc = RemapStringInJSLoc(table, expr.Loc);
  const e = expr.Data;
  if (e instanceof js_ast.EArray) {
    e.CloseBracketLoc = RemapStringInJSLoc(table, e.CloseBracketLoc);
    for (const item of e.Items) remapExprLocsInJSON(item, table);
  } else if (e instanceof js_ast.EObject) {
    e.CloseBraceLoc = RemapStringInJSLoc(table, e.CloseBraceLoc);
    for (const prop of e.Properties) {
      remapExprLocsInJSON(prop.Key, table);
      if (prop.ValueOrNil !== null) remapExprLocsInJSON(prop.ValueOrNil, table);
    }
  }
}

/** Go: type substituteStatus uint8 (js_parser.go:9721) —— 单次使用符号代入的三态返回 */
const substituteContinue = 0;
const substituteSuccess = 1;
const substituteFailure = 2;

/** Go: config.TSOptions 的字段子集（config 包整包未移植，见 PLAN.md「第 11 次推进」§3） */
export interface TSOptions {
  Parse: boolean;
  NoAmbiguousLessThan: boolean;
}

/** Go: config.JSXOptions 的字段子集（同上） */
export interface JSXOptions {
  Parse: boolean;
  Preserve: boolean;
  /** Go: jsx.AutomaticRuntime —— "@jsxRuntime automatic" 开启 react/jsx-runtime lowering */
  AutomaticRuntime: boolean;
  /** Go: jsx.Development —— "@jsxRuntime automatic" 的 dev 变体（jsxDEV / jsx-dev-runtime） */
  Development: boolean;
  /** Go: jsx.Factory（config.DefineExpr.Parts）—— 默认 ["React","createElement"] */
  Factory: string[];
  /** Go: jsx.Fragment —— 默认 ["React","Fragment"] */
  Fragment: string[];
  /** Go: jsx.ImportSource —— automatic runtime 的包名，默认 "react" */
  ImportSource: string;
  /** Go: jsx.SideEffects —— 为 true 时 createElement 调用不能当作无副作用 */
  SideEffects: boolean;
}

/** Go: js_parser.Options（只落骨架用到的字段；injectedFiles/defines 等留给后续） */
/** Go: config.ModuleTypeData（js_ast.go:1519 的 ModuleType 枚举 + 来源位置） */
export class ModuleTypeData {
  Type: number = 0; // ModuleUnknown
  Source: Source | null = null;
  Range: Range = new Range();
}

/** Go: config.TSOptions.AlwaysStrict 的位置信息（whyStrictMode 的 notes 用） */
export class TSAlwaysStrict {
  Name: string = "";
  Source: Source | null = null;
  Range: Range = new Range();
  /** Go: TSAlwaysStrict.Value（Options.Equal 用） */
  Value: boolean = false;
}

export class Options {
  ts: TSOptions = { Parse: false, NoAmbiguousLessThan: false };
  jsx: JSXOptions = {
    Parse: true,
    Preserve: false,
    AutomaticRuntime: false,
    Development: false,
    Factory: ["React", "createElement"],
    Fragment: ["React", "Fragment"],
    ImportSource: "react",
    SideEffects: false,
  };
  /** Go: OptionsFromConfig 里的 MinifyWhitespace；压缩时不收集 exprComments */
  minifyWhitespace: boolean = false;
  /** Go: options.minifySyntax（selectLocalKind 的 const→let 优化用；M1 默认 false） */
  minifySyntax: boolean = false;
  /** Go: options.minifyIdentifiers（computeCharacterFrequency 的开关；第 44 轮 define 后同轮攻 CharFreq 链） */
  minifyIdentifiers: boolean = false;
  /** Go: options.unsupportedJSFeatures（M1 默认 0；selectLocalKind 看 ConstAndLet） */
  unsupportedJSFeatures: bigint = 0n;
  /** Go: options.mode（0=ModePassThrough / 1=ModeConvertFormat / 2=ModeBundle；M1 默认 0） */
  mode: number = 0;
  /**
   * Go: options.outputFormat（`config.Format` 的整数形式：0 preserve / 1 iife / 2 cjs / 3 esm；
   * 用 Go 探针实测 tmpfmt 得到，见 `docs/m1-closeout-plan.md` §2 Q 行的同款口径）
   */
  outputFormat: number = 0;
  /** Go: options.keepNames（M1 默认 false；影响 computeClassLoweringInfo 的静态块降级） */
  keepNames: boolean = false;
  /** Go: options.ts.Config.ExperimentalDecorators == config.True */
  tsExperimentalDecorators: boolean = false;
  /** Go: options.originalTargetEnv（诊断文案用；M1 为空 → “the configured target environment”） */
  originalTargetEnv: string = "";
  /** Go: options.moduleTypeData（.mjs/.mts/package.json 的模块类型；M1 的 stdin 语料恒 Unknown） */
  moduleTypeData: ModuleTypeData | null = null;
  /** Go: options.tsAlwaysStrict（TS 的 alwaysStrict 设置位置；ts.Parse=0 时不用） */
  tsAlwaysStrict: TSAlwaysStrict | null = null;
  /** Go: options.unsupportedJSFeatureOverridesMask（M1 恒 0）—— 只影响 PrettyPrintTargetEnvironment 的 " + N overrides" */
  unsupportedJSFeatureOverridesMask: bigint = 0n;
  /** Go: options.asciiOnly（checkForUnrepresentableIdentifier 用；M1 默认 false） */
  asciiOnly: boolean = false;
  /** Go: options.mangleProps / mangleQuoted / reserveProps（C 批 mangled props；M1 默认关闭） */
  mangleProps: RegExp | null = null;
  mangleQuoted: boolean = false;
  reserveProps: RegExp | null = null;
  /** Go: p.willWrapModuleInTryCatchForUsing（M1 默认 false） */
  willWrapModuleInTryCatchForUsing: boolean = false;
  /**
   * Go: config.ProcessedDefines / p.options.defines（第 44 轮 define 链）。
   * key 为标识符名（单 part）或属性链的最后一段（多 part），值是待匹配的 KeyParts + DefineExpr。
   * M1 默认空（只有内置 undefined/NaN/Infinity），六档门不受影响。
   */
  defines: DefineData[] = [];
  /**
   * Go: options.decodeHydrateRuntimeStateYarnPnP（js_parser.go:491，internal-only）
   * 第 172 批：PnP JS 拦截底座。仅 OptionsForYarnPnP() 置 true，M1 默认 false。
   */
  decodeHydrateRuntimeStateYarnPnP: boolean = false;
  // 第 91 轮：OptionsFromConfig / Equal 需要的完整映射字段（Go optionsThatSupportStructuralEquality）
  injectedFiles: any[] = [];
  dropLabels: string[] | null = null;
  unsupportedJSFeatureOverrides: bigint = 0n;
  platform: number = 0;
  treeShaking: boolean = false;
  omitRuntimeForTests: boolean = false;
  omitJSXRuntimeForTests: boolean = false;
  ignoreDCEAnnotations: boolean = false;
  dropDebugger: boolean = false;
  logPathStyle: number = 0;
  codePathStyle: number = 0;
  /** Go: ts.Config.ExperimentalDecorators（Options.Equal 用；TS 侧以 bool 承载） */
  tsConfigExperimentalDecorators: number = 0;
}

/** Go: func OptionsForYarnPnP() Options (js_parser.go:494) —— 只置 PnP 内部开关 */
export function OptionsForYarnPnP(): Options {
  return init(new Options(), { decodeHydrateRuntimeStateYarnPnP: true });
}

// ============================================================================
// 第 91 轮：OptionsFromConfig + (*Options).Equal（js_parser.go:502/539）
// parseRuntime / parseFile 从 config.Options（TS 侧 duck-typed any）到 parser.Options
// 的桥。Go 探针 tmpgen_ofc_test.bak → testdata/options-from-config-go.json（13 行逐字节）。
// ============================================================================

/** Go: func OptionsFromConfig(options *config.Options) Options (js_parser.go:502) */
export function OptionsFromConfig(options: any): Options {
  const o = new Options();
  o.injectedFiles = options.InjectedFiles ?? [];
  o.jsx = options.JSX ?? o.jsx;
  o.tsAlwaysStrict = options.TSAlwaysStrict ?? null;
  o.mangleProps = options.MangleProps ?? null;
  o.reserveProps = options.ReserveProps ?? null;
  o.dropLabels = options.DropLabels ?? null;
  // defines：Go 传指针（ProcessedDefines），TS 侧 DefineData[]
  o.defines = options.Defines ?? [];

  // optionsThatSupportStructuralEquality（逐字段）
  o.unsupportedJSFeatures = options.UnsupportedJSFeatures ?? 0n;
  o.unsupportedJSFeatureOverrides = options.UnsupportedJSFeatureOverrides ?? 0n;
  o.unsupportedJSFeatureOverridesMask = options.UnsupportedJSFeatureOverridesMask ?? 0n;
  o.originalTargetEnv = options.OriginalTargetEnv ?? "";
  const ts = options.TS ?? {};
  o.ts = {
    Parse: !!ts.Parse,
    NoAmbiguousLessThan: !!ts.NoAmbiguousLessThan,
  };
  o.tsConfigExperimentalDecorators = ts.Config?.ExperimentalDecorators ?? 0;
  o.mode = options.Mode ?? 0;
  o.platform = options.Platform ?? 0;
  o.outputFormat = options.OutputFormat ?? 0;
  o.moduleTypeData = options.ModuleTypeData ?? null;
  o.asciiOnly = !!options.ASCIIOnly;
  o.keepNames = !!options.KeepNames;
  o.minifySyntax = !!options.MinifySyntax;
  o.minifyIdentifiers = !!options.MinifyIdentifiers;
  o.minifyWhitespace = !!options.MinifyWhitespace;
  o.omitRuntimeForTests = !!options.OmitRuntimeForTests;
  o.omitJSXRuntimeForTests = !!options.OmitJSXRuntimeForTests;
  o.ignoreDCEAnnotations = !!options.IgnoreDCEAnnotations;
  o.treeShaking = !!options.TreeShaking;
  o.dropDebugger = !!options.DropDebugger;
  o.mangleQuoted = !!options.MangleQuoted;
  o.logPathStyle = options.LogPathStyle ?? 0;
  o.codePathStyle = options.CodePathStyle ?? 0;
  return o;
}

/**
 * Go: func (a *Options) Equal(b *Options) bool (js_parser.go:539)
 * 依赖已移植的 isSameRegexp / jsxExprsEqual / StringArraysEqual。
 * 以独立函数实现（与 Go 方法签名 1:1，首参为 receiver a）。
 */
export function Equal(a: Options, b: Options): boolean {
  // optionsThatSupportStructuralEquality：逐字段结构体相等（bigint 用 ===）
  if (a.originalTargetEnv !== b.originalTargetEnv ||
      a.moduleTypeData?.Type !== b.moduleTypeData?.Type ||
      a.unsupportedJSFeatures !== b.unsupportedJSFeatures ||
      a.unsupportedJSFeatureOverrides !== b.unsupportedJSFeatureOverrides ||
      a.unsupportedJSFeatureOverridesMask !== b.unsupportedJSFeatureOverridesMask ||
      a.ts.Parse !== b.ts.Parse || a.ts.NoAmbiguousLessThan !== b.ts.NoAmbiguousLessThan ||
      a.tsConfigExperimentalDecorators !== b.tsConfigExperimentalDecorators ||
      a.mode !== b.mode || a.platform !== b.platform || a.outputFormat !== b.outputFormat ||
      a.logPathStyle !== b.logPathStyle || a.codePathStyle !== b.codePathStyle ||
      a.asciiOnly !== b.asciiOnly || a.keepNames !== b.keepNames ||
      a.minifySyntax !== b.minifySyntax || a.minifyIdentifiers !== b.minifyIdentifiers ||
      a.minifyWhitespace !== b.minifyWhitespace ||
      a.omitRuntimeForTests !== b.omitRuntimeForTests ||
      a.omitJSXRuntimeForTests !== b.omitJSXRuntimeForTests ||
      a.ignoreDCEAnnotations !== b.ignoreDCEAnnotations ||
      a.treeShaking !== b.treeShaking || a.dropDebugger !== b.dropDebugger ||
      a.mangleQuoted !== b.mangleQuoted ||
      a.decodeHydrateRuntimeStateYarnPnP !== b.decodeHydrateRuntimeStateYarnPnP) {
    return false;
  }
  // tsAlwaysStrict
  const at = a.tsAlwaysStrict, bt = b.tsAlwaysStrict;
  if ((at === null) !== (bt === null)) return false;
  if (at !== null && bt !== null && (at.Name !== bt.Name || at.Value !== bt.Value)) return false;
  // regexes
  if (!isSameRegexp(a.mangleProps, b.mangleProps) || !isSameRegexp(a.reserveProps, b.reserveProps)) return false;
  // dropLabels
  if (!StringArraysEqual(a.dropLabels ?? [], b.dropLabels ?? [])) return false;
  // injectedFiles
  if (a.injectedFiles.length !== b.injectedFiles.length) return false;
  for (let i = 0; i < a.injectedFiles.length; i++) {
    const x = a.injectedFiles[i], y = b.injectedFiles[i];
    if (x.Source !== y.Source || x.DefineName !== y.DefineName || (x.Exports?.length ?? 0) !== (y.Exports?.length ?? 0)) return false;
    for (let j = 0; j < (x.Exports?.length ?? 0); j++) if (x.Exports[j] !== y.Exports[j]) return false;
  }
  // jsx（Go: jsxExprsEqual(Factory)/jsxExprsEqual(Fragment)；TS 的 Factory/Fragment 是 string[]，
  // 无 Constant 字段，等价于 DefineExpr{Parts} 的比较）
  if (a.jsx.Parse !== b.jsx.Parse ||
      !StringArraysEqual(a.jsx.Factory, b.jsx.Factory) ||
      !StringArraysEqual(a.jsx.Fragment, b.jsx.Fragment)) return false;
  // defines cheap assert
  if ((a.defines !== null && a.defines.length > 0) || (b.defines !== null && b.defines.length > 0)) {
    if (a.defines === null || b.defines === null || a.defines.length !== b.defines.length) {
      throw new Error("Internal error");
    }
  }
  return true;
}

/** Go: config.DefineData（config/globals.go:926）—— 用户 define 的一条记录 */
export class DefineData {
  KeyParts: string[] = [];
  DefineExpr: DefineExpr | null = null;
  CanBeRemovedIfUnused: boolean = false;
  CallCanBeUnwrappedIfUnused: boolean = false;
  IsSymbolInstance: boolean = false;
}

/** Go: type parseStmtOpts struct */
export class parseStmtOpts {
  isModuleScope: boolean = false;
  allowDirectivePrologue: boolean = false;
  isExport: boolean = false;
  /** Go: isNameOptional —— "export default function() {}" / "export default class {}" */
  isNameOptional: boolean = false;
  /** Go: isCaseBody —— switch case 体里的语句 */
  isCaseBody: boolean = false;
  /** Go: isTypeScriptDeclare —— "declare var x" / "declare class Foo {}" */
  isTypeScriptDeclare: boolean = false;
  /** Go: isNamespaceScope —— TS namespace 体 */
  isNamespaceScope: boolean = false;
  /** Go: isForLoopInit —— for 循环初始化子句（using 的 of 判定与初始化器要求都看它） */
  isForLoopInit: boolean = false;
  /** Go: isForAwaitLoopInit */
  isForAwaitLoopInit: boolean = false;
  /** Go: lexicalDecl（0 normal / 1 allowFnInsideIf / 2 allowFnInsideLabel） */
  lexicalDecl: number = 0;
  /** Go: deferredDecorators —— "@x export class Foo {}" 里穿过 export 的装饰器 */
  deferredDecorators: js_ast.Decorator[] | null = null;
}

/** Go: type propertyOpts struct（js_parser.go）的 JS 子集 */
export class propertyOpts {
  isClass: boolean = false;
  isAsync: boolean = false;
  isGenerator: boolean = false;
  isStatic: boolean = false;
  classHasExtends: boolean = false;
  classKeyword: Range = new Range();
  /** Go: propertyOpts.decorators */
  decorators: js_ast.Decorator[] = [];
}

/** Go: type JSXImport uint8 (js_parser.go:1809) */
export const jsxImport = {
  JSX: 0,
  JSXS: 1,
  Fragment: 2,
  CreateElement: 3,
} as const;

/** Go: type mergeResult int (js_parser.go:1377) */
const mergeResult = {
  Forbidden: 0,
  ReplaceWithNew: 1,
  OverwriteWithNew: 2,
  KeepExisting: 3,
  BecomePrivateGetSetPair: 4,
  BecomePrivateStaticGetSetPair: 5,
} as const;

/** Go: type fnKind uint8 */
const fnKind = { fnStmt: 0, fnExpr: 1 } as const;

/** Go: type generateTempRefArg uint8 (js_parser.go:8609) */
export const generateTempRefArg = {
  tempRefNeedsDeclare: 0,
  tempRefNoDeclare: 1,
  /** 生成的临时值既在循环体内、又可能在闭包里 —— 只能用 "let" 并在块内声明 */
  tempRefNeedsDeclareMayBeCapturedInsideLoop: 2,
} as const;

/** Go: config.Mode 的整数形式（Go 探针 tmpfmt 实测 0/1/2） */
const modePassThrough = 0;
const modeBundle = 2;
/** Go: config.FormatCommonJS（Go 探针 tmpfmt 实测 = 2） */
const formatCommonJS = 2;
/** Go: runtime.SourceIndex（`internal/runtime/runtime.go:16` 实测 = 0） */
const runtimeSourceIndex = 0;

/** Go: type globPart (js_parser.go:16759) —— globPatternFromExpr 的内部表示 */
class globPart {
  text: string = "";
  isWildcard: boolean = false;
}

/** Go: type exprFlag uint8 */
export type exprFlag = number;
export const exprFlag = {
  exprFlagNone: 0,
  exprFlagDecorator: 1 << 0,
  exprFlagIsNewTarget: 1 << 1,
  exprFlagAfterQuestionAndBeforeColon: 1 << 2,
} as const;

/** Go: type scopeMemberArray []js_ast.ScopeMember (js_parser.go:1524) —— 为了用 Go 原生 sort */
class scopeMemberArray {
  members: js_ast.ScopeMember[];

  constructor(members: js_ast.ScopeMember[]) {
    this.members = members;
  }

  Len(): number {
    return this.members.length;
  }

  Swap(i: number, j: number): void {
    const t = this.members[i];
    this.members[i] = this.members[j];
    this.members[j] = t;
  }

  Less(i: number, j: number): boolean {
    const ai = this.members[i].Ref;
    const bj = this.members[j].Ref;
    return ai.InnerIndex < bj.InnerIndex || (ai.InnerIndex === bj.InnerIndex && ai.SourceIndex < bj.SourceIndex);
  }

  /** Go: sort.Sort(scopeMemberArray) —— Ref 是仐序（InnerIndex 唯一），插入排序与 Go 结果相同 */
  sort(): js_ast.ScopeMember[] {
    const n = this.Len();
    for (let i = 1; i < n; i++) {
      for (let j = i; j > 0 && this.Less(j, j - 1); j--) {
        this.Swap(j, j - 1);
      }
    }
    return this.members;
  }
}

/** Go: type AssignTarget uint8 (js_ast.go:95) —— None=0 / Replace=1 / Update=2 */
export const assignTarget = {
  assignTargetNone: 0,
  assignTargetReplace: 1,
  assignTargetUpdate: 2,
} as const;

/** Go: type exprIn struct (js_parser.go) —— 只保留 visit 分支用到的字段 */
export class exprIn {
  assignTarget: number = assignTarget.assignTargetNone;
  shouldMangleStringsAsProps: boolean = false;
  /** Go: exprIn.isMethod —— 类方法的函数体不是普通表达式（影响 this/super 与 keepNames） */
  isMethod: boolean = false;
  /** Go: exprIn.isLoweredPrivateMethod */
  isLoweredPrivateMethod: boolean = false;
  /** Go: exprIn.hasChainParent —— 父节点是同链上的可选链访问（js_parser.go:13186） */
  hasChainParent: boolean = false;
  /** Go: exprIn.storeThisArgForParentOptionalChain —— 父 ECall 是链起点，需存 this（js_parser.go:13231） */
  storeThisArgForParentOptionalChain: boolean = false;
}

/** Go: type exprOut struct (js_parser.go:13245) —— 可选链降级在 visit 分支间传递的元数据 */
export class exprOut {
  thisArgFunc: ((() => js_ast.Expr) | null) = null;
  thisArgWrapFunc: (((expr: js_ast.Expr) => js_ast.Expr) | null) = null;
  childContainsOptionalChain: boolean = false;
  callMustBeReplacedWithUndefined: boolean = false;
  methodCallMustBeReplacedWithUndefined: boolean = false;
}

/** Go: type bindingOpts struct (js_parser.go) */
export class bindingOpts {
  duplicateArgCheck: Map<string, Range> | null = null;
}

/** Go: type importsExportsScanResult struct (js_parser.go:17262) */
class importsExportsScanResult {
  stmts: js_ast.Stmt[] = [];
  keptImportEquals: boolean = false;
  removedImportEquals: boolean = false;
}

/** Go: type visitClassResult struct (js_parser.go:12166) */
class visitClassResult {
  bodyScope: js_ast.Scope | null = null;
  innerClassNameRef: Ref = InvalidRef;
  superCtorRef: Ref = InvalidRef;
  canBeRemovedIfUnused: boolean = false;
}

/** Go: func isSimpleParameterList(args []js_ast.Arg, hasRestArg bool) bool (js_parser.go:12549) */
function isSimpleParameterList(args: js_ast.Arg[], hasRestArg: boolean): boolean {
  if (hasRestArg) return false;
  for (const arg of args) {
    if (!(arg.Binding.Data instanceof js_ast.BIdentifier) || arg.DefaultOrNil !== null) return false;
  }
  return true;
}

/** Go: func fnBodyContainsUseStrict(body []js_ast.Stmt) (logger.Loc, bool) (js_parser.go:12561) */
function fnBodyContainsUseStrict(body: js_ast.Stmt[]): Loc | null {
  for (const stmt of body) {
    const s = stmt.Data;
    if (s instanceof js_ast.SComment) continue;
    if (s instanceof js_ast.SDirective) {
      if (UTF16EqualsString(s.Value, new TextEncoder().encode("use strict"))) return stmt.Loc;
      return null;
    }
    return null;
  }
  return null;
}

/** Go: type stmtsKind uint8 (js_parser.go:8952) —— mangleStmts 的上下文（循环体/函数体尾部优化用） */
export type stmtsKind = number;
export const stmtsKind = {
  stmtsNormal: 0,
  stmtsLoopBody: 1,
  stmtsFnBody: 2,
} as const;

/** Go: type deferredErrors struct (js_parser.go:1943) */
export class deferredErrors {
  invalidExprDefaultValue: Range = new Range();
  invalidExprAfterQuestion: Range = new Range();
  arraySpreadFeature: Range = new Range();
  invalidParens: Range[] = [];

  /** Go: func (from *deferredErrors) mergeInto(to *deferredErrors) (js_parser.go:1953) */
  mergeInto(to: deferredErrors): void {
    if (this.invalidExprDefaultValue.Len > 0) {
      to.invalidExprDefaultValue = this.invalidExprDefaultValue;
    }
    if (this.invalidExprAfterQuestion.Len > 0) {
      to.invalidExprAfterQuestion = this.invalidExprAfterQuestion;
    }
    if (this.arraySpreadFeature.Len > 0) {
      to.arraySpreadFeature = this.arraySpreadFeature;
    }
    if (this.invalidParens.length > 0) {
      if (to.invalidParens.length > 0) {
        to.invalidParens = to.invalidParens.concat(this.invalidParens);
      } else {
        to.invalidParens = this.invalidParens;
      }
    }
  }
}

/** Go: type deferredArrowArgErrors struct (js_parser.go:2075) */
export class deferredArrowArgErrors {
  invalidExprAwait: Range = new Range();
  invalidExprYield: Range = new Range();
}

/**
 * Go: func PrettyPrintTargetEnvironment(originalTargetEnv string, unsupportedJSFeatureOverridesMask compat.JSFeature) string
 * (internal/config/config.go:852)
 *
 * 只用于诊断文案；overrides 非 0 时追加 " + N override(s)"。
 */
export function prettyPrintTargetEnvironment(originalTargetEnv: string, unsupportedJSFeatureOverridesMask: bigint): string {
  let where = "the configured target environment";
  let overrides = "";
  if (unsupportedJSFeatureOverridesMask !== 0n) {
    let count = 0;
    for (let mask = unsupportedJSFeatureOverridesMask; mask !== 0n; mask >>= 1n) {
      if ((mask & 1n) !== 0n) count++;
    }
    overrides = ` + ${count} override${count === 1 ? "" : "s"}`;
  }
  if (originalTargetEnv !== "") {
    where = `${where} (${originalTargetEnv}${overrides})`;
  }
  return where;
}

/** Go: type wasOriginallyDotOrIndex uint8 (js_parser.go:2877) */
export type wasOriginallyDotOrIndex = number;
export const wasOriginallyDot: wasOriginallyDotOrIndex = 0;
export const wasOriginallyIndex: wasOriginallyDotOrIndex = 1;

/** Go: var permanentReservedProps = map[string]bool{...} (js_parser.go:2845) */
const permanentReservedProps = new Set<string>(["__proto__", "constructor", "prototype"]);

/**
 * Go: type fnOrArrowDataParse struct (js_parser.go:646) —— 只保留 D 批与 visit 用到的字段。
 * Go 还带 `arrowArgErrors`/`decoratorScope`/`await`/`yield` 等，待用到时再补。
 */
export class fnOrArrowDataParse {
  allowSuperCall: boolean = false;
  allowSuperProperty: boolean = false;
  isTopLevel: boolean = false;
  isConstructor: boolean = false;
  isTypeScriptDeclare: boolean = false;
  isThisDisallowed: boolean = false;
  isReturnDisallowed: boolean = false;
  /** In TypeScript, forward declarations of functions have no bodies */
  allowMissingBodyForTypeScript: boolean = false;
  /** Go: fnOrArrowDataParse.yield（awaitOrYield；0 = allowIdent） */
  yield: number = 0;
  /** Go: fnOrArrowDataParse.await（awaitOrYield；0 = allowIdent） */
  await: number = 0;
}

/** Go: type stringLocalForYarnPnP struct (js_parser.go:406) —— 记录 `var X = "<json>"` 的字符串本地 */
export class stringLocalForYarnPnP {
  value: Uint16Array = new Uint16Array(0);
  loc: Loc = new Loc();
  constructor(value?: Uint16Array, loc?: Loc) {
    if (value !== undefined) this.value = value;
    if (loc !== undefined) this.loc = loc;
  }
}

/** Go: type parser struct（字段取骨架实际用到的部分） */
export class parser {
  log: Log;
  source: Source;
  tracker: LineColumnTracker;

  /** Go: func (p *parser) warnAboutImportNamespaceCall (js_parser.go:16859) */
  warnAboutImportNamespaceCall(target: js_ast.Expr, kind: number): void {
    if (this.options.outputFormat === 0 /* FormatPreserve */) return;
    if (!(target.Data instanceof js_ast.EIdentifier)) return;
    const ref = (target.Data as js_ast.EIdentifier).Ref;
    const rk = this.refKey(ref);
    const items = this.importItemsForNamespace.get(rk);
    if (items === undefined || items.entries === null) return;
    const key = `${rk}|${kind}`;
    if (this.importNamespaceCCMap === null) this.importNamespaceCCMap = new Map();
    if (this.importNamespaceCCMap.has(key)) return;
    this.importNamespaceCCMap.set(key, true);
    const r = RangeOfIdentifier(this.source, target.Loc);
    const notes: MsgData[] = [];
    const name = this.symbols[ref.InnerIndex].OriginalName;
    // note 分支（default import 建议 / esModuleInterop）需 moduleScope/ts.Parse 状态；本夹具未触发，保留结构。
    const member = this.moduleScope?.Members.get(name);
    if (member !== undefined && member.Ref.InnerIndex === ref.InnerIndex && member.Ref.SourceIndex === ref.SourceIndex) {
      const star = this.source.RangeOfOperatorBefore(member.Loc, "*");
      if (star.Len > 0) {
        const as = this.source.RangeOfOperatorBefore(member.Loc, "as");
        if (as.Len > 0 && as.Loc.Start > star.Loc.Start) {
          const note = this.tracker.MsgData(new Range(star.Loc, RangeOfIdentifier(this.source, member.Loc).End() - star.Loc.Start),
            `Consider changing ${JSON.stringify(name)} to a default import instead:`);
          note.Location!.Suggestion = name;
          notes.push(note);
        }
      }
    }
    if (this.options.ts.Parse) {
      notes.push(new MsgData());
      notes[notes.length - 1].Text = 'Make sure to enable TypeScript\'s "esModuleInterop" setting so that TypeScript\'s type checker generates an error when you try to do this. You can read more about this setting here: https://www.typescriptlang.org/tsconfig#esModuleInterop';
    }
    let verb = "", where = "", noun = "";
    if (kind === 0) { verb = "Calling"; noun = "function"; }
    else if (kind === 1) { verb = "Constructing"; noun = "constructor"; }
    else if (kind === 2) { verb = "Using"; where = " in a JSX expression"; noun = "component"; }
    AddIDWithNotes(this.log, MsgID_JS_CallImportNamespace, 1 /* Warning */, this.tracker, r,
      `${verb} ${JSON.stringify(name)}${where} will crash at run-time because it's an import namespace object, not a ${noun}`, notes);
  }

  /** Go: func (p *parser) handleGlobPattern (js_parser.go:16617) */
  handleGlobPattern(expr: js_ast.Expr, kind: number, phase: number, prefix: string, assertOrWith: any): js_ast.Expr {
    const { parts: pattern } = this.globPatternFromExpr(expr);
    if (pattern === null) return new js_ast.Expr();
    // 组装 GlobPart（Prefix/Wildcard）
    const parts: { Prefix: string; Wildcard: number }[] = [];
    let last = { Prefix: "", Wildcard: 0 };
    for (const pt of pattern) {
      if (pt.isWildcard) {
        if (last.Wildcard === 0) {
          if (!last.Prefix.endsWith("/")) last.Wildcard = 1; // GlobAllExceptSlash
          else { last.Wildcard = 2; parts.push(last); last = { Prefix: "/", Wildcard: 1 }; }
        }
      } else if (pt.text !== "") {
        if (last.Wildcard !== 0) { parts.push(last); last = { Prefix: "", Wildcard: 0 }; }
        last.Prefix += pt.text;
      }
    }
    parts.push(last);
    // 字符串常量不处理
    if (parts.length === 1 && parts[0].Wildcard === 0) return new js_ast.Expr();
    // 只支持相对 glob
    if (!parts[0].Prefix.startsWith("./") && !parts[0].Prefix.startsWith("../")) return new js_ast.Expr();
    let ref: Ref | null = null;
    // 去重（同 kind/phase/parts）
    for (const gi of this.globPatternImports) {
      if (gi.kind !== kind || gi.phase !== phase || gi.parts.length !== parts.length) continue;
      let same = true;
      for (let i = 0; i < parts.length; i++) {
        if (gi.parts[i].Prefix !== parts[i].Prefix || gi.parts[i].Wildcard !== parts[i].Wildcard) { same = false; break; }
      }
      if (same) { ref = gi.ref; break; }
    }
    if (ref === null && prefix !== "") {
      let nameStr = prefix;
      for (const part of parts) {
        let gap = true;
        for (const ch of part.Prefix) {
          const cp = ch.codePointAt(0)!;
          if (!IsIdentifierContinue(cp)) gap = true;
          else { if (gap) { nameStr += "_"; gap = false; } nameStr += ch; }
        }
      }
      ref = this.newSymbol(SymbolKind.SymbolOther, nameStr);
      this.moduleScope!.Generated.push(ref);
      this.globPatternImports.push({ name: nameStr, parts, ref, kind, phase });
    }
    this.recordUsage(ref!);
    const id = new js_ast.EIdentifier(ref!);
    const call = new js_ast.ECall();
    call.Target = new js_ast.Expr(id, expr.Loc);
    call.Args = [expr];
    return new js_ast.Expr(call, expr.Loc);
  }

  /** Go: func (p *parser) maybeRelocateVarsToTopLevel (js_parser.go:11854) */
  maybeRelocateVarsToTopLevel(decls: js_ast.Decl[], mode: number): [js_ast.Stmt | null, boolean] {
    const empty = () => [null, false] as [js_ast.Stmt | null, boolean];
    if (this.options.mode !== 1 /* ModeBundle */ || (this.currentScope === this.moduleScope && this.singleStmtDepth === 0)) return empty();
    let scope = this.currentScope!;
    while (!js_ast.StopsHoisting(scope.Kind)) {
      if (scope.Parent === null) break;
      scope = scope.Parent;
    }
    if (scope !== this.moduleScope) return empty();
    const wrapIdentifier = (loc: Loc, ref: Ref): js_ast.Expr => {
      this.relocatedTopLevelVars.push({ Loc: loc, Ref: ref });
      this.recordUsage(ref);
      return new js_ast.Expr(new js_ast.EIdentifier(ref), loc);
    };
    let value: js_ast.Expr | null = null;
    for (const decl of decls) {
      const binding = js_ast_helpers.ConvertBindingToExpr(decl.Binding, wrapIdentifier);
      const valueExpr = decl.ValueOrNil;
      if (valueExpr !== null && valueExpr.Data !== null) {
        value = value === null ? js_ast_helpers.Assign(binding, valueExpr) : js_ast_helpers.JoinWithComma(value, js_ast_helpers.Assign(binding, valueExpr));
      } else if (mode === 1 /* relocateVarsForInOrForOf */) {
        value = value === null ? binding : js_ast_helpers.JoinWithComma(value, binding);
      }
    }
    if (value === null) return [null, true];
    const se = new js_ast.SExpr(); se.Value = value;
    return [new js_ast.Stmt(se, value.Loc), true];
  }

  /** Go: func (p *parser) instantiateInjectDotName (js_parser.go:12787) */
  instantiateInjectDotName(loc: Loc, name: { parts: string[]; injectedDefineIndex: number }, assignTarget: number): js_ast.Expr {
    const ref = this.injectedDefineSymbols[name.injectedDefineIndex];
    this.recordUsage(ref);
    if (assignTarget !== 0 /* AssignTargetNone */) {
      const where = this.injectedSymbolSources.get(this.refKey(ref));
      if (where !== undefined) {
        const r = RangeOfIdentifier(this.source, loc);
        const tracker = MakeLineColumnTracker(where.source);
        const joined = name.parts.join(".");
        const notes: MsgData[] = [tracker.MsgData(RangeOfIdentifier(where.source, where.loc),
          `The symbol ${JSON.stringify(joined)} was exported from ${JSON.stringify(where.source.PrettyPaths.Select(this.options.logPathStyle))} here:`)];
        AddErrorWithNotes(this.log, this.tracker, r,
          `Cannot assign to ${JSON.stringify(joined)} because it's an import from an injected file`, notes);
      }
    }
    return new js_ast.Expr(new js_ast.EIdentifier(ref), loc);
  }

  /** Go: func (p *parser) declareCommonJSSymbol(kind ast.SymbolKind, name string) ast.Ref (js_parser.go:18432) */
  declareCommonJSSymbol(kind: number, name: string): Ref {
    const member = this.moduleScope!.Members.get(name);
    if (member !== undefined && this.symbols[member.Ref.InnerIndex].Kind === SymbolKind.SymbolHoisted &&
        kind === SymbolKind.SymbolHoisted && !this.isFileConsideredToHaveESMExports) {
      return member.Ref;
    }
    const ref = this.newSymbol(kind, name);
    if (member === undefined) {
      const sm = new js_ast.ScopeMember();
      sm.Ref = ref; sm.Loc = new Loc(-1);
      this.moduleScope!.Members.set(name, sm);
      return ref;
    }
    this.moduleScope!.Generated.push(ref);
    return ref;
  }

  /** Go: func (p *parser) convertSymbolUseToCall(ref ast.Ref, isSingleNonSpreadArgCall bool) (js_parser.go:16834) */
  convertSymbolUseToCall(ref: Ref, isSingleNonSpreadArgCall: boolean): void {
    const key = this.refKey(ref);
    const uses = this.currentPart!.SymbolUses;
    const use = uses.get(key) ?? new js_ast.SymbolUse();
    use.CountEstimate = (use.CountEstimate - 1) >>> 0; // Go uint32 下溢
    if (use.CountEstimate === 0) uses.delete(key);
    else uses.set(key, use);
    let callUse = this.currentPart!.SymbolCallUses.get(key);
    if (callUse === undefined) { callUse = new js_ast.SymbolCallUse(); this.currentPart!.SymbolCallUses.set(key, callUse); }
    callUse.CallCountEstimate = (callUse.CallCountEstimate + 1) >>> 0;
    if (isSingleNonSpreadArgCall) callUse.SingleArgNonSpreadCallCountEstimate = (callUse.SingleArgNonSpreadCallCountEstimate + 1) >>> 0;
  }

  /** Go: func (p *parser) markSyntaxFeature (js_parser_lower.go:18) —— 本端口覆盖 logExprErrors 可达的 ArraySpread 分支 */
  markSyntaxFeature(feature: bigint, r: Range): boolean {
    let didGenerateError = true;
    if (!HasFeature(this.options.unsupportedJSFeatures, feature)) {
      didGenerateError = false;
      return didGenerateError;
    }
    const where = prettyPrintTargetEnvironment(this.options.originalTargetEnv ?? "", this.options.unsupportedJSFeatureOverridesMask ?? 0n);
    let name = "array spread"; // compat.ArraySpread（本端口唯一可达分支）
    AddError(this.log, this.tracker, r, `Transforming ${name} to ${where} is not supported yet`);
    return didGenerateError;
  }

  /** Go: func (p *parser) logExprErrors(errors *deferredErrors) (js_parser.go:1972) */
  logExprErrors(errors: deferredErrors): void {
    if (errors.invalidExprDefaultValue.Len > 0) {
      AddError(this.log, this.tracker, errors.invalidExprDefaultValue, 'Unexpected "="');
    }
    if (errors.invalidExprAfterQuestion.Len > 0) {
      const r = errors.invalidExprAfterQuestion;
      const text = new TextDecoder().decode(this.source.Contents.subarray(r.Loc.Start, r.Loc.Start + r.Len));
      AddError(this.log, this.tracker, r, `Unexpected ${JSON.stringify(text)}`);
    }
    if (errors.arraySpreadFeature.Len > 0) {
      this.markSyntaxFeature(JSFeature.ArraySpread, errors.arraySpreadFeature);
    }
  }
  lexer: Lexer;
  options: Options;

  symbols: Symbol[] = [];
  allocatedNames: Uint8Array[] = [];
  /** Go: p.importRecords（visit pass 会把它们搬到 AST.ImportRecords） */
  importRecords: js_ast.ImportRecord[] = [];
  /** Go: p.manifestForYarnPnP（js_parser.go:164，PnP JS 拦截底座，第 172 批） */
  manifestForYarnPnP: js_ast.Expr | null = null;
  /** Go: p.stringLocalsForYarnPnP map[ast.Ref]stringLocalForYarnPnP（js_parser.go:165） */
  stringLocalsForYarnPnP: Map<number, stringLocalForYarnPnP> | null = null;
  /** Go: p.exprComments map[logger.Loc][]string（非 minify 时收集 token 前注释） */
  exprComments: Map<number, string[]> | null = null;
  currentScope: js_ast.Scope | null = null;
  // 第 107 轮：变量提升底座
  singleStmtDepth: number = 0;
  relocatedTopLevelVars: { Loc: Loc; Ref: Ref }[] = [];
  moduleScope: js_ast.Scope | null = null;
  // 第 107 轮：注入符号底座（instantiateInjectDotName 可达字段）
  injectedDefineSymbols: Ref[] = [];
  injectedSymbolSources: Map<string, { source: Source; loc: Loc }> = new Map();
  // 第 107 轮：import namespace call 警告状态机底座
  importItemsForNamespace: Map<string, { entries: Map<string, any> | null }> = new Map();
  importNamespaceCCMap: Map<string, boolean> | null = null;
  // 第 108 轮：glob pattern 去重底座
  globPatternImports: { name: string; parts: { Prefix: string; Wildcard: number }[]; ref: Ref; kind: number; phase: number }[] = [];
  /** Go: p.scopesInOrder（pushScopeForParsePass 记录，popAndFlattenScope 回滚） */
  scopesInOrder: { loc: Loc; scope: js_ast.Scope }[] = [];
  /** Go: p.refToTSNamespaceMemberData map[ast.Ref]js_ast.TSNamespaceMemberData（TS namespace/enum 合并底座） */
  refToTSNamespaceMemberData: Map<number, js_ast.TSNamespaceMemberData> = new Map();
  /** Go: p.scopesInOrderForEnum map[logger.Loc][]scopeOrder（out-of-order enum 记录） */
  scopesInOrderForEnum: Map<number, { loc: Loc; scope: js_ast.Scope }[]> | null = null;
  /** Go: p.hasNonLocalExportDeclareInsideNamespace（namespace 里 export declare 判定） */
  hasNonLocalExportDeclareInsideNamespace: boolean = false;
  /** Go: p.tsEnums map[ast.Ref]map[string]TSEnumValue（跨模块 enum 内联，visit 期填充） */
  tsEnums: Map<number, Map<string, js_ast.TSEnumValue>> | null = null;
  /** Go: p.isExportedInsideNamespace map[ast.Ref]ast.Ref（namespace 内导出绑定→arg ref） */
  isExportedInsideNamespace: Map<number, number> = new Map();
  /** Go: p.emittedNamespaceVars map[ast.Ref]bool（同一 namespace 只发一次 var） */
  emittedNamespaceVars: Map<number, boolean> = new Map();
  /** Go: p.enclosingNamespaceArgRef *ast.Ref（namespace 导出回指外层 arg） */
  enclosingNamespaceArgRef: number | null = null;
  /** Go: p.shouldFoldTypeScriptConstantExpressions（enum 内数值常量折叠） */
  shouldFoldTypeScriptConstantExpressions: boolean = false;
  /** Go: p.tsNamespaceTarget / p.tsNamespaceMemberData（namespace/enum 成员链式折叠） */
  tsNamespaceTarget: js_ast.E | null = null;
  tsNamespaceMemberData: js_ast.TSNamespaceMemberData | null = null;
  /** Go: p.nameToKeep / p.nameToKeepIsFor —— 把绑定名传给初始化器（visit pass） */
  nameToKeep: string = "";
  nameToKeepIsFor: js_ast.E | null = null;
  allowIn: boolean = true;
  /** Go: p.fnOrArrowDataParse（parse 期的函数上下文；TS 侧只用到 yield/await） */
  fnOrArrowDataParse: fnOrArrowDataParse = new fnOrArrowDataParse();
  allowDirectivePrologue: boolean = false;
  /**
   * Go: fnOrArrowDataParse.allowSuperCall / allowSuperProperty（只保留 super 相关位）
   * 类方法里 allowSuperProperty=true；派生类的 constructor 里 allowSuperCall=true。
   */
  allowSuperCall: boolean = false;
  allowSuperProperty: boolean = false;
  /** Go: p.isInsideWithScope 的计数形式（parser 侧 define 代换用，js_parser.go:13764） */
  withNesting: number = 0;
  /** Go: p.jsxRuntimeImports map[string]ast.LocRef —— automatic runtime 生成的符号 */
  jsxRuntimeImports: Map<string, LocRef> = new Map();
  /** Go: p.jsxLegacyImports map[string]ast.LocRef —— createElement 回退生成的符号 */
  jsxLegacyImports: Map<string, LocRef> = new Map();
  /** Go: p.runtimeImports map[string]ast.LocRef —— lowering 的运行时助手（__template 等） */
  runtimeImports: Map<string, LocRef> = new Map();
  /** Go: p.topLevelTempRefsToDeclare / p.topLevelTempRefCount（模板 lowering 的缓存变量） */
  topLevelTempRefsToDeclare: Ref[] = [];
  topLevelTempRefCount: number = 0;
  /** Go: p.tempRefCount / p.tempRefsToDeclare / p.tempLetsToDeclare（generateTempRef） */
  tempRefCount: number = 0;
  tempRefsToDeclare: { ref: Ref; valueOrNil?: js_ast.Expr | null }[] = [];
  tempLetsToDeclare: Ref[] = [];
  /** Go: p.requireRef —— "require" 的 unbound 符号（首次用到时由 newSymbol 建立） */
  requireRef: Ref = InvalidRef;
  /** Go: p.promiseRef / p.regExpRef / p.bigIntRef —— make*Ref 的缓存 */
  promiseRef: Ref = InvalidRef;
  regExpRef: Ref = InvalidRef;
  bigIntRef: Ref = InvalidRef;
  /** Go: p.legacyOctalLiterals map[js_ast.E]logger.Range（visit pass 的 strict-mode 诊断输入） */
  legacyOctalLiterals: Map<js_ast.E, Range> | null = null;
  /** Go: p.esmExportKeyword / p.esmImportMeta / p.esmImportStatementKeyword / p.topLevelAwaitKeyword */
  esmExportKeyword: Range = new Range();
  esmImportMeta: Range = new Range();
  esmImportStatementKeyword: Range = new Range();
  topLevelAwaitKeyword: Range = new Range();
  /** Go: p.firstJSXElementLoc（JSX automatic runtime 的 strict 提示；M1 不触发） */
  firstJSXElementLoc: Loc = new Loc(0);
  /** Go: p.suppressWarningsAboutWeirdCode = helpers.IsInsideNodeModules(source.KeyPath.Text) */
  suppressWarningsAboutWeirdCode: boolean = false;
  /** Go: p.reservedProps / p.mangledProps（mangled props 的缓存，C 批） */
  reservedProps: Map<string, boolean> | null = null;
  mangledProps: Map<string, Ref> | null = null;
  /** Go: p.unrepresentableIdentifiers map[string]bool（checkForUnrepresentableIdentifier 的去重） */
  unrepresentableIdentifiers: Map<string, boolean> | null = null;
  /** Go: p.isControlFlowDead —— visit pass 的死代码区标记（M1 的 parse pass 不置位） */
  isControlFlowDead: boolean = false;
  /** Go: p.hoistedRefForSloppyModeBlockFn map[ast.Ref]ast.Ref */
  hoistedRefForSloppyModeBlockFn: Map<number, { original: Ref; hoisted: Ref }> = new Map();
  /** 解析期记录每个语句列表及其所在作用域（Go visitStmts 的输入） */
  pendingStmtLists: { stmts: js_ast.Stmt[]; scope: js_ast.Scope }[] = [];
  /** Go: p.isFileConsideredESM（仅由 import/export 语句置位，足以覆盖 M1 语料） */
  isFileConsideredESM: boolean = false;
  /**
   * Go: p.isFileConsideredToHaveESMExports（E-s1b 的 valueForThis 用）。
   * TS 侧还没有「有 ESM 导出」的判据（Go 在 Parse 末尾按 export 语句统计），
   * 先恒为 false：M1 默认 mode=PassThrough 时 valueForThis 本来就不替换，字节不受影响。
   */
  isFileConsideredToHaveESMExports: boolean = false;
  /** Go: p.stmtExprValue（js_parser.go:10042）—— 当前表达式语句的值，BinOpAssign 选 objRest 模式 */
  stmtExprValue: js_ast.E | null = null;
  /** Go: p.astHelpers —— 惰性创建的 HelperContext（对齐 Go parser 的同名字段） */
  private _astHelpers: js_ast_helpers.HelperContext | null = null;
  get astHelpers(): js_ast_helpers.HelperContext {
    if (this._astHelpers === null) {
      this._astHelpers = new js_ast_helpers.HelperContext(
        (ref) => this.symbols[ref.InnerIndex].Kind === SymbolKind.SymbolUnbound,
      );
    }
    return this._astHelpers;
  }
  /** Go: p.esmExportKeyword / p.esmImportMeta（isFileConsideredToHaveESMExports 的判据，E-s1b） */
  sawExportKeyword: boolean = false;
  sawImportMeta: boolean = false;
  /** Go: fnOnlyDataVisit.isThisNested / hasThisUsage 的简化（E-s1b） */
  isThisNested: boolean = false;
  hasThisUsage: boolean = false;
  /** Go: fnOnlyDataVisit.thisCaptureRef / argumentsCaptureRef / argumentsRef（async 降级 this/arguments 捕获） */
  thisCaptureRef: Ref | null = null;
  argumentsCaptureRef: Ref | null = null;
  argumentsRef: Ref = InvalidRef;
  /** Go: p.importMetaRef（valueForImportMeta 生成的符号） */
  importMetaRef: Ref = InvalidRef;
  /** Go: p.exportsRef —— TS 的 Parse 还没有建这个符号（M2 的 CJS 通道） */
  exportsRef: Ref | null = null;
  /** Go: p.moduleRef（第 112 批 AST 构建器底座） */
  moduleRef: Ref = new Ref(0, 0);
  /** Go: p.callTarget / p.deleteTarget / p.templateTag —— 供 maybeRewritePropertyAccess 判定访问上下文 */
  callTarget: js_ast.E | null = null;
  deleteTarget: js_ast.E | null = null;
  templateTag: js_ast.E | null = null;
  /** "if (1) function f() {}" 的单语句体（Go: visitSingleStmt 的 stmtsToSingleStmt 包装） */
  pendingIfBodies: {
    stmt: js_ast.Stmt;
    scope: js_ast.Scope;
    parent: js_ast.SIf;
    isYes: boolean;
  }[] = [];
  /** 标签体里的单语句函数声明（同上） */
  pendingLabelBodies: { stmt: js_ast.Stmt; scope: js_ast.Scope; parent: js_ast.SLabel }[] = [];
  /** Go: p.duplicateCaseChecker（switch 重复 case 检查；第 27 轮 G-1） */
  duplicateCaseChecker: duplicateCaseChecker = new duplicateCaseChecker();
  /**
   * Go: p.currentPart —— appendPart 在 visit 期间设置，SImport/SExportStar/SExportFrom
   * 把 ImportRecordIndex 追加到它的 ImportRecordIndices（js_parser.go:17560 / 17611 / 17632）。
   */
  currentPart: js_ast.Part | null = null;
  /** Go: p.namedImports map[ast.Ref]js_ast.NamedImport（键 = refKey(ref)） */
  namedImports: Map<string, js_ast.NamedImport> = new Map();
  /** Go: p.namedExports map[string]js_ast.NamedExport */
  namedExports: Map<string, js_ast.NamedExport> = new Map();
  /** Go: p.exportStarImportRecords */
  exportStarImportRecords: number[] = [];
  /** Go: config.TSUnusedImportFlags（§2.1 F-s2；M1 的 ts.Parse=false 不进入） */
  tsUnusedImportFlags: number = 0;
  /** Go: parse 期 logical fold 产生的表达式；Go 在 visit 期才 fold，故其 call/tag Kind 仍按 fold 前的原始 target 判定（comma-target 修复） */
  logicalFoldedTargets: WeakSet<object> = new WeakSet();
  /** Go: p.lowerAllOfThesePrivateNames map[string]bool（class 的 private 名保守降级；M1 为 null） */
  lowerAllOfThesePrivateNames: Map<string, boolean> | null = null;
  /** Go: p.enclosingClassKeyword */
  enclosingClassKeyword: Range = new Range();
  /** Go: p.superCtorRef */
  superCtorRef: Ref = InvalidRef;
  /** Go: p.propMethodDecoratorScope（装饰器参数的作用域） */
  propMethodDecoratorScope: js_ast.Scope | null = null;
  /** Go: p.propDerivedCtorValue（区分衍生类构造器） */
  propDerivedCtorValue: js_ast.E | null = null;

  // --- 第 34 轮 J-1：class lowering 的上下文字段（Go parser.fnOnlyDataVisit / fnOrArrowDataVisit / privateGetters / privateSetters） ---
  /** Go: fnOnlyDataVisit（js_parser.go:688）—— super/private lowering 的类上下文 */
  fnOnlyDataVisit: {
    innerClassNameRef: Ref;
    shouldReplaceThisWithInnerClassNameRef: boolean;
    isInStaticClassContext: boolean;
  } = {
    innerClassNameRef: InvalidRef,
    shouldReplaceThisWithInnerClassNameRef: false,
    isInStaticClassContext: false,
  };
  /** Go: fnOrArrowDataVisit（js_parser.go:682）—— async/generator 降级状态 */
  fnOrArrowDataVisit: { shouldLowerSuperPropertyAccess: boolean; isAsync: boolean; isGenerator: boolean; isArrow: boolean; isOutsideFnOrArrow: boolean } = {
    shouldLowerSuperPropertyAccess: false, isAsync: false, isGenerator: false, isArrow: false, isOutsideFnOrArrow: false,
  };
  /** Go: fnOnlyDataVisit.isInsideAsyncArrowFn（async 箭头里的 arguments 捕获） */
  isInsideAsyncArrowFn: boolean = false;
  /** Go: p.privateGetters map[ast.Ref]ast.Ref（键 = SourceIndex:InnerIndex） */
  privateGetters: Map<string, Ref> = new Map();
  /** Go: p.privateSetters map[ast.Ref]ast.Ref（键 = SourceIndex:InnerIndex） */
  privateSetters: Map<string, Ref> = new Map();
  /** Go: p.weakMapRef / p.weakSetRef（J-2 lowerField/lowerPrivateMethod 生成 WeakMap/WeakSet） */
  weakMapRef: Ref = InvalidRef;
  weakSetRef: Ref = InvalidRef;
  /** Go: p.shouldAddKeyComment（J-2 lowerField 的 __publicField key 注释标记；M1 默认 false） */
  shouldAddKeyComment: boolean = false;
  /** Go: p.localTypeNames map[string]bool（TS interface/type 声明的名字，K-3） */
  localTypeNames: Map<string, boolean> = new Map();

  /** Go: p.currentPart.DeclaredSymbols 的累积（单 part） */
  declaredSymbols: js_ast.DeclaredSymbol[] = [];
  /** Go: fnOrArrowDataParse.await == allowIdent —— 非 async 函数里 "await" 是普通标识符 */
  awaitIsIdentifier: boolean = false;
  /** Go: exprFlagForLoopInit / parseStmtOpts.isForLoopInit 的解析期镜像（async-of 判定用） */
  isForLoopInit: boolean = false;
  /** Go: p.afterArrowBodyLoc —— 箭头函数体之后禁止继续解析后缀（除逗号） */
  afterArrowBodyLoc: Loc = new Loc(-1);

  constructor(log: Log, source: Source, lexer: Lexer, options: Options) {
    this.log = log;
    this.source = source;
    this.tracker = MakeLineColumnTracker(source);
    this.lexer = lexer;
    this.options = options;
    // Go: newParser 末尾 `if !options.minifyWhitespace { p.exprComments = make(...) }`
    if (!options.minifyWhitespace) this.exprComments = new Map();
    // Go: newParser 的 suppressWarningsAboutWeirdCode: helpers.IsInsideNodeModules(source.KeyPath.Text)
    this.suppressWarningsAboutWeirdCode = IsInsideNodeModules(source.KeyPath.Text);
  }

  // -------------------------------------------------------------------------
  // 作用域 / 符号
  // -------------------------------------------------------------------------

  /** Go: func (p *parser) selectLocalKind(kind js_ast.LocalKind) js_ast.LocalKind (js_parser.go:1145) */
  selectLocalKind(kind: js_ast.LocalKind): js_ast.LocalKind {
    // Use "var" instead of "let" and "const" if they aren't supported
    if (
      (kind === js_ast.LocalKind.LocalLet || kind === js_ast.LocalKind.LocalConst) &&
      HasFeature(this.options.unsupportedJSFeatures, JSFeature.ConstAndLet)
    ) {
      return js_ast.LocalKind.LocalVar;
    }

    // Use "var" instead of "let" and "const" if the variable declaration may
    // need to be separated from the initializer（Go: 同条件）
    if (
      this.currentScope!.Parent === null &&
      (kind === js_ast.LocalKind.LocalLet || kind === js_ast.LocalKind.LocalConst) &&
      (this.options.mode === 2 /* ModeBundle */ || this.options.willWrapModuleInTryCatchForUsing)
    ) {
      return js_ast.LocalKind.LocalVar;
    }

    // Optimization: use "let" instead of "const" because it's shorter
    if (
      this.options.mode === 2 /* ModeBundle */ && kind === js_ast.LocalKind.LocalConst &&
      this.options.minifySyntax
    ) {
      return js_ast.LocalKind.LocalLet;
    }

    return kind;
  }

  /** 作用域栈不变量探针：currentScope 的父链长度（第 25 轮 Step 0 固化） */
  scopeDepth(): number { let d = 0; let s: js_ast.Scope | null = this.currentScope; while (s !== null) { d++; s = s.Parent; } return d; }

  /** Go: func (p *parser) pushScopeForParsePass(kind js_ast.ScopeKind, loc logger.Loc) int */
  pushScopeForParsePass(kind: js_ast.ScopeKind, loc: Loc): number {
    const parent = this.currentScope;
    const scope = new js_ast.Scope();
    scope.Kind = kind;
    scope.Parent = parent;
    scope.Label = new LocRef();
    scope.Label.Ref = InvalidRef;
    if (parent !== null) {
      parent.Children.push(scope);
      scope.StrictMode = parent.StrictMode;
      scope.UseStrictLoc = parent.UseStrictLoc;
    }
    this.currentScope = scope;
    if (this.moduleScope === null) {
      this.moduleScope = scope;
    }

    // Go: js_parser.go:1196-1208 —— 函数体作用域复制参数作用域的成员
    if (kind === js_ast.ScopeKind.ScopeFunctionBody) {
      if (parent === null || parent.Kind !== js_ast.ScopeKind.ScopeFunctionArgs) {
        throw new Error("Internal error");
      }
      for (const [name, member] of parent.Members) {
        if (this.symbols[member.Ref.InnerIndex].Kind !== SymbolKind.SymbolHoistedFunction) {
          scope.Members.set(name, member);
        }
      }
    }
    const scopeIndex = this.scopesInOrder.length;
    this.scopesInOrder.push({ loc, scope });
    return scopeIndex;
  }

  /** Go: func (p *parser) popScope() */
  popScope(): void {
    this.currentScope = this.currentScope!.Parent;
  }

  /** Go: func (p *parser) popAndFlattenScope(scopeIndex int) (js_parser.go:1291) */
  popAndFlattenScope(scopeIndex: number): void {
    // Move up to the parent scope
    const toFlatten = this.currentScope!;
    const parent = toFlatten.Parent!;
    this.currentScope = parent;

    // Erase this scope from the order
    this.scopesInOrder.splice(scopeIndex, 1);

    // Remove the last child from the parent scope
    const last = parent.Children.length - 1;
    if (parent.Children[last] !== toFlatten) {
      throw new Error("Internal error");
    }
    parent.Children.pop();

    // Reparent our child scopes into our parent
    for (const scope of toFlatten.Children) {
      scope.Parent = parent;
      parent.Children.push(scope);
    }
  }

  /** Go: func (p *parser) popAndDiscardScope(scopeIndex int) (js_parser.go:1272) */
  popAndDiscardScope(scopeIndex: number): void {
    // Unwind any newly-added scopes in reverse order
    for (let i = this.scopesInOrder.length - 1; i >= scopeIndex; i--) {
      const scope = this.scopesInOrder[i].scope;
      const parent = scope.Parent!;
      const last = parent.Children.length - 1;
      if (parent.Children[last] !== scope) {
        throw new Error("Internal error");
      }
      parent.Children.pop();
    }

    // Move up to the parent scope
    this.currentScope = this.currentScope!.Parent;

    // Truncate the scope order where we started to pretend we never saw this scope
    this.scopesInOrder.length = scopeIndex;
  }

  /**
   * Go: func (p *parser) discardScopesUpTo(scopeIndex int) (js_parser.go:1322)
   *
   * Undo all scopes pushed and popped after this scope index. 假定作用域栈当前已经回到
   * scopeIndex 对应的层级（Go 注释原话）。
   */
  discardScopesUpTo(scopeIndex: number): void {
    // Remove any direct children from their parent
    let children = this.currentScope!.Children;
    for (const child of this.scopesInOrder.slice(scopeIndex)) {
      if (child.scope.Parent === this.currentScope) {
        for (let i = children.length - 1; i >= 0; i--) {
          if (children[i] === child.scope) {
            children = children.slice(0, i).concat(children.slice(i + 1));
            break;
          }
        }
      }
    }
    this.currentScope!.Children = children;

    // Truncate the scope order where we started to pretend we never saw this scope
    this.scopesInOrder.length = scopeIndex;
  }

  /**
   * Go: func (p *parser) mergeSymbols(old ast.Ref, new ast.Ref) ast.Ref (js_parser.go:1358)
   *
   * 类似 `ast.MergeSymbols`，但作用在本 parser 的单层符号表上；不处理环（Go 注释）。
   */
  mergeSymbols(oldRef: Ref, newRef: Ref): Ref {
    if (oldRef.Equals(newRef)) {
      return newRef;
    }

    const oldSymbol = this.symbols[oldRef.InnerIndex];
    if (!oldSymbol.Link.Equals(InvalidRef)) {
      oldSymbol.Link = this.mergeSymbols(oldSymbol.Link, newRef);
      return oldSymbol.Link;
    }

    const newSymbol = this.symbols[newRef.InnerIndex];
    if (!newSymbol.Link.Equals(InvalidRef)) {
      newSymbol.Link = this.mergeSymbols(oldRef, newSymbol.Link);
      return newSymbol.Link;
    }

    oldSymbol.Link = newRef;
    newSymbol.MergeContentsWith(oldSymbol);
    return newRef;
  }

  /** Go: func (p *parser) declareBinding(kind ast.SymbolKind, binding js_ast.Binding, opts parseStmtOpts) (js_parser.go:1719) */
  declareBinding(kind: SymbolKind, binding: js_ast.Binding, opts: parseStmtOpts): void {
    js_ast_helpers.ForEachIdentifierBinding(binding, (loc, b) => {
      if (!opts.isTypeScriptDeclare || (opts.isNamespaceScope && opts.isExport)) {
        b.Ref = this.declareSymbol(kind, loc, this.loadNameFromRef(b.Ref));
      }
    });
  }

  /** Go: func (p *parser) ignoreUsage(ref ast.Ref) (js_parser.go:1748) */
  ignoreUsage(ref: Ref): void {
    // Roll back the use count increment in recordUsage()
    if (!this.isControlFlowDead) {
      this.symbols[ref.InnerIndex].UseCountEstimate--;
      // Go 还会回滚 part.SymbolUses 的计数；TS 侧是单 part 且不维护 SymbolUses
      // （见 `recordUsage` 的同款注释），故此处无对应动作。
    }

    // Don't roll back the "tsUseCounts" increment —— TS 侧未落 tsUseCounts（batch K 时随 TS 通道补）
  }

  /** Go: func (p *parser) ignoreUsageOfIdentifierInDotChain(expr js_ast.Expr) (js_parser.go:1769) */
  ignoreUsageOfIdentifierInDotChain(expr: js_ast.Expr): void {
    for (;;) {
      const data = expr.Data;
      if (data instanceof js_ast.EIdentifier) {
        this.ignoreUsage(data.Ref);
      } else if (data instanceof js_ast.EDot) {
        expr = data.Target;
        continue;
      } else if (data instanceof js_ast.EIndex) {
        if (data.Index.Data instanceof js_ast.EString) {
          expr = data.Target;
          continue;
        }
      }
      return;
    }
  }

  /**
   * Go: func (p *parser) parseExprOrLetOrUsingStmt(opts parseStmtOpts) (Expr, Stmt, []Decl)
   *     (js_parser.go:5019)。第 113 轮从 parseStmt 的 TIdentifier 分支抽出为独立方法
   * （正常 Parse 路径调用）：using / await using / await / async / let 语句识别与降级。
   * 返回非 null 表示已产出语句；null 表示回落到普通表达式语句（含标签）路径。
   */
  parseExprOrLetOrUsingStmt(loc: Loc, opts: parseStmtOpts): js_ast.Stmt | null {
    const rawText = bytesToString(this.lexer.Raw());
        // Go: js_parser.go:5067 —— "using x = y" / "await using x = y"
        if (rawText === "using") {
          const usingName = this.lexer.Identifier;
          const usingLoc = this.lexer.Loc();
          this.lexer.Next();
          const stmt = this.maybeParseUsingDecl(usingLoc, opts, false);
          if (stmt !== null) return stmt;

          // 不是声明时按普通标识符表达式处理（Go: parseExprOrLetOrUsingStmt 末尾）
          let expr = new js_ast.Expr(new js_ast.EIdentifier(this.resolveName(bytesToString(usingName.String), usingLoc)), usingLoc);
          expr = this.parseSuffix(expr, js_ast.L.LLowest, exprFlag.exprFlagNone);
          this.lexer.ExpectOrInsertSemicolon();
          return new js_ast.Stmt(init(new js_ast.SExpr(), { Value: expr }), loc);
        }

        if (rawText === "await") {
          // Go: 非 async 函数体里 await 是普通标识符（await: allowIdent）
          if (this.awaitIsIdentifier) {
            return null;
          }
          const awaitLoc = this.lexer.Loc();
          this.lexer.Next();

          // Go: js_parser.go:5084 —— "await using"（注意 "await using" 中间不能有换行）
          if (this.tokenIs(T.TIdentifier) && bytesToString(this.lexer.Raw()) === "using") {
            const usingName = this.lexer.Identifier;
            const usingLoc = this.lexer.Loc();
            this.lexer.Next();
            const stmt = this.maybeParseUsingDecl(awaitLoc, opts, true);
            if (stmt !== null) return stmt;

            let value = new js_ast.Expr(new js_ast.EIdentifier(this.resolveName(bytesToString(usingName.String), usingLoc)), usingLoc);
            if (this.tokenIs(T.TAsteriskAsterisk)) this.lexer.Unexpected();
            value = this.parseSuffix(value, js_ast.L.LPrefix, exprFlag.exprFlagNone);
            let expr = new js_ast.Expr(init(new js_ast.EAwait(), { Value: value }), awaitLoc);
            expr = this.parseSuffix(expr, js_ast.L.LLowest, exprFlag.exprFlagNone);
            this.lexer.ExpectOrInsertSemicolon();
            return new js_ast.Stmt(init(new js_ast.SExpr(), { Value: expr }), loc);
          }

          // 普通 await 表达式（与 parsePrefix 的 await 分支一致）
          const value = this.parseExpr(js_ast.L.LPrefix);
          if (this.tokenIs(T.TAsteriskAsterisk)) this.lexer.Unexpected();
          let expr = new js_ast.Expr(init(new js_ast.EAwait(), { Value: value }), awaitLoc);
          expr = this.parseSuffix(expr, js_ast.L.LLowest, exprFlag.exprFlagNone);
          this.lexer.ExpectOrInsertSemicolon();
          return new js_ast.Stmt(init(new js_ast.SExpr(), { Value: expr }), loc);
        }

        // Go: "async function" 语句（上下文关键字 async，token 仍是 TIdentifier）
        if (rawText === "async") {
          const asyncRange = this.lexer.Range();
          this.lexer.Next();
          if (this.lexer.Token === T.TFunction && !this.lexer.HasNewlineBefore) {
            this.lexer.Next(); // "function"
            return this.parseFnStmt(asyncRange.Loc, opts, true /* isAsync */);
          }
          // 其余情况交给 parseAsyncPrefixExpr（async 箭头函数 / async 标识符）
          let expr = this.parseAsyncPrefixExpr(asyncRange, js_ast.L.LLowest, exprFlag.exprFlagNone);
          expr = this.parseSuffix(expr, js_ast.L.LLowest, exprFlag.exprFlagNone);
          this.lexer.ExpectOrInsertSemicolon();
          return new js_ast.Stmt(init(new js_ast.SExpr(), { Value: expr }), loc);
        }
        // SKELETON: Go 用 willNeedBindingPattern() 前瞻区分 `let` 声明与普通标识符；
        // 骨架只在 `let` 后面紧跟标识符时才当成声明（corpus 覆盖这一形态）。
        if (this.lexer.IsContextualKeyword("let")) {
          // Go: js_parser.go:5048 的 couldBeLet / isLet 判定：换行后不是声明（除非是 `[`）
          const letName = this.lexer.Identifier;
          const letLoc = this.lexer.Loc();
          this.lexer.Next();
          let isLet = false;
          if (this.tokenIs(T.TIdentifier) || this.tokenIs(T.TOpenBracket) ||
            this.tokenIs(T.TOpenBrace)) {
            if (!this.lexer.HasNewlineBefore || this.tokenIs(T.TOpenBracket) || opts.isModuleScope) isLet = true;
          }
          if (isLet) {
            // Go: js_parser.go:5056 —— 单语句上下文里的 "let" 声明要 forbid
            if (opts.lexicalDecl !== 1) this.forbidLexicalDecl(letLoc);
            const decls = this.parseAndDeclareDecls(SymbolKind.SymbolOther, opts);
            this.lexer.ExpectOrInsertSemicolon();
            return new js_ast.Stmt(init(new js_ast.SLocal(), {
              Decls: decls,
              Kind: this.selectLocalKind(js_ast.LocalKind.LocalLet),
              IsExport: opts.isExport,
            }), loc);
          }
          // "let" 作为普通标识符
          let letExpr = new js_ast.Expr(
            new js_ast.EIdentifier(this.resolveName(bytesToString(letName.String), letLoc)), letLoc);
          letExpr = this.parseSuffix(letExpr, js_ast.L.LLowest, exprFlag.exprFlagNone);
          this.lexer.ExpectOrInsertSemicolon();
          return new js_ast.Stmt(init(new js_ast.SExpr(), { Value: letExpr }), loc);
        }
    return null;
  }

  /**
   * Go: func (p *parser) maybeRewritePropertyAccess(loc, assignTarget, isDeleteTarget,
   *     target, name, nameLoc, isCallTarget, isTemplateTag, preferQuotedKey) (js_ast.Expr, bool)
   *     (js_parser.go:12939)。第 113 轮落地「minify 静态属性折叠」与「"foo".length 折叠」两个
   *     在 PassThrough+minify 下可逐字节验证的分支（namespace / ModeBundle 分支 M1 不可达，仍 SKELETON）。
   * 返回非 null 表示替换该属性访问表达式。
   */
  maybeRewritePropertyAccess(loc: Loc, target: js_ast.Expr, name: string, visitIn: exprIn,
                             isCallTarget: boolean, isDeleteTarget: boolean, isTemplateTag: boolean): js_ast.Expr | null {
    const nameBytes = new TextEncoder().encode(name);
    // Attempt to simplify statically-determined object literal property accesses
    if (!isCallTarget && !isTemplateTag && this.options.minifySyntax && visitIn.assignTarget === assignTarget.assignTargetNone) {
      if (target.Data instanceof js_ast.EObject) {
        const object = target.Data;
        let replace: js_ast.Expr | null = null;
        let hasProtoNull = false;
        let isUnsafe = false;
        for (const prop of object.Properties) {
          if (prop.Kind === js_ast.PropertyKind.PropertySpread ||
              js_ast.Has(prop.Flags, js_ast.PropertyFlags.PropertyIsComputed) ||
              js_ast.IsMethodDefinition(prop.Kind)) {
            isUnsafe = true; break;
          }
          const key = prop.Key.Data;
          if (!(key instanceof js_ast.EString)) { isUnsafe = true; break; }
          if (UTF16EqualsString(key.Value, new TextEncoder().encode("__proto__"))) {
            if (prop.ValueOrNil.Data instanceof js_ast.ENull) hasProtoNull = true;
          }
          if (!this.astHelpers.ExprCanBeRemovedIfUnused(prop.ValueOrNil)) { isUnsafe = true; break; }
          if (UTF16EqualsString(key.Value, nameBytes)) replace = prop.ValueOrNil;
        }
        if (!isUnsafe) {
          if (replace !== null && name !== "__proto__") return replace;
          if (hasProtoNull) return new js_ast.Expr(js_ast.ENullShared === null ? null : new js_ast.EUndefined(), target.Loc);
        }
      }
    }
    // Minify "foo".length
    if (this.options.minifySyntax && visitIn.assignTarget === assignTarget.assignTargetNone) {
      const d = target.Data;
      if (d instanceof js_ast.EString && name === "length") {
        return new js_ast.Expr(new js_ast.ENumber(d.Value.length), loc);
      }
      if (d instanceof js_ast.EInlinedEnum && d.Value.Data instanceof js_ast.EString && name === "length") {
        return new js_ast.Expr(new js_ast.ENumber(d.Value.Data.Value.length), loc);
      }
    }
    return null;
  }

  /**
   * Go: func (p *parser) handleIdentifier(loc logger.Loc, e *js_ast.EIdentifier,
   *     opts identifierOpts) js_ast.Expr (js_parser.go:17058)。第 113 轮从 visitExprInOut 的
   * EIdentifier 分支抽出为独立方法（正常 Parse 路径调用）：标识符引用的折叠/替换与捕获。
   * 返回非 null 表示替换该标识符表达式；null 表示保留原标识符。
   * define 替换与 usage 计数属于 visitExprInOut 前置职责，仍留在调用点。
   */
  handleIdentifier(loc: Loc, e: js_ast.EIdentifier): js_ast.Expr | null {
    // Go: js_parser.go:17152 —— enum 成员引用折叠成 "常量 /* 名字 */"。
    if (this.options.ts.Parse) {
      const memberData = this.refToTSNamespaceMemberData.get(e.Ref.InnerIndex);
      if (memberData instanceof js_ast.TSNamespaceMemberEnumNumber) {
        const num = new js_ast.ENumber(); num.Value = memberData.Value;
        return wrapInlinedEnum(new js_ast.Expr(num, loc), this.symbols[e.Ref.InnerIndex].OriginalName);
      } else if (memberData instanceof js_ast.TSNamespaceMemberEnumString) {
        const str = new js_ast.EString(); str.Value = memberData.Value;
        return wrapInlinedEnum(new js_ast.Expr(str, loc), this.symbols[e.Ref.InnerIndex].OriginalName);
      } else if (memberData instanceof js_ast.TSNamespaceMemberNamespace) {
        this.tsNamespaceTarget = e;
        this.tsNamespaceMemberData = memberData;
      }
    }
    // Go: js_parser.go:17166 —— namespace 内导出引用替换成对 arg 对象的属性访问。
    if (this.options.ts.Parse) {
      const nsRef = this.isExportedInsideNamespace.get(e.Ref.InnerIndex);
      if (nsRef !== undefined) {
        const name = this.symbols[e.Ref.InnerIndex].OriginalName;
        const nsRefObj = new Ref(e.Ref.SourceIndex, nsRef);
        this.recordUsage(nsRefObj);
        const target = new js_ast.Expr(new js_ast.EIdentifier(nsRefObj), loc);
        const prop = this.dotOrMangledPropVisit(target, name, loc);
        return new js_ast.Expr(prop, loc);
      }
    }
    // Go: js_parser.go:17070 —— 捕获 await 降级箭头里的 arguments
    if (this.argumentsRef.InnerIndex !== InvalidRef.InnerIndex && e.Ref.InnerIndex === this.argumentsRef.InnerIndex &&
        this.isInsideAsyncArrowFn && HasFeature(this.options.unsupportedJSFeatures, JSFeature.AsyncAwait)) {
      return mkExpr(new js_ast.EIdentifier(captureArguments(this)), loc);
    }
    return null;
  }

  /**
   * Go: func (v *binaryExprVisitor) checkAndPrepare(p *parser) js_ast.Expr
   *     (js_parser.go:16030) —— binary visit 的前置检查。第 113 轮从 visitExprInOut 抽出为
   * 独立方法（正常 Parse 路径调用）：处理 "#field in obj" 的私有品牌检查降级。
   * 返回非 null 表示表达式已被完全处理（调用方直接返回），null 表示继续访问左右操作数。
   * Go 用堆栈实现（防 WASM 栈溢出），TS 用递归；此处只抽语义等价的前置检查部分。
   */
  checkAndPrepare(e: js_ast.EBinary, loc: Loc): js_ast.Expr | null {
    if (e.Op === js_ast.OpCode.BinOpIn && e.Left.Data instanceof js_ast.EPrivateIdentifier) {
      const privateIdent = e.Left.Data;
      if (privateSymbolNeedsToBeLowered(this, privateIdent)) {
        e.Right = this.visitExpr(e.Right);
        return lowerPrivateBrandCheck(this, e.Right, loc, privateIdent);
      }
    }
    return null;
  }

  /**
   * Go: func (v *binaryExprVisitor) visitRightAndFinish(p *parser) js_ast.Expr
   *     (js_parser.go:16067) —— 右操作数已访问后的相等诊断 / minify 重写 / target 降级。
   * 第 113 轮从 visitExprInOut 的 EBinary 尾部抽出为独立方法（正常 Parse 路径调用），
   * 并补齐 Go 的两处 minify 重写：相等比较常量统一放右侧、"x == void 0" => "x == null"。
   * 返回非 null 表示替换整个表达式；null 表示保留原 EBinary。
   */
  visitRightAndFinish(e: js_ast.EBinary, loc: Loc): js_ast.Expr | null {
    // Go js_parser.go:16140 —— 相等比较时常量统一放右侧（有利于 gzip 压缩）
    if (this.options.minifySyntax) {
      switch (e.Op) {
        case js_ast.OpCode.BinOpLooseEq:
        case js_ast.OpCode.BinOpLooseNe:
        case js_ast.OpCode.BinOpStrictEq:
        case js_ast.OpCode.BinOpStrictNe:
          if (js_ast_helpers.IsPrimitiveLiteral(e.Left.Data) && !js_ast_helpers.IsPrimitiveLiteral(e.Right.Data)) {
            const t = e.Left; e.Left = e.Right; e.Right = t;
          }
          break;
      }
    }

    const afterOpLoc = locAfterOp(e);
    switch (e.Op) {
      case js_ast.OpCode.BinOpLooseEq: {
        const [ev, eok] = js_ast_helpers.CheckEqualityIfNoSideEffects(e.Left.Data, e.Right.Data, js_ast_helpers.LooseEquality);
        if (eok) return new js_ast.Expr(new js_ast.EBoolean(ev), loc);
        if (!this.warnAboutEqualityCheck("==", e.Left, afterOpLoc)) this.warnAboutEqualityCheck("==", e.Right, afterOpLoc);
        this.warnAboutTypeofAndString(e.Left, e.Right, checkBothOrders);
        if (this.options.minifySyntax) {
          if (e.Left.Data instanceof js_ast.EUndefined) e.Left.Data = js_ast.ENullShared;
          else if (e.Right.Data instanceof js_ast.EUndefined) e.Right.Data = js_ast.ENullShared;
          const [res, ok] = js_ast_helpers.MaybeSimplifyEqualityComparison(loc, e, this.options.unsupportedJSFeatures);
          if (ok) return res;
        }
        break;
      }
      case js_ast.OpCode.BinOpStrictEq: {
        const [ev, eok] = js_ast_helpers.CheckEqualityIfNoSideEffects(e.Left.Data, e.Right.Data, js_ast_helpers.StrictEquality);
        if (eok) return new js_ast.Expr(new js_ast.EBoolean(ev), loc);
        if (!this.warnAboutEqualityCheck("===", e.Left, afterOpLoc)) this.warnAboutEqualityCheck("===", e.Right, afterOpLoc);
        this.warnAboutTypeofAndString(e.Left, e.Right, checkBothOrders);
        if (this.options.minifySyntax) {
          if (js_ast_helpers.CanChangeStrictToLoose(e.Left, e.Right)) e.Op = js_ast.OpCode.BinOpLooseEq;
          const [res, ok] = js_ast_helpers.MaybeSimplifyEqualityComparison(loc, e, this.options.unsupportedJSFeatures);
          if (ok) return res;
        }
        break;
      }
      case js_ast.OpCode.BinOpLooseNe: {
        const [ev, eok] = js_ast_helpers.CheckEqualityIfNoSideEffects(e.Left.Data, e.Right.Data, js_ast_helpers.LooseEquality);
        if (eok) return new js_ast.Expr(new js_ast.EBoolean(!ev), loc);
        if (!this.warnAboutEqualityCheck("!=", e.Left, afterOpLoc)) this.warnAboutEqualityCheck("!=", e.Right, afterOpLoc);
        this.warnAboutTypeofAndString(e.Left, e.Right, checkBothOrders);
        if (this.options.minifySyntax) {
          if (e.Left.Data instanceof js_ast.EUndefined) e.Left.Data = js_ast.ENullShared;
          else if (e.Right.Data instanceof js_ast.EUndefined) e.Right.Data = js_ast.ENullShared;
          const [res, ok] = js_ast_helpers.MaybeSimplifyEqualityComparison(loc, e, this.options.unsupportedJSFeatures);
          if (ok) return res;
        }
        break;
      }
      case js_ast.OpCode.BinOpStrictNe: {
        const [ev, eok] = js_ast_helpers.CheckEqualityIfNoSideEffects(e.Left.Data, e.Right.Data, js_ast_helpers.StrictEquality);
        if (eok) return new js_ast.Expr(new js_ast.EBoolean(!ev), loc);
        if (!this.warnAboutEqualityCheck("!==", e.Left, afterOpLoc)) this.warnAboutEqualityCheck("!==", e.Right, afterOpLoc);
        this.warnAboutTypeofAndString(e.Left, e.Right, checkBothOrders);
        if (this.options.minifySyntax) {
          if (js_ast_helpers.CanChangeStrictToLoose(e.Left, e.Right)) e.Op = js_ast.OpCode.BinOpLooseNe;
          const [res, ok] = js_ast_helpers.MaybeSimplifyEqualityComparison(loc, e, this.options.unsupportedJSFeatures);
          if (ok) return res;
        }
        break;
      }

      // 第 40 轮：target 降级（es2015/16/17 位实测置位）——接 main chain 当轮验字节
      case js_ast.OpCode.BinOpNullishCoalescing:
        if (HasFeature(this.options.unsupportedJSFeatures, JSFeature.NullishCoalescing)) {
          return lowerNullishCoalescing(this, loc, e.Left, e.Right);
        }
        break;
      case js_ast.OpCode.BinOpNullishCoalescingAssign: {
        const [value, ok] = lowerNullishCoalescingAssignmentOperator(this, loc, e);
        if (ok) return value;
        break;
      }
      case js_ast.OpCode.BinOpLogicalAndAssign: {
        const [value, ok] = lowerLogicalAssignmentOperator(this, loc, e, js_ast.OpCode.BinOpLogicalAnd);
        if (ok) return value;
        break;
      }
      case js_ast.OpCode.BinOpLogicalOrAssign: {
        const [value, ok] = lowerLogicalAssignmentOperator(this, loc, e, js_ast.OpCode.BinOpLogicalOr);
        if (ok) return value;
        break;
      }
      case js_ast.OpCode.BinOpPowAssign:
        if (HasFeature(this.options.unsupportedJSFeatures, JSFeature.ExponentOperator)) {
          return lowerExponentiationAssignmentOperator(this, loc, e);
        }
        {
          const result = maybeLowerSetBinOp(this, e.Left, js_ast.OpCode.BinOpPow, e.Right);
          if (result.Data !== null) return result;
        }
        break;
      case js_ast.OpCode.BinOpAddAssign:
      case js_ast.OpCode.BinOpSubAssign:
      case js_ast.OpCode.BinOpMulAssign:
      case js_ast.OpCode.BinOpDivAssign:
      case js_ast.OpCode.BinOpRemAssign:
      case js_ast.OpCode.BinOpShlAssign:
      case js_ast.OpCode.BinOpShrAssign:
      case js_ast.OpCode.BinOpUShrAssign:
      case js_ast.OpCode.BinOpBitwiseOrAssign:
      case js_ast.OpCode.BinOpBitwiseAndAssign:
      case js_ast.OpCode.BinOpBitwiseXorAssign: {
        const BASE: Record<number, js_ast.OpCode> = {
          [js_ast.OpCode.BinOpAddAssign]: js_ast.OpCode.BinOpAdd,
          [js_ast.OpCode.BinOpSubAssign]: js_ast.OpCode.BinOpSub,
          [js_ast.OpCode.BinOpMulAssign]: js_ast.OpCode.BinOpMul,
          [js_ast.OpCode.BinOpDivAssign]: js_ast.OpCode.BinOpDiv,
          [js_ast.OpCode.BinOpRemAssign]: js_ast.OpCode.BinOpRem,
          [js_ast.OpCode.BinOpShlAssign]: js_ast.OpCode.BinOpShl,
          [js_ast.OpCode.BinOpShrAssign]: js_ast.OpCode.BinOpShr,
          [js_ast.OpCode.BinOpUShrAssign]: js_ast.OpCode.BinOpUShr,
          [js_ast.OpCode.BinOpBitwiseOrAssign]: js_ast.OpCode.BinOpBitwiseOr,
          [js_ast.OpCode.BinOpBitwiseAndAssign]: js_ast.OpCode.BinOpBitwiseAnd,
          [js_ast.OpCode.BinOpBitwiseXorAssign]: js_ast.OpCode.BinOpBitwiseXor,
        };
        const result = maybeLowerSetBinOp(this, e.Left, BASE[e.Op], e.Right);
        if (result.Data !== null) return result;
        break;
      }
    }
    return null;
  }

  /** Go: func (p *parser) valueToSubstituteForRequire(loc logger.Loc) js_ast.Expr (js_parser.go:1863) */
  valueToSubstituteForRequire(loc: Loc): js_ast.Expr {
    if (
      this.source.Index !== runtimeSourceIndex && this.options.mode === modeBundle &&
      this.options.outputFormat !== formatCommonJS
    ) {
      return this.importFromRuntime(loc, "__require");
    }

    this.recordUsage(this.requireRef);
    return new js_ast.Expr(init(new js_ast.EIdentifier(), { Ref: this.requireRef }), loc);
  }

  /** Go: func (p *parser) makePromiseRef() ast.Ref (js_parser.go:1873) */
  makePromiseRef(): Ref {
    if (this.promiseRef.Equals(InvalidRef)) {
      this.promiseRef = this.newSymbol(SymbolKind.SymbolUnbound, "Promise");
    }
    return this.promiseRef;
  }

  /** Go: func (p *parser) makeRegExpRef() ast.Ref (js_parser.go:1880) */
  makeRegExpRef(): Ref {
    if (this.regExpRef.Equals(InvalidRef)) {
      this.regExpRef = this.newSymbol(SymbolKind.SymbolUnbound, "RegExp");
      this.moduleScope!.Generated.push(this.regExpRef);
    }
    return this.regExpRef;
  }

  /** Go: func (p *parser) makeBigIntRef() ast.Ref (js_parser.go:1888) */
  makeBigIntRef(): Ref {
    if (this.bigIntRef.Equals(InvalidRef)) {
      this.bigIntRef = this.newSymbol(SymbolKind.SymbolUnbound, "BigInt");
      this.moduleScope!.Generated.push(this.bigIntRef);
    }
    return this.bigIntRef;
  }

  /** Go: func (p *parser) checkForLegacyOctalLiteral(e js_ast.E) (js_parser.go:2108) */
  checkForLegacyOctalLiteral(e: js_ast.E): void {
    if (this.lexer.IsLegacyOctalLiteral) {
      if (this.legacyOctalLiterals === null) {
        this.legacyOctalLiterals = new Map();
      }
      this.legacyOctalLiterals.set(e, this.lexer.Range());
    }
  }

  /** Go: func (p *parser) parseBigIntOrStringIfUnsupported() js_ast.Expr (js_parser.go:2157) */
  parseBigIntOrStringIfUnsupported(): js_ast.Expr {
    if (HasFeature(this.options.unsupportedJSFeatures, JSFeature.Bigint)) {
      // Go: fmt.Sscan(identifier, &i); helpers.StringToUTF16(i.String())
      // big.Int 的 Scan 用 base 0（支持 0x/0o/0b）且输出十进制，与 BigInt(text).toString() 一致。
      const value = BigInt(bytesToString(this.lexer.Identifier.String)).toString();
      return new js_ast.Expr(init(new js_ast.EString(), { Value: utf16FromString(value) }), this.lexer.Loc());
    }
    return new js_ast.Expr(new js_ast.EBigInt(bytesToString(this.lexer.Identifier.String)), this.lexer.Loc());
  }

  /** Go: func (p *parser) generateTempRef(declare generateTempRefArg, optionalName string) ast.Ref (js_parser.go:8624) */
  generateTempRef(declare: number, optionalName: string): Ref {
    let scope = this.currentScope!;

    if (declare !== generateTempRefArg.tempRefNeedsDeclareMayBeCapturedInsideLoop) {
      while (!js_ast.StopsHoisting(scope.Kind)) {
        scope = scope.Parent!;
      }
    }

    if (optionalName === "") {
      optionalName = "_" + DefaultNameMinifierJS.NumberToMinifiedName(this.tempRefCount);
      this.tempRefCount++;
    }
    const ref = this.newSymbol(SymbolKind.SymbolOther, optionalName);

    if (declare === generateTempRefArg.tempRefNeedsDeclareMayBeCapturedInsideLoop && !js_ast.StopsHoisting(scope.Kind)) {
      this.tempLetsToDeclare.push(ref);
    } else if (declare !== generateTempRefArg.tempRefNoDeclare) {
      this.tempRefsToDeclare.push({ ref });
    }

    scope.Generated.push(ref);
    return ref;
  }

  /**
   * Go: compat.SymbolFeature(kind) 后 unsupportedJSFeatures.Has(...)（compat.go:161）。
   * 第 34 轮 J-1：privateSymbolNeedsToBeLowered 用它判 es2015 档私有成员降级。
   * 位值全部由 Go 探针 tmpprobebits 实测（见 compat.ts）。
   */
  symbolNeedsLoweringForTarget(kind: number): boolean {
    let feature = 0n;
    const SK = SymbolKind;
    switch (kind) {
      case SK.SymbolPrivateField: feature = JSFeature.ClassPrivateField; break;
      case SK.SymbolPrivateMethod: feature = JSFeature.ClassPrivateMethod; break;
      case SK.SymbolPrivateGet:
      case SK.SymbolPrivateSet:
      case SK.SymbolPrivateGetSetPair: feature = JSFeature.ClassPrivateAccessor; break;
      case SK.SymbolPrivateStaticField: feature = JSFeature.ClassPrivateStaticField; break;
      case SK.SymbolPrivateStaticMethod: feature = JSFeature.ClassPrivateStaticMethod; break;
      case SK.SymbolPrivateStaticGet:
      case SK.SymbolPrivateStaticSet:
      case SK.SymbolPrivateStaticGetSetPair: feature = JSFeature.ClassPrivateStaticAccessor; break;
      default: return false;
    }
    return HasFeature(this.options.unsupportedJSFeatures, feature);
  }

  /**
   * Go: func (p *parser) captureValueWithPossibleSideEffects(...) (js_parser.go:12029)
   * 第 34 轮 J-1 移植：lowerPrivateSetBinOp / lowerSuperPropertySetBinOp 依赖它。
   * 返回 [生成引用表达式的函数, 包裹最终表达式的函数]。
   */
  captureValueWithPossibleSideEffects(
    loc: Loc, count: number, value: js_ast.Expr, mode: number,
  ): [( () => js_ast.Expr ), ((expr: js_ast.Expr) => js_ast.Expr)] {
    const wrapFunc = (expr: js_ast.Expr): js_ast.Expr => {
      if (expr.Data === null) return value;
      return expr;
    };

    // Referencing certain expressions more than once has no side effects
    let valueFunc: (() => js_ast.Expr) | null = null;
    if (value.Data instanceof js_ast.ENull) {
      valueFunc = () => mkExpr(js_ast.ENullShared, loc);
    } else if (value.Data instanceof js_ast.EUndefined) {
      valueFunc = () => mkExpr(js_ast.EUndefinedShared, loc);
    } else if (value.Data instanceof js_ast.EThis) {
      valueFunc = () => mkExpr(js_ast.EThisShared, loc);
    } else if (value.Data instanceof js_ast.EBoolean) {
      const v = value.Data.Value;
      valueFunc = () => mkExpr(new js_ast.EBoolean(v), loc);
    } else if (value.Data instanceof js_ast.ENumber) {
      const v = value.Data.Value;
      valueFunc = () => mkExpr(new js_ast.ENumber(v), loc);
    } else if (value.Data instanceof js_ast.EBigInt) {
      const v = value.Data.Value;
      valueFunc = () => mkExpr(new js_ast.EBigInt(v), loc);
    } else if (value.Data instanceof js_ast.EString) {
      const v = value.Data.Value;
      valueFunc = () => mkExpr(new js_ast.EString(v), loc);
    } else if (value.Data instanceof js_ast.EPrivateIdentifier) {
      const v = value.Data.Ref;
      valueFunc = () => mkExpr(new js_ast.EPrivateIdentifier(v), loc);
    } else if (value.Data instanceof js_ast.EIdentifier) {
      const v = value.Data.Ref;
      if (mode === 0 /* valueDefinitelyNotMutated */) {
        valueFunc = () => {
          this.recordUsage(v);
          return mkExpr(new js_ast.EIdentifier(v), loc);
        };
      }
    }
    if (valueFunc !== null) return [valueFunc, wrapFunc];

    // We don't need to worry about side effects if the value won't be used multiple times
    if (count < 2) {
      return [() => value, wrapFunc];
    }

    // Otherwise, fall back to generating a temporary reference
    let tempRef: Ref = InvalidRef;
    if (this.currentScope !== null && this.currentScope.Kind === js_ast.ScopeKind.ScopeFunctionArgs) {
      return [
        () => {
          if (tempRef === InvalidRef) {
            tempRef = this.generateTempRef(generateTempRefArg.tempRefNoDeclare, "");
            this.recordUsage(tempRef);
            return js_ast_helpers.Assign(mkExpr(new js_ast.EIdentifier(tempRef), loc), value);
          }
          this.recordUsage(tempRef);
          return mkExpr(new js_ast.EIdentifier(tempRef), loc);
        },
        (expr: js_ast.Expr): js_ast.Expr => {
          if (expr.Data === null) return value;
          const arrow = new js_ast.EArrow();
          const arg = new js_ast.Arg();
          arg.Binding = init(new js_ast.Binding(), { Data: new js_ast.BIdentifier(tempRef), Loc: loc });
          arrow.Args = [arg];
          arrow.PreferExpr = true;
          const fnBody = new js_ast.FnBody();
          const ret = new js_ast.SReturn();
          ret.ValueOrNil = expr;
          fnBody.Block = init(new js_ast.SBlock(), { Stmts: [new js_ast.Stmt(ret, loc)] });
          arrow.Body = fnBody;
          return mkExpr(init(new js_ast.ECall(), { Target: mkExpr(arrow, loc), Args: [] }), loc);
        },
      ];
    }

    return [
      () => {
        if (tempRef === InvalidRef) {
          tempRef = this.generateTempRef(generateTempRefArg.tempRefNeedsDeclare, "");
          this.recordUsage(tempRef);
          return js_ast_helpers.Assign(mkExpr(new js_ast.EIdentifier(tempRef), loc), value);
        }
        this.recordUsage(tempRef);
        return mkExpr(new js_ast.EIdentifier(tempRef), loc);
      },
      wrapFunc,
    ];
  }

  /** Go: func (p *parser) findLabelSymbol(loc logger.Loc, name string) (ref ast.Ref, isLoop bool, ok bool) (js_parser.go:8758) */
  findLabelSymbol(loc: Loc, name: string): { ref: Ref; isLoop: boolean; ok: boolean } {
    for (let s = this.currentScope; s !== null && !js_ast.StopsHoisting(s.Kind); s = s.Parent) {
      if (s.Kind === js_ast.ScopeKind.ScopeLabel && name === this.symbols[s.Label.Ref.InnerIndex].OriginalName) {
        // Track how many times we've referenced this symbol
        this.recordUsage(s.Label.Ref);
        return { ref: s.Label.Ref, isLoop: s.LabelStmtIsLoop, ok: true };
      }
    }

    const r = RangeOfIdentifier(this.source, loc);
    AddError(this.log, this.tracker, r, `There is no containing label named ${goQuoted(name)}`);

    // Allocate an "unbound" symbol
    const ref = this.newSymbol(SymbolKind.SymbolUnbound, name);

    // Track how many times we've referenced this symbol
    this.recordUsage(ref);
    return { ref, isLoop: false, ok: false };
  }

  /**
   * Go: func (p *parser) pushScopeForVisitPass(kind js_ast.ScopeKind, loc logger.Loc) (js_parser.go:8657)
   *
   * Go 在这里还会把 order.scope 追加到 currentPart.Scopes；TS 侧为单 part，故只保留
   * 作用域栈的语义（已登记在 `docs/m1-closeout-plan.md` §2.1 的 F-s1 依赖）。
   */
  pushScopeForVisitPass(kind: js_ast.ScopeKind, loc: Loc): void {
    const order = this.scopesInOrder[0];

    // Sanity-check that the scopes generated by the first and second passes match
    if (order.loc.Start !== loc.Start || order.scope.Kind !== kind) {
      // Go 的 panic 文案还带 PrettyPaths.Select(logPathStyle)；TS 侧 Logger 的路径选择器不在 M1 通道
      throw new Error(
        `Expected scope (${kind}, ${loc.Start}) in source, found scope (${order.scope.Kind}, ${order.loc.Start})`,
      );
    }

    this.scopesInOrder.shift();
    this.currentScope = order.scope;
  }

  // -------------------------------------------------------------------------
  // 第 24 轮：D 批（解析侧补全）与 F-s1a（visit pass 的 SLocal 分支）
  // -------------------------------------------------------------------------

  /** Go: func (p *parser) willNeedBindingPattern() bool (js_parser.go:4137) */
  willNeedBindingPattern(): boolean {
    switch (this.lexer.Token) {
      case T.TEquals:
        // "[a] = b;"
        return true;

      case T.TIn:
        // "for ([a] in b) {}"
        return !this.allowIn;

      case T.TIdentifier:
        // "for ([a] of b) {}"
        return !this.allowIn && this.lexer.IsContextualKeyword("of");

      default:
        return false;
    }
  }

  /**
   * Go: func (p *parser) parseExprOrBindings(level js_ast.L, errors *deferredErrors) js_ast.Expr (js_parser.go:4220)
   * Go: `return p.parseExprCommon(level, errors, 0)`；TS 的 parseExprCommon 还没有 errors 参数（§2.2 单列 #2 的同一处诊断通道）。
   */
  parseExprOrBindings(level: js_ast.L, errors: deferredErrors | null): js_ast.Expr {
    void errors;
    return this.parseExprCommon(level, exprFlag.exprFlagNone);
  }

  /** Go: func (p *parser) parseFnBody(data fnOrArrowDataParse) js_ast.FnBody (js_parser.go:8470) */
  parseFnBody(data: fnOrArrowDataParse): js_ast.FnBody {
    // Go 在这里存 p.fnOrArrowDataParse = data（TS 尚未维护这个字段，await/yield 信息仍走 allowIn/awaitIsIdentifier）
    void data;
    const oldAllowIn = this.allowIn;
    this.allowIn = true;

    const loc = this.lexer.Loc();
    this.pushScopeForParsePass(js_ast.ScopeKind.ScopeFunctionBody, loc);
    try {
      this.lexer.Expect(T.TOpenBrace);
      const opts = new parseStmtOpts();
      opts.allowDirectivePrologue = true;
      const stmts = this.parseStmtsUpTo(T.TCloseBrace, opts);
      const closeBraceLoc = this.lexer.Loc();
      this.lexer.Next();

      this.allowIn = oldAllowIn;
      const body = new js_ast.FnBody();
      body.Loc = loc;
      body.Block = new js_ast.SBlock();
      body.Block.Stmts = stmts;
      body.Block.CloseBraceLoc = closeBraceLoc;
      return body;
    } finally {
      this.popScope();
    }
  }

  /** Go: func (p *parser) isValidAssignmentTarget(expr js_ast.Expr) bool (js_parser.go:13377) */
  isValidAssignmentTarget(expr: js_ast.Expr): boolean {
    const e = expr.Data;
    if (e instanceof js_ast.EIdentifier) {
      // Go: strict 模式下 eval/arguments 不能当赋值目标 —— 依赖 isStrictMode()（§2.2 单列 #2）
      return true;
    }
    if (e instanceof js_ast.EDot || e instanceof js_ast.EIndex) {
      return e.OptionalChain === js_ast.OptionalChain.OptionalChainNone;
    }

    // Don't worry about recursive checking for objects and arrays. This will
    // already be handled naturally by passing down the assign target flag.
    if (e instanceof js_ast.EObject || e instanceof js_ast.EArray) {
      return !e.IsParenthesized;
    }
    return false;
  }

  /** Go: func (p *parser) visitExpr(expr js_ast.Expr) js_ast.Expr (js_parser.go:13277) */
  visitExpr(expr: js_ast.Expr): js_ast.Expr {
    return this.visitExprInOut(expr, new exprIn(), new exprOut());
  }

  /**
   * Go: func (p *parser) visitExprInOut(expr js_ast.Expr, in exprIn) (js_ast.Expr, exprOut) (js_parser.go:13552)
   *
   * 第 24 轮只落 **E-s1 的字面量分支**（ENull/ESuper/EBoolean/EUndefined/EJSXText/EBigInt/EString/ENumber）；
   * 其余 Expr 种类原样返回。EIdentifier/EThis/EImportMeta 与 ERegExp/ETemplate 分属 E-s1b/E-s1c/E-s2（见 §2.1）。
   * 需要 strict-mode 闭包的两个诊断（legacy octal escape/literal）按 §2.2 单列 #2 留口。
   */
  visitExprInOut(expr: js_ast.Expr, visitIn: exprIn, out: exprOut = new exprOut()): js_ast.Expr {
    if (visitIn.assignTarget !== assignTarget.assignTargetNone && !this.isValidAssignmentTarget(expr)) {
      AddError(this.log, this.tracker, new Range(expr.Loc, 0), "Invalid assignment target");
    }

    const e = expr.Data;
    if (
      e instanceof js_ast.ENull || e instanceof js_ast.ESuper || e instanceof js_ast.EBoolean ||
      e instanceof js_ast.EUndefined || e instanceof js_ast.EJSXText
    ) {
      // 无需处理（Go: 空分支）
    } else if (e instanceof js_ast.EBigInt) {
      if (HasFeature(this.options.unsupportedJSFeatures, JSFeature.Bigint)) {
        // Go 还会 p.markSyntaxFeature(compat.Bigint, ...)（I 批未落），这里保留 BigInt 符号的使用
        this.recordUsage(this.makeBigIntRef());
      }
    } else if (e instanceof js_ast.ERegExp) {
      // "/pattern/flags" => "new RegExp('pattern', 'flags')"
      const [pattern, flags, isUnsupported] = this.isUnsupportedRegularExpression(expr.Loc, e.Value);
      if (isUnsupported) {
        const args: js_ast.Expr[] = [
          new js_ast.Expr(new js_ast.EString(utf16FromString(pattern)), new Loc(expr.Loc.Start + 1)),
        ];
        if (flags !== "") {
          args.push(new js_ast.Expr(
            new js_ast.EString(utf16FromString(flags)),
            new Loc(expr.Loc.Start + new TextEncoder().encode(pattern).length + 2),
          ));
        }
        const regExpRef = this.makeRegExpRef();
        this.recordUsage(regExpRef);
        return new js_ast.Expr(init(new js_ast.ENew(), {
          Target: new js_ast.Expr(new js_ast.EIdentifier(regExpRef), expr.Loc),
          Args: args,
          CloseParenLoc: new Loc(expr.Loc.Start + new TextEncoder().encode(e.Value).length),
        }), expr.Loc);
      }
    } else if (e instanceof js_ast.EString) {
      // Go: LegacyOctalLoc > 0 时按 strict 模式报 legacyOctalEscape（strict 闭包未落，§2.2 #2）
    } else if (e instanceof js_ast.ENumber) {
      // Go: legacyOctalLiterals != nil && isStrictMode() 时报 legacyOctalLiteral（同上）
    } else if (e instanceof js_ast.EIdentifier) {
      // Go: js_parser.go:14287 —— EIdentifier 的 define/inject 检查（在记录 usage 之前）
      const defined = this.trySubstituteDefine(expr, visitIn);
      if (defined !== null) return defined;
      // Go: visitExprInOut 的 EIdentifier 分支记录使用计数（import-equals DCE 依赖）
      if (!this.isControlFlowDead) this.symbols[e.Ref.InnerIndex].UseCountEstimate++;
      const hi = this.handleIdentifier(expr.Loc, e);
      if (hi !== null) return hi;
    } else if (e instanceof js_ast.EThis) {
      // Go: case *js_ast.EThis（js_parser.go:13632）
      this.hasThisUsage = true;
      const value = this.valueForThis(expr.Loc, true, visitIn.assignTarget, false, false);
      if (value !== null) return value;
      // Go: js_parser.go:13645 —— 降级箭头里的 this 捕获
      if (this.fnOrArrowDataVisit.isArrow && HasFeature(this.options.unsupportedJSFeatures, JSFeature.Arrow) && this.isThisNested) {
        return mkExpr(new js_ast.EIdentifier(captureThis(this)), expr.Loc);
      }
    } else if (e instanceof js_ast.EImportMeta) {
      // Go: case *js_ast.EImportMeta（js_parser.go:13648）；define 检查（第 44 轮）+ 已知全局
      const defined = this.trySubstituteDefine(expr, visitIn);
      if (defined !== null) return defined;
      const value = this.valueForImportMeta(expr.Loc);
      if (value !== null) return value;
    } else if (e instanceof js_ast.EFunction) {
      // Go: visitFn 的 scopeLoc 是 expr.Loc（js_parser.go:15929）
      this.visitFn(e.Fn, expr.Loc);
      // Go: minify 的匿名函数名消除、keepNames —— M1 默认不触发
    } else if (e instanceof js_ast.EArrow) {
      this.visitArrow(e, expr.Loc);
    } else if (e instanceof js_ast.EClass) {
      // Go: js_parser.go:15949-15956 —— visitClass + lowerClass（类表达式）
      let nameToKeep = "";
      if (this.nameToKeepIsFor === e) nameToKeep = this.nameToKeep;
      const result = this.visitClass(expr.Loc, e.Class, InvalidRef);
      const [, loweredExpr0] = lowerClass(this, new js_ast.Stmt(), expr, result, nameToKeep);
      let loweredExpr = loweredExpr0;
      if (result.canBeRemovedIfUnused) {
        const ann = init(new js_ast.EAnnotation(), { Value: loweredExpr, Flags: js_ast.AnnotationFlags.CanBeRemovedIfUnusedFlag });
        loweredExpr = new js_ast.Expr(ann, loweredExpr.Loc);
      }
      return loweredExpr;
    } else if (e instanceof js_ast.EArray) {
      // Go: case *js_ast.EArray（js_parser.go:14837）的 visit 骨架
      for (let i = 0; i < e.Items.length; i++) e.Items[i] = this.visitExpr(e.Items[i]);
    } else if (e instanceof js_ast.EObject) {
      // Go: case *js_ast.EObject（js_parser.go:14897）的 visit 骨架
      for (const property of e.Properties) {
        if ((property.Flags & js_ast.PropertyFlags.PropertyIsComputed) !== 0) {
          property.Key = this.visitExprInOut(property.Key, init(new exprIn(), { shouldMangleStringsAsProps: true }));
        } else {
          property.Key = this.visitExpr(property.Key);
        }
        if (property.ValueOrNil !== null) property.ValueOrNil = this.visitExpr(property.ValueOrNil);
        if (property.InitializerOrNil !== null) property.InitializerOrNil = this.visitExpr(property.InitializerOrNil);
      }
      // Go: js_parser.go:15013 —— "{a, ...b}" => "__spreadValues({a}, b)"（target < es2018）
      if (visitIn.assignTarget === assignTarget.assignTargetNone) {
        return lowerObjectSpread(this, expr.Loc, e);
      }
    } else if (e instanceof js_ast.EBinary) {
      // Go: visitExprInOut 的 EBinary 分支（js_parser.go:16416 起）——private/super 赋值降级
      const cp = this.checkAndPrepare(e, expr.Loc);
      if (cp !== null) return cp;
      if (e.Op === js_ast.OpCode.BinOpAssign) {
        const pi = extractPrivateIndex(this, e.Left);
        if (pi !== null) {
          // "foo.#bar = v" => "__privateSet(foo, #bar, v)"（js_parser.go:16417）
          const v = this.visitExpr(e.Right);
          return lowerPrivateSet(this, pi.target, pi.loc, pi.private, v);
        }
        const sp = extractSuperProperty(this, e.Left);
        if (sp !== null) {
          // "super.foo = v" => "__superSet(Class, this, 'foo', v)"（js_parser.go:16421）
          const v = this.visitExpr(e.Right);
          return lowerSuperPropertySet(this, e.Left.Loc, sp, v);
        }
        // Go: js_parser.go:16429 —— 对象 rest 赋值降级（"({...x} = y)"）
        if (visitIn.assignTarget === assignTarget.assignTargetNone) {
          const mode = (e as js_ast.E) === this.stmtExprValue ? objRestMode.objRestReturnValueIsUnused : objRestMode.objRestMustReturnInitExpr;
          const [result, ok] = lowerAssign(this, e.Left, e.Right, mode);
          if (ok) return result;
        }
      }
      e.Left = this.visitExpr(e.Left);
      e.Right = this.visitExpr(e.Right);

      const vr = this.visitRightAndFinish(e, expr.Loc);
      if (vr !== null) return vr;
    } else if (e instanceof js_ast.EUnary) {
      // Go: visitExprInOut 的 EUnary 分支（js_parser.go:14731）——private/super ++/-- 降级
      const isIncDec = e.Op === js_ast.OpCode.UnOpPreDec || e.Op === js_ast.OpCode.UnOpPreInc ||
        e.Op === js_ast.OpCode.UnOpPostDec || e.Op === js_ast.OpCode.UnOpPostInc;
      if (isIncDec) {
        const pi = extractPrivateIndex(this, e.Value);
        if (pi !== null) return lowerPrivateSetUnOp(this, pi.target, pi.loc, pi.private, e.Op);
        const sp = extractSuperProperty(this, e.Value);
        if (sp !== null) e.Value = callSuperPropertyWrapper(this, expr.Loc, sp);
      }
      if (e.Op === js_ast.OpCode.UnOpDelete) {
        this.deleteTarget = e.Value.Data; // Go: p.deleteTarget = e.Value.Data
        // Go: js_parser.go:14663 —— delete 可选链：子链作为链尾，捕获 childOut
        const childOut = new exprOut();
        e.Value = this.visitExprInOut(e.Value, init(new exprIn(), { hasChainParent: true }), childOut);
        if (childOut.childContainsOptionalChain) {
          return lowerOptionalChain(this, expr, visitIn, childOut, out);
        }
      } else {
        e.Value = this.visitExpr(e.Value);
      }
    } else if (e instanceof js_ast.EIf) {
      e.Test = this.visitExpr(e.Test);
      e.Yes = this.visitExpr(e.Yes);
      e.No = this.visitExpr(e.No);
    } else if (e instanceof js_ast.ECall) {
      this.callTarget = e.Target.Data; // Go: p.callTarget = e.Target.Data
      const e2 = e.Target.Data;
      let isParenthesizedOptionalChain = false;
      if (e2 instanceof js_ast.EDot || e2 instanceof js_ast.EIndex) {
        isParenthesizedOptionalChain = e.OptionalChain === js_ast.OptionalChain.OptionalChainNone &&
          e2.OptionalChain !== js_ast.OptionalChain.OptionalChainNone;
      }
      const childOut = new exprOut();
      e.Target = this.visitExprInOut(e.Target, init(new exprIn(), {
        hasChainParent: e.OptionalChain === js_ast.OptionalChain.OptionalChainContinue,
        storeThisArgForParentOptionalChain: e.OptionalChain === js_ast.OptionalChain.OptionalChainStart || isParenthesizedOptionalChain,
      }), childOut);
      for (let i = 0; i < e.Args.length; i++) e.Args[i] = this.visitExpr(e.Args[i]);

      // Go: js_parser.go:15321 —— Our hack for reading Yarn PnP files is implemented here
      // 三种形态：hydrateRuntimeState({...}) / (JSON.parse("<json>")) / (JSON.parse(X))。
      if (this.options.decodeHydrateRuntimeStateYarnPnP) {
        const targetId = e.Target.Data instanceof js_ast.EIdentifier ? e.Target.Data : null;
        if (targetId !== null &&
            this.symbols[targetId.Ref.InnerIndex].OriginalName === "hydrateRuntimeState" &&
            e.Args.length >= 1) {
          const arg0 = e.Args[0];
          if (arg0.Data instanceof js_ast.EObject) {
            // "hydrateRuntimeState(<object literal>)"
            if (isValidJSON(arg0)) this.manifestForYarnPnP = arg0;
          } else if (arg0.Data instanceof js_ast.ECall) {
            // "hydrateRuntimeState(JSON.parse(<something>))"
            const call = arg0.Data;
            if (call.Args.length === 1) {
              const dot = call.Target.Data instanceof js_ast.EDot ? call.Target.Data : null;
              if (dot !== null && dot.Name === "parse") {
                const dotTarget = dot.Target.Data instanceof js_ast.EIdentifier ? dot.Target.Data : null;
                if (dotTarget !== null) {
                  const sym = this.symbols[dotTarget.Ref.InnerIndex];
                  if (sym.Kind === ast.SymbolKind.SymbolUnbound && sym.OriginalName === "JSON") {
                    const inner = call.Args[0];
                    if (inner.Data instanceof js_ast.EString) {
                      const source = new Source();
                      source.KeyPath = this.source.KeyPath;
                      source.Contents = UTF16ToString(inner.Data.Value);
                      const table = GenerateStringInJSTable(this.source.Contents, inner.Loc, source.Contents);
                      const log = NewStringInJSLog(this.log, this.tracker, table);
                      this.manifestForYarnPnP = ParseJSON(log, source, new JSONOptions()).expr;
                      remapExprLocsInJSON(this.manifestForYarnPnP, table);
                    } else if (inner.Data instanceof js_ast.EIdentifier) {
                      const local = this.stringLocalsForYarnPnP?.get(inner.Data.Ref.InnerIndex);
                      if (local !== undefined) {
                        const source = new Source();
                        source.KeyPath = this.source.KeyPath;
                        source.Contents = UTF16ToString(local.value);
                        const table = GenerateStringInJSTable(this.source.Contents, local.loc, source.Contents);
                        const log = NewStringInJSLog(this.log, this.tracker, table);
                        this.manifestForYarnPnP = ParseJSON(log, source, new JSONOptions()).expr;
                        remapExprLocsInJSON(this.manifestForYarnPnP, table);
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }

      // Go: js_parser.go:15730 —— "super.foo(a)" => "__superGet(...).call(this, a)"
      maybeLowerSuperPropertyGetInsideCall(this, e);
      // Go: js_parser.go:15702 —— 括号包裹的可选链
      if (isParenthesizedOptionalChain && childOut.thisArgFunc !== null && childOut.thisArgWrapFunc !== null) {
        return lowerParenthesizedOptionalChain(this, expr.Loc, e, childOut);
      }
      const containsOptionalChain = e.OptionalChain === js_ast.OptionalChain.OptionalChainStart ||
        (e.OptionalChain === js_ast.OptionalChain.OptionalChainContinue && childOut.childContainsOptionalChain);
      if (containsOptionalChain && !visitIn.hasChainParent) {
        return lowerOptionalChain(this, expr, visitIn, childOut, out);
      }
      out.childContainsOptionalChain = containsOptionalChain;
      out.thisArgFunc = childOut.thisArgFunc;
      out.thisArgWrapFunc = childOut.thisArgWrapFunc;
      if (!visitIn.hasChainParent) { out.thisArgFunc = null; out.thisArgWrapFunc = null; }
    } else if (e instanceof js_ast.ENew) {
      e.Target = this.visitExpr(e.Target);
      for (let i = 0; i < e.Args.length; i++) e.Args[i] = this.visitExpr(e.Args[i]);
    } else if (e instanceof js_ast.EDot) {
      // Go: js_parser.go:14287 —— EDot 的 define/inject 检查（在 visit target 之前 peek 整链）
      const defined = this.trySubstituteDefine(expr, visitIn);
      if (defined !== null) return defined;
      const childOut = new exprOut();
      e.Target = this.visitExprInOut(e.Target, init(new exprIn(), {
        hasChainParent: e.OptionalChain === js_ast.OptionalChain.OptionalChainContinue,
      }), childOut);
      // Go: js_parser.go:13094 —— namespace/enum 成员常量折叠（E.A => 1 /* A */）。
      if (this.options.ts.Parse && e.Target.Data === this.tsNamespaceTarget &&
        this.tsNamespaceMemberData instanceof js_ast.TSNamespaceMemberNamespace) {
        const member = this.tsNamespaceMemberData.ExportedMembers.get(e.Name);
        if (member && member.Data instanceof js_ast.TSNamespaceMemberEnumNumber) {
          const num = new js_ast.ENumber(); num.Value = member.Data.Value;
          return wrapInlinedEnum(new js_ast.Expr(num, expr.Loc), e.Name);
        } else if (member && member.Data instanceof js_ast.TSNamespaceMemberEnumString) {
          const str = new js_ast.EString(); str.Value = member.Data.Value;
          return wrapInlinedEnum(new js_ast.Expr(str, expr.Loc), e.Name);
        }
      }
      // Go: js_parser.go:14356 —— "super.foo" => "__superGet('foo')"
      if (
        e.OptionalChain === js_ast.OptionalChain.OptionalChainNone &&
        visitIn.assignTarget === assignTarget.assignTargetNone &&
        shouldLowerSuperPropertyAccess(this, e.Target)
      ) {
        const key = new js_ast.Expr(new js_ast.EString(utf16FromString(e.Name)), e.NameLoc);
        return lowerSuperPropertyGet(this, expr.Loc, key);
      }
      const containsOptionalChain = e.OptionalChain === js_ast.OptionalChain.OptionalChainStart ||
        (e.OptionalChain === js_ast.OptionalChain.OptionalChainContinue && childOut.childContainsOptionalChain);
      if (containsOptionalChain && !visitIn.hasChainParent) {
        return lowerOptionalChain(this, expr, visitIn, childOut, out);
      }
      out.childContainsOptionalChain = containsOptionalChain;
      out.thisArgFunc = childOut.thisArgFunc;
      out.thisArgWrapFunc = childOut.thisArgWrapFunc;
      if (!visitIn.hasChainParent) { out.thisArgFunc = null; out.thisArgWrapFunc = null; }
      // Go: js_parser.go:14404 —— EDot 属性访问重写（minify 常量折叠 / "foo".length）
      if (e.OptionalChain === js_ast.OptionalChain.OptionalChainNone) {
        const rw = this.maybeRewritePropertyAccess(expr.Loc, e.Target, e.Name, visitIn,
          e === this.callTarget, e === this.deleteTarget, e === this.templateTag);
        if (rw !== null) return rw;
      }
    } else if (e instanceof js_ast.EIndex) {
      // Go: js_parser.go:14310 —— EIndex 的 define/inject 检查（在 visit target 之前 peek 整链）
      const defined = this.trySubstituteDefine(expr, visitIn);
      if (defined !== null) return defined;
      const childOut = new exprOut();
      e.Target = this.visitExprInOut(e.Target, init(new exprIn(), {
        hasChainParent: e.OptionalChain === js_ast.OptionalChain.OptionalChainContinue,
      }), childOut);
      // Go: js_parser.go:14518 —— "foo.#bar" => "__privateGet(foo, #bar)"
      const pi = extractPrivateIndex(this, expr);
      if (
        pi !== null &&
        visitIn.assignTarget === assignTarget.assignTargetNone &&
        e.OptionalChain === js_ast.OptionalChain.OptionalChainNone
      ) {
        return lowerPrivateGet(this, pi.target, pi.loc, pi.private);
      }
      e.Index = this.visitExpr(e.Index);
      // Go: js_parser.go:14530 —— "super[foo]" => "__superGet(foo)"
      if (
        e.OptionalChain === js_ast.OptionalChain.OptionalChainNone &&
        visitIn.assignTarget === assignTarget.assignTargetNone &&
        shouldLowerSuperPropertyAccess(this, e.Target)
      ) {
        return lowerSuperPropertyGet(this, expr.Loc, e.Index);
      }
      const containsOptionalChain = e.OptionalChain === js_ast.OptionalChain.OptionalChainStart ||
        (e.OptionalChain === js_ast.OptionalChain.OptionalChainContinue && childOut.childContainsOptionalChain);
      if (containsOptionalChain && !visitIn.hasChainParent) {
        return lowerOptionalChain(this, expr, visitIn, childOut, out);
      }
      out.childContainsOptionalChain = containsOptionalChain;
      out.thisArgFunc = childOut.thisArgFunc;
      out.thisArgWrapFunc = childOut.thisArgWrapFunc;
      if (!visitIn.hasChainParent) { out.thisArgFunc = null; out.thisArgWrapFunc = null; }
    } else if (e instanceof js_ast.ESpread) {
      e.Value = this.visitExpr(e.Value);
    } else if (e instanceof js_ast.ETemplate) {
      if (e.TagOrNil !== null) this.templateTag = e.TagOrNil.Data; // Go: p.templateTag = e.TagOrNil.Data
      if (e.TagOrNil !== null) e.TagOrNil = this.visitExpr(e.TagOrNil);
      for (const part of e.Parts) part.Value = this.visitExpr(part.Value);
    } else if (e instanceof js_ast.EAwait) {
      e.Value = this.visitExpr(e.Value);
      // Go: js_parser.go:14825 —— await 降级为 yield（async 函数/generator）
      return maybeLowerAwait(this, expr.Loc, e);
    } else if (e instanceof js_ast.EYield) {
      if (e.ValueOrNil !== null) e.ValueOrNil = this.visitExpr(e.ValueOrNil);
    } else if (e instanceof js_ast.EAnnotation) {
      e.Value = this.visitExpr(e.Value);
    } else if (e instanceof js_ast.EInlinedEnum) {
      e.Value = this.visitExpr(e.Value);
    } else if (e instanceof js_ast.EJSXElement) {
      if (e.TagOrNil !== null) e.TagOrNil = this.visitExpr(e.TagOrNil);
      for (const property of e.Properties) {
        if ((property.Flags & js_ast.PropertyFlags.PropertyIsComputed) !== 0) {
          property.Key = this.visitExprInOut(property.Key, init(new exprIn(), { shouldMangleStringsAsProps: true }));
        }
        if (property.ValueOrNil !== null) property.ValueOrNil = this.visitExpr(property.ValueOrNil);
      }
      for (let i = 0; i < e.NullableChildren.length; i++) {
        e.NullableChildren[i] = this.visitExpr(e.NullableChildren[i]);
      }
    }

    return expr;
  }

  /** Go: func (p *parser) visitBinding(binding js_ast.Binding, opts bindingOpts) (js_parser.go:10083) */
  visitBinding(binding: js_ast.Binding, opts: bindingOpts): void {
    const b = binding.Data;
    if (b instanceof js_ast.BMissing) {
      // 空
    } else if (b instanceof js_ast.BIdentifier) {
      // Go: p.recordDeclaredSymbol(b.Ref) —— TS 在 parse 期（declareSymbol 的调用点）已经记录过一次，
      // visit 期再记会让 declaredSymbols 出现重复项；等价性以 Print 字节为准（见 §2.1 F-s1a 偏差注）
      const name = this.symbols[b.Ref.InnerIndex].OriginalName;
      // Go: p.validateDeclaredSymbolName(binding.Loc, name) —— 依赖 strict-mode 闭包（§2.2 单列 #2）
      if (opts.duplicateArgCheck !== null) {
        const r = RangeOfIdentifier(this.source, binding.Loc);
        const firstRange = opts.duplicateArgCheck.get(name);
        if (firstRange !== undefined && firstRange.Len > 0) {
          AddErrorWithNotes(
            this.log,
            this.tracker,
            r,
            `${goQuoted(name)} cannot be bound multiple times in the same parameter list`,
            [this.tracker.MsgData(firstRange, `The name ${goQuoted(name)} was originally bound here:`)],
          );
        } else {
          opts.duplicateArgCheck.set(name, r);
        }
      }
    } else if (b instanceof js_ast.BArray) {
      for (const item of b.Items) {
        this.visitBinding(item.Binding, opts);
        if (item.DefaultValueOrNil !== null) {
          // Propagate the name to keep from the binding into the initializer
          if (item.Binding.Data instanceof js_ast.BIdentifier) {
            this.nameToKeep = this.symbols[item.Binding.Data.Ref.InnerIndex].OriginalName;
            this.nameToKeepIsFor = item.DefaultValueOrNil.Data;
          }

          item.DefaultValueOrNil = this.visitExpr(item.DefaultValueOrNil);
        }
      }
    } else if (b instanceof js_ast.BObject) {
      for (const property of b.Properties) {
        if (!property.IsSpread) {
          const keyIn = new exprIn();
          keyIn.shouldMangleStringsAsProps = true;
          property.Key = this.visitExprInOut(property.Key, keyIn);
        }
        this.visitBinding(property.Value, opts);
        if (property.DefaultValueOrNil !== null) {
          // Propagate the name to keep from the binding into the initializer
          if (property.Value.Data instanceof js_ast.BIdentifier) {
            this.nameToKeep = this.symbols[property.Value.Data.Ref.InnerIndex].OriginalName;
            this.nameToKeepIsFor = property.DefaultValueOrNil.Data;
          }

          property.DefaultValueOrNil = this.visitExpr(property.DefaultValueOrNil);
        }
      }
    } else {
      throw new Error("Internal error");
    }
  }

  /**
   * Go: func (p *parser) visitAndAppendStmt(stmts []js_ast.Stmt, stmt js_ast.Stmt) []js_ast.Stmt (js_parser.go:10393)
   *
   * 第 24 轮只落了 **SLocal 分支**（F-s1a，10721–10862）；其余 Stmt 种类原样追加。
   * M1 默认选项下不走的分支（minify 的 const-local-prefix / undefined 消除 / YarnPnP、
   * namespace 导出包装、object-rest 降级、var 提升）在对应位置逐条注明原因。
   */
  visitAndAppendStmt(stmts: js_ast.Stmt[], stmt: js_ast.Stmt): js_ast.Stmt[] {
    const s = stmt.Data;

    if (s instanceof js_ast.SLocal) {
      // Go: "await using" 的顶层降级依赖 fnOrArrowDataVisit.isOutsideFnOrArrow（未落，§2.1 F-s1a）
      // Go: p.currentScope.IsAfterConstLocalPrefix = wasAfterAfterConstLocalPrefix —— 只有 minify 会改它
      if (this.options.minifySyntax && this.currentScope !== null) {
        this.currentScope.IsAfterConstLocalPrefix = this.currentScope.IsAfterConstLocalPrefix;
      }

      // Go: js_parser.go:10813 —— namespace 内导出声明转成 "Foo.x = value" 赋值语句。
      if (s.IsExport && this.enclosingNamespaceArgRef !== null) {
        const argRef = new Ref(this.source.Index, this.enclosingNamespaceArgRef);
        const wrapIdentifier = (loc: Loc, ref: Ref): js_ast.Expr => {
          this.recordUsage(argRef);
          const target = new js_ast.Expr(new js_ast.EIdentifier(argRef), loc);
          const name = this.symbols[ref.InnerIndex].OriginalName;
          return new js_ast.Expr(this.dotOrMangledPropVisit(target, name, loc), loc);
        };
        for (const decl of s.Decls) {
          if (decl.ValueOrNil !== null && decl.ValueOrNil.Data !== null) {
            const target = js_ast_helpers.ConvertBindingToExpr(decl.Binding, wrapIdentifier);
            const assign = js_ast_helpers.Assign(target, decl.ValueOrNil);
            const se = new js_ast.SExpr(); se.Value = assign;
            stmts.push(new js_ast.Stmt(se, stmt.Loc));
          }
        }
        return stmts;
      }

      for (const d of s.Decls) {
        this.visitBinding(d.Binding, new bindingOpts());

        // Visit the initializer
        if (d.ValueOrNil !== null) {
          // Propagate the name to keep from the binding into the initializer
          if (d.Binding.Data instanceof js_ast.BIdentifier) {
            this.nameToKeep = this.symbols[d.Binding.Data.Ref.InnerIndex].OriginalName;
            this.nameToKeepIsFor = d.ValueOrNil.Data;
          }

          d.ValueOrNil = this.visitExpr(d.ValueOrNil);
          // Go: js_parser.go:10777 —— Yarn's PnP data may be stored in a variable
          // （https://github.com/yarnpkg/berry/pull/4320）。记录 `var X = "<json>"`，
          // 供后面 `hydrateRuntimeState(JSON.parse(X))` 分支取用。
          if (this.options.decodeHydrateRuntimeStateYarnPnP &&
              d.ValueOrNil.Data instanceof js_ast.EString &&
              d.Binding.Data instanceof js_ast.BIdentifier) {
            if (this.stringLocalsForYarnPnP === null) this.stringLocalsForYarnPnP = new Map();
            this.stringLocalsForYarnPnP.set(
              d.Binding.Data.Ref.InnerIndex,
              new stringLocalForYarnPnP(d.ValueOrNil.Data.Value, d.ValueOrNil.Loc),
            );
          }
          // Go: minify 的 "let a = undefined" 消除 / const local prefix / YarnPnP 均要求 minifySyntax
        }
      }

      // Go: s.IsExport && p.enclosingNamespaceArgRef —— TS 的 namespace 导出在 parse 期处理（K 批）
      // Go: s.Decls = p.lowerObjectRestInDecls(s.Decls) —— target < es2018 时降级（js_parser.go:10053/10836）
      s.Decls = lowerObjectRestInDecls(this, s.Decls);
      s.Kind = this.selectLocalKind(s.Kind);

      // Go: p.maybeRelocateVarsToTopLevel 在 mode != ModeBundle 时直接返回 false（M1 的 mode=0）
    } else if (s instanceof js_ast.SFunction) {
      this.visitFn(s.Fn, s.Fn.OpenParenLoc);

      // Go: js_parser.go:11383 —— namespace 内导出函数去掉 export 标志并追加 "N.f = f"。
      if (s.IsExport && this.enclosingNamespaceArgRef !== null && s.Fn.Name !== null) {
        const nameToExport = this.symbols[s.Fn.Name.Ref.InnerIndex].OriginalName;
        s.IsExport = false;
        stmts.push(stmt);
        const argRefObj = new Ref(this.source.Index, this.enclosingNamespaceArgRef);
        const target = new js_ast.Expr(new js_ast.EIdentifier(argRefObj), stmt.Loc);
        const prop = this.dotOrMangledPropVisit(target, nameToExport, s.Fn.Name.Loc);
        stmts.push(js_ast_helpers.AssignStmt(new js_ast.Expr(prop, stmt.Loc),
          new js_ast.Expr(new js_ast.EIdentifier(s.Fn.Name.Ref), s.Fn.Name.Loc)));
        return stmts;
      }

      // Strip this function declaration if it was overwritten
      if (s.Fn.Name !== null &&
        (this.symbols[s.Fn.Name.Ref.InnerIndex].Flags & ast.SymbolFlags.RemoveOverwrittenFunctionDeclaration) !== 0 &&
        !s.IsExport) {
        return stmts;
      }
      // Go: minifySyntax 的 IsEmptyFunction/IsIdentityFunction、namespace 导出、keepNames —— M1 默认不触发
      stmts.push(stmt);
      return stmts;
    } else if (s instanceof js_ast.SClass) {
      // Go: js_parser.go:11383-11390 —— visitClass 后无条件 lowerClass（target=esnext 时它原样返回）
      const result = this.visitClass(stmt.Loc, s.Class, InvalidRef);
      const [classStmts] = lowerClass(this, stmt, new js_ast.Expr(), result, "");
      if (result.canBeRemovedIfUnused) {
        for (const classStmt of classStmts) {
          if (classStmt.Data instanceof js_ast.SExpr) classStmt.Data.IsFromClassOrFnThatCanBeRemovedIfUnused = true;
        }
      }
      stmts.push(...classStmts);
      return stmts;
    } else if (s instanceof js_ast.SExpr) {
      // Go: js_parser.go:10042/10865 —— 记下表达式语句的值，BinOpAssign 据此选 objRest 模式
      this.stmtExprValue = s.Value.Data;
      // Go: js_parser.go:10864 —— 原值不是 unsightly、visit 后变成 unsightly 的表达式语句会被删掉
      const shouldTrimUnsightlyPrimitives = !this.options.minifySyntax && !this.isUnsightlyPrimitive(s.Value.Data);
      s.Value = this.visitExpr(s.Value);
      if (shouldTrimUnsightlyPrimitives && this.isUnsightlyPrimitive(s.Value.Data)) {
        return stmts;
      }
    } else if (s instanceof js_ast.SReturn) {
      if (s.ValueOrNil !== null) s.ValueOrNil = this.visitExpr(s.ValueOrNil);
      // Go: 顶层 return 诊断依赖 fnOrArrowDataVisit / isFileConsideredESM 的 notes
    } else if (s instanceof js_ast.SThrow) {
      s.Value = this.visitExpr(s.Value);
    } else if (s instanceof js_ast.SBlock) {
      this.pushScopeForVisitPass(js_ast.ScopeKind.ScopeBlock, stmt.Loc);
      s.Stmts = this.visitStmts(s.Stmts);
      this.popScope();
    } else if (s instanceof js_ast.SWith) {
      s.Value = this.visitExpr(s.Value);
      this.pushScopeForVisitPass(js_ast.ScopeKind.ScopeWith, s.BodyLoc);
      s.Body = this.visitSingleStmt(s.Body);
      this.popScope();
    } else if (s instanceof js_ast.SWhile) {
      s.Test = this.visitExpr(s.Test);
      s.Body = this.visitLoopBody(s.Body);
    } else if (s instanceof js_ast.SDoWhile) {
      s.Body = this.visitLoopBody(s.Body);
      s.Test = this.visitExpr(s.Test);
    } else if (s instanceof js_ast.SIf) {
      s.Test = this.visitExpr(s.Test);
      s.Yes = this.visitSingleStmt(s.Yes);
      if (s.NoOrNil !== null) s.NoOrNil = this.visitSingleStmt(s.NoOrNil);
    } else if (s instanceof js_ast.SFor) {
      this.pushScopeForVisitPass(js_ast.ScopeKind.ScopeBlock, stmt.Loc);
      if (s.InitOrNil !== null) s.InitOrNil = this.visitForLoopInit(s.InitOrNil, false);
      if (s.TestOrNil !== null) s.TestOrNil = this.visitExpr(s.TestOrNil);
      if (s.UpdateOrNil !== null) s.UpdateOrNil = this.visitExpr(s.UpdateOrNil);
      s.Body = this.visitLoopBody(s.Body);
      this.popScope();
    } else if (s instanceof js_ast.SForIn) {
      this.pushScopeForVisitPass(js_ast.ScopeKind.ScopeBlock, stmt.Loc);
      s.Init = this.visitForLoopInit(s.Init, true);
      s.Value = this.visitExpr(s.Value);
      s.Body = this.visitSingleStmt(s.Body);
      this.popScope();
      lowerObjectRestInForLoopInit(this, s.Init, s.Body);
    } else if (s instanceof js_ast.SForOf) {
      this.pushScopeForVisitPass(js_ast.ScopeKind.ScopeBlock, stmt.Loc);
      s.Init = this.visitForLoopInit(s.Init, true);
      s.Value = this.visitExpr(s.Value);
      s.Body = this.visitLoopBody(s.Body);
      this.popScope();
      lowerObjectRestInForLoopInit(this, s.Init, s.Body);
      // Go: js_parser.go:11107-11127 —— Handle "for (using x of y)" / "for (await using x of y)"（第 109 批）
      const initLocal = s.Init.Data;
      if (initLocal instanceof js_ast.SLocal) {
        const uf = this.options.unsupportedJSFeatures;
        if (initLocal.Kind === js_ast.LocalKind.LocalUsing && HasFeature(uf, JSFeature.Using)) {
          lowerUsingDeclarationInForOf(this, s.Init.Loc, initLocal, s.Body);
        } else if (initLocal.Kind === js_ast.LocalKind.LocalAwaitUsing) {
          if (this.fnOrArrowDataVisit.isOutsideFnOrArrow) {
            if (this.isControlFlowDead && (HasFeature(uf, JSFeature.TopLevelAwait) || this.options.outputFormat !== 3)) {
              initLocal.Kind = js_ast.LocalKind.LocalUsing;
            } else {
              this.markSyntaxFeature(JSFeature.TopLevelAwait, new Range(s.Init.Loc, 5));
            }
            if (HasFeature(uf, JSFeature.Using)) lowerUsingDeclarationInForOf(this, s.Init.Loc, initLocal, s.Body);
          } else if (HasFeature(uf, JSFeature.Using) || HasFeature(uf, JSFeature.AsyncAwait) ||
            (HasFeature(uf, JSFeature.AsyncGenerator) && this.fnOrArrowDataVisit.isGenerator)) {
            lowerUsingDeclarationInForOf(this, s.Init.Loc, initLocal, s.Body);
          }
        }
      }
      // Go: js_parser.go:11137 —— for await 降级（ForAwait 位置位时）
      if (s.Await.Len > 0 && HasFeature(this.options.unsupportedJSFeatures, JSFeature.ForAwait)) {
        // Go 是 `stmts = lowerForAwaitLoop(loc, s, stmts)`：把原 SForOf 替换成 try/catch。
        // TS 的 visitAndAppendStmt 末尾会 push(stmt)，故先把 try/catch 推进去，再替换 stmt.Data 为空块，
        // 让末尾 push 的是空块（打印阶段会跳过 SEmpty）——等价于 Go 的替换。
        const lowered = lowerForAwaitLoop(this, stmt.Loc, s, []);
        stmts.push(...lowered);
        stmt.Data = new js_ast.SEmpty();
        return stmts;
      }
      // Go: top-level await / using 降级 —— M2 与 I 批
    } else if (s instanceof js_ast.STry) {
      this.pushScopeForVisitPass(js_ast.ScopeKind.ScopeBlock, stmt.Loc);
      s.Block.Stmts = this.visitStmts(s.Block.Stmts);
      this.popScope();

      if (s.Catch !== null) {
        this.pushScopeForVisitPass(js_ast.ScopeKind.ScopeCatchBinding, s.Catch.Loc);
        if (s.Catch.BindingOrNil !== null) this.visitBinding(s.Catch.BindingOrNil, new bindingOpts());
        this.pushScopeForVisitPass(js_ast.ScopeKind.ScopeBlock, s.Catch.BlockLoc);
        s.Catch.Block.Stmts = this.visitStmts(s.Catch.Block.Stmts);
        this.popScope();
        lowerObjectRestInCatchBinding(this, s.Catch);
        this.popScope();
      }

      if (s.Finally !== null) {
        this.pushScopeForVisitPass(js_ast.ScopeKind.ScopeBlock, s.Finally.Loc);
        s.Finally.Block.Stmts = this.visitStmts(s.Finally.Block.Stmts);
        this.popScope();
      }
    } else if (s instanceof js_ast.SSwitch) {
      s.Test = this.visitExpr(s.Test);
      this.pushScopeForVisitPass(js_ast.ScopeKind.ScopeBlock, s.BodyLoc);

      // Disable const inlining in switch cases. They all share the same scope
      // and can be evaluated in an unusual order.
      this.currentScope!.IsAfterConstLocalPrefix = true;

      // Visit case values first
      for (const c of s.Cases) {
        if (c.ValueOrNil !== null) {
          c.ValueOrNil = this.visitExpr(c.ValueOrNil);
          this.warnAboutEqualityCheck("case", c.ValueOrNil, c.ValueOrNil.Loc);
          this.warnAboutTypeofAndString(s.Test, c.ValueOrNil, onlyCheckOriginalOrder);
        }
      }

      // Check for duplicate case values
      this.duplicateCaseChecker.reset();
      for (const c of s.Cases) {
        if (c.ValueOrNil !== null) this.duplicateCaseChecker.check(this, c.ValueOrNil);
      }

      // Then analyze the cases to determine which ones are live and/or dead
      const cases = analyzeSwitchCasesForLiveness(s);

      // Then visit case bodies, and potentially filter out dead cases
      let end = 0;
      for (let i = 0; i < s.Cases.length; i++) {
        const c = s.Cases[i];
        const isAlwaysDead = cases[i].status === alwaysDead;
        // Go: js_parser.go:11282-11287 —— 静态判死的 case 体在死代码区里 visit
        const oldIsControlFlowDead = this.isControlFlowDead;
        if (isAlwaysDead) this.isControlFlowDead = true;
        c.Body = this.visitStmts(c.Body);
        this.isControlFlowDead = oldIsControlFlowDead;
        if (this.options.minifySyntax && isAlwaysDead && c.Body.length === 0) continue;
        s.Cases[end] = c;
        end++;
      }
      s.Cases = s.Cases.slice(0, end);
      this.popScope();

      // Go: js_parser.go:11307-11316 —— 死代码里展开 switch / minify 时把 switch 压成 if-else
      // 注意：TS visitStmts 忽略 visitAndAppendStmt 的返回值，靠原地改 stmts 生效。
      if (this.options.minifySyntax && this.isControlFlowDead) {
        for (const c of s.Cases) stmts.push(...c.Body);
        return stmts;
      }
      if (this.options.minifySyntax) {
        const out = this.minifySwitchStmt(stmt.Loc, s, stmts);
        if (out !== stmts) { stmts.length = 0; stmts.push(...out); }
        return stmts;
      }
    } else if (s instanceof js_ast.SLabel) {
      this.pushScopeForVisitPass(js_ast.ScopeKind.ScopeLabel, stmt.Loc);
      s.Stmt = this.visitSingleStmt(s.Stmt);
      this.popScope();
    } else if (s instanceof js_ast.SImport) {
      // Go: case *js_ast.SImport（js_parser.go:10426）—— 符号在 parse 期的 declareSymbol 已建，
      // visit 只把它们记进 declaredSymbols。
      this.recordDeclaredSymbol(s.NamespaceRef);
      if (s.DefaultName !== null) this.recordDeclaredSymbol(s.DefaultName.Ref);
      if (s.Items !== null) {
        for (const item of s.Items) this.recordDeclaredSymbol(item.Name.Ref);
      }
    } else if (s instanceof js_ast.SExportClause) {
      // Go: case *js_ast.SExportClause（js_parser.go:10439）
      let end = 0;
      for (const item of s.Items) {
        const name = this.loadNameFromRef(item.Name.Ref);
        const ref = this.resolveName(name, item.AliasLoc);

        if (this.symbols[ref.InnerIndex].Kind === SymbolKind.SymbolUnbound) {
          // Silently strip exports of non-local symbols in TypeScript, since those likely
          // correspond to type-only exports. But report exports of non-local symbols as
          // errors in JavaScript.
          if (!this.options.ts.Parse) {
            AddError(
              this.log,
              this.tracker,
              RangeOfIdentifier(this.source, item.Name.Loc),
              `${goQuoted(name)} is not declared in this file`,
            );
          }
          continue;
        }

        item.Name.Ref = ref;
        s.Items[end] = item;
        end++;
      }

      // Note: do not remove empty export statements since TypeScript uses them as module markers
      s.Items = s.Items.slice(0, end);
    } else if (s instanceof js_ast.SExportFrom) {
      // Go: case *js_ast.SExportFrom（js_parser.go:10465）
      const name = this.loadNameFromRef(s.NamespaceRef);
      s.NamespaceRef = this.newSymbol(SymbolKind.SymbolOther, name);
      this.currentScope!.Generated.push(s.NamespaceRef);
      this.recordDeclaredSymbol(s.NamespaceRef);

      // This is a re-export and the symbols created here are used to reference names in
      // another file. This means the symbols are really aliases.
      for (let i = 0; i < s.Items.length; i++) {
        const itemName = this.loadNameFromRef(s.Items[i].Name.Ref);
        const ref = this.newSymbol(SymbolKind.SymbolOther, itemName);
        this.currentScope!.Generated.push(ref);
        this.recordDeclaredSymbol(ref);
        s.Items[i].Name.Ref = ref;
      }
    } else if (s instanceof js_ast.SExportStar) {
      // Go: case *js_ast.SExportStar（js_parser.go:10482）
      const name = this.loadNameFromRef(s.NamespaceRef);
      s.NamespaceRef = this.newSymbol(SymbolKind.SymbolOther, name);
      this.currentScope!.Generated.push(s.NamespaceRef);
      this.recordDeclaredSymbol(s.NamespaceRef);

      // Go: "export * as ns from 'path'" 在 unsupportedJSFeatures 含 compat.ExportStarAs
      // （Go 探针实测 8388608 = 1<<23）时降级成 SImport + SExportClause。
      // M1（target=esnext）不支持降级，此分支不可达。
      if (s.Alias !== null && HasFeature(this.options.unsupportedJSFeatures, JSFeature.ExportStarAs)) {
        this.recordUsage(s.NamespaceRef);
        const importStmt = new js_ast.Stmt(init(new js_ast.SImport(), {
          NamespaceRef: s.NamespaceRef,
          StarNameLoc: s.Alias.Loc,
          ImportRecordIndex: s.ImportRecordIndex,
        }), stmt.Loc);
        const item = init(new js_ast.ClauseItem(), {
          Alias: s.Alias.OriginalName,
          OriginalName: s.Alias.OriginalName,
          AliasLoc: s.Alias.Loc,
          Name: new LocRef(s.Alias.Loc, s.NamespaceRef),
        });
        const exportClause = new js_ast.Stmt(init(new js_ast.SExportClause(), {
          Items: [item],
          IsSingleLine: true,
        }), stmt.Loc);
        stmts.push(importStmt, exportClause);
        return stmts;
      }
    } else if (s instanceof js_ast.SExportDefault) {
      // Go: js_parser.go:10515（SExportDefault 的子集）
      this.recordDeclaredSymbol(s.DefaultName.Ref);
      const v = s.Value.Data;
      if (v instanceof js_ast.SExpr) {
        this.nameToKeep = "default";
        this.nameToKeepIsFor = v.Value.Data;
        v.Value = this.visitExpr(v.Value);
      } else if (v instanceof js_ast.SFunction) {
        this.visitFn(v.Fn, v.Fn.OpenParenLoc);
      } else if (v instanceof js_ast.SClass) {
        // Go: js_parser.go:10583 —— visitClass + lowerClass（导出默认 class）
        const result = this.visitClass(s.Value.Loc, v.Class, s.DefaultName.Ref);
        const [classStmts] = lowerClass(this, stmt, new js_ast.Expr(), result, "");
        if (result.canBeRemovedIfUnused) {
          for (const classStmt of classStmts) {
            if (classStmt.Data instanceof js_ast.SExpr) classStmt.Data.IsFromClassOrFnThatCanBeRemovedIfUnused = true;
          }
        }
        stmts.push(...classStmts);
        return stmts;
      }
    } else if (s instanceof js_ast.SExportEquals) {
      s.Value = this.visitExpr(s.Value);
    } else if (s instanceof js_ast.SLazyExport) {
      s.Value = this.visitExpr(s.Value);
    } else if (s instanceof js_ast.SEnum) {
      // Go: js_parser.go:11417 —— visit SEnum，常量折叠每个值，包进 closure。
      return this.visitTypeScriptEnum(stmts, stmt.Loc, s);
    } else if (s instanceof js_ast.SNamespace) {
      // Go: js_parser.go:11575 —— visit SNamespace，包进 closure。
      return this.visitTypeScriptNamespace(stmts, stmt.Loc, s);
    }

    stmts.push(stmt);
    return stmts;
  }

  /** Go: js_parser.go:11417 SEnum visit 分支（第 42 轮深水链）。M1: mode=0/minify=false/Arrow 位清。 */
  private visitTypeScriptEnum(stmts: js_ast.Stmt[], stmtLoc: Loc, s: js_ast.SEnum): js_ast.Stmt[] {
    this.recordDeclaredSymbol(s.Name.Ref);
    this.pushScopeForVisitPass(js_ast.ScopeKind.ScopeEntry, stmtLoc);
    this.recordDeclaredSymbol(s.Arg);

    const exportedMembers = this.currentScope!.TSNamespace!.ExportedMembers;
    let nextNumericValue = 0;
    let hasNumericValue = true;
    const valueExprs: js_ast.Expr[] = [];
    let allValuesArePure = true;

    const oldFold = this.shouldFoldTypeScriptConstantExpressions;
    this.shouldFoldTypeScriptConstantExpressions = true;

    for (const value of s.Values) {
      const name = new TextDecoder().decode(UTF16ToString(value.Name));
      let hasStringValue = false;
      let assignTarget: js_ast.Expr;

      if (value.ValueOrNil !== null) {
        value.ValueOrNil = this.visitExpr(value.ValueOrNil);
        hasNumericValue = false;
        let underlying = value.ValueOrNil;
        if (underlying.Data instanceof js_ast.EInlinedEnum) underlying = underlying.Data.Value;
        const d = underlying.Data;
        if (d instanceof js_ast.ENumber) {
          const member = exportedMembers.get(name) ?? new js_ast.TSNamespaceMember();
          const em = new js_ast.TSNamespaceMemberEnumNumber(); em.Value = d.Value; member.Data = em;
          exportedMembers.set(name, member);
          this.refToTSNamespaceMemberData.set(value.Ref.InnerIndex, member.Data);
          hasNumericValue = true;
          nextNumericValue = d.Value + 1;
        } else if (d instanceof js_ast.EString) {
          const member = exportedMembers.get(name) ?? new js_ast.TSNamespaceMember();
          const em = new js_ast.TSNamespaceMemberEnumString(); em.Value = d.Value; member.Data = em;
          exportedMembers.set(name, member);
          this.refToTSNamespaceMemberData.set(value.Ref.InnerIndex, member.Data);
          hasStringValue = true;
        } else {
          if (!this.astHelpers.ExprCanBeRemovedIfUnused(underlying)) allValuesArePure = false;
        }
      } else if (hasNumericValue) {
        const member = exportedMembers.get(name) ?? new js_ast.TSNamespaceMember();
        const em = new js_ast.TSNamespaceMemberEnumNumber(); em.Value = nextNumericValue; member.Data = em;
        exportedMembers.set(name, member);
        this.refToTSNamespaceMemberData.set(value.Ref.InnerIndex, member.Data);
        const num = new js_ast.ENumber(); num.Value = nextNumericValue;
        value.ValueOrNil = new js_ast.Expr(num, value.Loc);
        nextNumericValue++;
      } else {
        value.ValueOrNil = new js_ast.Expr(js_ast.EUndefinedShared, value.Loc);
      }

      // M1: minifySyntax=false → "Enum['Name'] = value"（EIndex 两-way map）
      const argId = new js_ast.EIdentifier(s.Arg);
      const idx = new js_ast.EIndex();
      idx.Target = new js_ast.Expr(argId, value.Loc);
      const str = new js_ast.EString(); str.Value = value.Name;
      idx.Index = new js_ast.Expr(str, value.Loc);
      assignTarget = js_ast_helpers.Assign(new js_ast.Expr(idx, value.Loc), value.ValueOrNil!);
      this.recordUsage(s.Arg);

      if (hasStringValue) {
        valueExprs.push(assignTarget);
      } else {
        const idx2 = new js_ast.EIndex();
        idx2.Target = new js_ast.Expr(new js_ast.EIdentifier(s.Arg), value.Loc);
        idx2.Index = assignTarget;
        const str2 = new js_ast.EString(); str2.Value = value.Name;
        valueExprs.push(js_ast_helpers.Assign(new js_ast.Expr(idx2, value.Loc), new js_ast.Expr(str2, value.Loc)));
        this.recordUsage(s.Arg);
      }
    }

    this.popScope();
    this.shouldFoldTypeScriptConstantExpressions = oldFold;
    return generateClosureForTypeScriptEnum(this, stmts, stmtLoc, s.IsExport, s.Name.Loc, s.Name.Ref, s.Arg, valueExprs, allValuesArePure);
  }

  /** Go: js_parser.go:11575 SNamespace visit 分支（第 42 轮深水链）。 */
  private visitTypeScriptNamespace(stmts: js_ast.Stmt[], stmtLoc: Loc, s: js_ast.SNamespace): js_ast.Stmt[] {
    this.recordDeclaredSymbol(s.Name.Ref);
    // Go: js_parser.go:11583 —— 提前登记 namespace 内的导出绑定为 arg 对象属性。
    for (const child of s.Stmts) {
      if (child.Data instanceof js_ast.SLocal && child.Data.IsExport) {
        js_ast_helpers.ForEachIdentifierBindingInDecls(child.Data.Decls, (_loc: Loc, b: js_ast.BIdentifier) => {
          this.isExportedInsideNamespace.set(b.Ref.InnerIndex, s.Arg.InnerIndex);
        });
      }
    }
    const oldEnclosing = this.enclosingNamespaceArgRef;
    this.enclosingNamespaceArgRef = s.Arg.InnerIndex;
    this.pushScopeForVisitPass(js_ast.ScopeKind.ScopeEntry, stmtLoc);
    this.recordDeclaredSymbol(s.Arg);
    const inside = this.visitStmtsAndPrependTempRefs(s.Stmts, stmtsKind.stmtsFnBody);
    this.popScope();
    this.enclosingNamespaceArgRef = oldEnclosing;
    return generateClosureForTypeScriptNamespaceOrEnum(this, stmts, stmtLoc, s.IsExport, s.Name.Loc, s.Name.Ref, s.Arg, inside);
  }

  /** Go: func (p *parser) visitForLoopInit(stmt js_ast.Stmt, isInOrOf bool) js_ast.Stmt (js_parser.go:10035) */
  visitForLoopInit(stmt: js_ast.Stmt, isInOrOf: boolean): js_ast.Stmt {
    const s = stmt.Data;
    if (s instanceof js_ast.SExpr) {
      s.Value = this.visitExprInOut(s.Value, init(new exprIn(), {
        assignTarget: isInOrOf ? assignTarget.assignTargetReplace : assignTarget.assignTargetNone,
      }));
    } else if (s instanceof js_ast.SLocal) {
      for (const d of s.Decls) {
        this.visitBinding(d.Binding, new bindingOpts());
        if (d.ValueOrNil !== null) d.ValueOrNil = this.visitExpr(d.ValueOrNil);
      }
      // Go: lowerObjectRestInDecls（js_parser.go:10053）
      s.Decls = lowerObjectRestInDecls(this, s.Decls);
      s.Kind = this.selectLocalKind(s.Kind);
    } else {
      throw new Error("Internal error");
    }
    return stmt;
  }

  /**
   * Go: func (p *parser) visitClass(nameScopeLoc logger.Loc, class *js_ast.Class, defaultNameRef ast.Ref, nameToKeep string) (result visitClassResult) (js_parser.go:12177)
   *
   * M1（target=esnext、keepNames=false、ts.Parse=false）下 `computeClassLoweringInfo` 全为 false，
   * lowerClass 分支不触发；本函数仍按 Go 的顺序处理：decorators → ClassName 作用域 → __super/innerClassNameRef
   * → extends → ClassBody（static block / private key / computed key / method / initializer）→ 重复 key 警告
   * → ClassCanBeRemovedIfUnused → innerClassNameRef 回收。
   */
  visitClass(nameScopeLoc: Loc, classValue: js_ast.Class, defaultNameRef: Ref): visitClassResult {
    classValue.Decorators = this.visitDecorators(classValue.Decorators);

    if (classValue.Name !== null) {
      this.recordDeclaredSymbol(classValue.Name.Ref);
      // Go: options.keepNames 时把 nameToKeep 改成类名（M1 默认 false）
    }

    // Replace "this" with a reference to the class inside static field initializers
    // if static fields are being lowered, since that relocates the field initializers
    // outside of the class body and "this" will no longer reference the same thing.
    let loweringInfo = computeClassLoweringInfo(this, classValue);
    let recomputeClassLoweringInfo = false;

    // Sometimes we need to lower private members even though they are supported.
    if (loweringInfo.lowerAllStaticFields) {
      for (const prop of classValue.Properties) {
        if (prop.Key.Data instanceof js_ast.EPrivateIdentifier) {
          this.symbols[prop.Key.Data.Ref.InnerIndex].Flags |= ast.SymbolFlags.PrivateSymbolMustBeLowered;
          recomputeClassLoweringInfo = true;
        }
      }
    }

    // Conservatively lower all private names that have been used in a private brand check anywhere in the file.
    if (this.lowerAllOfThesePrivateNames !== null) {
      for (const prop of classValue.Properties) {
        if (prop.Key.Data instanceof js_ast.EPrivateIdentifier) {
          const symbol = this.symbols[prop.Key.Data.Ref.InnerIndex];
          if (this.lowerAllOfThesePrivateNames.get(symbol.OriginalName)) {
            symbol.Flags |= ast.SymbolFlags.PrivateSymbolMustBeLowered;
            recomputeClassLoweringInfo = true;
          }
        }
      }
    }

    if (recomputeClassLoweringInfo) loweringInfo = computeClassLoweringInfo(this, classValue);

    this.pushScopeForVisitPass(js_ast.ScopeKind.ScopeClassName, nameScopeLoc);
    const oldEnclosingClassKeyword = this.enclosingClassKeyword;
    this.enclosingClassKeyword = classValue.ClassKeyword;
    this.currentScope!.RecursiveSetStrictMode(js_ast.StrictModeKind.ImplicitStrictModeClass);
    // Go: validateDeclaredSymbolName(class.Name.Loc, ...) —— 依赖 strict-mode 闭包（§2.2 单列 #2）

    // Create the "__super" symbol if necessary.
    const result = new visitClassResult();
    result.superCtorRef = InvalidRef;
    if (loweringInfo.shimSuperCtorCalls) {
      result.superCtorRef = this.newSymbol(SymbolKind.SymbolOther, "__super");
      this.currentScope!.Generated.push(result.superCtorRef);
      this.recordDeclaredSymbol(result.superCtorRef);
    }
    const oldSuperCtorRef = this.superCtorRef;
    this.superCtorRef = result.superCtorRef;

    // Insert an immutable inner name that spans the whole class to match JavaScript's
    // "CreateImmutableBinding" semantics for class definitions.
    if (classValue.Name !== null) {
      const name = this.symbols[classValue.Name.Ref.InnerIndex].OriginalName;
      // TS 一趟 parser 在 parseClassStmt 里已预建内层类名且 class body 自引用已绑到它，
      // 直接复用；否则（pass-through / class 表达式）沿用原逻辑新建。
      if (classValue.InnerNameRef.InnerIndex !== InvalidRef.InnerIndex) {
        result.innerClassNameRef = classValue.InnerNameRef;
      } else {
        result.innerClassNameRef = this.newSymbol(SymbolKind.SymbolConst, "_" + name);
      }
      this.currentScope!.Members.set(name, init(new js_ast.ScopeMember(), {
        Loc: classValue.Name.Loc,
        Ref: result.innerClassNameRef,
      }));
    } else {
      let name = "_this";
      if (defaultNameRef !== InvalidRef) name = "_" + this.source.IdentifierName + "_default";
      result.innerClassNameRef = this.newSymbol(SymbolKind.SymbolConst, name);
    }
    this.recordDeclaredSymbol(result.innerClassNameRef);

    if (classValue.ExtendsOrNil !== null) {
      classValue.ExtendsOrNil = this.visitExpr(classValue.ExtendsOrNil);
    }

    // A scope is needed for private identifiers
    this.pushScopeForVisitPass(js_ast.ScopeKind.ScopeClassBody, classValue.BodyLoc);
    result.bodyScope = this.currentScope;
    // Go: fnOnlyDataVisit.innerClassNameRef = &result.innerClassNameRef（J-1 super/private lowering）
    const oldFnOnlyDataVisit = { ...this.fnOnlyDataVisit };
    this.fnOnlyDataVisit.innerClassNameRef = result.innerClassNameRef;

    for (const property of classValue.Properties) {
      if (property.ClassStaticBlock !== null) {
        // Go: js_parser.go:12297-12313 —— static block 降级时 lower this/super
        const oldShouldLowerSuperStatic = this.fnOrArrowDataVisit.shouldLowerSuperPropertyAccess;
        const oldFnOnlyBlock = { ...this.fnOnlyDataVisit };
        this.fnOnlyDataVisit.isInStaticClassContext = true;
        if (loweringInfo.lowerAllStaticFields) {
          this.fnOnlyDataVisit.shouldReplaceThisWithInnerClassNameRef = true;
          this.fnOrArrowDataVisit.shouldLowerSuperPropertyAccess = true;
        }
        // Go: js_parser.go:12292 —— 静态块里 this/new.target 是 nested（this 指向类本身）
        const oldIsThisNestedStatic = this.isThisNested;
        this.isThisNested = true;
        // Go: fnOnlyDataVisit = {isThisNested, isNewTargetAllowed, isInStaticClassContext, innerClassNameRef}
        // static field lowering 时的 shouldReplaceThisWithInnerClassNameRef 属 J 批（M1 不触发）

        this.pushScopeForVisitPass(js_ast.ScopeKind.ScopeClassStaticInit, property.ClassStaticBlock.Loc);

        // Make it an error to use "arguments" in a static class block
        this.currentScope!.ForbidArguments = true;

        property.ClassStaticBlock.Block.Stmts = this.visitStmts(property.ClassStaticBlock.Block.Stmts, stmtsKind.stmtsFnBody);
        this.popScope();

        this.isThisNested = oldIsThisNestedStatic;
        this.fnOrArrowDataVisit.shouldLowerSuperPropertyAccess = oldShouldLowerSuperStatic;
        this.fnOnlyDataVisit = oldFnOnlyBlock;
        continue;
      }

      property.Decorators = this.visitDecorators(property.Decorators);

      // Visit the property key
      if (property.Key.Data instanceof js_ast.EPrivateIdentifier) {
        // Special-case private identifiers here
        this.recordDeclaredSymbol(property.Key.Data.Ref);
      } else {
        // It's forbidden to reference the class name in a computed key
        if ((property.Flags & js_ast.PropertyFlags.PropertyIsComputed) !== 0 && classValue.Name !== null) {
          this.symbols[result.innerClassNameRef.InnerIndex].Kind = SymbolKind.SymbolClassInComputedPropertyKey;
        }

        property.Key = this.visitExprInOut(property.Key, init(new exprIn(), {
          shouldMangleStringsAsProps: true,
        }));

        // Re-allow using the class name after visiting a computed key
        if ((property.Flags & js_ast.PropertyFlags.PropertyIsComputed) !== 0 && classValue.Name !== null) {
          this.symbols[result.innerClassNameRef.InnerIndex].Kind = SymbolKind.SymbolConst;
        }

        // Go: minifySyntax 的 key 折叠（EInlinedEnum / 数字 / 字符串）属 G 批
      }

      // Make it an error to use "arguments" in a class body
      this.currentScope!.ForbidArguments = true;

      // The value of "this" and "super" is shadowed inside property values
      const oldIsThisNestedValue = this.isThisNested;
      this.isThisNested = true;

      // We need to explicitly assign the name to the property initializer if it
      // will be transformed such that it is no longer an inline initializer.
      let nameToKeep = "";
      let isLoweredPrivateMethod = false;
      if (property.Key.Data instanceof js_ast.EPrivateIdentifier) {
        const privateIdent = property.Key.Data;
        if (!js_ast.IsMethodDefinition(property.Kind) || privateSymbolNeedsToBeLowered(this, privateIdent)) {
          nameToKeep = this.symbols[privateIdent.Ref.InnerIndex].OriginalName;
        }

        // Lowered private methods (both instance and static) are initialized outside of
        // the class body, so we must rewrite "super" property accesses inside them.
        if (js_ast.IsMethodDefinition(property.Kind) && privateSymbolNeedsToBeLowered(this, privateIdent)) {
          isLoweredPrivateMethod = true;
        }
      } else if (!js_ast.IsMethodDefinition(property.Kind) && (property.Flags & js_ast.PropertyFlags.PropertyIsComputed) === 0) {
        if (property.Key.Data instanceof js_ast.EString) {
          nameToKeep = bytesToString(UTF16ToString(property.Key.Data.Value));
        }
      }

      // Handle methods
      if (property.ValueOrNil !== null) {
        this.propMethodDecoratorScope = result.bodyScope;

        // Propagate the name to keep from the method into the initializer
        if (nameToKeep !== "") {
          this.nameToKeep = nameToKeep;
          this.nameToKeepIsFor = property.ValueOrNil.Data;
        }

        // Propagate whether we're in a derived class constructor
        if (classValue.ExtendsOrNil !== null && (property.Flags & js_ast.PropertyFlags.PropertyIsComputed) === 0) {
          if (property.Key.Data instanceof js_ast.EString && UTF16EqualsString(property.Key.Data.Value, new TextEncoder().encode("constructor"))) {
            this.propDerivedCtorValue = property.ValueOrNil.Data;
          }
        }

        property.ValueOrNil = this.visitExprInOut(property.ValueOrNil, init(new exprIn(), {
          isMethod: true,
          isLoweredPrivateMethod,
        }));
      }

      // Handle initialized fields
      if (property.InitializerOrNil !== null) {
        // Go: js_parser.go:12450-12458 —— static 字段降级时 lower this/super
        const oldShouldLowerSuperField = this.fnOrArrowDataVisit.shouldLowerSuperPropertyAccess;
        const oldFnOnlyStatic = { ...this.fnOnlyDataVisit };
        if ((property.Flags & js_ast.PropertyFlags.PropertyIsStatic) !== 0 && loweringInfo.lowerAllStaticFields) {
          // Need to lower "this" and "super" since they won't be valid outside the class body
          this.fnOnlyDataVisit.shouldReplaceThisWithInnerClassNameRef = true;
          this.fnOnlyDataVisit.isInStaticClassContext = true;
          this.fnOrArrowDataVisit.shouldLowerSuperPropertyAccess = true;
        }

        // Propagate the name to keep from the field into the initializer
        if (nameToKeep !== "") {
          this.nameToKeep = nameToKeep;
          this.nameToKeepIsFor = property.InitializerOrNil.Data;
        }

        property.InitializerOrNil = this.visitExpr(property.InitializerOrNil);
        this.fnOrArrowDataVisit.shouldLowerSuperPropertyAccess = oldShouldLowerSuperField;
        this.fnOnlyDataVisit = oldFnOnlyStatic;
      }

      // Restore "this" so it will take the inherited value in property keys
      this.isThisNested = oldIsThisNestedValue;

      // Restore the ability to use "arguments" in decorators and computed properties
      this.currentScope!.ForbidArguments = false;
    }

    // Check for and warn about duplicate keys in class bodies
    this.warnAboutDuplicateProperties(classValue.Properties, false);

    // Analyze side effects before adding the name keeping call
    const ctx = new js_ast_helpers.HelperContext(
      (ref) => this.symbols[ref.InnerIndex].Kind === SymbolKind.SymbolUnbound,
    );
    result.canBeRemovedIfUnused = ctx.ClassCanBeRemovedIfUnused(classValue);

    // Go: keepNames 的 static block（options.keepNames=false，M1 不触发）

    this.fnOnlyDataVisit = oldFnOnlyDataVisit;
    this.enclosingClassKeyword = oldEnclosingClassKeyword;
    this.superCtorRef = oldSuperCtorRef;
    this.popScope();

    if (this.symbols[result.innerClassNameRef.InnerIndex].UseCountEstimate === 0) {
      // Don't generate a shadowing name if one isn't needed
      result.innerClassNameRef = InvalidRef;
    } else if (classValue.Name === null) {
      // If there was originally no class name but something inside needed one
      let classNameRef = defaultNameRef;
      if (classNameRef === InvalidRef) {
        classNameRef = this.newSymbol(SymbolKind.SymbolOther, "_this");
        this.currentScope!.Generated.push(classNameRef);
        this.recordDeclaredSymbol(classNameRef);
      }
      classValue.Name = new LocRef(nameScopeLoc, classNameRef);
    }

    this.popScope();

    // Sanity check that the class lowering info hasn't changed before and after visiting.
    const after = computeClassLoweringInfo(this, classValue);
    if (
      loweringInfo.lowerAllInstanceFields !== after.lowerAllInstanceFields ||
      loweringInfo.lowerAllStaticFields !== after.lowerAllStaticFields ||
      loweringInfo.shimSuperCtorCalls !== after.shimSuperCtorCalls
    ) {
      throw new Error("Internal error");
    }

    return result;
  }

  /** Go: func (p *parser) visitDecorators(decorators []js_ast.Decorator, decoratorScope *js_ast.Scope) []js_ast.Decorator (js_parser.go:12145) */
  visitDecorators(decorators: js_ast.Decorator[]): js_ast.Decorator[] {
    // Go 会临时把 currentScope 切到 decoratorScope（参数装饰器的生成代码落在类外层）；
    // M1 默认不启用实验装饰器，这里只做值遍历，作用域切换留给 K 批。
    for (let i = 0; i < decorators.length; i++) {
      decorators[i].Value = this.visitExpr(decorators[i].Value);
    }
    return decorators;
  }

  /** Go: func (p *parser) valueForThis(loc logger.Loc, shouldLog bool, assignTarget js_ast.AssignTarget, isCallTarget bool, isDeleteTarget bool) (js_ast.Expr, bool) (js_parser.go:13282) */
  valueForThis(
    loc: Loc,
    shouldLog: boolean,
    assignTargetValue: number,
    isDeleteTarget: boolean,
    isCallTarget: boolean,
  ): js_ast.Expr | null {
    void shouldLog; void assignTargetValue; void isDeleteTarget; void isCallTarget;
    // Go: defines.IdentifierDefines["this"] 的替换（H 批）；shouldReplaceThisWithInnerClassNameRef 依赖 fnOnlyDataVisit（E-s6）

    // Is this a top-level use of "this"?
    if (!this.isThisNested) {
      // Go: 顶层 this 在 ESM 文件里替换成 undefined（MsgID_JS_ThisIsUndefinedInESM 的日志在 M2 的消息通道）
      if (this.isFileConsideredToHaveESMExports) {
        return new js_ast.Expr(js_ast.EUndefinedShared, loc);
      }
      // Go: CJS 里替换成 exports；TS 的 Parse 还没建 exportsRef（M2），此时按不替换处理
      if (this.options.mode !== 0 && this.exportsRef !== null) {
        this.recordUsage(this.exportsRef);
        return new js_ast.Expr(new js_ast.EIdentifier(this.exportsRef), loc);
      }
    }

    return null;
  }

  /** Go: func (p *parser) valueForImportMeta(loc logger.Loc) (js_ast.Expr, bool) (js_parser.go:13337) */
  valueForImportMeta(loc: Loc): js_ast.Expr | null {
    const keepESM = this.options.outputFormat === 3; // Go: Format.KeepESMImportExportSyntax()
    if ((this.options.unsupportedJSFeatures & JSFeature.ImportMeta) !== 0n ||
      (this.options.mode !== 0 && !keepESM)) {
      if (this.importMetaRef.InnerIndex === InvalidRef.InnerIndex) {
        this.importMetaRef = this.newSymbol(SymbolKind.SymbolOther, "import_meta");
        this.moduleScope!.Generated.push(this.importMetaRef);
      }
      this.recordUsage(this.importMetaRef);
      return new js_ast.Expr(new js_ast.EIdentifier(this.importMetaRef), loc);
    }

    return null;
  }

  /** Go: func (p *parser) visitFn(fn *js_ast.Fn, scopeLoc logger.Loc, opts visitFnOpts) (js_parser.go:17205) */
  visitFn(fn: js_ast.Fn, scopeLoc: Loc): void {
    const oldIsThisNested = this.isThisNested;
    const oldFnOrArrow = { ...this.fnOrArrowDataVisit };
    const oldFnOnly = { ...this.fnOnlyDataVisit };
    this.isThisNested = true;
    // Go: js_parser.go:17210 —— async/generator 降级状态
    this.fnOrArrowDataVisit.isAsync = fn.IsAsync;
    this.fnOrArrowDataVisit.isGenerator = fn.IsGenerator;
    this.fnOrArrowDataVisit.isArrow = false;
    this.fnOrArrowDataVisit.isOutsideFnOrArrow = false;
    // Go: shouldLowerSuperPropertyAccess 由 class lowering 路径设置；此处不再为 async 提前置位——
    // 独立 async 函数里的 `super.x`（非法语法）在骨架里会缺 __super 符号而崩，保持原 false 更安全。
    if (fn.Name !== null) this.recordDeclaredSymbol(fn.Name.Ref);

    this.pushScopeForVisitPass(js_ast.ScopeKind.ScopeFunctionArgs, scopeLoc);
    this.visitArgs(fn.Args, {
      body: fn.Body.Block.Stmts,
      hasRestArg: fn.HasRestArg,
      isUniqueFormalParameters: fn.IsUniqueFormalParameters,
    });
    this.pushScopeForVisitPass(js_ast.ScopeKind.ScopeFunctionBody, fn.Body.Loc);
    // Go: validateDeclaredSymbolName（strict 闭包，§2.2 #2）
    fn.Body.Block.Stmts = this.visitStmtsAndPrependTempRefs(fn.Body.Block.Stmts, stmtsKind.stmtsFnBody);
    this.popScope();
    // Go: js_parser.go:17244 —— lowerFunction（async/对象 rest 参数降级）
    lowerFunction(this, fn, false);
    this.popScope();
    this.isThisNested = oldIsThisNested;
    this.fnOrArrowDataVisit = oldFnOrArrow;
    this.fnOnlyDataVisit = oldFnOnly;
  }

  /** Go: func (p *parser) visitArgs(args []js_ast.Arg, opts visitArgsOpts) (js_parser.go:12586) */
  visitArgs(args: js_ast.Arg[], opts: { body: js_ast.Stmt[]; hasRestArg: boolean; isUniqueFormalParameters: boolean }): void {
    let duplicateArgCheck: Map<string, Range> | null = null;
    const useStrictLoc = fnBodyContainsUseStrict(opts.body);
    const hasSimpleArgs = isSimpleParameterList(args, opts.hasRestArg);

    // Section 15.2.1 Static Semantics: Early Errors
    if (useStrictLoc !== null && !hasSimpleArgs) {
      AddError(this.log, this.tracker, this.source.RangeOfString(useStrictLoc),
        'Cannot use a "use strict" directive in a function with a non-simple parameter list');
    }

    // Section 15.1.1 Static Semantics: Early Errors
    // Go 还带 p.isStrictMode()；strict 闭包未落（§2.2 #2），函数体里的 "use strict" 已由上面的条件覆盖
    if (opts.isUniqueFormalParameters || useStrictLoc !== null || !hasSimpleArgs) {
      duplicateArgCheck = new Map();
    }

    for (const arg of args) {
      // Go: visitDecorators（实验装饰器；M1 不触发）
      this.visitBinding(arg.Binding, init(new bindingOpts(), { duplicateArgCheck }));
      if (arg.DefaultOrNil !== null) {
        arg.DefaultOrNil = this.visitExpr(arg.DefaultOrNil);
      }
    }
  }

  /** Go: case *js_ast.EArrow（js_parser.go:15855）的 M1 子集 */
  visitArrow(e: js_ast.EArrow, exprLoc: Loc): void {
    const oldIsThisNested = this.isThisNested;
    const oldFnOrArrow = { ...this.fnOrArrowDataVisit };
    const oldFnOnly = { ...this.fnOnlyDataVisit };
    this.isThisNested = true;
    // Go: js_parser.go:15855 —— 箭头函数保存/重置 hasThisUsage（EThis 分支置位）
    const oldHasThisUsage = this.hasThisUsage;
    const oldIsInsideAsyncArrow = this.isInsideAsyncArrowFn;
    this.hasThisUsage = false;
    this.fnOrArrowDataVisit.isAsync = e.IsAsync;
    this.fnOrArrowDataVisit.isGenerator = false;
    this.fnOrArrowDataVisit.isArrow = true;
    this.fnOrArrowDataVisit.isOutsideFnOrArrow = false;
    if (e.IsAsync) this.isInsideAsyncArrowFn = true;
    // 同上：不在 async 箭头里提前置 shouldLowerSuperPropertyAccess（class 路径自理）。
    this.pushScopeForVisitPass(js_ast.ScopeKind.ScopeFunctionArgs, exprLoc);
    this.visitArgs(e.Args, {
      body: e.Body.Block.Stmts,
      hasRestArg: e.HasRestArg,
      isUniqueFormalParameters: true,
    });
    this.pushScopeForVisitPass(js_ast.ScopeKind.ScopeFunctionBody, e.Body.Loc);
    e.Body.Block.Stmts = this.visitStmtsAndPrependTempRefs(e.Body.Block.Stmts, stmtsKind.stmtsFnBody);
    this.popScope();
    // Go: js_parser.go:15888 —— lowerFunction（async 箭头降级 + 对象 rest 参数）
    {
      const wasAsync = e.IsAsync;
      const fn = new js_ast.Fn();
      fn.Args = e.Args;
      fn.Body = e.Body;
      fn.IsAsync = e.IsAsync;
      fn.HasRestArg = e.HasRestArg;
      lowerFunction(this, fn, true);
      e.Args = fn.Args; e.Body = fn.Body; e.IsAsync = fn.IsAsync; e.HasRestArg = fn.HasRestArg;
      // Go: lowerFunction 里 preferExpr=true（async 箭头降级后 body 变成 return __async(...)）
      if (wasAsync && !e.IsAsync) e.PreferExpr = true;
    }
    this.popScope();
    this.isThisNested = oldIsThisNested;
    this.hasThisUsage = oldHasThisUsage;
    this.isInsideAsyncArrowFn = oldIsInsideAsyncArrow;
    this.fnOrArrowDataVisit = oldFnOrArrow;
    this.fnOnlyDataVisit = oldFnOnly;
  }

  /** Go: func (p *parser) newSymbol(kind ast.SymbolKind, name string) ast.Ref */
  newSymbol(kind: SymbolKind, name: string): Ref {
    const ref = new Ref(this.source.Index, this.symbols.length);
    const symbol = new Symbol();
    symbol.Kind = kind;
    symbol.OriginalName = name;
    symbol.Link = InvalidRef;
    this.symbols.push(symbol);
    return ref;
  }

  /** Go: func (p *parser) canMergeSymbols(scope *js_ast.Scope, existing ast.SymbolKind, new ast.SymbolKind) mergeResult (js_parser.go:1391) */
  canMergeSymbols(scope: js_ast.Scope, existing: SymbolKind, newKind: SymbolKind): number {
    if (existing === SymbolKind.SymbolUnbound) {
      return mergeResult.ReplaceWithNew;
    }

    // In TypeScript, imports are allowed to silently collide with symbols within the module
    if (this.options.ts.Parse && existing === SymbolKind.SymbolImport) {
      return mergeResult.ReplaceWithNew;
    }

    // "enum Foo {} enum Foo {}"
    if (newKind === SymbolKind.SymbolTSEnum && existing === SymbolKind.SymbolTSEnum) {
      return mergeResult.KeepExisting;
    }

    // "namespace Foo { ... } enum Foo {}"
    if (newKind === SymbolKind.SymbolTSEnum && existing === SymbolKind.SymbolTSNamespace) {
      return mergeResult.ReplaceWithNew;
    }

    // "namespace Foo { ... } namespace Foo { ... }"
    // "function Foo() {} namespace Foo { ... }"
    // "enum Foo {} namespace Foo { ... }"
    if (newKind === SymbolKind.SymbolTSNamespace) {
      switch (existing) {
        case SymbolKind.SymbolTSNamespace:
        case SymbolKind.SymbolHoistedFunction:
        case SymbolKind.SymbolGeneratorOrAsyncFunction:
        case SymbolKind.SymbolTSEnum:
        case SymbolKind.SymbolClass:
          return mergeResult.KeepExisting;
      }
    }

    // "var foo; var foo;"
    // "var foo; function foo() {}"
    // "function foo() {} var foo;"
    // "function *foo() {} function *foo() {}" but not "{ function *foo() {} function *foo() {} }"
    if (
      ast.IsHoistedOrFunction(newKind) && ast.IsHoistedOrFunction(existing) &&
      (scope.Kind === js_ast.ScopeKind.ScopeEntry ||
        scope.Kind === js_ast.ScopeKind.ScopeFunctionBody ||
        scope.Kind === js_ast.ScopeKind.ScopeFunctionArgs ||
        (newKind === existing && ast.IsHoisted(newKind)))
    ) {
      return mergeResult.ReplaceWithNew;
    }

    // "get #foo() {} set #foo() {}"
    // "set #foo() {} get #foo() {}"
    if (
      (existing === SymbolKind.SymbolPrivateGet && newKind === SymbolKind.SymbolPrivateSet) ||
      (existing === SymbolKind.SymbolPrivateSet && newKind === SymbolKind.SymbolPrivateGet)
    ) {
      return mergeResult.BecomePrivateGetSetPair;
    }
    if (
      (existing === SymbolKind.SymbolPrivateStaticGet && newKind === SymbolKind.SymbolPrivateStaticSet) ||
      (existing === SymbolKind.SymbolPrivateStaticSet && newKind === SymbolKind.SymbolPrivateStaticGet)
    ) {
      return mergeResult.BecomePrivateStaticGetSetPair;
    }

    // "try {} catch (e) { var e }"
    if (existing === SymbolKind.SymbolCatchIdentifier && newKind === SymbolKind.SymbolHoisted) {
      return mergeResult.ReplaceWithNew;
    }

    // "function() { var arguments }"
    if (existing === SymbolKind.SymbolArguments && newKind === SymbolKind.SymbolHoisted) {
      return mergeResult.KeepExisting;
    }

    // "function() { let arguments }"
    if (existing === SymbolKind.SymbolArguments && newKind !== SymbolKind.SymbolHoisted) {
      return mergeResult.OverwriteWithNew;
    }

    return mergeResult.Forbidden;
  }

  /** Go: func (p *parser) addSymbolAlreadyDeclaredError(name string, newLoc logger.Loc, oldLoc logger.Loc) (js_parser.go:1467) */
  addSymbolAlreadyDeclaredError(name: string, newLoc: Loc, oldLoc: Loc): void {
    AddErrorWithNotes(
      this.log,
      this.tracker,
      RangeOfIdentifier(this.source, newLoc),
      `The symbol ${JSON.stringify(name)} has already been declared`,
      [this.tracker.MsgData(
        RangeOfIdentifier(this.source, oldLoc),
        `The symbol ${JSON.stringify(name)} was originally declared here:`,
      )],
    );
  }

  /** Go: func (p *parser) declareSymbol(kind ast.SymbolKind, loc logger.Loc, name string) ast.Ref */
  declareSymbol(kind: SymbolKind, loc: Loc, name: string): Ref {
    // Allocate a new symbol
    let ref = this.newSymbol(kind, name);

    // Check for a collision in the declaring scope
    const existing = this.currentScope!.Members.get(name);
    if (existing !== undefined) {
      const symbol = this.symbols[existing.Ref.InnerIndex];
      switch (this.canMergeSymbols(this.currentScope!, symbol.Kind, kind)) {
        case mergeResult.Forbidden:
          this.addSymbolAlreadyDeclaredError(name, loc, existing.Loc);
          return existing.Ref;
        case mergeResult.KeepExisting:
          ref = existing.Ref;
          break;
        case mergeResult.ReplaceWithNew:
          symbol.Link = ref;
          this.currentScope!.Replaced.push(existing);
          break;
        case mergeResult.BecomePrivateGetSetPair:
          ref = existing.Ref;
          symbol.Kind = SymbolKind.SymbolPrivateGetSetPair;
          break;
        case mergeResult.BecomePrivateStaticGetSetPair:
          ref = existing.Ref;
          symbol.Kind = SymbolKind.SymbolPrivateStaticGetSetPair;
          break;
        case mergeResult.OverwriteWithNew:
          break;
      }
    }

    // Overwrite this name in the declaring scope
    const member = new js_ast.ScopeMember();
    member.Ref = ref;
    member.Loc = loc;
    this.currentScope!.Members.set(name, member);
    return ref;
  }

  /**
   * Go: func (p *parser) hoistSymbols(scope *js_ast.Scope) (js_parser.go:1535)
   *
   * 只落 M1 输出需要的部分：sloppy mode 下块级函数声明的 Annex B 兄弟符号
   * （hoistedRefForSloppyModeBlockFn）。var/let 向上合并、重复声明诊断与
   * MustNotBeRenamed 仅影响重命名/诊断，未在此生效（已在 PLAN 登记为 partial）。
   */
  hoistSymbols(scope: js_ast.Scope): void {
    if (!js_ast.StopsHoisting(scope.Kind)) {
      // 迭代顺序必须确定（Go: scopeMemberArray 按 Ref.InnerIndex / SourceIndex 排序）。
      // DEVIATION（等价）：Go 的 map 遍历是随机的，所以必须 sort；TS 的 Map 是插入有序，
      // 但插入序恰好总是 Ref 升序，sort 就成了恒等变换。这里先 reverse 再造 sort，
      // 让排序（与 Less/Swap）真实发生；结果与 Go 的 Ref 升序一致（Ref 是仐序）。
      // 迭代顺序必须确定（Go: scopeMemberArray 按 Ref.InnerIndex / SourceIndex 排序）。
      // DEVIATION（等价）：Go 的 map 遍历随机、必须 sort；TS 的 Map 是插入有序且恰好总是
      // Ref 升序，直接 sort 恒等。这里先 reverse 再 sort，让排序（包含 Less/Swap）真实发生；
      // Ref 是仐序，结果与 Go 的升序一致。
      const sortedMembers = new scopeMemberArray([...scope.Members.values()].reverse()).sort();
      for (const member of sortedMembers) {
        const symbol = this.symbols[member.Ref.InnerIndex];
        if (symbol.Kind !== SymbolKind.SymbolHoistedFunction) continue;

        // Block-level function declarations behave like "let" in strict mode
        if (scope.StrictMode !== js_ast.StrictModeKind.SloppyMode) continue;

        const hoistedRef = this.newSymbol(SymbolKind.SymbolHoisted, symbol.OriginalName);
        scope.Generated.push(hoistedRef);
        this.hoistedRefForSloppyModeBlockFn.set(member.Ref.InnerIndex, {
          original: member.Ref,
          hoisted: hoistedRef,
        });

        // Check for collisions that would prevent hoisting "var" symbols up to the
        // enclosing function scope（Go: js_parser.go:1647-1716）
        const hoistedSymbol = this.symbols[hoistedRef.InnerIndex];
        let s: js_ast.Scope | null = scope.Parent;
        while (s !== null) {
          const existingMember = s.Members.get(symbol.OriginalName);
          if (existingMember !== undefined) {
            const existingSymbol = this.symbols[existingMember.Ref.InnerIndex];
            if (
              existingSymbol.Kind === SymbolKind.SymbolUnbound ||
              existingSymbol.Kind === SymbolKind.SymbolHoisted ||
              (ast.IsFunction(existingSymbol.Kind) &&
                (s.Kind === js_ast.ScopeKind.ScopeEntry || s.Kind === js_ast.ScopeKind.ScopeFunctionBody))
            ) {
              // Silently merge this symbol into the existing symbol
              hoistedSymbol.Link = existingMember.Ref;
              s.Members.set(symbol.OriginalName, existingMember);
              break;
            }

            // Otherwise if this isn't a catch identifier or "arguments", it's a collision
            if (
              existingSymbol.Kind !== SymbolKind.SymbolCatchIdentifier &&
              existingSymbol.Kind !== SymbolKind.SymbolArguments
            ) {
              // An identifier binding from a catch statement and a function
              // declaration can both silently shadow another hoisted symbol
              if (
                hoistedSymbol.Kind !== SymbolKind.SymbolCatchIdentifier &&
                hoistedSymbol.Kind !== SymbolKind.SymbolHoistedFunction &&
                s === scope.Parent
              ) {
                // Never mind about this, turns out it's not needed after all
                this.hoistedRefForSloppyModeBlockFn.delete(member.Ref.InnerIndex);
              }
              break;
            }

            // If this is a catch identifier, silently merge the existing symbol
            // into this symbol but continue hoisting past this catch scope
            existingSymbol.Link = member.Ref;
            s.Members.set(symbol.OriginalName, member);
          }

          if (js_ast.StopsHoisting(s.Kind)) {
            // Declare the member in the scope that stopped the hoisting
            s.Members.set(symbol.OriginalName, member);
            break;
          }
          s = s.Parent;
        }
      }
    }

    for (const child of scope.Children) this.hoistSymbols(child);
  }

  // -------------------------------------------------------------------------
  // 第 25 轮 Step 2：visit pass 递归（F-s1b）
  // -------------------------------------------------------------------------

  /** Go: func (p *parser) visitStmtsAndPrependTempRefs(stmts []js_ast.Stmt, opts prependTempRefsOpts) []js_ast.Stmt (js_parser.go:8884) */
  visitStmtsAndPrependTempRefs(stmts: js_ast.Stmt[], kind: stmtsKind = stmtsKind.stmtsNormal): js_ast.Stmt[] {
    // Go: js_parser.go:8884-8947 —— 保存/清空 tempRefsToDeclare，visit 后把生成的临时变量前置为 var 声明。
    const oldTempRefs = this.tempRefsToDeclare;
    this.tempRefsToDeclare = [];
    stmts = this.visitStmts(stmts, kind);
    // 顶层专用临时变量并入（Go 8885-8916）；Parse 末尾也会处理残留，这里保持一致。
    if (this.currentScope === this.moduleScope && this.topLevelTempRefsToDeclare.length > 0) {
      for (const r of this.topLevelTempRefsToDeclare) this.tempRefsToDeclare.push({ ref: r });
      this.topLevelTempRefsToDeclare = [];
    }
    const decls: js_ast.Decl[] = [];
    for (const temp of this.tempRefsToDeclare) {
      if (this.symbols[temp.ref.InnerIndex].UseCountEstimate > 0) {
        decls.push(init(new js_ast.Decl(), {
          Binding: init(new js_ast.Binding(), { Data: new js_ast.BIdentifier(temp.ref) }),
          ValueOrNil: temp.valueOrNil ?? null,
        }));
        this.recordDeclaredSymbol(temp.ref);
      }
    }
    if (decls.length > 0) {
      let split = 0;
      while (split < stmts.length && (stmts[split].Data instanceof js_ast.SComment || stmts[split].Data instanceof js_ast.SDirective)) split++;
      stmts = [
        ...stmts.slice(0, split),
        new js_ast.Stmt(init(new js_ast.SLocal(), { Kind: js_ast.LocalKind.LocalVar, Decls: decls })),
        ...stmts.slice(split),
      ];
    }
    this.tempRefsToDeclare = oldTempRefs;
    return stmts;
  }

  /** Go: func (p *parser) visitStmts(stmts []js_ast.Stmt, kind stmtsKind) []js_ast.Stmt (js_parser.go:8960) 的 M1 子集 */
  visitStmts(stmts: js_ast.Stmt[], kind: stmtsKind = stmtsKind.stmtsNormal): js_ast.Stmt[] {
    const visited: js_ast.Stmt[] = [];
    const before: js_ast.Stmt[] = [];
    for (const stmt of stmts) {
      const s = stmt.Data;
      if (
        s instanceof js_ast.SFunction && s.Fn.Name !== null &&
        !js_ast.StopsHoisting(this.currentScope!.Kind) &&
        this.symbols[s.Fn.Name.Ref.InnerIndex].Kind === SymbolKind.SymbolHoistedFunction
      ) {
        // Go: 块级函数声明先 visit，再降级成 let + var（Annex B）
        this.visitAndAppendStmt(before, stmt);
        continue;
      }
      this.visitAndAppendStmt(visited, stmt);
    }
    let result = visited;
    if (before.length > 0) result = [...this.lowerBlockLevelFnsForVisit(before), ...visited];

    // Go: js_parser.go:9118-9123 —— Lower using declarations（第 109 批）
    if (shouldLowerUsingDeclarations(this, result)) {
      const ctx = lowerUsingDeclarationContext(this);
      ctx.scanStmts(this, result);
      result = ctx.finalize(this, result, this.currentScope!.Parent === null);
    }

    // Go: js_parser.go:9130-9153 —— 死分支里只保留必要语句（并合并相邻 var），不再做 mangleStmts
    if (this.options.minifySyntax && this.isControlFlowDead) {
      const kept: js_ast.Stmt[] = [];
      for (const stmt of result) {
        if (!shouldKeepStmtInDeadControlFlow(stmt)) continue;
        const d = stmt.Data;
        if (d instanceof js_ast.SLocal && d.Kind === js_ast.LocalKind.LocalVar && kept.length > 0) {
          const prevData = kept[kept.length - 1].Data;
          if (prevData instanceof js_ast.SLocal && prevData.Kind === js_ast.LocalKind.LocalVar && d.IsExport === prevData.IsExport) {
            prevData.Decls = prevData.Decls.concat(d.Decls);
            continue;
          }
        }
        kept.push(stmt);
      }
      return kept;
    }

    // Go: js_parser.go:9153 —— minify 时才做 mangleStmts。
    // 接线地基（本轮）：先接调用点；mangleStmts 的完整实现随后填入（G-3）。
    // 桩阶段返回入参，保证接线本身不改变③通道输出。
    // G-3 落地前用非同名桩，避免空函数体被 progress 算作「已移植未测试」
    if (this.options.minifySyntax || this.options.minifyWhitespace) return this.mangleStmtsWiring(result, kind);
    return result;
  }



  /** Go: func (p *parser) mangleIf(stmts []js_ast.Stmt, loc logger.Loc, s *js_ast.SIf) []js_ast.Stmt (js_parser.go:10246) */
  mangleIf(stmts: js_ast.Stmt[], loc: Loc, s: js_ast.SIf): js_ast.Stmt[] {
    const AH = js_ast_helpers;
    const nilNo = (): boolean => s.NoOrNil === null || s.NoOrNil.Data === null;
    const uf = this.options.unsupportedJSFeatures;

    // Constant folding using the test expression
    const [boolVal, sideEffects, boolOk] = AH.ToBooleanWithSideEffects(s.Test.Data);
    if (boolOk) {
      if (boolVal) {
        if (nilNo() || !shouldKeepStmtInDeadControlFlow(s.NoOrNil!)) {
          if (sideEffects === AH.CouldHaveSideEffects) {
            const test = this.astHelpers.SimplifyUnusedExpr(s.Test, uf);
            if (test.Data !== null) { const se=new js_ast.SExpr(); se.Value=test; stmts.push(new js_ast.Stmt(se, s.Test.Loc)); }
          }
          return this.appendIfOrLabelBodyPreservingScope(stmts, s.Yes);
        }
      } else {
        if (!shouldKeepStmtInDeadControlFlow(s.Yes)) {
          if (sideEffects === AH.CouldHaveSideEffects) {
            const test = this.astHelpers.SimplifyUnusedExpr(s.Test, uf);
            if (test.Data !== null) { const se=new js_ast.SExpr(); se.Value=test; stmts.push(new js_ast.Stmt(se, s.Test.Loc)); }
          }
          if (nilNo()) return stmts;
          return this.appendIfOrLabelBodyPreservingScope(stmts, s.NoOrNil!);
        }
      }
      if (sideEffects === AH.NoSideEffects) {
        s.Test.Data = new js_ast.ENumber(boolVal ? 1 : 0);
      }
    }

    let expr: js_ast.Expr | null = null;
    const yesExpr = s.Yes.Data instanceof js_ast.SExpr ? (s.Yes.Data as js_ast.SExpr) : null;
    const noExpr = !nilNo() && s.NoOrNil!.Data instanceof js_ast.SExpr ? (s.NoOrNil!.Data as js_ast.SExpr) : null;

    if (yesExpr !== null) {
      if (nilNo()) {
        if (s.Test.Data instanceof js_ast.EUnary && (s.Test.Data as js_ast.EUnary).Op === js_ast.OpCode.UnOpNot) {
          expr = AH.JoinWithLeftAssociativeOp(js_ast.OpCode.BinOpLogicalOr, (s.Test.Data as js_ast.EUnary).Value, yesExpr.Value);
        } else {
          expr = AH.JoinWithLeftAssociativeOp(js_ast.OpCode.BinOpLogicalAnd, s.Test, yesExpr.Value);
        }
      } else if (noExpr !== null) {
        const iff = new js_ast.EIf(); iff.Test = s.Test; iff.Yes = yesExpr.Value; iff.No = noExpr.Value;
        expr = this.astHelpers.MangleIfExpr(loc, iff, uf);
      }
    } else if (s.Yes.Data instanceof js_ast.SEmpty) {
      if (nilNo()) {
        if (this.astHelpers.ExprCanBeRemovedIfUnused(s.Test)) {
          return stmts;
        } else {
          expr = s.Test;
        }
      } else if (noExpr !== null) {
        if (s.Test.Data instanceof js_ast.EUnary && (s.Test.Data as js_ast.EUnary).Op === js_ast.OpCode.UnOpNot) {
          expr = AH.JoinWithLeftAssociativeOp(js_ast.OpCode.BinOpLogicalAnd, (s.Test.Data as js_ast.EUnary).Value, noExpr.Value);
        } else {
          expr = AH.JoinWithLeftAssociativeOp(js_ast.OpCode.BinOpLogicalOr, s.Test, noExpr.Value);
        }
      } else {
        if (s.Test.Data instanceof js_ast.EUnary && (s.Test.Data as js_ast.EUnary).Op === js_ast.OpCode.UnOpNot) {
          s.Test = (s.Test.Data as js_ast.EUnary).Value;
          s.Yes = s.NoOrNil!; s.NoOrNil = null;
        } else {
          s.Test = AH.Not(s.Test);
          s.Yes = s.NoOrNil!; s.NoOrNil = null;
        }
      }
    } else {
      if (!nilNo()) {
        if (s.Test.Data instanceof js_ast.EUnary && (s.Test.Data as js_ast.EUnary).Op === js_ast.OpCode.UnOpNot) {
          s.Test = (s.Test.Data as js_ast.EUnary).Value;
          const t = s.Yes; s.Yes = s.NoOrNil!; s.NoOrNil = t;
        }
      } else {
        if (s.Yes.Data instanceof js_ast.SIf && (s.Yes.Data as js_ast.SIf).NoOrNil === null) {
          const s2 = s.Yes.Data as js_ast.SIf;
          s.Test = AH.JoinWithLeftAssociativeOp(js_ast.OpCode.BinOpLogicalAnd, s.Test, s2.Test);
          s.Yes = s2.Yes;
        }
      }
    }

    if (expr !== null && expr.Data !== null) {
      expr = this.astHelpers.SimplifyUnusedExpr(expr, uf);
      const se = new js_ast.SExpr(); se.Value = expr;
      stmts.push(new js_ast.Stmt(se, loc));
      return stmts;
    }
    stmts.push(new js_ast.Stmt(s, loc));
    return stmts;
  }

  /**
   * Go: func (p *parser) mangleStmts(stmts []js_ast.Stmt, kind stmtsKind) []js_ast.Stmt (js_parser.go:9156)
   * 第 36 轮：接进 visitStmts 主链的真实实现。覆盖 strip-empty / 去副作用语句 / 合并相邻
   * local/expr / expr 吸收进控制流 / 控制流死代码裁剪 / 尾部 jump / 反向合并 return-if 等分支。
   * 未移植的 constValues 常量移除与 single-use 内联两块保持 no-op（不产生字节差异，M1 不触发）。
   */
  mangleStmts(stmts: js_ast.Stmt[], kind: stmtsKind): js_ast.Stmt[] {
    let result: js_ast.Stmt[] = [];
    let isControlFlowDead = false;

    const noData = (s: { Data: unknown } | null): boolean => s === null || s.Data === null;

    for (let i = 0; i < stmts.length; i++) {
      let stmt = stmts[i];

      if (isControlFlowDead && !shouldKeepStmtInDeadControlFlow(stmt)) continue;

      // Go: js_parser.go:9200-9275 —— 内联单次使用的局部声明（仅嵌套作用域、无直接 eval）
      if (this.currentScope !== this.moduleScope && !this.currentScope!.ContainsDirectEval) {
        for (;;) {
          const prevData = result.length > 0 ? result[result.length - 1].Data : null;
          if (!(prevData instanceof js_ast.SLocal) ||
              (prevData.Kind !== js_ast.LocalKind.LocalLet && prevData.Kind !== js_ast.LocalKind.LocalConst)) break;
          const prevS = prevData as js_ast.SLocal;
          const last = prevS.Decls[prevS.Decls.length - 1];
          if (last === undefined || !(last.Binding.Data instanceof js_ast.BIdentifier)) break;
          const id = last.Binding.Data as js_ast.BIdentifier;
          const sym = this.symbols[id.Ref.InnerIndex];
          if (sym.UseCountEstimate !== 1 || (sym.Flags & ast.SymbolFlags.DidKeepName) !== 0) break;
          let replacement = last.ValueOrNil;
          if (replacement === null || replacement.Data === null) {
            replacement = new js_ast.Expr(js_ast.EUndefinedShared, last.Binding.Loc);
          }
          if (this.substituteSingleUseSymbolInStmt(stmt, id.Ref, replacement)) {
            if (prevS.Decls.length === 1) result.pop();
            else prevS.Decls.pop();
            continue;
          }
          break;
        }
      }

      const s = stmt.Data;
      if (s === null) continue;

      if (s instanceof js_ast.SEmpty) {
        continue;
      } else if (s instanceof js_ast.SLocal) {
        // 合并相邻同类 local
        if (result.length > 0) {
          const prevS = result[result.length - 1].Data;
          if (prevS instanceof js_ast.SLocal && s.Kind === prevS.Kind && s.IsExport === prevS.IsExport) {
            prevS.Decls = prevS.Decls.concat(s.Decls);
            continue;
          }
        }
      } else if (s instanceof js_ast.SExpr) {
        // 去副作用表达式
        s.Value = this.astHelpers.SimplifyUnusedExpr(s.Value, this.options.unsupportedJSFeatures);
        if (s.Value.Data === null) continue;
        // 合并相邻表达式
        if (result.length > 0) {
          const prevS = result[result.length - 1].Data;
          if (prevS instanceof js_ast.SExpr) {
            if (!s.IsFromClassOrFnThatCanBeRemovedIfUnused) prevS.IsFromClassOrFnThatCanBeRemovedIfUnused = false;
            prevS.Value = js_ast_helpers.JoinWithComma(prevS.Value, s.Value);
            continue;
          }
        }
      } else if (s instanceof js_ast.SSwitch) {
        if (result.length > 0) {
          const prevS = result[result.length - 1].Data;
          if (prevS instanceof js_ast.SExpr) {
            s.Test = js_ast_helpers.JoinWithComma(prevS.Value, s.Test);
            result.pop();
          }
        }
      } else if (s instanceof js_ast.SIf) {
        if (result.length > 0) {
          const prevS = result[result.length - 1].Data;
          if (prevS instanceof js_ast.SExpr) {
            s.Test = js_ast_helpers.JoinWithComma(prevS.Value, s.Test);
            result.pop();
          }
        }
        // 吸收前一条相同 jump 的 if："if(a) return c; if(b) return c;" => "if(a||b) return c;"
        if (isJumpStatement(s.Yes.Data)) {
          if (result.length > 0) {
            const prevS = result[result.length - 1].Data;
            if (prevS instanceof js_ast.SIf && noData(prevS.NoOrNil) && jumpStmtsLookTheSame(prevS.Yes.Data, s.Yes.Data)) {
              s.Test = js_ast_helpers.JoinWithLeftAssociativeOp(js_ast.OpCode.BinOpLogicalOr, prevS.Test, s.Test);
              result.pop();
            }
          }
          // else-if 链拉平
          if (!noData(s.NoOrNil)) {
            let curS: js_ast.SIf = s;
            while (true) {
              result.push(stmt);
              stmt = curS.NoOrNil!;
              curS.NoOrNil = null;
              const nextS = stmt.Data;
              if (!(nextS instanceof js_ast.SIf) || !isJumpStatement(nextS.Yes.Data) || !noData(nextS.NoOrNil)) break;
              curS = nextS;
            }
            result = this.appendIfOrLabelBodyPreservingScope(result, stmt);
            if (isJumpStatement(stmt.Data)) isControlFlowDead = true;
            continue;
          }
        }
        // Go mangleStmts SIf: run mangleIf for constant folding / if→expr
        {
          const merged = this.mangleIf([], stmt.Loc, s as js_ast.SIf);
          if (merged.length > 0) { result.push(...merged); continue; }
        }
      } else if (s instanceof js_ast.SReturn) {
        if (result.length > 0 && !noData(s.ValueOrNil)) {
          const prevS = result[result.length - 1].Data;
          if (prevS instanceof js_ast.SExpr) {
            { const nr = new js_ast.SReturn(); nr.ValueOrNil = js_ast_helpers.JoinWithComma(prevS.Value, s.ValueOrNil!); result[result.length - 1] = new js_ast.Stmt(nr, result[result.length - 1].Loc); }
            continue;
          }
        }
        isControlFlowDead = true;
      } else if (s instanceof js_ast.SThrow) {
        if (result.length > 0 && s.Value.Data !== null) {
          const prevS = result[result.length - 1].Data;
          if (prevS instanceof js_ast.SExpr) {
            const th = new js_ast.SThrow(); th.Value = js_ast_helpers.JoinWithComma(prevS.Value, s.Value);
            result[result.length - 1] = new js_ast.Stmt(th, result[result.length - 1].Loc);
            continue;
          }
        }
        isControlFlowDead = true;
      } else if (s instanceof js_ast.SBreak || s instanceof js_ast.SContinue) {
        isControlFlowDead = true;
      } else if (s instanceof js_ast.SFor) {
        if (result.length > 0) {
          const prevStmt = result[result.length - 1];
          const prevS = prevStmt.Data;
          if (prevS instanceof js_ast.SExpr) {
            if (s.InitOrNil === null || s.InitOrNil.Data === null) {
              result[result.length - 1] = stmt;
              const ie = new js_ast.SExpr(); ie.Value = prevS.Value;
              s.InitOrNil = new js_ast.Stmt(ie, prevStmt.Loc);
              continue;
            } else if (s.InitOrNil.Data instanceof js_ast.SExpr) {
              result[result.length - 1] = stmt;
              const ie = new js_ast.SExpr(); ie.Value = js_ast_helpers.JoinWithComma(prevS.Value, (s.InitOrNil.Data as js_ast.SExpr).Value);
              s.InitOrNil = new js_ast.Stmt(ie, prevStmt.Loc);
              continue;
            }
          } else if (prevS instanceof js_ast.SLocal && prevS.Kind === js_ast.LocalKind.LocalVar && !prevS.IsExport) {
            if (s.InitOrNil === null || s.InitOrNil.Data === null) {
              result[result.length - 1] = stmt;
              s.InitOrNil = prevStmt;
              continue;
            } else if (s.InitOrNil.Data instanceof js_ast.SLocal && (s.InitOrNil.Data as js_ast.SLocal).Kind === js_ast.LocalKind.LocalVar) {
              result[result.length - 1] = stmt;
              const merged = new js_ast.SLocal();
              merged.Kind = js_ast.LocalKind.LocalVar;
              merged.Decls = prevS.Decls.concat((s.InitOrNil.Data as js_ast.SLocal).Decls);
              s.InitOrNil.Data = merged;
              continue;
            }
          }
        }
      } else if (s instanceof js_ast.STry) {
        // 去掉未使用的 catch 绑定（Go :9510）
        const oc = (s as js_ast.STry).Catch;
        if (oc && oc.BindingOrNil !== null && oc.BindingOrNil.Data instanceof js_ast.BIdentifier) {
          const id = (oc.BindingOrNil.Data as js_ast.BIdentifier).Ref;
          if (this.symbols[id.InnerIndex].UseCountEstimate === 0 && !(this.currentScope && this.currentScope.ContainsDirectEval)) {
            oc.BindingOrNil.Data = null;
          }
        }
      }

      result.push(stmt);
    }

    // 尾部无条件 jump
    if (result.length > 0) {
      const last = result[result.length - 1].Data;
      if (kind === stmtsKind.stmtsLoopBody) {
        if (last instanceof js_ast.SContinue && last.Label === null) result.pop();
      } else if (kind === stmtsKind.stmtsFnBody) {
        if (last instanceof js_ast.SReturn) {
          if (noData(last.ValueOrNil)) result.pop();
          else if (last.ValueOrNil!.Data instanceof js_ast.EUnary && (last.ValueOrNil!.Data as js_ast.EUnary).Op === js_ast.OpCode.UnOpVoid) {
            const se = new js_ast.SExpr(); se.Value = (last.ValueOrNil!.Data as js_ast.EUnary).Value;
            result[result.length - 1].Data = se;
          }
        }
      }
    }

    // 反向合并 return（if-return 链 → 三元）
    if (result.length >= 2) {
      let lastStmt = result[result.length - 1];
      if (lastStmt.Data instanceof js_ast.SReturn) {
        let lastReturn = lastStmt.Data as js_ast.SReturn;
        returnLoop: while (result.length >= 2) {
          const prevIndex = result.length - 2;
          const prevStmt = result[prevIndex];
          const prevS = prevStmt.Data;
          if (prevS instanceof js_ast.SExpr) {
            if (noData(lastReturn.ValueOrNil)) break returnLoop;
            { const nr = new js_ast.SReturn(); nr.ValueOrNil = js_ast_helpers.JoinWithComma(prevS.Value, lastReturn.ValueOrNil!); lastReturn = nr; }
            lastStmt = new js_ast.Stmt(lastReturn, prevStmt.Loc);
            result[prevIndex] = lastStmt;
            result.pop();
          } else if (prevS instanceof js_ast.SIf) {
            if (prevS.NoOrNil !== null && prevS.NoOrNil.Data !== null) break returnLoop;
            if (!(prevS.Yes.Data instanceof js_ast.SReturn)) break returnLoop;
            const prevReturn = prevS.Yes.Data as js_ast.SReturn;
            let left = prevReturn.ValueOrNil;
            let right = lastReturn.ValueOrNil;
            if (noData(left)) left = new js_ast.Expr(js_ast.EUndefinedShared, prevS.Yes.Loc);
            if (noData(right)) right = new js_ast.Expr(js_ast.EUndefinedShared, lastStmt.Loc);
            if (prevS.Test.Data instanceof js_ast.EUnary && (prevS.Test.Data as js_ast.EUnary).Op === js_ast.OpCode.UnOpNot) {
              prevS.Test = (prevS.Test.Data as js_ast.EUnary).Value;
              const t = left; left = right; right = t;
            }
            let value: js_ast.Expr;
            if (prevS.Test.Data instanceof js_ast.EBinary && (prevS.Test.Data as js_ast.EBinary).Op === js_ast.OpCode.BinOpComma) {
              const comma = prevS.Test.Data as js_ast.EBinary;
              const iff = new js_ast.EIf(); iff.Test = comma.Right; iff.Yes = left; iff.No = right;
              value = js_ast_helpers.JoinWithComma(comma.Left, this.astHelpers.MangleIfExpr(comma.Right.Loc, iff, this.options.unsupportedJSFeatures));
            } else {
              const iff = new js_ast.EIf(); iff.Test = prevS.Test; iff.Yes = left; iff.No = right;
              value = this.astHelpers.MangleIfExpr(prevS.Test.Loc, iff, this.options.unsupportedJSFeatures);
            }
            { const nr = new js_ast.SReturn(); nr.ValueOrNil = value; lastReturn = nr; }
            lastStmt = new js_ast.Stmt(lastReturn, prevStmt.Loc);
            result[prevIndex] = lastStmt;
            result.pop();
          } else {
            break returnLoop;
          }
        }
      }
    }

    return result;
  }

  /** Go: func (p *parser) substituteSingleUseSymbolInStmt(stmt js_ast.Stmt, ref ast.Ref, replacement js_ast.Expr) bool (js_parser.go:9676) */
  private substituteSingleUseSymbolInStmt(stmt: js_ast.Stmt, ref: Ref, replacement: js_ast.Expr): boolean {
    let getExpr: () => js_ast.Expr | null = () => null;
    let setExpr: (e: js_ast.Expr) => void = () => {};
    const s = stmt.Data;
    if (s instanceof js_ast.SExpr) {
      getExpr = () => s.Value;
      setExpr = (e) => { s.Value = e; };
    } else if (s instanceof js_ast.SThrow) {
      getExpr = () => s.Value;
      setExpr = (e) => { s.Value = e; };
    } else if (s instanceof js_ast.SReturn) {
      getExpr = () => s.ValueOrNil;
      setExpr = (e) => { s.ValueOrNil = e; };
    } else if (s instanceof js_ast.SIf) {
      getExpr = () => s.Test;
      setExpr = (e) => { s.Test = e; };
    } else if (s instanceof js_ast.SSwitch) {
      getExpr = () => s.Test;
      setExpr = (e) => { s.Test = e; };
    } else if (s instanceof js_ast.SLocal) {
      const first = s.Decls[0];
      if (first !== undefined && first.ValueOrNil !== null && first.ValueOrNil.Data !== null &&
          first.Binding.Data instanceof js_ast.BIdentifier) {
        getExpr = () => first.ValueOrNil!;
        setExpr = (e) => { first.ValueOrNil = e; };
      }
    }
    const expr = getExpr();
    if (expr !== null && expr.Data !== null) {
      const replacementCanBeRemoved = this.astHelpers.ExprCanBeRemovedIfUnused(replacement);
      const [newExpr, status] = this.substituteSingleUseSymbolInExpr(expr, ref, replacement, replacementCanBeRemoved);
      if (status === substituteSuccess) { setExpr(newExpr); return true; }
    }
    return false;
  }

  /** Go: func (p *parser) substituteSingleUseSymbolInExpr(...) (js_ast.Expr, substituteStatus) (js_parser.go:9735) */
  private substituteSingleUseSymbolInExpr(
    expr: js_ast.Expr,
    ref: Ref,
    replacement: js_ast.Expr,
    replacementCanBeRemoved: boolean,
  ): [js_ast.Expr, number] {
    const e = expr.Data;
    if (e instanceof js_ast.EIdentifier) {
      if (e.Ref.Equals(ref)) {
        this.ignoreUsage(ref);
        return [replacement, substituteSuccess];
      }
    } else if (e instanceof js_ast.ESpread) {
      const [value, status] = this.substituteSingleUseSymbolInExpr(e.Value, ref, replacement, replacementCanBeRemoved);
      if (status !== substituteContinue) { e.Value = value; return [expr, status]; }
    } else if (e instanceof js_ast.EAwait) {
      const [value, status] = this.substituteSingleUseSymbolInExpr(e.Value, ref, replacement, replacementCanBeRemoved);
      if (status !== substituteContinue) { e.Value = value; return [expr, status]; }
    } else if (e instanceof js_ast.EYield) {
      if (e.ValueOrNil !== null && e.ValueOrNil.Data !== null) {
        const [value, status] = this.substituteSingleUseSymbolInExpr(e.ValueOrNil, ref, replacement, replacementCanBeRemoved);
        if (status !== substituteContinue) { e.ValueOrNil = value; return [expr, status]; }
      }
    } else if (e instanceof js_ast.EImportCall) {
      const [value, status] = this.substituteSingleUseSymbolInExpr(e.Expr, ref, replacement, replacementCanBeRemoved);
      if (status !== substituteContinue) { e.Expr = value; return [expr, status]; }
      if (replacementCanBeRemoved && this.astHelpers.ExprCanBeRemovedIfUnused(e.Expr)) {
        return [expr, substituteContinue];
      }
    } else if (e instanceof js_ast.EUnary) {
      switch (e.Op) {
        case js_ast.OpCode.UnOpPreInc:
        case js_ast.OpCode.UnOpPostInc:
        case js_ast.OpCode.UnOpPreDec:
        case js_ast.OpCode.UnOpPostDec:
        case js_ast.OpCode.UnOpDelete:
          break;
        default: {
          const [value, status] = this.substituteSingleUseSymbolInExpr(e.Value, ref, replacement, replacementCanBeRemoved);
          if (status !== substituteContinue) { e.Value = value; return [expr, status]; }
          break;
        }
      }
    } else if (e instanceof js_ast.EDot) {
      const [value, status] = this.substituteSingleUseSymbolInExpr(e.Target, ref, replacement, replacementCanBeRemoved);
      if (status !== substituteContinue) { e.Target = value; return [expr, status]; }
    } else if (e instanceof js_ast.EBinary) {
      const target = js_ast.BinaryAssignTarget(e.Op);
      if (target === js_ast.AssignTarget.AssignTargetNone) {
        const [value, status] = this.substituteSingleUseSymbolInExpr(e.Left, ref, replacement, replacementCanBeRemoved);
        if (status !== substituteContinue) { e.Left = value; return [expr, status]; }
      } else if (!this.astHelpers.ExprCanBeRemovedIfUnused(e.Left)) {
        return [expr, substituteFailure];
      } else if (target === js_ast.AssignTarget.AssignTargetUpdate && !replacementCanBeRemoved) {
        return [expr, substituteFailure];
      }
      const [value, status] = this.substituteSingleUseSymbolInExpr(e.Right, ref, replacement, replacementCanBeRemoved);
      if (status !== substituteContinue) { e.Right = value; return [expr, status]; }
    } else if (e instanceof js_ast.EIf) {
      const [value, status] = this.substituteSingleUseSymbolInExpr(e.Test, ref, replacement, replacementCanBeRemoved);
      if (status !== substituteContinue) { e.Test = value; return [expr, status]; }
      if (replacementCanBeRemoved) {
        const [yesValue, yesStatus] = this.substituteSingleUseSymbolInExpr(e.Yes, ref, replacement, replacementCanBeRemoved);
        if (yesStatus === substituteSuccess) { e.Yes = yesValue; return [expr, yesStatus]; }
        const [noValue, noStatus] = this.substituteSingleUseSymbolInExpr(e.No, ref, replacement, replacementCanBeRemoved);
        if (noStatus === substituteSuccess) { e.No = noValue; return [expr, noStatus]; }
        if (yesStatus !== substituteContinue || noStatus !== substituteContinue) return [expr, substituteFailure];
      }
    } else if (e instanceof js_ast.EIndex) {
      const [value, status] = this.substituteSingleUseSymbolInExpr(e.Target, ref, replacement, replacementCanBeRemoved);
      if (status !== substituteContinue) { e.Target = value; return [expr, status]; }
      if (replacementCanBeRemoved || e.OptionalChain === js_ast.OptionalChain.OptionalChainNone) {
        const [v2, s2] = this.substituteSingleUseSymbolInExpr(e.Index, ref, replacement, replacementCanBeRemoved);
        if (s2 !== substituteContinue) { e.Index = v2; return [expr, s2]; }
      }
    } else if (e instanceof js_ast.ECall) {
      const isDot = replacement.Data instanceof js_ast.EDot;
      const isIndex = replacement.Data instanceof js_ast.EIndex;
      const targetIsRef = e.Target.Data instanceof js_ast.EIdentifier && e.Target.Data.Ref.Equals(ref);
      if (!(isDot || isIndex) || !targetIsRef) {
        const [value, status] = this.substituteSingleUseSymbolInExpr(e.Target, ref, replacement, replacementCanBeRemoved);
        if (status !== substituteContinue) {
          e.Target = value;
          if (status === substituteSuccess) {
            const iife = this.maybeInlineIIFE(expr.Loc, e);
            if (iife.ok) return [iife.expr, substituteSuccess];
          }
          return [expr, status];
        }
        if (replacementCanBeRemoved || e.OptionalChain === js_ast.OptionalChain.OptionalChainNone) {
          for (let i = 0; i < e.Args.length; i++) {
            const [av, as] = this.substituteSingleUseSymbolInExpr(e.Args[i], ref, replacement, replacementCanBeRemoved);
            if (as !== substituteContinue) { e.Args[i] = av; return [expr, as]; }
          }
        }
      }
    } else if (e instanceof js_ast.EArray) {
      for (let i = 0; i < e.Items.length; i++) {
        const [v, status] = this.substituteSingleUseSymbolInExpr(e.Items[i], ref, replacement, replacementCanBeRemoved);
        if (status !== substituteContinue) { e.Items[i] = v; return [expr, status]; }
      }
    } else if (e instanceof js_ast.EObject) {
      for (let i = 0; i < e.Properties.length; i++) {
        const property = e.Properties[i];
        if ((property.Flags & js_ast.PropertyFlags.PropertyIsComputed) !== 0) {
          const [v, status] = this.substituteSingleUseSymbolInExpr(property.Key, ref, replacement, replacementCanBeRemoved);
          if (status !== substituteContinue) { e.Properties[i].Key = v; return [expr, status]; }
          return [expr, substituteFailure];
        }
        if (property.ValueOrNil !== null && property.ValueOrNil.Data !== null) {
          const [v, status] = this.substituteSingleUseSymbolInExpr(property.ValueOrNil, ref, replacement, replacementCanBeRemoved);
          if (status !== substituteContinue) { e.Properties[i].ValueOrNil = v; return [expr, status]; }
        }
      }
    } else if (e instanceof js_ast.ETemplate) {
      if (e.TagOrNil !== null && e.TagOrNil.Data !== null) {
        const [v, status] = this.substituteSingleUseSymbolInExpr(e.TagOrNil, ref, replacement, replacementCanBeRemoved);
        if (status !== substituteContinue) { e.TagOrNil = v; return [expr, status]; }
      }
      for (let i = 0; i < e.Parts.length; i++) {
        const [v, status] = this.substituteSingleUseSymbolInExpr(e.Parts[i].Value, ref, replacement, replacementCanBeRemoved);
        if (status !== substituteContinue) {
          e.Parts[i].Value = v;
          if (js_ast_helpers.IsPrimitiveLiteral(v.Data)) {
            expr = js_ast_helpers.InlinePrimitivesIntoTemplate(expr.Loc, e);
          }
          return [expr, status];
        }
      }
    }
    if (replacementCanBeRemoved && this.astHelpers.ExprCanBeRemovedIfUnused(expr)) return [expr, substituteContinue];
    if (js_ast_helpers.IsPrimitiveLiteral(expr.Data) || js_ast_helpers.IsPrimitiveLiteral(replacement.Data)) return [expr, substituteContinue];
    return [expr, substituteFailure];
  }

  /** Go: func (p *parser) minifySwitchStmt(loc logger.Loc, s *js_ast.SSwitch, stmts []js_ast.Stmt) []js_ast.Stmt (js_parser.go:11612) */
  private minifySwitchStmt(loc: Loc, s: js_ast.SSwitch, stmts: js_ast.Stmt[]): js_ast.Stmt[] {
    const noData = (x: js_ast.Expr | null): boolean => x === null || x.Data === null;

    // Trim empty cases before a trailing default clause
    if (s.Cases.length > 0) {
      let i = s.Cases.length - 1;
      if (noData(s.Cases[i].ValueOrNil)) {
        while (i > 0 && s.Cases[i - 1].Body.length === 0 &&
               js_ast_helpers.IsPrimitiveLiteral(s.Cases[i - 1].ValueOrNil!.Data)) i--;
        const last = s.Cases[s.Cases.length - 1];
        s.Cases = s.Cases.slice(0, i).concat([last]);
      }
    }

    // Attempt to partially-evaluate statically-determined switch statements
    if (js_ast_helpers.IsPrimitiveLiteral(s.Test.Data)) {
      let allCasesArePrimitives = true;
      let defaultIndex = -1;
      for (let i = 0; i < s.Cases.length; i++) {
        const c = s.Cases[i];
        if (noData(c.ValueOrNil)) defaultIndex = i;
        else if (!js_ast_helpers.IsPrimitiveLiteral(c.ValueOrNil!.Data)) allCasesArePrimitives = false;
      }
      if (allCasesArePrimitives) {
        let takenIndex = -1;
        for (let i = 0; i < s.Cases.length; i++) {
          const [isEqualToTest, ok] = js_ast_helpers.CheckEqualityIfNoSideEffects(
            s.Test.Data, s.Cases[i].ValueOrNil!.Data, js_ast_helpers.StrictEquality);
          if (ok && isEqualToTest) { takenIndex = i; break; }
        }
        if (takenIndex === -1) takenIndex = defaultIndex;
        if (takenIndex !== -1) {
          let isFallThrough = false;
          let liveIndex = -1;
          let end = 0;
          for (let i = 0; i < s.Cases.length; i++) {
            const c = s.Cases[i];
            const isTaken = i === takenIndex;
            if (isTaken) liveIndex = end;
            if (isFallThrough) {
              const live = s.Cases[liveIndex];
              live.Body = live.Body.concat(c.Body);
            } else if (isTaken || c.Body.length > 0) {
              s.Cases[end] = c;
              end++;
            }
            if (isTaken || isFallThrough) isFallThrough = caseBodyCouldHaveFallThrough(c.Body);
          }
          s.Cases = s.Cases.slice(0, end);
        }
      }
    }

    // Handle empty switch statements
    if (s.Cases.length === 0) {
      if (this.astHelpers.ExprCanBeRemovedIfUnused(s.Test)) return stmts;
      const se = new js_ast.SExpr();
      se.Value = s.Test;
      return stmts.concat([new js_ast.Stmt(se, s.Test.Loc)]);
    }

    // Handle a switch statement containing only a "default" clause
    if (s.Cases.length === 1) {
      const c = s.Cases[0];
      if (noData(c.ValueOrNil) && this.astHelpers.ExprCanBeRemovedIfUnused(s.Test)) {
        const inlined = this.tryToInlineCaseBody(s.BodyLoc, c.Body, s.CloseBraceLoc);
        if (inlined.ok) return stmts.concat(inlined.stmts);
      }
    }

    // Try to turn this into an if-else statement
    let yesCase: js_ast.Case | null = null;
    let noCase: js_ast.Case | null = null;
    if (s.Cases.length === 1) {
      if (!noData(s.Cases[0].ValueOrNil)) yesCase = s.Cases[0];
    } else if (s.Cases.length === 2) {
      const first = s.Cases[0];
      const second = s.Cases[1];
      if (!noData(first.ValueOrNil) && !caseBodyCouldHaveFallThrough(first.Body) && noData(second.ValueOrNil)) {
        yesCase = first;
        noCase = second;
      }
      if (noData(first.ValueOrNil) && !caseBodyCouldHaveFallThrough(first.Body) && !noData(second.ValueOrNil)) {
        yesCase = second;
        noCase = first;
      }
    }
    if (yesCase !== null && !noData(yesCase.ValueOrNil)) {
      const yesInlined = this.tryToInlineCaseBody(s.BodyLoc, yesCase.Body, s.CloseBraceLoc);
      const yesBody = yesInlined.stmts;
      if (yesInlined.ok) {
        const noInlined = this.tryToInlineCaseBody(s.BodyLoc, noCase !== null ? noCase.Body : [], s.CloseBraceLoc);
        const noBody = noInlined.stmts;
        if (noInlined.ok) {
          const iff = new js_ast.SIf();
          iff.Test = new js_ast.Expr(null, s.Test.Loc);
          iff.Yes = this.stmtsToSingleStmt(yesCase.Loc, yesBody);
          const [isEqualToTest, ok] = js_ast_helpers.CheckEqualityIfNoSideEffects(
            s.Test.Data, yesCase.ValueOrNil!.Data, js_ast_helpers.StrictEquality);
          if (ok) {
            iff.Test = new js_ast.Expr(new js_ast.EBoolean(isEqualToTest), s.Test.Loc);
          } else {
            iff.Test = new js_ast.Expr(init(new js_ast.EBinary(), {
              Op: js_ast.OpCode.BinOpStrictEq, Left: s.Test, Right: yesCase.ValueOrNil!,
            }), s.Test.Loc);
          }
          if (noBody.length > 0) iff.NoOrNil = this.stmtsToSingleStmt(noCase!.Loc, noBody);
          return this.mangleIf(stmts, loc, iff);
        }
      }
    }

    return stmts.concat([new js_ast.Stmt(s, loc)]);
  }

  /** Go: visitStmts 末尾调用 mangleStmts（js_parser.go:9153）—— 第 36 轮接主链 */
  mangleStmtsWiring(stmts: js_ast.Stmt[], kind: stmtsKind): js_ast.Stmt[] {
    return this.mangleStmts(stmts, kind);
  }

  /** Go: appendIfOrLabelBodyPreservingScope (js_parser.go:10236) */
  appendIfOrLabelBodyPreservingScope(stmts: js_ast.Stmt[], body: js_ast.Stmt): js_ast.Stmt[] {
    const d = body.Data;
    if (d instanceof js_ast.SBlock && !stmtsCareAboutScope(d.Stmts)) {
      return stmts.concat(d.Stmts);
    }
    if (stmtCaresAboutScope(d)) {
      const block = init(new js_ast.SBlock(), { Stmts: [body] });
      return stmts.concat(new js_ast.Stmt(block, body.Loc));
    }
    return stmts.concat(body);
  }

  /** Go: mangleFor(s *js_ast.SFor) (js_parser.go:10184) */
  mangleFor(s: js_ast.SFor): void {
    let first = s.Body;
    const fd = first.Data;
    if (fd instanceof js_ast.SBlock && fd.Stmts.length > 0) first = fd.Stmts[0];
    const id = first.Data;
    if (!(id instanceof js_ast.SIf)) return;
    if (id.Yes.Data instanceof js_ast.SBreak && id.Yes.Data.Label === null) {
      let not: js_ast.Expr;
      const tdata = id.Test.Data;
      if (tdata instanceof js_ast.EUnary && tdata.Op === js_ast.OpCode.UnOpNot) not = tdata.Value;
      else not = js_ast_helpers.Not(id.Test);
      if (s.TestOrNil !== null && s.TestOrNil.Data !== null) {
        s.TestOrNil = new js_ast.Expr(init(new js_ast.EBinary(), {
          Op: js_ast.OpCode.BinOpLogicalAnd, Left: s.TestOrNil, Right: not,
        }), s.TestOrNil.Loc);
      } else {
        s.TestOrNil = not;
      }
      s.Body = dropFirstStatement(s.Body, id.NoOrNil);
      return;
    }
    if (id.NoOrNil !== null && id.NoOrNil.Data !== null &&
        id.NoOrNil.Data instanceof js_ast.SBreak && id.NoOrNil.Data.Label === null) {
      if (s.TestOrNil !== null && s.TestOrNil.Data !== null) {
        s.TestOrNil = new js_ast.Expr(init(new js_ast.EBinary(), {
          Op: js_ast.OpCode.BinOpLogicalAnd, Left: s.TestOrNil, Right: id.Test,
        }), s.TestOrNil.Loc);
      } else {
        s.TestOrNil = id.Test;
      }
      s.Body = dropFirstStatement(s.Body, id.Yes);
    }
  }

  /** Go: maybeTransposeIfExprChain (js_parser.go:11918) */
  maybeTransposeIfExprChain(expr: js_ast.Expr, visit: (e: js_ast.Expr) => js_ast.Expr): js_ast.Expr {
    const e = expr.Data;
    if (e instanceof js_ast.EIf) {
      e.Yes = this.maybeTransposeIfExprChain(e.Yes, visit);
      e.No = this.maybeTransposeIfExprChain(e.No, visit);
      return expr;
    }
    return visit(expr);
  }

  /** Go: keepExprSymbolName (js_parser.go:10373) */
  keepExprSymbolName(value: js_ast.Expr, name: string): js_ast.Expr {
    value = this.callRuntime(value.Loc, "__name", [
      value,
      new js_ast.Expr(new js_ast.EString(utf16FromString(name)), value.Loc),
    ]);
    (value.Data as js_ast.ECall).CanBeUnwrappedIfUnused = true;
    return value;
  }

  /** Go: keepClassOrFnSymbolName (js_parser.go:10383) */
  keepClassOrFnSymbolName(loc: Loc, expr: js_ast.Expr, name: string): js_ast.Stmt {
    const e = init(new js_ast.SExpr(), {
      Value: this.callRuntime(loc, "__name", [
        expr,
        new js_ast.Expr(new js_ast.EString(utf16FromString(name)), loc),
      ]),
      IsFromClassOrFnThatCanBeRemovedIfUnused: true,
    });
    return new js_ast.Stmt(e, loc);
  }

  /** Go: js_parser.go:9050-9115 —— before 里的 SFunction 转成 let 声明（+ hoisted 兄弟的 var） */
  lowerBlockLevelFnsForVisit(before: js_ast.Stmt[]): js_ast.Stmt[] {
    const letDecls: js_ast.Decl[] = [];
    const varDecls: js_ast.Decl[] = [];
    const nonFnStmts: js_ast.Stmt[] = [];
    const fnStmts = new Map<number, number>();
    for (const stmt of before) {
      const s = stmt.Data;
      if (!(s instanceof js_ast.SFunction) || s.Fn.Name === null) {
        // We may get non-function statements here in certain scenarios such as when "KeepNames" is enabled
        nonFnStmts.push(stmt);
        continue;
      }

      // If direct "eval" is present then it's not possible to preserve the semantics
      if (this.currentScope!.ContainsDirectEval) {
        const hoisted = this.hoistedRefForSloppyModeBlockFn.get(s.Fn.Name.Ref.InnerIndex);
        if (hoisted !== undefined) this.symbols[hoisted.hoisted.InnerIndex].Link = s.Fn.Name.Ref;
        nonFnStmts.push(stmt);
        continue;
      }

      let index = fnStmts.get(s.Fn.Name.Ref.InnerIndex);
      if (index === undefined) {
        index = letDecls.length;
        fnStmts.set(s.Fn.Name.Ref.InnerIndex, index);
        letDecls.push(init(new js_ast.Decl(), {
          Binding: init(new js_ast.Binding(), {
            Loc: s.Fn.Name.Loc,
            Data: new js_ast.BIdentifier(s.Fn.Name.Ref),
          }),
        }));

        // Also write the function to the hoisted sibling symbol if applicable
        const hoisted = this.hoistedRefForSloppyModeBlockFn.get(s.Fn.Name.Ref.InnerIndex);
        if (hoisted !== undefined) {
          this.recordDeclaredSymbol(hoisted.hoisted);
          this.recordUsage(s.Fn.Name.Ref);
          varDecls.push(init(new js_ast.Decl(), {
            Binding: init(new js_ast.Binding(), {
              Loc: s.Fn.Name.Loc,
              Data: new js_ast.BIdentifier(hoisted.hoisted),
            }),
            ValueOrNil: new js_ast.Expr(new js_ast.EIdentifier(s.Fn.Name.Ref), s.Fn.Name.Loc),
          }));
        }
      }

      // The last function statement for a given symbol wins
      s.Fn.Name = null;
      letDecls[index].ValueOrNil = new js_ast.Expr(init(new js_ast.EFunction(), { Fn: s.Fn }), stmt.Loc);
    }

    const out: js_ast.Stmt[] = [];
    if (letDecls.length > 0) {
      out.push(new js_ast.Stmt(init(new js_ast.SLocal(), {
        Kind: this.selectLocalKind(js_ast.LocalKind.LocalLet),
        Decls: letDecls,
      }), letDecls[0].ValueOrNil!.Loc));
    }
    if (varDecls.length > 0) {
      out.push(new js_ast.Stmt(init(new js_ast.SLocal(), {
        Kind: js_ast.LocalKind.LocalVar,
        Decls: varDecls,
      }), varDecls[0].ValueOrNil!.Loc));
    }
    out.push(...nonFnStmts);
    return out;
  }

  /** Go: func stmtsToSingleStmt(loc logger.Loc, stmts []js_ast.Stmt, closeBraceLoc logger.Loc) js_ast.Stmt (js_parser.go:10025) */
  stmtsToSingleStmt(loc: Loc, stmts: js_ast.Stmt[]): js_ast.Stmt {
    if (stmts.length === 1) return stmts[0];
    return new js_ast.Stmt(init(new js_ast.SBlock(), { Stmts: stmts }), loc);
  }

  /** Go: func (p *parser) visitLoopBody(stmt js_ast.Stmt) js_ast.Stmt (js_parser.go:9981) */
  visitLoopBody(stmt: js_ast.Stmt): js_ast.Stmt {
    // Go: isInsideLoop=true; p.loopBody = stmt.Data; visitSingleStmt(stmt, stmtsLoopBody)
    return this.visitSingleStmt(stmt, stmtsKind.stmtsLoopBody);
  }

  /** Go: func (p *parser) visitSingleStmt(stmt js_ast.Stmt, kind stmtsKind) js_ast.Stmt (js_parser.go:9990) */
  visitSingleStmt(stmt: js_ast.Stmt, kind: stmtsKind = stmtsKind.stmtsNormal): js_ast.Stmt {
    // To reduce stack depth, special-case blocks and process their children directly
    if (stmt.Data instanceof js_ast.SBlock) {
      this.pushScopeForVisitPass(js_ast.ScopeKind.ScopeBlock, stmt.Loc);
      stmt.Data.Stmts = this.visitStmts(stmt.Data.Stmts, kind);
      this.popScope();
      return stmt;
    }

    // Introduce a fake block scope for function declarations inside if statements
    const s = stmt.Data;
    const hasIfScope = s instanceof js_ast.SFunction && s.Fn.HasIfScope;
    if (hasIfScope) this.pushScopeForVisitPass(js_ast.ScopeKind.ScopeBlock, stmt.Loc);

    const stmts = this.visitStmts([stmt], kind);

    // Balance the fake block scope introduced above
    if (hasIfScope) this.popScope();
    return this.stmtsToSingleStmt(stmt.Loc, stmts);
  }

  /** Go: func (p *parser) recordDeclaredSymbol(ref ast.Ref) (js_parser.go:10063) */
  recordDeclaredSymbol(ref: Ref): void {
    let isTopLevel = this.currentScope === this.moduleScope;

    // Check whether this symbol was hoisted out of a nested scope into the module scope
    if (!isTopLevel) {
      const symbol = this.symbols[ref.InnerIndex];
      const member = this.moduleScope!.Members.get(symbol.OriginalName);
      if (
        ast.IsHoisted(symbol.Kind) && member !== undefined &&
        member.Ref.InnerIndex === ref.InnerIndex && member.Ref.SourceIndex === ref.SourceIndex
      ) {
        isTopLevel = true;
      }
    }

    const declared = new js_ast.DeclaredSymbol();
    declared.Ref = ref;
    declared.IsTopLevel = isTopLevel;
    this.declaredSymbols.push(declared);
  }

  /** Go: func (p *parser) recordUsage(ref ast.Ref) (js_parser.go:1727) */
  recordUsage(ref: Ref): void {
    // 使用计数只影响 minify 的命名；这里只维护符号上的计数（part 级统计不在 M1 通道）。
    this.symbols[ref.InnerIndex].UseCountEstimate++;
  }

  /** Go: func (p *parser) findSymbol(loc logger.Loc, name string) findSymbolResult */  findSymbol(loc: Loc, name: string): Ref | null {
    // SKELETON: Go 的版本还处理 mangled props / TS namespace / direct eval；
    // 骨架只做朴素的「当前作用域链查找」，找不到返回 null。
    let scope = this.currentScope;
    while (scope !== null) {
      const member = scope.Members.get(name);
      if (member !== undefined) {
        return member.Ref;
      }
      scope = scope.Parent;
    }
    return null;
  }

  /** Go: func (p *parser) storeNameInRef(name js_lexer.MaybeSubstring) ast.Ref */
  storeNameInRef(name: MaybeSubstring): Ref {
    // Is the data in "name" a subset of the data in "p.source.Contents"?
    if (name.Start > 0) {
      // The name is a slice of the file contents, so we can just reference it by
      // length and don't have to allocate anything. This is the common case.
      //
      // It's stored as a negative value so we'll crash if we try to use it. That
      // way we'll catch cases where we've forgotten to call loadNameFromRef().
      return new Ref((-name.String.length) >>> 0, name.Start);
    }

    // The name is some memory allocated elsewhere (an inline string constant or an
    // identifier with escape sequences). Stash it away for later.
    const ref = new Ref(0x80000000, this.allocatedNames.length);
    this.allocatedNames.push(name.String);
    return ref;
  }

  /** Go: func (p *parser) loadNameFromRef(ref ast.Ref) string */
  loadNameFromRef(ref: Ref): string {
    if (ref.SourceIndex === 0x80000000) {
      return bytesToString(this.allocatedNames[ref.InnerIndex]);
    }
    const length = (0x100000000 - ref.SourceIndex) >>> 0;
    return bytesToString(this.source.Contents.subarray(ref.InnerIndex, ref.InnerIndex + length));
  }

  /** Go: func (p *parser) maybeMarkKnownGlobalConstructorAsPure(e *js_ast.ENew) (js_parser.go:16930) */
  maybeMarkKnownGlobalConstructorAsPure(e: js_ast.ENew): void {
    if (!(e.Target.Data instanceof js_ast.EIdentifier)) return;
    const symbol = this.symbols[e.Target.Data.Ref.InnerIndex];
    if (symbol.Kind !== SymbolKind.SymbolUnbound) return;
    const n = e.Args.length;
    switch (symbol.OriginalName) {
      case "WeakSet":
      case "WeakMap":
        if (n === 0) {
          e.CanBeUnwrappedIfUnused = true;
        } else if (n === 1) {
          const arg = e.Args[0].Data;
          if (arg instanceof js_ast.ENull || arg instanceof js_ast.EUndefined ||
            (arg instanceof js_ast.EArray && arg.Items.length === 0)) {
            e.CanBeUnwrappedIfUnused = true;
          }
        }
        break;

      case "Date":
        if (n === 0) {
          e.CanBeUnwrappedIfUnused = true;
        } else if (n === 1) {
          const t = js_ast_helpers.KnownPrimitiveType(e.Args[0].Data);
          if (t === js_ast_helpers.PrimitiveNull || t === js_ast_helpers.PrimitiveUndefined ||
            t === js_ast_helpers.PrimitiveBoolean || t === js_ast_helpers.PrimitiveNumber ||
            t === js_ast_helpers.PrimitiveString) {
            e.CanBeUnwrappedIfUnused = true;
          }
        }
        break;

      case "Set":
        if (n === 0) {
          e.CanBeUnwrappedIfUnused = true;
        } else if (n === 1) {
          const arg = e.Args[0].Data;
          if (arg instanceof js_ast.EArray || arg instanceof js_ast.ENull || arg instanceof js_ast.EUndefined) {
            e.CanBeUnwrappedIfUnused = true;
          }
        }
        break;

      case "Map":
        if (n === 0) {
          e.CanBeUnwrappedIfUnused = true;
        } else if (n === 1) {
          const arg = e.Args[0].Data;
          if (arg instanceof js_ast.ENull || arg instanceof js_ast.EUndefined) {
            e.CanBeUnwrappedIfUnused = true;
          } else if (arg instanceof js_ast.EArray) {
            let allEntriesAreArrays = true;
            for (const item of arg.Items) {
              if (!(item.Data instanceof js_ast.EArray)) {
                allEntriesAreArrays = false;
                break;
              }
            }
            if (allEntriesAreArrays) e.CanBeUnwrappedIfUnused = true;
          }
        }
        break;
    }
  }

  /**
   * Go: p.options.defines.IdentifierDefines 的默认项（globals.go:1016）
   * + visit pass 对 unbound 符号的代换（js_parser.go:13764）。
   */
  identifierExpr(text: string, loc: Loc): js_ast.Expr {
    const found = this.findSymbol(loc, text);
    // Go: js_parser.go:13764 —— "!result.isInsideWithScope" 才做 define 代换；
    // with 作用域里的裸标识符可能是 with 目标的属性，不能替换。
    if (this.withNesting === 0 && (found === null || this.symbols[found.InnerIndex].Kind === SymbolKind.SymbolUnbound)) {
      switch (text) {
        case "undefined":
          return new js_ast.Expr(js_ast.EUndefinedShared, loc);
        case "NaN":
          return new js_ast.Expr(new js_ast.ENumber(NaN), loc);
        case "Infinity":
          return new js_ast.Expr(new js_ast.ENumber(Infinity), loc);
      }
    }
    return new js_ast.Expr(new js_ast.EIdentifier(this.resolveName(text, loc)), loc);
  }

  /** 骨架辅助：把名字解析成符号引用（对应 Go visit pass 里的 findSymbol 调用点） */
  resolveName(text: string, loc: Loc): Ref {
    const found = this.findSymbol(loc, text);
    if (found !== null) {
      return found;
    }
    const ref = this.newSymbol(SymbolKind.SymbolUnbound, text);
    const member = new js_ast.ScopeMember();
    member.Ref = ref;
    member.Loc = loc;
    this.moduleScope!.Members.set(text, member);
    return ref;
  }

  /** 骨架辅助：Go 的 p.saveExprCommentsHere() */
  saveExprCommentsHere(): Loc {
    const loc = this.lexer.Loc();
    // Go: js_parser.go:3476 —— 只有 exprComments 开启且当前 token 前有注释时才记录。
    if (this.exprComments !== null && this.lexer.CommentsBeforeToken.length > 0) {
      const decoder = new TextDecoder();
      const comments: string[] = [];
      for (const comment of this.lexer.CommentsBeforeToken) {
        comments.push(decoder.decode(this.source.CommentTextWithoutIndent(comment)));
      }
      this.exprComments.set(loc.Start, comments);
      // Go: p.lexer.CommentsBeforeToken = p.lexer.CommentsBeforeToken[0:]
      this.lexer.CommentsBeforeToken = [];
    }
    return loc;
  }

  // -------------------------------------------------------------------------
  // 语句
  // -------------------------------------------------------------------------

  /** Go: func (p *parser) parseStmtsUpTo(end js_lexer.T, opts parseStmtOpts) []js_ast.Stmt */
  parseStmtsUpTo(end: T, opts: parseStmtOpts): js_ast.Stmt[] {
    // Go: js_parser.go:8507 —— 普通语句列表里允许 lexical 声明（0=forbid / 1=allowAll / 2=if 体 / 3=label 体）
    opts.lexicalDecl = 1;
    const stmts: js_ast.Stmt[] = [];
    let isDirectivePrologue = opts.allowDirectivePrologue;

    for (;;) {
      // Preserve some statement-level comments（Go: js_parser.go:8508）
      const comments = this.lexer.LegalCommentsBeforeToken;
      if (comments.length > 0) {
        for (const comment of comments) {
          stmts.push(new js_ast.Stmt(init(new js_ast.SComment(), {
            Text: decoder.decode(this.source.CommentTextWithoutIndent(comment)),
            IsLegalComment: true,
          }), comment.Loc));
        }
      }

      if (this.lexer.Token === end) break;

      if (this.lexer.Token === T.TEndOfFile) {
        if (end !== T.TEndOfFile) {
          this.lexer.Expected(end);
        }
        break;
      }

      const stmt = this.parseStmt(opts);

      // Parse one or more directives at the beginning
      if (isDirectivePrologue) {
        isDirectivePrologue = false;
        if (stmt.Data instanceof js_ast.SExpr) {
          const str = stmt.Data.Value.Data;
          if (str instanceof js_ast.EString && !str.PreferTemplate) {
            stmt.Data = init(new js_ast.SDirective(), {
              Value: str.Value,
              LegacyOctalLoc: str.LegacyOctalLoc,
            });
            isDirectivePrologue = true;
          }
        }
      }

      stmts.push(stmt);
    }
    // 记录语句列表与其所在作用域（P20：Go visitStmts 的块级函数降级需要）
    if (this.currentScope !== null) {
      this.pendingStmtLists.push({ stmts, scope: this.currentScope });
    }
    return stmts;
  }

  /** Go: func (p *parser) parseStmt(opts parseStmtOpts) js_ast.Stmt */
  parseStmt(opts: parseStmtOpts): js_ast.Stmt {
    const loc = this.lexer.Loc();

    // Go: js_parser.go:7108 —— 语句前的注释不附着到下一个表达式。
    this.lexer.CommentsBeforeToken = [];

    // Go: js_parser.go:7431 —— "enum Foo {}"（ts.Parse=1）。
    // 用 tokenIs 取值比较而非 case 标签，避免向 switch 判别式 union 注入新常量、
    // 扰动基线里大量 token 比较的类型收窄（tsc baseline 167）。
    if (this.tokenIs(T.TEnum)) {
      if (!this.options.ts.Parse) { this.lexer.Unexpected(); }
      return parseTypeScriptEnumStmt(this, loc, opts);
    }

    switch (this.lexer.Token) {
      case T.TAt: {
        // Go: js_parser.go:7436 —— 装饰器只能在 class 语句前（可以隔着 export/export default）
        const decorators = this.parseDecorators();
        if (this.tokenIs(T.TClass)) {
          return this.parseClassStmt(loc, opts, decorators);
        }
        if (!this.tokenIs(T.TExport)) this.lexer.Unexpected();
        this.lexer.Next();

        let defaultLoc: Loc | null = null;
        if (this.tokenIs(T.TDefault)) {
          defaultLoc = this.lexer.Loc();
          this.lexer.Next();
        }
        if (!this.tokenIs(T.TClass)) this.lexer.Unexpected();

        if (defaultLoc === null) {
          const exportOpts = init(new parseStmtOpts(), opts, { isExport: true });
          return this.parseClassStmt(loc, exportOpts, decorators);
        }

        // "@x export default class {}"
        const classOpts = init(new parseStmtOpts(), opts, { isNameOptional: true });
        const stmt = this.parseClassStmt(loc, classOpts, decorators);
        const cls = stmt.Data as js_ast.SClass;
        let defaultName: LocRef;
        if (cls.Class.Name !== null) {
          defaultName = new LocRef(defaultLoc, cls.Class.Name.Ref);
        } else {
          defaultName = new LocRef(defaultLoc, this.newSymbol(SymbolKind.SymbolOther, "default"));
          this.currentScope!.Generated.push(defaultName.Ref);
          this.symbols[defaultName.Ref.InnerIndex].OriginalName = this.source.IdentifierName + "_default";
        }
        return new js_ast.Stmt(init(new js_ast.SExportDefault(), {
          DefaultName: defaultName,
          Value: stmt,
        }), loc);
      }

      case T.TExport: {
        // Go: exports are allowed at module scope or TypeScript namespace scope.
        if (!opts.isModuleScope && !opts.isNamespaceScope) {
          this.lexer.Unexpected();
        }
        this.isFileConsideredESM = true;
        this.sawExportKeyword = true;
        this.esmExportKeyword = this.lexer.Range(); // Go: parseStmt 的 export 关键字 range
        this.lexer.Next();

        // "export @x class Foo {}"
        if (this.tokenIs(T.TAt)) {
          const exportOpts = init(new parseStmtOpts(), opts, { isExport: true });
          return this.parseStmt(exportOpts);
        }

        // Go: "export enum Foo {}" —— TEnum 由 parseStmt 顶部的 tokenIs 守卫处理
        if (this.tokenIs(T.TEnum)) {
          const exportOpts = init(new parseStmtOpts(), opts, { isExport: true });
          return this.parseStmt(exportOpts);
        }

        switch (this.lexer.Token) {
          case T.TClass:
          case T.TConst:
          case T.TFunction:
          case T.TVar: {
            // Go 的 opts 是值类型；TS 是类，必须克隆后改。
            const exportOpts = init(new parseStmtOpts(), opts, { isExport: true });
            return this.parseStmt(exportOpts);
          }

          case T.TIdentifier: {
            // Go: "export let ..."（`let` 是上下文关键字，token 仍是 TIdentifier）
            if (this.lexer.IsContextualKeyword("let")) {
              const exportLetOpts = init(new parseStmtOpts(), opts, { isExport: true });
              return this.parseStmt(exportLetOpts);
            }

            if (this.lexer.IsContextualKeyword("async")) {
              // "export async function foo() {}"
              const asyncRange = this.lexer.Range();
              this.lexer.Next();
              if (this.lexer.HasNewlineBefore) {
                AddError(this.log, this.tracker, new Range(new Loc(asyncRange.Loc.Start + 5), 0),
                  "Unexpected newline after \"async\"");
                throw new LexerPanic();
              }
              this.lexer.Expect(T.TFunction);
              const asyncOpts = init(new parseStmtOpts(), opts, { isExport: true });
              return this.parseFnStmt(loc, asyncOpts, true);
            }

            // Go: js_parser.go:8319 —— "export namespace Foo {}" / "export module Foo {}"
            if (this.options.ts.Parse && (this.lexer.IsContextualKeyword("namespace") || this.lexer.IsContextualKeyword("module"))) {
              this.lexer.Next(); // 消费 namespace/module 上下文关键字
              const nsOpts = init(new parseStmtOpts(), opts, { isExport: true, isModuleScope: true });
              return parseTypeScriptNamespaceStmt(this, loc, nsOpts);
            }

            // 其余 TS 分支（"export as namespace" / "type" / "declare"）本子集不含。
            this.lexer.Unexpected();
            break;
          }

          case T.TDefault: {
            const defaultLoc = this.lexer.Loc();
            this.lexer.Next();

            // The default name is lazily generated only if no other name is present
            const createDefaultName = (): LocRef => {
              // This must be named "default" for when "--keep-names" is active
              const defaultName = new LocRef(defaultLoc, this.newSymbol(SymbolKind.SymbolOther, "default"));
              this.currentScope!.Generated.push(defaultName.Ref);
              // Go visit pass（js_parser.go:10603）：生成名改成 "<IdentifierName>_default"
              this.symbols[defaultName.Ref.InnerIndex].OriginalName = this.source.IdentifierName + "_default";
              return defaultName;
            };

            // "export default async function() {}"
            // "export default async function foo() {}"
            if (this.lexer.IsContextualKeyword("async")) {
              const asyncRange = this.lexer.Range();
              this.lexer.Next();

              if (this.lexer.Token === T.TFunction && !this.lexer.HasNewlineBefore) {
                this.lexer.Next(); // "function"
                const fnOpts = new parseStmtOpts();
                fnOpts.isNameOptional = true;
                const stmt = this.parseFnStmt(loc, fnOpts, true);
                const s = stmt.Data as js_ast.SFunction;

                // Use the statement name if present, since it's a better name
                const defaultName = s.Fn.Name !== null
                  ? new LocRef(defaultLoc, s.Fn.Name.Ref)
                  : createDefaultName();

                return new js_ast.Stmt(init(new js_ast.SExportDefault(), {
                  DefaultName: defaultName,
                  Value: stmt,
                }), loc);
              }

              // Go: "export default async <expr>"
              const expr = this.parseSuffix(
                this.parseAsyncPrefixExpr(asyncRange, js_ast.L.LComma, exprFlag.exprFlagNone),
                js_ast.L.LComma, exprFlag.exprFlagNone);
              this.lexer.ExpectOrInsertSemicolon();
              const asyncDefaultName = createDefaultName();
              return new js_ast.Stmt(init(new js_ast.SExportDefault(), {
                DefaultName: asyncDefaultName,
                Value: new js_ast.Stmt(init(new js_ast.SExpr(), { Value: expr }), loc),
              }), loc);
            }

            // "export default class {}" / "export default class Foo {}"
            // "export default function() {}" / "export default function foo() {}"
            if (this.tokenIs(T.TFunction) || this.tokenIs(T.TClass) || this.tokenIs(T.TAt)) {
              const innerOpts = new parseStmtOpts();
              innerOpts.isNameOptional = true;
              const stmt = this.parseStmt(innerOpts);

              // Use the statement name if present, since it's a better name
              let defaultName: LocRef;
              if (stmt.Data instanceof js_ast.SFunction) {
                defaultName = stmt.Data.Fn.Name !== null
                  ? new LocRef(defaultLoc, stmt.Data.Fn.Name.Ref)
                  : createDefaultName();
              } else if (stmt.Data instanceof js_ast.SClass) {
                // Go 的 visit pass 会走 lowerClass()，重建后的 SClass 语句 Loc 为 0
                // （js_parser.go:10581）。这里保留 parse 期的 loc 供 visit 校验，visit 后再置 0。
                defaultName = stmt.Data.Class.Name !== null
                  ? new LocRef(defaultLoc, stmt.Data.Class.Name.Ref)
                  : createDefaultName();
              } else {
                throw new Error("Internal error");
              }

              return new js_ast.Stmt(init(new js_ast.SExportDefault(), {
                DefaultName: defaultName,
                Value: stmt,
              }), loc);
            }

            const expr = this.parseExpr(js_ast.L.LComma);
            this.lexer.ExpectOrInsertSemicolon();
            const defaultName = createDefaultName();
            return new js_ast.Stmt(init(new js_ast.SExportDefault(), {
              DefaultName: defaultName,
              Value: new js_ast.Stmt(init(new js_ast.SExpr(), { Value: expr }), loc),
            }), loc);
          }

          case T.TAsterisk: {
            this.lexer.Next();
            let namespaceRef: Ref;
            let alias: js_ast.ExportStarAlias | null = null;
            let pathRange: Range;
            let pathText: string;
            let assertOrWith: ast.ImportAssertOrWith | null = null;
            let pathFlags = 0;

            if (this.lexer.IsContextualKeyword("as")) {
              // "export * as ns from 'path'"
              this.lexer.Next();
              const name = this.parseClauseAlias("export");
              namespaceRef = this.storeNameInRef(name);
              alias = init(new js_ast.ExportStarAlias(), {
                Loc: this.lexer.Loc(),
                OriginalName: bytesToString(name.String),
              });
              this.lexer.Next();
              this.lexer.ExpectContextualKeyword("from");
              ({ pathRange, pathText, assertOrWith, flags: pathFlags } = this.parsePath());
            } else {
              // "export * from 'path'"
              this.lexer.ExpectContextualKeyword("from");
              ({ pathRange, pathText, assertOrWith, flags: pathFlags } = this.parsePath());
              const name = js_ast.GenerateNonUniqueNameFromPath(pathText) + "_star";
              namespaceRef = this.storeNameInRef(new MaybeSubstring(new TextEncoder().encode(name), 0));
            }
            const importRecordIndex = this.addImportRecord(
              ImportKind.ImportStmt, ImportPhase.EvaluationPhase, pathRange, pathText, assertOrWith, pathFlags);

            // Export-star statements anywhere in the file disable top-level const
            // local prefix because import cycles can be used to trigger TDZ
            this.currentScope!.IsAfterConstLocalPrefix = true;

            this.lexer.ExpectOrInsertSemicolon();

            // Go: 符号创建在 visit 的 SExportStar（js_parser.go:10482），parse 期只存名字。

            return new js_ast.Stmt(init(new js_ast.SExportStar(), {
              NamespaceRef: namespaceRef,
              Alias: alias,
              ImportRecordIndex: importRecordIndex,
            }), loc);
          }

          case T.TOpenBrace: {
            const { items, isSingleLine } = this.parseExportClause();
            if (this.lexer.IsContextualKeyword("from")) {
              // "export {} from 'path'"
              this.lexer.Next();
              const { pathRange, pathText, assertOrWith, flags: pathFlags } = this.parsePath();
              const importRecordIndex = this.addImportRecord(
                ImportKind.ImportStmt, ImportPhase.EvaluationPhase, pathRange, pathText, assertOrWith, pathFlags);
              const name = "import_" + js_ast.GenerateNonUniqueNameFromPath(pathText);
              let namespaceRef = this.storeNameInRef(new MaybeSubstring(new TextEncoder().encode(name), 0));

              // Export clause statements anywhere in the file disable top-level const
              // local prefix because import cycles can be used to trigger TDZ
              this.currentScope!.IsAfterConstLocalPrefix = true;

              this.lexer.ExpectOrInsertSemicolon();

              // Go: parse 期只保留 storeNameInRef，真实符号在 visit 的 SExportFrom 里建
              // （js_parser.go:10465）；这里不能提前改 item.Name.Ref。

              return new js_ast.Stmt(init(new js_ast.SExportFrom(), {
                Items: items,
                NamespaceRef: namespaceRef,
                ImportRecordIndex: importRecordIndex,
                IsSingleLine: isSingleLine,
              }), loc);
            }

            this.lexer.ExpectOrInsertSemicolon();

            // Go: parse 期只存 storeNameInRef，真实符号在 visit 的 SExportClause 里结算
            // （js_parser.go:10439）。整文件声明都已入场，`export {x}; let x` 才能解析到 x。
            return new js_ast.Stmt(init(new js_ast.SExportClause(), {
              Items: items,
              IsSingleLine: isSingleLine,
            }), loc);
          }
        }

        // Go: "export =" 属 TS；这里一律报错（不静默）
        this.lexer.Unexpected();
        return new js_ast.Stmt(js_ast.SEmptyShared, loc);
      }

      case T.TImport: {
        this.lexer.Next();
        // Go: js_lexer 的 esmImportStatementKeyword —— "import("/"import." 不是 ESM
        if (!this.tokenIs(T.TOpenParen) && !this.tokenIs(T.TDot)) {
          this.isFileConsideredESM = true;
          this.esmImportStatementKeyword = this.lexer.Range(); // Go: esmImportStatementKeyword
        }
        const stmt = new js_ast.SImport();
        let wasOriginallyBareImport = false;
        let phase: ImportPhase = ImportPhase.EvaluationPhase;

        // Go: "export import foo = bar" / namespace 里的 import 属 TS，本子集不含；
        // opts.isExport 分支在 Go 里只在 ts.Parse 下到达。
        syntaxBeforePath: {
          switch (this.lexer.Token) {
            case T.TOpenParen:
            case T.TDot: {
              // "import('path')" / "import.meta"
              let expr = this.parseImportExpr(loc, js_ast.L.LLowest);
              expr = this.parseSuffix(expr, js_ast.L.LLowest, exprFlag.exprFlagNone);
              this.lexer.ExpectOrInsertSemicolon();
              return new js_ast.Stmt(init(new js_ast.SExpr(), { Value: expr }), loc);
            }

            case T.TStringLiteral:
            case T.TNoSubstitutionTemplateLiteral:
              // "import 'path'"
              if (!opts.isModuleScope) {
                this.lexer.Unexpected();
              }
              wasOriginallyBareImport = true;
              break;

            case T.TAsterisk: {
              // "import * as ns from 'path'"
              if (!opts.isModuleScope) {
                this.lexer.Unexpected();
              }
              this.lexer.Next();
              this.lexer.ExpectContextualKeyword("as");
              stmt.NamespaceRef = this.storeNameInRef(this.lexer.Identifier);
              const starLoc = this.lexer.Loc();
              stmt.StarNameLoc = starLoc;
              this.lexer.Expect(T.TIdentifier);
              this.lexer.ExpectContextualKeyword("from");
              break;
            }

            case T.TOpenBrace: {
              // "import {item1, item2} from 'path'"
              if (!opts.isModuleScope) {
                this.lexer.Unexpected();
              }
              const { items, isSingleLine } = this.parseImportClause();
              stmt.Items = items;
              stmt.IsSingleLine = isSingleLine;
              this.lexer.ExpectContextualKeyword("from");
              break;
            }

            case T.TIdentifier: {
              // "import defaultItem from 'path'"
              if (!opts.isModuleScope) {
                this.lexer.Unexpected();
              }
              const defaultName = this.lexer.Identifier;
              const defaultLoc = this.lexer.Loc();
              const defaultRaw = bytesToString(this.lexer.Raw());
              const isDeferName = defaultRaw === "defer";
              const isSourceName = defaultRaw === "source";
              this.lexer.Next();

              if (isDeferName && this.tokenIs(T.TAsterisk)) {
                // "import defer * as foo from 'bar';"
                phase = ImportPhase.DeferPhase;
                this.lexer.Next();
                this.lexer.ExpectContextualKeyword("as");
                stmt.NamespaceRef = this.storeNameInRef(this.lexer.Identifier);
                stmt.StarNameLoc = this.lexer.Loc();
                this.lexer.Expect(T.TIdentifier);
                this.lexer.ExpectContextualKeyword("from");
                break;
              }

              if (isSourceName && this.tokenIs(T.TIdentifier)) {
                if (bytesToString(this.lexer.Raw()) === "from") {
                  const nameSubstring = this.lexer.Identifier;
                  const nameLoc = this.lexer.Loc();
                  this.lexer.Next();
                  if (this.lexer.IsContextualKeyword("from")) {
                    // "import source from from 'foo';"
                    phase = ImportPhase.SourcePhase;
                    stmt.DefaultName = new LocRef(nameLoc, this.storeNameInRef(nameSubstring));
                    this.lexer.Next();
                  } else {
                    // "import source from 'foo';"
                    stmt.DefaultName = new LocRef(defaultLoc, this.storeNameInRef(defaultName));
                  }
                  break;
                }

                // "import source foo from 'bar';"
                phase = ImportPhase.SourcePhase;
                stmt.DefaultName = new LocRef(this.lexer.Loc(), this.storeNameInRef(this.lexer.Identifier));
                this.lexer.Next();
                this.lexer.ExpectContextualKeyword("from");
                break;
              }

              stmt.DefaultName = new LocRef(defaultLoc, this.storeNameInRef(defaultName));

              // Go: js_parser.go:8096-8099 —— TS import-equals（ts.Parse 下 token=TEquals）
              if (this.options.ts.Parse && (this.lexer.Token as number) === T.TEquals) {
                return parseTypeScriptImportEqualsStmt(this, loc, opts, defaultLoc, bytesToString(defaultName.String));
              }

              // Go: TS 的 type-only import / import-equals 分支属 ts.Parse
              if (this.lexer.Token === T.TComma) {
                this.lexer.Next();
                switch (this.lexer.Token) {
                  case T.TAsterisk: {
                    // "import defaultItem, * as ns from 'path'"
                    this.lexer.Next();
                    this.lexer.ExpectContextualKeyword("as");
                    stmt.NamespaceRef = this.storeNameInRef(this.lexer.Identifier);
                    const starLoc = this.lexer.Loc();
                    stmt.StarNameLoc = starLoc;
                    this.lexer.Expect(T.TIdentifier);
                    break;
                  }

                  case T.TOpenBrace: {
                    // "import defaultItem, {item1, item2} from 'path'"
                    const { items, isSingleLine } = this.parseImportClause();
                    stmt.Items = items;
                    stmt.IsSingleLine = isSingleLine;
                    break;
                  }

                  default:
                    this.lexer.Unexpected();
                }
              }

              this.lexer.ExpectContextualKeyword("from");
              break;
            }

            default:
              this.lexer.Unexpected();
          }
        }

        const { pathRange, pathText, assertOrWith, flags: pathFlags } = this.parsePath();
        this.lexer.ExpectOrInsertSemicolon();

        let flags = pathFlags;
        if (wasOriginallyBareImport) {
          flags |= ImportRecordFlags.WasOriginallyBareImport;
        }
        // Go visit pass（scanForImportsAndExports）：导入形态相关的 record flags
        if (stmt.StarNameLoc !== null) {
          flags |= ImportRecordFlags.ContainsImportStar;
        }
        if (stmt.DefaultName !== null) {
          flags |= ImportRecordFlags.ContainsDefaultAlias;
        } else if (stmt.Items !== null) {
          for (const item of stmt.Items) {
            if (item.Alias === "default") {
              flags |= ImportRecordFlags.ContainsDefaultAlias;
            } else if (item.Alias === "__esModule") {
              flags |= ImportRecordFlags.ContainsESModuleAlias;
            }
          }
        }
        stmt.ImportRecordIndex = this.addImportRecord(
          ImportKind.ImportStmt, phase, pathRange, pathText, assertOrWith, flags);

        if (stmt.StarNameLoc !== null) {
          const name = this.loadNameFromRef(stmt.NamespaceRef);
          stmt.NamespaceRef = this.declareSymbol(SymbolKind.SymbolImport, stmt.StarNameLoc, name);
        } else {
          // Generate a symbol for the namespace
          const name = "import_" + js_ast.GenerateNonUniqueNameFromPath(pathText);
          stmt.NamespaceRef = this.newSymbol(SymbolKind.SymbolOther, name);
          this.currentScope!.Generated.push(stmt.NamespaceRef);
        }

        // Link the default item to the namespace
        if (stmt.DefaultName !== null) {
          const name = this.loadNameFromRef(stmt.DefaultName.Ref);
          stmt.DefaultName.Ref = this.declareSymbol(SymbolKind.SymbolImport, stmt.DefaultName.Loc, name);
        }

        // Link each import item to the namespace
        if (stmt.Items !== null) {
          for (const item of stmt.Items) {
            const name = this.loadNameFromRef(item.Name.Ref);
            item.Name.Ref = this.declareSymbol(SymbolKind.SymbolImport, item.Name.Loc, name);
          }
        }

        // Import statements anywhere in the file disable top-level const
        // local prefix because import cycles can be used to trigger TDZ
        this.currentScope!.IsAfterConstLocalPrefix = true;
        return new js_ast.Stmt(stmt, loc);
      }

      case T.TSemicolon: {
        this.lexer.Next();
        return new js_ast.Stmt(js_ast.SEmptyShared, loc);
      }

      case T.TOpenBrace: {
        // Go: js_parser.go:8255 —— 块语句自己的 ScopeBlock（块级函数声明的 Annex B 判定依据）
        this.pushScopeForParsePass(js_ast.ScopeKind.ScopeBlock, loc);
        const stmts = this.parseBlockStmts();
        this.popScope();
        return new js_ast.Stmt(init(new js_ast.SBlock(), {
          Stmts: stmts.stmts,
          CloseBraceLoc: stmts.closeBraceLoc,
        }), loc);
      }

      case T.TVar: {
        this.lexer.Next();
        const decls = this.parseAndDeclareDecls(SymbolKind.SymbolHoisted, opts);
        this.lexer.ExpectOrInsertSemicolon();
        return new js_ast.Stmt(init(new js_ast.SLocal(), {
          Decls: decls,
          Kind: js_ast.LocalKind.LocalVar,
          IsExport: opts.isExport,
        }), loc);
      }

      case T.TConst: {
        // Go: js_parser.go:7508 —— 单语句上下文不允许 lexical 声明
        if (opts.lexicalDecl !== 1) this.forbidLexicalDecl(loc);
        this.lexer.Next();
        // Go: js_parser.go:7513 —— "const enum Foo {}"（ts.Parse=1）
        // 用 tokenIs 而非直接比较：const 分支判别式 union 不含 TEnum，直接比较触发 TS2367。
        if (this.options.ts.Parse && this.tokenIs(T.TEnum)) {
          return parseTypeScriptEnumStmt(this, loc, init(new parseStmtOpts(), opts, { isTypeScriptDeclare: true }));
        }
        const decls = this.parseAndDeclareDecls(SymbolKind.SymbolConst, opts);
        this.lexer.ExpectOrInsertSemicolon();
        return new js_ast.Stmt(init(new js_ast.SLocal(), {
          Decls: decls,
          Kind: this.selectLocalKind(js_ast.LocalKind.LocalConst),
          IsExport: opts.isExport,
        }), loc);
      }

      case T.TFunction:
        this.lexer.Next();
        return this.parseFnStmt(loc, opts, false);

      case T.TClass:
        if (opts.lexicalDecl !== 1) this.forbidLexicalDecl(loc);
        return this.parseClassStmt(loc, opts);

      case T.TIf: {
        this.lexer.Next();
        this.lexer.Expect(T.TOpenParen);
        const test = this.parseExpr(js_ast.L.LLowest);
        this.lexer.Expect(T.TCloseParen);
        const isSingleLineYes = !this.lexer.HasNewlineBefore && this.lexer.Token !== T.TOpenBrace;

        // Go: lexicalDeclAllowFnInsideIf —— "if (1) function f() {}" 的假 ScopeBlock
        // 由 parseFnStmt 的 hasIfScope 负责 push/pop（js_parser.go:6803），这里不再重复推一层。
        let yes = this.parseStmt(init(new parseStmtOpts(), { lexicalDecl: 2 }));

        let noOrNil: js_ast.Stmt | null = null;
        let isSingleLineNo = false;
        if (this.lexer.Token === T.TElse) {
          this.lexer.Next();
          isSingleLineNo = !this.lexer.HasNewlineBefore && this.lexer.Token !== T.TOpenBrace;
          noOrNil = this.parseStmt(init(new parseStmtOpts(), { lexicalDecl: 2 }));
        }
        const sIf = init(new js_ast.SIf(), {
          Test: test,
          Yes: yes,
          NoOrNil: noOrNil,
          IsSingleLineYes: isSingleLineYes,
          IsSingleLineNo: isSingleLineNo,
        });
        return new js_ast.Stmt(sIf, loc);
      }

      case T.TReturn: {
        this.lexer.Next();
        let valueOrNil: js_ast.Expr | null = null;
        if (
          !this.lexer.HasNewlineBefore && this.lexer.Token !== T.TSemicolon &&
          this.lexer.Token !== T.TCloseBrace && this.lexer.Token !== T.TEndOfFile
        ) {
          valueOrNil = this.parseExpr(js_ast.L.LLowest);
        }
        this.lexer.ExpectOrInsertSemicolon();
        return new js_ast.Stmt(init(new js_ast.SReturn(), { ValueOrNil: valueOrNil }), loc);
      }

      case T.TDebugger:
        this.lexer.Next();
        this.lexer.ExpectOrInsertSemicolon();
        return new js_ast.Stmt(js_ast.SDebuggerShared, loc);

      case T.TBreak: {
        this.lexer.Next();
        const name = this.parseLabelName();
        this.lexer.ExpectOrInsertSemicolon();
        return new js_ast.Stmt(init(new js_ast.SBreak(), { Label: name }), loc);
      }

      case T.TContinue: {
        this.lexer.Next();
        const name = this.parseLabelName();
        this.lexer.ExpectOrInsertSemicolon();
        return new js_ast.Stmt(init(new js_ast.SContinue(), { Label: name }), loc);
      }

      case T.TThrow: {
        this.lexer.Next();
        if (this.lexer.HasNewlineBefore) {
          const endLoc = new Loc(loc.Start + 5);
          AddError(this.log, this.tracker, new Range(endLoc, 0), 'Unexpected newline after "throw"');
          return new js_ast.Stmt(init(new js_ast.SThrow(), {
            Value: new js_ast.Expr(js_ast.ENullShared, endLoc),
          }), loc);
        }
        const expr = this.parseExpr(js_ast.L.LLowest);
        this.lexer.ExpectOrInsertSemicolon();
        return new js_ast.Stmt(init(new js_ast.SThrow(), { Value: expr }), loc);
      }

      case T.TDo: {
        this.lexer.Next();
        const body = this.parseStmt(new parseStmtOpts());
        this.lexer.Expect(T.TWhile);
        this.lexer.Expect(T.TOpenParen);
        const test = this.parseExpr(js_ast.L.LLowest);
        this.lexer.Expect(T.TCloseParen);

        // This is a weird corner case where automatic semicolon insertion applies
        // even without a newline present
        if (this.lexer.Token === T.TSemicolon) {
          this.lexer.Next();
        }
        return new js_ast.Stmt(init(new js_ast.SDoWhile(), { Body: body, Test: test }), loc);
      }

      case T.TWhile: {
        this.lexer.Next();
        this.lexer.Expect(T.TOpenParen);
        const test = this.parseExpr(js_ast.L.LLowest);
        this.lexer.Expect(T.TCloseParen);
        const isSingleLineBody = !this.lexer.HasNewlineBefore && this.lexer.Token !== T.TOpenBrace;
        const body = this.parseStmt(new parseStmtOpts());
        return new js_ast.Stmt(init(new js_ast.SWhile(), {
          Test: test,
          Body: body,
          IsSingleLineBody: isSingleLineBody,
        }), loc);
      }

      case T.TWith: {
        // Go: js_parser.go:7569
        this.lexer.Next();
        this.lexer.Expect(T.TOpenParen);
        const test = this.parseExpr(js_ast.L.LLowest);
        const bodyLoc = this.lexer.Loc();
        this.lexer.Expect(T.TCloseParen);

        // Push a scope so we make sure to prevent any bare identifiers referenced
        // within the body from being renamed. Renaming them might change the
        // semantics of the code.
        this.pushScopeForParsePass(js_ast.ScopeKind.ScopeWith, bodyLoc);
        const isSingleLineBody = !this.lexer.HasNewlineBefore && this.lexer.Token !== T.TOpenBrace;
        this.withNesting++;
        const body = this.parseStmt(new parseStmtOpts());
        this.withNesting--;
        this.popScope();

        return new js_ast.Stmt(init(new js_ast.SWith(), {
          Value: test,
          BodyLoc: bodyLoc,
          Body: body,
          IsSingleLineBody: isSingleLineBody,
        }), loc);
      }

      case T.TSwitch: {
        this.lexer.Next();
        this.lexer.Expect(T.TOpenParen);
        const test = this.parseExpr(js_ast.L.LLowest);
        this.lexer.Expect(T.TCloseParen);

        const bodyLoc = this.lexer.Loc();
        this.pushScopeForParsePass(js_ast.ScopeKind.ScopeBlock, bodyLoc);

        this.lexer.Expect(T.TOpenBrace);
        const cases: js_ast.Case[] = [];
        let foundDefault = false;
        let caseScopeMap: Set<js_ast.Scope> | null = null;
        const switchScopeStart = this.scopesInOrder.length;

        while (this.lexer.Token !== T.TCloseBrace) {
          let value: js_ast.Expr | null = null;
          const body: js_ast.Stmt[] = [];
          const caseLoc = this.saveExprCommentsHere();
          let caseScopeStart = this.scopesInOrder.length;

          if (this.lexer.Token === T.TDefault) {
            if (foundDefault) {
              AddError(this.log, this.tracker, this.lexer.Range(), "Multiple default clauses are not allowed");
              throw new LexerPanic();
            }
            foundDefault = true;
            this.lexer.Next();
            this.lexer.Expect(T.TColon);
          } else {
            this.lexer.Expect(T.TCase);
            value = this.parseExpr(js_ast.L.LLowest);
            this.lexer.Expect(T.TColon);
          }

          // Keep track of any scopes created by case values (e.g. arrows inside a case value).
          if (caseScopeStart < this.scopesInOrder.length) {
            if (caseScopeMap === null) caseScopeMap = new Set();
            while (caseScopeStart < this.scopesInOrder.length) {
              caseScopeMap.add(this.scopesInOrder[caseScopeStart].scope);
              caseScopeStart++;
            }
          }

          for (;;) {
            if (this.lexer.Token === T.TCloseBrace || this.lexer.Token === T.TCase ||
              this.lexer.Token === T.TDefault) {
              break;
            }
            const caseOpts = new parseStmtOpts();
            caseOpts.isCaseBody = true;
            body.push(this.parseStmt(caseOpts));
          }

          cases.push(init(new js_ast.Case(), { ValueOrNil: value, Body: body, Loc: caseLoc }));
        }

        // If any case contains values that create a scope, reorder those scopes to come first
        // before any scopes created by case bodies. This reflects the visit order (values first).
        if (caseScopeMap !== null && caseScopeMap.size > 0) {
          const caseScopes: { loc: Loc; scope: js_ast.Scope }[] = [];
          const bodyScopes: { loc: Loc; scope: js_ast.Scope }[] = [];
          for (let i = switchScopeStart; i < this.scopesInOrder.length; i++) {
            const it = this.scopesInOrder[i];
            if (caseScopeMap.has(it.scope)) caseScopes.push(it);
            else bodyScopes.push(it);
          }
          const merged = caseScopes.concat(bodyScopes);
          for (let i = 0; i < merged.length; i++) this.scopesInOrder[switchScopeStart + i] = merged[i];
        }

        const closeBraceLoc = this.lexer.Loc();
        this.lexer.Expect(T.TCloseBrace);
        this.popScope();
        return new js_ast.Stmt(init(new js_ast.SSwitch(), {
          Test: test,
          Cases: cases,
          BodyLoc: bodyLoc,
          CloseBraceLoc: closeBraceLoc,
        }), loc);
      }

      case T.TTry: {
        this.lexer.Next();
        const blockLoc = this.lexer.Loc();
        this.lexer.Expect(T.TOpenBrace);
        this.pushScopeForParsePass(js_ast.ScopeKind.ScopeBlock, loc);
        const body = this.parseStmtsUpTo(T.TCloseBrace, new parseStmtOpts());
        this.popScope();
        const closeBraceLoc = this.lexer.Loc();
        this.lexer.Next();

        let catchOrNil: js_ast.Catch | null = null;
        let finallyOrNil: js_ast.Finally | null = null;

        if (this.lexer.Token === T.TCatch) {
          const catchLoc = this.lexer.Loc();
          this.pushScopeForParsePass(js_ast.ScopeKind.ScopeCatchBinding, catchLoc);
          this.lexer.Next();
          let bindingOrNil: js_ast.Binding | null = null;

          // The catch binding is optional, and can be omitted
          if (this.lexer.Token !== T.TOpenBrace) {
            this.lexer.Expect(T.TOpenParen);
            const catchBindingLoc = this.lexer.Loc();
            bindingOrNil = this.parseBinding(SymbolKind.SymbolCatchIdentifier);
            this.lexer.Expect(T.TCloseParen);
            if (bindingOrNil.Data instanceof js_ast.BIdentifier) {
              // Go: bare identifiers use SymbolCatchIdentifier（parseBinding 已声明）
            }
            void catchBindingLoc;
          }

          const catchBlockLoc = this.lexer.Loc();
          this.lexer.Expect(T.TOpenBrace);

          this.pushScopeForParsePass(js_ast.ScopeKind.ScopeBlock, catchBlockLoc);
          const stmts = this.parseStmtsUpTo(T.TCloseBrace, new parseStmtOpts());
          this.popScope();

          const catchCloseBraceLoc = this.lexer.Loc();
          this.lexer.Next();
          catchOrNil = init(new js_ast.Catch(), {
            Loc: catchLoc,
            BindingOrNil: bindingOrNil,
            BlockLoc: catchBlockLoc,
            Block: init(new js_ast.SBlock(), { Stmts: stmts, CloseBraceLoc: catchCloseBraceLoc }),
          });
          this.popScope();
        }

        if (this.lexer.Token === T.TFinally || catchOrNil === null) {
          const finallyLoc = this.lexer.Loc();
          this.pushScopeForParsePass(js_ast.ScopeKind.ScopeBlock, finallyLoc);
          this.lexer.Expect(T.TFinally);
          this.lexer.Expect(T.TOpenBrace);
          const stmts = this.parseStmtsUpTo(T.TCloseBrace, new parseStmtOpts());
          const finallyCloseBraceLoc = this.lexer.Loc();
          this.lexer.Next();
          finallyOrNil = init(new js_ast.Finally(), {
            Loc: finallyLoc,
            Block: init(new js_ast.SBlock(), { Stmts: stmts, CloseBraceLoc: finallyCloseBraceLoc }),
          });
          this.popScope();
        }

        return new js_ast.Stmt(init(new js_ast.STry(), {
          BlockLoc: blockLoc,
          Block: init(new js_ast.SBlock(), { Stmts: body, CloseBraceLoc: closeBraceLoc }),
          Catch: catchOrNil,
          Finally: finallyOrNil,
        }), loc);
      }

      case T.TFor: {
        this.pushScopeForParsePass(js_ast.ScopeKind.ScopeBlock, loc);
        this.lexer.Next();

        // "for await (let x of y) {}"
        let awaitRange = new Range();
        if (this.lexer.IsContextualKeyword("await")) {
          // Go: await 只在 async 函数里合法；本子集不追踪 await 语境，
          // 这里照 Go 的“合法”路径走（topLevelAwaitKeyword 的记账未移植，登记在 PLAN §3）。
          // Go: 顶层 await 的 keyword range（TS 不追踪函数嵌套；该 range 只进 whyESModule 的 notes，不影响 Print 字节）
          this.topLevelAwaitKeyword = this.lexer.Range();
          awaitRange = this.lexer.Range();
          this.lexer.Next();
        }

        this.lexer.Expect(T.TOpenParen);

        let initOrNil: js_ast.Stmt | null = null;
        let testOrNil: js_ast.Expr | null = null;
        let updateOrNil: js_ast.Expr | null = null;

        // "in" expressions aren't allowed here
        const oldAllowIn = this.allowIn;
        this.allowIn = false;

        let decls: js_ast.Decl[] = [];
        let isVar = false;
        const initLoc = this.lexer.Loc();

        switch (this.lexer.Token) {
          case T.TVar:
            isVar = true;
            this.lexer.Next();
            decls = this.parseAndDeclareDecls(SymbolKind.SymbolHoisted, new parseStmtOpts());
            initOrNil = new js_ast.Stmt(init(new js_ast.SLocal(), {
              Kind: js_ast.LocalKind.LocalVar,
              Decls: decls,
            }), initLoc);
            break;

          case T.TConst:
            this.lexer.Next();
            decls = this.parseAndDeclareDecls(SymbolKind.SymbolConst, new parseStmtOpts());
            initOrNil = new js_ast.Stmt(init(new js_ast.SLocal(), {
              Kind: this.selectLocalKind(js_ast.LocalKind.LocalConst),
              Decls: decls,
            }), initLoc);
            break;

          case T.TSemicolon:
            break;

          default: {
            const forInitOpts = init(new parseStmtOpts(), { isForLoopInit: true, isForAwaitLoopInit: awaitRange.Len > 0, lexicalDecl: 1 });
            const oldIsForLoopInit = this.isForLoopInit;
            this.isForLoopInit = true;
            const rawText = this.tokenIs(T.TIdentifier) ? bytesToString(this.lexer.Raw()) : "";
            if (this.lexer.IsContextualKeyword("let")) {
              this.lexer.Next();
              decls = this.parseAndDeclareDecls(SymbolKind.SymbolOther, new parseStmtOpts());
              initOrNil = new js_ast.Stmt(init(new js_ast.SLocal(), {
                Kind: this.selectLocalKind(js_ast.LocalKind.LocalLet),
                Decls: decls,
              }), initLoc);
            } else if (rawText === "using") {
              // Go: js_parser.go:5067（for-init 里的 using）
              const usingName = this.lexer.Identifier;
              const usingLoc = this.lexer.Loc();
              this.lexer.Next();
              const stmt = this.maybeParseUsingDecl(usingLoc, forInitOpts, false);
              if (stmt !== null) {
                decls = (stmt.Data as js_ast.SLocal).Decls;
                initOrNil = stmt;
              } else {
                let expr = new js_ast.Expr(new js_ast.EIdentifier(this.resolveName(bytesToString(usingName.String), usingLoc)), usingLoc);
                expr = this.parseSuffix(expr, js_ast.L.LLowest, exprFlag.exprFlagNone);
                initOrNil = new js_ast.Stmt(init(new js_ast.SExpr(), { Value: expr }), expr.Loc);
              }
            } else if (rawText === "await") {
              // Go: js_parser.go:5084（for-init 里的 await using）
              const awaitLoc = this.lexer.Loc();
              this.lexer.Next();
              if (this.tokenIs(T.TIdentifier) && bytesToString(this.lexer.Raw()) === "using") {
                const usingName = this.lexer.Identifier;
                const usingLoc = this.lexer.Loc();
                this.lexer.Next();
                const stmt = this.maybeParseUsingDecl(awaitLoc, forInitOpts, true);
                if (stmt !== null) {
                  decls = (stmt.Data as js_ast.SLocal).Decls;
                  initOrNil = stmt;
                } else {
                  let value = new js_ast.Expr(new js_ast.EIdentifier(this.resolveName(bytesToString(usingName.String), usingLoc)), usingLoc);
                  if (this.tokenIs(T.TAsteriskAsterisk)) this.lexer.Unexpected();
                  value = this.parseSuffix(value, js_ast.L.LPrefix, exprFlag.exprFlagNone);
                  let expr = new js_ast.Expr(init(new js_ast.EAwait(), { Value: value }), awaitLoc);
                  expr = this.parseSuffix(expr, js_ast.L.LLowest, exprFlag.exprFlagNone);
                  initOrNil = new js_ast.Stmt(init(new js_ast.SExpr(), { Value: expr }), expr.Loc);
                }
              } else {
                const value = this.parseExpr(js_ast.L.LPrefix);
                if (this.tokenIs(T.TAsteriskAsterisk)) this.lexer.Unexpected();
                let expr = new js_ast.Expr(init(new js_ast.EAwait(), { Value: value }), awaitLoc);
                expr = this.parseSuffix(expr, js_ast.L.LLowest, exprFlag.exprFlagNone);
                initOrNil = new js_ast.Stmt(init(new js_ast.SExpr(), { Value: expr }), expr.Loc);
              }
            } else {
              const expr = this.parseExpr(js_ast.L.LLowest);
              initOrNil = new js_ast.Stmt(init(new js_ast.SExpr(), { Value: expr }), expr.Loc);
            }
            this.isForLoopInit = oldIsForLoopInit;
            break;
          }
        }

        // "in" expressions are allowed again
        this.allowIn = oldAllowIn;

        // Detect for-of loops
        if (this.lexer.IsContextualKeyword("of") || awaitRange.Len > 0) {
          if (awaitRange.Len > 0 && !this.lexer.IsContextualKeyword("of")) {
            if (initOrNil !== null) {
              this.lexer.ExpectedString("\"of\"");
            } else {
              this.lexer.Unexpected();
            }
          }
          this.forbidInitializers(decls, "of", false);
          this.lexer.Next();
          const value = this.parseExpr(js_ast.L.LComma);
          this.lexer.Expect(T.TCloseParen);
          const isSingleLineBody = !this.lexer.HasNewlineBefore && this.lexer.Token !== T.TOpenBrace;
          const body = this.parseStmt(new parseStmtOpts());
          this.popScope();
          return new js_ast.Stmt(init(new js_ast.SForOf(), {
            Await: awaitRange,
            Init: initOrNil!,
            Value: value,
            Body: body,
            IsSingleLineBody: isSingleLineBody,
          }), loc);
        }

        // Detect for-in loops
        if (this.lexer.Token === T.TIn) {
          this.forbidInitializers(decls, "in", isVar);
          this.lexer.Next();
          const value = this.parseExpr(js_ast.L.LLowest);
          this.lexer.Expect(T.TCloseParen);
          const isSingleLineBody = !this.lexer.HasNewlineBefore && this.lexer.Token !== T.TOpenBrace;
          const body = this.parseStmt(new parseStmtOpts());
          this.popScope();
          return new js_ast.Stmt(init(new js_ast.SForIn(), {
            Init: initOrNil!,
            Value: value,
            Body: body,
            IsSingleLineBody: isSingleLineBody,
          }), loc);
        }

        this.lexer.Expect(T.TSemicolon);

        if (this.lexer.Token !== T.TSemicolon) {
          testOrNil = this.parseExpr(js_ast.L.LLowest);
        }

        this.lexer.Expect(T.TSemicolon);

        if (this.lexer.Token !== T.TCloseParen) {
          updateOrNil = this.parseExpr(js_ast.L.LLowest);
        }

        this.lexer.Expect(T.TCloseParen);
        const isSingleLineBody = !this.lexer.HasNewlineBefore && this.lexer.Token !== T.TOpenBrace;
        const body = this.parseStmt(new parseStmtOpts());
        this.popScope();
        return new js_ast.Stmt(init(new js_ast.SFor(), {
          InitOrNil: initOrNil,
          TestOrNil: testOrNil,
          UpdateOrNil: updateOrNil,
          Body: body,
          IsSingleLineBody: isSingleLineBody,
        }), loc);
      }

      case T.TIdentifier: {
        const rawText = bytesToString(this.lexer.Raw());

        // Go: js_parser.go:8319 —— "namespace Foo {}" / "module Foo {}"（ts.Parse=1）
        // 注：TS lexer 在 offset 0 也把 HasNewlineBefore 置 true，与 Go 不同；
        // Go 的 !HasNewlineBefore 是为排除 `foo\nnamespace Bar`，文件开头应视为无换行。
        const noNewlineBefore = !this.lexer.HasNewlineBefore || loc.Start === 0;
        if (this.options.ts.Parse && (rawText === "namespace" || rawText === "module") &&
          noNewlineBefore && (opts.isModuleScope || opts.isNamespaceScope)) {
          // Go 的判据看的是 namespace/module **之后**的 token（名字），
          // 而此处的 token 就是 module 本身，必须前瞻一个再判，避免把 `module;` 当成 namespace。
          const savedLexer = this.lexer;
          this.lexer = this.lexer.clone();
          this.lexer.Next();
          const nextIsName = this.lexer.Token === T.TIdentifier ||
            (this.lexer.Token === T.TStringLiteral && opts.isTypeScriptDeclare);
          this.lexer = savedLexer;
          if (nextIsName) {
            this.lexer.Next();
            return parseTypeScriptNamespaceStmt(this, loc, opts);
          }
        }

        // Go: js_parser.go:5019 parseExprOrLetOrUsingStmt（using/await/async/let 声明分支）
        const pe = this.parseExprOrLetOrUsingStmt(loc, opts);
        if (pe !== null) return pe;
        break;
      }
    }

    // Expression statement
    const value = this.parseExpr(js_ast.L.LLowest);

    // "foo: bar()" —— 标签语句
    if (value.Data instanceof js_ast.EIdentifier && this.lexer.Token === T.TColon) {
      this.lexer.Next();
      const labelName = this.symbols[value.Data.Ref.InnerIndex].OriginalName;
      // Go visit pass: newSymbol(SymbolLabel, name) + pushScopeForVisitPass(ScopeLabel)
      const ref = this.newSymbol(SymbolKind.SymbolLabel, labelName);
      const name = new LocRef(value.Loc, ref);
      this.pushScopeForParsePass(js_ast.ScopeKind.ScopeLabel, loc);
      this.currentScope!.Label = name;
      const member = new js_ast.ScopeMember();
      member.Ref = ref;
      member.Loc = value.Loc;
      this.currentScope!.Members.set(labelName, member);

      const isSingleLineStmt = !this.lexer.HasNewlineBefore && this.lexer.Token !== T.TOpenBrace;
      // Go: lexicalDeclAllowFnInsideLabel —— "x: function f() {}"；
      // Go 不给 label 下的函数声明额外假块（parseFnStmt 的 hasIfScope 只认 if），这里也不再推。
      const stmt = this.parseStmt(init(new parseStmtOpts(), { lexicalDecl: 3 }));
      this.popScope();
      const sLabel = init(new js_ast.SLabel(), {
        Name: name,
        Stmt: stmt,
        IsSingleLineStmt: isSingleLineStmt,
      });
      return new js_ast.Stmt(sLabel, loc);
    }

    this.lexer.ExpectOrInsertSemicolon();
    return new js_ast.Stmt(init(new js_ast.SExpr(), { Value: value }), loc);
  }

  /** 骨架：`let` 是上下文关键字（js_lexer 里没有 TLet token） */
  parseLetStmt(loc: Loc, opts: parseStmtOpts): js_ast.Stmt {
    // Go: js_parser.go:5056 —— 单语句上下文的 "let" 声明要报 forbid
    if (opts.lexicalDecl !== 1) this.forbidLexicalDecl(loc);
    this.lexer.Next();
    const decls = this.parseAndDeclareDecls(SymbolKind.SymbolOther, opts);
    this.lexer.ExpectOrInsertSemicolon();
    return new js_ast.Stmt(init(new js_ast.SLocal(), {
      Decls: decls,
      Kind: this.selectLocalKind(js_ast.LocalKind.LocalLet),
      IsExport: opts.isExport,
    }), loc);
  }

  /** 骨架辅助：`{ stmts }`（Go 的 parseStmtsUpTo + Expect(TCloseBrace)） */
  parseBlockStmts(): { stmts: js_ast.Stmt[]; closeBraceLoc: Loc } {
    this.lexer.Expect(T.TOpenBrace);
    const stmts = this.parseStmtsUpTo(T.TCloseBrace, new parseStmtOpts());
    const closeBraceLoc = this.lexer.Loc();
    this.lexer.Expect(T.TCloseBrace);
    return { stmts, closeBraceLoc };
  }

  /** Go: func (p *parser) parseAndDeclareDecls(kind ast.SymbolKind, opts parseStmtOpts) []js_ast.Decl */
  parseAndDeclareDecls(kind: SymbolKind, opts: parseStmtOpts): js_ast.Decl[] {    const decls: js_ast.Decl[] = [];

    for (;;) {
      const binding = this.parseBinding(kind);
      let valueOrNil: js_ast.Expr | null = null;
      if (this.lexer.Token === T.TEquals) {
        this.lexer.Next();
        valueOrNil = this.parseExpr(js_ast.L.LComma);
      }
      decls.push(init(new js_ast.Decl(), { Binding: binding, ValueOrNil: valueOrNil }));

      if (this.lexer.Token !== T.TComma) {
        break;
      }
      this.lexer.Next();
    }

    return decls;
  }

  // -------------------------------------------------------------------------
  // import / export 子句
  // -------------------------------------------------------------------------

  /** Go: func (p *parser) parseLabelName() *ast.LocRef (js_parser.go:6638) */
  parseLabelName(): LocRef | null {
    if (this.lexer.Token !== T.TIdentifier || this.lexer.HasNewlineBefore) {
      return null;
    }

    const loc = this.lexer.Loc();
    const name = bytesToString(this.lexer.Identifier.String);
    this.lexer.Next();
    // Go 在 visit pass 里用 findLabelSymbol 换成 SymbolLabel；本子集直接按名解析。
    return new LocRef(loc, this.resolveName(name, loc));
  }

  /**
   * 骨架辅助：绕开 TS 对 `this.lexer.Token` 的过窄控制流推断。
   * Go 的 lexer.Token 是可变字段，Next() 之后类型不应被当成固定字面量；
   * 直接比较会假报 TS2367（已在基线 167 里容忍一批，新代码不再增加）。
   */
  tokenIs(t: T): boolean {
    return this.lexer.Token === t;
  }

  /** Go: func (p *parser) requireInitializers(kind js_ast.LocalKind, decls []js_ast.Decl) (js_parser.go:5675) */
  requireInitializers(kind: js_ast.LocalKind, decls: js_ast.Decl[]): void {
    for (const d of decls) {
      if (d.ValueOrNil === null) {
        let what = "constant";
        if (kind === js_ast.LocalKind.LocalUsing) {
          what = "declaration";
        }
        if (d.Binding.Data instanceof js_ast.BIdentifier) {
          const r = RangeOfIdentifier(this.source, d.Binding.Loc);
          AddError(this.log, this.tracker, r,
            `The ${what} ${goQuoted(this.symbols[d.Binding.Data.Ref.InnerIndex].OriginalName)} must be initialized`);
        } else {
          AddError(this.log, this.tracker, new Range(d.Binding.Loc, 0), `This ${what} must be initialized`);
        }
      }
    }
  }

  /**
   * Go: js_parser.go:5067 / 5084 的 using / await using 声明分支。
   * 进入时当前 token 已经是下一个 token（调用方已 Next 过 `using` / `await`）。
   * 返回 null 表示不是声明（由调用方按普通表达式处理）。
   */
  maybeParseUsingDecl(loc: Loc, opts: parseStmtOpts, isAwait: boolean): js_ast.Stmt | null {
    if (!this.tokenIs(T.TIdentifier) || this.lexer.HasNewlineBefore) return null;
    // Go: js_parser.go:5067 —— 只对普通 using 做 "of" 排除（await using of of of 合法）
    if (!isAwait && opts.isForLoopInit && bytesToString(this.lexer.Raw()) === "of") return null;
    // Go: js_parser.go:5097 —— switch case 体里不允许 using；其它单语句上下文一律 forbid
    if (opts.isCaseBody) {
      this.forbidUsingInSwitch(loc);
    } else if (opts.lexicalDecl !== 1) {
      this.forbidLexicalDecl(loc);
    }
    const kind = isAwait ? js_ast.LocalKind.LocalAwaitUsing : js_ast.LocalKind.LocalUsing;
    const decls = this.parseAndDeclareDecls(SymbolKind.SymbolConst, opts);
    if (!opts.isForLoopInit) this.requireInitializers(kind, decls);
    // Go: parseStmt 在 parseExprOrLetOrUsingStmt 返回 stmt 后调 ExpectOrInsertSemicolon()。
    // TS 的 using 分支在此直接返回 stmt，故在此补消费分号，否则多出 SEmpty（打印成多余的 ";"）。
    // for 循环 init 例外：其后是 "of"/"in"，不能吃分号。
    if (!opts.isForLoopInit) this.lexer.ExpectOrInsertSemicolon();
    return new js_ast.Stmt(init(new js_ast.SLocal(), {
      Kind: kind,
      Decls: decls,
      IsExport: opts.isExport,
    }), loc);
  }

  /** Go: func (p *parser) forbidInitializers(decls []js_ast.Decl, loopType string, isVar bool) */
  forbidInitializers(decls: js_ast.Decl[], loopType: string, isVar: boolean): void {
    if (decls.length > 1) {
      AddError(this.log, this.tracker, new Range(decls[0].Binding.Loc, 0),
        `for-${loopType} loops must have a single declaration`);
    } else if (decls.length === 1 && decls[0].ValueOrNil !== null) {
      if (isVar && decls[0].Binding.Data instanceof js_ast.BIdentifier) {
        // This is a weird special case. Initializers are allowed in "var"
        // statements with identifier bindings.
        return;
      }
      AddError(this.log, this.tracker, new Range(decls[0].ValueOrNil.Loc, 0),
        `for-${loopType} loop variables cannot have an initializer`);
    }
  }

  /** Go: func (p *parser) parseClauseAlias(kind string) js_lexer.MaybeSubstring (js_parser.go:5711) */
  parseClauseAlias(kind: string): MaybeSubstring {
    const loc = this.lexer.Loc();

    // The alias may now be a string (see https://github.com/tc39/ecma262/pull/2154)
    if (this.lexer.Token === T.TStringLiteral) {
      const r = this.source.RangeOfString(loc);
      const result = UTF16ToStringWithValidation(this.lexer.StringLiteral());
      if (!result.ok) {
        AddError(this.log, this.tracker, r,
          `This ${kind} alias is invalid because it contains the unpaired Unicode surrogate U+${result.bad.toString(16).toUpperCase()}`);
      }
      return new MaybeSubstring(result.value, 0);
    }

    // The alias may be a keyword
    if (!this.lexer.IsIdentifierOrKeyword()) {
      this.lexer.Expect(T.TIdentifier);
    }

    const alias = this.lexer.Identifier;
    this.checkForUnrepresentableIdentifier(loc, bytesToString(alias.String));
    return alias;
  }

  /** Go: func (p *parser) parseImportClause() ([]js_ast.ClauseItem, bool) (js_parser.go:5735) */
  parseImportClause(): { items: js_ast.ClauseItem[]; isSingleLine: boolean } {
    const items: js_ast.ClauseItem[] = [];
    this.lexer.Expect(T.TOpenBrace);
    let isSingleLine = !this.lexer.HasNewlineBefore;

    while (this.lexer.Token !== T.TCloseBrace) {
      const isIdentifier = this.lexer.Token === T.TIdentifier;
      const aliasLoc = this.lexer.Loc();
      const alias = this.parseClauseAlias("import");
      let name = new LocRef(aliasLoc, this.storeNameInRef(alias));
      let originalName = alias;
      this.lexer.Next();

      // Go: "import { type xx } from 'mod'" 等 TS 分支属 ts.Parse，本子集不含。
      if (this.lexer.IsContextualKeyword("as")) {
        this.lexer.Next();
        originalName = this.lexer.Identifier;
        name = new LocRef(this.lexer.Loc(), this.storeNameInRef(originalName));
        this.lexer.Expect(T.TIdentifier);
      } else if (!isIdentifier) {
        // An import where the name is a keyword must have an alias
        this.lexer.ExpectedString("\"as\"");
      }

      // Go: 这里还有 isEvalOrArguments 的 "Cannot use %q as an identifier here" 诊断；
      // 该诊断与 ok 的联动未移植（登记在 PLAN「第 16 次推进」§3）。
      items.push(init(new js_ast.ClauseItem(), {
        Alias: bytesToString(alias.String),
        AliasLoc: aliasLoc,
        Name: name,
        OriginalName: bytesToString(originalName.String),
      }));

      if (this.lexer.Token !== T.TComma) {
        break;
      }
      if (this.lexer.HasNewlineBefore) {
        isSingleLine = false;
      }
      this.lexer.Next();
      if (this.lexer.HasNewlineBefore) {
        isSingleLine = false;
      }
    }

    if (this.lexer.HasNewlineBefore) {
      isSingleLine = false;
    }
    this.lexer.Expect(T.TCloseBrace);
    return { items, isSingleLine };
  }

  /** Go: func (p *parser) parseExportClause() ([]js_ast.ClauseItem, bool) (js_parser.go:5856) */
  parseExportClause(): { items: js_ast.ClauseItem[]; isSingleLine: boolean } {
    const items: js_ast.ClauseItem[] = [];
    let firstNonIdentifierLoc = new Loc(0);
    this.lexer.Expect(T.TOpenBrace);
    let isSingleLine = !this.lexer.HasNewlineBefore;

    while (this.lexer.Token !== T.TCloseBrace) {
      let alias = this.parseClauseAlias("export");
      let aliasLoc = this.lexer.Loc();
      let name = new LocRef(aliasLoc, this.storeNameInRef(alias));
      let originalName = alias;

      // The name can actually be a keyword if we're really an "export from"
      // statement. However, we won't know until later. Allow keywords as
      // identifiers for now and throw an error later if there's no "from".
      if (this.lexer.Token !== T.TIdentifier && firstNonIdentifierLoc.Start === 0) {
        firstNonIdentifierLoc = this.lexer.Loc();
      }
      this.lexer.Next();

      // Go: "export { type xx }" 等 TS 分支属 ts.Parse，本子集不含。
      if (this.lexer.IsContextualKeyword("as")) {
        this.lexer.Next();
        alias = this.parseClauseAlias("export");
        aliasLoc = this.lexer.Loc();
        this.lexer.Next();
      }

      items.push(init(new js_ast.ClauseItem(), {
        Alias: bytesToString(alias.String),
        AliasLoc: aliasLoc,
        Name: name,
        OriginalName: bytesToString(originalName.String),
      }));

      if (this.lexer.Token !== T.TComma) {
        break;
      }
      if (this.lexer.HasNewlineBefore) {
        isSingleLine = false;
      }
      this.lexer.Next();
      if (this.lexer.HasNewlineBefore) {
        isSingleLine = false;
      }
    }

    if (this.lexer.HasNewlineBefore) {
      isSingleLine = false;
    }
    this.lexer.Expect(T.TCloseBrace);

    // Throw an error here if we found a keyword earlier and this isn't an
    // "export from" statement after all
    if (firstNonIdentifierLoc.Start !== 0 && !this.lexer.IsContextualKeyword("from")) {
      const r = RangeOfIdentifier(this.source, firstNonIdentifierLoc);
      AddError(this.log, this.tracker, r, `Expected identifier but found ${goQuoted(bytesToString(this.source.TextForRange(r)))}`);
      throw new LexerPanic();
    }

    return { items, isSingleLine };
  }

  /** Go: func (p *parser) parsePath() (logger.Range, string, *ast.ImportAssertOrWith, ast.ImportRecordFlags) (js_parser.go:6648) */
  parsePath(): { pathRange: Range; pathText: string; assertOrWith: ast.ImportAssertOrWith | null; flags: number } {
    let flags = 0;
    const pathRange = this.lexer.Range();
    const pathText = bytesToString(UTF16ToString(this.lexer.StringLiteral()));
    if (this.tokenIs(T.TNoSubstitutionTemplateLiteral)) {
      this.lexer.Next();
    } else {
      this.lexer.Expect(T.TStringLiteral);
    }

    // See https://github.com/tc39/proposal-import-attributes for more info
    let assertOrWith: ast.ImportAssertOrWith | null = null;
    if (this.tokenIs(T.TWith) || (!this.lexer.HasNewlineBefore && this.lexer.IsContextualKeyword("assert"))) {
      // "import './foo.json' assert { type: 'json' }"
      // "import './foo.json' with { type: 'json' }"
      const entries: ast.AssertOrWithEntry[] = [];
      const seen = new Set<string>();
      let keyword: ast.AssertOrWithKeyword = ast.AssertOrWithKeyword.WithKeyword;
      if (!this.tokenIs(T.TWith)) {
        keyword = ast.AssertOrWithKeyword.AssertKeyword;
      }
      const keywordLoc = this.saveExprCommentsHere();
      this.lexer.Next();
      const openBraceLoc = this.saveExprCommentsHere();
      this.lexer.Expect(T.TOpenBrace);

      while (!this.tokenIs(T.TCloseBrace)) {
        // Parse the key
        const keyLoc = this.saveExprCommentsHere();
        let preferQuotedKey = false;
        let key: number[];
        let keyText: string;
        if (this.lexer.IsIdentifierOrKeyword()) {
          keyText = bytesToString(this.lexer.Identifier.String);
          key = Array.from(StringToUTF16(this.lexer.Identifier.String));
        } else if (this.tokenIs(T.TStringLiteral)) {
          key = Array.from(this.lexer.StringLiteral());
          keyText = bytesToString(UTF16ToString(new Uint16Array(key)));
          preferQuotedKey = true;
        } else {
          this.lexer.Expect(T.TIdentifier);
          key = [];
          keyText = "";
        }
        // Go: 重复的 import assertion/attribute 是错误（只记诊断，不改变 AST）
        void seen;
        this.lexer.Next();
        this.lexer.Expect(T.TColon);

        // Parse the value
        const valueLoc = this.saveExprCommentsHere();
        const value = Array.from(this.lexer.StringLiteral());
        this.lexer.Expect(T.TStringLiteral);

        entries.push({
          Key: key,
          KeyLoc: keyLoc,
          Value: value,
          ValueLoc: valueLoc,
          PreferQuotedKey: preferQuotedKey,
        });

        // Using "assert: { type: 'json' }" triggers special behavior
        if (keyword === ast.AssertOrWithKeyword.AssertKeyword && keyText === "type" &&
          bytesToString(UTF16ToString(new Uint16Array(value))) === "json") {
          flags |= ast.ImportRecordFlags.AssertTypeJSON;
        }

        if (!this.tokenIs(T.TComma)) {
          break;
        }
        this.lexer.Next();
      }

      const closeBraceLoc = this.saveExprCommentsHere();
      this.lexer.Expect(T.TCloseBrace);
      assertOrWith = init(new ast.ImportAssertOrWith(), {
        Entries: entries,
        Keyword: keyword,
        KeywordLoc: keywordLoc,
        InnerOpenBraceLoc: openBraceLoc,
        InnerCloseBraceLoc: closeBraceLoc,
      });
    }

    return { pathRange, pathText, assertOrWith, flags };
  }

  /** Go: func (p *parser) addImportRecord(kind, phase, pathRange, text, assertOrWith, flags) uint32 */
  addImportRecord(
    kind: ImportKind,
    phase: ImportPhase,
    pathRange: Range,
    text: string,
    assertOrWith: ast.ImportAssertOrWith | null,
    flags: number,
  ): number {
    const index = this.importRecords.length;
    const record = new js_ast.ImportRecord();
    record.Kind = kind;
    record.Range = pathRange;
    record.Path = new Path();
    record.Path.Text = text;
    record.Phase = phase;
    record.Flags = flags;
    record.AssertOrWith = assertOrWith;
    this.importRecords.push(record);
    return index;
  }

  /** Go: func (p *parser) parseBinding(opts parseBindingOpts) js_ast.Binding (js_parser.go:5999) */
  parseBinding(kind: SymbolKind): js_ast.Binding {
    const loc = this.lexer.Loc();

    switch (this.lexer.Token) {
      case T.TIdentifier: {
        const name = bytesToString(this.lexer.Identifier.String);
        const ref = this.declareSymbol(kind, loc, name);
        this.lexer.Next();
        return init(new js_ast.Binding(), { Data: new js_ast.BIdentifier(ref), Loc: loc });
      }

      case T.TOpenBracket: {
        this.lexer.Next();
        let isSingleLine = !this.lexer.HasNewlineBefore;
        const items: js_ast.ArrayBinding[] = [];
        let hasSpread = false;

        // "in" expressions are allowed
        const oldAllowIn = this.allowIn;
        this.allowIn = true;

        while (this.lexer.Token !== T.TCloseBracket) {
          const itemLoc = this.saveExprCommentsHere();

          if (this.lexer.Token === T.TComma) {
            items.push(init(new js_ast.ArrayBinding(), {
              Binding: init(new js_ast.Binding(), { Loc: itemLoc, Data: js_ast.BMissingShared }),
              Loc: itemLoc,
            }));
          } else {
            if (this.lexer.Token === T.TDotDotDot) {
              this.lexer.Next();
              hasSpread = true;
            }

            const binding = this.parseBinding(kind);

            let defaultValueOrNil: js_ast.Expr | null = null;
            if (!hasSpread && this.lexer.Token === T.TEquals) {
              this.lexer.Next();
              defaultValueOrNil = this.parseExpr(js_ast.L.LComma);
            }

            items.push(init(new js_ast.ArrayBinding(), {
              Binding: binding,
              DefaultValueOrNil: defaultValueOrNil,
              Loc: itemLoc,
            }));

            // Commas after spread elements are not allowed
            if (hasSpread && this.lexer.Token === T.TComma) {
              AddError(this.log, this.tracker, this.lexer.Range(), 'Unexpected "," after rest pattern');
              throw new LexerPanic();
            }
          }

          if (this.lexer.Token !== T.TComma) break;
          if (this.lexer.HasNewlineBefore) isSingleLine = false;
          this.lexer.Next();
          if (this.lexer.HasNewlineBefore) isSingleLine = false;
        }

        this.allowIn = oldAllowIn;

        if (this.lexer.HasNewlineBefore) isSingleLine = false;
        const closeBracketLoc = this.saveExprCommentsHere();
        this.lexer.Expect(T.TCloseBracket);
        return init(new js_ast.Binding(), {
          Data: init(new js_ast.BArray(), {
            Items: items,
            HasSpread: hasSpread,
            IsSingleLine: isSingleLine,
            CloseBracketLoc: closeBracketLoc,
          }),
          Loc: loc,
        });
      }

      case T.TOpenBrace: {
        this.lexer.Next();
        let isSingleLine = !this.lexer.HasNewlineBefore;
        const properties: js_ast.PropertyBinding[] = [];

        // "in" expressions are allowed
        const oldAllowIn = this.allowIn;
        this.allowIn = true;

        while (this.lexer.Token !== T.TCloseBrace) {
          this.saveExprCommentsHere();
          const property = this.parsePropertyBinding(kind);
          properties.push(property);

          // Commas after spread elements are not allowed
          if (property.IsSpread && this.lexer.Token === T.TComma) {
            AddError(this.log, this.tracker, this.lexer.Range(), 'Unexpected "," after rest pattern');
            throw new LexerPanic();
          }

          if (this.lexer.Token !== T.TComma) break;
          if (this.lexer.HasNewlineBefore) isSingleLine = false;
          this.lexer.Next();
          if (this.lexer.HasNewlineBefore) isSingleLine = false;
        }

        this.allowIn = oldAllowIn;

        if (this.lexer.HasNewlineBefore) isSingleLine = false;
        const closeBraceLoc = this.saveExprCommentsHere();
        this.lexer.Expect(T.TCloseBrace);
        return init(new js_ast.Binding(), {
          Data: init(new js_ast.BObject(), {
            Properties: properties,
            IsSingleLine: isSingleLine,
            CloseBraceLoc: closeBraceLoc,
          }),
          Loc: loc,
        });
      }
    }

    this.lexer.Expect(T.TIdentifier);
    return new js_ast.Binding();
  }

  /** Go: func (p *parser) parsePropertyBinding() js_ast.PropertyBinding */
  parsePropertyBinding(kind: SymbolKind): js_ast.PropertyBinding {
    let key = new js_ast.Expr();
    let closeBracketLoc = new Loc(0);
    let isComputed = false;
    let preferQuotedKey = false;
    const loc = this.lexer.Loc();

    switch (this.lexer.Token) {
      case T.TDotDotDot: {
        this.lexer.Next();
        const valueLoc = this.saveExprCommentsHere();
        const name = bytesToString(this.lexer.Identifier.String);
        this.lexer.Expect(T.TIdentifier);
        const ref = this.declareSymbol(kind, valueLoc, name);
        return init(new js_ast.PropertyBinding(), {
          Loc: loc,
          IsSpread: true,
          Value: init(new js_ast.Binding(), { Loc: valueLoc, Data: new js_ast.BIdentifier(ref) }),
        });
      }

      case T.TNumericLiteral:
        key = new js_ast.Expr(new js_ast.ENumber(this.lexer.Number), this.lexer.Loc());
        this.lexer.Next();
        break;

      case T.TStringLiteral:
        key = this.parseStringLiteral();
        preferQuotedKey = true;
        break;

      case T.TBigIntegerLiteral: {
        const value = bytesToString(this.lexer.Identifier.String);
        key = new js_ast.Expr(new js_ast.EBigInt(value), this.lexer.Loc());
        this.lexer.Next();
        break;
      }

      case T.TOpenBracket:
        isComputed = true;
        this.lexer.Next();
        key = this.parseExpr(js_ast.L.LComma);
        closeBracketLoc = this.saveExprCommentsHere();
        this.lexer.Expect(T.TCloseBracket);
        break;

      default: {
        const name = this.lexer.Identifier;
        const nameRange = this.lexer.Range();
        if (!this.lexer.IsIdentifierOrKeyword()) {
          this.lexer.Expect(T.TIdentifier);
        }
        this.lexer.Next();
        key = new js_ast.Expr(new js_ast.EString(utf16FromString(bytesToString(name.String))), nameRange.Loc);

        if (this.lexer.Token !== T.TColon && this.lexer.Token !== T.TOpenParen) {
          const ref = this.declareSymbol(kind, nameRange.Loc, bytesToString(name.String));
          const value = init(new js_ast.Binding(), {
            Loc: nameRange.Loc,
            Data: new js_ast.BIdentifier(ref),
          });

          let defaultValueOrNil: js_ast.Expr | null = null;
          if (this.lexer.Token === T.TEquals) {
            this.lexer.Next();
            defaultValueOrNil = this.parseExpr(js_ast.L.LComma);
          }

          return init(new js_ast.PropertyBinding(), {
            Loc: loc,
            Key: key,
            Value: value,
            DefaultValueOrNil: defaultValueOrNil,
          });
        }
        break;
      }
    }

    this.lexer.Expect(T.TColon);
    const value = this.parseBinding(kind);

    let defaultValueOrNil: js_ast.Expr | null = null;
    if (this.tokenIs(T.TEquals)) {
      this.lexer.Next();
      defaultValueOrNil = this.parseExpr(js_ast.L.LComma);
    }

    return init(new js_ast.PropertyBinding(), {
      Loc: loc,
      IsComputed: isComputed,
      PreferQuotedKey: preferQuotedKey,
      Key: key,
      Value: value,
      DefaultValueOrNil: defaultValueOrNil,
      CloseBracketLoc: closeBracketLoc,
    });
  }

  /** Go: func (p *parser) parseFnStmt(loc logger.Loc, opts parseStmtOpts, isAsync bool, asyncRange logger.Range) js_ast.Stmt */
  parseFnStmt(loc: Loc, opts: parseStmtOpts, isAsync: boolean): js_ast.Stmt {
    // Go: parseFnStmt 入口处当前 token 已经是 "function" 之后（调用方负责消费 function）
    const isGenerator = this.lexer.Token === T.TAsterisk;
    // Go: js_parser.go:6772-6780 —— lexicalDeclForbid；if/label 体里只允许普通函数
    if (opts.lexicalDecl === 0) {
      this.forbidLexicalDecl(loc);
    } else if ((opts.lexicalDecl === 2 || opts.lexicalDecl === 3) && (isGenerator || isAsync)) {
      this.forbidLexicalDecl(loc);
    }
    if (isGenerator) {
      this.lexer.Next();
    }

    // Go: js_parser.go:6803 —— if 里的单语句函数声明需要假 ScopeBlock
    const hasIfScope = opts.lexicalDecl === 2 && !isGenerator && !isAsync;
    // Go: js_parser.go:2581 —— async 语法特性诊断
    if (isAsync) markAsyncFn(this, new Range(loc, 5), isGenerator);
    if (hasIfScope) this.pushScopeForParsePass(js_ast.ScopeKind.ScopeBlock, loc);
    const fn = this.parseFn(loc, isAsync, isGenerator, true /* isStatement */, opts.isNameOptional);
    if (hasIfScope) this.popScope();
    fn.HasIfScope = hasIfScope;
    this.validateFunctionName(fn, fnKind.fnStmt);
    return new js_ast.Stmt(init(new js_ast.SFunction(), { Fn: fn, IsExport: opts.isExport }), loc);
  }

  /** Go: func (p *parser) parseExprWithFlags(level js_ast.L, flags exprFlag) js_ast.Expr (js_parser.go:4228) */
  parseExprWithFlags(level: js_ast.L, flags: exprFlag): js_ast.Expr {
    return this.parseExprCommon(level, flags);
  }

  /** Go: func (p *parser) validateFunctionName(fn js_ast.Fn, kind fnKind) (js_parser.go:6374) */
  validateFunctionName(fn: js_ast.Fn, kind: number): void {
    // Prevent the function name from being the same as a function-specific keyword
    if (fn.Name !== null) {
      const name = this.symbols[fn.Name.Ref.InnerIndex].OriginalName;
      if (fn.IsAsync && name === "await") {
        AddError(
          this.log,
          this.tracker,
          RangeOfIdentifier(this.source, fn.Name.Loc),
          'An async function cannot be named "await"',
        );
      } else if (fn.IsGenerator && name === "yield" && kind === fnKind.fnExpr) {
        AddError(
          this.log,
          this.tracker,
          RangeOfIdentifier(this.source, fn.Name.Loc),
          'A generator function expression cannot be named "yield"',
        );
      }
    }
  }

  /**
   * Go: func (p *parser) parseFn(loc logger.Loc, opts parseFnOpts) (fn js_ast.Fn, hadBody bool)
   *
   * SKELETON: 只支持「标识符参数 + 可选默认值以外的简单形态」；参数作用域与函数体作用域
   * 按 Go 的 ScopeFunctionArgs/ScopeFunctionBody 两层建立（函数体作用域会复制参数名，
   * 见 pushScopeForParsePass 的注释）。
   */
  parseFn(
    loc: Loc,
    isAsync: boolean,
    isGenerator: boolean,
    isStatement: boolean,
    isNameOptional: boolean = false,
    allowSuperCall: boolean = false,
    allowSuperProperty: boolean = false,
  ): js_ast.Fn {
    const __d0 = this.scopeDepth();
    const fn = new js_ast.Fn();
    fn.IsAsync = isAsync;
    fn.IsGenerator = isGenerator;

    // Go: parseFn 把 fnOrArrowDataParse 换成调用方给的数据（super 权限随之生效）
    const oldAllowSuperCall = this.allowSuperCall;
    const oldAllowSuperProperty = this.allowSuperProperty;
    const oldAwaitIsIdentifier = this.awaitIsIdentifier;
    this.allowSuperCall = allowSuperCall;
    this.allowSuperProperty = allowSuperProperty;
    this.awaitIsIdentifier = !isAsync;

    // Function name
    if (this.lexer.Token === T.TIdentifier) {
      const nameLoc = this.lexer.Loc();
      const name = bytesToString(this.lexer.Identifier.String);
      const kind = (isAsync || isGenerator)
        ? SymbolKind.SymbolGeneratorOrAsyncFunction
        : SymbolKind.SymbolHoistedFunction;
      const ref = this.declareSymbol(kind, nameLoc, name);
      fn.Name = new LocRef(nameLoc, ref);
      this.lexer.Next();
    } else if (isStatement && !isNameOptional) {
      this.lexer.Expected(T.TIdentifier);
    }

    // Argument list
    // Go: fn.OpenParenLoc 在 Expect 之前取（得到 "(" 的位置）
    fn.OpenParenLoc = this.lexer.Loc();
    this.lexer.Expect(T.TOpenParen);

    // Go: 函数声明由调用方 push ScopeFunctionArgs，loc 是 "("（js_parser.go:6808）；
    // 函数表达式的 loc 是 "function" 关键字（:3107）。TS 把 push 放在 parseFn 内，
    // 这里按 isStatement 区分，使 parse/visit 两趟的 (kind, loc) 对齐。
    this.pushScopeForParsePass(js_ast.ScopeKind.ScopeFunctionArgs, isStatement ? fn.OpenParenLoc : loc);
    const argsScope = this.currentScope!;

    while (this.lexer.Token !== T.TCloseParen) {
      // Go: rest argument "...a"
      if (!fn.HasRestArg && this.lexer.Token === T.TDotDotDot) {
        this.lexer.Next();
        fn.HasRestArg = true;
      }

      const argLoc = this.lexer.Loc();
      const binding = this.parseBinding(SymbolKind.SymbolHoisted);

      // Go: 默认参数值（"function f(a = 1)"）
      let defaultValueOrNil: js_ast.Expr | null = null;
      if (!fn.HasRestArg && this.lexer.Token === T.TEquals) {
        this.lexer.Next();
        defaultValueOrNil = this.parseExpr(js_ast.L.LComma);
      }

      const arg = new js_ast.Arg();
      arg.Binding = binding;
      arg.DefaultOrNil = defaultValueOrNil;
      void argLoc;
      fn.Args.push(arg);

      if (this.lexer.Token !== T.TComma) {
        break;
      }
      if (fn.HasRestArg) {
        // JavaScript does not allow a comma after a rest argument
        this.lexer.Expect(T.TCloseParen);
        break;
      }
      this.lexer.Next();
    }
    this.lexer.Expect(T.TCloseParen);

    // Function body
    fn.Body = this.parseFnBody(new fnOrArrowDataParse());
    this.allowSuperCall = oldAllowSuperCall;
    this.allowSuperProperty = oldAllowSuperProperty;
    this.awaitIsIdentifier = oldAwaitIsIdentifier;
    // Go: parseFn 本身不 push/pop 作用域（Args 由调用方管）；TS 骨架把 Args 放在
    // parseFn 内，所以这里只 pop 这一层。Body 的 push/pop 由 parseFnBody 自己平衡。
    this.popScope();
    if (this.scopeDepth() !== __d0) {
      throw new Error(`Internal error: parseFn changed the scope stack depth (${__d0} -> ${this.scopeDepth()}) at ${loc.Start}`);
    }

    return fn;
  }

  // -------------------------------------------------------------------------
  // class
  // -------------------------------------------------------------------------

  /** Go: func (p *parser) parseDecorators(...) (js_parser.go:6890) 的 JS 子集 */
  parseDecorators(): js_ast.Decorator[] {
    const decorators: js_ast.Decorator[] = [];
    while (this.tokenIs(T.TAt)) {
      const atLoc = this.lexer.Loc();
      this.lexer.Next();
      const value = this.parseDecorator();
      decorators.push(init(new js_ast.Decorator(), {
        Value: value,
        AtLoc: atLoc,
        OmitNewlineAfter: !this.lexer.HasNewlineBefore,
      }));
    }
    return decorators;
  }

  /** Go: func (p *parser) parseDecorator() js_ast.Expr (js_parser.go:6955) —— JS 的受限语法 */
  parseDecorator(): js_ast.Expr {
    if (this.lexer.Token === T.TOpenParen) {
      this.lexer.Next();
      const value = this.parseExpr(js_ast.L.LLowest);
      this.lexer.Expect(T.TCloseParen);
      return value;
    }

    const name = this.lexer.Identifier;
    const nameRange = this.lexer.Range();
    this.lexer.Expect(T.TIdentifier);

    let memberExpr = new js_ast.Expr(new js_ast.EIdentifier(this.resolveName(bytesToString(name.String), nameRange.Loc)), nameRange.Loc);

    loop: for (;;) {
      switch (this.lexer.Token) {
        case T.TDot:
        case T.TQuestionDot: {
          this.lexer.Next();
          if (this.tokenIs(T.TPrivateIdentifier)) {
            const privateName = this.lexer.Identifier;
            const privateLoc = this.lexer.Loc();
            this.lexer.Next();
            this.reportPrivateNameUsage(bytesToString(privateName.String));
            memberExpr = new js_ast.Expr(init(new js_ast.EIndex(), {
              Target: memberExpr,
              Index: new js_ast.Expr(new js_ast.EPrivateIdentifier(this.resolveName(bytesToString(privateName.String), privateLoc)), privateLoc),
            }), memberExpr.Loc);
          } else {
            const memberName = bytesToString(this.lexer.Identifier.String);
            const memberLoc = this.lexer.Loc();
            this.lexer.Expect(T.TIdentifier);
            memberExpr = new js_ast.Expr(init(new js_ast.EDot(), {
              Target: memberExpr,
              Name: memberName,
              NameLoc: memberLoc,
            }), memberExpr.Loc);
          }
          break;
        }

        case T.TOpenParen: {
          const args = this.parseCallArgs();
          memberExpr = new js_ast.Expr(init(new js_ast.ECall(), {
            Target: memberExpr,
            Args: args.args,
            CloseParenLoc: args.closeParenLoc,
            IsMultiLine: args.isMultiLine,
            Kind: js_ast.CallKind.TargetWasOriginallyPropertyAccess,
          }), memberExpr.Loc);

          // The grammar for "DecoratorCallExpression" currently forbids anything after it
          if (this.tokenIs(T.TDot)) {
            continue;
          }
          break loop;
        }

        default:
          break loop;
      }
    }

    return memberExpr;
  }

  /** Go: func (p *parser) parseClassStmt(loc logger.Loc, opts parseStmtOpts) js_ast.Stmt */
  parseClassStmt(loc: Loc, opts: parseStmtOpts, decorators: js_ast.Decorator[] = []): js_ast.Stmt {
    if (decorators.length === 0 && opts.deferredDecorators !== null) {
      decorators = opts.deferredDecorators;
    }
    let name: LocRef | null = null;
    const classKeyword = this.lexer.Range();
    if (this.lexer.Token === T.TClass) {
      this.lexer.Next();
    } else {
      this.lexer.Expected(T.TClass);
    }

    // Go: !opts.isNameOptional（"export default class {}" 时名字可选）
    if (!opts.isNameOptional || this.lexer.Token === T.TIdentifier) {
      const nameLoc = this.lexer.Loc();
      const nameText = bytesToString(this.lexer.Identifier.String);
      this.lexer.Expect(T.TIdentifier);
      name = new LocRef(nameLoc, this.declareSymbol(SymbolKind.SymbolClass, nameLoc, nameText));
    }

    this.pushScopeForParsePass(js_ast.ScopeKind.ScopeClassName, loc);
    // Go 两趟 parser 在 visit pass 为 class 建不可变内层类名（innerClassNameRef），
    // class body 里的自引用会绑到它。TS 一趟 parser 必须在 parse 期就把它注入 class
    // 作用域，否则自引用绑到外层符号，bundle 输出 `class { x = Foo }` 而非 Go 的
    // `class _Foo { x = _Foo }`。仅 ModeBundle 需要；pass-through 行为保持不变。
    let classInnerNameRef: Ref = InvalidRef;
    if (name !== null && this.options.mode === 2 /* ModeBundle */) {
      const outerName = this.symbols[name.Ref.InnerIndex].OriginalName;
      classInnerNameRef = this.newSymbol(SymbolKind.SymbolConst, "_" + outerName);
      const member = new js_ast.ScopeMember();
      member.Loc = name.Loc;
      member.Ref = classInnerNameRef;
      this.currentScope!.Members.set(outerName, member);
    }
    const classValue = this.parseClass(classKeyword, name, decorators);
    if (classInnerNameRef.InnerIndex !== InvalidRef.InnerIndex) classValue.InnerNameRef = classInnerNameRef;
    this.popScope();

    return new js_ast.Stmt(init(new js_ast.SClass(), {
      Class: classValue,
      IsExport: opts.isExport,
    }), loc);
  }

  /** Go: func (p *parser) parseClassExpr(decorators []js_ast.Decorator) js_ast.Expr */
  parseClassExpr(decorators: js_ast.Decorator[] = []): js_ast.Expr {
    const classKeyword = this.lexer.Range();
    this.lexer.Expect(T.TClass);
    let name: LocRef | null = null;

    this.pushScopeForParsePass(js_ast.ScopeKind.ScopeClassName, classKeyword.Loc);

    // Parse an optional class name
    if (this.lexer.Token === T.TIdentifier) {
      const nameLoc = this.lexer.Loc();
      const nameText = bytesToString(this.lexer.Identifier.String);
      name = new LocRef(nameLoc, this.newSymbol(SymbolKind.SymbolOther, nameText));
      this.lexer.Next();
    }

    const classValue = this.parseClass(classKeyword, name, decorators);
    this.popScope();

    return new js_ast.Expr(init(new js_ast.EClass(), { Class: classValue }), classKeyword.Loc);
  }

  /** Go: func (p *parser) parseClass(classKeyword logger.Range, name *ast.LocRef, classOpts parseClassOpts) js_ast.Class */
  parseClass(classKeyword: Range, name: LocRef | null, decorators: js_ast.Decorator[] = []): js_ast.Class {
    let extendsOrNil: js_ast.Expr | null = null;

    if (this.lexer.Token === T.TExtends) {
      this.lexer.Next();
      extendsOrNil = this.parseExpr(js_ast.L.LNew);
    }

    const bodyLoc = this.lexer.Loc();
    this.lexer.Expect(T.TOpenBrace);
    const properties: js_ast.Property[] = [];

    // Allow "in" and private fields inside class bodies
    const oldAllowIn = this.allowIn;
    this.allowIn = true;

    this.pushScopeForParsePass(js_ast.ScopeKind.ScopeClassBody, bodyLoc);

    const opts = new propertyOpts();
    opts.isClass = true;
    opts.classHasExtends = extendsOrNil !== null;
    opts.classKeyword = classKeyword;

    while (this.lexer.Token !== T.TCloseBrace) {
      if (this.lexer.Token === T.TSemicolon) {
        this.lexer.Next();
        continue;
      }

      // Go: js_parser.go:6549 —— 类成员装饰器（@dec）
      opts.decorators = this.parseDecorators();

      properties.push(this.parseProperty(this.saveExprCommentsHere(), js_ast.PropertyKind.PropertyField, opts));
    }

    this.popScope();
    this.allowIn = oldAllowIn;

    const closeBraceLoc = this.saveExprCommentsHere();
    this.lexer.Expect(T.TCloseBrace);

    const classValue = new js_ast.Class();
    classValue.ClassKeyword = classKeyword;
    classValue.Name = name;
    classValue.ExtendsOrNil = extendsOrNil;
    classValue.BodyLoc = bodyLoc;
    classValue.Properties = properties;
    classValue.CloseBraceLoc = closeBraceLoc;
    classValue.Decorators = decorators;
    // Go: UseDefineForClassFields: !p.options.ts.Parse → true
    classValue.UseDefineForClassFields = true;
    return classValue;
  }

  // -------------------------------------------------------------------------
  // 表达式
  // -------------------------------------------------------------------------

  /** Go: js_parser.go:2527-2549 —— 私有名字声明为正确的 SymbolKind（J-2 lowerClass 的 private 降级依赖此 kind） */
  declarePrivateSymbolIfNeeded(key: js_ast.Expr, kind: js_ast.PropertyKind, isStatic: boolean): void {
    if (!(key.Data instanceof js_ast.EPrivateIdentifier)) return;
    const priv = key.Data;
    // TS 骨架的私有名由 resolveName 创建（OriginalName 存名字），不是 Go 的编码 ref
    const name = this.symbols[priv.Ref.InnerIndex].OriginalName || this.loadNameFromRef(priv.Ref);
    let declare: SymbolKind;
    if (kind === js_ast.PropertyKind.PropertyAutoAccessor) {
      if (isStatic) { declare = SymbolKind.SymbolPrivateStaticGetSetPair; }
      else { declare = SymbolKind.SymbolPrivateGetSetPair; }
      priv.Ref = this.declareSymbol(declare, key.Loc, name);
      this.privateGetters.set(String(priv.Ref.InnerIndex), this.newSymbol(SymbolKind.SymbolOther, name.slice(1) + "_get"));
      this.privateSetters.set(String(priv.Ref.InnerIndex), this.newSymbol(SymbolKind.SymbolOther, name.slice(1) + "_set"));
    } else {
      declare = isStatic ? SymbolKind.SymbolPrivateStaticField : SymbolKind.SymbolPrivateField;
      priv.Ref = this.declareSymbol(declare, key.Loc, name);
    }
  }

  /**
   * Go: func (p *parser) parseProperty(startLoc logger.Loc, kind js_ast.PropertyKind,
   *   opts propertyOpts, errors *deferredErrors) (js_ast.Property, bool)
   *
   * 骨架子集：JS 子集（无 TS / decorators / private identifier / mangled props）。
   */
  parseProperty(startLoc: Loc, kind: js_ast.PropertyKind, opts: propertyOpts): js_ast.Property {
    let flags: js_ast.PropertyFlags = 0;
    let key: js_ast.Expr;
    let closeBracketLoc: Loc = new Loc(0);

    switch (this.lexer.Token) {
      case T.TNumericLiteral:
        key = new js_ast.Expr(new js_ast.ENumber(this.lexer.Number), this.lexer.Loc());
        this.lexer.Next();
        break;

      case T.TStringLiteral:
        key = this.parseStringLiteral();
        // Go: if !p.options.minifySyntax（骨架没有 minifySyntax 选项，恒为 false）
        flags |= js_ast.PropertyFlags.PropertyPreferQuotedKey;
        break;

      case T.TBigIntegerLiteral: {
        const value = bytesToString(this.lexer.Identifier.String);
        key = new js_ast.Expr(new js_ast.EBigInt(value), this.lexer.Loc());
        this.lexer.Next();
        break;
      }

      case T.TPrivateIdentifier: {
        // Go: js_parser.go:2207 —— 类体里的 #name
        if (!opts.isClass) {
          this.lexer.Expected(T.TIdentifier);
        }
        const name = this.lexer.Identifier;
        key = new js_ast.Expr(new js_ast.EPrivateIdentifier(this.resolveName(bytesToString(name.String), this.lexer.Loc())), this.lexer.Loc());
        this.reportPrivateNameUsage(bytesToString(name.String));
        this.lexer.Next();
        break;
      }

      case T.TOpenBracket:
        flags |= js_ast.PropertyFlags.PropertyIsComputed;
        this.lexer.Next();
        key = this.parseExpr(js_ast.L.LComma);
        closeBracketLoc = this.saveExprCommentsHere();
        this.lexer.Expect(T.TCloseBracket);
        break;

      case T.TAsterisk: {
        if (kind !== js_ast.PropertyKind.PropertyField &&
          (kind !== js_ast.PropertyKind.PropertyMethod || opts.isGenerator)) {
          this.lexer.Unexpected();
        }
        const nextOpts = init(new propertyOpts(), opts, { isGenerator: true });
        this.lexer.Next();
        return this.parseProperty(startLoc, js_ast.PropertyKind.PropertyMethod, nextOpts);
      }

      default: {
        const name = bytesToString(this.lexer.Identifier.String);
        const raw = bytesToString(this.lexer.Raw());
        const nameRange = this.lexer.Range();
        if (!this.lexer.IsIdentifierOrKeyword()) {
          this.lexer.Expect(T.TIdentifier);
        }
        this.lexer.Next();

        // Support contextual keywords
        if (kind === js_ast.PropertyKind.PropertyField) {
          // Does the following token look like a key?
          let couldBeModifierKeyword = this.lexer.IsIdentifierOrKeyword();
          if (!couldBeModifierKeyword) {
            switch (this.lexer.Token) {
              case T.TOpenBracket:
              case T.TNumericLiteral:
              case T.TStringLiteral:
              case T.TPrivateIdentifier:
                couldBeModifierKeyword = true;
                break;
              case T.TAsterisk:
                if (opts.isAsync || (raw !== "get" && raw !== "set")) {
                  couldBeModifierKeyword = true;
                }
                break;
            }
          }

          // If so, check for a modifier keyword
          if (couldBeModifierKeyword) {
            switch (raw) {
              case "get":
                if (!opts.isAsync) {
                  return this.parseProperty(
                    startLoc,
                    js_ast.PropertyKind.PropertyGetter,
                    init(new propertyOpts(), opts),
                  );
                }
                break;

              case "set":
                if (!opts.isAsync) {
                  return this.parseProperty(
                    startLoc,
                    js_ast.PropertyKind.PropertySetter,
                    init(new propertyOpts(), opts),
                  );
                }
                break;

              case "accessor":
                // Go: js_parser.go:2295 —— "accessor x" 自动访问器字段
                if (!this.lexer.HasNewlineBefore && !opts.isAsync && opts.isClass) {
                  return this.parseProperty(
                    startLoc,
                    js_ast.PropertyKind.PropertyAutoAccessor,
                    init(new propertyOpts(), opts),
                  );
                }
                break;

              case "async":
                if (!this.lexer.HasNewlineBefore && !opts.isAsync) {
                  const asyncOpts = init(new propertyOpts(), opts, { isAsync: true });
                  return this.parseProperty(startLoc, js_ast.PropertyKind.PropertyMethod, asyncOpts);
                }
                break;

              case "static":
                if (!opts.isStatic && !opts.isAsync && opts.isClass) {
                  const staticOpts = init(new propertyOpts(), opts, { isStatic: true });
                  return this.parseProperty(startLoc, kind, staticOpts);
                }
                break;
            }
          } else if (this.lexer.Token === T.TOpenBrace && name === "static") {
            // "static { ... }" class static block
            const loc = this.lexer.Loc();
            this.lexer.Next();

            // Go: 静态块里允许 super.property；不允许 return
            const oldAllowSuperPropertyStatic = this.allowSuperProperty;
            const oldAllowSuperCallStatic = this.allowSuperCall;
            this.allowSuperProperty = true;
            this.allowSuperCall = false;

            this.pushScopeForParsePass(js_ast.ScopeKind.ScopeClassStaticInit, loc);
            const stmts = this.parseStmtsUpTo(T.TCloseBrace, new parseStmtOpts());
            this.popScope();

            this.allowSuperProperty = oldAllowSuperPropertyStatic;
            this.allowSuperCall = oldAllowSuperCallStatic;

            const closeBraceLoc = this.lexer.Loc();
            this.lexer.Expect(T.TCloseBrace);
            return init(new js_ast.Property(), {
              Kind: js_ast.PropertyKind.PropertyClassStaticBlock,
              Loc: startLoc,
              ClassStaticBlock: init(new js_ast.ClassStaticBlock(), {
                Loc: loc,
                Block: init(new js_ast.SBlock(), { Stmts: stmts, CloseBraceLoc: closeBraceLoc }),
              }),
            });
          }
        }

        key = new js_ast.Expr(new js_ast.EString(utf16FromString(name)), nameRange.Loc);

        // Parse a shorthand property
        if (!opts.isClass && kind === js_ast.PropertyKind.PropertyField &&
          this.lexer.Token !== T.TColon && this.lexer.Token !== T.TOpenParen &&
          this.lexer.Token !== T.TLessThan && (Keywords.get(name) ?? 0) === 0) {
          const ref = this.resolveName(name, key.Loc);
          const value = new js_ast.Expr(new js_ast.EIdentifier(ref), key.Loc);

          // Destructuring patterns have an optional default value
          let initializerOrNil: js_ast.Expr | null = null;
          if (this.lexer.Token === T.TEquals) {
            this.lexer.Next();
            initializerOrNil = this.parseExpr(js_ast.L.LComma);
          }

          return init(new js_ast.Property(), {
            Kind: kind,
            Loc: startLoc,
            Key: key,
            ValueOrNil: value,
            InitializerOrNil: initializerOrNil,
            Flags: js_ast.PropertyFlags.PropertyWasShorthand,
          });
        }
        break;
      }
    }

    // Parse a class field with an optional initial value
    if (kind === js_ast.PropertyKind.PropertyAutoAccessor ||
      (opts.isClass && kind === js_ast.PropertyKind.PropertyField && this.lexer.Token !== T.TOpenParen)) {
      let initializerOrNil: js_ast.Expr | null = null;

      if (this.lexer.Token === T.TEquals) {
        this.lexer.Next();

        // Go: "this" and "super" property access is allowed in field initializers
        const oldAllowSuperPropertyInit = this.allowSuperProperty;
        this.allowSuperProperty = true;
        initializerOrNil = this.parseExpr(js_ast.L.LComma);
        this.allowSuperProperty = oldAllowSuperPropertyInit;
      }

      this.lexer.ExpectOrInsertSemicolon();
      this.declarePrivateSymbolIfNeeded(key, kind, opts.isStatic);
      if (opts.isStatic) flags |= js_ast.PropertyFlags.PropertyIsStatic;
      return init(new js_ast.Property(), {
        Loc: startLoc,
        Kind: kind,
        Flags: flags,
        Key: key,
        InitializerOrNil: initializerOrNil,
        CloseBracketLoc: closeBracketLoc,
        Decorators: opts.decorators,
      });
    }

    // Parse a method expression
    if (this.lexer.Token === T.TOpenParen || js_ast.IsMethodDefinition(kind) || opts.isClass) {
      const loc = this.lexer.Loc();

      // Go: 类方法里 super.property 合法；派生类 constructor 里 super() 合法
      let isConstructor = false;
      if (opts.isClass && !(flags & js_ast.PropertyFlags.PropertyIsComputed) &&
        key.Data instanceof js_ast.EString) {
        if (!opts.isStatic && UTF16EqualsString(key.Data.Value, new TextEncoder().encode("constructor"))) {
          if (kind !== js_ast.PropertyKind.PropertyGetter && kind !== js_ast.PropertyKind.PropertySetter &&
            !opts.isAsync && !opts.isGenerator) {
            isConstructor = true;
          }
        }
      }

      const fn = this.parseFn(
        loc,
        opts.isAsync,
        opts.isGenerator,
        false /* isStatement */,
        false /* isNameOptional */,
        opts.classHasExtends && isConstructor,
        true /* allowSuperProperty */,
      );
      fn.IsUniqueFormalParameters = true;
      // 注意：js_ast.EFunction 没有接收 Fn 的构造函数（Go 是结构体字面量），必须显式赋值。
      const value = new js_ast.Expr(init(new js_ast.EFunction(), { Fn: fn }), loc);

      switch (kind) {
        case js_ast.PropertyKind.PropertyGetter:
          if (fn.Args.length > 0) {
            const r = RangeOfIdentifier(this.source, fn.Args[0].Binding.Loc);
            AddError(this.log, this.tracker, r, `Getter ${this.keyNameForError(key)} must have zero arguments`);
          }
          break;
        case js_ast.PropertyKind.PropertySetter:
          if (fn.Args.length !== 1) {
            let r = RangeOfIdentifier(this.source, key.Loc);
            if (fn.Args.length > 1) {
              r = RangeOfIdentifier(this.source, fn.Args[1].Binding.Loc);
            }
            AddError(this.log, this.tracker, r, `Setter ${this.keyNameForError(key)} must have exactly one argument`);
          }
          break;
        default:
          kind = js_ast.PropertyKind.PropertyMethod;
      }

      this.declarePrivateSymbolIfNeeded(key, kind, opts.isStatic);
      if (opts.isStatic) flags |= js_ast.PropertyFlags.PropertyIsStatic;
      return init(new js_ast.Property(), {
        Loc: startLoc,
        Kind: kind,
        Flags: flags,
        Key: key,
        ValueOrNil: value,
        CloseBracketLoc: closeBracketLoc,
        Decorators: opts.decorators,
      });
    }

    // Parse an object key/value pair
    this.lexer.Expect(T.TColon);
    const value = this.parseExpr(js_ast.L.LComma);
    return init(new js_ast.Property(), {
      Loc: startLoc,
      Kind: kind,
      Flags: flags,
      Key: key,
      ValueOrNil: value,
      CloseBracketLoc: closeBracketLoc,
    });
  }

  /** Go: func (p *parser) keyNameForError(key js_ast.Expr) string (js_parser.go:2098) */
  keyNameForError(key: js_ast.Expr): string {
    if (key.Data instanceof js_ast.EString) {
      return goQuoted(bytesToString(UTF16ToString(key.Data.Value)));
    }
    if (key.Data instanceof js_ast.EPrivateIdentifier) {
      const ref = key.Data.Ref;
      // DEVIATION（已登记，第 19 轮）：Go 的私有名存的是 name ref；TS 改用 resolveName 存符号 ref。
      // 所以这里按 ref 的种类分别取值，两边都得到包含 "#" 的名字。
      const name = ref.SourceIndex === this.source.Index
        ? this.symbols[ref.InnerIndex].OriginalName
        : this.loadNameFromRef(ref);
      return goQuoted(name);
    }
    return "property";
  }

  /** Go: func (p *parser) forbidLexicalDecl(loc logger.Loc) (js_parser.go:8492) */
  forbidLexicalDecl(loc: Loc): void {
    const r = RangeOfIdentifier(this.source, loc);
    AddErrorWithNotes(this.log, this.tracker, r, "Cannot use a declaration in a single-statement context", [
      init(new MsgData(), { Text: "Wrap this declaration in a block statement to use it here." }),
    ]);
  }

  /** Go: func (p *parser) forbidUsingInSwitch(loc logger.Loc) (js_parser.go:8498) */
  forbidUsingInSwitch(loc: Loc): void {
    const r = RangeOfIdentifier(this.source, loc);
    AddErrorWithNotes(this.log, this.tracker, r, 'Cannot use a "using" declaration directly inside a switch case', [
      init(new MsgData(), { Text: "Wrap this declaration in a block statement to use it here." }),
    ]);
  }

  /** Go: func (p *parser) logDeferredArrowArgErrors(errors *deferredErrors) (js_parser.go:1987) */
  logDeferredArrowArgErrors(errors: deferredErrors): void {
    for (const paren of errors.invalidParens) {
      AddError(this.log, this.tracker, paren, "Invalid binding pattern");
    }
  }

  /** Go: func (p *parser) logArrowArgErrors(errors *deferredArrowArgErrors) (js_parser.go:2088) */
  logArrowArgErrors(errors: deferredArrowArgErrors): void {
    if (errors.invalidExprAwait.Len > 0) {
      AddError(this.log, this.tracker, errors.invalidExprAwait, 'Cannot use an "await" expression here:');
    }

    if (errors.invalidExprYield.Len > 0) {
      AddError(this.log, this.tracker, errors.invalidExprYield, 'Cannot use a "yield" expression here:');
    }
  }

  /** Go: func (p *parser) logNullishCoalescingErrorPrecedenceError(op string) (js_parser.go:1993) */
  logNullishCoalescingErrorPrecedenceError(op: string): void {
    let prevOp = "??";
    if (this.lexer.Token === T.TQuestionQuestion) {
      const before = op;
      op = prevOp;
      prevOp = before;
    }
    AddErrorWithNotes(this.log, this.tracker, this.lexer.Range(),
      `Cannot use ${goQuoted(op)} with ${goQuoted(prevOp)} without parentheses`,
      [init(new MsgData(), {
        Text: `Expressions of the form "x ${prevOp} y ${op} z" are not allowed in JavaScript. ` +
          `You must disambiguate between "(x ${prevOp} y) ${op} z" and "x ${prevOp} (y ${op} z)" by adding parentheses.`,
      })]);
  }

  /** Go: func (p *parser) logAssignToDefine(r logger.Range, name string, expr js_ast.Expr) (js_parser.go:2016) */
  logAssignToDefine(r: Range, name: string, expr: js_ast.Expr): void {
    // If this is a compound expression, pretty-print it for the error message.
    if (expr.Data !== null) {
      const parts: string[] = [];
      for (;;) {
        const data = expr.Data;
        if (data instanceof js_ast.EIdentifier) {
          parts.push(this.loadNameFromRef(data.Ref));
          break;
        } else if (data instanceof js_ast.EDot) {
          parts.push(data.Name);
          parts.push(".");
          expr = data.Target;
        } else if (data instanceof js_ast.EIndex) {
          const index = data.Index.Data;
          if (index instanceof js_ast.EString) {
            parts.push("]");
            parts.push(bytesToString(QuoteSingle(UTF16ToString(index.Value), false)));
            parts.push("[");
            expr = data.Target;
          } else {
            return;
          }
        } else {
          return;
        }
      }
      for (let i = 0, j = parts.length - 1; i < j; i++, j--) {
        const t = parts[i];
        parts[i] = parts[j];
        parts[j] = t;
      }
      name = parts.join("");
    }

    let kind: number = MsgKind.Warning;
    if (this.suppressWarningsAboutWeirdCode) kind = MsgKind.Debug;

    AddIDWithNotes(this.log, MsgID_JS_AssignToDefine, kind, this.tracker, r,
      `Suspicious assignment to defined constant ${goQuoted(name)}`,
      [init(new MsgData(), {
        Text: `The expression ${goQuoted(name)} has been configured to be replaced with a constant using the "define" feature. ` +
          "If this expression is supposed to be a compile-time constant, then it doesn't make sense to assign to it here. " +
          "Or if this expression is supposed to change at run-time, this \"define\" substitution should be removed.",
      })]);
  }

  /** Go: func (p *parser) notesForAssertTypeJSON(record *ast.ImportRecord, alias string) []logger.MsgData (js_parser.go:2117) */
  notesForAssertTypeJSON(record: js_ast.ImportRecord, alias: string): MsgData[] {
    return [
      this.tracker.MsgData(
        RangeOfImportAssertOrWith(this.source, ast.FindAssertOrWithEntry(record.AssertOrWith.Entries, "type")!,
          KeyOrValue.KeyAndValueRange),
        "The JSON import assertion is here:"),
      init(new MsgData(), {
        Text: "You can either keep the import assertion and only use the \"default\" import, " +
          `or you can remove the import assertion and use the ${goQuoted(alias)} import.`,
      }),
    ];
  }

  /** Go: func (p *parser) maybeWarnAboutAssertKeyword(loc logger.Loc) (js_parser.go:6744) */
  maybeWarnAboutAssertKeyword(loc: Loc): void {
    if (
      HasFeature(this.options.unsupportedJSFeatures, JSFeature.ImportAssertions) &&
      !HasFeature(this.options.unsupportedJSFeatures, JSFeature.ImportAttributes)
    ) {
      const where = prettyPrintTargetEnvironment(this.options.originalTargetEnv, this.options.unsupportedJSFeatureOverridesMask);
      const msg = new Msg();
      msg.Kind = MsgKind.Warning;
      msg.Data = this.tracker.MsgData(RangeOfIdentifier(this.source, loc), `The "assert" keyword is not supported in ${where}`);
      msg.Notes = [init(new MsgData(), { Text: 'Did you mean to use "with" instead of "assert"?' })];
      if (msg.Data.Location !== null) msg.Data.Location.Suggestion = "with";
      AddMsgID(this.log, MsgID_JS_AssertToWith, msg);
    }
  }

    /** Go: func (p *parser) whyESModule() (whyESM, []logger.MsgData) (js_parser.go:18283) */
  whyESModule(): [whyESM, MsgData[] | null] {
  const because = "This file is considered to be an ECMAScript module because";
  if (this.esmExportKeyword.Len > 0) {
    return [whyESM.whyESMExportKeyword, [this.tracker.MsgData(this.esmExportKeyword, because + ' of the "export" keyword here:')]];
  }
  if (this.esmImportMeta.Len > 0) {
    return [whyESM.whyESMImportMeta, [this.tracker.MsgData(this.esmImportMeta, because + ' of the use of "import.meta" here:')]];
  }
  if (this.topLevelAwaitKeyword.Len > 0) {
    return [whyESM.whyESMTopLevelAwait, [this.tracker.MsgData(this.topLevelAwaitKeyword, because + ' of the top-level "await" keyword here:')]];
  }

  const mt = this.options.moduleTypeData;
  if (mt !== null && mt.Type === 4) {
    return [whyESM.whyESMFileMJS, [init(new MsgData(), { Text: because + ' the file name ends in ".mjs".' })]];
  }
  if (mt !== null && mt.Type === 5) {
    return [whyESM.whyESMFileMTS, [init(new MsgData(), { Text: because + ' the file name ends in ".mts".' })]];
  }
  if (mt !== null && mt.Type === 6 && mt.Source !== null) {
    const t = MakeLineColumnTracker(mt.Source);
    return [whyESM.whyESMTypeModulePackageJSON, [
      t.MsgData(mt.Range, because + ' the enclosing "package.json" file sets the type of this file to "module":'),
    ]];
  }
  // 这个 case 必须最后：有些代码关心 import 语句关键字，有些不关心
  if (this.esmImportStatementKeyword.Len > 0) {
    return [whyESM.whyESMImportStatement, [this.tracker.MsgData(this.esmImportStatementKeyword, because + ' of the "import" keyword here:')]];
  }
  return [whyESM.whyESMUnknown, null];
}

  /** Go: func (p *parser) validateDeclaredSymbolName(loc logger.Loc, name string) (js_parser.go:6387) */
  validateDeclaredSymbolName(loc: Loc, name: string): void {
  if (StrictModeReservedWords.has(name)) {
    markStrictModeFeature(this, strictModeFeature.reservedWord, RangeOfIdentifier(this.source, loc), name);
  } else if (isEvalOrArguments(name)) {
    markStrictModeFeature(this, strictModeFeature.evalOrArguments, RangeOfIdentifier(this.source, loc), name);
  }
}

/** Go: func (p *parser) checkForUnrepresentableIdentifier(loc logger.Loc, name string) (js_parser.go:12809) */
  checkForUnrepresentableIdentifier(loc: Loc, name: string): void {
    if (
      this.options.asciiOnly &&
      HasFeature(this.options.unsupportedJSFeatures, JSFeature.UnicodeEscapes) &&
      ContainsNonBMPCodePoint(new TextEncoder().encode(name))
    ) {
      if (this.unrepresentableIdentifiers === null) this.unrepresentableIdentifiers = new Map();
      if (!this.unrepresentableIdentifiers.get(name)) {
        this.unrepresentableIdentifiers.set(name, true);
        const where = prettyPrintTargetEnvironment(this.options.originalTargetEnv, this.options.unsupportedJSFeatureOverridesMask);
        const r = RangeOfIdentifier(this.source, loc);
        AddError(this.log, this.tracker, r,
          `${goQuoted(name)} cannot be escaped in ${where} but you can set the charset to "utf8" to allow unescaped Unicode characters`);
      }
    }
  }

  /** Go: func (p *parser) isMangledProp(name string) bool (js_parser.go:2851) */
  isMangledProp(name: string): boolean {
    if (this.options.mangleProps === null) return false;
    if (
      this.options.mangleProps.test(name) &&
      !permanentReservedProps.has(name) &&
      (this.options.reserveProps === null || !this.options.reserveProps.test(name))
    ) {
      return true;
    }
    if (this.reservedProps === null) this.reservedProps = new Map();
    this.reservedProps.set(name, true);
    return false;
  }

  /** Go: func (p *parser) symbolForMangledProp(name string) ast.Ref (js_parser.go:2867) */
  symbolForMangledProp(name: string): Ref {
    if (this.mangledProps === null) this.mangledProps = new Map();
    let ref = this.mangledProps.get(name);
    if (ref === undefined) {
      ref = this.newSymbol(SymbolKind.SymbolMangledProp, name);
      this.mangledProps.set(name, ref);
    }
    if (!this.isControlFlowDead) this.symbols[ref.InnerIndex].UseCountEstimate++;
    return ref;
  }

  /** Go: func (p *parser) dotOrMangledPropParse(...) js_ast.E (js_parser.go:2891) */
  dotOrMangledPropParse(
    target: js_ast.Expr,
    name: MaybeSubstring,
    nameLoc: Loc,
    optionalChain: js_ast.OptionalChain,
    original: wasOriginallyDotOrIndex,
  ): js_ast.E {
    if (
      (original !== wasOriginallyIndex || this.options.mangleQuoted) &&
      this.isMangledProp(bytesToString(name.String))
    ) {
      return init(new js_ast.EIndex(), {
        Target: target,
        Index: new js_ast.Expr(new js_ast.ENameOfSymbol(this.storeNameInRef(name)), nameLoc),
        OptionalChain: optionalChain,
      });
    }

    return init(new js_ast.EDot(), {
      Target: target,
      Name: bytesToString(name.String),
      NameLoc: nameLoc,
      OptionalChain: optionalChain,
    });
  }

  /** Go: func (p *parser) dotOrMangledPropVisit(target js_ast.Expr, name string, nameLoc logger.Loc) js_ast.E (js_parser.go:2914) */
  dotOrMangledPropVisit(target: js_ast.Expr, name: string, nameLoc: Loc): js_ast.E {
    if (this.isMangledProp(name)) {
      return init(new js_ast.EIndex(), {
        Target: target,
        Index: new js_ast.Expr(new js_ast.ENameOfSymbol(this.symbolForMangledProp(name)), nameLoc),
      });
    }

    return init(new js_ast.EDot(), { Target: target, Name: name, NameLoc: nameLoc });
  }

  /** Go: func (p *parser) warnAboutDuplicateProperties(properties []js_ast.Property, in duplicatePropertiesIn) (js_parser.go:1043) */
  warnAboutDuplicateProperties(properties: js_ast.Property[], inObjectLiteral: boolean): void {
    if (properties.length < 2) return;

    const keyMissing = 0;
    const keyNormal = 1;
    const keyGet = 2;
    const keySet = 3;
    const keyGetAndSet = 4;

    const instanceKeys = new Map<string, { loc: Loc; kind: number }>();
    const staticKeys = new Map<string, { loc: Loc; kind: number }>();

    for (const property of properties) {
      if (property.Kind !== js_ast.PropertyKind.PropertySpread && property.Key.Data instanceof js_ast.EString) {
        const keys = js_ast.Has(property.Flags, js_ast.PropertyFlags.PropertyIsStatic) ? staticKeys : instanceKeys;
        const key = bytesToString(UTF16ToString(property.Key.Data.Value));
        const prevKey = keys.get(key);
        const nextKey = { kind: keyNormal, loc: property.Key.Loc };

        if (property.Kind === js_ast.PropertyKind.PropertyGetter) {
          nextKey.kind = keyGet;
        } else if (property.Kind === js_ast.PropertyKind.PropertySetter) {
          nextKey.kind = keySet;
        }

        if (
          prevKey !== undefined &&
          (!inObjectLiteral || key !== "__proto__") &&
          (inObjectLiteral || key !== "constructor")
        ) {
          if (
            (prevKey.kind === keyGet && nextKey.kind === keySet) ||
            (prevKey.kind === keySet && nextKey.kind === keyGet)
          ) {
            nextKey.kind = keyGetAndSet;
          } else {
            const id = inObjectLiteral ? MsgID_JS_DuplicateObjectKey : MsgID_JS_DuplicateClassMember;
            const what = inObjectLiteral ? "key" : "member";
            const where = inObjectLiteral ? "object literal" : "class body";
            const r = RangeOfIdentifier(this.source, property.Key.Loc);
            AddIDWithNotes(this.log, id, MsgKind.Warning, this.tracker, r,
              `Duplicate ${what} ${goQuoted(key)} in ${where}`,
              [this.tracker.MsgData(RangeOfIdentifier(this.source, prevKey.loc),
                `The original ${what} ${goQuoted(key)} is here:`)]);
          }
        }

        keys.set(key, nextKey);
      }
    }
  }

  /** Go: func (p *parser) parseObjectLiteral(loc logger.Loc) js_ast.Expr 的子集 */
  parseObjectLiteral(loc: Loc): js_ast.Expr {
    this.lexer.Expect(T.TOpenBrace);
    let isSingleLine = !this.lexer.HasNewlineBefore;
    const properties: js_ast.Property[] = [];

    // Allow "in" inside object literals
    const oldAllowIn = this.allowIn;
    this.allowIn = true;

    while (this.lexer.Token !== T.TCloseBrace) {
      if (this.lexer.Token === T.TDotDotDot) {
        const dotLoc = this.saveExprCommentsHere();
        this.lexer.Next();
        const value = this.parseExpr(js_ast.L.LComma);
        properties.push(init(new js_ast.Property(), {
          Kind: js_ast.PropertyKind.PropertySpread,
          Loc: dotLoc,
          ValueOrNil: value,
        }));
      } else {
        properties.push(this.parseProperty(this.saveExprCommentsHere(), js_ast.PropertyKind.PropertyField, new propertyOpts()));
      }

      if (this.lexer.Token !== T.TComma) break;
      if (this.lexer.HasNewlineBefore) isSingleLine = false;
      this.lexer.Next();
      if (this.lexer.HasNewlineBefore) isSingleLine = false;
    }

    if (this.lexer.HasNewlineBefore) isSingleLine = false;
    const closeBraceLoc = this.saveExprCommentsHere();
    this.lexer.Expect(T.TCloseBrace);
    this.allowIn = oldAllowIn;
    // Go: visitExprInOut 的 EObject 分支（js_parser.go:12478 附近）—— 重复 key 警告。
    // TS 单趟在 parse 结束时发，因为 properties 已经定稿。
    this.warnAboutDuplicateProperties(properties, true);
    return new js_ast.Expr(init(new js_ast.EObject(), {
      Properties: properties,
      IsSingleLine: isSingleLine,
      CloseBraceLoc: closeBraceLoc,
    }), loc);
  }

  /** Go: func (p *parser) parseExpr(level js_ast.L) js_ast.Expr */
  parseExpr(level: js_ast.L): js_ast.Expr {
    return this.parseExprCommon(level, exprFlag.exprFlagNone);
  }

  /** Go: func (p *parser) parseExprCommon(level js_ast.L, errors *deferredErrors, flags exprFlag) js_ast.Expr */
  parseExprCommon(level: js_ast.L, flags: exprFlag): js_ast.Expr {
    // Go: js_parser.go:4233 —— 注释标记必须在 parsePrefix 之前取（Next() 会清零）。
    const lexerCommentFlags = this.lexer.HasCommentBefore;
    let left = this.parsePrefix(level, flags);

    if ((lexerCommentFlags & (CommentBefore.PureCommentBefore | CommentBefore.NoSideEffectsCommentBefore)) !== 0) {
      if ((lexerCommentFlags & CommentBefore.NoSideEffectsCommentBefore) !== 0) {
        if (left.Data instanceof js_ast.EArrow) {
          left.Data.HasNoSideEffectsComment = true;
        } else if (left.Data instanceof js_ast.EFunction) {
          left.Data.Fn.HasNoSideEffectsComment = true;
        }
      }

      // "/* @__PURE__ */" applies to the next CallExpression or NewExpression
      if ((lexerCommentFlags & CommentBefore.PureCommentBefore) !== 0 && level < js_ast.L.LCall) {
        left = this.parseSuffix(left, (js_ast.L.LCall - 1) as js_ast.L, flags);
        if (left.Data instanceof js_ast.ECall) {
          left.Data.CanBeUnwrappedIfUnused = true;
        } else if (left.Data instanceof js_ast.ENew) {
          left.Data.CanBeUnwrappedIfUnused = true;
        }
      }
    }

    return this.parseSuffix(left, level, flags);
  }

  /** Go: func (p *parser) parsePrefix(level js_ast.L, errors *deferredErrors, flags exprFlag) js_ast.Expr */
  parsePrefix(level: js_ast.L, _flags: exprFlag): js_ast.Expr {
    // Go: js_parser.go:3499 —— 注释在 parsePrefix 入口处绑定到 expr.Loc。
    const loc = this.saveExprCommentsHere();

    switch (this.lexer.Token) {
      case T.TNumericLiteral: {
        const value = new js_ast.Expr(new js_ast.ENumber(this.lexer.Number), loc);
        this.lexer.Next();
        return value;
      }

      case T.TBigIntegerLiteral: {
        const value = bytesToString(this.lexer.Identifier.String);
        this.lexer.Next();
        return new js_ast.Expr(new js_ast.EBigInt(value), loc);
      }

      case T.TStringLiteral:
      case T.TNoSubstitutionTemplateLiteral:
        return this.parseStringLiteral();

      case T.TTemplateHead: {
        const headLoc = this.lexer.Loc();
        const head = this.lexer.StringLiteral();
        const parts = this.parseTemplateParts(false /* includeRaw */);
        return new js_ast.Expr(init(new js_ast.ETemplate(), {
          HeadLoc: headLoc,
          HeadCooked: head,
          Parts: parts,
        }), loc);
      }

      case T.TSlash:
      case T.TSlashEquals: {
        this.lexer.ScanRegExp();
        const value = bytesToString(this.lexer.Raw());
        this.lexer.Next();
        return new js_ast.Expr(new js_ast.ERegExp(value), loc);
      }

      case T.TTrue:
        this.lexer.Next();
        return new js_ast.Expr(new js_ast.EBoolean(true), loc);

      case T.TFalse:
        this.lexer.Next();
        return new js_ast.Expr(new js_ast.EBoolean(false), loc);

      case T.TNull:
        this.lexer.Next();
        return new js_ast.Expr(js_ast.ENullShared, loc);

      case T.TThis:
        this.lexer.Next();
        return new js_ast.Expr(js_ast.EThisShared, loc);

      case T.TSuper: {
        // Go: js_parser.go:3503
        const superRange = this.lexer.Range();
        this.lexer.Next();

        switch (this.lexer.Token) {
          case T.TOpenParen:
            if (level < js_ast.L.LCall && this.allowSuperCall) {
              return new js_ast.Expr(js_ast.ESuperShared, loc);
            }
            break;

          case T.TDot:
          case T.TOpenBracket:
            if (this.allowSuperProperty) {
              return new js_ast.Expr(js_ast.ESuperShared, loc);
            }
            break;
        }

        AddError(this.log, this.tracker, superRange, 'Unexpected "super"');
        return new js_ast.Expr(js_ast.ESuperShared, loc);
      }

      case T.TNew: {
        // Go: js_parser.go:3813
        this.lexer.Next();

        // Special-case the weird "new.target" expression here
        if (this.lexer.Token === T.TDot) {
          this.lexer.Next();
          if (this.lexer.Token !== T.TIdentifier || bytesToString(this.lexer.Raw()) !== "target") {
            this.lexer.Unexpected();
          }
          const r = new Range(loc, this.lexer.Range().End() - loc.Start);
          this.lexer.Next();
          return new js_ast.Expr(init(new js_ast.ENewTarget(), { Range: r }), loc);
        }

        const target = this.parseExprCommon(js_ast.L.LMember, exprFlag.exprFlagIsNewTarget);
        let args: js_ast.Expr[] = [];
        let closeParenLoc = new Loc(0);
        let isMultiLine = false;

        if (this.lexer.Token === T.TOpenParen) {
          const parsed = this.parseCallArgs();
          args = parsed.args;
          closeParenLoc = parsed.closeParenLoc;
          isMultiLine = parsed.isMultiLine;
        }

        const newExpr = init(new js_ast.ENew(), {
          Target: target,
          Args: args,
          CloseParenLoc: closeParenLoc,
          IsMultiLine: isMultiLine,
        });
        // Go: js_parser.go:16930 —— 已知全局构造函数在可推导无副作用时标记 pure，
        // printer 会输出 "/* @__PURE__ */ "（source 里没有注释也会加）。
        this.maybeMarkKnownGlobalConstructorAsPure(newExpr);
        return new js_ast.Expr(newExpr, loc);
      }

      case T.TPrivateIdentifier: {
        // Go: js_parser.go:3572 —— "#foo in bar"
        if (!this.allowIn || level >= js_ast.L.LCompare) {
          this.lexer.Unexpected();
        }
        const name = this.lexer.Identifier;
        this.lexer.Next();
        if (!this.tokenIs(T.TIn)) {
          this.lexer.Expected(T.TIn);
        }
        this.reportPrivateNameUsage(bytesToString(name.String));
        return new js_ast.Expr(new js_ast.EPrivateIdentifier(this.resolveName(bytesToString(name.String), loc)), loc);
      }

      case T.TIdentifier: {
        const name = this.lexer.Identifier;
        const rawText = bytesToString(this.lexer.Raw());
        const ref = this.storeNameInRef(name);
        const text = this.loadNameFromRef(ref);
        this.lexer.Next();

        // Handle the start of an arrow expression (Go: js_parser.go:3667)
        if (this.lexer.Token === T.TEqualsGreaterThan && level <= js_ast.L.LAssign) {
          const arg = init(new js_ast.Arg(), {
            Binding: init(new js_ast.Binding(), {
              Loc: loc,
              Data: new js_ast.BIdentifier(this.resolveName(text, loc)),
            }),
          });

          this.pushScopeForParsePass(js_ast.ScopeKind.ScopeFunctionArgs, loc);
          const arrow = this.parseArrowBody([arg]);
          this.popScope();
          return new js_ast.Expr(arrow, loc);
        }

        // Go: 上下文关键字 await / yield（Go 在 visit pass 里按作用域决定；本子集不追踪，
        // 一律按表达式处理——Module 代码里两者都是保留字，登记在 PLAN §3）
        // 注意：只有 raw 未转义时才是上下文关键字（"\\u0061sync" 是普通标识符）
        if (text === "async" && rawText === "async") {
          return this.parseAsyncPrefixExpr(new Range(loc, 5), level, _flags);
        }
        if (text === "await") {
          if (this.awaitIsIdentifier) {
            return this.identifierExpr(text, loc);
          }
          const value = this.parseExpr(js_ast.L.LPrefix);
          if (this.lexer.Token === T.TAsteriskAsterisk) {
            this.lexer.Unexpected();
          }
          return new js_ast.Expr(init(new js_ast.EAwait(), { Value: value }), loc);
        }
        if (text === "yield") {
          return this.parseYieldExpr(loc);
        }

        // Go: visit pass 对 unbound 符号做默认 defines 代换（newParser 注入
        // config.ProcessDefines(nil)：undefined/NaN/Infinity，见 globals.go:1016）。
        // 单趟骨架在解析处直接代换；已声明的同名符号不代换。
        return this.identifierExpr(text, loc);
      }
      case T.TImport:
        this.lexer.Next();
        return this.parseImportExpr(loc, level);

      case T.TOpenParen:
        return this.parseParenExpr(loc, level);

      case T.TOpenBracket: {
        this.lexer.Next();
        const items: js_ast.Expr[] = [];
        let isSingleLine = !this.lexer.HasNewlineBefore;
        let commaAfterSpread: Loc = new Loc(0);

        // Allow "in" inside arrays
        const oldAllowIn = this.allowIn;
        this.allowIn = true;

        // Go: js_parser.go:3843 —— 数组字面量允许洞（EMissing）
        while (this.lexer.Token !== T.TCloseBracket) {
          switch (this.lexer.Token) {
            case T.TComma:
              items.push(new js_ast.Expr(js_ast.EMissingShared, this.lexer.Loc()));
              break;

            case T.TDotDotDot: {
              const dotsLoc = this.saveExprCommentsHere();
              this.lexer.Next();
              const item = this.parseExpr(js_ast.L.LComma);
              // 注意：js_ast.ESpread 没有构造函数，new ESpread(item) 会静默丢掉 item
              items.push(new js_ast.Expr(init(new js_ast.ESpread(), { Value: item }), dotsLoc));

              // Commas are not allowed here when destructuring
              if (this.lexer.Token === T.TComma) {
                commaAfterSpread = this.lexer.Loc();
              }
              break;
            }

            default:
              items.push(this.parseExpr(js_ast.L.LComma));
              break;
          }

          if (this.lexer.Token !== T.TComma) {
            break;
          }
          if (this.lexer.HasNewlineBefore) isSingleLine = false;
          this.lexer.Next();
          if (this.lexer.HasNewlineBefore) isSingleLine = false;
        }

        if (this.lexer.HasNewlineBefore) isSingleLine = false;
        const closeBracketLoc = this.saveExprCommentsHere();
        this.lexer.Expect(T.TCloseBracket);
        this.allowIn = oldAllowIn;

        return new js_ast.Expr(init(new js_ast.EArray(), {
          Items: items,
          CommaAfterSpread: commaAfterSpread,
          IsSingleLine: isSingleLine,
          CloseBracketLoc: closeBracketLoc,
        }), loc);
      }

      case T.TPlus:
      case T.TMinus:
      case T.TTilde:
      case T.TExclamation:
      case T.TVoid:
      case T.TTypeof:
      case T.TDelete: {
        const op = opForPrefixToken(this.lexer.Token);
        this.lexer.Next();
        const value = this.parseExpr(js_ast.L.LPrefix);
        if (this.lexer.Token === T.TAsteriskAsterisk) {
          this.lexer.Unexpected();
        }
        // Go: js_parser.go:14709 —— visit pass 总是对 +/- 后的无副作用数字做折叠。
        if (op === js_ast.OpCode.UnOpPos || op === js_ast.OpCode.UnOpNeg) {
          const [num, ok] = js_ast_helpers.ToNumberWithoutSideEffects(value.Data);
          if (ok) {
            return new js_ast.Expr(new js_ast.ENumber(op === js_ast.OpCode.UnOpNeg ? -num : num), loc);
          }
        }
        // Go visit pass 对 ! / typeof / void 的无条件折叠
        if (op === js_ast.OpCode.UnOpNot) {
          const [boolean, sideEffects, ok] = js_ast_helpers.ToBooleanWithSideEffects(value.Data);
          if (ok && sideEffects === js_ast_helpers.NoSideEffects) {
            return new js_ast.Expr(new js_ast.EBoolean(!boolean), loc);
          }
        } else if (op === js_ast.OpCode.UnOpTypeof) {
          const [typeofValue, ok] = js_ast_helpers.TypeofWithoutSideEffects(value.Data);
          if (ok) {
            return new js_ast.Expr(new js_ast.EString(new Uint16Array(StringToUTF16(new TextEncoder().encode(typeofValue)))), loc);
          }
        } else if (op === js_ast.OpCode.UnOpVoid && this.isUnsightlyPrimitive(value.Data)) {
          return new js_ast.Expr(js_ast.EUndefinedShared, loc);
        }
        // Go: js_parser.go:3737-3761 —— typeof/delete 记录「原本的操作数形态」，供 printer 防止语义变化。
        // TS 在 parse 期已 fold logical（logicalFoldedTargets），fold 前的真实形态是 EBinary，故这些 flag 必须为 false。
        let unary = init(new js_ast.EUnary(), { Op: op, Value: value });
        if (op === js_ast.OpCode.UnOpTypeof) {
          unary.WasOriginallyTypeofIdentifier = value.Data instanceof js_ast.EIdentifier && !this.logicalFoldedTargets.has(value);
        } else if (op === js_ast.OpCode.UnOpDelete) {
          unary.WasOriginallyDeleteOfIdentifierOrPropertyAccess =
            (value.Data instanceof js_ast.EIdentifier || js_ast_helpers.IsPropertyAccess(value)) && !this.logicalFoldedTargets.has(value);
        }
        return new js_ast.Expr(unary, loc);
      }

      case T.TMinusMinus:
      case T.TPlusPlus: {
        const op = this.lexer.Token === T.TMinusMinus ? js_ast.OpCode.UnOpPreDec : js_ast.OpCode.UnOpPreInc;
        this.lexer.Next();
        return new js_ast.Expr(init(new js_ast.EUnary(), {
          Op: op,
          Value: this.parseExpr(js_ast.L.LPrefix),
        }), loc);
      }

      case T.TFunction: {
        this.lexer.Next();
        // Go: 函数表达式可以是 generator（"function* () {}"）
        let isGenerator = false;
        if (this.lexer.Token === T.TAsterisk) {
          isGenerator = true;
          this.lexer.Next();
        }
        const fn = this.parseFn(loc, false /* isAsync */, isGenerator, false /* isStatement */);
        return new js_ast.Expr(init(new js_ast.EFunction(), { Fn: fn }), loc);
      }

      case T.TClass:
        return this.parseClassExpr();

      case T.TAt: {
        // Go: js_parser.go:3808 —— "@x class {}" 类表达式
        const decorators = this.parseDecorators();
        return this.parseClassExpr(decorators);
      }

      case T.TOpenBrace:
        return this.parseObjectLiteral(loc);

      case T.TOpenParen: {
        // 骨架子集：仅分组括号；箭头函数参数的回溯尚未移植（见 PLAN §5）。
        this.lexer.Next();
        const value = this.parseExpr(js_ast.L.LLowest);
        this.lexer.Expect(T.TCloseParen);
        return value;
      }

      case T.TLessThan: {
        if (this.options.jsx.Parse) {
          // Use NextInsideJSXElement() instead of Next() so we parse "<<" as "<"
          this.lexer.NextInsideJSXElement();
          const element = this.parseJSXElement(loc);

          // The call to parseJSXElement() above doesn't consume the last
          // TGreaterThan because the caller knows what Next() function to call.
          // Use Next() instead of NextInsideJSXElement() here since the next
          // token is an expression.
          this.lexer.Next();
          return element;
        }
        break;
      }
    }

    this.lexer.Unexpected();
    throw new LexerPanic();
  }

  /** Go: func (p *parser) parseYieldExpr(loc logger.Loc) js_ast.Expr (js_parser.go:4112) */
  parseYieldExpr(loc: Loc): js_ast.Expr {
    // Parse a yield-from expression, which yields from an iterator
    const isStar = this.lexer.Token === T.TAsterisk;
    if (isStar && !this.lexer.HasNewlineBefore) {
      this.lexer.Next();
    }

    let valueOrNil: js_ast.Expr | null = null;

    // The yield expression only has a value in certain cases
    if (isStar) {
      valueOrNil = this.parseExpr(js_ast.L.LYield);
    } else {
      switch (this.lexer.Token) {
        case T.TCloseBrace:
        case T.TCloseBracket:
        case T.TCloseParen:
        case T.TColon:
        case T.TComma:
        case T.TSemicolon:
          break;
        default:
          if (!this.lexer.HasNewlineBefore) {
            valueOrNil = this.parseExpr(js_ast.L.LYield);
          }
      }
    }

    return new js_ast.Expr(init(new js_ast.EYield(), {
      ValueOrNil: valueOrNil,
      IsStar: isStar,
    }), loc);
  }

  /** Go: func (p *parser) reportPrivateNameUsage(name string) (js_parser.go:13368) */
  reportPrivateNameUsage(_name: string): void {
    // Go: 只在解析 experimental decorators 时才记录待降级的私有名（本仓库无该模式）
  }

  /**
   * Go: func (p *parser) checkForArrowAfterTheCurrentToken() bool（js_parser.go:4120）
   * 复制当前 lexer 状态往后看一个 token；用于 "for (async of ...)" 的歧义判定。
   */
  checkForArrowAfterTheCurrentToken(): boolean {
    const clone: Lexer = Object.create(Object.getPrototypeOf(this.lexer));
    Object.assign(clone, this.lexer);
    clone.AllComments = [...this.lexer.AllComments];
    clone.CommentsBeforeToken = [...this.lexer.CommentsBeforeToken];
    clone.LegalCommentsBeforeToken = [...this.lexer.LegalCommentsBeforeToken];
    clone.Next();
    return clone.Token === T.TEqualsGreaterThan;
  }

  /** Go: func (p *parser) parseFnExpr(loc logger.Loc, isAsync bool, asyncRange logger.Range) js_ast.Expr */
  parseFnExpr(loc: Loc, isAsync: boolean, asyncRange: Range | null): js_ast.Expr {
    this.lexer.Next();
    let isGenerator = false;
    if (this.tokenIs(T.TAsterisk)) {
      isGenerator = true;
      this.lexer.Next();
    }
    // Go: js_parser.go:3097 —— async 语法特性诊断（target 不支持 generator 时报错）
    if (isAsync) markAsyncFn(this, asyncRange ?? new Range(loc, 5), isGenerator);
    const fn = this.parseFn(loc, isAsync, isGenerator, false /* isStatement */);
    this.validateFunctionName(fn, fnKind.fnExpr);
    void asyncRange;
    return new js_ast.Expr(init(new js_ast.EFunction(), { Fn: fn }), loc);
  }

  /** Go: func (p *parser) parseAsyncPrefixExpr(asyncRange logger.Range, level js_ast.L, flags exprFlag) js_ast.Expr */
  parseAsyncPrefixExpr(asyncRange: Range, level: js_ast.L, _flags: exprFlag): js_ast.Expr {
    // "async function() {}"
    if (!this.lexer.HasNewlineBefore && this.lexer.Token === T.TFunction) {
      return this.parseFnExpr(asyncRange.Loc, true /* isAsync */, asyncRange);
    }

    // Check the precedence level to avoid parsing an arrow function in
    // "new async () => {}". This also avoids parsing "new async()" as
    // "new (async())()" instead.
    if (!this.lexer.HasNewlineBefore && level < js_ast.L.LMember) {
      switch (this.lexer.Token) {
        // "async => {}"
        case T.TEqualsGreaterThan: {
          if (level <= js_ast.L.LAssign) {
            this.pushScopeForParsePass(js_ast.ScopeKind.ScopeFunctionArgs, asyncRange.Loc);
            const ref = this.declareSymbol(SymbolKind.SymbolHoisted, asyncRange.Loc, "async");
            const arg = init(new js_ast.Arg(), {
              Binding: init(new js_ast.Binding(), {
                Loc: asyncRange.Loc,
                Data: new js_ast.BIdentifier(ref),
              }),
            });
            const arrow = this.parseArrowBody([arg], false);
            this.popScope();
            return new js_ast.Expr(arrow, asyncRange.Loc);
          }
          break;
        }

        // "async x => {}"
        case T.TIdentifier: {
          if (level <= js_ast.L.LAssign) {
            const argLoc = this.lexer.Loc();
            const name = bytesToString(this.lexer.Identifier.String);

            // Go: js_parser.go:3021 —— "for (async of" 只有下一个 token 是 "=>" 时才是箭头函数
            if (this.isForLoopInit && name === "of" && !this.checkForArrowAfterTheCurrentToken()) {
              break;
            }

            this.lexer.Next();

            this.pushScopeForParsePass(js_ast.ScopeKind.ScopeFunctionArgs, asyncRange.Loc);
            const ref = this.declareSymbol(SymbolKind.SymbolHoisted, argLoc, name);
            const arg = init(new js_ast.Arg(), {
              Binding: init(new js_ast.Binding(), {
                Loc: argLoc,
                Data: new js_ast.BIdentifier(ref),
              }),
            });
            const arrow = this.parseArrowBody([arg], true);
            arrow.IsAsync = true;
            this.popScope();
            return new js_ast.Expr(arrow, asyncRange.Loc);
          }
          break;
        }

        // "async()"
        // "async () => {}"
        case T.TOpenParen: {
          // 注意：本仓库的 parseParenExpr 自己消费 "("（Go 是调用方消费）
          return this.parseParenExpr(asyncRange.Loc, level, asyncRange);
        }
      }
    }

    // "async"
    // "async + 1"
    return new js_ast.Expr(
      new js_ast.EIdentifier(this.resolveName("async", asyncRange.Loc)), asyncRange.Loc);
  }

  /** Go: func (p *parser) parseSuffix(left js_ast.Expr, level js_ast.L, errors *deferredErrors, flags exprFlag) js_ast.Expr */
  parseSuffix(left: js_ast.Expr, level: js_ast.L, _flags: exprFlag): js_ast.Expr {
    // Go: js_parser.go:4269 —— 箭头函数体之后只允许逗号继续
    let optionalChain: number = js_ast.OptionalChain.OptionalChainNone;
    for (;;) {
      if (this.lexer.Loc().Start === this.afterArrowBodyLoc.Start) {
        for (;;) {
          if (this.lexer.Token === T.TComma) {
            if (level >= js_ast.L.LComma) return left;
            this.lexer.Next();
            left = new js_ast.Expr(init(new js_ast.EBinary(), {
              Op: js_ast.OpCode.BinOpComma,
              Left: left,
              Right: this.parseExpr(js_ast.L.LComma),
            }), left.Loc);
          } else {
            return left;
          }
        }
      }
      const oldOptionalChain = optionalChain;
      optionalChain = js_ast.OptionalChain.OptionalChainNone;
      switch (this.lexer.Token) {
        case T.TDot: {
          // Go: 成员访问不受 level 限制（只受调用 LCall 限制）
          this.lexer.Next();
          if (this.tokenIs(T.TPrivateIdentifier)) {
            // "a.#b" / "a?.b.#c"
            if (left.Data instanceof js_ast.ESuper) this.lexer.Expected(T.TIdentifier);
            const name = this.lexer.Identifier;
            const nameLoc = this.lexer.Loc();
            this.lexer.Next();
            this.reportPrivateNameUsage(bytesToString(name.String));
            const ref = this.resolveName(bytesToString(name.String), nameLoc);
            left = new js_ast.Expr(init(new js_ast.EIndex(), {
              Target: left,
              Index: new js_ast.Expr(new js_ast.EPrivateIdentifier(ref), nameLoc),
              OptionalChain: oldOptionalChain,
            }), left.Loc);
            optionalChain = oldOptionalChain;
            break;
          }
          if (!this.lexer.IsIdentifierOrKeyword()) {
            this.lexer.Expected(T.TIdentifier);
          }
          const name = bytesToString(this.lexer.Identifier.String);
          const nameLoc = this.lexer.Loc();
          this.lexer.Next();
          left = new js_ast.Expr(init(new js_ast.EDot(), {
            Target: left,
            Name: name,
            NameLoc: nameLoc,
            OptionalChain: oldOptionalChain,
          }), left.Loc);
          optionalChain = oldOptionalChain;
          break;
        }

        case T.TOpenBracket: {
          // Go: 下标访问不受 level 限制
          this.lexer.Next();
          // Allow "in" inside the brackets
          const oldAllowIn = this.allowIn;
          this.allowIn = true;
          const index = this.parseExpr(js_ast.L.LLowest);
          this.allowIn = oldAllowIn;
          const closeBracketLoc = this.saveExprCommentsHere();
          this.lexer.Expect(T.TCloseBracket);
          left = new js_ast.Expr(init(new js_ast.EIndex(), {
            Target: left,
            Index: index,
            OptionalChain: oldOptionalChain,
            CloseBracketLoc: closeBracketLoc,
          }), left.Loc);
          optionalChain = oldOptionalChain;
          break;
        }

        case T.TOpenParen: {
          if (level >= js_ast.L.LCall) return left;
          const args = this.parseCallArgs();
          const call = init(new js_ast.ECall(), {
            Target: left,
            Args: args.args,
            CloseParenLoc: args.closeParenLoc,
            OptionalChain: oldOptionalChain,
            IsMultiLine: args.isMultiLine,
          });
          this.setCallKind(call, left);
          this.maybeMarkIIFEAsPure(call, left.Data);
          left = new js_ast.Expr(call, left.Loc);
          optionalChain = oldOptionalChain;
          break;
        }

        case T.TQuestionDot: {
          // Go: js_parser.go:4331（可选链）
          this.lexer.Next();
          const optionalStart = js_ast.OptionalChain.OptionalChainStart;

          switch (this.lexer.Token) {
            case T.TOpenBracket: {
              // "a?.[b]"
              this.lexer.Next();
              const oldAllowIn = this.allowIn;
              this.allowIn = true;
              const index = this.parseExpr(js_ast.L.LLowest);
              this.allowIn = oldAllowIn;
              const closeBracketLoc = this.saveExprCommentsHere();
              this.lexer.Expect(T.TCloseBracket);
              left = new js_ast.Expr(init(new js_ast.EIndex(), {
                Target: left,
                Index: index,
                OptionalChain: optionalStart,
                CloseBracketLoc: closeBracketLoc,
              }), left.Loc);
              break;
            }

            case T.TOpenParen: {
              // "a?.()"
              if (level >= js_ast.L.LCall) return left;
              const args = this.parseCallArgs();
              const call = init(new js_ast.ECall(), {
                Target: left,
                Args: args.args,
                CloseParenLoc: args.closeParenLoc,
                OptionalChain: optionalStart,
                IsMultiLine: args.isMultiLine,
              });
              this.setCallKind(call, left);
              this.maybeMarkIIFEAsPure(call, left.Data);
              left = new js_ast.Expr(call, left.Loc);
              break;
            }

            default: {
              if (this.tokenIs(T.TPrivateIdentifier)) {
                // "a?.#b"
                const name = this.lexer.Identifier;
                const nameLoc = this.lexer.Loc();
                this.lexer.Next();
                this.reportPrivateNameUsage(bytesToString(name.String));
                const ref = this.resolveName(bytesToString(name.String), nameLoc);
                left = new js_ast.Expr(init(new js_ast.EIndex(), {
                  Target: left,
                  Index: new js_ast.Expr(new js_ast.EPrivateIdentifier(ref), nameLoc),
                  OptionalChain: optionalStart,
                }), left.Loc);
                break;
              }
              // "a?.b"
              if (!this.lexer.IsIdentifierOrKeyword()) {
                this.lexer.Expect(T.TIdentifier);
              }
              const name = bytesToString(this.lexer.Identifier.String);
              const nameLoc = this.lexer.Loc();
              this.lexer.Next();
              left = new js_ast.Expr(init(new js_ast.EDot(), {
                Target: left,
                Name: name,
                NameLoc: nameLoc,
                OptionalChain: optionalStart,
              }), left.Loc);
              break;
            }
          }
          // Go: js_parser.go:4415 —— 只有真正起了链才继续
          if (optionalStart === js_ast.OptionalChain.OptionalChainStart) {
            optionalChain = js_ast.OptionalChain.OptionalChainContinue;
          }
          break;
        }

        case T.TQuestion: {
          // Go: js_parser.go:4528
          if (level >= js_ast.L.LConditional) return left;
          this.lexer.Next();

          // Allow "in" in between "?" and ":"
          const oldAllowIn = this.allowIn;
          this.allowIn = true;

          const yes = this.parseExprWithFlags(js_ast.L.LComma, exprFlag.exprFlagAfterQuestionAndBeforeColon);

          this.allowIn = oldAllowIn;

          this.lexer.Expect(T.TColon);
          const no = this.parseExprCommon(js_ast.L.LComma, _flags & exprFlag.exprFlagAfterQuestionAndBeforeColon);
          left = new js_ast.Expr(init(new js_ast.EIf(), { Test: left, Yes: yes, No: no }), left.Loc);
          break;
        }

        case T.TMinusMinus: {
          if (this.lexer.HasNewlineBefore || level >= js_ast.L.LPostfix) return left;
          this.lexer.Next();
          left = new js_ast.Expr(init(new js_ast.EUnary(), {
            Op: js_ast.OpCode.UnOpPostDec,
            Value: left,
          }), left.Loc);
          break;
        }

        case T.TPlusPlus: {
          if (this.lexer.HasNewlineBefore || level >= js_ast.L.LPostfix) return left;
          this.lexer.Next();
          left = new js_ast.Expr(init(new js_ast.EUnary(), {
            Op: js_ast.OpCode.UnOpPostInc,
            Value: left,
          }), left.Loc);
          break;
        }

        case T.TEquals: {
          if (level >= js_ast.L.LAssign) return left;
          this.lexer.Next();
          left = new js_ast.Expr(init(new js_ast.EBinary(), {
            Op: js_ast.OpCode.BinOpAssign,
            Left: left,
            Right: this.parseExpr((js_ast.L.LAssign - 1) as js_ast.L),
          }), left.Loc);
          break;
        }

        case T.TPlusEquals: {
          if (level >= js_ast.L.LAssign) return left;
          this.lexer.Next();
          left = new js_ast.Expr(init(new js_ast.EBinary(), {
            Op: js_ast.OpCode.BinOpAddAssign,
            Left: left,
            Right: this.parseExpr((js_ast.L.LAssign - 1) as js_ast.L),
          }), left.Loc);
          break;
        }

        case T.TMinusEquals: {
          if (level >= js_ast.L.LAssign) return left;
          this.lexer.Next();
          left = new js_ast.Expr(init(new js_ast.EBinary(), {
            Op: js_ast.OpCode.BinOpSubAssign,
            Left: left,
            Right: this.parseExpr((js_ast.L.LAssign - 1) as js_ast.L),
          }), left.Loc);
          break;
        }

        case T.TAsteriskEquals: {
          if (level >= js_ast.L.LAssign) return left;
          this.lexer.Next();
          left = new js_ast.Expr(init(new js_ast.EBinary(), {
            Op: js_ast.OpCode.BinOpMulAssign,
            Left: left,
            Right: this.parseExpr((js_ast.L.LAssign - 1) as js_ast.L),
          }), left.Loc);
          break;
        }

        case T.TAsteriskAsteriskEquals: {
          if (level >= js_ast.L.LAssign) return left;
          this.lexer.Next();
          left = new js_ast.Expr(init(new js_ast.EBinary(), {
            Op: js_ast.OpCode.BinOpPowAssign,
            Left: left,
            Right: this.parseExpr((js_ast.L.LAssign - 1) as js_ast.L),
          }), left.Loc);
          break;
        }

        case T.TSlashEquals: {
          if (level >= js_ast.L.LAssign) return left;
          this.lexer.Next();
          left = new js_ast.Expr(init(new js_ast.EBinary(), {
            Op: js_ast.OpCode.BinOpDivAssign,
            Left: left,
            Right: this.parseExpr((js_ast.L.LAssign - 1) as js_ast.L),
          }), left.Loc);
          break;
        }

        case T.TPercentEquals: {
          if (level >= js_ast.L.LAssign) return left;
          this.lexer.Next();
          left = new js_ast.Expr(init(new js_ast.EBinary(), {
            Op: js_ast.OpCode.BinOpRemAssign,
            Left: left,
            Right: this.parseExpr((js_ast.L.LAssign - 1) as js_ast.L),
          }), left.Loc);
          break;
        }

        case T.TLessThanLessThanEquals: {
          if (level >= js_ast.L.LAssign) return left;
          this.lexer.Next();
          left = new js_ast.Expr(init(new js_ast.EBinary(), {
            Op: js_ast.OpCode.BinOpShlAssign,
            Left: left,
            Right: this.parseExpr((js_ast.L.LAssign - 1) as js_ast.L),
          }), left.Loc);
          break;
        }

        case T.TGreaterThanGreaterThanEquals: {
          if (level >= js_ast.L.LAssign) return left;
          this.lexer.Next();
          left = new js_ast.Expr(init(new js_ast.EBinary(), {
            Op: js_ast.OpCode.BinOpShrAssign,
            Left: left,
            Right: this.parseExpr((js_ast.L.LAssign - 1) as js_ast.L),
          }), left.Loc);
          break;
        }

        case T.TGreaterThanGreaterThanGreaterThanEquals: {
          if (level >= js_ast.L.LAssign) return left;
          this.lexer.Next();
          left = new js_ast.Expr(init(new js_ast.EBinary(), {
            Op: js_ast.OpCode.BinOpUShrAssign,
            Left: left,
            Right: this.parseExpr((js_ast.L.LAssign - 1) as js_ast.L),
          }), left.Loc);
          break;
        }

        case T.TBarEquals: {
          if (level >= js_ast.L.LAssign) return left;
          this.lexer.Next();
          left = new js_ast.Expr(init(new js_ast.EBinary(), {
            Op: js_ast.OpCode.BinOpBitwiseOrAssign,
            Left: left,
            Right: this.parseExpr((js_ast.L.LAssign - 1) as js_ast.L),
          }), left.Loc);
          break;
        }

        case T.TAmpersandEquals: {
          if (level >= js_ast.L.LAssign) return left;
          this.lexer.Next();
          left = new js_ast.Expr(init(new js_ast.EBinary(), {
            Op: js_ast.OpCode.BinOpBitwiseAndAssign,
            Left: left,
            Right: this.parseExpr((js_ast.L.LAssign - 1) as js_ast.L),
          }), left.Loc);
          break;
        }

        case T.TCaretEquals: {
          if (level >= js_ast.L.LAssign) return left;
          this.lexer.Next();
          left = new js_ast.Expr(init(new js_ast.EBinary(), {
            Op: js_ast.OpCode.BinOpBitwiseXorAssign,
            Left: left,
            Right: this.parseExpr((js_ast.L.LAssign - 1) as js_ast.L),
          }), left.Loc);
          break;
        }

        case T.TNoSubstitutionTemplateLiteral: {
          const headLoc = this.lexer.Loc();
          const head = this.lexer.CookedAndRawTemplateContents();
          this.lexer.Next();
          left = new js_ast.Expr(init(new js_ast.ETemplate(), {
            TagOrNil: left,
            HeadLoc: headLoc,
            HeadCooked: head.cooked,
            HeadRaw: head.raw,
            TagWasOriginallyPropertyAccess: js_ast_helpers.IsPropertyAccess(left) && !this.logicalFoldedTargets.has(left),
          }), left.Loc);
          // Go: visitExprInOut 的 ETemplate 分支（js_parser.go:14186-14200）—— 带 tag 且 raw
          // 含 "</script" 时必须降级为 __template(...)，否则无法在模板里转义。
          {
            const e = left.Data as js_ast.ETemplate;
            let shouldLower = false;
            if (containsClosingScriptTag(bytesToString(e.HeadRaw))) {
              shouldLower = true;
            } else {
              for (const part of e.Parts) {
                if (containsClosingScriptTag(bytesToString(part.TailRaw))) {
                  shouldLower = true;
                  break;
                }
              }
            }
            if (shouldLower) left = lowerTemplateLiteral(this, left.Loc, e, null, null);
          }
          break;
        }

        case T.TTemplateHead: {
          const headLoc = this.lexer.Loc();
          const head = this.lexer.CookedAndRawTemplateContents();
          const parts = this.parseTemplateParts(true /* includeRaw */);
          left = new js_ast.Expr(init(new js_ast.ETemplate(), {
            TagOrNil: left,
            HeadLoc: headLoc,
            HeadCooked: head.cooked,
            HeadRaw: head.raw,
            Parts: parts,
            TagWasOriginallyPropertyAccess: js_ast_helpers.IsPropertyAccess(left) && !this.logicalFoldedTargets.has(left),
          }), left.Loc);
          // 同上：带 tag 且 raw 含 "</script" 时降级
          {
            const e = left.Data as js_ast.ETemplate;
            let shouldLower = false;
            if (containsClosingScriptTag(bytesToString(e.HeadRaw))) {
              shouldLower = true;
            } else {
              for (const part of e.Parts) {
                if (containsClosingScriptTag(bytesToString(part.TailRaw))) {
                  shouldLower = true;
                  break;
                }
              }
            }
            if (shouldLower) left = lowerTemplateLiteral(this, left.Loc, e, null, null);
          }
          break;
        }

        default: {
          const op = opForBinaryToken(this.lexer.Token);
          if (op === null) return left;
          if (level >= op.level) return left;
          // Go: for 循环的 init 里不允许把 "in" 当二元运算符
          if (!this.allowIn && op.op === js_ast.OpCode.BinOpIn) return left;

          this.lexer.Next();
          // 第 25 轮：parse 期的折叠会丢弃右子树；记录右子树入口的 scope 位置，
          // 折叠丢弃时回滚它的作用域（Go 的折叠在 visit 期，右侧已被 visit 过）
          const scopeIndexBeforeRight = this.scopesInOrder.length;
          const right = this.parseExpr(op.rightLevel);
          // Go: js_parser.go:16393（visit pass 的 BinOpAdd 常量折叠）。
          // 单趟骨架在构造处立即折叠，最终 AST 与 Go 相同。
          if (op.op === js_ast.OpCode.BinOpAdd) {
            const folded = js_ast_helpers.FoldStringAddition(left, right, js_ast_helpers.StringAdditionNormal);
            if (folded.Data !== null) {
              this.discardScopesUpTo(scopeIndexBeforeRight);
              left = new js_ast.Expr(folded.Data, left.Loc);
              break;
            }
            if (left.Data instanceof js_ast.EBinary && left.Data.Op === js_ast.OpCode.BinOpAdd) {
              const nested = js_ast_helpers.FoldStringAddition(
                left.Data.Right, right, js_ast_helpers.StringAdditionWithNestedLeft);
              if (nested.Data !== null) {
                left = new js_ast.Expr(init(new js_ast.EBinary(), {
                  Op: left.Data.Op,
                  Left: left.Data.Left,
                  Right: nested,
                }), left.Loc);
                break;
              }
            }
          }
          const foldedVisited = this.maybeFoldVisitedBinary(op.op, left, right);
          if (foldedVisited !== null) {
            // Go: logical fold 在 visit 期发生，早于此的 call/tag Kind 按 fold 前的原始 target 判定。
            // TS 在 parse 期 fold，故标记该结果，令 setCallKind / TagWasOriginallyPropertyAccess 不误判为「原本就是属性访问」。
            if (op.op === js_ast.OpCode.BinOpLogicalOr || op.op === js_ast.OpCode.BinOpLogicalAnd ||
                op.op === js_ast.OpCode.BinOpNullishCoalescing) {
              this.logicalFoldedTargets.add(foldedVisited);
            }
            // 返回 right 时右子树被保留（"0 || x" → x），不能回滚
            if (foldedVisited !== right) this.discardScopesUpTo(scopeIndexBeforeRight);
            left = foldedVisited;
            break;
          }
          left = new js_ast.Expr(init(new js_ast.EBinary(), {
            Op: op.op,
            Left: left,
            Right: right,
          }), left.Loc);
          break;
        }
      }
    }
  }

  /** Go: func isUnsightlyPrimitive(data js_ast.E) bool (js_parser.go:11791) */
  isUnsightlyPrimitive(data: js_ast.E | null): boolean {
    return data instanceof js_ast.EBoolean || data instanceof js_ast.ENull ||
      data instanceof js_ast.EUndefined || data instanceof js_ast.ENumber ||
      data instanceof js_ast.EBigInt || data instanceof js_ast.EString;
  }

  /** Go: func isSafeForConstLocalPrefix(expr js_ast.Expr) bool (js_parser.go:11818) */
  isSafeForConstLocalPrefix(expr: js_ast.Expr): boolean {
    const e = expr.Data;
    if (e instanceof js_ast.EMissing || e instanceof js_ast.EString || e instanceof js_ast.ERegExp ||
      e instanceof js_ast.EBigInt || e instanceof js_ast.EFunction || e instanceof js_ast.EArrow) {
      return true;
    }
    if (e instanceof js_ast.EArray) {
      for (const item of e.Items) if (!this.isSafeForConstLocalPrefix(item)) return false;
      return true;
    }
    if (e instanceof js_ast.EObject) {
      return e.Properties.length === 0;
    }
    return false;
  }

  /** Go: func (p *parser) maybeInlineIIFE(loc logger.Loc, e *js_ast.ECall) (js_ast.Expr, bool) (js_parser.go:11927) */
  maybeInlineIIFE(loc: Loc, e: js_ast.ECall): { expr: js_ast.Expr; ok: boolean } {
    if (e.Args.length !== 0) return { expr: new js_ast.Expr(), ok: false };
    const arrow = e.Target.Data;
    if (arrow instanceof js_ast.EArrow && arrow.Args.length === 0 && !arrow.IsAsync) {
      const stmts = arrow.Body.Block.Stmts;
      if (stmts.length === 0) {
        return { expr: new js_ast.Expr(js_ast.EUndefinedShared, loc), ok: true };
      }
      if (stmts.length === 1) {
        let value: js_ast.Expr | null = null;
        const s = stmts[0].Data;
        if (s instanceof js_ast.SReturn) {
          value = s.ValueOrNil!;
          if (value.Data === null) value.Data = js_ast.EUndefinedShared;
        } else if (s instanceof js_ast.SExpr) {
          const unary = new js_ast.EUnary();
          unary.Op = js_ast.OpCode.UnOpVoid;
          unary.Value = s.Value;
          value = new js_ast.Expr(unary, s.Value.Loc);
        }
        if (value !== null && value.Data !== null) {
          if (!e.CanBeUnwrappedIfUnused || this.astHelpers.ExprCanBeRemovedIfUnused(value)) {
            return { expr: value, ok: true };
          }
        }
      }
    }
    return { expr: new js_ast.Expr(), ok: false };
  }

  /** Go: func tryToInlineCaseBody(...) ([]js_ast.Stmt, bool) (js_parser.go:11746) */
  tryToInlineCaseBody(openBraceLoc: Loc, stmts: js_ast.Stmt[], closeBraceLoc: Loc): { stmts: js_ast.Stmt[]; ok: boolean } {
    if (stmts.length === 1 && stmts[0].Data instanceof js_ast.SBlock) {
      const block = stmts[0].Data as js_ast.SBlock;
      return this.tryToInlineCaseBody(stmts[0].Loc, block.Stmts, block.CloseBraceLoc);
    }
    let caresAboutScope = false;
    for (let i = 0; i < stmts.length; i++) {
      const s = stmts[i].Data;
      if (s instanceof js_ast.SEmpty || s instanceof js_ast.SDirective || s instanceof js_ast.SComment ||
        s instanceof js_ast.SExpr || s instanceof js_ast.SDebugger || s instanceof js_ast.SContinue ||
        s instanceof js_ast.SReturn || s instanceof js_ast.SThrow) {
        continue;
      }
      if (s instanceof js_ast.SLocal) {
        if (s.Kind !== js_ast.LocalKind.LocalVar) caresAboutScope = true;
      } else if (s instanceof js_ast.SBreak) {
        if (s.Label !== null) return { stmts: [], ok: false };
        stmts = stmts.slice(0, i);
        break;
      } else {
        return { stmts: [], ok: false };
      }
    }
    if (caresAboutScope) {
      const block = new js_ast.SBlock();
      block.Stmts = stmts;
      block.CloseBraceLoc = closeBraceLoc;
      return { stmts: [new js_ast.Stmt(block, openBraceLoc)], ok: true };
    }
    return { stmts, ok: true };
  }

  /**
   * Go visit pass 的无条件折叠（非 minify）：EBinary 的 ?? / || / && / == / != / === / !==。
   * 对应 js_parser.go:16095 / 16251 / 16292 / 16330 / 16159 附近。
   */
  maybeFoldVisitedBinary(op: js_ast.OpCode, left: js_ast.Expr, right: js_ast.Expr): js_ast.Expr | null {
    if (op === js_ast.OpCode.BinOpNullishCoalescing) {
      const [isNullOrUndefined, sideEffects, ok] = js_ast_helpers.ToNullOrUndefinedWithSideEffects(left.Data);
      if (ok) {
        if (!isNullOrUndefined) return left;
        if (sideEffects === js_ast_helpers.NoSideEffects) return right;
      }
    } else if (op === js_ast.OpCode.BinOpLogicalOr) {
      const [boolean, sideEffects, ok] = js_ast_helpers.ToBooleanWithSideEffects(left.Data);
      if (ok) {
        if (boolean) return left;
        if (sideEffects === js_ast_helpers.NoSideEffects) return right;
      }
    } else if (op === js_ast.OpCode.BinOpLogicalAnd) {
      const [boolean, sideEffects, ok] = js_ast_helpers.ToBooleanWithSideEffects(left.Data);
      if (ok) {
        if (!boolean) return left;
        if (sideEffects === js_ast_helpers.NoSideEffects) return right;
      }
    } else if (op === js_ast.OpCode.BinOpLooseEq || op === js_ast.OpCode.BinOpLooseNe) {
      const [equal, ok] = js_ast_helpers.CheckEqualityIfNoSideEffects(left.Data, right.Data, js_ast_helpers.LooseEquality);
      if (ok) return new js_ast.Expr(new js_ast.EBoolean(op === js_ast.OpCode.BinOpLooseEq ? equal : !equal), left.Loc);
    } else if (op === js_ast.OpCode.BinOpStrictEq || op === js_ast.OpCode.BinOpStrictNe) {
      const [equal, ok] = js_ast_helpers.CheckEqualityIfNoSideEffects(left.Data, right.Data, js_ast_helpers.StrictEquality);
      if (ok) return new js_ast.Expr(new js_ast.EBoolean(op === js_ast.OpCode.BinOpStrictEq ? equal : !equal), left.Loc);
    }
    return null;
  }

  /** Go: func (p *parser) parseImportExpr(loc logger.Loc, level js_ast.L) js_ast.Expr (js_parser.go:4157) */
  parseImportExpr(loc: Loc, level: js_ast.L): js_ast.Expr {
    // Parse an "import.meta" expression
    let phase: ImportPhase = ImportPhase.EvaluationPhase;
    if (this.tokenIs(T.TDot)) {
      this.lexer.Next();
      if (this.lexer.IsContextualKeyword("meta")) {
        this.lexer.Next();
        this.sawImportMeta = true;
        // Go: js_parser.go:4163 Range{Loc: loc, Len: p.lexer.Range().End() - loc.Start}
        this.esmImportMeta = new Range(loc, this.lexer.Range().End() - loc.Start);
        return new js_ast.Expr(init(new js_ast.EImportMeta(), { RangeLen: 0 }), loc);
      } else if (this.lexer.IsContextualKeyword("defer")) {
        phase = ImportPhase.DeferPhase;
        this.lexer.Next();
      } else if (this.lexer.IsContextualKeyword("source")) {
        phase = ImportPhase.SourcePhase;
        this.lexer.Next();
      } else {
        this.lexer.Unexpected();
      }
    }

    if (level > js_ast.L.LCall) {
      AddError(this.log, this.tracker, RangeOfIdentifier(this.source, loc),
        `Cannot use an "import" expression here without parentheses`);
    }

    // Allow "in" inside call arguments
    const oldAllowIn = this.allowIn;
    this.allowIn = true;

    this.lexer.Expect(T.TOpenParen);

    const value = this.parseExpr(js_ast.L.LComma);
    let optionsOrNil: js_ast.Expr | null = null;

    if (this.tokenIs(T.TComma)) {
      // "import('./foo.json', )"
      this.lexer.Next();

      if (!this.tokenIs(T.TCloseParen)) {
        // "import('./foo.json', { assert: { type: 'json' } })"
        optionsOrNil = this.parseExpr(js_ast.L.LComma);

        if (this.tokenIs(T.TComma)) {
          // "import('./foo.json', { assert: { type: 'json' } }, )"
          this.lexer.Next();
        }
      }
    }

    const closeParenLoc = this.saveExprCommentsHere();
    this.lexer.Expect(T.TCloseParen);

    this.allowIn = oldAllowIn;
    return new js_ast.Expr(init(new js_ast.EImportCall(), {
      Expr: value,
      OptionsOrNil: optionsOrNil,
      CloseParenLoc: closeParenLoc,
      Phase: phase,
    }), loc);
  }

  /** Go: func (p *parser) parseCallArgs() (args []js_ast.Expr, closeParenLoc logger.Loc, isMultiLine bool) */
  parseCallArgs(): { args: js_ast.Expr[]; closeParenLoc: Loc; isMultiLine: boolean } {
    const args: js_ast.Expr[] = [];

    // Allow "in" inside call arguments
    const oldAllowIn = this.allowIn;
    this.allowIn = true;

    this.lexer.Expect(T.TOpenParen);
    let isMultiLine = this.lexer.HasNewlineBefore;

    while (this.lexer.Token !== T.TCloseParen) {
      if (args.length > 0) {
        if (this.lexer.Token !== T.TComma) break;
        if (this.lexer.HasNewlineBefore) isMultiLine = true;
        this.lexer.Next();
        if (this.lexer.HasNewlineBefore) isMultiLine = true;
        if (this.lexer.Token === T.TCloseParen) break;
      }

      if (this.lexer.Token === T.TDotDotDot) {
        const loc = this.lexer.Loc();
        this.lexer.Next();
        args.push(new js_ast.Expr(
          init(new js_ast.ESpread(), { Value: this.parseExpr(js_ast.L.LComma) }),
          loc,
        ));
      } else {
        args.push(this.parseExpr(js_ast.L.LComma));
      }
    }

    if (this.lexer.HasNewlineBefore) isMultiLine = true;
    const closeParenLoc = this.saveExprCommentsHere();
    this.lexer.Expect(T.TCloseParen);
    this.allowIn = oldAllowIn;
    return { args, closeParenLoc, isMultiLine };
  }

  /** Go: func (p *parser) parseStringLiteral() js_ast.Expr */
  parseStringLiteral(): js_ast.Expr {
    const loc = this.lexer.Loc();
    const text = this.lexer.StringLiteral();

    const value = init(new js_ast.EString(), {
      Value: text,
      PreferTemplate: this.lexer.Token === T.TNoSubstitutionTemplateLiteral,
    });
    this.lexer.Next();
    return new js_ast.Expr(value, loc);
  }

  /** Go: func (p *parser) parseTemplateParts(includeRaw bool) (parts []js_ast.TemplatePart, legacyOctalLoc logger.Loc) */
  parseTemplateParts(includeRaw: boolean): js_ast.TemplatePart[] {
    // Allow "in" inside template literals
    const oldAllowIn = this.allowIn;
    this.allowIn = true;

    const parts: js_ast.TemplatePart[] = [];

    for (;;) {
      this.lexer.Next();
      const value = this.parseExpr(js_ast.L.LLowest);
      const tailLoc = this.lexer.Loc();
      this.lexer.RescanCloseBraceAsTemplateToken();

      const part = new js_ast.TemplatePart();
      part.Value = value;
      part.TailLoc = tailLoc;
      if (includeRaw) {
        const tail = this.lexer.CookedAndRawTemplateContents();
        part.TailCooked = tail.cooked;
        part.TailRaw = tail.raw;
      } else {
        part.TailCooked = this.lexer.StringLiteral();
      }
      parts.push(part);

      if (this.lexer.Token === T.TTemplateTail) {
        this.lexer.Next();
        break;
      }
    }

    this.allowIn = oldAllowIn;
    return parts;
  }

  // -------------------------------------------------------------------------
  // 括号 / 箭头函数
  // -------------------------------------------------------------------------

  /**
   * Go: func (p *parser) parseParenExpr(loc logger.Loc, level js_ast.L, opts parenExprOpts) js_ast.Expr
   *
   * Go 不用词法器快照回滚，而是先按「可能是箭头参数」推一个作用域，把内容当表达式解析，
   * 遇到 "=>" 再 convertExprToBinding；否则 pop 掉作用域当作分组括号（见 Go 注释）。
   */
  parseParenExpr(loc: Loc, level: js_ast.L, asyncRange: Range | null = null): js_ast.Expr {
    const items: js_ast.Expr[] = [];
    let hasSpread = false;

    // Go: parsePrefix 在调用前已经消费了 "("
    this.lexer.Next();

    this.pushScopeForParsePass(js_ast.ScopeKind.ScopeFunctionArgs, loc);
    const scopeIndex = this.scopesInOrder.length - 1;
    const oldAllowIn = this.allowIn;
    this.allowIn = true;

    for (;;) {
      if (this.lexer.Token === T.TCloseParen) break;
      const itemLoc = this.lexer.Loc();
      const isSpread = this.lexer.Token === T.TDotDotDot;
      if (isSpread) {
        hasSpread = true;
        this.lexer.Next();
      }

      let item = this.parseExprOrBindings(js_ast.L.LComma, null);
      if (isSpread) {
        item = new js_ast.Expr(init(new js_ast.ESpread(), { Value: item }), itemLoc);
      }
      items.push(item);

      if (this.lexer.Token !== T.TComma) break;
      this.lexer.Next();
    }

    const closeParenLoc = this.saveExprCommentsHere();
    this.lexer.Expect(T.TCloseParen);
    this.allowIn = oldAllowIn;

    // Are these arguments to an arrow function?
    const isArrowFn = this.lexer.Token === T.TEqualsGreaterThan;
    if (isArrowFn) {
      // Arrow functions are not allowed inside certain expressions
      if (level > js_ast.L.LAssign) {
        this.lexer.Unexpected();
      }

      const args: js_ast.Arg[] = [];
      for (const rawItem of items) {
        let item = rawItem;
        if (item.Data instanceof js_ast.ESpread) item = item.Data.Value;
        const converted = this.convertExprToBindingAndInitializer(item);
        args.push(init(new js_ast.Arg(), {
          Binding: converted.binding,
          DefaultOrNil: converted.initializerOrNil,
        }));
      }

      const arrow = this.parseArrowBody(args, asyncRange !== null);
      arrow.HasRestArg = hasSpread;
      if (asyncRange !== null) arrow.IsAsync = true;
      this.popScope();
      return new js_ast.Expr(arrow, loc);
    }

    // If we get here, it's not an arrow function so undo the pushing of the scope
    // （Go: js_parser.go:3326 —— 把子作用域摊回父作用域，就像从未 push 过）
    this.popAndFlattenScope(scopeIndex);

    // Go: 前面是 "async" 且不是箭头函数时，这是对名为 "async" 的函数的调用
    if (asyncRange !== null) {
      const target = new js_ast.Expr(new js_ast.EIdentifier(this.resolveName("async", loc)), loc);
      return new js_ast.Expr(init(new js_ast.ECall(), {
        Target: target,
        Args: items,
        CloseParenLoc: closeParenLoc,
      }), loc);
    }

    if (items.length > 0) {
      if (hasSpread) {
        this.lexer.Unexpected();
      }
      let value = items[0];
      for (let i = 1; i < items.length; i++) {
        value = new js_ast.Expr(init(new js_ast.EBinary(), {
          Op: js_ast.OpCode.BinOpComma,
          Left: value,
          Right: items[i],
        }), value.Loc);
      }
      this.markExprAsParenthesized(value, loc);
      return value;
    }

    // Indicate that we expected an arrow function
    this.lexer.Expected(T.TEqualsGreaterThan);
    throw new LexerPanic();
  }

  /** Go: func (p *parser) parseArrowBody(args []js_ast.Arg, data fnOrArrowDataParse) *js_ast.EArrow */
  parseArrowBody(args: js_ast.Arg[], isAsync: boolean = false): js_ast.EArrow {
    const arrowLoc = this.lexer.Loc();

    // Newlines are not allowed before "=>"
    if (this.lexer.HasNewlineBefore) {
      this.lexer.Unexpected();
    }

    this.lexer.Expect(T.TEqualsGreaterThan);

    const arrow = new js_ast.EArrow();
    arrow.Args = args;

    // Go: 箭头函数体的 await 语境（async 箭头里 await 是表达式，非 async 里是标识符）
    const oldAwaitIsIdentifier = this.awaitIsIdentifier;
    this.awaitIsIdentifier = !isAsync;

    // Block body
    if (this.lexer.Token === T.TOpenBrace) {
      const bodyLoc = this.lexer.Loc();
      this.pushScopeForParsePass(js_ast.ScopeKind.ScopeFunctionBody, bodyLoc);
      const oldAllowIn = this.allowIn;
      this.allowIn = true;

      this.lexer.Expect(T.TOpenBrace);
      const opts = new parseStmtOpts();
      opts.allowDirectivePrologue = true;
      const stmts = this.parseStmtsUpTo(T.TCloseBrace, opts);
      const closeBraceLoc = this.lexer.Loc();
      this.lexer.Next();

      this.allowIn = oldAllowIn;
      this.popScope();

      arrow.Body = init(new js_ast.FnBody(), {
        Loc: bodyLoc,
        Block: init(new js_ast.SBlock(), { Stmts: stmts, CloseBraceLoc: closeBraceLoc }),
      });
      this.afterArrowBodyLoc = this.lexer.Loc();
      this.awaitIsIdentifier = oldAwaitIsIdentifier;
      return arrow;
    }

    // Expression body
    this.pushScopeForParsePass(js_ast.ScopeKind.ScopeFunctionBody, arrowLoc);
    const expr = this.parseExpr(js_ast.L.LComma);
    this.popScope();

    arrow.PreferExpr = true;
    arrow.Body = init(new js_ast.FnBody(), {
      Loc: arrowLoc,
      Block: init(new js_ast.SBlock(), {
        Stmts: [new js_ast.Stmt(init(new js_ast.SReturn(), { ValueOrNil: expr }), expr.Loc)],
      }),
    });
    this.awaitIsIdentifier = oldAwaitIsIdentifier;
    return arrow;
  }

  /** Go: func (p *parser) convertExprToBindingAndInitializer(...) */
  convertExprToBindingAndInitializer(
    expr: js_ast.Expr,
  ): { binding: js_ast.Binding; initializerOrNil: js_ast.Expr | null } {
    let initializerOrNil: js_ast.Expr | null = null;
    if (expr.Data instanceof js_ast.EBinary && expr.Data.Op === js_ast.OpCode.BinOpAssign) {
      initializerOrNil = expr.Data.Right;
      expr = expr.Data.Left;
    }
    return { binding: this.convertExprToBinding(expr), initializerOrNil };
  }

  /** Go: func (p *parser) convertExprToBinding(expr js_ast.Expr, invalidLog invalidLog) (js_ast.Binding, invalidLog) */
  convertExprToBinding(expr: js_ast.Expr): js_ast.Binding {
    const e = expr.Data;

    if (e instanceof js_ast.EMissing) {
      return init(new js_ast.Binding(), { Loc: expr.Loc, Data: js_ast.BMissingShared });
    }

    if (e instanceof js_ast.EIdentifier) {
      return init(new js_ast.Binding(), {
        Loc: expr.Loc,
        Data: new js_ast.BIdentifier(e.Ref),
      });
    }

    if (e instanceof js_ast.EArray) {
      const items: js_ast.ArrayBinding[] = [];
      let hasSpread = false;

      for (const rawItem of e.Items) {
        let item = rawItem;
        if (item.Data instanceof js_ast.ESpread) {
          hasSpread = true;
          item = item.Data.Value;
        }
        const converted = this.convertExprToBindingAndInitializer(item);
        items.push(init(new js_ast.ArrayBinding(), {
          Binding: converted.binding,
          DefaultValueOrNil: converted.initializerOrNil,
          Loc: item.Loc,
        }));
      }

      return init(new js_ast.Binding(), {
        Loc: expr.Loc,
        Data: init(new js_ast.BArray(), {
          Items: items,
          HasSpread: hasSpread,
          IsSingleLine: e.IsSingleLine,
          CloseBracketLoc: e.CloseBracketLoc,
        }),
      });
    }

    if (e instanceof js_ast.EObject) {
      const properties: js_ast.PropertyBinding[] = [];

      for (const property of e.Properties) {
        if (js_ast.IsMethodDefinition(property.Kind)) {
          // Go: invalidLog.invalidTokens → "Invalid binding pattern"
          throw new LexerPanic();
        }

        const converted = this.convertExprToBindingAndInitializer(property.ValueOrNil ?? new js_ast.Expr());
        let initializerOrNil = converted.initializerOrNil;
        if (initializerOrNil === null) initializerOrNil = property.InitializerOrNil;

        properties.push(init(new js_ast.PropertyBinding(), {
          Loc: property.Loc,
          IsSpread: property.Kind === js_ast.PropertyKind.PropertySpread,
          IsComputed: (property.Flags & js_ast.PropertyFlags.PropertyIsComputed) !== 0,
          Key: property.Key,
          Value: converted.binding,
          DefaultValueOrNil: initializerOrNil,
        }));
      }

      return init(new js_ast.Binding(), {
        Loc: expr.Loc,
        Data: init(new js_ast.BObject(), {
          Properties: properties,
          IsSingleLine: e.IsSingleLine,
          CloseBraceLoc: e.CloseBraceLoc,
        }),
      });
    }

    // Go: invalidLog.invalidTokens → "Invalid binding pattern"
    this.lexer.Unexpected();
    throw new LexerPanic();
  }

  /** Go: func (p *parser) markExprAsParenthesized(value js_ast.Expr, openParenLoc logger.Loc, isAsync bool) */
  markExprAsParenthesized(value: js_ast.Expr, openParenLoc: Loc): void {
    // Go: js_parser.go:11891 —— 不要把括号前注释弄丢。
    if (this.exprComments !== null) {
      const comments = this.exprComments.get(openParenLoc.Start);
      if (comments !== undefined) {
        this.exprComments.delete(openParenLoc.Start);
        const existing = this.exprComments.get(value.Loc.Start);
        this.exprComments.set(value.Loc.Start, existing === undefined ? comments : comments.concat(existing));
      }
    }

    const e = value.Data;
    if (e instanceof js_ast.EArray || e instanceof js_ast.EObject || e instanceof js_ast.EFunction ||
      e instanceof js_ast.EArrow || e instanceof js_ast.EBinary) {
      e.IsParenthesized = true;
    }
  }

  // -------------------------------------------------------------------------
  // JSX
  // -------------------------------------------------------------------------

  /** Go: func (p *parser) parseJSXNamespacedName() (logger.Range, js_lexer.MaybeSubstring) */
  parseJSXNamespacedName(): { nameRange: Range; name: MaybeSubstring } {
    const nameRange = this.lexer.Range();
    const name = this.lexer.Identifier;
    this.lexer.ExpectInsideJSXElement(T.TIdentifier);

    // Parse JSX namespaces. These are not supported by React or TypeScript
    // but someone using JSX syntax in more obscure ways may find a use for them.
    if (this.lexer.Token === T.TColon) {
      // Parse the colon
      nameRange.Len = this.lexer.Range().End() - nameRange.Loc.Start;
      let ns = bytesToString(name.String) + ":";
      this.lexer.NextInsideJSXElement();

      // Parse the second identifier
      if (this.lexer.Token === T.TIdentifier) {
        nameRange.Len = this.lexer.Range().End() - nameRange.Loc.Start;
        ns += bytesToString(this.lexer.Identifier.String);
        this.lexer.NextInsideJSXElement();
      } else {
        AddError(
          this.log,
          this.tracker,
          new Range(new Loc(nameRange.End()), 0),
          "Expected identifier after " + goQuoted(ns) + " in namespaced JSX name",
        );
        throw new LexerPanic();
      }
      const result = new MaybeSubstring(codeUnits(ns), 0);
      return { nameRange, name: result };
    }

    return { nameRange, name };
  }

  /** Go: func (p *parser) parseJSXTag() (logger.Range, string, js_ast.Expr) */
  parseJSXTag(): { tagRange: Range; tagName: string; tagOrNil: js_ast.Expr | null } {
    const loc = this.lexer.Loc();

    // A missing tag is a fragment
    if (this.lexer.Token === T.TGreaterThan) {
      return { tagRange: new Range(loc, 0), tagName: "", tagOrNil: null };
    }

    // The tag is an identifier
    const { nameRange: tagRange, name } = this.parseJSXNamespacedName();
    const tagText = bytesToString(name.String);

    // Certain identifiers are strings
    if (
      tagText.includes("-") || tagText.includes(":") ||
      (this.lexer.Token !== T.TDot && tagText.length > 0 && tagText[0] >= "a" && tagText[0] <= "z")
    ) {
      return {
        tagRange,
        tagName: tagText,
        tagOrNil: new js_ast.Expr(new js_ast.EString(new Uint16Array(StringToUTF16(name.String))), loc),
      };
    }

    // Otherwise, this is an identifier
    let tag = new js_ast.Expr(
      new js_ast.EIdentifier(this.resolveName(this.loadNameFromRef(this.storeNameInRef(name)), loc)),
      loc,
    );

    // Parse a member expression chain
    let chain = tagText;
    while (this.lexer.Token === T.TDot) {
      this.lexer.NextInsideJSXElement();
      const memberRange = this.lexer.Range();
      const member = this.lexer.Identifier;
      this.lexer.ExpectInsideJSXElement(T.TIdentifier);

      // Dashes are not allowed in member expression chains
      const memberText = bytesToString(member.String);
      const index = memberText.indexOf("-");
      if (index >= 0) {
        AddError(
          this.log,
          this.tracker,
          new Range(new Loc(memberRange.Loc.Start + index), 0),
          'Unexpected "-"',
        );
        throw new LexerPanic();
      }

      chain += "." + memberText;
      tag = new js_ast.Expr(init(new js_ast.EDot(), {
        Target: tag,
        Name: memberText,
        NameLoc: memberRange.Loc,
      }), loc);
      tagRange.Len = memberRange.Loc.Start + memberRange.Len - tagRange.Loc.Start;
    }

    return { tagRange, tagName: chain, tagOrNil: tag };
  }

  /**
   * Go: func (p *parser) instantiateDefineExpr(loc logger.Loc, expr config.DefineExpr,
   * opts identifierOpts) js_ast.Expr (js_parser.go:12678)
   *
   * TS 侧 options.defines / injectedDotNames 尚未移植（M1 不用），这里只落 Parts 分支：
   * 特殊名字（NaN/Infinity/null/undefined/this/import.meta）与标识符链。
   */
  instantiateDefineExpr(loc: Loc, parts: string[]): js_ast.Expr {
    if (parts.length === 0) return new js_ast.Expr();

    // Generate an identifier for the first part
    let value: js_ast.Expr;
    const firstPart = parts[0];
    let rest = parts.slice(1);
    switch (firstPart) {
      case "NaN":
        value = new js_ast.Expr(init(new js_ast.ENumber(), { Value: NaN }), loc);
        break;
      case "Infinity":
        value = new js_ast.Expr(init(new js_ast.ENumber(), { Value: Infinity }), loc);
        break;
      case "null":
        value = new js_ast.Expr(js_ast.ENullShared, loc);
        break;
      case "undefined":
        value = new js_ast.Expr(js_ast.EUndefinedShared, loc);
        break;
      case "this":
        value = new js_ast.Expr(js_ast.EThisShared, loc);
        break;
      default: {
        if (firstPart === "import" && rest.length > 0 && rest[0] === "meta") {
          value = new js_ast.Expr(init(new js_ast.EImportMeta(), {}), loc);
          rest = rest.slice(1);
          break;
        }
        value = new js_ast.Expr(init(new js_ast.EIdentifier(this.resolveName(firstPart, loc)), {
          // Enable tree shaking
          CanBeRemovedIfUnused: true,
        }), loc);
        break;
      }
    }

    // Build up a chain of property access expressions for subsequent parts
    for (const part of rest) {
      value = new js_ast.Expr(init(new js_ast.EDot(), {
        Target: value,
        Name: part,
        NameLoc: loc,

        // Enable tree shaking
        CanBeRemovedIfUnused: true,
      }), loc);
    }
    return value;
  }

  /**
   * Go: func (p *parser) instantiateDefineExpr(loc, expr config.DefineExpr, opts) js_ast.Expr (js_parser.go:12678)
   * 第 44 轮 define 链的完整 1:1 版：Constant → InjectedDefineIndex → Parts。
   * M1 无 injectedDefineSymbols，故 InjectedDefineIndex 分支不触发（登记）。
   */
  instantiateDefineExprFromData(loc: Loc, expr: DefineExpr): js_ast.Expr {
    if (expr.Constant !== null) return new js_ast.Expr(expr.Constant, loc);
    // Go: InjectedDefineIndex.IsValid() —— M1 无注入 define，跳过
    return this.instantiateDefineExpr(loc, expr.Parts);
  }

  /**
   * Go: visitExprInOut 各分支的 define 检查（js_parser.go:13655 / 14287 / 16859）。
   * 在 visit 子表达式之前 peek 整个属性链；命中则实例化 define 值并替换。
   * 返回 null 表示未命中，调用方继续正常 visit。
   */
  private trySubstituteDefine(expr: js_ast.Expr, visitIn: exprIn): js_ast.Expr | null {
    if (this.options.defines.length === 0) return null;
    const e = expr.Data;
    // 取属性链最后一段作为 DotDefines 的索引键
    let key: string | null = null;
    if (e instanceof js_ast.EDot) key = e.Name;
    else if (e instanceof js_ast.EIndex) {
      const idx = e.Index.Data;
      if (idx instanceof js_ast.EString) key = decoder.decode(new Uint8Array(idx.Value));
    } else if (e instanceof js_ast.EIdentifier) {
      // DEVIATION: Go 用 loadNameFromRef（两趟 parser 的负 SourceIndex）；TS 一趟 parser 在 parse 期
      // 已 resolve 成真实符号，等价的名字来源是符号表的 OriginalName。
      key = this.symbols[e.Ref.InnerIndex]?.OriginalName ?? null;
    } else if (e instanceof js_ast.EImportMeta) key = "meta";
    if (key === null) return null;

    for (const def of this.options.defines) {
      const lastPart = def.KeyParts[def.KeyParts.length - 1];
      if (lastPart !== key) continue;
      if (!this.isDotOrIndexDefineMatch(expr, def.KeyParts)) continue;
      if (def.DefineExpr === null) break;
      const replacement = this.instantiateDefineExprFromData(expr.Loc, def.DefineExpr);
      // Go: 赋值目标要求 defineValueCanBeUsedInAssignTarget（M1 只替普通引用）
      if (visitIn.assignTarget !== assignTarget.assignTargetNone) return null;
      return replacement;
    }
    return null;
  }

  /**
   * Go: func (p *parser) isDotOrIndexDefineMatch(expr js_ast.Expr, parts []string) bool (js_parser.go:12619)
   * 1:1（第 44 轮 define 链）：递归匹配属性链。TS findSymbol 不标记 usage，故无需 Go 的 ignoreUsage。
   */
  isDotOrIndexDefineMatch(expr: js_ast.Expr, parts: string[]): boolean {
    const e = expr.Data;
    if (e instanceof js_ast.EDot) {
      if (parts.length > 1) {
        const last = parts.length - 1;
        return parts[last] === e.Name && this.isDotOrIndexDefineMatch(e.Target, parts.slice(0, last));
      }
    } else if (e instanceof js_ast.EIndex) {
      if (parts.length > 1) {
        const idx = e.Index.Data;
        if (idx instanceof js_ast.EString) {
          const last = parts.length - 1;
          return parts[last] === decoder.decode(new Uint8Array(idx.Value)) && this.isDotOrIndexDefineMatch(e.Target, parts.slice(0, last));
        }
      }
    } else if (e instanceof js_ast.EThis) {
      if (!this.isThisNested) return parts.length === 1 && parts[0] === "this";
    } else if (e instanceof js_ast.EImportMeta) {
      return parts.length === 2 && parts[0] === "import" && parts[1] === "meta";
    } else if (e instanceof js_ast.EIdentifier) {
      if (parts.length === 1) {
        // DEVIATION: 同 trySubstituteDefine —— 一趟 parser 用符号表 OriginalName 代替 loadNameFromRef。
        const name = this.symbols[e.Ref.InnerIndex]?.OriginalName ?? "";
        if (name !== parts[0]) return false;
        const found = this.findSymbol(expr.Loc, name);
        // Go: must not be inside a "with" scope
        if (this.withNesting > 0) return false;
        // Go: last symbol must be unbound or injected
        const kind = found !== null ? this.symbols[found.InnerIndex].Kind : SymbolKind.SymbolUnbound;
        return ast.IsUnboundOrInjected(kind);
      }
    }
    return false;
  }

  /** Go: type JSXImport uint8 (js_parser.go:1809) */
  importJSXSymbol(loc: Loc, jsx: number): js_ast.Expr {
    let symbols: Map<string, LocRef>;
    let name: string;
    switch (jsx) {
      case jsxImport.JSX:
        symbols = this.jsxRuntimeImports;
        name = this.options.jsx.Development ? "jsxDEV" : "jsx";
        break;
      case jsxImport.JSXS:
        symbols = this.jsxRuntimeImports;
        name = this.options.jsx.Development ? "jsxDEV" : "jsxs";
        break;
      case jsxImport.Fragment:
        symbols = this.jsxRuntimeImports;
        name = "Fragment";
        break;
      default:
        symbols = this.jsxLegacyImports;
        name = "createElement";
        break;
    }

    let it = symbols.get(name);
    if (it === undefined) {
      it = new LocRef(loc, this.newSymbol(SymbolKind.SymbolOther, name));
      this.moduleScope!.Generated.push(it.Ref);
      symbols.set(name, it);
    }

    return new js_ast.Expr(init(new js_ast.EIdentifier(it.Ref), {
      // Go: handleIdentifier(identifierOpts{wasOriginallyIdentifier: true})
      CanBeRemovedIfUnused: true,
    }), loc);
  }

  /**
   * Go: func (p *parser) lowerJSXElement? → 实际的 transform 在 visit pass 的
   * EJSXElement 分支（js_parser.go:13876-14111）。TS 侧在 parse pass 末尾就地执行。
   */
  lowerJSXElement(expr: js_ast.Expr, e: js_ast.EJSXElement): js_ast.Expr {
    const propsLoc = expr.Loc;
    // Remove any nil children in the array before iterating over it
    const children = e.NullableChildren.filter((child) => child.Data !== null);

    // A missing tag is a fragment
    const tag = e.TagOrNil !== null
      ? e.TagOrNil
      : (this.options.jsx.AutomaticRuntime
        ? this.importJSXSymbol(expr.Loc, jsxImport.Fragment)
        : this.instantiateDefineExpr(expr.Loc, this.options.jsx.Fragment));

    let shouldUseCreateElement = !this.options.jsx.AutomaticRuntime;
    if (!shouldUseCreateElement) {
      // Even for runtime="automatic", <div {...props} key={key} /> is special cased to createElement
      let seenPropsSpread = false;
      for (const property of e.Properties) {
        if (seenPropsSpread && property.Kind === js_ast.PropertyKind.PropertyField) {
          const key = property.Key.Data;
          if (key instanceof js_ast.EString && bytesToString(UTF16ToString(key.Value)) === "key") {
            shouldUseCreateElement = true;
            break;
          }
        } else if (property.Kind === js_ast.PropertyKind.PropertySpread) {
          seenPropsSpread = true;
        }
      }
    }

    if (shouldUseCreateElement) {
      // Arguments to createElement()
      const args: js_ast.Expr[] = [tag];
      if (e.Properties.length > 0) {
        // p.lowerObjectSpread：默认 unsupportedJSFeatures 为空，不需要降级，直接返回 EObject
        args.push(new js_ast.Expr(init(new js_ast.EObject(), {
          Properties: e.Properties,
          IsSingleLine: e.IsTagSingleLine,
        }), propsLoc));
      } else {
        args.push(new js_ast.Expr(js_ast.ENullShared, propsLoc));
      }
      args.push(...children);

      let target: js_ast.Expr;
      let kind: number = js_ast.CallKind.NormalCall;
      if (this.options.jsx.AutomaticRuntime) {
        target = this.importJSXSymbol(expr.Loc, jsxImport.CreateElement);
      } else {
        target = this.instantiateDefineExpr(expr.Loc, this.options.jsx.Factory);
        if (js_ast_helpers.IsPropertyAccess(target)) {
          kind = js_ast.CallKind.TargetWasOriginallyPropertyAccess;
        }
      }
      return new js_ast.Expr(init(new js_ast.ECall(), {
        Target: target,
        Args: args,
        CloseParenLoc: e.CloseLoc,
        IsMultiLine: !e.IsTagSingleLine,
        Kind: kind,

        // Enable tree shaking
        CanBeUnwrappedIfUnused: !this.options.jsx.SideEffects,
      }), expr.Loc);
    }

    // Arguments to jsx()
    const args: js_ast.Expr[] = [tag];

    // Props argument
    const properties: js_ast.Property[] = [];

    // For jsx(), "key" is passed in as a separate argument, so filter it out
    // from the props here. Also, check for __source and __self, which might have
    // been added by some upstream plugin. Their presence here would represent a
    // configuration error.
    let hasKey = false;
    let keyProperty = new js_ast.Expr(js_ast.EUndefinedShared, expr.Loc);
    for (const property of e.Properties) {
      const key = property.Key.Data;
      if (key instanceof js_ast.EString) {
        const propName = bytesToString(UTF16ToString(key.Value));
        switch (propName) {
          case "key":
            if (property.ValueOrNil !== null && property.ValueOrNil.Data instanceof js_ast.EBoolean &&
              (property.ValueOrNil.Data as js_ast.EBoolean).Value &&
              js_ast.Has(property.Flags, js_ast.PropertyFlags.PropertyWasShorthand)) {
              const r = RangeOfIdentifier(this.source, property.Loc);
              AddErrorWithNotes(this.log, this.tracker, r, 'Please provide an explicit value for "key":', [
                init(new MsgData(), {
                  Text:
                    'Using "key" as a shorthand for "key={true}" is not allowed when using React\'s "automatic" JSX transform.',
                }),
              ]);
            } else {
              keyProperty = property.ValueOrNil ?? new js_ast.Expr(js_ast.EUndefinedShared, property.Loc);
              hasKey = true;
            }
            continue;

          case "__source":
          case "__self": {
            const r = RangeOfIdentifier(this.source, property.Loc);
            AddErrorWithNotes(this.log, this.tracker, r, `Duplicate "${propName}" prop found:`, [init(new MsgData(), {
              Text:
                'Both "__source" and "__self" are set automatically by esbuild when using React\'s "automatic" JSX transform. ' +
                "This duplicate prop may have come from a plugin.",
            })]);
            continue;
          }
        }
      }
      properties.push(property);
    }

    let isStaticChildren = children.length > 1;

    // Children are passed in as an explicit prop
    if (children.length > 0) {
      let childrenValue = children[0];
      if (children.length > 1) {
        childrenValue = new js_ast.Expr(init(new js_ast.EArray(), { Items: children }), childrenValue.Loc);
      } else if (childrenValue.Data instanceof js_ast.ESpread) {
        // TypeScript considers spread children to be static
        childrenValue = new js_ast.Expr(init(new js_ast.EArray(), { Items: [childrenValue] }), childrenValue.Loc);
        isStaticChildren = true;
      }
      properties.push(init(new js_ast.Property(), {
        Key: new js_ast.Expr(init(new js_ast.EString(utf16FromString("children")), {}), childrenValue.Loc),
        ValueOrNil: childrenValue,
        Kind: js_ast.PropertyKind.PropertyField,
        Loc: childrenValue.Loc,
      }));
    }

    args.push(new js_ast.Expr(init(new js_ast.EObject(), {
      Properties: properties,
      IsSingleLine: e.IsTagSingleLine,
    }), propsLoc));

    // "key"
    if (hasKey) args.push(keyProperty);

    return new js_ast.Expr(init(new js_ast.ECall(), {
      Target: this.importJSXSymbol(expr.Loc, isStaticChildren ? jsxImport.JSXS : jsxImport.JSX),
      Args: args,
      CloseParenLoc: e.CloseLoc,
      IsMultiLine: !e.IsTagSingleLine,

      // Enable tree shaking
      CanBeUnwrappedIfUnused: !this.options.jsx.SideEffects,
    }), expr.Loc);
  }

  /** Go: func sortedKeysOfMapStringLocRef(in map[string]ast.LocRef) []string (js_parser.go:18597) */
  sortedKeysOfMapStringLocRef(inMap: Map<string, LocRef>): string[] {
    return [...inMap.keys()].sort();
  }

  /**
   * Go: func (p *parser) generateImportStmt(path string, pathRange logger.Range, imports []string,
   * parts []js_ast.Part, symbols map[string]ast.LocRef, sourceIndex *uint32, copySourceIndex *uint32)
   * ([]js_ast.Part, uint32) (js_parser.go:18532)
   *
   * TS 侧只有一个 Part（见 toAST），所以只返回 SImport 语句。
   */
  generateImportStmt(
    path: string,
    pathRange: Range,
    imports: string[],
    parts: js_ast.Part[],
    symbols: Map<string, LocRef>,
  ): js_ast.Part[] {
    if (pathRange.Len === 0) {
      let isFirst = true;
      for (const it of symbols.values()) {
        if (isFirst || it.Loc.Start < pathRange.Loc.Start) {
          pathRange.Loc = it.Loc;
        }
        isFirst = false;
      }
    }

    const namespaceRef = this.newSymbol(
      SymbolKind.SymbolOther,
      "import_" + js_ast.GenerateNonUniqueNameFromPath(path),
    );
    this.moduleScope!.Generated.push(namespaceRef);
    const clauseItems: js_ast.ClauseItem[] = [];
    const declaredSymbols: js_ast.DeclaredSymbol[] = [];
    declaredSymbols.push(init(new js_ast.DeclaredSymbol(), { Ref: namespaceRef, IsTopLevel: true }));
    const importRecordIndex = this.addImportRecord(
      ImportKind.ImportStmt,
      ImportPhase.EvaluationPhase,
      pathRange,
      path,
      null,
      0,
    );
    for (const alias of imports) {
      const it = symbols.get(alias)!;
      clauseItems.push(init(new js_ast.ClauseItem(), {
        Alias: alias,
        AliasLoc: it.Loc,
        Name: new LocRef(it.Loc, it.Ref),
      }));
      declaredSymbols.push(init(new js_ast.DeclaredSymbol(), { Ref: it.Ref, IsTopLevel: true }));
    }

    const part = new js_ast.Part();
    part.DeclaredSymbols = declaredSymbols;
    part.ImportRecordIndices = [importRecordIndex];
    part.Stmts = [new js_ast.Stmt(init(new js_ast.SImport(), {
      NamespaceRef: namespaceRef,
      Items: clauseItems,
      ImportRecordIndex: importRecordIndex,
      IsSingleLine: true,
    }), pathRange.Loc)];
    parts.push(part);
    return parts;
  }

  /** Go: func (p *parser) iifeCanBeRemovedIfUnused(args []js_ast.Arg, body js_ast.FnBody) bool (js_parser.go:11983) */
  iifeCanBeRemovedIfUnused(args: js_ast.Arg[], body: js_ast.FnBody): boolean {
    const ctx = new js_ast_helpers.HelperContext((ref) =>
      this.symbols[ref.InnerIndex].Kind === SymbolKind.SymbolUnbound);
    for (const arg of args) {
      if (arg.DefaultOrNil !== null && !ctx.ExprCanBeRemovedIfUnused(arg.DefaultOrNil)) {
        // The default value has a side effect
        return false;
      }
      if (!(arg.Binding.Data instanceof js_ast.BIdentifier)) {
        // Destructuring is a side effect (due to property access)
        return false;
      }
    }
    // Return statements are considered side-effect free (the return value is unused)
    return ctx.StmtsCanBeRemovedIfUnused(body.Block.Stmts, js_ast_helpers.ReturnCanBeRemovedIfUnused);
  }

  /** Go: js_parser.go:15306 —— 给无副作用的 IIFE 打 pure 标记 */
  maybeMarkIIFEAsPure(call: js_ast.ECall, target: js_ast.E | null): void {
    if (call.CanBeUnwrappedIfUnused) return;
    if (target instanceof js_ast.EArrow) {
      if (!target.IsAsync && this.iifeCanBeRemovedIfUnused(target.Args, target.Body)) {
        call.CanBeUnwrappedIfUnused = true;
      }
    } else if (target instanceof js_ast.EFunction) {
      if (!target.Fn.IsAsync && !target.Fn.IsGenerator &&
        this.iifeCanBeRemovedIfUnused(target.Fn.Args, target.Fn.Body)) {
        call.CanBeUnwrappedIfUnused = true;
      }
    }
  }

  /** Go: js_parser.go:15385 —— 直接 eval 与“原本是属性访问的调用目标”标记 */
  setCallKind(call: js_ast.ECall, target: js_ast.Expr): void {
    // Go: js_parser.go:15282 —— IIFE 的 function 目标强制加括号（"(function(){})()"）
    if (target.Data instanceof js_ast.EFunction) {
      target.Data.IsParenthesized = true;
    }
    if (call.OptionalChain === js_ast.OptionalChain.OptionalChainNone &&
      target.Data instanceof js_ast.EIdentifier &&
      this.symbols[target.Data.Ref.InnerIndex].OriginalName === "eval") {
      call.Kind = js_ast.CallKind.DirectEval;
      // Go: js_parser.go:15414 —— 标记本作用域及所有父作用域含直接 eval
      for (let s: js_ast.Scope | null = this.currentScope; s !== null; s = s.Parent) {
        s.ContainsDirectEval = true;
      }
    } else if (js_ast_helpers.IsPropertyAccess(target) && !this.logicalFoldedTargets.has(target)) {
      call.Kind = js_ast.CallKind.TargetWasOriginallyPropertyAccess;
    }
  }

  /** Go: func (p *parser) parseJSXElement(loc logger.Loc) js_ast.Expr */
  parseJSXElement(loc: Loc): js_ast.Expr {
    // Parse the tag
    const { tagName: startText, tagOrNil: startTagOrNil } = this.parseJSXTag();

    // Parse attributes
    const properties: js_ast.Property[] = [];
    let isSingleLine = true;

    if (startTagOrNil !== null) {
      parseAttributes:
      for (;;) {
        if (this.lexer.HasNewlineBefore) isSingleLine = false;

        switch (this.lexer.Token) {
          case T.TIdentifier: {
            // Parse the key
            const { nameRange: keyRange, name: keyName } = this.parseJSXNamespacedName();
            const key = new js_ast.Expr(
              new js_ast.EString(new Uint16Array(StringToUTF16(keyName.String))),
              keyRange.Loc,
            );

            // Parse the value
            let value: js_ast.Expr;
            let flags: js_ast.PropertyFlags = 0;
            if (this.lexer.Token !== T.TEquals) {
              // Implicitly true value
              flags |= js_ast.PropertyFlags.PropertyWasShorthand;
              value = new js_ast.Expr(new js_ast.EBoolean(true), new Loc(keyRange.Loc.Start + keyRange.Len));
            } else {
              // Use NextInsideJSXElement() not Next() so we can parse a JSX-style string literal
              this.lexer.NextInsideJSXElement();
              if (this.lexer.Token === T.TStringLiteral) {
                const stringLoc = this.lexer.Loc();
                if (this.options.jsx.Preserve) {
                  value = new js_ast.Expr(
                    init(new js_ast.EJSXText(), { Raw: this.lexer.Raw() }),
                    stringLoc,
                  );
                } else {
                  value = new js_ast.Expr(
                    init(new js_ast.EString(), { Value: this.lexer.StringLiteral() }),
                    stringLoc,
                  );
                }
                this.lexer.NextInsideJSXElement();
              } else if (this.lexer.Token === T.TLessThan) {
                // This may be removed in the future: https://github.com/facebook/jsx/issues/53
                const elementLoc = this.lexer.Loc();
                this.lexer.NextInsideJSXElement();
                flags |= js_ast.PropertyFlags.PropertyWasShorthand;
                value = this.parseJSXElement(elementLoc);

                // The call to parseJSXElement() above doesn't consume the last
                // TGreaterThan because the caller knows what Next() function to call.
                this.lexer.NextInsideJSXElement();
              } else {
                // Use Expect() not ExpectInsideJSXElement() so we can parse expression tokens
                this.lexer.Expect(T.TOpenBrace);
                value = this.parseExpr(js_ast.L.LLowest);
                this.lexer.ExpectInsideJSXElement(T.TCloseBrace);
              }
            }

            // Add a property
            properties.push(init(new js_ast.Property(), {
              Loc: keyRange.Loc,
              Key: key,
              ValueOrNil: value,
              Flags: flags,
            }));
            break;
          }

          case T.TOpenBrace: {
            // Use Next() not ExpectInsideJSXElement() so we can parse "..."
            this.lexer.Next();
            const dotLoc = this.saveExprCommentsHere();
            this.lexer.Expect(T.TDotDotDot);
            const value = this.parseExpr(js_ast.L.LComma);
            properties.push(init(new js_ast.Property(), {
              Kind: js_ast.PropertyKind.PropertySpread,
              Loc: dotLoc,
              ValueOrNil: value,
            }));

            // Use NextInsideJSXElement() not Next() so we can parse ">>" as ">"
            this.lexer.NextInsideJSXElement();
            break;
          }

          default:
            break parseAttributes;
        }
      }
    }

    // A slash here is a self-closing element
    if (this.lexer.Token === T.TSlash) {
      // Use NextInsideJSXElement() not Next() so we can parse ">>" as ">"
      const closeLoc = this.lexer.Loc();
      this.lexer.NextInsideJSXElement();
      if (this.lexer.Token !== T.TGreaterThan) {
        this.lexer.Expected(T.TGreaterThan);
      }
      const element = new js_ast.Expr(init(new js_ast.EJSXElement(), {
        TagOrNil: startTagOrNil,
        Properties: properties,
        CloseLoc: closeLoc,
        IsTagSingleLine: isSingleLine,
      }), loc);
      return this.options.jsx.Preserve ? element : this.lowerJSXElement(element, element.Data as js_ast.EJSXElement);
    }

    // Use ExpectJSXElementChild() so we parse child strings
    this.lexer.ExpectJSXElementChild(T.TGreaterThan);

    // Parse the children of this element
    const nullableChildren: js_ast.Expr[] = [];
    for (;;) {
      switch (this.lexer.Token) {
        case T.TStringLiteral: {
          if (this.options.jsx.Preserve) {
            nullableChildren.push(new js_ast.Expr(
              init(new js_ast.EJSXText(), { Raw: this.lexer.Raw() }),
              this.lexer.Loc(),
            ));
          } else {
            const str = this.lexer.StringLiteral();
            if (str.length > 0) {
              nullableChildren.push(new js_ast.Expr(
                init(new js_ast.EString(), { Value: str }),
                this.lexer.Loc(),
              ));
            }
            // Skip this token if it turned out to be empty after trimming
          }
          this.lexer.NextJSXElementChild();
          break;
        }

        case T.TOpenBrace: {
          // Use Next() instead of NextJSXElementChild() here since the next token is an expression
          this.lexer.Next();

          // The expression is optional, and may be absent
          if (this.lexer.Token === T.TCloseBrace) {
            // Save comments even for absent expressions
            nullableChildren.push(new js_ast.Expr(null, this.saveExprCommentsHere()));
          } else if (this.lexer.Token === T.TDotDotDot) {
            const itemLoc = this.lexer.Loc();
            this.lexer.Next();
            nullableChildren.push(new js_ast.Expr(
              init(new js_ast.ESpread(), { Value: this.parseExpr(js_ast.L.LLowest) }),
              itemLoc,
            ));
          } else {
            nullableChildren.push(this.parseExpr(js_ast.L.LLowest));
          }

          // Use ExpectJSXElementChild() so we parse child strings
          this.lexer.ExpectJSXElementChild(T.TCloseBrace);
          break;
        }

        case T.TLessThan: {
          const lessThanLoc = this.lexer.Loc();
          this.lexer.NextInsideJSXElement();

          if (this.lexer.Token !== T.TSlash) {
            // This is a child element
            nullableChildren.push(this.parseJSXElement(lessThanLoc));

            // The call to parseJSXElement() above doesn't consume the last
            // TGreaterThan because the caller knows what Next() function to call.
            this.lexer.NextJSXElementChild();
            continue;
          }

          // This is the closing element
          this.lexer.NextInsideJSXElement();
          const { tagName: endText } = this.parseJSXTag();
          if (startText !== endText) {
            // Go 在这里只记错误、不 panic（parseJSXElement 继续返回元素）
            AddError(
              this.log,
              this.tracker,
              this.lexer.Range(),
              "Unexpected closing " + tagOrFragmentHelpText(endText) + " does not match opening " +
                tagOrFragmentHelpText(startText),
            );
          }
          if (this.lexer.Token !== T.TGreaterThan) {
            this.lexer.Expected(T.TGreaterThan);
          }

          const element = new js_ast.Expr(init(new js_ast.EJSXElement(), {
            TagOrNil: startTagOrNil,
            Properties: properties,
            NullableChildren: nullableChildren,
            CloseLoc: lessThanLoc,
            IsTagSingleLine: isSingleLine,
          }), loc);
          return this.options.jsx.Preserve ? element : this.lowerJSXElement(element, element.Data as js_ast.EJSXElement);
        }

        case T.TEndOfFile: {
          AddError(
            this.log,
            this.tracker,
            this.lexer.Range(),
            "Unexpected end of file before a closing " + tagOrFragmentHelpText(startText),
          );
          throw new LexerPanic();
        }

        default:
          this.lexer.Unexpected();
      }
    }
  }

  // -------------------------------------------------------------------------
  // 收尾
  // -------------------------------------------------------------------------

  /** 骨架辅助：Go 的 Parse 末尾要跑 visit pass；骨架直接出单 part 的 AST */
  /** Go: func (p *parser) importFromRuntime(loc logger.Loc, name string) js_ast.Expr (js_parser.go:1790) */
  importFromRuntime(loc: Loc, name: string): js_ast.Expr {
    let it = this.runtimeImports.get(name);
    if (it === undefined) {
      it = new LocRef();
      it.Loc = loc;
      it.Ref = this.newSymbol(SymbolKind.SymbolOther, name);
      this.moduleScope!.Generated.push(it.Ref);
      this.runtimeImports.set(name, it);
    }
    this.recordUsage(it.Ref);
    return new js_ast.Expr(init(new js_ast.EIdentifier(it.Ref), {}), loc);
  }

  /** Go: func (p *parser) callRuntime(loc logger.Loc, name string, args []js_ast.Expr) js_ast.Expr (js_parser.go:1802) */
  callRuntime(loc: Loc, name: string, args: js_ast.Expr[]): js_ast.Expr {
    return new js_ast.Expr(init(new js_ast.ECall(), {
      Target: this.importFromRuntime(loc, name),
      Args: args,
    }), loc);
  }

  /** Go: func (p *parser) generateTopLevelTempRef() ast.Ref (js_parser.go:8649) */
  generateTopLevelTempRef(): Ref {
    const ref = this.newSymbol(
      SymbolKind.SymbolOther,
      "_" + DefaultNameMinifierJS.NumberToMinifiedName(this.topLevelTempRefCount),
    );
    this.topLevelTempRefsToDeclare.push(ref);
    this.moduleScope!.Generated.push(ref);
    this.topLevelTempRefCount++;
    return ref;
  }

  /** 内部：Ref → Map key（Go 的 map[ast.Ref] 键） */
  refKey(ref: Ref): string {
    return `${ref.SourceIndex}:${ref.InnerIndex}`;
  }

  /** Go: func (p *parser) warnAboutTypeofAndString(a js_ast.Expr, b js_ast.Expr, order typeofStringOrder) (js_parser.go:12832) */
  warnAboutTypeofAndString(a: js_ast.Expr, b: js_ast.Expr, order: number): void {
    if (order === checkBothOrders) {
      if (a.Data instanceof js_ast.EString) {
        const swap = a;
        a = b;
        b = swap;
      }
    }

    const unary = a.Data;
    const str = b.Data;
    if (unary instanceof js_ast.EUnary && unary.Op === js_ast.OpCode.UnOpTypeof) {
      if (str instanceof js_ast.EString) {
        const value = bytesToString(UTF16ToString(str.Value));
        switch (value) {
          case "undefined":
          case "object":
          case "boolean":
          case "number":
          case "bigint":
          case "string":
          case "symbol":
          case "function":
          case "unknown":
            break;
          default: {
            const r = this.source.RangeOfString(b.Loc);
            const text = `The "typeof" operator will never evaluate to ${goQuoted(value)}`;
            const notes: MsgData[] = [];
            if (value === "null") {
              notes.push(init(new MsgData(), {
                Text: 'The expression "typeof x" actually evaluates to "object" in JavaScript, not "null". ' +
                  'You need to use "x === null" to test for null.',
              }));
            }
            AddIDWithNotes(this.log, MsgID_JS_ImpossibleTypeof, MsgKind.Warning, this.tracker, r, text, notes);
          }
        }
      }
    }
  }

  /** Go: func (p *parser) warnAboutEqualityCheck(op string, value js_ast.Expr, afterOpLoc logger.Loc) bool (js_parser.go:12867) */
  warnAboutEqualityCheck(op: string, value: js_ast.Expr, afterOpLoc: Loc): boolean {
    const e = value.Data;

    if (e instanceof js_ast.ENumber) {
      // "0 === -0" is true in JavaScript. Here's an example of code with this problem: three.js #11183
      if (e.Value === 0 && Object.is(e.Value, -0)) {
        let r = new Range(value.Loc, 0);
        if (r.Loc.Start < this.source.Contents.length && this.source.Contents[r.Loc.Start] === 0x2d /* '-' */) {
          const zeroRange = this.source.RangeOfNumber(new Loc(r.Loc.Start + 1));
          r = new Range(r.Loc, zeroRange.Len + 1);
        }
        let text = `Comparison with -0 using the ${goQuoted(op)} operator will also match 0`;
        if (op === "case") text = "Comparison with -0 using a case clause will also match 0";
        AddIDWithNotes(this.log, MsgID_JS_EqualsNegativeZero, MsgKind.Warning, this.tracker, r, text, [init(new MsgData(), {
          Text: "Floating-point equality is defined such that 0 and -0 are equal, so \"x === -0\" returns true for both 0 and -0. " +
            "You need to use \"Object.is(x, -0)\" instead to test for -0.",
        })]);
        return true;
      }

      // "NaN === NaN" is false in JavaScript
      if (Number.isNaN(e.Value)) {
        let text = `Comparison with NaN using the ${goQuoted(op)} operator here is always ${op[0] === "!"}`;
        if (op === "case") text = "This case clause will never be evaluated because equality with NaN is always false";
        const r = this.source.RangeOfOperatorBefore(afterOpLoc, op);
        AddIDWithNotes(this.log, MsgID_JS_EqualsNaN, MsgKind.Warning, this.tracker, r, text, [init(new MsgData(), {
          Text: "Floating-point equality is defined such that NaN is never equal to anything, so \"x === NaN\" always returns false. " +
            "You need to use \"Number.isNaN(x)\" instead to test for NaN.",
        })]);
        return true;
      }
    } else if (
      e instanceof js_ast.EArray || e instanceof js_ast.EArrow || e instanceof js_ast.EClass ||
      e instanceof js_ast.EFunction || e instanceof js_ast.EObject || e instanceof js_ast.ERegExp
    ) {
      // This warning only applies to strict equality because loose equality can cause string conversions.
      if (op.length > 2) {
        let text = `Comparison using the ${goQuoted(op)} operator here is always ${op[0] === "!"}`;
        if (op === "case") text = "This case clause will never be evaluated because the comparison is always false";
        const r = this.source.RangeOfOperatorBefore(afterOpLoc, op);
        AddIDWithNotes(this.log, MsgID_JS_EqualsNewObject, MsgKind.Warning, this.tracker, r, text, [init(new MsgData(), {
          Text: "Equality with a new object is always false in JavaScript because the equality operator tests object identity. " +
            "You need to write code to compare the contents of the object instead. " +
            "For example, use \"Array.isArray(x) && x.length === 0\" instead of \"x === []\" to test for an empty array.",
        })]);
        return true;
      }
    }

    return false;
  }

  /** Go: func (p *parser) isUnsupportedRegularExpression(loc logger.Loc, value string) (pattern string, flags string, isUnsupported bool) (js_parser.go:13415) */
  isUnsupportedRegularExpression(loc: Loc, value: string): [string, string, boolean] {
    let what = "";
    let r = new Range(new Loc(0), 0);

    const end = value.lastIndexOf("/");
    const pattern = value.slice(1, end);
    const flags = value.slice(end + 1);
    const isUnicode = flags.indexOf("u") >= 0;
    let parenDepth = 0;
    let i = 0;
    let isUnsupported = false;

    // Do a simple scan for unsupported features assuming the regular expression is valid.
    patternLoop: while (i < pattern.length) {
      const c = pattern[i];
      i++;

      switch (c) {
        case "[":
          while (i < pattern.length) {
            const c2 = pattern[i];
            i++;
            if (c2 === "]") break;
            if (c2 === "\\") i++; // Skip the escaped character
          }
          break;

        case "(": {
          const tail = pattern.slice(i);

          if (tail.startsWith("?<=") || tail.startsWith("?<!")) {
            if (HasFeature(this.options.unsupportedJSFeatures, JSFeature.RegexpLookbehindAssertions)) {
              what = "Lookbehind assertions in regular expressions are not available";
              r = new Range(new Loc(loc.Start + i + 1), 3);
              isUnsupported = true;
              break patternLoop;
            }
          } else if (tail.startsWith("?<")) {
            if (HasFeature(this.options.unsupportedJSFeatures, JSFeature.RegexpNamedCaptureGroups)) {
              const close = tail.indexOf(">");
              if (close >= 0) {
                what = "Named capture groups in regular expressions are not available";
                r = new Range(new Loc(loc.Start + i + 1), close + 1);
                isUnsupported = true;
                break patternLoop;
              }
            }
          }

          parenDepth++;
          break;
        }

        case ")":
          if (parenDepth === 0) {
            r = new Range(new Loc(loc.Start + i), 1);
            AddError(this.log, this.tracker, r, 'Unexpected ")" in regular expression');
            return [pattern, flags, false];
          }
          parenDepth--;
          break;

        case "\\": {
          const tail = pattern.slice(i);

          if (isUnicode && (tail.startsWith("p{") || tail.startsWith("P{"))) {
            if (HasFeature(this.options.unsupportedJSFeatures, JSFeature.RegexpUnicodePropertyEscapes)) {
              const close = tail.indexOf("}");
              if (close >= 0) {
                what = "Unicode property escapes in regular expressions are not available";
                r = new Range(new Loc(loc.Start + i), close + 2);
                isUnsupported = true;
                break patternLoop;
              }
            }
          }

          i++; // Skip the escaped character
          break;
        }
      }
    }

    if (!isUnsupported) {
      for (let fi = 0; fi < flags.length; fi++) {
        const c = flags[fi];
        switch (c) {
          case "g":
          case "i":
          case "m":
            continue; // These are part of ES5 and are always supported

          case "s":
            if (!HasFeature(this.options.unsupportedJSFeatures, JSFeature.RegexpDotAllFlag)) continue;
            break;

          case "y":
          case "u":
            if (!HasFeature(this.options.unsupportedJSFeatures, JSFeature.RegexpStickyAndUnicodeFlags)) continue;
            break;

          case "d":
            if (!HasFeature(this.options.unsupportedJSFeatures, JSFeature.RegexpMatchIndices)) continue;
            break;

          case "v":
            if (!HasFeature(this.options.unsupportedJSFeatures, JSFeature.RegexpSetNotation)) continue;
            break;

          default:
            // Unknown flags are never supported
            break;
        }

        r = new Range(new Loc(loc.Start + (end + 1) + fi), 1);
        what = `The regular expression flag '${c}' is not available`;
        isUnsupported = true;
        break;
      }
    }

    if (isUnsupported) {
      // Go: config.PrettyPrintTargetEnvironment（overrides 分支属 M3；M1 只有默认文案）
      const where = this.options.originalTargetEnv !== ""
        ? this.options.originalTargetEnv
        : "the configured target environment";
      AddIDWithNotes(this.log, MsgID_JS_UnsupportedRegExp, MsgKind.Debug, this.tracker, r, `${what} in ${where}`, [init(new MsgData(), {
        Text: 'This regular expression literal has been converted to a "new RegExp()" constructor ' +
          "to avoid generating code with a syntax error. However, you will need to include a " +
          'polyfill for "RegExp" for your code to have the correct behavior at run-time.',
      })]);
    }

    return [pattern, flags, isUnsupported];
  }

  /** Go: func (p *parser) recordExport(loc logger.Loc, alias string, ref ast.Ref) (js_parser.go:17251) */
  recordExport(loc: Loc, alias: string, ref: Ref): void {
    const name = this.namedExports.get(alias);
    if (name !== undefined) {
      // Duplicate exports are an error
      AddErrorWithNotes(
        this.log,
        this.tracker,
        RangeOfIdentifier(this.source, loc),
        `Multiple exports with the same name ${goQuoted(alias)}`,
        [this.tracker.MsgData(
          RangeOfIdentifier(this.source, name.AliasLoc),
          `The name ${goQuoted(alias)} was originally exported here:`,
        )],
      );
    } else {
      const named = new js_ast.NamedExport();
      named.AliasLoc = loc;
      named.Ref = ref;
      this.namedExports.set(alias, named);
    }
  }

  /** Go: func (p *parser) checkForUnusedTSImportEquals(s *js_ast.SLocal, result *importsExportsScanResult) bool (js_parser.go:17270) */
  checkForUnusedTSImportEquals(s: js_ast.SLocal, result: importsExportsScanResult): boolean {
    if (s.WasTSImportEquals && !s.IsExport && s.Decls.length > 0 && s.Decls[0].ValueOrNil !== null) {
      const decl = s.Decls[0];

      // Skip to the underlying reference
      let value = decl.ValueOrNil;
      for (;;) {
        if (value.Data instanceof js_ast.EDot) {
          value = value.Data.Target;
        } else {
          break;
        }
      }

      // Is this an identifier reference and not a require() call?
      let valueRef: Ref | null = null;
      if (value.Data instanceof js_ast.EIdentifier) valueRef = value.Data.Ref;
      else if (value.Data instanceof js_ast.EImportIdentifier) valueRef = value.Data.Ref;
      if (valueRef !== null) {
        // Is this import statement unused?
        const ref = (decl.Binding.Data as js_ast.BIdentifier).Ref;
        if (this.symbols[ref.InnerIndex].UseCountEstimate === 0) {
          // Also don't count the referenced identifier
          this.ignoreUsage(valueRef);

          // Import-equals statements can come in any order. Removing one could potentially
          // cause another one to be removable too. Continue iterating until a fixed point.
          result.removedImportEquals = true;
          return true;
        } else {
          result.keptImportEquals = true;
        }
      }
    }

    return false;
  }

  /** Go: func (p *parser) scanForUnusedTSImportEquals(stmts []js_ast.Stmt) (result importsExportsScanResult) (js_parser.go:17313) */
  scanForUnusedTSImportEquals(stmts: js_ast.Stmt[]): importsExportsScanResult {
    const result = new importsExportsScanResult();
    const kept: js_ast.Stmt[] = [];
    for (const stmt of stmts) {
      const s = stmt.Data;
      if (s instanceof js_ast.SLocal && this.checkForUnusedTSImportEquals(s, result)) continue;
      kept.push(stmt);
    }
    result.stmts = kept;
    return result;
  }

  /**
   * Go: func (p *parser) scanForImportsAndExports(stmts []js_ast.Stmt) (result importsExportsScanResult) (js_parser.go:17332)
   *
   * M1（mode=PassThrough、ts.Parse=false、minifySyntax=false）走的是不受这三个开关保护的主干；
   * Go 里包在 `ts.Parse` / `mode = ModeBundle` 内的段落在 M1 不可达，用 `SKELETON` 标注。
   */
  scanForImportsAndExports(stmts: js_ast.Stmt[]): importsExportsScanResult {
    const result = new importsExportsScanResult();
    const kept: js_ast.Stmt[] = [];

    for (const stmt of stmts) {
      const s = stmt.Data;

      if (s instanceof js_ast.SImport) {
        const record = this.importRecords[s.ImportRecordIndex];

        // SKELETON（② ts.Parse 通道）：Go 的 unused-import 裁剪需要 p.tsUseCounts
        // 与 config.TSUnusedImportFlags（K 批），M1 的 ts.Parse=false 不进入。

        // SKELETON（M2 ModeBundle）：JSON import assertion 的非 default 报错需要
        // notesForAssertTypeJSON；这里只在真的进入 bundle 时报错，M1 不可达。
        if ((record.Flags & ImportRecordFlags.AssertTypeJSON) !== 0 && this.options.mode === 2 && s.Items !== null) {
          for (const item of s.Items) {
            if (item.Alias !== "default") {
              AddError(this.log, this.tracker, RangeOfIdentifier(this.source, item.AliasLoc),
                `Cannot use non-default import ${goQuoted(item.Alias)} with a JSON import assertion`);
            }
          }
        }

        // SKELETON（M2 ModeBundle）：Go 在这里为 namespace 属性访问建 namedImports
        // （p.importItemsForNamespace 未移植）。

        this.currentPart!.ImportRecordIndices.push(s.ImportRecordIndex);

        if (s.StarNameLoc !== null) {
          record.Flags |= ImportRecordFlags.ContainsImportStar;
        }

        if (s.DefaultName !== null) {
          record.Flags |= ImportRecordFlags.ContainsDefaultAlias;
        } else if (s.Items !== null) {
          for (const item of s.Items) {
            if (item.Alias === "default") {
              record.Flags |= ImportRecordFlags.ContainsDefaultAlias;
            } else if (item.Alias === "__esModule") {
              record.Flags |= ImportRecordFlags.ContainsESModuleAlias;
            }
          }
        }
      } else if (s instanceof js_ast.SFunction) {
        if (s.IsExport && s.Fn.Name !== null) {
          this.recordExport(s.Fn.Name.Loc, this.symbols[s.Fn.Name.Ref.InnerIndex].OriginalName, s.Fn.Name.Ref);
        }
      } else if (s instanceof js_ast.SClass) {
        if (s.IsExport && s.Class.Name !== null) {
          this.recordExport(s.Class.Name.Loc, this.symbols[s.Class.Name.Ref.InnerIndex].OriginalName, s.Class.Name.Ref);
        }
      } else if (s instanceof js_ast.SLocal) {
        if (s.IsExport) {
          js_ast_helpers.ForEachIdentifierBindingInDecls(s.Decls, (loc, b) => {
            this.recordExport(loc, this.symbols[b.Ref.InnerIndex].OriginalName, b.Ref);
          });
        }

        // Remove unused import-equals statements, since those likely correspond to types instead of values
        if (this.checkForUnusedTSImportEquals(s, result)) continue;
      } else if (s instanceof js_ast.SExportDefault) {
        this.recordExport(s.DefaultName.Loc, "default", s.DefaultName.Ref);
      } else if (s instanceof js_ast.SExportClause) {
        for (const item of s.Items) {
          this.recordExport(item.AliasLoc, item.Alias, item.Name.Ref);
        }
      } else if (s instanceof js_ast.SExportStar) {
        const record = this.importRecords[s.ImportRecordIndex];
        this.currentPart!.ImportRecordIndices.push(s.ImportRecordIndex);

        if (s.Alias !== null) {
          // "export * as ns from 'path'"
          const named = new js_ast.NamedImport();
          named.AliasIsStar = true;
          named.AliasLoc = s.Alias.Loc;
          named.NamespaceRef = InvalidRef;
          named.ImportRecordIndex = s.ImportRecordIndex;
          named.IsExported = true;
          this.namedImports.set(this.refKey(s.NamespaceRef), named);
          this.recordExport(s.Alias.Loc, s.Alias.OriginalName, s.NamespaceRef);

          record.Flags |= ImportRecordFlags.ContainsImportStar;
        } else {
          // "export * from 'path'"
          this.exportStarImportRecords.push(s.ImportRecordIndex);
        }
      } else if (s instanceof js_ast.SExportFrom) {
        const record = this.importRecords[s.ImportRecordIndex];
        this.currentPart!.ImportRecordIndices.push(s.ImportRecordIndex);

        for (const item of s.Items) {
          // Note that the imported alias is not item.Alias, which is the exported alias. This is
          // somewhat confusing because each SExportFrom statement is basically SImport + SExportClause.
          const named = new js_ast.NamedImport();
          named.Alias = item.OriginalName;
          named.AliasLoc = item.Name.Loc;
          named.NamespaceRef = s.NamespaceRef;
          named.ImportRecordIndex = s.ImportRecordIndex;
          named.IsExported = true;
          this.namedImports.set(this.refKey(item.Name.Ref), named);
          this.recordExport(item.Name.Loc, item.Alias, item.Name.Ref);

          if (item.OriginalName === "default") {
            record.Flags |= ImportRecordFlags.ContainsDefaultAlias;
          } else if (item.OriginalName === "__esModule") {
            record.Flags |= ImportRecordFlags.ContainsESModuleAlias;
          }
        }

        // SKELETON（M2 ModeBundle）：JSON import assertion 的非 default 报错（同 SImport）。
        // SKELETON（② ts.Parse）：空的 re-export 语句裁剪需要 TSUnusedImport_KeepStmt。
      }

      // Filter out statements we skipped over
      kept.push(stmt);
    }

    result.stmts = kept;
    return result;
  }

  /** Go: func (p *parser) appendPart(parts []js_ast.Part, stmts []js_ast.Stmt) []js_ast.Part (js_parser.go:17682) */
  appendPart(parts: js_ast.Part[], stmts: js_ast.Stmt[]): js_ast.Part[] {
    const part = new js_ast.Part();
    this.currentPart = part;
    part.Stmts = this.visitStmtsAndPrependTempRefs(stmts);
    part.DeclaredSymbols = this.declaredSymbols;
    this.declaredSymbols = [];

    // Sanity check
    if (this.currentScope !== this.moduleScope) {
      throw new Error("Internal error: Scope stack imbalance");
    }

    // SKELETON（G 批）：relocatedTopLevelVars 只在 mangle 时非空，M1 不触发。

    if (part.Stmts.length > 0) {
      let flags = 0;
      if (this.options.mode === 0 /* ModePassThrough */) {
        // Exports are tracked separately, so export clauses can normally always be removed.
        // Except we should keep them if we're not doing any format conversion.
        flags |= js_ast_helpers.KeepExportClauses;
      }
      const ctx = new js_ast_helpers.HelperContext(
        (ref) => this.symbols[ref.InnerIndex].Kind === SymbolKind.SymbolUnbound,
      );
      part.CanBeRemovedIfUnused = ctx.StmtsCanBeRemovedIfUnused(part.Stmts, flags);
      parts.push(part);
    }

    // Reset the state for this part so we don't accidentally mutate it
    this.currentPart = null;
    return parts;
  }

  /**
   * Go: func (p *parser) globPatternFromExpr(expr js_ast.Expr) ([]globPart, logger.Range) (js_parser.go:16758)
   * 1:1（第 44 轮 glob 链）：把动态 import 的路径表达式拆成 glob 片段。
   */
  globPatternFromExpr(expr: js_ast.Expr): { parts: globPart[] | null; range: Range } {
    const e = expr.Data;
    if (e instanceof js_ast.EString) {
      return { parts: [init(new globPart(), { text: bytesToString(UTF16ToString(e.Value)) })], range: this.source.RangeOfString(expr.Loc) };
    }
    if (e instanceof js_ast.ETemplate) {
      if (e.TagOrNil !== null && e.TagOrNil.Data !== null) return { parts: null, range: new Range() };
      const pattern: globPart[] = [init(new globPart(), { text: bytesToString(UTF16ToString(e.HeadCooked ?? new Uint16Array(0))) })];
      for (const part of e.Parts) {
        const sub = this.globPatternFromExpr(part.Value);
        if (sub.parts !== null) pattern.push(...sub.parts);
        else pattern.push(init(new globPart(), { isWildcard: true }));
        pattern.push(init(new globPart(), { text: bytesToString(UTF16ToString(part.TailCooked ?? new Uint16Array(0))) }));
      }
      if (e.Parts.length === 0) return { parts: pattern, range: this.source.RangeOfString(expr.Loc) };
      const text = this.source.Contents;
      const templateRange = new Range(e.HeadLoc, 0);
      for (let i = e.Parts[e.Parts.length - 1].TailLoc.Start; i < text.length; i++) {
        const c = text[i];
        if (c === 0x60) { templateRange.Len = i + 1 - templateRange.Loc.Start; break; }
        else if (c === 0x5c) { i += 1; }
      }
      return { parts: pattern, range: templateRange };
    }
    if (e instanceof js_ast.EBinary && e.Op === js_ast.OpCode.BinOpAdd) {
      const left = this.globPatternFromExpr(e.Left);
      if (left.parts === null) return { parts: null, range: new Range() };
      const right = this.globPatternFromExpr(e.Right);
      if (right.parts !== null) {
        left.parts.push(...right.parts);
        left.range.Len = right.range.End() - left.range.Loc.Start;
        return left;
      }
      left.parts.push(init(new globPart(), { isWildcard: true }));
      const rv = e.Right.Data;
      if (rv instanceof js_ast.EIdentifier) {
        left.range.Len = RangeOfIdentifier(this.source, e.Right.Loc).End() - left.range.Loc.Start;
      } else if (rv instanceof js_ast.ECall && rv.CloseParenLoc.Start > 0) {
        left.range.Len = rv.CloseParenLoc.Start + 1 - left.range.Loc.Start;
      }
      return left;
    }
    return { parts: null, range: new Range() };
  }

  /**
   * Go: func (p *parser) computeCharacterFrequency() *ast.CharFreq (js_parser.go:18481)
   * 1:1（第 44 轮 CharFreq 链）：扫描源码建字符直方图，扣掉注释/import 路径/将被重命名的符号/属性。
   */
  computeCharacterFrequency(): ast.CharFreq | null {
    if (!this.options.minifyIdentifiers || this.source.Index === runtimeSourceIndex) return null;

    const charFreq = new ast.CharFreq();
    charFreq.Scan(decoder.decode(this.source.Contents), 1);

    // Subtract out all comments
    for (const commentRange of this.lexer.AllComments) {
      charFreq.Scan(decoder.decode(this.source.TextForRange(commentRange)), -1);
    }

    // Subtract out all import paths
    // DEVIATION: Go 用 Index32.IsValid()（flippedBits!=0）；TS 的 ImportRecord.SourceIndex 简化为
    // number（0 = 无来源文件/invalid），故以 !== 0 近似。M1 语料无 import，此分支不触发。
    for (const record of this.importRecords) {
      if (record.SourceIndex === 0) {
        charFreq.Scan(record.Path.Text, -1);
      }
    }

    // Subtract out all symbols that will be minified
    const visit = (scope: js_ast.Scope): void => {
      for (const member of scope.Members.values()) {
        const symbol = this.symbols[member.Ref.InnerIndex];
        if (symbol !== undefined && symbol.SlotNamespace() !== ast.SlotNamespace.SlotMustNotBeRenamed) {
          charFreq.Scan(symbol.OriginalName, -symbol.UseCountEstimate);
        }
      }
      if (scope.Label.Ref !== InvalidRef && scope.Label.Ref.InnerIndex < this.symbols.length) {
        const symbol = this.symbols[scope.Label.Ref.InnerIndex];
        if (symbol !== undefined && symbol.SlotNamespace() !== ast.SlotNamespace.SlotMustNotBeRenamed) {
          charFreq.Scan(symbol.OriginalName, -symbol.UseCountEstimate - 1);
        }
      }
      for (const child of scope.Children) visit(child);
    };
    visit(this.moduleScope!);

    // Subtract out all properties that will be mangled
    if (this.mangledProps !== null) {
      for (const ref of this.mangledProps.values()) {
        const symbol = this.symbols[ref.InnerIndex];
        if (symbol !== undefined) charFreq.Scan(symbol.OriginalName, -symbol.UseCountEstimate);
      }
    }

    return charFreq;
  }

  toAST(parts: js_ast.Part[], hashbang: string): js_ast.AST {
    // Go: js_parser.go:18608-18660 —— 生成的 import 语句插到其它代码前面
    // （import 本来就会提升，但有些有 bug 的工具链会就地改写 import，所以放最前更稳）。
    let before: js_ast.Part[] = [];
    // Go: toAST —— runtime imports 先插（<runtime>），再插 JSX runtime / legacy imports
    if (this.runtimeImports.size > 0) {
      const keys = this.sortedKeysOfMapStringLocRef(this.runtimeImports);
      before = this.generateImportStmt("<runtime>", new Range(new Loc(0), 0), keys, before, this.runtimeImports);
    }
    if (this.jsxRuntimeImports.size > 0) {
      const keys = this.sortedKeysOfMapStringLocRef(this.jsxRuntimeImports);
      let path = this.options.jsx.ImportSource;
      path += this.options.jsx.Development ? "/jsx-dev-runtime" : "/jsx-runtime";
      before = this.generateImportStmt(path, new Range(new Loc(0), 0), keys, before, this.jsxRuntimeImports);
    }
    if (this.jsxLegacyImports.size > 0) {
      const keys = this.sortedKeysOfMapStringLocRef(this.jsxLegacyImports);
      before = this.generateImportStmt(
        this.options.jsx.ImportSource,
        new Range(new Loc(0), 0),
        keys,
        before,
        this.jsxLegacyImports,
      );
    }
    if (before.length > 0) parts = before.concat(parts);

    // Go: js_parser.go:18669-18699 —— 每个 part 扫一遍 import/export（namedExports/namedImports/flags）
    const scanned: js_ast.Part[] = [];
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex];
      this.currentPart = part;
      const result = this.scanForImportsAndExports(part.Stmts);
      this.currentPart = null;
      part.Stmts = result.stmts;
      // Go js_parser.go:18681 —— 空 part 也保留 index 0（namespace-export part）；
      // 仅 tree-shaking 底座产出该空 part，非 tree-shaking 维持旧骨架行为（M1 口径）。
      if (part.Stmts.length > 0 || (this.options.treeShaking && partIndex === 0 /* NSExportPartIndex */)) scanned.push(part);
    }
    parts = scanned;

    const ast = new js_ast.AST();
    ast.Parts = parts;
    ast.Symbols = this.symbols;
    ast.ModuleScope = this.moduleScope;
    // Go: js_parser.go:18815 —— toAST 里计算 CharFreq（minifyIdentifiers 时非 null）
    ast.CharFreq = this.computeCharacterFrequency();
    ast.Hashbang = hashbang;
    ast.ImportRecords = this.importRecords;
    ast.ExprComments = this.exprComments ?? new Map();
    ast.NamedImports = this.namedImports;
    ast.NamedExports = this.namedExports;
    ast.ExportStarImportRecords = this.exportStarImportRecords;
    // Go: js_parser.go:18834 —— PnP JS 拦截产物出 AST（第 172 批）
    ast.ManifestForYarnPnP = this.manifestForYarnPnP;
    return ast;
  }

  /**
   * Go: func (p *parser) prepareForVisitPass() (js_parser.go:18319)
   * 第 112 批：独立可用底座。正常 Parse 路径已内联等价逻辑（不动、保持绿门）；
   * 此供 LazyExportAST/GlobResolveAST 这类「零 lexer、不解析」的 AST 构建器调用。
   */
  prepareForVisitPass(): void {
    // scopesInOrder[0] 由 newParser 的 pushScopeForParsePass(ScopeEntry) 建立
    this.pushScopeForVisitPass(js_ast.ScopeKind.ScopeEntry, new Loc(0));
    this.fnOrArrowDataVisit.isOutsideFnOrArrow = true;
    this.moduleScope = this.currentScope;

    // ESM 判据（零 lexer 下各 keyword Range 均为 0，TypeScript tsAlwaysStrict 默认关）
    this.isFileConsideredToHaveESMExports = false;
    this.isFileConsideredESM = false;
    if (this.currentScope!.StrictMode === js_ast.StrictModeKind.SloppyMode &&
        this.options.jsx.AutomaticRuntime && this.firstJSXElementLoc.Start !== -1) {
      this.currentScope!.StrictMode = js_ast.StrictModeKind.ImplicitStrictModeJSXAutomaticRuntime;
    }

    this.hoistSymbols(this.moduleScope!);

    // CommonJS 符号（Go 18355-18362）
    if (this.options.mode !== 1 /* ModeBundle */) {
      this.requireRef = this.declareCommonJSSymbol(SymbolKind.SymbolUnbound, "require");
    } else {
      this.requireRef = this.newSymbol(SymbolKind.SymbolUnbound, "require");
    }
    if (this.options.mode !== 1 /* ModeBundle */ && !this.isFileConsideredToHaveESMExports) {
      this.exportsRef = this.declareCommonJSSymbol(SymbolKind.SymbolHoisted, "exports");
      this.moduleRef = this.declareCommonJSSymbol(SymbolKind.SymbolHoisted, "module");
    } else {
      this.exportsRef = this.newSymbol(SymbolKind.SymbolHoisted, "exports");
      this.moduleRef = this.newSymbol(SymbolKind.SymbolHoisted, "module");
    }
  }
}

/** Go: type HelperCall (js_parser.go:18132) */
export class HelperCall {
  Global: string[] = [];
  Runtime: string = "";
}

/** Go: func LazyExportAST(log, source, options, expr, helperCall) js_ast.AST (js_parser.go:18137) */
export function LazyExportAST(log: Log, source: Source, options: Options, expr: js_ast.Expr, helperCall: HelperCall | null): js_ast.AST {
  const p = newParser(log, source, null as any, options);
  p.prepareForVisitPass();

  let part = init(new js_ast.Part(), { SymbolUses: new Map<string, js_ast.SymbolUse>() });
  if (helperCall !== null) {
    p.currentPart = part;
    if (helperCall.Global.length > 0) {
      const ref = p.newSymbol(SymbolKind.SymbolUnbound, helperCall.Global[0]);
      p.recordUsage(ref);
      let target: js_ast.Expr = new js_ast.Expr(new js_ast.EIdentifier(ref));
      let kind: number = js_ast.CallKind.NormalCall;
      for (const name of helperCall.Global.slice(1)) {
        target = new js_ast.Expr(init(new js_ast.EDot(), { Target: target, Name: name }));
        kind = js_ast.CallKind.TargetWasOriginallyPropertyAccess;
      }
      expr = new js_ast.Expr(init(new js_ast.ECall(), { Target: target, Args: [expr], Kind: kind }));
    } else {
      expr = p.callRuntime(expr.Loc, helperCall.Runtime, [expr]);
    }
    p.currentPart = null;
  }
  const se = new js_ast.SLazyExport();
  se.Value = expr;
  part.Stmts = [new js_ast.Stmt(se, expr.Loc)];

  const nsExportPart = init(new js_ast.Part(), {
    SymbolUses: new Map<string, js_ast.SymbolUse>(),
    CanBeRemovedIfUnused: true,
  });
  const ast = p.toAST([nsExportPart, part], "");
  if (ast.Parts.length === 0 || ast.Parts[0] !== nsExportPart) ast.Parts.unshift(nsExportPart);
  ast.HasLazyExport = true;
  return ast;
}

/** Go: func GlobResolveAST(log, source, importRecords, object, name) js_ast.AST (js_parser.go:18180) */
export function GlobResolveAST(log: Log, source: Source, importRecords: js_ast.ImportRecord[], object: js_ast.EObject, name: string): js_ast.AST {
  const p = newParser(log, source, null as any, new Options());
  p.prepareForVisitPass();

  const nsExportPart = init(new js_ast.Part(), {
    SymbolUses: new Map<string, js_ast.SymbolUse>(),
    CanBeRemovedIfUnused: true,
  });
  p.importRecords = importRecords;
  const importRecordIndices: number[] = importRecords.map((_, i) => i);
  const ref = p.newSymbol(SymbolKind.SymbolOther, name);
  p.moduleScope!.Generated.push(ref);
  const part = init(new js_ast.Part(), {
    ImportRecordIndices: importRecordIndices,
    SymbolUses: new Map<string, js_ast.SymbolUse>(),
  });
  p.currentPart = part;
  const decl = new js_ast.Decl();
  decl.Binding = init(new js_ast.Binding(), { Data: new js_ast.BIdentifier(ref) });
  decl.ValueOrNil = p.callRuntime(new Loc(0), "__glob", [new js_ast.Expr(object)]);
  const sl = new js_ast.SLocal();
  sl.IsExport = true;
  sl.Decls = [decl];
  part.Stmts = [new js_ast.Stmt(sl, new Loc(0))];
  p.currentPart = null;
  p.esmExportKeyword = new Range(new Loc(0), 1);
  const ast = p.toAST([nsExportPart, part], "");
  if (ast.Parts.length === 0 || ast.Parts[0] !== nsExportPart) ast.Parts.unshift(nsExportPart);
  return ast;
}

// ---------------------------------------------------------------------------
// 包级入口
// ---------------------------------------------------------------------------

/** Go: type config.DefineExpr —— 这里只保留 JSX pragma 用到的两个字段 */
export class DefineExpr {
  Parts: string[] = [];
  Constant: js_ast.E | null = null;
}

/**
 * Go: func ParseDefineExpr(text string) (config.DefineExpr, js_ast.E) (js_parser.go:18224)
 *
 * 两条分支都已 1:1：
 *   1. 属性链（keywords 判定同 Go）；
 *   2. JSON 值 —— 走 json_parser.ts 的 `ParseJSON(IsForDefine: true)`（第 21 轮移植），
 *      Go 会把 ENull/EBoolean/EString/ENumber/EBigInt 放进 `Constant` 并返回 nil，
 *      其余复合值（EArray/EObject）直接返回（注入到行外）。
 */
export function ParseDefineExpr(text: string): [DefineExpr, js_ast.E | null] {
  if (text === "") return [new DefineExpr(), null];

  // Try a property chain
  let parts: string[] | null = text.split(".");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!IsIdentifier(new TextEncoder().encode(part))) {
      parts = null;
      break;
    }

    // Don't allow most keywords as the identifier
    if (i === 0) {
      const token = Keywords.get(part);
      if (
        token !== undefined && token !== T.TNull && token !== T.TThis &&
        (token !== T.TImport || parts.length < 2 || parts[1] !== "meta")
      ) {
        parts = null;
        break;
      }
    }
  }
  if (parts !== null) {
    const expr = new DefineExpr();
    expr.Parts = parts;
    return [expr, null];
  }

  // Try parsing a value（Go: ParseJSON(IsForDefine: true)，json_parser.go:189）
  const source = new Source();
  source.Contents = codeUnits(text);
  source.KeyPath = new Path();
  const { expr, ok } = ParseJSON(new Log(), source, init(new JSONOptions(), { IsForDefine: true }));
  if (!ok) {
    return [new DefineExpr(), null];
  }

  // Only primitive literals are inlined directly
  const data = expr.Data;
  if (
    data instanceof js_ast.ENull || data instanceof js_ast.EBoolean ||
    data instanceof js_ast.EString || data instanceof js_ast.ENumber ||
    data instanceof js_ast.EBigInt
  ) {
    return [init(new DefineExpr(), { Constant: data }), null];
  }

  // If it's not a primitive, return the whole compound JSON value to be injected out-of-line
  return [new DefineExpr(), data];
}

// ---------------------------------------------------------------------------
// visit / minify 侧的包级谓词（第 23 次推进：F-s1 的前置 + G 批纯谓词）
// 均为 Go 同名整函数；导出只为单测直接调用（同 `containsClosingScriptTag` 的口径）。
// ---------------------------------------------------------------------------

/** Go: func isSameRegexp(a *regexp.Regexp, b *regexp.Regexp) bool (js_parser.go:592) */
export function isSameRegexp(a: RegExp | null, b: RegExp | null): boolean {
  if (a === null) {
    return b === null;
  }
  // Go 比的是 `regexp.String()`（编译时的原始文本）；JS 的 RegExp 没存原文，
  // 用 `source + flags` 等价代替（本项目只在 options 比较上用，M1 不触发）。
  return b !== null && a.source === b.source && a.flags === b.flags;
}

/** Go: func jsxExprsEqual(a config.DefineExpr, b config.DefineExpr) bool (js_parser.go:600) */
export function jsxExprsEqual(a: DefineExpr, b: DefineExpr): boolean {
  if (!StringArraysEqual(a.Parts, b.Parts)) {
    return false;
  }

  if (a.Constant !== null) {
    if (b.Constant === null || !js_ast_helpers.ValuesLookTheSame(a.Constant, b.Constant)) {
      return false;
    }
  } else if (b.Constant !== null) {
    return false;
  }

  return true;
}

/** Go: func isJumpStatement(data js_ast.S) bool (js_parser.go:1113) */
export function isJumpStatement(data: js_ast.S | null): boolean {
  return data instanceof js_ast.SBreak || data instanceof js_ast.SContinue ||
    data instanceof js_ast.SReturn || data instanceof js_ast.SThrow;
}

/** Go: func jumpStmtsLookTheSame(left, right js_ast.S) bool (js_parser.go:1122) */
export function jumpStmtsLookTheSame(left: js_ast.S | null, right: js_ast.S | null): boolean {
  if (left instanceof js_ast.SBreak) {
    return right instanceof js_ast.SBreak &&
      (left.Label === null) === (right.Label === null) &&
      (left.Label === null || left.Label.Ref.Equals(right.Label!.Ref));
  }

  if (left instanceof js_ast.SContinue) {
    return right instanceof js_ast.SContinue &&
      (left.Label === null) === (right.Label === null) &&
      (left.Label === null || left.Label.Ref.Equals(right.Label!.Ref));
  }

  if (left instanceof js_ast.SReturn) {
    return right instanceof js_ast.SReturn &&
      (left.ValueOrNil === null) === (right.ValueOrNil === null) &&
      (left.ValueOrNil === null || js_ast_helpers.ValuesLookTheSame(left.ValueOrNil.Data, right.ValueOrNil!.Data));
  }

  if (left instanceof js_ast.SThrow) {
    return right instanceof js_ast.SThrow &&
      js_ast_helpers.ValuesLookTheSame(left.Value.Data, right.Value.Data);
  }

  return false;
}

/** Go: func defineValueCanBeUsedInAssignTarget(data js_ast.E) bool (js_parser.go:2004) */
export function defineValueCanBeUsedInAssignTarget(data: js_ast.E | null): boolean {
  if (data instanceof js_ast.EIdentifier || data instanceof js_ast.EDot) {
    return true;
  }

  // Substituting a constant into an assignment target (e.g. "x = 1" becomes
  // "0 = 1") will cause a syntax error, so we avoid doing this. The caller
  // will log a warning instead.
  return false;
}

/** Go: func textForParenthesesSuggestion(text string) string (js_parser.go:7067) */
export function textForParenthesesSuggestion(text: string): string {
  // Go: utf8.RuneCountInString(text) - 2
  let count = [...text].length - 2;
  if (count < 1) {
    count = 1;
  }
  return "(" + " ".repeat(count) + ")";
}

/** Go: func stmtCaresAboutScope(stmt js_ast.Stmt) bool (js_parser.go:10142) */
export function stmtCaresAboutScope(stmt: js_ast.S | null): boolean {
  if (
    stmt instanceof js_ast.SBlock || stmt instanceof js_ast.SEmpty || stmt instanceof js_ast.SDebugger ||
    stmt instanceof js_ast.SExpr || stmt instanceof js_ast.SIf || stmt instanceof js_ast.SFor ||
    stmt instanceof js_ast.SForIn || stmt instanceof js_ast.SForOf || stmt instanceof js_ast.SDoWhile ||
    stmt instanceof js_ast.SWhile || stmt instanceof js_ast.SWith || stmt instanceof js_ast.STry ||
    stmt instanceof js_ast.SSwitch || stmt instanceof js_ast.SReturn || stmt instanceof js_ast.SThrow ||
    stmt instanceof js_ast.SBreak || stmt instanceof js_ast.SContinue || stmt instanceof js_ast.SDirective ||
    stmt instanceof js_ast.SLabel
  ) {
    return false;
  }

  if (stmt instanceof js_ast.SLocal) {
    return stmt.Kind !== js_ast.LocalKind.LocalVar;
  }

  return true;
}

/** Go: func stmtsCareAboutScope(stmts []js_ast.Stmt) bool (js_parser.go:10158) */
export function stmtsCareAboutScope(stmts: js_ast.Stmt[]): boolean {
  for (const stmt of stmts) {
    if (stmtCaresAboutScope(stmt.Data)) {
      return true;
    }
  }
  return false;
}

/** Go: func dropFirstStatement(body js_ast.Stmt, replaceOrNil js_ast.Stmt) js_ast.Stmt (js_parser.go:10167) */
export function dropFirstStatement(body: js_ast.Stmt, replaceOrNil: js_ast.Stmt | null): js_ast.Stmt {
  const block = body.Data;
  if (block instanceof js_ast.SBlock && block.Stmts.length > 0) {
    if (replaceOrNil !== null) {
      block.Stmts[0] = replaceOrNil;
    } else if (block.Stmts.length === 2 && !stmtCaresAboutScope(block.Stmts[1].Data)) {
      return block.Stmts[1];
    } else {
      block.Stmts = block.Stmts.slice(1);
    }
    return body;
  }
  if (replaceOrNil !== null) {
    return replaceOrNil;
  }
  return new js_ast.Stmt(js_ast.SEmptyShared, body.Loc);
}

/** Go: func findIdentifiers(binding js_ast.Binding, identifiers []js_ast.Decl) []js_ast.Decl (js_parser.go:8781) */
export function findIdentifiers(binding: js_ast.Binding, identifiers: js_ast.Decl[]): js_ast.Decl[] {
  const b = binding.Data;
  if (b instanceof js_ast.BIdentifier) {
    const decl = new js_ast.Decl();
    decl.Binding = binding;
    identifiers.push(decl);
  } else if (b instanceof js_ast.BArray) {
    for (const item of b.Items) {
      identifiers = findIdentifiers(item.Binding, identifiers);
    }
  } else if (b instanceof js_ast.BObject) {
    for (const property of b.Properties) {
      identifiers = findIdentifiers(property.Value, identifiers);
    }
  }

  return identifiers;
}

/** Go: func shouldKeepStmtsInDeadControlFlow(stmts []js_ast.Stmt) bool (js_parser.go:8800) */
export function shouldKeepStmtsInDeadControlFlow(stmts: js_ast.Stmt[]): boolean {
  for (const child of stmts) {
    if (shouldKeepStmtInDeadControlFlow(child)) {
      return true;
    }
  }
  return false;
}

/**
 * Go: func shouldKeepStmtInDeadControlFlow(stmt js_ast.Stmt) bool (js_parser.go:8809)
 *
 * If this is in a dead branch, then we want to trim as much dead code as we can.
 * Everything can be trimmed except for hoisted declarations ("var" and "function"),
 * which affect the parent scope.
 */
export function shouldKeepStmtInDeadControlFlow(stmt: js_ast.Stmt): boolean {
  const s = stmt.Data;
  if (
    s instanceof js_ast.SEmpty || s instanceof js_ast.SExpr || s instanceof js_ast.SThrow ||
    s instanceof js_ast.SReturn || s instanceof js_ast.SBreak || s instanceof js_ast.SContinue ||
    s instanceof js_ast.SClass || s instanceof js_ast.SDebugger
  ) {
    // Omit these statements entirely
    return false;
  }

  if (s instanceof js_ast.SLocal) {
    if (s.Kind !== js_ast.LocalKind.LocalVar) {
      // Omit these statements entirely
      return false;
    }

    // Omit everything except the identifiers
    let identifiers: js_ast.Decl[] = [];
    for (const decl of s.Decls) {
      identifiers = findIdentifiers(decl.Binding, identifiers);
    }
    if (identifiers.length === 0) {
      return false;
    }
    s.Decls = identifiers;
    return true;
  }

  if (s instanceof js_ast.SBlock) {
    return shouldKeepStmtsInDeadControlFlow(s.Stmts);
  }

  if (s instanceof js_ast.STry) {
    return shouldKeepStmtsInDeadControlFlow(s.Block.Stmts) ||
      (s.Catch !== null && shouldKeepStmtsInDeadControlFlow(s.Catch.Block.Stmts)) ||
      (s.Finally !== null && shouldKeepStmtsInDeadControlFlow(s.Finally.Block.Stmts));
  }

  if (s instanceof js_ast.SIf) {
    return shouldKeepStmtInDeadControlFlow(s.Yes) ||
      (s.NoOrNil !== null && shouldKeepStmtInDeadControlFlow(s.NoOrNil));
  }

  if (s instanceof js_ast.SWhile || s instanceof js_ast.SDoWhile) {
    return shouldKeepStmtInDeadControlFlow(s.Body);
  }

  if (s instanceof js_ast.SFor) {
    return (s.InitOrNil !== null && shouldKeepStmtInDeadControlFlow(s.InitOrNil)) ||
      shouldKeepStmtInDeadControlFlow(s.Body);
  }

  if (s instanceof js_ast.SForIn || s instanceof js_ast.SForOf) {
    return shouldKeepStmtInDeadControlFlow(s.Init) || shouldKeepStmtInDeadControlFlow(s.Body);
  }

  if (s instanceof js_ast.SLabel) {
    return shouldKeepStmtInDeadControlFlow(s.Stmt);
  }

  // Everything else must be kept
  return true;
}

/** Go: func locAfterOp(e *js_ast.EBinary) logger.Loc (js_parser.go:13354) */
export function locAfterOp(e: js_ast.EBinary): Loc {
  if (e.Left.Loc.Start < e.Right.Loc.Start) {
    return e.Right.Loc;
  }
  // Handle the case when we have transposed the operands
  return e.Left.Loc;
}

/** Go: func isEvalOrArguments(name string) bool (js_parser.go:13363) */
export function isEvalOrArguments(name: string): boolean {
  return name === "eval" || name === "arguments";
}

/** Go: type typeofStringOrder uint8 (js_parser.go:12825) */
const onlyCheckOriginalOrder = 0;
const checkBothOrders = 1;

/** Go: type livenessStatus int8 (js_parser.go:757) */
const alwaysDead = -1;
const livenessUnknown = 0;
const alwaysLive = 1;

/** Go: type switchCaseLiveness struct (js_parser.go:763) */
class switchCaseLiveness {
  status: number = livenessUnknown;
  canFallThrough: boolean = true;
}

/** Go: func analyzeSwitchCasesForLiveness(s *js_ast.SSwitch) []switchCaseLiveness (js_parser.go:766) */
function analyzeSwitchCasesForLiveness(s: js_ast.SSwitch): switchCaseLiveness[] {
  const cases: switchCaseLiveness[] = [];
  let defaultIndex = -1;

  // Determine the status of the individual cases independently
  let maxStatus = alwaysDead;
  for (let i = 0; i < s.Cases.length; i++) {
    const c = s.Cases[i];
    if (c.ValueOrNil === null) defaultIndex = i;

    let status: number;
    if (maxStatus === alwaysLive) {
      status = alwaysDead; // Everything after an always-live case is always dead
    } else if (c.ValueOrNil === null) {
      status = alwaysDead; // This is the default case, and will be filled in later
    } else {
      const [isEqualToTest, ok] = js_ast_helpers.CheckEqualityIfNoSideEffects(
        s.Test.Data,
        c.ValueOrNil.Data,
        js_ast_helpers.StrictEquality,
      );
      if (ok) {
        status = isEqualToTest ? alwaysLive : alwaysDead;
      } else {
        status = livenessUnknown;
      }
    }
    if (maxStatus < status) maxStatus = status;

    const item = new switchCaseLiveness();
    item.status = status;
    item.canFallThrough = caseBodyCouldHaveFallThrough(c.Body);
    cases.push(item);
  }

  // Set the liveness for the default case last based on the other cases
  if (defaultIndex !== -1) {
    // The negation here transposes "always live" with "always dead"
    const status = -maxStatus;
    if (maxStatus < status) maxStatus = status;
    cases[defaultIndex].status = status;
  }

  // Then propagate fall-through information in linear fall-through order
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    if (c.status !== alwaysDead) {
      for (let j = i + 1; j < cases.length && cases[j - 1].canFallThrough; j++) {
        cases[j].status = livenessUnknown;
      }
    } else if (maxStatus > alwaysDead && stmtsCareAboutScope(s.Cases[i].Body)) {
      // Adjacent cases share a scope, so dead cases can potentially still affect live ones.
      cases[i].status = livenessUnknown;
    }
  }
  return cases;
}

const bloomFilterSize = 251;

/** Go: type duplicateCaseValue struct (js_parser.go:859) */
class duplicateCaseValue {
  value: js_ast.Expr = new js_ast.Expr();
  hash: number = 0;
}

/** Go: type duplicateCaseChecker struct (js_parser.go:864) */
class duplicateCaseChecker {
  cases: duplicateCaseValue[] = [];
  bloomFilter: Uint8Array = new Uint8Array((bloomFilterSize + 7) / 8);

  /** Go: func (dc *duplicateCaseChecker) reset() (js_parser.go:870) */
  reset(): void {
    // Preserve capacity
    this.cases = [];
    this.bloomFilter.fill(0);
  }

  /** Go: func (dc *duplicateCaseChecker) check(p *parser, expr js_ast.Expr) (js_parser.go:878) */
  check(p: parser, expr: js_ast.Expr): void {
    const [hash, ok] = duplicateCaseHash(expr);
    if (!ok) return;

    const bucket = hash % bloomFilterSize;
    const entry = bucket >> 3;
    const mask = 1 << (bucket % 8);

    // Check for collisions
    if ((this.bloomFilter[entry] & mask) !== 0) {
      for (const c of this.cases) {
        if (c.hash === hash) {
          const [equals, couldBeIncorrect] = duplicateCaseEquals(c.value, expr);
          if (equals) {
            let laterRange: Range;
            let earlierRange: Range;
            if (expr.Data instanceof js_ast.EString) laterRange = p.source.RangeOfString(expr.Loc);
            else laterRange = p.source.RangeOfOperatorBefore(expr.Loc, "case");
            if (c.value.Data instanceof js_ast.EString) earlierRange = p.source.RangeOfString(c.value.Loc);
            else earlierRange = p.source.RangeOfOperatorBefore(c.value.Loc, "case");
            let text = "This case clause will never be evaluated because it duplicates an earlier case clause";
            if (couldBeIncorrect) {
              text = "This case clause may never be evaluated because it likely duplicates an earlier case clause";
            }
            AddIDWithNotes(p.log, MsgID_JS_DuplicateCase, MsgKind.Warning, p.tracker, laterRange, text,
              [p.tracker.MsgData(earlierRange, "The earlier case clause is here:")]);
          }
          return;
        }
      }
    }

    this.bloomFilter[entry] |= mask;
    const value = new duplicateCaseValue();
    value.hash = hash;
    value.value = expr;
    this.cases.push(value);
  }
}

/** Go: func duplicateCaseHash(expr js_ast.Expr) (uint32, bool) (js_parser.go:925) */
export function duplicateCaseHash(expr: js_ast.Expr): [number, boolean] {
  const e = expr.Data;

  if (e instanceof js_ast.EInlinedEnum) return duplicateCaseHash(e.Value);
  if (e instanceof js_ast.ENull) return [0, true];
  if (e instanceof js_ast.EUndefined) return [1, true];
  if (e instanceof js_ast.EBoolean) return [HashCombine(2, e.Value ? 1 : 0), true];
  if (e instanceof js_ast.ENumber) {
    // Go: math.Float64bits
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, e.Value, true);
    const bits = view.getUint32(0, true);
    const high = view.getUint32(4, true);
    return [HashCombine(HashCombine(3, bits), high), true];
  }
  if (e instanceof js_ast.EString) {
    let hash = 4;
    for (const c of e.Value) hash = HashCombine(hash, c);
    return [hash, true];
  }
  if (e instanceof js_ast.EBigInt) {
    let hash = 5;
    for (const c of new TextEncoder().encode(e.Value)) hash = HashCombine(hash, c);
    return [hash, true];
  }
  if (e instanceof js_ast.EIdentifier) return [HashCombine(6, e.Ref.InnerIndex), true];
  if (e instanceof js_ast.EDot) {
    const [target, ok] = duplicateCaseHash(e.Target);
    if (ok) return [HashCombineString(HashCombine(7, target), new TextEncoder().encode(e.Name)), true];
  }
  if (e instanceof js_ast.EIndex) {
    const [target, targetOk] = duplicateCaseHash(e.Target);
    if (targetOk) {
      const [index, indexOk] = duplicateCaseHash(e.Index);
      if (indexOk) return [HashCombine(HashCombine(8, target), index), true];
    }
  }

  return [0, false];
}

/** Go: func duplicateCaseEquals(left js_ast.Expr, right js_ast.Expr) (equals bool, couldBeIncorrect bool) (js_parser.go:979) */
export function duplicateCaseEquals(left: js_ast.Expr, right: js_ast.Expr): [boolean, boolean] {
  if (right.Data instanceof js_ast.EInlinedEnum) return duplicateCaseEquals(left, right.Data.Value);

  const a = left.Data;
  const b = right.Data;

  if (a instanceof js_ast.EInlinedEnum) return duplicateCaseEquals(a.Value, right);
  if (a instanceof js_ast.ENull) return [b instanceof js_ast.ENull, false];
  if (a instanceof js_ast.EUndefined) return [b instanceof js_ast.EUndefined, false];
  if (a instanceof js_ast.EBoolean) return [b instanceof js_ast.EBoolean && a.Value === b.Value, false];
  if (a instanceof js_ast.ENumber) return [b instanceof js_ast.ENumber && a.Value === b.Value, false];
  if (a instanceof js_ast.EString) {
    if (!(b instanceof js_ast.EString)) return [false, false];
    if (a.Value.length !== b.Value.length) return [false, false];
    for (let i = 0; i < a.Value.length; i++) if (a.Value[i] !== b.Value[i]) return [false, false];
    return [true, false];
  }
  if (a instanceof js_ast.EBigInt) {
    if (b instanceof js_ast.EBigInt) {
      const [equal, ok] = js_ast_helpers.CheckEqualityBigInt(a.Value, b.Value);
      return [ok && equal, false];
    }
    return [false, false];
  }
  if (a instanceof js_ast.EIdentifier) {
    return [
      b instanceof js_ast.EIdentifier &&
      a.Ref.InnerIndex === b.Ref.InnerIndex && a.Ref.SourceIndex === b.Ref.SourceIndex,
      false,
    ];
  }
  if (a instanceof js_ast.EDot) {
    if (b instanceof js_ast.EDot && a.OptionalChain === b.OptionalChain && a.Name === b.Name) {
      return [duplicateCaseEquals(a.Target, b.Target)[0], true];
    }
    return [false, false];
  }
  if (a instanceof js_ast.EIndex) {
    if (b instanceof js_ast.EIndex && a.OptionalChain === b.OptionalChain) {
      if (duplicateCaseEquals(a.Index, b.Index)[0]) return [duplicateCaseEquals(a.Target, b.Target)[0], true];
    }
    return [false, false];
  }

  return [false, false];
}

/** Go: func caseBodyCouldHaveFallThrough(stmts []js_ast.Stmt) bool (js_parser.go:842) */
export function caseBodyCouldHaveFallThrough(stmts: js_ast.Stmt[]): boolean {
  for (;;) {
    if (stmts.length === 0) {
      break;
    }
    const s = stmts[stmts.length - 1].Data;
    if (s instanceof js_ast.SBlock) {
      stmts = s.Stmts; // If this ends with a block, check the block's body next
      continue;
    }
    if (
      s instanceof js_ast.SBreak || s instanceof js_ast.SContinue || s instanceof js_ast.SReturn ||
      s instanceof js_ast.SThrow
    ) {
      return false;
    }
    break;
  }
  return true;
}

/** Go: func containsClosingScriptTag(text string) bool (js_parser.go:13401) */
function containsClosingScriptTag(text: string): boolean {
  for (;;) {
    const i = text.indexOf("</");
    if (i < 0) break;
    text = text.slice(i + 2);
    if (text.length >= 6 && text.slice(0, 6).toLowerCase() === "script") {
      return true;
    }
  }
  return false;
}

/** Go: func newParser(log logger.Log, source logger.Source, lexer js_lexer.Lexer, options *Options) *parser */
export function newParser(log: Log, source: Source, lexer: Lexer, options: Options): parser {
  const p = new parser(log, source, lexer, options);
  p.pushScopeForParsePass(js_ast.ScopeKind.ScopeEntry, new Loc(0));
  return p;
}

/** Go: func Parse(log logger.Log, source logger.Source, options Options) (result js_ast.AST, ok bool) */
export function Parse(
  log: Log,
  source: Source,
  options: Options,
): { ast: js_ast.AST; ok: boolean } {
  let ok = true;
  const result = new js_ast.AST();
  try {
    const p = newParser(log, source, Lexer.NewLexer(log, source, options.ts), options);

    // Go: js_parser.go:18373-18420 —— @jsx / @jsxFrag / @jsxRuntime / @jsxImportSource
    // 都是整文件 lex 完之后（visit pass 开头）才生效。TS 侧 JSX lowering 在 parse 期，
    // 所以源码里出现 "@jsx" 时先用同一个 Lexer 预扫一遍（静默 Log 丢弃诊断，
    // 只搬 pragma 注释字段，不影响真实 parse）。
    {
      const contents = source.Contents;
      let hasAtJSX = false;
      for (let i = 0; i + 3 < contents.length; i++) {
        if (contents[i] === 0x40 && contents[i + 1] === 0x6a && contents[i + 2] === 0x73 && contents[i + 3] === 0x78) {
          hasAtJSX = true;
          break;
        }
      }
      if (hasAtJSX) {
        const scan = Lexer.NewLexer(new Log(), source, options.ts);
        try {
          while (scan.Token !== T.TEndOfFile) scan.Next();
        } catch (e) {
          if (!(e instanceof LexerPanic)) throw e;
        }
        p.lexer.JSXFactoryPragmaComment = scan.JSXFactoryPragmaComment;
        p.lexer.JSXFragmentPragmaComment = scan.JSXFragmentPragmaComment;
        p.lexer.JSXRuntimePragmaComment = scan.JSXRuntimePragmaComment;
        p.lexer.JSXImportSourcePragmaComment = scan.JSXImportSourcePragmaComment;
      }
    }

    // Handle "@jsx" and "@jsxFrag" pragmas now that lexing is done
    if (options.jsx.Parse) {
      const jsxRuntime = p.lexer.JSXRuntimePragmaComment;
      if (jsxRuntime.Text.length > 0) {
        const text = bytesToString(jsxRuntime.Text);
        if (text === "automatic") {
          options.jsx.AutomaticRuntime = true;
        } else if (text === "classic") {
          options.jsx.AutomaticRuntime = false;
        } else {
          AddIDWithNotes(
            log,
            MsgID_JS_UnsupportedJSXComment,
            MsgKind.Warning,
            p.tracker,
            jsxRuntime.Range,
            `Invalid JSX runtime: ${JSON.stringify(text)}`,
            [init(new MsgData(), { Text: 'The JSX runtime can only be set to either "classic" or "automatic".' })],
          );
        }
      }

      const jsxFactory = p.lexer.JSXFactoryPragmaComment;
      if (jsxFactory.Text.length > 0) {
        const text = bytesToString(jsxFactory.Text);
        if (options.jsx.AutomaticRuntime) {
          AddID(
            log,
            MsgID_JS_UnsupportedJSXComment,
            MsgKind.Warning,
            p.tracker,
            jsxFactory.Range,
            'The JSX factory cannot be set when using React\'s "automatic" JSX transform',
          );
        } else {
          const [expr] = ParseDefineExpr(text);
          if (expr.Parts.length > 0) {
            options.jsx.Factory = expr.Parts;
          } else {
            AddID(
              log,
              MsgID_JS_UnsupportedJSXComment,
              MsgKind.Warning,
              p.tracker,
              jsxFactory.Range,
              `Invalid JSX factory: ${text}`,
            );
          }
        }
      }

      const jsxFragment = p.lexer.JSXFragmentPragmaComment;
      if (jsxFragment.Text.length > 0) {
        const text = bytesToString(jsxFragment.Text);
        if (options.jsx.AutomaticRuntime) {
          AddID(
            log,
            MsgID_JS_UnsupportedJSXComment,
            MsgKind.Warning,
            p.tracker,
            jsxFragment.Range,
            'The JSX fragment cannot be set when using React\'s "automatic" JSX transform',
          );
        } else {
          const [expr] = ParseDefineExpr(text);
          if (expr.Parts.length > 0 || expr.Constant !== null) {
            if (expr.Parts.length > 0) options.jsx.Fragment = expr.Parts;
            // Go 是 `p.options.jsx.Fragment = expr`（config.DefineExpr，可能是 Constant）；
            // TS 的 JSXOptions.Fragment 只有 Parts，常量 fragment 的 lowering 留待需要时补
            // （M1 的 4,238 例不触发），已记入 PLAN「第 21 次推进」§5。
          } else {
            AddID(
              log,
              MsgID_JS_UnsupportedJSXComment,
              MsgKind.Warning,
              p.tracker,
              jsxFragment.Range,
              `Invalid JSX fragment: ${text}`,
            );
          }
        }
      }

      const jsxImportSource = p.lexer.JSXImportSourcePragmaComment;
      if (jsxImportSource.Text.length > 0) {
        const text = bytesToString(jsxImportSource.Text);
        if (!options.jsx.AutomaticRuntime) {
          AddIDWithNotes(
            log,
            MsgID_JS_UnsupportedJSXComment,
            MsgKind.Warning,
            p.tracker,
            jsxImportSource.Range,
            "The JSX import source cannot be set without also enabling React's \"automatic\" JSX transform",
            [init(new MsgData(), {
              Text:
                'You can enable React\'s "automatic" JSX transform for this file by using a "@jsxRuntime automatic" comment.',
            })],
          );
        } else {
          options.jsx.ImportSource = text;
        }
      }
    }

    // Consume a leading hashbang comment
    let hashbang = "";
    if (p.lexer.Token === T.THashbang) {
      hashbang = bytesToString(p.lexer.Identifier.String);
      p.lexer.Next();
    }

    // Parse the file in the first pass, but do not bind symbols
    const opts = new parseStmtOpts();
    opts.isModuleScope = true;
    opts.allowDirectivePrologue = true;
    let stmts = p.parseStmtsUpTo(T.TEndOfFile, opts);

    // Strip off all leading directives (Go: Parse 里的同一段逻辑)
    const directives: string[] = [];
    let totalCount = 0;
    let keptCount = 0;
    for (const stmt of stmts) {
      if (stmt.Data instanceof js_ast.SComment) {
        stmts[keptCount] = stmt;
        keptCount++;
        totalCount++;
        continue;
      }
      if (stmt.Data instanceof js_ast.SDirective) {
        const directive = bytesToString(UTF16ToString(stmt.Data.Value));
        if (!directives.includes(directive)) {
          directives.push(directive);
        }
        totalCount++;
        continue;
      }
      break;
    }
    if (keptCount < totalCount) {
      stmts.splice(keptCount, totalCount - keptCount);
    }

    // Go: visitStmtsAndPrependTempRefs —— 顶层临时变量（模板 lowering 的缓存变量）
    // 插到前导 SComment 之后（指令已剥离；Go 的 split 也只跳过 SComment/SDirective）。
    if (p.topLevelTempRefsToDeclare.length > 0) {
      const decls: js_ast.Decl[] = [];
      for (const ref of p.topLevelTempRefsToDeclare) {
        decls.push(init(new js_ast.Decl(), {
          Binding: init(new js_ast.Binding(), { Data: new js_ast.BIdentifier(ref) }),
        }));
        p.recordDeclaredSymbol(ref);
      }
      let split = 0;
      while (split < stmts.length && stmts[split].Data instanceof js_ast.SComment) split++;
      stmts = [
        ...stmts.slice(0, split),
        new js_ast.Stmt(init(new js_ast.SLocal(), { Kind: js_ast.LocalKind.LocalVar, Decls: decls })),
        ...stmts.slice(split),
      ];
      p.topLevelTempRefsToDeclare = [];
    }

    // Go: js_parser.go:18346-18352 —— ESM / "use strict" 先于 hoistSymbols 生效
    if (p.isFileConsideredESM) {
      p.moduleScope!.RecursiveSetStrictMode(js_ast.StrictModeKind.ImplicitStrictModeESM);
    }
    if (directives.includes("use strict")) {
      p.moduleScope!.RecursiveSetStrictMode(js_ast.StrictModeKind.ExplicitStrictMode);
    }

    // Go: js_parser.go:18352 —— 建 Annex B 的块级函数兄弟符号
    p.hoistSymbols(p.moduleScope!);


    // Go: js_parser.go:18330 —— ESM 导出判据（export 关键字 / import.meta / top-level await）；
    // top-level await 的跟踪属 E-s4，暂不置位。
    p.isFileConsideredToHaveESMExports = p.sawExportKeyword || p.sawImportMeta;

    // Go: prepareForVisitPass —— fnOrArrowDataVisit.isOutsideFnOrArrow = true (js_parser.go:18321)
    p.fnOrArrowDataVisit.isOutsideFnOrArrow = true;
    // Go: p.willWrapModuleInTryCatchForUsing = p.shouldLowerUsingDeclarations(stmts) (js_parser.go:18021)
    p.options.willWrapModuleInTryCatchForUsing = shouldLowerUsingDeclarations(p, stmts);

    // Go: prepareForVisitPass（js_parser.go:18319）+ appendPart（js_parser.go:17682）
    // 第 92 轮：补 tree-shaking part 拆分底座（Go js_parser.go:17909-17914 + 18029-18099）。
    // Go 在 treeShaking 下为每个顶层语句各产一个 part（多声明 var 再按 decl 拆），
    // 并预留 index 0 的 namespace-export 空 part；非 treeShaking 仍单 part（M1 口径不变）。
    p.pushScopeForVisitPass(js_ast.ScopeKind.ScopeEntry, new Loc(0));
    const nsExportPart = init(new js_ast.Part(), {
      SymbolUses: new Map<string, js_ast.SymbolUse>(),
      CanBeRemovedIfUnused: true,
    });
    const before: js_ast.Part[] = [nsExportPart];
    let parts: js_ast.Part[] = [];
    const after: js_ast.Part[] = [];
    if (!p.options.treeShaking) {
      parts = p.appendPart(parts, stmts);
    } else {
      // Go: for i, stmt := range stmts
      for (const stmt of stmts) {
        const d = stmt.Data;
        if (d instanceof js_ast.SLocal) {
          // 多声明 var 拆成单声明 part（Go 18066-18068）
          for (const decl of d.Decls) {
            const clone = init(new js_ast.SLocal(), {
              Decls: [decl], Kind: d.Kind, IsExport: d.IsExport, WasTSImportEquals: d.WasTSImportEquals,
            });
            parts = p.appendPart(parts, [new js_ast.Stmt(clone, stmt.Loc)]);
          }
        } else if (d instanceof js_ast.SImport || d instanceof js_ast.SExportFrom || d instanceof js_ast.SExportStar) {
          if (p.options.mode !== 0 /* ModePassThrough */) {
            // import / import-like export 移到文件头（Go 18071-18078）
            before.push(...p.appendPart([], [stmt]));
          } else {
            parts = p.appendPart(parts, [stmt]);
          }
        } else if (d instanceof js_ast.SExportEquals) {
          // export = 移到末尾（Go 18081-18082）
          after.push(...p.appendPart([], [stmt]));
        } else {
          parts = p.appendPart(parts, [stmt]);
        }
      }
      // Go: parts = append(before, parts...); parts = append(parts, after...)
      parts = before.concat(parts, after);
    }

    // 作用域栈不变量（第 25 轮 Step 0 固化）：parse+visit 结束后必须回到 moduleScope
    if (p.currentScope !== p.moduleScope) {
      throw new Error("Internal error: scope stack did not return to module scope");
    }
    p.popScope();

    const ast = p.toAST(parts, hashbang);
    ast.Directives = directives;
    return { ast, ok: true };
  } catch (e) {
    if (e instanceof LexerPanic) {
      ok = false;
      return { ast: result, ok };
    }
    throw e;
  }
}

// Go: global_name_parser.go 的 ParseGlobalName 已按「一文件一 TS」约定搬到
// ./global_name_parser.ts（第 44 轮归置）；此处 re-export 保持既有 import 兼容。
export { ParseGlobalName } from "./global_name_parser.ts";

// ---------------------------------------------------------------------------
// 小工具（Go 的 fmt / helpers 里本文件用到的那一点）
// ---------------------------------------------------------------------------

function codeUnits(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Go: fmt.Sprintf("%q", s)（骨架只用于 ASCII 名字/标签） */
export function goQuoted(s: string): string {
  let out = '"';
  for (const ch of s) {
    if (ch === '"' || ch === "\\") out += "\\" + ch;
    else out += ch;
  }
  return out + '"';
}

/** Go: func tagOrFragmentHelpText(tag string) string */
function tagOrFragmentHelpText(tag: string): string {
  if (tag === "") return "fragment tag";
  return goQuoted(tag) + " tag";
}

function opForPrefixToken(token: T): js_ast.OpCode {
  switch (token) {
    case T.TPlus: return js_ast.OpCode.UnOpPos;
    case T.TMinus: return js_ast.OpCode.UnOpNeg;
    case T.TTilde: return js_ast.OpCode.UnOpCpl;
    case T.TExclamation: return js_ast.OpCode.UnOpNot;
    case T.TVoid: return js_ast.OpCode.UnOpVoid;
    case T.TTypeof: return js_ast.OpCode.UnOpTypeof;
    case T.TDelete: return js_ast.OpCode.UnOpDelete;
  }
  throw new Error("Internal error: not a prefix operator token");
}

/**
 * 把 lexer token 映射到 (OpCode, 优先级, 右操作数优先级)。
 *
 * Go 的 parseSuffix 是一长串 `case js_lexer.TXxx: if level >= js_ast.LYyy { return left } ...`，
 * 这里把「左边最小优先级」与「递归解析右操作数的优先级」等价地集中在表里，
 * 取值逐个对照 js_ast.go 的 OpTable 与 js_parser.go 的对应 case（见每个条目右侧注释）。
 */
function opForBinaryToken(
  token: T,
): { op: js_ast.OpCode; level: js_ast.L; rightLevel: js_ast.L } | null {
  switch (token) {
    case T.TComma: return { op: js_ast.OpCode.BinOpComma, level: js_ast.L.LComma, rightLevel: js_ast.L.LComma };
    case T.TPlus: return { op: js_ast.OpCode.BinOpAdd, level: js_ast.L.LAdd, rightLevel: js_ast.L.LAdd };
    case T.TMinus: return { op: js_ast.OpCode.BinOpSub, level: js_ast.L.LAdd, rightLevel: js_ast.L.LAdd };
    case T.TAsterisk: return { op: js_ast.OpCode.BinOpMul, level: js_ast.L.LMultiply, rightLevel: js_ast.L.LMultiply };
    case T.TSlash: return { op: js_ast.OpCode.BinOpDiv, level: js_ast.L.LMultiply, rightLevel: js_ast.L.LMultiply };
    case T.TPercent: return { op: js_ast.OpCode.BinOpRem, level: js_ast.L.LMultiply, rightLevel: js_ast.L.LMultiply };
    case T.TAsteriskAsterisk:
      return {
        op: js_ast.OpCode.BinOpPow,
        level: js_ast.L.LExponentiation,
        rightLevel: (js_ast.L.LExponentiation - 1) as js_ast.L,
      };
    case T.TLessThan: return { op: js_ast.OpCode.BinOpLt, level: js_ast.L.LCompare, rightLevel: js_ast.L.LCompare };
    case T.TLessThanEquals:
      return { op: js_ast.OpCode.BinOpLe, level: js_ast.L.LCompare, rightLevel: js_ast.L.LCompare };
    case T.TGreaterThan:
      return { op: js_ast.OpCode.BinOpGt, level: js_ast.L.LCompare, rightLevel: js_ast.L.LCompare };
    case T.TGreaterThanEquals:
      return { op: js_ast.OpCode.BinOpGe, level: js_ast.L.LCompare, rightLevel: js_ast.L.LCompare };
    case T.TEqualsEquals:
      return { op: js_ast.OpCode.BinOpLooseEq, level: js_ast.L.LEquals, rightLevel: js_ast.L.LEquals };
    case T.TExclamationEquals:
      return { op: js_ast.OpCode.BinOpLooseNe, level: js_ast.L.LEquals, rightLevel: js_ast.L.LEquals };
    case T.TEqualsEqualsEquals:
      return { op: js_ast.OpCode.BinOpStrictEq, level: js_ast.L.LEquals, rightLevel: js_ast.L.LEquals };
    case T.TExclamationEqualsEquals:
      return { op: js_ast.OpCode.BinOpStrictNe, level: js_ast.L.LEquals, rightLevel: js_ast.L.LEquals };
    case T.TQuestionQuestion:
      return {
        op: js_ast.OpCode.BinOpNullishCoalescing,
        level: js_ast.L.LNullishCoalescing,
        rightLevel: js_ast.L.LNullishCoalescing,
      };
    case T.TBarBar:
      return { op: js_ast.OpCode.BinOpLogicalOr, level: js_ast.L.LLogicalOr, rightLevel: js_ast.L.LLogicalOr };
    case T.TAmpersandAmpersand:
      return {
        op: js_ast.OpCode.BinOpLogicalAnd,
        level: js_ast.L.LLogicalAnd,
        rightLevel: js_ast.L.LLogicalAnd,
      };
    case T.TBar: return { op: js_ast.OpCode.BinOpBitwiseOr, level: js_ast.L.LBitwiseOr, rightLevel: js_ast.L.LBitwiseOr };
    case T.TCaret:
      return { op: js_ast.OpCode.BinOpBitwiseXor, level: js_ast.L.LBitwiseXor, rightLevel: js_ast.L.LBitwiseXor };
    case T.TAmpersand:
      return { op: js_ast.OpCode.BinOpBitwiseAnd, level: js_ast.L.LBitwiseAnd, rightLevel: js_ast.L.LBitwiseAnd };
    case T.TLessThanLessThan:
      return { op: js_ast.OpCode.BinOpShl, level: js_ast.L.LShift, rightLevel: js_ast.L.LShift };
    case T.TGreaterThanGreaterThan:
      return { op: js_ast.OpCode.BinOpShr, level: js_ast.L.LShift, rightLevel: js_ast.L.LShift };
    case T.TGreaterThanGreaterThanGreaterThan:
      return { op: js_ast.OpCode.BinOpUShr, level: js_ast.L.LShift, rightLevel: js_ast.L.LShift };
    case T.TIn:
      return { op: js_ast.OpCode.BinOpIn, level: js_ast.L.LCompare, rightLevel: js_ast.L.LCompare };
    case T.TInstanceof:
      return { op: js_ast.OpCode.BinOpInstanceof, level: js_ast.L.LCompare, rightLevel: js_ast.L.LCompare };
    case T.TEquals:
      return {
        op: js_ast.OpCode.BinOpAssign,
        level: js_ast.L.LAssign,
        rightLevel: (js_ast.L.LAssign - 1) as js_ast.L,
      };
    case T.TPlusEquals:
      return {
        op: js_ast.OpCode.BinOpAddAssign,
        level: js_ast.L.LAssign,
        rightLevel: (js_ast.L.LAssign - 1) as js_ast.L,
      };
    case T.TMinusEquals:
      return {
        op: js_ast.OpCode.BinOpSubAssign,
        level: js_ast.L.LAssign,
        rightLevel: (js_ast.L.LAssign - 1) as js_ast.L,
      };
    case T.TAsteriskEquals:
      return {
        op: js_ast.OpCode.BinOpMulAssign,
        level: js_ast.L.LAssign,
        rightLevel: (js_ast.L.LAssign - 1) as js_ast.L,
      };
    case T.TSlashEquals:
      return {
        op: js_ast.OpCode.BinOpDivAssign,
        level: js_ast.L.LAssign,
        rightLevel: (js_ast.L.LAssign - 1) as js_ast.L,
      };
    case T.TQuestionQuestionEquals:
      return {
        op: js_ast.OpCode.BinOpNullishCoalescingAssign,
        level: js_ast.L.LAssign,
        rightLevel: (js_ast.L.LAssign - 1) as js_ast.L,
      };
    case T.TAmpersandAmpersandEquals:
      return {
        op: js_ast.OpCode.BinOpLogicalAndAssign,
        level: js_ast.L.LAssign,
        rightLevel: (js_ast.L.LAssign - 1) as js_ast.L,
      };
    case T.TBarBarEquals:
      return {
        op: js_ast.OpCode.BinOpLogicalOrAssign,
        level: js_ast.L.LAssign,
        rightLevel: (js_ast.L.LAssign - 1) as js_ast.L,
      };
  }
  return null;
}
