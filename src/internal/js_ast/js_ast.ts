// 1:1 移植自 esbuild internal/js_ast/js_ast.go（v0.28.2，commit f6058f83）
//
// 本轮（第 12 次推进）落的是**类型层**：枚举 + 全部 AST 节点结构 + 判定函数。
// 对照的 Go 行号写在每个声明上方，方便逐条核对。
//
// 约定（与 logger/helpers 的既定决策一致）：
//   - Go 的 `string` 是 UTF-8 字节串；AST 里需要保留字节语义的字段（EString.Value 等）用 Uint16Array
//     （UTF-16 码元，与 Go 的 []uint16 一一对应），标识符/属性名用 TS string。
//   - Go 的指针 nil → TS 的 `| null`，零值 → 构造函数默认值。
//   - Go 的接口 `E`/`S`/`B` 是「标记接口」，只为在类型系统里编码 variant。TS 里落成基类，
//     每个子类显式声明自己的 `isExpr()` / `isStmt()` / `isBinding()`（Go 侧每个类型也各有一个空方法）。
//     这不是装饰：Go 的 `expr.(type)` 分支在 TS 里由 `instanceof` + 该标记共同表达，测试会用
//     Go reflect 探针核对「哪些类型属于 Expr / Stmt / Binding」这一集合本身。
//   - 两个 `Has`（PropertyFlags.Has / AnnotationFlags.Has）Go 侧函数体逐字相同，TS 只能有一个同名函数，
//     这里合并为 `Has(flags, flag)` 并在两侧注释注明。

import { Loc, Path, PlatformIndependentPathDirBaseExt, Range, Span } from "../logger/logger.ts";
import { init } from "../helpers/init.ts";
import { Ref, InvalidRef, Symbol, CharFreq, LocRef, ImportPhase, SlotCounts, ImportAssertOrWith } from "../ast/ast.ts";

// ---------------------------------------------------------------------------
// 优先级 / 运算符
// ---------------------------------------------------------------------------

/** Go: type L uint8 (js_ast.go:25) */
export type L = number;
export const L = {
  LLowest: 0,
  LComma: 1,
  LSpread: 2,
  LYield: 3,
  LAssign: 4,
  LConditional: 5,
  LNullishCoalescing: 6,
  LLogicalOr: 7,
  LLogicalAnd: 8,
  LBitwiseOr: 9,
  LBitwiseXor: 10,
  LBitwiseAnd: 11,
  LEquals: 12,
  LCompare: 13,
  LShift: 14,
  LAdd: 15,
  LMultiply: 16,
  LExponentiation: 17,
  LPrefix: 18,
  LPostfix: 19,
  LNew: 20,
  LCall: 21,
  LMember: 22,
} as const;

/** Go: type AssignTarget uint8 (js_ast.go:95) */
export type AssignTarget = number;
export const AssignTarget = {
  AssignTargetNone: 0,
  AssignTargetReplace: 1, // "a = b"
  AssignTargetUpdate: 2, // "a += b"
} as const;

/** Go: type OpCode uint8 (js_ast.go:54) */
export type OpCode = number;
export const OpCode = {
  // Prefix
  UnOpPos: 0,
  UnOpNeg: 1,
  UnOpCpl: 2,
  UnOpNot: 3,
  UnOpVoid: 4,
  UnOpTypeof: 5,
  UnOpDelete: 6,

  // Prefix update
  UnOpPreDec: 7,
  UnOpPreInc: 8,

  // Postfix update
  UnOpPostDec: 9,
  UnOpPostInc: 10,

  // Left-associative
  BinOpAdd: 11,
  BinOpSub: 12,
  BinOpMul: 13,
  BinOpDiv: 14,
  BinOpRem: 15,
  BinOpPow: 16,
  BinOpLt: 17,
  BinOpLe: 18,
  BinOpGt: 19,
  BinOpGe: 20,
  BinOpIn: 21,
  BinOpInstanceof: 22,
  BinOpShl: 23,
  BinOpShr: 24,
  BinOpUShr: 25,
  BinOpLooseEq: 26,
  BinOpLooseNe: 27,
  BinOpStrictEq: 28,
  BinOpStrictNe: 29,
  BinOpNullishCoalescing: 30,
  BinOpLogicalOr: 31,
  BinOpLogicalAnd: 32,
  BinOpBitwiseOr: 33,
  BinOpBitwiseAnd: 34,
  BinOpBitwiseXor: 35,

  // Non-associative
  BinOpComma: 36,

  // Right-associative
  BinOpAssign: 37,
  BinOpAddAssign: 38,
  BinOpSubAssign: 39,
  BinOpMulAssign: 40,
  BinOpDivAssign: 41,
  BinOpRemAssign: 42,
  BinOpPowAssign: 43,
  BinOpShlAssign: 44,
  BinOpShrAssign: 45,
  BinOpUShrAssign: 46,
  BinOpBitwiseOrAssign: 47,
  BinOpBitwiseAndAssign: 48,
  BinOpBitwiseXorAssign: 49,
  BinOpNullishCoalescingAssign: 50,
  BinOpLogicalOrAssign: 51,
  BinOpLogicalAndAssign: 52,
} as const;

/** Go: func (op OpCode) IsPrefix() bool (js_ast.go:56) */
export function IsPrefix(op: OpCode): boolean {
  return op < OpCode.UnOpPostDec;
}

/** Go: func (op OpCode) UnaryAssignTarget() AssignTarget (js_ast.go:60) */
export function UnaryAssignTarget(op: OpCode): AssignTarget {
  if (op >= OpCode.UnOpPreDec && op <= OpCode.UnOpPostInc) return AssignTarget.AssignTargetUpdate;
  return AssignTarget.AssignTargetNone;
}

/** Go: func (op OpCode) IsLeftAssociative() bool (js_ast.go:67) */
export function IsLeftAssociative(op: OpCode): boolean {
  return op >= OpCode.BinOpAdd && op < OpCode.BinOpComma && op !== OpCode.BinOpPow;
}

/** Go: func (op OpCode) IsRightAssociative() bool (js_ast.go:71) */
export function IsRightAssociative(op: OpCode): boolean {
  return op >= OpCode.BinOpAssign || op === OpCode.BinOpPow;
}

/** Go: func (op OpCode) BinaryAssignTarget() AssignTarget (js_ast.go:75) */
export function BinaryAssignTarget(op: OpCode): AssignTarget {
  if (op === OpCode.BinOpAssign) return AssignTarget.AssignTargetReplace;
  if (op > OpCode.BinOpAssign) return AssignTarget.AssignTargetUpdate;
  return AssignTarget.AssignTargetNone;
}

/** Go: func (op OpCode) IsShortCircuit() bool (js_ast.go:85) */
export function IsShortCircuit(op: OpCode): boolean {
  switch (op) {
    case OpCode.BinOpLogicalOr:
    case OpCode.BinOpLogicalOrAssign:
    case OpCode.BinOpLogicalAnd:
    case OpCode.BinOpLogicalAndAssign:
    case OpCode.BinOpNullishCoalescing:
    case OpCode.BinOpNullishCoalescingAssign:
      return true;
  }
  return false;
}

/** Go: type OpTableEntry struct (js_ast.go:171) */
export class OpTableEntry {
  Text: string;
  Level: L;
  IsKeyword: boolean;

  constructor(Text: string = "", Level: L = L.LLowest, IsKeyword: boolean = false) {
    this.Text = Text;
    this.Level = Level;
    this.IsKeyword = IsKeyword;
  }
}

/** Go: var OpTable = []OpTableEntry{...} (js_ast.go:177) */
export const OpTable: OpTableEntry[] = [
  // Prefix
  new OpTableEntry("+", L.LPrefix, false),
  new OpTableEntry("-", L.LPrefix, false),
  new OpTableEntry("~", L.LPrefix, false),
  new OpTableEntry("!", L.LPrefix, false),
  new OpTableEntry("void", L.LPrefix, true),
  new OpTableEntry("typeof", L.LPrefix, true),
  new OpTableEntry("delete", L.LPrefix, true),

  // Prefix update
  new OpTableEntry("--", L.LPrefix, false),
  new OpTableEntry("++", L.LPrefix, false),

  // Postfix update
  new OpTableEntry("--", L.LPostfix, false),
  new OpTableEntry("++", L.LPostfix, false),

  // Left-associative
  new OpTableEntry("+", L.LAdd, false),
  new OpTableEntry("-", L.LAdd, false),
  new OpTableEntry("*", L.LMultiply, false),
  new OpTableEntry("/", L.LMultiply, false),
  new OpTableEntry("%", L.LMultiply, false),
  new OpTableEntry("**", L.LExponentiation, false), // Right-associative
  new OpTableEntry("<", L.LCompare, false),
  new OpTableEntry("<=", L.LCompare, false),
  new OpTableEntry(">", L.LCompare, false),
  new OpTableEntry(">=", L.LCompare, false),
  new OpTableEntry("in", L.LCompare, true),
  new OpTableEntry("instanceof", L.LCompare, true),
  new OpTableEntry("<<", L.LShift, false),
  new OpTableEntry(">>", L.LShift, false),
  new OpTableEntry(">>>", L.LShift, false),
  new OpTableEntry("==", L.LEquals, false),
  new OpTableEntry("!=", L.LEquals, false),
  new OpTableEntry("===", L.LEquals, false),
  new OpTableEntry("!==", L.LEquals, false),
  new OpTableEntry("??", L.LNullishCoalescing, false),
  new OpTableEntry("||", L.LLogicalOr, false),
  new OpTableEntry("&&", L.LLogicalAnd, false),
  new OpTableEntry("|", L.LBitwiseOr, false),
  new OpTableEntry("&", L.LBitwiseAnd, false),
  new OpTableEntry("^", L.LBitwiseXor, false),

  // Non-associative
  new OpTableEntry(",", L.LComma, false),

  // Right-associative
  new OpTableEntry("=", L.LAssign, false),
  new OpTableEntry("+=", L.LAssign, false),
  new OpTableEntry("-=", L.LAssign, false),
  new OpTableEntry("*=", L.LAssign, false),
  new OpTableEntry("/=", L.LAssign, false),
  new OpTableEntry("%=", L.LAssign, false),
  new OpTableEntry("**=", L.LAssign, false),
  new OpTableEntry("<<=", L.LAssign, false),
  new OpTableEntry(">>=", L.LAssign, false),
  new OpTableEntry(">>>=", L.LAssign, false),
  new OpTableEntry("|=", L.LAssign, false),
  new OpTableEntry("&=", L.LAssign, false),
  new OpTableEntry("^=", L.LAssign, false),
  new OpTableEntry("??=", L.LAssign, false),
  new OpTableEntry("||=", L.LAssign, false),
  new OpTableEntry("&&=", L.LAssign, false),
];

// ---------------------------------------------------------------------------
// 属性 / 绑定 / 函数 / 类
// ---------------------------------------------------------------------------

/** Go: type Decorator struct (js_ast.go:244) */
export class Decorator {
  Value: Expr;
  AtLoc: Loc;
  OmitNewlineAfter: boolean;

  constructor(Value: Expr = new Expr(), AtLoc: Loc = new Loc(0), OmitNewlineAfter: boolean = false) {
    this.Value = Value;
    this.AtLoc = AtLoc;
    this.OmitNewlineAfter = OmitNewlineAfter;
  }
}

/** Go: type PropertyKind uint8 (js_ast.go:250) */
export type PropertyKind = number;
export const PropertyKind = {
  PropertyField: 0,
  PropertyMethod: 1,
  PropertyGetter: 2,
  PropertySetter: 3,
  PropertyAutoAccessor: 4,
  PropertySpread: 5,
  PropertyDeclareOrAbstract: 6,
  PropertyClassStaticBlock: 7,
} as const;

/** Go: func (kind PropertyKind) IsMethodDefinition() bool (js_ast.go:275) */
export function IsMethodDefinition(kind: PropertyKind): boolean {
  return kind === PropertyKind.PropertyMethod || kind === PropertyKind.PropertyGetter ||
    kind === PropertyKind.PropertySetter;
}

/** Go: type ClassStaticBlock struct (js_ast.go:279) */
export class ClassStaticBlock {
  Block: SBlock = new SBlock();
  Loc: Loc = new Loc(0);
}

/** Go: type PropertyFlags uint8 (js_ast.go:284) */
export type PropertyFlags = number;
export const PropertyFlags = {
  PropertyIsComputed: 1 << 0,
  PropertyIsStatic: 1 << 1,
  PropertyWasShorthand: 1 << 2,
  PropertyPreferQuotedKey: 1 << 3,
} as const;

/**
 * Go: func (flags PropertyFlags) Has(flag PropertyFlags) bool (js_ast.go:293)
 *     func (flags AnnotationFlags) Has(flag AnnotationFlags) bool (js_ast.go:1201)
 *
 * 两处函数体逐字相同（`(flags & flag) != 0`），TS 同名函数只能有一个，故合并。
 */
export function Has(flags: number, flag: number): boolean {
  return (flags & flag) !== 0;
}

/** Go: type Property struct (js_ast.go:297) */
export class Property {
  ClassStaticBlock: ClassStaticBlock | null = null;
  Key: Expr = new Expr();
  ValueOrNil: Expr | null = null;
  InitializerOrNil: Expr | null = null;
  Decorators: Decorator[] = [];
  Loc: Loc = new Loc(0);
  CloseBracketLoc: Loc = new Loc(0);
  Kind: PropertyKind = PropertyKind.PropertyField;
  Flags: PropertyFlags = 0;
}

/** Go: type PropertyBinding struct (js_ast.go:324) */
export class PropertyBinding {
  Key: Expr = new Expr();
  Value: Binding = new Binding();
  DefaultValueOrNil: Expr | null = null;
  Loc: Loc = new Loc(0);
  CloseBracketLoc: Loc = new Loc(0);
  IsComputed: boolean = false;
  IsSpread: boolean = false;
  PreferQuotedKey: boolean = false;
}

/** Go: type Arg struct (js_ast.go:335) */
export class Arg {
  Binding: Binding = new Binding();
  DefaultOrNil: Expr | null = null;
  Decorators: Decorator[] = [];
  IsTypeScriptCtorField: boolean = false;
}

/** Go: type Fn struct (js_ast.go:344) */
export class Fn {
  Name: LocRef | null = null;
  Args: Arg[] = [];
  Body: FnBody = new FnBody();
  ArgumentsRef: Ref = new Ref(0, 0);
  OpenParenLoc: Loc = new Loc(0);
  IsAsync: boolean = false;
  IsGenerator: boolean = false;
  HasRestArg: boolean = false;
  HasIfScope: boolean = false;
  HasNoSideEffectsComment: boolean = false;
  IsUniqueFormalParameters: boolean = false;
}

/** Go: type FnBody struct (js_ast.go:363) */
export class FnBody {
  Block: SBlock = new SBlock();
  Loc: Loc = new Loc(0);
}

/** Go: type Class struct (js_ast.go:368) */
export class Class {
  Decorators: Decorator[] = [];
  Name: LocRef | null = null;
  /** Go visit-pass innerClassNameRef（class body 自引用捕获的不可变内层类名符号）。
   *  TS 一趟 parser 在 parseClassStmt 里预建并挂在这里，visitClass 直接取用，
   *  否则一趟绑定会让自引用落到外层符号上。InvalidRef 表示未预建。 */
  InnerNameRef: Ref = InvalidRef;
  ExtendsOrNil: Expr | null = null;
  Properties: Property[] = [];
  ClassKeyword: Range = new Range();
  BodyLoc: Loc = new Loc(0);
  CloseBraceLoc: Loc = new Loc(0);
  ShouldLowerStandardDecorators: boolean = false;
  UseDefineForClassFields: boolean = false;
}

/** Go: type ArrayBinding struct (js_ast.go:409) */
export class ArrayBinding {
  Binding: Binding = new Binding();
  DefaultValueOrNil: Expr | null = null;
  Loc: Loc = new Loc(0);
}

/** Go: type Binding struct (js_ast.go:415) */
export class Binding {
  Data: B | null = null;
  Loc: Loc = new Loc(0);
}

/** Go: type B interface{ isBinding() } (js_ast.go:422) */
export class B {
  isBinding(): void {}
}

/** Go: type BMissing struct{} (js_ast.go:429) */
export class BMissing extends B {
  isBinding(): void {}
}

/** Go: type BIdentifier struct{ Ref ast.Ref } (js_ast.go:431) */
export class BIdentifier extends B {
  Ref: Ref;
  constructor(ref: Ref = new Ref(0, 0)) {
    super();
    this.Ref = ref;
  }
  isBinding(): void {}
}

/** Go: type BArray struct (js_ast.go:433) */
export class BArray extends B {
  Items: ArrayBinding[] = [];
  CloseBracketLoc: Loc = new Loc(0);
  HasSpread: boolean = false;
  IsSingleLine: boolean = false;
  isBinding(): void {}
}

/** Go: type BObject struct (js_ast.go:440) */
export class BObject extends B {
  Properties: PropertyBinding[] = [];
  CloseBraceLoc: Loc = new Loc(0);
  IsSingleLine: boolean = false;
  isBinding(): void {}
}

/** Go: type Expr struct (js_ast.go:446) */
export class Expr {
  Data: E | null;
  Loc: Loc;

  constructor(data: E | null = null, loc: Loc = new Loc(0)) {
    this.Data = data;
    this.Loc = loc;
  }
}

/** Go: type E interface{ isExpr() } (js_ast.go:453) */
export class E {
  isExpr(): void {}
}

/** Go: type EArray struct (js_ast.go:496) */
export class EArray extends E {
  Items: Expr[] = [];
  CommaAfterSpread: Loc = new Loc(0);
  CloseBracketLoc: Loc = new Loc(0);
  IsSingleLine: boolean = false;
  IsParenthesized: boolean = false;
  isExpr(): void {}
}

/** Go: type EUnary struct (js_ast.go:504) */
export class EUnary extends E {
  Value: Expr = new Expr();
  Op: OpCode = OpCode.UnOpPos;
  WasOriginallyTypeofIdentifier: boolean = false;
  WasOriginallyDeleteOfIdentifierOrPropertyAccess: boolean = false;
  isExpr(): void {}
}

/** Go: type EBinary struct (js_ast.go:542) */
export class EBinary extends E {
  Left: Expr = new Expr();
  Right: Expr = new Expr();
  Op: OpCode = OpCode.BinOpAdd;
  IsParenthesized: boolean = false;
  isExpr(): void {}
}

/** Go: type EBoolean struct{ Value bool } (js_ast.go:549) */
export class EBoolean extends E {
  Value: boolean;
  constructor(Value: boolean = false) {
    super();
    this.Value = Value;
  }
  isExpr(): void {}
}

/** Go: type EMissing struct{} (js_ast.go:551) */
export class EMissing extends E {
  isExpr(): void {}
}

/** Go: type ESuper struct{} (js_ast.go:553) */
export class ESuper extends E {
  isExpr(): void {}
}

/** Go: type ENull struct{} (js_ast.go:555) */
export class ENull extends E {
  isExpr(): void {}
}

/** Go: type EUndefined struct{} (js_ast.go:557) */
export class EUndefined extends E {
  isExpr(): void {}
}

/** Go: type EThis struct{} (js_ast.go:559) */
export class EThis extends E {
  isExpr(): void {}
}

/** Go: type ENewTarget struct (js_ast.go:561) */
export class ENewTarget extends E {
  Range: Range = new Range();
  isExpr(): void {}
}

/** Go: type EImportMeta struct (js_ast.go:565) */
export class EImportMeta extends E {
  RangeLen: number = 0;
  isExpr(): void {}
}

/** Go: type ENew struct (js_ast.go:581) */
export class ENew extends E {
  Target: Expr = new Expr();
  Args: Expr[] = [];
  CloseParenLoc: Loc = new Loc(0);
  IsMultiLine: boolean = false;
  CanBeUnwrappedIfUnused: boolean = false;
  isExpr(): void {}
}

/** Go: type CallKind uint8 (js_ast.go:593) */
export type CallKind = number;
export const CallKind = {
  NormalCall: 0,
  DirectEval: 1,
  TargetWasOriginallyPropertyAccess: 2,
} as const;

/** Go: type OptionalChain uint8 (js_ast.go:601) */
export type OptionalChain = number;
export const OptionalChain = {
  OptionalChainNone: 0,
  OptionalChainStart: 1,
  OptionalChainContinue: 2,
} as const;

/** Go: type ECall struct (js_ast.go:615) */
export class ECall extends E {
  Target: Expr = new Expr();
  Args: Expr[] = [];
  CloseParenLoc: Loc = new Loc(0);
  OptionalChain: OptionalChain = OptionalChain.OptionalChainNone;
  Kind: CallKind = CallKind.NormalCall;
  IsMultiLine: boolean = false;
  CanBeUnwrappedIfUnused: boolean = false;

  /** Go: func (a *ECall) HasSameFlagsAs(b *ECall) bool (js_ast.go:634) */
  HasSameFlagsAs(b: ECall): boolean {
    return this.OptionalChain === b.OptionalChain &&
      this.Kind === b.Kind &&
      this.CanBeUnwrappedIfUnused === b.CanBeUnwrappedIfUnused;
  }
  isExpr(): void {}
}

/** Go: type EDot struct (js_ast.go:640) */
export class EDot extends E {
  Target: Expr = new Expr();
  Name: string = "";
  NameLoc: Loc = new Loc(0);
  OptionalChain: OptionalChain = OptionalChain.OptionalChainNone;
  CanBeRemovedIfUnused: boolean = false;
  CallCanBeUnwrappedIfUnused: boolean = false;
  IsSymbolInstance: boolean = false;

  /** Go: func (a *EDot) HasSameFlagsAs(b *EDot) bool (js_ast.go:660) */
  HasSameFlagsAs(b: EDot): boolean {
    return this.OptionalChain === b.OptionalChain &&
      this.CanBeRemovedIfUnused === b.CanBeRemovedIfUnused &&
      this.CallCanBeUnwrappedIfUnused === b.CallCanBeUnwrappedIfUnused &&
      this.IsSymbolInstance === b.IsSymbolInstance;
  }
  isExpr(): void {}
}

/** Go: type EIndex struct (js_ast.go:667) */
export class EIndex extends E {
  Target: Expr = new Expr();
  Index: Expr = new Expr();
  CloseBracketLoc: Loc = new Loc(0);
  OptionalChain: OptionalChain = OptionalChain.OptionalChainNone;
  CanBeRemovedIfUnused: boolean = false;
  CallCanBeUnwrappedIfUnused: boolean = false;
  IsSymbolInstance: boolean = false;

  /** Go: func (a *EIndex) HasSameFlagsAs(b *EIndex) bool (js_ast.go:687) */
  HasSameFlagsAs(b: EIndex): boolean {
    return this.OptionalChain === b.OptionalChain &&
      this.CanBeRemovedIfUnused === b.CanBeRemovedIfUnused &&
      this.CallCanBeUnwrappedIfUnused === b.CallCanBeUnwrappedIfUnused &&
      this.IsSymbolInstance === b.IsSymbolInstance;
  }
  isExpr(): void {}
}

/** Go: type EArrow struct (js_ast.go:694) */
export class EArrow extends E {
  Args: Arg[] = [];
  Body: FnBody = new FnBody();
  IsAsync: boolean = false;
  HasRestArg: boolean = false;
  PreferExpr: boolean = false;
  IsParenthesized: boolean = false;
  HasNoSideEffectsComment: boolean = false;
  isExpr(): void {}
}

/** Go: type EFunction struct (js_ast.go:709) */
export class EFunction extends E {
  Fn: Fn = new Fn();
  IsParenthesized: boolean = false;
  isExpr(): void {}
}

/** Go: type EClass struct{ Class Class } (js_ast.go:716) */
export class EClass extends E {
  Class: Class = new Class();
  isExpr(): void {}
}

/** Go: type EIdentifier struct (js_ast.go:718) */
export class EIdentifier extends E {
  Ref: Ref;
  MustKeepDueToWithStmt: boolean = false;
  CanBeRemovedIfUnused: boolean = false;
  CallCanBeUnwrappedIfUnused: boolean = false;
  constructor(ref: Ref = new Ref(0, 0)) {
    super();
    this.Ref = ref;
  }
  isExpr(): void {}
}

/** Go: type EImportIdentifier struct (js_ast.go:757) */
export class EImportIdentifier extends E {
  Ref: Ref;
  PreferQuotedKey: boolean = false;
  WasOriginallyIdentifier: boolean = false;
  constructor(ref: Ref = new Ref(0, 0)) {
    super();
    this.Ref = ref;
  }
  isExpr(): void {}
}

/** Go: type EPrivateIdentifier struct (js_ast.go:770) */
export class EPrivateIdentifier extends E {
  Ref: Ref;
  constructor(ref: Ref = new Ref(0, 0)) {
    super();
    this.Ref = ref;
  }
  isExpr(): void {}
}

/** Go: type ENameOfSymbol struct (js_ast.go:776) */
export class ENameOfSymbol extends E {
  Ref: Ref;
  HasPropertyKeyComment: boolean = false;
  constructor(ref: Ref = new Ref(0, 0)) {
    super();
    this.Ref = ref;
  }
  isExpr(): void {}
}

/** Go: type EJSXElement struct (js_ast.go:785) */
export class EJSXElement extends E {
  TagOrNil: Expr | null = null;
  Properties: Property[] = [];
  NullableChildren: Expr[] = [];
  CloseLoc: Loc = new Loc(0);
  IsTagSingleLine: boolean = false;
  isExpr(): void {}
}

/** Go: type EJSXText struct (js_ast.go:820) */
export class EJSXText extends E {
  // DEVIATION: Go 的 Raw 是 string（UTF-8 字节串）；TS 用 Uint8Array 保留原始字节
  // （preserve 模式下要逐字节回写源码）。
  Raw: Uint8Array = new Uint8Array(0);
  isExpr(): void {}
}

/** Go: type ENumber struct{ Value float64 } (js_ast.go:824) */
export class ENumber extends E {
  Value: number;
  constructor(Value: number = 0) {
    super();
    this.Value = Value;
  }
  isExpr(): void {}
}

/** Go: type EBigInt struct{ Value string } (js_ast.go:826) */
export class EBigInt extends E {
  Value: string;
  constructor(Value: string = "") {
    super();
    this.Value = Value;
  }
  isExpr(): void {}
}

/** Go: type EObject struct (js_ast.go:828) */
export class EObject extends E {
  Properties: Property[] = [];
  CommaAfterSpread: Loc = new Loc(0);
  CloseBraceLoc: Loc = new Loc(0);
  IsSingleLine: boolean = false;
  IsParenthesized: boolean = false;
  isExpr(): void {}
}

/** Go: type ESpread struct{ Value Expr } (js_ast.go:836) */
export class ESpread extends E {
  Value: Expr = new Expr();
  isExpr(): void {}
}

/** Go: type EString struct (js_ast.go:841) */
export class EString extends E {
  Value: Uint16Array = new Uint16Array(0);
  LegacyOctalLoc: Loc = new Loc(0);
  PreferTemplate: boolean = false;
  HasPropertyKeyComment: boolean = false;
  ContainsUniqueKey: boolean = false;

  constructor(Value: Uint16Array = new Uint16Array(0)) {
    super();
    this.Value = Value;
  }
  isExpr(): void {}
}

/** Go: type TemplatePart struct (js_ast.go:849) */
export class TemplatePart {
  Value: Expr = new Expr();
  // DEVIATION: Go 的 TailRaw 是 string（UTF-8 字节串）；TS 用 Uint8Array 保留原始字节。
  TailRaw: Uint8Array = new Uint8Array(0); // Only use when "TagOrNil" is not nil
  TailCooked: Uint16Array | null = null; // Only use when "TagOrNil" is nil
  TailLoc: Loc = new Loc(0);
}

/** Go: type ETemplate struct (js_ast.go:856) */
export class ETemplate extends E {
  TagOrNil: Expr | null = null;
  // DEVIATION: Go 的 HeadRaw 是 string；TS 用 Uint8Array（同 EJSXText.Raw）。
  HeadRaw: Uint8Array = new Uint8Array(0); // Only use when "TagOrNil" is not nil
  HeadCooked: Uint16Array | null = null; // Only use when "TagOrNil" is nil
  Parts: TemplatePart[] = [];
  HeadLoc: Loc = new Loc(0);
  LegacyOctalLoc: Loc = new Loc(0);
  CanBeUnwrappedIfUnused: boolean = false;
  TagWasOriginallyPropertyAccess: boolean = false;
  isExpr(): void {}
}

/** Go: type ERegExp struct{ Value string } (js_ast.go:900) */
export class ERegExp extends E {
  Value: string;
  constructor(Value: string = "") {
    super();
    this.Value = Value;
  }
  isExpr(): void {}
}

/** Go: type EInlinedEnum struct (js_ast.go:902) */
export class EInlinedEnum extends E {
  Value: Expr = new Expr();
  Comment: string = "";
  isExpr(): void {}
}

/** Go: type AnnotationFlags uint8 (js_ast.go:1186) */
export type AnnotationFlags = number;
export const AnnotationFlags = {
  CanBeRemovedIfUnusedFlag: 1 << 0,
} as const;

/** Go: type EAnnotation struct (js_ast.go:1205) */
export class EAnnotation extends E {
  Value: Expr = new Expr();
  Flags: AnnotationFlags = 0;
  isExpr(): void {}
}

/** Go: type EAwait struct (js_ast.go:1210) */
export class EAwait extends E {
  Value: Expr = new Expr();
  isExpr(): void {}
}

/** Go: type EYield struct (js_ast.go:1214) */
export class EYield extends E {
  ValueOrNil: Expr | null = null;
  IsStar: boolean = false;
  isExpr(): void {}
}

/** Go: type EIf struct (js_ast.go:1219) */
export class EIf extends E {
  Test: Expr = new Expr();
  Yes: Expr = new Expr();
  No: Expr = new Expr();
  isExpr(): void {}
}

/** Go: type ERequireString struct (js_ast.go:1225) */
export class ERequireString extends E {
  ImportRecordIndex: number = 0;
  CloseParenLoc: Loc = new Loc(0);
  isExpr(): void {}
}

/** Go: type ERequireResolveString struct (js_ast.go:1230) */
export class ERequireResolveString extends E {
  ImportRecordIndex: number = 0;
  CloseParenLoc: Loc = new Loc(0);
  isExpr(): void {}
}

/** Go: type EImportString struct (js_ast.go:1235) */
export class EImportString extends E {
  ImportRecordIndex: number = 0;
  CloseParenLoc: Loc = new Loc(0);
  isExpr(): void {}
}

/** Go: type EImportCall struct (js_ast.go:1240) */
export class EImportCall extends E {
  Expr: Expr = new Expr();
  OptionsOrNil: Expr | null = null;
  CloseParenLoc: Loc = new Loc(0);
  Phase: ImportPhase = 0;
  isExpr(): void {}
}

// ---------------------------------------------------------------------------
// 语句
// ---------------------------------------------------------------------------

/** Go: type Stmt struct (js_ast.go:1248) */
export class Stmt {
  Data: S | null;
  Loc: Loc;

  constructor(data: S | null = null, loc: Loc = new Loc(0)) {
    this.Data = data;
    this.Loc = loc;
  }
}

/** Go: type S interface{ isStmt() } (js_ast.go:1255) */
export class S {
  isStmt(): void {}
}

/** Go: type SBlock struct (js_ast.go:1292) */
export class SBlock extends S {
  Stmts: Stmt[] = [];
  CloseBraceLoc: Loc = new Loc(0);
  isStmt(): void {}
}

/** Go: type SEmpty struct{} (js_ast.go:1297) */
export class SEmpty extends S {
  isStmt(): void {}
}

/** Go: type STypeScript struct (js_ast.go:1300) */
export class STypeScript extends S {
  WasDeclareClass: boolean = false;
  isStmt(): void {}
}

/** Go: type SComment struct (js_ast.go:1305) */
export class SComment extends S {
  Text: string = "";
  IsLegalComment: boolean = false;
  isStmt(): void {}
}

/** Go: type SDebugger struct{} (js_ast.go:1310) */
export class SDebugger extends S {
  isStmt(): void {}
}

/** Go: type SDirective struct (js_ast.go:1312) */
export class SDirective extends S {
  Value: Uint16Array = new Uint16Array(0);
  LegacyOctalLoc: Loc = new Loc(0);
  isStmt(): void {}
}

/** Go: type SExportClause struct (js_ast.go:1317) */
export class SExportClause extends S {
  Items: ClauseItem[] = [];
  IsSingleLine: boolean = false;
  isStmt(): void {}
}

/** Go: type SExportFrom struct (js_ast.go:1322) */
export class SExportFrom extends S {
  Items: ClauseItem[] = [];
  NamespaceRef: Ref = new Ref(0, 0);
  ImportRecordIndex: number = 0;
  IsSingleLine: boolean = false;
  isStmt(): void {}
}

/** Go: type SExportDefault struct (js_ast.go:1329) */
export class SExportDefault extends S {
  Value: Stmt = new Stmt(); // May be a SExpr or SFunction or SClass
  DefaultName: LocRef = new LocRef();
  isStmt(): void {}
}

/** Go: type ExportStarAlias struct (js_ast.go:1335) */
export class ExportStarAlias {
  OriginalName: string = "";
  Loc: Loc = new Loc(0);
}

/** Go: type SExportStar struct (js_ast.go:1344) */
export class SExportStar extends S {
  Alias: ExportStarAlias | null = null;
  NamespaceRef: Ref = new Ref(0, 0);
  ImportRecordIndex: number = 0;
  isStmt(): void {}
}

/** Go: type SExportEquals struct (js_ast.go:1352) */
export class SExportEquals extends S {
  Value: Expr = new Expr();
  isStmt(): void {}
}

/** Go: type SLazyExport struct (js_ast.go:1359) */
export class SLazyExport extends S {
  Value: Expr = new Expr();
  isStmt(): void {}
}

/** Go: type SExpr struct (js_ast.go:1363) */
export class SExpr extends S {
  Value: Expr = new Expr();
  IsFromClassOrFnThatCanBeRemovedIfUnused: boolean = false;
  isStmt(): void {}
}

/** Go: type EnumValue struct (js_ast.go:1373) */
export class EnumValue {
  ValueOrNil: Expr | null = null;
  Name: Uint16Array = new Uint16Array(0);
  Ref: Ref = new Ref(0, 0);
  Loc: Loc = new Loc(0);
}

/** Go: type SEnum struct (js_ast.go:1380) */
export class SEnum extends S {
  Values: EnumValue[] = [];
  Name: LocRef = new LocRef();
  Arg: Ref = new Ref(0, 0);
  IsExport: boolean = false;
  isStmt(): void {}
}

/** Go: type SNamespace struct (js_ast.go:1388) */
export class SNamespace extends S {
  Stmts: Stmt[] = [];
  Name: LocRef = new LocRef();
  Arg: Ref = new Ref(0, 0);
  IsExport: boolean = false;
  isStmt(): void {}
}

/** Go: type SFunction struct (js_ast.go:1396) */
export class SFunction extends S {
  Fn: Fn = new Fn();
  IsExport: boolean = false;
  isStmt(): void {}
}

/** Go: type SClass struct (js_ast.go:1401) */
export class SClass extends S {
  Class: Class = new Class();
  IsExport: boolean = false;
  isStmt(): void {}
}

/** Go: type SLabel struct (js_ast.go:1406) */
export class SLabel extends S {
  Stmt: Stmt = new Stmt();
  Name: LocRef = new LocRef();
  IsSingleLineStmt: boolean = false;
  isStmt(): void {}
}

/** Go: type SIf struct (js_ast.go:1413) */
export class SIf extends S {
  Test: Expr = new Expr();
  Yes: Stmt = new Stmt();
  NoOrNil: Stmt | null = null;
  IsSingleLineYes: boolean = false;
  IsSingleLineNo: boolean = false;
  isStmt(): void {}
}

/** Go: type SFor struct (js_ast.go:1421) */
export class SFor extends S {
  InitOrNil: Stmt | null = null; // May be a SLocal or SExpr
  TestOrNil: Expr | null = null;
  UpdateOrNil: Expr | null = null;
  Body: Stmt = new Stmt();
  IsSingleLineBody: boolean = false;
  IsLoweredForAwait: boolean = false;
  isStmt(): void {}
}

/** Go: type SForIn struct (js_ast.go:1431) */
export class SForIn extends S {
  Init: Stmt = new Stmt(); // May be a SLocal or SExpr
  Value: Expr = new Expr();
  Body: Stmt = new Stmt();
  IsSingleLineBody: boolean = false;
  isStmt(): void {}
}

/** Go: type SForOf struct (js_ast.go:1439) */
export class SForOf extends S {
  Init: Stmt = new Stmt(); // May be a SLocal or SExpr
  Value: Expr = new Expr();
  Body: Stmt = new Stmt();
  Await: Range = new Range();
  IsSingleLineBody: boolean = false;
  isStmt(): void {}
}

/** Go: type SDoWhile struct (js_ast.go:1448) */
export class SDoWhile extends S {
  Body: Stmt = new Stmt();
  Test: Expr = new Expr();
  isStmt(): void {}
}

/** Go: type SWhile struct (js_ast.go:1453) */
export class SWhile extends S {
  Test: Expr = new Expr();
  Body: Stmt = new Stmt();
  IsSingleLineBody: boolean = false;
  isStmt(): void {}
}

/** Go: type SWith struct (js_ast.go:1459) */
export class SWith extends S {
  Value: Expr = new Expr();
  Body: Stmt = new Stmt();
  BodyLoc: Loc = new Loc(0);
  IsSingleLineBody: boolean = false;
  isStmt(): void {}
}

/** Go: type Catch struct (js_ast.go:1467) */
export class Catch {
  BindingOrNil: Binding | null = null;
  Block: SBlock = new SBlock();
  Loc: Loc = new Loc(0);
  BlockLoc: Loc = new Loc(0);
}

/** Go: type Finally struct (js_ast.go:1474) */
export class Finally {
  Block: SBlock = new SBlock();
  Loc: Loc = new Loc(0);
}

/** Go: type STry struct (js_ast.go:1479) */
export class STry extends S {
  Catch: Catch | null = null;
  Finally: Finally | null = null;
  Block: SBlock = new SBlock();
  BlockLoc: Loc = new Loc(0);
  isStmt(): void {}
}

/** Go: type Case struct (js_ast.go:1486) */
export class Case {
  ValueOrNil: Expr | null = null; // If nil, this is "default" instead of "case"
  Body: Stmt[] = [];
  Loc: Loc = new Loc(0);
}

/** Go: type SSwitch struct (js_ast.go:1493) */
export class SSwitch extends S {
  Test: Expr = new Expr();
  Cases: Case[] = [];
  BodyLoc: Loc = new Loc(0);
  CloseBraceLoc: Loc = new Loc(0);
  isStmt(): void {}
}

/** Go: type SImport struct (js_ast.go:1524) */
export class SImport extends S {
  DefaultName: LocRef | null = null;
  Items: ClauseItem[] | null = null;
  StarNameLoc: Loc | null = null;
  NamespaceRef: Ref = new Ref(0, 0);
  ImportRecordIndex: number = 0;
  IsSingleLine: boolean = false;
  isStmt(): void {}
}

/** Go: type SReturn struct (js_ast.go:1537) */
export class SReturn extends S {
  ValueOrNil: Expr | null = null;
  isStmt(): void {}
}

/** Go: type SThrow struct (js_ast.go:1541) */
export class SThrow extends S {
  Value: Expr = new Expr();
  isStmt(): void {}
}

/** Go: type LocalKind uint8 (js_ast.go:1545) */
export type LocalKind = number;
export const LocalKind = {
  LocalVar: 0,
  LocalLet: 1,
  LocalConst: 2,
  LocalUsing: 3,
  LocalAwaitUsing: 4,
} as const;

/** Go: func (kind LocalKind) IsUsing() bool (js_ast.go:1553) */
export function IsUsing(kind: LocalKind): boolean {
  return kind >= LocalKind.LocalUsing;
}

/** Go: type SLocal struct (js_ast.go:1556) */
export class SLocal extends S {
  Decls: Decl[] = [];
  Kind: LocalKind = LocalKind.LocalVar;
  IsExport: boolean = false;
  WasTSImportEquals: boolean = false;
  isStmt(): void {}
}

/** Go: type SBreak struct (js_ast.go:1571) */
export class SBreak extends S {
  Label: LocRef | null = null;
  isStmt(): void {}
}

/** Go: type SContinue struct (js_ast.go:1575) */
export class SContinue extends S {
  Label: LocRef | null = null;
  isStmt(): void {}
}

/** Go: type ClauseItem struct (js_ast.go:1579) */
export class ClauseItem {
  Alias: string = "";
  OriginalName: string = "";
  AliasLoc: Loc = new Loc(0);
  Name: LocRef = new LocRef();
}

/** Go: type Decl struct (js_ast.go:1597) */
export class Decl {
  Binding: Binding = new Binding();
  ValueOrNil: Expr | null = null;
}

/** Go: type ScopeKind uint8 (js_ast.go:1602) */
export type ScopeKind = number;
export const ScopeKind = {
  ScopeBlock: 0,
  ScopeWith: 1,
  ScopeLabel: 2,
  ScopeClassName: 3,
  ScopeClassBody: 4,
  ScopeCatchBinding: 5,

  // The scopes below stop hoisted variables from extending into parent scopes
  ScopeEntry: 6, // This is a module, TypeScript enum, or TypeScript namespace
  ScopeFunctionArgs: 7,
  ScopeFunctionBody: 8,
  ScopeClassStaticInit: 9,
} as const;

/** Go: func (kind ScopeKind) StopsHoisting() bool (js_ast.go:1625) */
export function StopsHoisting(kind: ScopeKind): boolean {
  return kind >= ScopeKind.ScopeEntry;
}

/** Go: type ScopeMember struct (js_ast.go:1629) */
export class ScopeMember {
  Ref: Ref = new Ref(0, 0);
  Loc: Loc = new Loc(0);
}

/** Go: type StrictModeKind uint8 (js_ast.go:1667) */
export type StrictModeKind = number;
export const StrictModeKind = {
  SloppyMode: 0,
  ExplicitStrictMode: 1,
  ImplicitStrictModeClass: 2,
  ImplicitStrictModeESM: 3,
  ImplicitStrictModeTSAlwaysStrict: 4,
  ImplicitStrictModeJSXAutomaticRuntime: 5,
} as const;

/** Go: type Scope struct (js_ast.go:1634) */
export class Scope {
  TSNamespace: TSNamespaceScope | null = null;
  Parent: Scope | null = null;
  Children: Scope[] = [];
  Members: Map<string, ScopeMember> = new Map();
  Replaced: ScopeMember[] = [];
  Generated: Ref[] = [];
  UseStrictLoc: Loc = new Loc(0);
  Label: LocRef = new LocRef();
  LabelStmtIsLoop: boolean = false;
  ContainsDirectEval: boolean = false;
  ForbidArguments: boolean = false;
  IsAfterConstLocalPrefix: boolean = false;
  StrictMode: StrictModeKind = StrictModeKind.SloppyMode;
  Kind: ScopeKind = ScopeKind.ScopeBlock;

  /** Go: func (s *Scope) RecursiveSetStrictMode(kind StrictModeKind) (js_ast.go:1685) */
  RecursiveSetStrictMode(kind: StrictModeKind): void {
    if (this.StrictMode === StrictModeKind.SloppyMode) {
      this.StrictMode = kind;
      for (const child of this.Children) child.RecursiveSetStrictMode(kind);
    }
  }
}

/** Go: type TSNamespaceScope struct (js_ast.go:1730) */
export class TSNamespaceScope {
  ExportedMembers: TSNamespaceMembers = new Map();
  LazilyGeneratedProperyAccesses: Map<string, Ref> = new Map();
  ArgRef: Ref = new Ref(0, 0);
  IsEnumScope: boolean = false;
}

/** Go: type TSNamespaceMembers map[string]TSNamespaceMember (js_ast.go:1783) */
export type TSNamespaceMembers = Map<string, TSNamespaceMember>;

/** Go: type TSNamespaceMember struct (js_ast.go:1785) */
export class TSNamespaceMember {
  Data: TSNamespaceMemberData | null = null;
  Loc: Loc = new Loc(0);
  IsEnumValue: boolean = false;
}

/** Go: type TSNamespaceMemberData interface (js_ast.go:1791) */
export class TSNamespaceMemberData {
  isTSNamespaceMember(): void {}
}

/** Go: type TSNamespaceMemberProperty struct{} (js_ast.go:1800) */
export class TSNamespaceMemberProperty extends TSNamespaceMemberData {
  isTSNamespaceMember(): void {}
}

/** Go: type TSNamespaceMemberNamespace struct (js_ast.go:1803) */
export class TSNamespaceMemberNamespace extends TSNamespaceMemberData {
  ExportedMembers: TSNamespaceMembers = new Map();
  isTSNamespaceMember(): void {}
}

/** Go: type TSNamespaceMemberEnumNumber struct (js_ast.go:1808) */
export class TSNamespaceMemberEnumNumber extends TSNamespaceMemberData {
  Value: number = 0;
  isTSNamespaceMember(): void {}
}

/** Go: type TSNamespaceMemberEnumString struct (js_ast.go:1813) */
export class TSNamespaceMemberEnumString extends TSNamespaceMemberData {
  Value: Uint16Array = new Uint16Array(0);
  isTSNamespaceMember(): void {}
}

// ---------------------------------------------------------------------------
// 模块 / 文件级
// ---------------------------------------------------------------------------

/** Go: type ExportsKind uint8 (js_ast.go:1817) */
export type ExportsKind = number;
export const ExportsKind = {
  ExportsNone: 0,
  ExportsCommonJS: 1,
  ExportsESM: 2,
  ExportsESMWithDynamicFallback: 3,
} as const;

/** Go: func (kind ExportsKind) IsDynamic() bool (js_ast.go:1836) */
export function IsDynamic(kind: ExportsKind): boolean {
  return kind === ExportsKind.ExportsCommonJS || kind === ExportsKind.ExportsESMWithDynamicFallback;
}

/** Go: type ModuleType uint8 (js_ast.go:1840) */
export type ModuleType = number;
export const ModuleType = {
  ModuleUnknown: 0,
  ModuleCommonJS_CJS: 1,
  ModuleCommonJS_CTS: 2,
  ModuleCommonJS_PackageJSON: 3,
  ModuleESM_MJS: 4,
  ModuleESM_MTS: 5,
  ModuleESM_PackageJSON: 6,
} as const;

/** Go: func (mt ModuleType) IsCommonJS() bool (js_ast.go:1856) */
export function IsCommonJS(mt: ModuleType): boolean {
  return mt >= ModuleType.ModuleCommonJS_CJS && mt <= ModuleType.ModuleCommonJS_PackageJSON;
}

/** Go: func (mt ModuleType) IsESM() bool (js_ast.go:1860) */
export function IsESM(mt: ModuleType): boolean {
  return mt >= ModuleType.ModuleESM_MJS && mt <= ModuleType.ModuleESM_PackageJSON;
}

/** Go: type ModuleTypeData struct (js_ast.go:1517) */
export class ModuleTypeData {
  Source: unknown = null; // *logger.Source
  Range: Range = new Range();
  Type: ModuleType = ModuleType.ModuleUnknown;
}

/** Go: const NSExportPartIndex = uint32(0) (js_ast.go:1525) */
export const NSExportPartIndex = 0;

/**
 * Go: type ImportRecord struct (ast.go:164)
 *
 * 字段类型子集：`AssertOrWith` / `GlobPattern` 依赖尚未移植的 `ImportAssertOrWith` /
 * `GlobPattern`（M2/M3），先以 `unknown | null` 占位并在这里登记；其余字段与 Go 一致。
 * `ImportKind` / `ImportRecordFlags` 是 ast 包的 uint8/uint16 常量集，M2 补。
 */
export class ImportRecord {
  AssertOrWith: ImportAssertOrWith | null = null;
  GlobPattern: unknown | null = null;
  Path: Path = new Path();
  Range: Range = new Range();
  ErrorHandlerLoc: Loc = new Loc(0);
  SourceIndex: number = 0;
  CopySourceIndex: number = 0;
  Flags: number = 0;
  Phase: ImportPhase = 0;
  Kind: number = 0;
}

/** Go: type AST struct (js_ast.go:1528) */
export class AST {
  ModuleTypeData: ModuleTypeData = new ModuleTypeData();
  Parts: Part[] = [];
  Symbols: Symbol[] = [];
  ExprComments: Map<number, string[]> = new Map();
  ModuleScope: Scope | null = null;
  CharFreq: CharFreq | null = null;
  ManifestForYarnPnP: Expr | null = null;
  Hashbang: string = "";
  Directives: string[] = [];
  URLForCSS: string = "";
  TopLevelSymbolToPartsFromParser: Map<string, number[]> = new Map();
  TSEnums: Map<string, Map<string, TSEnumValue>> = new Map();
  ConstValues: Map<string, ConstValue> = new Map();
  MangledProps: Map<string, Ref> = new Map();
  ReservedProps: Set<string> = new Set();
  // TODO(M1-c): ast.ImportRecord 结构体尚未移植（PLAN.md「M1-c ... 结构体 ImportRecord 等 4 个待补」），
  // 这里只声明字段，等 ast 包补齐后再收紧类型；本轮 parser 骨架不解析 import/export。
  ImportRecords: ImportRecord[] = [];
  NamedImports: Map<string, NamedImport> = new Map();
  NamedExports: Map<string, NamedExport> = new Map();
  ExportStarImportRecords: number[] = [];
  SourceMapComment: Span = new Span();
  ExportKeyword: Range = new Range();
  TopLevelAwaitKeyword: Range = new Range();
  LiveTopLevelAwaitKeyword: Range = new Range();
  ExportsRef: Ref = new Ref(0, 0);
  ModuleRef: Ref = new Ref(0, 0);
  WrapperRef: Ref = new Ref(0, 0);
  ApproximateLineCount: number = 0;
  NestedScopeSlotCounts: SlotCounts = new SlotCounts();
  HasLazyExport: boolean = false;
  UsesExportsRef: boolean = false;
  UsesModuleRef: boolean = false;
  ExportsKind: ExportsKind = ExportsKind.ExportsNone;
}

/** Go: type TSEnumValue struct (js_ast.go:1594) */
export class TSEnumValue {
  String: Uint16Array | null = null; // Use this if it's not nil
  Number: number = 0; // Use this if "String" is nil
}

/** Go: type ConstValueKind uint8 (js_ast.go:1599) */
export type ConstValueKind = number;
export const ConstValueKind = {
  ConstValueNone: 0,
  ConstValueNull: 1,
  ConstValueUndefined: 2,
  ConstValueTrue: 3,
  ConstValueFalse: 4,
  ConstValueNumber: 5,
  ConstValueString: 6,
} as const;

/** Go: type ConstValue struct (js_ast.go:1608) */
export class ConstValue {
  Number: number = 0; // Use this for "ConstValueNumber"
  String: Uint16Array | null = null; // Use this for "ConstValueString"
  Kind: ConstValueKind = ConstValueKind.ConstValueNone;
}

/**
 * Go: strconv.FormatFloat(v, 'g', -1, 64) 的最短十进制表示（仅用于长度判定）。
 *
 * Go 与 JS 都生成「最短往返」十进制数字串，数字序列一致；差异只在格式：
 *   - Go 'g' 用 e 形式的阈值是 exp < -4 || exp >= 6（shortest 路径固定 prec=6，
 *     见 Go internal/strconv/ftoa.go fmtEFG「if shortest { eprec = 6 }」），
 *     而 JS Number#toString 的阈值是 exp < -6 || exp >= 21；
 *   - Go 指数至少两位（`1e+06`），JS 是一位（`1e+6`）。
 * JS `toExponential()` 给出与 Go 相同的最短数字序列和十进制指数，按 Go 规则重排即可。
 * 已用 Go 探针 5011 例（含 4000 随机 double + 边界）逐字节验证 goFormatFloatG 长度与 Go 一致。
 */
function goFormatFloatG(v: number): string {
  if (v === 0) return Object.is(v, -0) ? "-0" : "0";
  const neg = v < 0;
  const [mant, es] = Math.abs(v).toExponential().split("e"); // "d.dddde+N" 最短数字
  const exp = parseInt(es, 10);
  const digits = mant.replace(".", ""); // 最短有效数字序列（无前导/尾随 0）
  const nd = digits.length;
  let out: string;
  if (exp < -4 || exp >= 6) {
    out = digits[0];
    if (nd > 1) out += "." + digits.slice(1);
    out += "e" + (exp < 0 ? "-" : "+");
    const ae = String(Math.abs(exp));
    out += ae.length < 2 ? "0" + ae : ae;
  } else {
    const dp = exp + 1;
    if (dp <= 0) out = "0." + "0".repeat(-dp) + digits;
    else if (dp >= nd) out = digits + "0".repeat(dp - nd);
    else out = digits.slice(0, dp) + "." + digits.slice(dp);
  }
  return (neg ? "-" : "") + out;
}

/** Go: func ExprToConstValue(expr Expr) ConstValue (js_ast.go:1650) */
export function ExprToConstValue(expr: Expr): ConstValue {
  const v = expr.Data;
  if (v instanceof ENull) return init(new ConstValue(), { Kind: ConstValueKind.ConstValueNull });
  if (v instanceof EUndefined) return init(new ConstValue(), { Kind: ConstValueKind.ConstValueUndefined });
  if (v instanceof EBoolean) {
    return init(new ConstValue(), { Kind: v.Value ? ConstValueKind.ConstValueTrue : ConstValueKind.ConstValueFalse });
  }
  if (v instanceof ENumber) {
    // Inline integers and other small numbers. Don't inline large real numbers because
    // people may not want them inlined as it will increase the minified code size by too much.
    // Go: `asInt := int64(v.Value); v.Value == float64(asInt)`。int64 越界时 Go 会回绕，
    // 故 float64(int64(v)) != v；JS 的 Math.trunc 对超大整数仍返回自身，必须显式加 int64 区间。
    const asInt = v.Value === Math.trunc(v.Value) && v.Value >= -9223372036854775808 && v.Value < 9223372036854775808;
    if (asInt || goFormatFloatG(v.Value).length <= 8) {
      return init(new ConstValue(), { Kind: ConstValueKind.ConstValueNumber, Number: v.Value });
    }
  }
  if (v instanceof EString) {
    // Deliberately only inline small strings.
    if (v.Value.length <= 3) return init(new ConstValue(), { Kind: ConstValueKind.ConstValueString, String: v.Value });
  }
  // EBigInt 等：不内联。
  return new ConstValue();
}

/** Go: func ConstValueToExpr(loc logger.Loc, value ConstValue) Expr (js_ast.go:1688) */
export function ConstValueToExpr(loc: Loc, value: ConstValue): Expr {
  switch (value.Kind) {
    case ConstValueKind.ConstValueNull: return new Expr(ENullShared, loc);
    case ConstValueKind.ConstValueUndefined: return new Expr(EUndefinedShared, loc);
    case ConstValueKind.ConstValueTrue: return new Expr(new EBoolean(true), loc);
    case ConstValueKind.ConstValueFalse: return new Expr(new EBoolean(false), loc);
    case ConstValueKind.ConstValueNumber: return new Expr(new ENumber(value.Number), loc);
    case ConstValueKind.ConstValueString: return new Expr(new EString(value.String ?? new Uint16Array(0)), loc);
  }
  throw new Error("Internal error: invalid constant value");
}

/** Go: type NamedImport struct (js_ast.go:1692) */
export class NamedImport {
  Alias: string = "";
  LocalPartsWithUses: number[] = [];
  AliasLoc: Loc = new Loc(0);
  NamespaceRef: Ref = new Ref(0, 0);
  ImportRecordIndex: number = 0;
  AliasIsStar: boolean = false;
  IsExported: boolean = false;
}

/** Go: type NamedExport struct (js_ast.go:1716) */
export class NamedExport {
  Ref: Ref = new Ref(0, 0);
  AliasLoc: Loc = new Loc(0);
}

/** Go: type Part struct (js_ast.go:1729) */
export class Part {
  Stmts: Stmt[] = [];
  Scopes: Scope[] = [];
  ImportRecordIndices: number[] = [];
  DeclaredSymbols: DeclaredSymbol[] = [];
  SymbolUses: Map<string, SymbolUse> = new Map();
  SymbolCallUses: Map<string, SymbolCallUse> = new Map();
  ImportSymbolPropertyUses: Map<string, Map<string, SymbolUse>> = new Map();
  Dependencies: Dependency[] = [];
  CanBeRemovedIfUnused: boolean = false;
  ForceTreeShaking: boolean = false;
  IsLive: boolean = false;
}

/** Go: type Dependency struct (js_ast.go:1770) */
export class Dependency {
  SourceIndex: number = 0;
  PartIndex: number = 0;
}

/** Go: type DeclaredSymbol struct (js_ast.go:1775) */
export class DeclaredSymbol {
  Ref: Ref = new Ref(0, 0);
  IsTopLevel: boolean = false;
}

/** Go: type SymbolUse struct (js_ast.go:1780) */
export class SymbolUse {
  CountEstimate: number = 0;
}

/** Go: type SymbolCallUse struct (js_ast.go:1784) */
export class SymbolCallUse {
  CallCountEstimate: number = 0;
  SingleArgNonSpreadCallCountEstimate: number = 0;
}

// ---------------------------------------------------------------------------
// 共享实例（Go: js_ast.go:570-579）
// ---------------------------------------------------------------------------

export const BMissingShared = new BMissing();
export const EMissingShared = new EMissing();
export const ENullShared = new ENull();
export const ESuperShared = new ESuper();
export const EThisShared = new EThis();
export const EUndefinedShared = new EUndefined();
export const SDebuggerShared = new SDebugger();
export const SEmptyShared = new SEmpty();
export const STypeScriptShared = new STypeScript();
export const STypeScriptSharedWasDeclareClass = init(new STypeScript(), { WasDeclareClass: true });

/** Go: func EnsureValidIdentifier(base string) string (js_ast.go:1845) */
export function EnsureValidIdentifier(base: string): string {
  const bytes: number[] = [];
  let needsGap = false;
  for (const ch of base) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) ||
      (bytes.length > 0 && c >= 0x30 && c <= 0x39)) {
      if (needsGap) {
        bytes.push(0x5f); // '_'
        needsGap = false;
      }
      bytes.push(c & 0xff);
    } else if (bytes.length > 0) {
      needsGap = true;
    }
  }

  // Make sure the name isn't empty
  if (bytes.length === 0) return "_";
  return String.fromCharCode(...bytes);
}

/**
 * Go: func GenerateNonUniqueNameFromPath(path string) string (js_ast.go:1834)
 *
 * 逐行按 Go 移植（第 16 次推进）：先剥扩展名取 base；base 为 "index" 时改用目录名；
 * 最后 EnsureValidIdentifier 转成 ASCII 标识符。给 SImport/SExportStar 的命名空间起名用。
 */
export function GenerateNonUniqueNameFromPath(path: string): string {
  // Get the file name without the extension
  const { dir, base: originalBase } = PlatformIndependentPathDirBaseExt(path);
  let base = originalBase;

  // If the name is "index", use the directory name instead. This is because
  // many packages in npm use the file name "index.js" because it triggers
  // node's implicit module resolution rules that allows you to import it by
  // just naming the directory.
  if (base === "index") {
    const { base: dirBase } = PlatformIndependentPathDirBaseExt(dir);
    if (dirBase !== "") {
      base = dirBase;
    }
  }

  return EnsureValidIdentifier(base);
}
