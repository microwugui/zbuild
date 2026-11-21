// 1:1 移植自 esbuild internal/js_parser/js_parser_lower_class.go（v0.28.2，commit f6058f83）
//
// 为什么单独一个文件（第 27 轮记账修复）：`tools/progress.ts` 按 Go 文件映射 TS 文件
// （`js_parser_lower_class.go` → `js_parser_lower_class.ts`）。第 26 轮这两个函数写在
// `js_parser.ts` 里，导致「已落地但 progress 计 0」，M1 收口会出现无法闭合的差额。
// 现在按 Go 的文件边界拆出来。
//
// DEVIATION（receiver）：Go 是 `*parser` 的方法，TS 改为「首参 p: parser」的自由函数；
// 调用点写作 `computeClassLoweringInfo(p, class)`。行为与 Go 逐行对应。

import * as ast from "../ast/ast.ts";
import { InvalidRef, LocRef, Ref, SymbolKind } from "../ast/ast.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import * as js_ast_helpers from "../js_ast/js_ast_helpers.ts";
import { Assign, AssignStmt, JoinAllWithComma, JoinWithComma } from "../js_ast/js_ast_helpers.ts";
import { Has as HasFeature, JSFeature } from "../compat/compat.ts";
import { StringToUTF16, UTF16EqualsString, UTF16ToString } from "../helpers/utf.ts";
import { Loc } from "../logger/logger.ts";
import { generateTempRefArg, stmtsKind, parser } from "./js_parser.ts";

/** Go: type classLoweringInfo struct (js_parser_lower_class.go:380) */
export class classLoweringInfo {
  lowerAllInstanceFields: boolean = false;
  lowerAllStaticFields: boolean = false;
  shimSuperCtorCalls: boolean = false;
}

/** Go: func (p *parser) privateSymbolNeedsToBeLowered(private *js_ast.EPrivateIdentifier) bool (js_parser_lower_class.go:14) */
export function privateSymbolNeedsToBeLowered(p: parser, privateIdent: js_ast.EPrivateIdentifier): boolean {
  const symbol = p.symbols[privateIdent.Ref.InnerIndex];
  // Go: p.options.unsupportedJSFeatures.Has(compat.SymbolFeature(symbol.Kind))
  // 第 34 轮 J-1：es2015 档私有字段按 SymbolKind 判 unsupportedJSFeatures。
  if (p.symbolNeedsLoweringForTarget(symbol.Kind)) return true;
  return (symbol.Flags & ast.SymbolFlags.PrivateSymbolMustBeLowered) !== 0;
}

// ---------------------------------------------------------------------------
// 第 34 轮 J-1：private / super lowering（js_parser_lower_class.go:14-379）
// ---------------------------------------------------------------------------

/** 构造一个 Expr（Go 结构体字面量 `js_ast.Expr{Loc: ..., Data: ...}`） */
function mk(data: js_ast.E | null, loc: Loc): js_ast.Expr {
  return new js_ast.Expr(data, loc);
}

/** Go: helpers.StringToUTF16(string) → Uint16Array */
function utf16Of(s: string): Uint16Array {
  return new Uint16Array(StringToUTF16(new TextEncoder().encode(s)));
}
/** Go: helpers.UTF16ToString → JS string（UTF16ToString 返回 UTF-8 字节，需再解码） */
function u16ToStr(v: Uint16Array | number[]): string {
  return new TextDecoder().decode(UTF16ToString(v));
}

/** Go: func (p *parser) lowerPrivateBrandCheck(...) (js_parser_lower_class.go:19) */
export function lowerPrivateBrandCheck(
  p: parser, target: js_ast.Expr, loc: Loc, privateIdent: js_ast.EPrivateIdentifier,
): js_ast.Expr {
  // "#field in this" => "__privateIn(#field, this)"
  return p.callRuntime(loc, "__privateIn", [
    mk(new js_ast.EIdentifier(privateIdent.Ref), loc),
    target,
  ]);
}

/** Go: func (p *parser) lowerPrivateGet(...) (js_parser_lower_class.go:27) */
export function lowerPrivateGet(
  p: parser, target: js_ast.Expr, loc: Loc, privateIdent: js_ast.EPrivateIdentifier,
): js_ast.Expr {
  const kind = p.symbols[privateIdent.Ref.InnerIndex].Kind;
  const priv = (): js_ast.Expr => mk(new js_ast.EIdentifier(privateIdent.Ref), loc);
  const SK = ast.SymbolKind;
  switch (kind) {
    case SK.SymbolPrivateMethod:
    case SK.SymbolPrivateStaticMethod:
      // "this.#method" => "__privateMethod(this, #method, method_fn)"
      {
        const fnRef = p.privateGetters.get(privateIdent.Ref.SourceIndex + ":" + privateIdent.Ref.InnerIndex)!;
        p.recordUsage(fnRef);
        return p.callRuntime(target.Loc, "__privateMethod", [
          target, priv(), mk(new js_ast.EIdentifier(fnRef), loc),
        ]);
      }
    case SK.SymbolPrivateGet:
    case SK.SymbolPrivateStaticGet:
    case SK.SymbolPrivateGetSetPair:
    case SK.SymbolPrivateStaticGetSetPair:
      // "this.#getter" => "__privateGet(this, #getter, getter_get)"
      {
        const fnRef = p.privateGetters.get(privateIdent.Ref.SourceIndex + ":" + privateIdent.Ref.InnerIndex)!;
        p.recordUsage(fnRef);
        return p.callRuntime(target.Loc, "__privateGet", [
          target, priv(), mk(new js_ast.EIdentifier(fnRef), loc),
        ]);
      }
    default:
      // "this.#field" => "__privateGet(this, #field)"
      return p.callRuntime(target.Loc, "__privateGet", [target, priv()]);
  }
}

/** Go: func (p *parser) lowerPrivateSet(...) (js_parser_lower_class.go:59) */
export function lowerPrivateSet(
  p: parser, target: js_ast.Expr, loc: Loc, privateIdent: js_ast.EPrivateIdentifier, value: js_ast.Expr,
): js_ast.Expr {
  const kind = p.symbols[privateIdent.Ref.InnerIndex].Kind;
  const priv = (): js_ast.Expr => mk(new js_ast.EIdentifier(privateIdent.Ref), loc);
  const SK = ast.SymbolKind;
  switch (kind) {
    case SK.SymbolPrivateSet:
    case SK.SymbolPrivateStaticSet:
    case SK.SymbolPrivateGetSetPair:
    case SK.SymbolPrivateStaticGetSetPair:
      // "this.#setter = 123" => "__privateSet(this, #setter, 123, setter_set)"
      {
        const fnRef = p.privateSetters.get(privateIdent.Ref.SourceIndex + ":" + privateIdent.Ref.InnerIndex)!;
        p.recordUsage(fnRef);
        return p.callRuntime(target.Loc, "__privateSet", [
          target, priv(), value, mk(new js_ast.EIdentifier(fnRef), loc),
        ]);
      }
    default:
      // "this.#field = 123" => "__privateSet(this, #field, 123)"
      return p.callRuntime(target.Loc, "__privateSet", [target, priv(), value]);
  }
}

/** Go: func (p *parser) lowerPrivateSetUnOp(...) (js_parser_lower_class.go:88) */
export function lowerPrivateSetUnOp(
  p: parser, target: js_ast.Expr, loc: Loc, privateIdent: js_ast.EPrivateIdentifier, op: js_ast.OpCode,
): js_ast.Expr {
  const kind = p.symbols[privateIdent.Ref.InnerIndex].Kind;
  const SK = ast.SymbolKind;

  // Determine the setter, if any
  let setter: js_ast.Expr | null = null;
  if (
    kind === SK.SymbolPrivateSet || kind === SK.SymbolPrivateStaticSet ||
    kind === SK.SymbolPrivateGetSetPair || kind === SK.SymbolPrivateStaticGetSetPair
  ) {
    const ref = p.privateSetters.get(privateIdent.Ref.SourceIndex + ":" + privateIdent.Ref.InnerIndex)!;
    p.recordUsage(ref);
    setter = mk(new js_ast.EIdentifier(ref), loc);
  }

  // Determine the getter, if any
  let getter: js_ast.Expr | null = null;
  if (
    kind === SK.SymbolPrivateGet || kind === SK.SymbolPrivateStaticGet ||
    kind === SK.SymbolPrivateGetSetPair || kind === SK.SymbolPrivateStaticGetSetPair
  ) {
    const ref = p.privateGetters.get(privateIdent.Ref.SourceIndex + ":" + privateIdent.Ref.InnerIndex)!;
    p.recordUsage(ref);
    getter = mk(new js_ast.EIdentifier(ref), loc);
  }

  // Only include necessary arguments
  const args: js_ast.Expr[] = [
    target,
    mk(new js_ast.EIdentifier(privateIdent.Ref), loc),
  ];
  if (setter !== null) args.push(setter);
  if (getter !== null) {
    if (setter === null) args.push(mk(js_ast.ENullShared, loc));
    args.push(getter);
  }

  // "target.#private++" => "__privateWrapper(target, #private, private_set, private_get)._"
  const wrapper = p.callRuntime(target.Loc, "__privateWrapper", args);
  const unary = new js_ast.EUnary();
  unary.Op = op;
  unary.Value = mk(initDot(wrapper, "_", target.Loc), target.Loc);
  return mk(unary, loc);
}

/** Go: func (p *parser) lowerPrivateSetBinOp(...) (js_parser_lower_class.go:137) */
export function lowerPrivateSetBinOp(
  p: parser, target: js_ast.Expr, loc: Loc, privateIdent: js_ast.EPrivateIdentifier,
  op: js_ast.OpCode, value: js_ast.Expr,
): js_ast.Expr {
  // "target.#private += 123" => "__privateSet(target, #private, __privateGet(target, #private) + 123)"
  const [targetFunc, targetWrapFunc] = p.captureValueWithPossibleSideEffects(target.Loc, 2, target, 0 /* valueDefinitelyNotMutated */);
  return targetWrapFunc(lowerPrivateSet(
    p, targetFunc(), loc, privateIdent,
    mk(initBinary(op, lowerPrivateGet(p, targetFunc(), loc, privateIdent), value), value.Loc),
  ));
}

/** Go: func (p *parser) extractPrivateIndex(target) (...) (js_parser_lower_class.go:149) */
export function extractPrivateIndex(
  p: parser, target: js_ast.Expr,
): { target: js_ast.Expr; loc: Loc; private: js_ast.EPrivateIdentifier } | null {
  if (target.Data instanceof js_ast.EIndex) {
    const index = target.Data;
    if (index.Index.Data instanceof js_ast.EPrivateIdentifier) {
      const privateIdent = index.Index.Data;
      if (privateSymbolNeedsToBeLowered(p, privateIdent)) {
        return { target: index.Target, loc: index.Index.Loc, private: privateIdent };
      }
    }
  }
  return null;
}

/** Go: func (p *parser) extractSuperProperty(target) js_ast.Expr (js_parser_lower_class.go:160) */
export function extractSuperProperty(p: parser, target: js_ast.Expr): js_ast.Expr | null {
  if (target.Data instanceof js_ast.EDot) {
    if (shouldLowerSuperPropertyAccess(p, target.Data.Target)) {
      return mk(new js_ast.EString(utf16Of(target.Data.Name)), new Loc(target.Data.NameLoc.Start));
    }
  } else if (target.Data instanceof js_ast.EIndex) {
    if (shouldLowerSuperPropertyAccess(p, target.Data.Target)) {
      return target.Data.Index;
    }
  }
  return null;
}

/** Go: func (p *parser) lowerSuperPropertyOrPrivateInAssign(expr) (js_ast.Expr, bool) (js_parser_lower_class.go:174) */
export function lowerSuperPropertyOrPrivateInAssign(p: parser, expr: js_ast.Expr): { expr: js_ast.Expr; didLower: boolean } {
  let didLower = false;
  const e = expr.Data;

  if (e instanceof js_ast.ESpread) {
    const r = lowerSuperPropertyOrPrivateInAssign(p, e.Value);
    if (r.didLower) {
      e.Value = r.expr;
      didLower = true;
    }
  } else if (e instanceof js_ast.EDot) {
    // "[super.foo] = [bar]" => "[__superWrapper(this, 'foo')._] = [bar]"
    if (shouldLowerSuperPropertyAccess(p, e.Target)) {
      const key = mk(new js_ast.EString(utf16Of(e.Name)), new Loc(e.NameLoc.Start));
      expr = callSuperPropertyWrapper(p, expr.Loc, key);
      didLower = true;
    }
  } else if (e instanceof js_ast.EIndex) {
    // "[super[foo]] = [bar]" => "[__superWrapper(this, foo)._] = [bar]"
    if (shouldLowerSuperPropertyAccess(p, e.Target)) {
      expr = callSuperPropertyWrapper(p, expr.Loc, e.Index);
      didLower = true;
    } else if (e.Index.Data instanceof js_ast.EPrivateIdentifier) {
      // "[a.#b] = [c]" => "[__privateWrapper(a, #b)._] = [c]"
      const privateIdent = e.Index.Data;
      if (privateSymbolNeedsToBeLowered(p, privateIdent)) {
        const kind = p.symbols[privateIdent.Ref.InnerIndex].Kind;
        const SK = ast.SymbolKind;
        let target: js_ast.Expr;
        if (
          kind === SK.SymbolPrivateSet || kind === SK.SymbolPrivateStaticSet ||
          kind === SK.SymbolPrivateGetSetPair || kind === SK.SymbolPrivateStaticGetSetPair
        ) {
          const fnRef = p.privateSetters.get(privateIdent.Ref.SourceIndex + ":" + privateIdent.Ref.InnerIndex)!;
          p.recordUsage(fnRef);
          target = p.callRuntime(expr.Loc, "__privateWrapper", [
            e.Target,
            mk(new js_ast.EIdentifier(privateIdent.Ref), expr.Loc),
            mk(new js_ast.EIdentifier(fnRef), expr.Loc),
          ]);
        } else {
          target = p.callRuntime(expr.Loc, "__privateWrapper", [
            e.Target,
            mk(new js_ast.EIdentifier(privateIdent.Ref), expr.Loc),
          ]);
        }
        expr.Data = initDot(target, "_", expr.Loc);
        didLower = true;
      }
    }
  } else if (e instanceof js_ast.EArray) {
    for (let i = 0; i < e.Items.length; i++) {
      const r = lowerSuperPropertyOrPrivateInAssign(p, e.Items[i]);
      if (r.didLower) {
        e.Items[i] = r.expr;
        didLower = true;
      }
    }
  } else if (e instanceof js_ast.EObject) {
    for (let i = 0; i < e.Properties.length; i++) {
      const property = e.Properties[i];
      if (property.ValueOrNil !== null) {
        const r = lowerSuperPropertyOrPrivateInAssign(p, property.ValueOrNil);
        if (r.didLower) {
          e.Properties[i].ValueOrNil = r.expr;
          didLower = true;
        }
      }
    }
  }

  return { expr, didLower };
}

/** Go: func (p *parser) shouldLowerSuperPropertyAccess(expr) bool (js_parser_lower_class.go:251) */
export function shouldLowerSuperPropertyAccess(p: parser, expr: js_ast.Expr): boolean {
  if (p.fnOrArrowDataVisit.shouldLowerSuperPropertyAccess) {
    return expr.Data instanceof js_ast.ESuper;
  }
  return false;
}

/** Go: func (p *parser) callSuperPropertyWrapper(loc, key) js_ast.Expr (js_parser_lower_class.go:259) */
export function callSuperPropertyWrapper(p: parser, loc: Loc, key: js_ast.Expr): js_ast.Expr {
  const ref = p.fnOnlyDataVisit.innerClassNameRef;
  p.recordUsage(ref);
  const classExpr: js_ast.Expr = mk(new js_ast.EIdentifier(ref), loc);
  const thisExpr: js_ast.Expr = mk(js_ast.EThisShared, loc);

  // Handle "this" in lowered static class field initializers
  if (p.fnOnlyDataVisit.shouldReplaceThisWithInnerClassNameRef) {
    p.recordUsage(ref);
    thisExpr.Data = new js_ast.EIdentifier(ref);
  }

  if (!p.fnOnlyDataVisit.isInStaticClassContext) {
    // "super.foo" => "__superWrapper(Class.prototype, this, 'foo')._"
    classExpr.Data = initDot(classExpr, "prototype", loc);
  }

  return mk(initDot(
    p.callRuntime(loc, "__superWrapper", [classExpr, thisExpr, key]), "_", loc,
  ), loc);
}

/** Go: func (p *parser) lowerSuperPropertyGet(loc, key) js_ast.Expr (js_parser_lower_class.go:284) */
export function lowerSuperPropertyGet(p: parser, loc: Loc, key: js_ast.Expr): js_ast.Expr {
  const ref = p.fnOnlyDataVisit.innerClassNameRef;
  p.recordUsage(ref);
  const classExpr: js_ast.Expr = mk(new js_ast.EIdentifier(ref), loc);
  const thisExpr: js_ast.Expr = mk(js_ast.EThisShared, loc);

  if (p.fnOnlyDataVisit.shouldReplaceThisWithInnerClassNameRef) {
    p.recordUsage(ref);
    thisExpr.Data = new js_ast.EIdentifier(ref);
  }

  if (!p.fnOnlyDataVisit.isInStaticClassContext) {
    // "super.foo" => "__superGet(Class.prototype, this, 'foo')"
    classExpr.Data = initDot(classExpr, "prototype", loc);
  }

  return p.callRuntime(loc, "__superGet", [classExpr, thisExpr, key]);
}

/** Go: func (p *parser) lowerSuperPropertySet(loc, key, value) js_ast.Expr (js_parser_lower_class.go:309) */
export function lowerSuperPropertySet(
  p: parser, loc: Loc, key: js_ast.Expr, value: js_ast.Expr,
): js_ast.Expr {
  const ref = p.fnOnlyDataVisit.innerClassNameRef;
  p.recordUsage(ref);
  const classExpr: js_ast.Expr = mk(new js_ast.EIdentifier(ref), loc);
  const thisExpr: js_ast.Expr = mk(js_ast.EThisShared, loc);

  if (p.fnOnlyDataVisit.shouldReplaceThisWithInnerClassNameRef) {
    p.recordUsage(ref);
    thisExpr.Data = new js_ast.EIdentifier(ref);
  }

  if (!p.fnOnlyDataVisit.isInStaticClassContext) {
    classExpr.Data = initDot(classExpr, "prototype", loc);
  }

  return p.callRuntime(loc, "__superSet", [classExpr, thisExpr, key, value]);
}

/** Go: func (p *parser) lowerSuperPropertySetBinOp(...) (js_parser_lower_class.go:337) */
export function lowerSuperPropertySetBinOp(
  p: parser, loc: Loc, property: js_ast.Expr, op: js_ast.OpCode, value: js_ast.Expr,
): js_ast.Expr {
  const [targetFunc, targetWrapFunc] = p.captureValueWithPossibleSideEffects(property.Loc, 2, property, 0 /* valueDefinitelyNotMutated */);
  return targetWrapFunc(lowerSuperPropertySet(
    p, loc, targetFunc(),
    mk(initBinary(op, lowerSuperPropertyGet(p, loc, targetFunc()), value), value.Loc),
  ));
}

/** Go: func (p *parser) maybeLowerSuperPropertyGetInsideCall(call *js_ast.ECall) (js_parser_lower_class.go:349) */
export function maybeLowerSuperPropertyGetInsideCall(p: parser, call: js_ast.ECall): void {
  let key: js_ast.Expr;

  if (call.Target.Data instanceof js_ast.EDot) {
    // Lower "super.prop" if necessary
    const e = call.Target.Data;
    if (!shouldLowerSuperPropertyAccess(p, e.Target)) return;
    key = mk(new js_ast.EString(utf16Of(e.Name)), new Loc(e.NameLoc.Start));
  } else if (call.Target.Data instanceof js_ast.EIndex) {
    // Lower "super[prop]" if necessary
    const e = call.Target.Data;
    if (!shouldLowerSuperPropertyAccess(p, e.Target)) return;
    key = e.Index;
  } else {
    return;
  }

  // "super.foo(a, b)" => "__superGet(Class, this, 'foo').call(this, a, b)"
  call.Target.Data = initDot(lowerSuperPropertyGet(p, call.Target.Loc, key), "call", new Loc(key.Loc.Start));
  const thisExpr = mk(js_ast.EThisShared, call.Target.Loc);
  call.Args = [thisExpr, ...call.Args];
}

// --- 内部构造 helper（对应 Go 的结构体字面量） ---

function initBinary(op: js_ast.OpCode, left: js_ast.Expr, right: js_ast.Expr): js_ast.EBinary {
  const e = new js_ast.EBinary();
  e.Op = op;
  e.Left = left;
  e.Right = right;
  return e;
}

function initDot(target: js_ast.Expr, name: string, nameLoc: Loc): js_ast.EDot {
  const e = new js_ast.EDot();
  e.Target = target;
  e.Name = name;
  e.NameLoc = nameLoc;
  return e;
}

/** Go: func (p *parser) computeClassLoweringInfo(...) (js_parser_lower_class.go:387) */
export function computeClassLoweringInfo(p: parser, classValue: js_ast.Class): classLoweringInfo {
  const result = new classLoweringInfo();

  if (p.options.keepNames && HasFeature(p.options.unsupportedJSFeatures, JSFeature.ClassStaticBlocks)) {
    result.lowerAllStaticFields = true;
  }

  if (p.options.ts.Parse && p.options.tsExperimentalDecorators && classValue.Decorators.length > 0) {
    result.lowerAllStaticFields = true;
  }

  if (classValue.ShouldLowerStandardDecorators) {
    for (const prop of classValue.Properties) {
      if (prop.Decorators.length > 0) {
        for (const prop2 of classValue.Properties) {
          if (prop2.Key.Data instanceof js_ast.EPrivateIdentifier) {
            p.symbols[prop2.Key.Data.Ref.InnerIndex].Flags |= ast.SymbolFlags.PrivateSymbolMustBeLowered;
          }
        }
        result.lowerAllStaticFields = true;
        result.lowerAllInstanceFields = true;
        break;
      }
    }
  }

  for (const prop of classValue.Properties) {
    if (prop.Kind === js_ast.PropertyKind.PropertyClassStaticBlock) {
      if (HasFeature(p.options.unsupportedJSFeatures, JSFeature.ClassStaticBlocks)) {
        result.lowerAllStaticFields = true;
      }
      continue;
    }

    if (prop.Key.Data instanceof js_ast.EPrivateIdentifier) {
      const privateIdent = prop.Key.Data;
      if ((prop.Flags & js_ast.PropertyFlags.PropertyIsStatic) !== 0) {
        if (privateSymbolNeedsToBeLowered(p, privateIdent)) {
          result.lowerAllStaticFields = true;
        }
      } else {
        if (privateSymbolNeedsToBeLowered(p, privateIdent)) {
          result.lowerAllInstanceFields = true;
          result.lowerAllStaticFields = true;
        }
      }
      continue;
    }

    if (prop.Kind === js_ast.PropertyKind.PropertyAutoAccessor) {
      if ((prop.Flags & js_ast.PropertyFlags.PropertyIsStatic) !== 0) {
        if (HasFeature(p.options.unsupportedJSFeatures, JSFeature.ClassPrivateStaticField)) {
          result.lowerAllStaticFields = true;
        }
      } else {
        if (HasFeature(p.options.unsupportedJSFeatures, JSFeature.ClassPrivateField)) {
          result.lowerAllInstanceFields = true;
          result.lowerAllStaticFields = true;
        }
      }
      continue;
    }

    if (js_ast.IsMethodDefinition(prop.Kind)) {
      if (classValue.ExtendsOrNil !== null) {
        if (prop.Key.Data instanceof js_ast.EString && UTF16EqualsString(prop.Key.Data.Value, new TextEncoder().encode("constructor"))) {
          if (prop.ValueOrNil !== null && prop.ValueOrNil.Data instanceof js_ast.EFunction) {
            for (const arg of prop.ValueOrNil.Data.Fn.Args) {
              if (arg.IsTypeScriptCtorField) {
                result.shimSuperCtorCalls = true;
                break;
              }
            }
          }
        }
      }
      continue;
    }

    if ((prop.Flags & js_ast.PropertyFlags.PropertyIsStatic) !== 0) {
      if (HasFeature(p.options.unsupportedJSFeatures, JSFeature.ClassStaticField)) {
        result.lowerAllStaticFields = true;
      }
      if (
        p.options.ts.Parse && !classValue.UseDefineForClassFields &&
        HasFeature(p.options.unsupportedJSFeatures, JSFeature.ClassStaticBlocks)
      ) {
        result.lowerAllStaticFields = true;
      }
    } else {
      if (p.options.ts.Parse && !classValue.UseDefineForClassFields) {
        if (prop.InitializerOrNil !== null) {
          result.lowerAllInstanceFields = true;
        }
      } else if (HasFeature(p.options.unsupportedJSFeatures, JSFeature.ClassField)) {
        result.lowerAllInstanceFields = true;
      }
    }
  }

  if (result.lowerAllInstanceFields && classValue.ExtendsOrNil !== null) {
    result.shimSuperCtorCalls = true;
  }

  return result;
}

// ===========================================================================
// 第 37 轮 J-2+J-3：lowerClass 完整生成链（js_parser_lower_class.go:615-2620）
// 1:1 移植，接进 visitClass 三处调用点，把 ① es2015 的 class field/static block
// 从「原样输出」降级为 Go 一致的 __publicField/__privateAdd/__superGet 等。
// ===========================================================================

/** 通用字段初始化器（等价于 js_parser.ts 里的 init<T>）。 */
function init<T extends object>(node: T, src: Partial<T>): T {
  for (const k of Object.keys(src) as (keyof T)[]) (node as any)[k] = (src as any)[k];
  return node;
}

/** Go: type classKind uint8 (js_parser_lower_class.go:615) */
export const classKind = {
  classKindExpr: 0,
  classKindStmt: 1,
  classKindExportStmt: 2,
  classKindExportDefaultStmt: 3,
} as const;
export type classKind = number;

/** Go: type lowerClassContext struct (js_parser_lower_class.go:624) */
export class lowerClassContext {
  nameToKeep: string = "";
  kind: classKind = classKind.classKindExpr;
  classValue: js_ast.Class = new js_ast.Class();
  classLoc: Loc = new Loc(0);
  classExpr: js_ast.Expr = new js_ast.Expr();
  defaultName: LocRef = new LocRef();

  ctor: js_ast.EFunction | null = null;
  extendsRef: Ref = InvalidRef;
  parameterFieldProps: js_ast.Property[] = [];
  parameterFields: js_ast.Stmt[] = [];
  instanceMembers: js_ast.Stmt[] = [];
  instancePrivateMethods: js_ast.Stmt[] = [];
  autoAccessorCount = 0;

  computedPropertyChain: js_ast.Expr = new js_ast.Expr();
  privateMembers: js_ast.Expr[] = [];
  staticMembers: js_ast.Expr[] = [];
  staticPrivateMethods: js_ast.Expr[] = [];

  instanceExperimentalDecorators: js_ast.Expr[] = [];
  staticExperimentalDecorators: js_ast.Expr[] = [];

  decoratorContextRef: Ref = InvalidRef;
  decoratorClassDecorators: js_ast.Expr = new js_ast.Expr();
  decoratorPropertyToInitializerMap: Map<number, number> | null = null;
  decoratorCallInstanceMethodExtraInitializers = false;
  decoratorCallStaticMethodExtraInitializers = false;
  decoratorStaticNonFieldElements: js_ast.Expr[] = [];
  decoratorInstanceNonFieldElements: js_ast.Expr[] = [];
  decoratorStaticFieldElements: js_ast.Expr[] = [];
  decoratorInstanceFieldElements: js_ast.Expr[] = [];

  privateInstanceMethodRef: Ref = InvalidRef;
  privateStaticMethodRef: Ref = InvalidRef;

  nameFunc: (() => js_ast.Expr) | null = null;
  wrapFunc: ((x: js_ast.Expr) => js_ast.Expr) | null = null;
  didCaptureClassExpr = false;
}

/** Go: type propertyAnalysis struct (js_parser_lower_class.go:1112) */
class propertyAnalysis {
  private: js_ast.EPrivateIdentifier | null = null;
  propExperimentalDecorators: js_ast.Decorator[] = [];
  propDecorators: js_ast.Decorator[] = [];
  mustLowerField = false;
  needsValueOfKey = false;
  rewriteAutoAccessorToGetSet = false;
  shouldOmitFieldInitializer = false;
  staticFieldToBlockAssign = false;
  isComputedPropertyCopiedOrMoved = false;
}

/** Go: func (p *parser) propertyNameHint(key js_ast.Expr) string (js_parser_lower_class.go:1206) */
export function propertyNameHint(p: parser, key: js_ast.Expr): string {
  const k = key.Data;
  if (k instanceof js_ast.EString) return u16ToStr(k.Value);
  if (k instanceof js_ast.EIdentifier) return p.symbols[k.Ref.InnerIndex].OriginalName;
  if (k instanceof js_ast.EPrivateIdentifier) return p.symbols[k.Ref.InnerIndex].OriginalName.slice(1);
  return "";
}

/** Go: func fieldOrAccessorOrder(...) (js_parser_lower_class.go:1454) */
export function fieldOrAccessorOrder(kind: js_ast.PropertyKind, flags: js_ast.PropertyFlags): [number, boolean] {
  if (kind === js_ast.PropertyKind.PropertyAutoAccessor) {
    if ((flags & js_ast.PropertyFlags.PropertyIsStatic) !== 0) return [0, true];
    return [1, true];
  } else if (kind === js_ast.PropertyKind.PropertyField) {
    if ((flags & js_ast.PropertyFlags.PropertyIsStatic) !== 0) return [2, true];
    return [3, true];
  }
  return [0, false];
}

/** Go: func cloneKeyForLowerClass(key js_ast.Expr) js_ast.Expr (js_parser_lower_class.go:2425) */
function cloneKeyForLowerClass(key: js_ast.Expr): js_ast.Expr {
  const k = key.Data;
  if (k instanceof js_ast.ENumber || k instanceof js_ast.EString || k instanceof js_ast.EIdentifier ||
      k instanceof js_ast.ENameOfSymbol || k instanceof js_ast.EPrivateIdentifier) {
    // TS 是 class 实例：克隆 Data 对象（Go 是值拷贝），保留同一 Loc
    // 用 Object.create 复制自身字段即可（这些 E 节点字段都是值）
    key.Data = Object.assign(Object.create(Object.getPrototypeOf(k)), k);
    return key;
  }
  throw new Error("Internal error: cloneKeyForLowerClass");
}

/** Go: func findFirstTopLevelSuperCall(...) (js_parser_lower_class.go:2580) */
export function findFirstTopLevelSuperCall(
  expr: js_ast.Expr, superCtorRef: Ref,
): [js_ast.Expr, Loc, js_ast.ECall | null, js_ast.Expr] {
  const empty = () => new js_ast.Expr();
  const d = expr.Data;
  if (d instanceof js_ast.ECall) {
    const target = d.Target.Data;
    if (target instanceof js_ast.EIdentifier && target.Ref.InnerIndex === superCtorRef.InnerIndex) {
      d.Target.Data = js_ast.ESuperShared;
      return [empty(), expr.Loc, d, empty()];
    }
  }
  if (d instanceof js_ast.EBinary && d.Op === js_ast.OpCode.BinOpComma) {
    const [before, loc, call, after] = findFirstTopLevelSuperCall(d.Left, superCtorRef);
    if (call !== null) return [before, loc, call, JoinWithComma(after, d.Right)];
    const [before2, loc2, call2, after2] = findFirstTopLevelSuperCall(d.Right, superCtorRef);
    if (call2 !== null) return [JoinWithComma(d.Left, before2), loc2, call2, after2];
  }
  return [empty(), new Loc(), null, empty()];
}

/** Go: func (p *parser) insertStmtsAfterSuperCall(...) (js_parser_lower_class.go:2451) */
export function insertStmtsAfterSuperCall(
  p: parser, body: js_ast.FnBody, stmtsToInsert: js_ast.Stmt[], superCtorRef: Ref,
): void {
  const superSym = p.symbols[superCtorRef.InnerIndex];
  if (superCtorRef.InnerIndex === InvalidRef.InnerIndex || superSym.UseCountEstimate === 0) {
    body.Block.Stmts = [...stmtsToInsert, ...body.Block.Stmts];
    return;
  }
  if (superSym.UseCountEstimate === 1) {
    for (let i = 0; i < body.Block.Stmts.length; i++) {
      const stmt = body.Block.Stmts[i];
      let before: js_ast.Expr | null = null;
      let callLoc: Loc = new Loc(0);
      let callData: js_ast.ECall | null = null;
      let after: js_ast.Stmt | null = null;
      const s = stmt.Data;
      if (s instanceof js_ast.SExpr) {
        const [b, loc, c, a] = findFirstTopLevelSuperCall(s.Value, superCtorRef);
        if (c !== null) {
          before = b; callLoc = loc; callData = c;
          if (a.Data !== null) { s.Value = a; after = new js_ast.Stmt(s, a.Loc); }
        }
      } else if (s instanceof js_ast.SReturn) {
        if (s.ValueOrNil !== null && s.ValueOrNil.Data !== null) {
          const [b, loc, c, a] = findFirstTopLevelSuperCall(s.ValueOrNil, superCtorRef);
          if (c !== null && a.Data !== null) { before = b; callLoc = loc; callData = c; s.ValueOrNil = a; after = new js_ast.Stmt(s, a.Loc); }
        }
      } else if (s instanceof js_ast.SThrow) {
        const [b, loc, c, a] = findFirstTopLevelSuperCall(s.Value, superCtorRef);
        if (c !== null && a.Data !== null) { before = b; callLoc = loc; callData = c; s.Value = a; after = new js_ast.Stmt(s, a.Loc); }
      } else if (s instanceof js_ast.SIf) {
        const [b, loc, c, a] = findFirstTopLevelSuperCall(s.Test, superCtorRef);
        if (c !== null && a.Data !== null) { before = b; callLoc = loc; callData = c; s.Test = a; after = new js_ast.Stmt(s, a.Loc); }
      } else if (s instanceof js_ast.SSwitch) {
        const [b, loc, c, a] = findFirstTopLevelSuperCall(s.Test, superCtorRef);
        if (c !== null && a.Data !== null) { before = b; callLoc = loc; callData = c; s.Test = a; after = new js_ast.Stmt(s, a.Loc); }
      } else if (s instanceof js_ast.SFor) {
        const initData = s.InitOrNil.Data;
        if (initData instanceof js_ast.SExpr) {
          const [b, loc, c, a] = findFirstTopLevelSuperCall(initData.Value, superCtorRef);
          if (c !== null) {
            before = b; callLoc = loc; callData = c;
            if (a.Data !== null) initData.Value = a; else s.InitOrNil.Data = null;
            after = new js_ast.Stmt(s, a.Loc);
          }
        }
      }
      if (callData !== null) {
        callData.Target.Data = js_ast.ESuperShared;
        p.ignoreUsage(superCtorRef);
        const stmtsBefore = body.Block.Stmts.slice(0, i);
        const stmtsAfter = body.Block.Stmts.slice(i + 1);
        const stmts: js_ast.Stmt[] = [...stmtsBefore];
        if (before !== null && before.Data !== null) stmts.push(new js_ast.Stmt(init(new js_ast.SExpr(), { Value: before }), before.Loc));
        stmts.push(new js_ast.Stmt(init(new js_ast.SExpr(), { Value: mk(callData, callLoc) }), callLoc));
        stmts.push(...stmtsToInsert);
        if (after !== null && after.Data !== null) stmts.push(after);
        stmts.push(...stmtsAfter);
        body.Block.Stmts = stmts;
        return;
      }
    }
  }
  const argsRef = p.newSymbol(ast.SymbolKind.SymbolOther, "args");
  p.currentScope!.Generated.push(argsRef);
  p.recordUsage(argsRef);
  const superCall = mk(new js_ast.ECall(), body.Loc);
  const sc = superCall.Data as js_ast.ECall;
  sc.Target = mk(js_ast.ESuperShared, body.Loc);
  sc.Args = [mk(init(new js_ast.ESpread(), { Value: mk(new js_ast.EIdentifier(argsRef), body.Loc) }), body.Loc)];
  let toInsert: js_ast.Stmt[] = [new js_ast.Stmt(init(new js_ast.SExpr(), { Value: superCall }), body.Loc), ...stmtsToInsert];
  toInsert.push(new js_ast.Stmt(init(new js_ast.SReturn(), { ValueOrNil: mk(js_ast.EThisShared, body.Loc) }), body.Loc));
  if (p.options.minifySyntax) toInsert = p.mangleStmts(toInsert, stmtsKind.stmtsFnBody);
  const arrow = new js_ast.EArrow();
  arrow.HasRestArg = true;
  arrow.PreferExpr = true;
  arrow.Args = [new js_ast.Arg()];
  arrow.Args[0].Binding = init(new js_ast.Binding(), { Data: new js_ast.BIdentifier(argsRef), Loc: body.Loc });
  arrow.Body = new js_ast.FnBody();
  arrow.Body.Loc = body.Loc;
  arrow.Body.Block.Stmts = toInsert;
  const local = new js_ast.SLocal();
  local.Decls = [new js_ast.Decl()];
  local.Decls[0].Binding = init(new js_ast.Binding(), { Data: new js_ast.BIdentifier(superCtorRef), Loc: body.Loc });
  local.Decls[0].ValueOrNil = mk(arrow, body.Loc);
  body.Block.Stmts = [new js_ast.Stmt(local, body.Loc), ...body.Block.Stmts];
}

/** Go: (ctx *lowerClassContext) enableNameCapture (js_parser_lower_class.go:747) */
function enableNameCapture(ctx: lowerClassContext, p: parser, result: any): void {
  ctx.nameFunc = () => {
    if (ctx.kind === classKind.classKindExpr) {
      const classExpr = new js_ast.EClass();
      classExpr.Class = ctx.classValue;
      ctx.classValue = classExpr.Class;
      const cap = p.captureValueWithPossibleSideEffects(ctx.classLoc, 2, mk(classExpr, ctx.classLoc), 0);
      ctx.nameFunc = cap[0];
      ctx.wrapFunc = cap[1];
      ctx.classExpr = ctx.nameFunc();
      ctx.didCaptureClassExpr = true;
      const name = ctx.nameFunc();
      if (ctx.classValue.Name !== null) {
        const nameRef = (name.Data as js_ast.EIdentifier).Ref;
        p.mergeSymbols(ctx.classValue.Name.Ref, nameRef);
        ctx.classValue.Name = null;
      }
      return name;
    } else {
      if (result.innerClassNameRef.InnerIndex !== InvalidRef.InnerIndex) {
        p.recordUsage(result.innerClassNameRef);
        return mk(new js_ast.EIdentifier(result.innerClassNameRef), ctx.classValue.Name?.Loc ?? ctx.classLoc);
      }
      if (ctx.classValue.Name === null) {
        if (ctx.kind === classKind.classKindExportDefaultStmt) {
          ctx.classValue.Name = ctx.defaultName;
        } else {
          ctx.classValue.Name = new LocRef(ctx.classLoc, p.generateTempRef(generateTempRefArg.tempRefNoDeclare, ""));
        }
      }
      p.recordUsage(ctx.classValue.Name.Ref);
      return mk(new js_ast.EIdentifier(ctx.classValue.Name.Ref), ctx.classValue.Name.Loc);
    }
  };
}

/** Go: (ctx *lowerClassContext) lowerField (js_parser_lower_class.go:819) */
function lowerField(
  ctx: lowerClassContext, p: parser, prop: js_ast.Property,
  priv: js_ast.EPrivateIdentifier | null, shouldOmitFieldInitializer: boolean,
  staticFieldToBlockAssign: boolean, initializerIndex: number,
): [js_ast.Property, Ref, boolean] {
  const mustLowerPrivate = priv !== null && privateSymbolNeedsToBeLowered(p, priv);
  let ref: Ref = InvalidRef;
  if (!shouldOmitFieldInitializer) {
    const loc = prop.Loc;
    let target: js_ast.Expr;
    if ((prop.Flags & js_ast.PropertyFlags.PropertyIsStatic) !== 0 && !staticFieldToBlockAssign) {
      target = ctx.nameFunc!();
    } else {
      target = mk(js_ast.EThisShared, loc);
    }
    let initExpr: js_ast.Expr = prop.InitializerOrNil !== null && prop.InitializerOrNil.Data !== null ? prop.InitializerOrNil : mk(js_ast.EUndefinedShared, loc);
    if (initializerIndex !== -1) {
      const value = (prop.Flags & js_ast.PropertyFlags.PropertyIsStatic) !== 0 ? ctx.nameFunc!() : mk(js_ast.EThisShared, loc);
      const args: js_ast.Expr[] = [
        mk(new js_ast.EIdentifier(ctx.decoratorContextRef), loc),
        mk(new js_ast.ENumber((4 + 2 * initializerIndex) << 1), loc),
        value,
      ];
      if (!(initExpr.Data instanceof js_ast.EUndefined)) args.push(initExpr);
      initExpr = p.callRuntime(initExpr.Loc, "__runInitializers", args);
      p.recordUsage(ctx.decoratorContextRef);
    }
    let memberExpr: js_ast.Expr;
    if (mustLowerPrivate) {
      ref = p.generateTempRef(generateTempRefArg.tempRefNeedsDeclare, "_" + p.symbols[priv!.Ref.InnerIndex].OriginalName.slice(1));
      p.symbols[priv!.Ref.InnerIndex].Link = ref;
      if (p.weakMapRef.InnerIndex === InvalidRef.InnerIndex) {
        p.weakMapRef = p.newSymbol(ast.SymbolKind.SymbolUnbound, "WeakMap");
        p.moduleScope!.Generated.push(p.weakMapRef);
      }
      ctx.privateMembers.push(Assign(
        mk(new js_ast.EIdentifier(ref), prop.Key.Loc),
        mk(init(new js_ast.ENew(), { Target: mk(new js_ast.EIdentifier(p.weakMapRef), prop.Key.Loc) }), prop.Key.Loc),
      ));
      p.recordUsage(ref);
      const key = mk(new js_ast.EIdentifier(ref), prop.Key.Loc);
      const args: js_ast.Expr[] = [target, key];
      if (!(initExpr.Data instanceof js_ast.EUndefined)) args.push(initExpr);
      memberExpr = p.callRuntime(loc, "__privateAdd", args);
      p.recordUsage(ref);
    } else if (priv === null && ctx.classValue.UseDefineForClassFields) {
      if (p.shouldAddKeyComment && prop.Key.Data instanceof js_ast.EString) prop.Key.Data.HasPropertyKeyComment = true;
      const args: js_ast.Expr[] = [target, prop.Key];
      if (!(initExpr.Data instanceof js_ast.EUndefined)) args.push(initExpr);
      const call = new js_ast.ECall();
      call.Target = p.importFromRuntime(loc, "__publicField");
      call.Args = args;
      memberExpr = mk(call, loc);
    } else {
      const keyData = prop.Key.Data;
      if (keyData instanceof js_ast.EString && (prop.Flags & js_ast.PropertyFlags.PropertyIsComputed) === 0 &&
          (prop.Flags & js_ast.PropertyFlags.PropertyPreferQuotedKey) === 0) {
        target = mk(initDot(target, u16ToStr(keyData.Value), prop.Key.Loc), loc);
      } else {
        const idx = new js_ast.EIndex(); idx.Target = target; idx.Index = prop.Key;
        target = mk(idx, loc);
      }
      memberExpr = Assign(target, initExpr);
    }
    if (initializerIndex !== -1) {
      const value = (prop.Flags & js_ast.PropertyFlags.PropertyIsStatic) !== 0 ? ctx.nameFunc!() : mk(js_ast.EThisShared, loc);
      memberExpr = JoinWithComma(memberExpr, p.callRuntime(loc, "__runInitializers", [
        mk(new js_ast.EIdentifier(ctx.decoratorContextRef), loc),
        mk(new js_ast.ENumber(((5 + 2 * initializerIndex) << 1) | 1), loc),
        value,
      ]));
      p.recordUsage(ctx.decoratorContextRef);
    }
    if ((prop.Flags & js_ast.PropertyFlags.PropertyIsStatic) !== 0) {
      if (staticFieldToBlockAssign) {
        const block = new js_ast.ClassStaticBlock();
        block.Loc = loc;
        block.Block = init(new js_ast.SBlock(), { Stmts: [new js_ast.Stmt(init(new js_ast.SExpr(), { Value: memberExpr }), loc)] });
        const p2 = new js_ast.Property(); p2.Loc = loc; p2.Kind = js_ast.PropertyKind.PropertyClassStaticBlock; p2.ClassStaticBlock = block;
        return [p2, ref, true];
      } else {
        ctx.staticMembers.push(memberExpr);
      }
    } else {
      ctx.instanceMembers.push(new js_ast.Stmt(init(new js_ast.SExpr(), { Value: memberExpr }), loc));
    }
  }
  if (priv === null || mustLowerPrivate) return [new js_ast.Property(), ref, false];
  prop.InitializerOrNil = new js_ast.Expr();
  return [prop, ref, true];
}

/** Go: (ctx *lowerClassContext) lowerPrivateMethod (js_parser_lower_class.go:979) */
function lowerPrivateMethod(ctx: lowerClassContext, p: parser, prop: js_ast.Property, priv: js_ast.EPrivateIdentifier): void {
  let refSlot: Ref = (prop.Flags & js_ast.PropertyFlags.PropertyIsStatic) !== 0 ? ctx.privateStaticMethodRef : ctx.privateInstanceMethodRef;
  if (refSlot.InnerIndex === InvalidRef.InnerIndex) {
    let name = (prop.Flags & js_ast.PropertyFlags.PropertyIsStatic) !== 0 ? "_static" : "_instances";
    if (ctx.nameToKeep !== "") name = "_" + ctx.nameToKeep + name;
    const ref = p.generateTempRef(generateTempRefArg.tempRefNeedsDeclare, name);
    if ((prop.Flags & js_ast.PropertyFlags.PropertyIsStatic) !== 0) ctx.privateStaticMethodRef = ref; else ctx.privateInstanceMethodRef = ref;
    refSlot = ref;
    if (p.weakSetRef.InnerIndex === InvalidRef.InnerIndex) {
      p.weakSetRef = p.newSymbol(ast.SymbolKind.SymbolUnbound, "WeakSet");
      p.moduleScope!.Generated.push(p.weakSetRef);
    }
    ctx.privateMembers.push(Assign(
      mk(new js_ast.EIdentifier(ref), ctx.classLoc),
      mk(init(new js_ast.ENew(), { Target: mk(new js_ast.EIdentifier(p.weakSetRef), ctx.classLoc) }), ctx.classLoc),
    ));
    p.recordUsage(ref);
    p.recordUsage(p.weakSetRef);
    const target = (prop.Flags & js_ast.PropertyFlags.PropertyIsStatic) !== 0 ? ctx.nameFunc!() : mk(js_ast.EThisShared, ctx.classLoc);
    const methodExpr = p.callRuntime(ctx.classLoc, "__privateAdd", [target, mk(new js_ast.EIdentifier(ref), ctx.classLoc)]);
    p.recordUsage(ref);
    if ((prop.Flags & js_ast.PropertyFlags.PropertyIsStatic) !== 0) ctx.staticPrivateMethods.push(methodExpr);
    else ctx.instancePrivateMethods.push(new js_ast.Stmt(init(new js_ast.SExpr(), { Value: methodExpr }), ctx.classLoc));
  }
  p.symbols[priv.Ref.InnerIndex].Link = refSlot;
}

/** Go: (ctx *lowerClassContext) lowerMethod (js_parser_lower_class.go:1048) */
function lowerMethod(ctx: lowerClassContext, p: parser, prop: js_ast.Property, priv: js_ast.EPrivateIdentifier | null): boolean {
  if (priv !== null && privateSymbolNeedsToBeLowered(p, priv)) {
    lowerPrivateMethod(ctx, p, prop, priv);
    const methodRef = p.generateTempRef(generateTempRefArg.tempRefNeedsDeclare, "_");
    if (prop.Kind === js_ast.PropertyKind.PropertySetter) p.symbols[methodRef.InnerIndex].Link = p.privateSetters.get(String(priv.Ref.InnerIndex))!;
    else p.symbols[methodRef.InnerIndex].Link = p.privateGetters.get(String(priv.Ref.InnerIndex))!;
    p.recordUsage(methodRef);
    ctx.privateMembers.push(Assign(mk(new js_ast.EIdentifier(methodRef), prop.Key.Loc), prop.ValueOrNil!));
    return true;
  }
  const keyData = prop.Key.Data;
  if (keyData instanceof js_ast.EString && UTF16EqualsString(keyData.Value, new TextEncoder().encode("constructor"))) {
    const vd = prop.ValueOrNil?.Data;
    if (vd instanceof js_ast.EFunction) {
      ctx.ctor = vd;
      if (p.options.ts.Parse) {
        for (const arg of vd.Fn.Args) {
          if (arg.IsTypeScriptCtorField) {
            const bd = arg.Binding.Data;
            if (bd instanceof js_ast.BIdentifier) {
              const loc = arg.Binding.Loc;
              const name = p.symbols[bd.Ref.InnerIndex].OriginalName;
              const target = mk(js_ast.EThisShared, loc);
              const initExpr2 = mk(new js_ast.EIdentifier(bd.Ref), loc);
              if (!ctx.classValue.UseDefineForClassFields || !HasFeature(p.options.unsupportedJSFeatures, JSFeature.ClassField)) {
                ctx.parameterFields.push(AssignStmt(mk(p.dotOrMangledPropVisit(target, name, loc), loc), initExpr2));
              }
              if (ctx.classValue.UseDefineForClassFields) {
                const key = mk(new js_ast.EString(utf16Of(name)), loc);
                if (HasFeature(p.options.unsupportedJSFeatures, JSFeature.ClassField)) {
                  const call = new js_ast.ECall(); call.Target = p.importFromRuntime(loc, "__publicField"); call.Args = [target, key, initExpr2];
                  ctx.parameterFields.push(new js_ast.Stmt(init(new js_ast.SExpr(), { Value: mk(call, loc) }), loc));
                } else {
                  const p2 = new js_ast.Property(); p2.Kind = js_ast.PropertyKind.PropertyField; p2.Loc = loc; p2.Key = key;
                  ctx.parameterFieldProps.push(p2);
                }
              }
            }
          }
        }
      }
    }
  }
  return false;
}

/** Go: (ctx *lowerClassContext) analyzeProperty (js_parser_lower_class.go:1124) */
function analyzeProperty(ctx: lowerClassContext, p: parser, prop: js_ast.Property, info: classLoweringInfo): propertyAnalysis {
  const a = new propertyAnalysis();
  a.private = prop.Key.Data instanceof js_ast.EPrivateIdentifier ? prop.Key.Data : null;
  const mustLowerPrivate = a.private !== null && privateSymbolNeedsToBeLowered(p, a.private);
  a.shouldOmitFieldInitializer = p.options.ts.Parse && !js_ast.IsMethodDefinition(prop.Kind) &&
    (prop.InitializerOrNil === null || prop.InitializerOrNil.Data === null) && !ctx.classValue.UseDefineForClassFields && !mustLowerPrivate && !ctx.classValue.ShouldLowerStandardDecorators;
  if (!js_ast.IsMethodDefinition(prop.Kind)) {
    if ((prop.Flags & js_ast.PropertyFlags.PropertyIsStatic) !== 0) {
      a.mustLowerField = info.lowerAllStaticFields;
    } else if (prop.Kind === js_ast.PropertyKind.PropertyField && p.options.ts.Parse && !ctx.classValue.UseDefineForClassFields && a.private === null) {
      a.mustLowerField = true;
    } else {
      a.mustLowerField = info.lowerAllInstanceFields;
    }
  }
  if (prop.Kind === js_ast.PropertyKind.PropertyDeclareOrAbstract && (prop.ValueOrNil === null || prop.ValueOrNil.Data === null)) {
    a.mustLowerField = true; a.shouldOmitFieldInitializer = true;
  }
  if (p.options.ts.Parse && p.options.tsExperimentalDecorators) a.propExperimentalDecorators = prop.Decorators;
  else if (ctx.classValue.ShouldLowerStandardDecorators) a.propDecorators = prop.Decorators;
  a.rewriteAutoAccessorToGetSet = a.propDecorators.length === 0 && prop.Kind === js_ast.PropertyKind.PropertyAutoAccessor &&
    (a.mustLowerField);
  a.staticFieldToBlockAssign = prop.Kind === js_ast.PropertyKind.PropertyField && !a.mustLowerField && !ctx.classValue.UseDefineForClassFields &&
    (prop.Flags & js_ast.PropertyFlags.PropertyIsStatic) !== 0 && a.private === null;
  a.needsValueOfKey = true;
  if ((prop.Flags & js_ast.PropertyFlags.PropertyIsComputed) !== 0 &&
      (a.propExperimentalDecorators.length > 0 || a.propDecorators.length > 0 || a.mustLowerField || a.staticFieldToBlockAssign || a.rewriteAutoAccessorToGetSet)) {
    a.isComputedPropertyCopiedOrMoved = true;
    if (a.propExperimentalDecorators.length === 0 && a.propDecorators.length === 0 && !a.rewriteAutoAccessorToGetSet && a.shouldOmitFieldInitializer) {
      a.needsValueOfKey = false;
    }
  }
  return a;
}

/** Go: (ctx *lowerClassContext) hoistComputedProperties (js_parser_lower_class.go:1219) */
function hoistComputedProperties(ctx: lowerClassContext, p: parser, info: classLoweringInfo): [Map<number, Ref> | null, Map<number, Ref> | null] {
  let nextComputedPropertyKey: js_ast.Expr | null = null;
  const propertyKeyTempRefs: Map<number, Ref> = new Map();
  let decoratorTempRefs: Map<number, Ref> | null = null;
  const props = ctx.classValue.Properties;
  for (let propIndex = props.length - 1; propIndex >= 0; propIndex--) {
    const prop = props[propIndex];
    const analysis = analyzeProperty(ctx, p, prop, info);
    let decorators: js_ast.Expr | null = null;
    if (analysis.propDecorators.length > 0) {
      let name = propertyNameHint(p, prop.Key);
      if (name !== "") name = "_" + name;
      name += "_dec";
      const ref = p.generateTempRef(generateTempRefArg.tempRefNeedsDeclare, name);
      const values = analysis.propDecorators.map(d => d.Value);
      const atLoc = analysis.propDecorators[0].AtLoc;
      decorators = Assign(mk(new js_ast.EIdentifier(ref), atLoc), mk(init(new js_ast.EArray(), { Items: values, IsSingleLine: true }), atLoc));
      p.recordUsage(ref);
      if (decoratorTempRefs === null) decoratorTempRefs = new Map();
      decoratorTempRefs.set(propIndex, ref);
    }
    const kd = prop.Key.Data;
    if (kd instanceof js_ast.EString || kd instanceof js_ast.ENameOfSymbol || kd instanceof js_ast.ENumber || kd instanceof js_ast.EPrivateIdentifier) {
      if (nextComputedPropertyKey !== null) {
        const joined = JoinWithComma(decorators ?? new js_ast.Expr(), nextComputedPropertyKey);
        nextComputedPropertyKey.Data = joined.Data;
        nextComputedPropertyKey.Loc = joined.Loc;
      } else {
        ctx.computedPropertyChain = JoinWithComma(decorators ?? new js_ast.Expr(), ctx.computedPropertyChain);
      }
      continue;
    } else {
      if (decorators !== null && decorators.Data !== null) { prop.Key = JoinWithComma(decorators, prop.Key); prop.Flags |= js_ast.PropertyFlags.PropertyIsComputed; }
    }
    if (analysis.isComputedPropertyCopiedOrMoved) {
      if (!analysis.rewriteAutoAccessorToGetSet && (analysis.mustLowerField || analysis.staticFieldToBlockAssign)) {
        let inlineKey = prop.Key;
        if (!analysis.needsValueOfKey) { /* only side effects */ }
        else {
          const ref = p.generateTempRef(generateTempRefArg.tempRefNeedsDeclare, "");
          inlineKey = Assign(mk(new js_ast.EIdentifier(ref), prop.Key.Loc), prop.Key);
          p.recordUsage(ref);
          prop.Key = mk(new js_ast.EIdentifier(ref), prop.Key.Loc);
          p.recordUsage(ref);
        }
        if (nextComputedPropertyKey !== null) {
          const joined = JoinWithComma(inlineKey, nextComputedPropertyKey);
          nextComputedPropertyKey.Data = joined.Data; nextComputedPropertyKey.Loc = joined.Loc;
        } else {
          ctx.computedPropertyChain = JoinWithComma(inlineKey, ctx.computedPropertyChain);
        }
        continue;
      }
      const ref = p.generateTempRef(generateTempRefArg.tempRefNeedsDeclare, "");
      prop.Key = Assign(mk(new js_ast.EIdentifier(ref), prop.Key.Loc), prop.Key);
      p.recordUsage(ref);
      propertyKeyTempRefs.set(propIndex, ref);
    }
    if ((prop.Flags & js_ast.PropertyFlags.PropertyIsComputed) !== 0) {
      if (ctx.computedPropertyChain.Data !== null) {
        let ref = propertyKeyTempRefs.get(propIndex);
        if (ref === undefined) {
          ref = p.generateTempRef(generateTempRefArg.tempRefNeedsDeclare, "");
          prop.Key = Assign(mk(new js_ast.EIdentifier(ref), prop.Key.Loc), prop.Key);
          p.recordUsage(ref);
        }
        const joined = JoinWithComma(JoinWithComma(prop.Key, ctx.computedPropertyChain), mk(new js_ast.EIdentifier(ref), prop.Key.Loc));
        prop.Key = joined;
        p.recordUsage(ref);
        ctx.computedPropertyChain = new js_ast.Expr();
      }
      nextComputedPropertyKey = prop.Key;
    }
  }
  if (ctx.computedPropertyChain.Data !== null && ctx.classValue.ExtendsOrNil !== null) {
    ctx.extendsRef = p.generateTempRef(generateTempRefArg.tempRefNeedsDeclare, "");
    const ext = ctx.classValue.ExtendsOrNil;
    ctx.classValue.ExtendsOrNil = JoinWithComma(
      JoinWithComma(Assign(mk(new js_ast.EIdentifier(ctx.extendsRef), ext.Loc), ext), ctx.computedPropertyChain),
      mk(new js_ast.EIdentifier(ctx.extendsRef), ext.Loc),
    );
    p.recordUsage(ctx.extendsRef);
    p.recordUsage(ctx.extendsRef);
    ctx.computedPropertyChain = new js_ast.Expr();
  }
  return [propertyKeyTempRefs.size > 0 ? propertyKeyTempRefs : null, decoratorTempRefs];
}

/** Go: (ctx *lowerClassContext) lowerStaticBlock (js_parser_lower_class.go:1806) */
function lowerStaticBlock(ctx: lowerClassContext, p: parser, loc: Loc, block: js_ast.ClassStaticBlock): void {
  const isAllExprs: js_ast.Expr[] = [];
  let allExprs = true;
  for (const stmt of block.Block.Stmts) {
    const s = stmt.Data;
    if (s instanceof js_ast.SEmpty) continue;
    else if (s instanceof js_ast.SExpr) isAllExprs.push(s.Value);
    else { allExprs = false; break; }
  }
  if (allExprs) {
    ctx.staticMembers.push(...isAllExprs);
  } else {
    const arrow = new js_ast.EArrow();
    arrow.Body = new js_ast.FnBody();
    arrow.Body.Loc = block.Loc;
    arrow.Body.Block = block.Block;
    const call = new js_ast.ECall();
    call.Target = mk(arrow, loc);
    call.CanBeUnwrappedIfUnused = p.astHelpers.StmtsCanBeRemovedIfUnused(block.Block.Stmts, 0);
    ctx.staticMembers.push(mk(call, loc));
  }
}

/** Go: (ctx *lowerClassContext) rewriteAutoAccessorToGetSet (js_parser_lower_class.go:1840) */
function rewriteAutoAccessorToGetSet(
  ctx: lowerClassContext, p: parser, prop: js_ast.Property, properties: js_ast.Property[],
  keyExprNoSideEffects: js_ast.Expr, mustLowerField: boolean, priv: js_ast.EPrivateIdentifier | null, result: any,
): js_ast.Property[] {
  const storageKind = (prop.Flags & js_ast.PropertyFlags.PropertyIsStatic) !== 0
    ? ast.SymbolKind.SymbolPrivateStaticField : ast.SymbolKind.SymbolPrivateField;
  let storageName: string;
  const kd = keyExprNoSideEffects.Data;
  if (kd instanceof js_ast.EString) storageName = "#" + UTF16ToString(kd.Value);
  else if (kd instanceof js_ast.EPrivateIdentifier) storageName = "#_" + p.symbols[kd.Ref.InnerIndex].OriginalName.slice(1);
  else { storageName = "#" + ast.DefaultNameMinifierJS.NumberToMinifiedName(ctx.autoAccessorCount); ctx.autoAccessorCount++; }
  const storageRef = p.newSymbol(storageKind, storageName);
  const argRef = p.newSymbol(ast.SymbolKind.SymbolOther, "_");
  result.bodyScope.Generated.push(storageRef);
  const childScope = new js_ast.Scope();
  childScope.Kind = js_ast.ScopeKind.ScopeFunctionBody;
  childScope.Generated = [argRef];
  result.bodyScope.Children.push(childScope);
  const loc = keyExprNoSideEffects.Loc;
  const storagePrivate = new js_ast.EPrivateIdentifier(storageRef);
  if (mustLowerField) p.symbols[storageRef.InnerIndex].Flags |= ast.SymbolFlags.PrivateSymbolMustBeLowered;
  const storageNeedsToBeLowered = privateSymbolNeedsToBeLowered(p, storagePrivate);
  const storageProp = new js_ast.Property();
  storageProp.Loc = prop.Loc;
  storageProp.Kind = js_ast.PropertyKind.PropertyField;
  storageProp.Flags = prop.Flags & js_ast.PropertyFlags.PropertyIsStatic;
  storageProp.Key = mk(storagePrivate, loc);
  storageProp.InitializerOrNil = prop.InitializerOrNil;
  if (!mustLowerField) properties.push(storageProp);
  else {
    const [p2, , ok] = lowerField(ctx, p, storageProp, storagePrivate, false, false, -1);
    if (ok) properties.push(p2);
  }
  let getExpr: js_ast.Expr;
  if (storageNeedsToBeLowered) getExpr = lowerPrivateGet(p, mk(js_ast.EThisShared, loc), loc, storagePrivate);
  else {
    p.recordUsage(storageRef);
    const idx = new js_ast.EIndex(); idx.Target = mk(js_ast.EThisShared, loc); idx.Index = mk(new js_ast.EPrivateIdentifier(storageRef), loc);
    getExpr = mk(idx, loc);
  }
  const getterFn = new js_ast.EFunction();
  getterFn.Fn = new js_ast.Fn();
  getterFn.Fn.Body = new js_ast.FnBody();
  getterFn.Fn.Body.Loc = loc;
  getterFn.Fn.Body.Block = init(new js_ast.SBlock(), { Stmts: [new js_ast.Stmt(init(new js_ast.SReturn(), { ValueOrNil: getExpr }), loc)] });
  const getterProp = new js_ast.Property();
  getterProp.Loc = prop.Loc; getterProp.Kind = js_ast.PropertyKind.PropertyGetter;
  getterProp.Flags = prop.Flags; getterProp.Key = prop.Key; getterProp.ValueOrNil = mk(getterFn, loc);
  if (!lowerMethod(ctx, p, getterProp, priv)) properties.push(getterProp);
  let setExpr: js_ast.Expr;
  if (storageNeedsToBeLowered) setExpr = lowerPrivateSet(p, mk(js_ast.EThisShared, loc), loc, storagePrivate, mk(new js_ast.EIdentifier(argRef), loc));
  else {
    p.recordUsage(storageRef); p.recordUsage(argRef);
    const idx = new js_ast.EIndex(); idx.Target = mk(js_ast.EThisShared, loc); idx.Index = mk(new js_ast.EPrivateIdentifier(storageRef), loc);
    setExpr = Assign(mk(idx, loc), mk(new js_ast.EIdentifier(argRef), loc));
  }
  const setterFn = new js_ast.EFunction();
  setterFn.Fn = new js_ast.Fn();
  setterFn.Fn.Args = [new js_ast.Arg()];
  setterFn.Fn.Args[0].Binding = init(new js_ast.Binding(), { Data: new js_ast.BIdentifier(argRef), Loc: loc });
  setterFn.Fn.Body = new js_ast.FnBody();
  setterFn.Fn.Body.Loc = loc;
  setterFn.Fn.Body.Block = init(new js_ast.SBlock(), { Stmts: [new js_ast.Stmt(init(new js_ast.SExpr(), { Value: setExpr }), loc)] });
  const setterProp = new js_ast.Property();
  setterProp.Loc = prop.Loc; setterProp.Kind = js_ast.PropertyKind.PropertySetter;
  setterProp.Flags = prop.Flags; setterProp.Key = cloneKeyForLowerClass(keyExprNoSideEffects); setterProp.ValueOrNil = mk(setterFn, loc);
  if (!lowerMethod(ctx, p, setterProp, priv)) properties.push(setterProp);
  return properties;
}

/** Go: (ctx *lowerClassContext) processProperties (js_parser_lower_class.go:1471) */
function processProperties(ctx: lowerClassContext, p: parser, info: classLoweringInfo, result: any): void {
  let properties: js_ast.Property[] = [];
  const [propertyKeyTempRefs, decoratorTempRefs] = hoistComputedProperties(ctx, p, info);

  if (ctx.classValue.ShouldLowerStandardDecorators) {
    const counts = [0, 0, 0, 0];
    for (const prop of ctx.classValue.Properties) {
      if (prop.Decorators.length > 0) {
        const [i, ok] = fieldOrAccessorOrder(prop.Kind, prop.Flags);
        if (ok) counts[i]++;
        else if ((prop.Flags & js_ast.PropertyFlags.PropertyIsStatic) !== 0) ctx.decoratorCallStaticMethodExtraInitializers = true;
        else ctx.decoratorCallInstanceMethodExtraInitializers = true;
      }
    }
    if (counts[0] > 0 || counts[1] > 0 || counts[2] > 0 || counts[3] > 0) {
      const indices = [0, counts[0], counts[0] + counts[1], counts[0] + counts[1] + counts[2]];
      ctx.decoratorPropertyToInitializerMap = new Map();
      for (let propIndex = 0; propIndex < ctx.classValue.Properties.length; propIndex++) {
        const prop = ctx.classValue.Properties[propIndex];
        if (prop.Decorators.length > 0) {
          const [i, ok] = fieldOrAccessorOrder(prop.Kind, prop.Flags);
          if (ok) { ctx.decoratorPropertyToInitializerMap.set(propIndex, indices[i]); indices[i]++; }
        }
      }
    }
  }
  if (ctx.classValue.ShouldLowerStandardDecorators && ctx.classValue.Decorators.length > 0) {
    let name = ctx.nameToKeep; if (name === "") name = "class";
    const decoratorsRef = p.generateTempRef(generateTempRefArg.tempRefNeedsDeclare, "_" + name + "_decorators");
    const values = ctx.classValue.Decorators.map(d => d.Value);
    const atLoc = ctx.classValue.Decorators[0].AtLoc;
    ctx.computedPropertyChain = JoinWithComma(
      Assign(mk(new js_ast.EIdentifier(decoratorsRef), atLoc), mk(init(new js_ast.EArray(), { Items: values, IsSingleLine: true }), atLoc)),
      ctx.computedPropertyChain);
    p.recordUsage(decoratorsRef);
    ctx.decoratorClassDecorators = mk(new js_ast.EIdentifier(decoratorsRef), atLoc);
    p.recordUsage(decoratorsRef);
    ctx.classValue.Decorators = [];
  }

  for (let propIndex = 0; propIndex < ctx.classValue.Properties.length; propIndex++) {
    let prop = ctx.classValue.Properties[propIndex];
    if (prop.Kind === js_ast.PropertyKind.PropertyClassStaticBlock) {
      if (p.options.minifySyntax && prop.ClassStaticBlock!.Block.Stmts.length === 0) continue;
      if (info.lowerAllStaticFields) { lowerStaticBlock(ctx, p, prop.Loc, prop.ClassStaticBlock!); continue; }
      properties.push(prop); continue;
    }
    if (p.options.ts.Parse && js_ast.IsMethodDefinition(prop.Kind)) {
      const vd = prop.ValueOrNil?.Data;
      if (vd instanceof js_ast.EFunction) {
        let isConstructor = false;
        const kd = prop.Key.Data;
        if (kd instanceof js_ast.EString) isConstructor = UTF16EqualsString(kd.Value, new TextEncoder().encode("constructor"));
        const args = vd.Fn.Args;
        for (let i = 0; i < args.length; i++) {
          for (const decorator of args[i].Decorators) {
            let decorators = prop.Decorators;
            if (isConstructor) decorators = ctx.classValue.Decorators;
            decorators.push(new js_ast.Decorator(p.callRuntime(decorator.Value.Loc, "__decorateParam", [
              mk(new js_ast.ENumber(i), decorator.Value.Loc), decorator.Value,
            ]), decorator.AtLoc));
            args[i].Decorators = [];
          }
        }
      }
    }
    const analysis = analyzeProperty(ctx, p, prop, info);
    let keyExprNoSideEffects = prop.Key;
    if (propertyKeyTempRefs !== null) {
      const ref = propertyKeyTempRefs.get(propIndex);
      if (ref !== undefined) keyExprNoSideEffects.Data = new js_ast.EIdentifier(ref);
    }
    if (analysis.propExperimentalDecorators.length > 0) {
      prop.Decorators = [];
      const loc = prop.Key.Loc;
      let descriptorKind = 1;
      if (prop.Kind === js_ast.PropertyKind.PropertyField || prop.Kind === js_ast.PropertyKind.PropertyDeclareOrAbstract) descriptorKind = 2;
      const target = (prop.Flags & js_ast.PropertyFlags.PropertyIsStatic) !== 0 ? ctx.nameFunc!()
        : mk(initDot(ctx.nameFunc!(), "prototype", loc), loc);
      const values = analysis.propExperimentalDecorators.map(d => d.Value);
      const decorator = p.callRuntime(loc, "__decorateClass", [
        mk(init(new js_ast.EArray(), { Items: values }), loc), target, cloneKeyForLowerClass(keyExprNoSideEffects), mk(new js_ast.ENumber(descriptorKind), loc),
      ]);
      if ((prop.Flags & js_ast.PropertyFlags.PropertyIsStatic) !== 0) ctx.staticExperimentalDecorators.push(decorator);
      else ctx.instanceExperimentalDecorators.push(decorator);
    }
    let initializerIndex = -1;
    if (analysis.propDecorators.length > 0) {
      prop.Decorators = [];
      const loc = prop.Loc, keyLoc = prop.Key.Loc, atLoc = analysis.propDecorators[0].AtLoc;
      let flags = 0;
      switch (prop.Kind) {
        case js_ast.PropertyKind.PropertyMethod: flags = 1; break;
        case js_ast.PropertyKind.PropertyGetter: flags = 2; break;
        case js_ast.PropertyKind.PropertySetter: flags = 3; break;
        case js_ast.PropertyKind.PropertyAutoAccessor: flags = 4; break;
        case js_ast.PropertyKind.PropertyField: flags = 5; break;
      }
      if (flags >= 4) initializerIndex = ctx.decoratorPropertyToInitializerMap?.get(propIndex) ?? 0;
      if ((prop.Flags & js_ast.PropertyFlags.PropertyIsStatic) !== 0) flags |= 8;
      if (analysis.private !== null) flags |= 16;
      let key: js_ast.Expr;
      const decoratorsRef = decoratorTempRefs?.get(propIndex) ?? InvalidRef;
      if (ctx.decoratorContextRef.InnerIndex === InvalidRef.InnerIndex) ctx.decoratorContextRef = p.generateTempRef(generateTempRefArg.tempRefNeedsDeclare, "_init");
      if (analysis.private !== null) key = mk(new js_ast.EString(utf16Of(p.symbols[analysis.private.Ref.InnerIndex].OriginalName)), loc);
      else key = cloneKeyForLowerClass(keyExprNoSideEffects);
      const args: js_ast.Expr[] = [
        mk(new js_ast.EIdentifier(ctx.decoratorContextRef), loc),
        mk(new js_ast.ENumber(flags), loc), key, mk(new js_ast.EIdentifier(decoratorsRef), atLoc),
      ];
      p.recordUsage(ctx.decoratorContextRef); p.recordUsage(decoratorsRef);
      let privateFnRef: Ref = InvalidRef;
      if (analysis.private !== null) {
        args.push(mk(new js_ast.EIdentifier(analysis.private.Ref), keyLoc));
        p.recordUsage(analysis.private.Ref);
        switch (prop.Kind) {
          case js_ast.PropertyKind.PropertyMethod: privateFnRef = p.privateGetters.get(String(analysis.private.Ref.InnerIndex)) ?? InvalidRef; break;
          case js_ast.PropertyKind.PropertyGetter: privateFnRef = p.privateGetters.get(String(analysis.private.Ref.InnerIndex)) ?? InvalidRef; break;
          case js_ast.PropertyKind.PropertySetter: privateFnRef = p.privateSetters.get(String(analysis.private.Ref.InnerIndex)) ?? InvalidRef; break;
        }
        if (privateFnRef.InnerIndex !== InvalidRef.InnerIndex) { args.push(mk(new js_ast.EIdentifier(privateFnRef), keyLoc)); p.recordUsage(privateFnRef); }
      } else args.push(ctx.nameFunc!());
      if (prop.Kind === js_ast.PropertyKind.PropertyAutoAccessor) {
        const kind = (prop.Flags & js_ast.PropertyFlags.PropertyIsStatic) !== 0 ? ast.SymbolKind.SymbolPrivateStaticField : ast.SymbolKind.SymbolPrivateField;
        const ref = p.newSymbol(kind, "#" + propertyNameHint(p, prop.Key));
        p.symbols[ref.InnerIndex].Flags |= ast.SymbolFlags.PrivateSymbolMustBeLowered;
        const [, autoAccessorWeakMapRef, ] = lowerField(ctx, p, prop, new js_ast.EPrivateIdentifier(ref), false, false, initializerIndex);
        args.push(mk(new js_ast.EIdentifier(autoAccessorWeakMapRef), keyLoc)); p.recordUsage(autoAccessorWeakMapRef);
      }
      let element = p.callRuntime(loc, "__decorateElement", args);
      if (privateFnRef.InnerIndex !== InvalidRef.InnerIndex) {
        element = Assign(mk(new js_ast.EIdentifier(privateFnRef), keyLoc), element); p.recordUsage(privateFnRef);
      } else if (prop.Kind === js_ast.PropertyKind.PropertyAutoAccessor && analysis.private !== null) {
        const ref = p.generateTempRef(generateTempRefArg.tempRefNeedsDeclare, "");
        const privateGetFnRef = p.generateTempRef(generateTempRefArg.tempRefNeedsDeclare, "_");
        const privateSetFnRef = p.generateTempRef(generateTempRefArg.tempRefNeedsDeclare, "_");
        p.symbols[privateGetFnRef.InnerIndex].Link = p.privateGetters.get(String(analysis.private.Ref.InnerIndex))!;
        p.symbols[privateSetFnRef.InnerIndex].Link = p.privateSetters.get(String(analysis.private.Ref.InnerIndex))!;
        element = JoinWithComma(JoinWithComma(
          Assign(mk(new js_ast.EIdentifier(ref), loc), element),
          Assign(mk(new js_ast.EIdentifier(privateGetFnRef), keyLoc), mk(initDot(mk(new js_ast.EIdentifier(ref), loc), "get", loc), loc))),
          Assign(mk(new js_ast.EIdentifier(privateSetFnRef), keyLoc), mk(initDot(mk(new js_ast.EIdentifier(ref), loc), "set", loc), loc)));
        p.recordUsage(ref); p.recordUsage(privateGetFnRef); p.recordUsage(privateSetFnRef);
      }
      if (prop.Kind === js_ast.PropertyKind.PropertyField) {
        if ((prop.Flags & js_ast.PropertyFlags.PropertyIsStatic) !== 0) ctx.decoratorStaticFieldElements.push(element);
        else ctx.decoratorInstanceFieldElements.push(element);
      } else {
        if ((prop.Flags & js_ast.PropertyFlags.PropertyIsStatic) !== 0) ctx.decoratorStaticNonFieldElements.push(element);
        else ctx.decoratorInstanceNonFieldElements.push(element);
      }
      if (prop.Kind === js_ast.PropertyKind.PropertyAutoAccessor) {
        if (analysis.private !== null) lowerPrivateMethod(ctx, p, prop, analysis.private);
        continue;
      }
    }
    if (analysis.rewriteAutoAccessorToGetSet) {
      properties = rewriteAutoAccessorToGetSet(ctx, p, prop, properties, keyExprNoSideEffects, analysis.mustLowerField, analysis.private, result);
      continue;
    }
    if ((!js_ast.IsMethodDefinition(prop.Kind) && analysis.mustLowerField) || analysis.staticFieldToBlockAssign) {
      const [p2, , keep] = lowerField(ctx, p, prop, analysis.private, analysis.shouldOmitFieldInitializer, analysis.staticFieldToBlockAssign, initializerIndex);
      if (!keep) continue;
      prop = p2;
    }
    if (js_ast.IsMethodDefinition(prop.Kind) && lowerMethod(ctx, p, prop, analysis.private)) continue;
    properties.push(prop);
  }
  ctx.classValue.Properties = properties;
}

/** Go: (ctx *lowerClassContext) insertInitializersIntoConstructor (js_parser_lower_class.go:1974) */
function insertInitializersIntoConstructor(ctx: lowerClassContext, p: parser, info: classLoweringInfo, result: any): void {
  if (ctx.parameterFieldProps.length > 0) ctx.classValue.Properties = [...ctx.parameterFieldProps, ...ctx.classValue.Properties];
  if (ctx.parameterFields.length === 0 && !ctx.decoratorCallInstanceMethodExtraInitializers &&
      ctx.instancePrivateMethods.length === 0 && ctx.instanceMembers.length === 0 &&
      (ctx.ctor === null || result.superCtorRef.InnerIndex === InvalidRef.InnerIndex)) return;
  if (ctx.ctor === null) {
    const fn = new js_ast.EFunction(); fn.Fn = new js_ast.Fn();
    fn.Fn.Body = new js_ast.FnBody(); fn.Fn.Body.Loc = ctx.classLoc;
    ctx.ctor = fn;
    const ctorProp = new js_ast.Property();
    ctorProp.Kind = js_ast.PropertyKind.PropertyMethod; ctorProp.Loc = ctx.classLoc;
    ctorProp.Key = mk(new js_ast.EString(utf16Of("constructor")), ctx.classLoc); ctorProp.ValueOrNil = mk(fn, ctx.classLoc);
    ctx.classValue.Properties.push(ctorProp);
    if (ctx.classValue.ExtendsOrNil !== null) {
      let target = mk(js_ast.ESuperShared, ctx.classLoc);
      if (info.shimSuperCtorCalls) { p.recordUsage(result.superCtorRef); target = mk(new js_ast.EIdentifier(result.superCtorRef), ctx.classLoc); }
      const argumentsRef = p.newSymbol(ast.SymbolKind.SymbolUnbound, "arguments");
      p.currentScope!.Generated.push(argumentsRef);
      const call = new js_ast.ECall();
      call.Target = target;
      call.Args = [mk(init(new js_ast.ESpread(), { Value: mk(new js_ast.EIdentifier(argumentsRef), ctx.classLoc) }), ctx.classLoc)];
      ctx.ctor.Fn.Body.Block.Stmts.push(new js_ast.Stmt(init(new js_ast.SExpr(), { Value: mk(call, ctx.classLoc) }), ctx.classLoc));
    }
  }
  let decoratorInstanceMethodExtraInitializers: js_ast.Expr | null = null;
  if (ctx.decoratorCallInstanceMethodExtraInitializers) {
    decoratorInstanceMethodExtraInitializers = p.callRuntime(ctx.classLoc, "__runInitializers", [
      mk(new js_ast.EIdentifier(ctx.decoratorContextRef), ctx.classLoc),
      mk(new js_ast.ENumber((2 << 1) | 1), ctx.classLoc),
      mk(js_ast.EThisShared, ctx.classLoc),
    ]);
    p.recordUsage(ctx.decoratorContextRef);
  }
  let generatedStmts: js_ast.Stmt[] = [...ctx.parameterFields];
  if (decoratorInstanceMethodExtraInitializers !== null && decoratorInstanceMethodExtraInitializers.Data !== null)
    generatedStmts.push(new js_ast.Stmt(init(new js_ast.SExpr(), { Value: decoratorInstanceMethodExtraInitializers }), decoratorInstanceMethodExtraInitializers.Loc));
  generatedStmts.push(...ctx.instancePrivateMethods);
  generatedStmts.push(...ctx.instanceMembers);
  insertStmtsAfterSuperCall(p, ctx.ctor.Fn.Body, generatedStmts, result.superCtorRef);
  for (let i = 0; i < ctx.classValue.Properties.length; i++) {
    if (ctx.classValue.Properties[i].ValueOrNil?.Data === ctx.ctor) {
      const ctorProp = ctx.classValue.Properties[i];
      for (let j = i; j > 0; j--) ctx.classValue.Properties[j] = ctx.classValue.Properties[j - 1];
      ctx.classValue.Properties[0] = ctorProp;
      break;
    }
  }
}

/** Go: (ctx *lowerClassContext) finishAndGenerateCode (js_parser_lower_class.go:2054) */
function finishAndGenerateCode(ctx: lowerClassContext, p: parser, result: any): [js_ast.Stmt[], js_ast.Expr] {
  const mustConvertStmtToExpr = ctx.kind !== classKind.classKindExpr && p.currentScope!.Parent === null &&
    (p.options.mode === 2 || p.options.willWrapModuleInTryCatchForUsing);
  let classDecorators: js_ast.Expr = new js_ast.Expr();
  let classExperimentalDecorators: js_ast.Decorator[] = [];
  if (p.options.ts.Parse && p.options.tsExperimentalDecorators) {
    classExperimentalDecorators = ctx.classValue.Decorators;
    ctx.classValue.Decorators = [];
  } else if (ctx.classValue.ShouldLowerStandardDecorators) {
    classDecorators = ctx.decoratorClassDecorators;
  }
  let decorateClassExpr: js_ast.Expr = new js_ast.Expr();
  if (classDecorators.Data !== null) {
    if (ctx.decoratorContextRef.InnerIndex === InvalidRef.InnerIndex) ctx.decoratorContextRef = p.generateTempRef(generateTempRefArg.tempRefNeedsDeclare, "_init");
    decorateClassExpr = p.callRuntime(ctx.classLoc, "__decorateElement", [
      mk(new js_ast.EIdentifier(ctx.decoratorContextRef), ctx.classLoc),
      mk(new js_ast.ENumber(0), ctx.classLoc),
      mk(new js_ast.EString(utf16Of(ctx.nameToKeep)), ctx.classLoc),
      classDecorators,
      ctx.nameFunc!(),
    ]);
    p.recordUsage(ctx.decoratorContextRef);
    decorateClassExpr = Assign(ctx.nameFunc!(), decorateClassExpr);
  } else if (ctx.decoratorContextRef.InnerIndex !== InvalidRef.InnerIndex) {
    decorateClassExpr = p.callRuntime(ctx.classLoc, "__decoratorMetadata", [
      mk(new js_ast.EIdentifier(ctx.decoratorContextRef), ctx.classLoc), ctx.nameFunc!(),
    ]);
  }
  const hasPotentialInnerClassNameEscape = result.innerClassNameRef.InnerIndex !== InvalidRef.InnerIndex &&
    (ctx.computedPropertyChain.Data !== null || ctx.privateMembers.length > 0 || ctx.staticPrivateMethods.length > 0 ||
     ctx.staticMembers.length > 0 || ctx.instanceExperimentalDecorators.length > 0 || ctx.staticExperimentalDecorators.length > 0 ||
     classExperimentalDecorators.length > 0 || ctx.decoratorContextRef.InnerIndex !== InvalidRef.InnerIndex);
  let nameForClassDecorators = new LocRef(new Loc(0), InvalidRef);
  if (classExperimentalDecorators.length > 0 || hasPotentialInnerClassNameEscape || mustConvertStmtToExpr) {
    if (ctx.kind === classKind.classKindExpr) {
      const name = ctx.nameFunc!();
      nameForClassDecorators = new LocRef(name.Loc, (name.Data as js_ast.EIdentifier).Ref);
    } else {
      // Go 是 `nameForClassDecorators = *ctx.class.Name`（结构体值拷贝）；TS 若直接别名同一个
      // LocRef 对象，后面 `ctx.classValue.Name!.Ref = innerClassNameRef` 会把外层绑定的 ref
      // 一起改成内层符号，导致 `var _Foo = class _Foo`（Go 是 `var Foo = class _Foo`）。
      if (ctx.classValue.Name !== null) nameForClassDecorators = new LocRef(ctx.classValue.Name.Loc, ctx.classValue.Name.Ref);
      else if (ctx.kind === classKind.classKindExportDefaultStmt) nameForClassDecorators = ctx.defaultName;
      else nameForClassDecorators = new LocRef(ctx.classLoc, p.generateTempRef(generateTempRefArg.tempRefNoDeclare, ""));
      p.recordUsage(nameForClassDecorators.Ref);
    }
  }
  let prefixExprs: js_ast.Expr[] = [];
  let suffixExprs: js_ast.Expr[] = [];
  if (ctx.decoratorContextRef.InnerIndex !== InvalidRef.InnerIndex) {
    let base = mk(js_ast.ENullShared, ctx.classLoc);
    if (ctx.classValue.ExtendsOrNil !== null) {
      if (ctx.extendsRef.InnerIndex === InvalidRef.InnerIndex) {
        ctx.extendsRef = p.generateTempRef(generateTempRefArg.tempRefNeedsDeclare, "");
        ctx.classValue.ExtendsOrNil = Assign(mk(new js_ast.EIdentifier(ctx.extendsRef), ctx.classValue.ExtendsOrNil.Loc), ctx.classValue.ExtendsOrNil);
        p.recordUsage(ctx.extendsRef);
      }
      base = mk(new js_ast.EIdentifier(ctx.extendsRef), ctx.classLoc);
    }
    suffixExprs.push(Assign(mk(new js_ast.EIdentifier(ctx.decoratorContextRef), ctx.classLoc),
      p.callRuntime(ctx.classLoc, "__decoratorStart", [base])));
    p.recordUsage(ctx.decoratorContextRef);
  }
  if (ctx.computedPropertyChain.Data !== null) prefixExprs.push(ctx.computedPropertyChain);
  suffixExprs.push(...ctx.privateMembers);
  suffixExprs.push(...ctx.decoratorStaticNonFieldElements);
  suffixExprs.push(...ctx.decoratorInstanceNonFieldElements);
  suffixExprs.push(...ctx.decoratorStaticFieldElements);
  suffixExprs.push(...ctx.decoratorInstanceFieldElements);
  suffixExprs.push(...ctx.staticPrivateMethods);
  if (decorateClassExpr.Data !== null) suffixExprs.push(decorateClassExpr);
  if (ctx.decoratorCallStaticMethodExtraInitializers) {
    suffixExprs.push(p.callRuntime(ctx.classLoc, "__runInitializers", [
      mk(new js_ast.EIdentifier(ctx.decoratorContextRef), ctx.classLoc),
      mk(new js_ast.ENumber((1 << 1) | 1), ctx.classLoc),
      ctx.nameFunc!(),
    ]));
    p.recordUsage(ctx.decoratorContextRef);
  }
  suffixExprs.push(...ctx.staticMembers);
  suffixExprs.push(...ctx.instanceExperimentalDecorators);
  suffixExprs.push(...ctx.staticExperimentalDecorators);
  if (classDecorators.Data !== null) {
    suffixExprs.push(p.callRuntime(ctx.classLoc, "__runInitializers", [
      mk(new js_ast.EIdentifier(ctx.decoratorContextRef), ctx.classLoc),
      mk(new js_ast.ENumber((0 << 1) | 1), ctx.classLoc), ctx.nameFunc!(),
    ]));
    p.recordUsage(ctx.decoratorContextRef);
  }
  if (classExperimentalDecorators.length > 0) {
    const values = classExperimentalDecorators.map(d => d.Value);
    suffixExprs.push(Assign(
      mk(new js_ast.EIdentifier(nameForClassDecorators.Ref), nameForClassDecorators.Loc),
      p.callRuntime(ctx.classLoc, "__decorateClass", [
        mk(init(new js_ast.EArray(), { Items: values }), ctx.classLoc),
        mk(new js_ast.EIdentifier(nameForClassDecorators.Ref), nameForClassDecorators.Loc),
      ])));
    p.recordUsage(nameForClassDecorators.Ref);
    p.recordUsage(nameForClassDecorators.Ref);
  }

  if (ctx.kind === classKind.classKindExpr) {
    let nameToJoin: js_ast.Expr = new js_ast.Expr();
    if (ctx.didCaptureClassExpr || suffixExprs.length > 0) nameToJoin = ctx.nameFunc!();
    ctx.classExpr = JoinWithComma(JoinAllWithComma(prefixExprs), ctx.classExpr);
    ctx.classExpr = JoinWithComma(ctx.classExpr, JoinAllWithComma(suffixExprs));
    ctx.classExpr = JoinWithComma(ctx.classExpr, nameToJoin);
    if (ctx.wrapFunc !== null) ctx.classExpr = ctx.wrapFunc(ctx.classExpr);
    return [[], ctx.classExpr];
  }

  let stmts: js_ast.Stmt[] = [];
  let outerClassNameDecl: js_ast.Stmt | null = null;
  for (const expr of prefixExprs) stmts.push(new js_ast.Stmt(init(new js_ast.SExpr(), { Value: expr }), expr.Loc));
  if (nameForClassDecorators.Ref.InnerIndex !== InvalidRef.InnerIndex) {
    const classExpr = new js_ast.EClass(); classExpr.Class = ctx.classValue;
    ctx.classValue = classExpr.Class;
    const initExpr = mk(classExpr, ctx.classLoc);
    if (result.innerClassNameRef.InnerIndex !== InvalidRef.InnerIndex) ctx.classValue.Name!.Ref = result.innerClassNameRef;
    else ctx.classValue.Name = null;
    if (classExperimentalDecorators.length > 0) {
      p.recordUsage(nameForClassDecorators.Ref);
      const local = new js_ast.SLocal();
      local.Kind = p.selectLocalKind(js_ast.LocalKind.LocalLet);
      local.IsExport = ctx.kind === classKind.classKindExportStmt;
      local.Decls = [init(new js_ast.Decl(), {
        Binding: init(new js_ast.Binding(), { Data: new js_ast.BIdentifier(nameForClassDecorators.Ref), Loc: nameForClassDecorators.Loc }),
        ValueOrNil: initExpr,
      })];
      stmts.push(new js_ast.Stmt(local, ctx.classLoc));
      if (ctx.classValue.Name !== null) { p.mergeSymbols(ctx.classValue.Name.Ref, nameForClassDecorators.Ref); ctx.classValue.Name = null; }
    } else if (hasPotentialInnerClassNameEscape) {
      const captureRef = p.newSymbol(ast.SymbolKind.SymbolOther, p.symbols[result.innerClassNameRef.InnerIndex].OriginalName);
      p.currentScope!.Generated.push(captureRef);
      p.recordDeclaredSymbol(captureRef);
      p.mergeSymbols(result.innerClassNameRef, captureRef);
      let kind: js_ast.LocalKind = js_ast.LocalKind.LocalConst;
      if (classDecorators.Data !== null) kind = js_ast.LocalKind.LocalLet;
      const local = new js_ast.SLocal();
      local.Kind = p.selectLocalKind(kind);
      local.Decls = [init(new js_ast.Decl(), {
        Binding: init(new js_ast.Binding(), { Data: new js_ast.BIdentifier(captureRef), Loc: nameForClassDecorators.Loc }),
        ValueOrNil: initExpr,
      })];
      stmts.push(new js_ast.Stmt(local, ctx.classLoc));
      p.recordUsage(nameForClassDecorators.Ref); p.recordUsage(captureRef);
      const outerLocal = new js_ast.SLocal();
      outerLocal.Kind = p.selectLocalKind(js_ast.LocalKind.LocalLet);
      outerLocal.IsExport = ctx.kind === classKind.classKindExportStmt;
      outerLocal.Decls = [init(new js_ast.Decl(), {
        Binding: init(new js_ast.Binding(), { Data: new js_ast.BIdentifier(nameForClassDecorators.Ref), Loc: nameForClassDecorators.Loc }),
        ValueOrNil: mk(new js_ast.EIdentifier(captureRef), ctx.classLoc),
      })];
      outerClassNameDecl = new js_ast.Stmt(outerLocal, ctx.classLoc);
    } else {
      p.recordUsage(nameForClassDecorators.Ref);
      const local = new js_ast.SLocal();
      local.Kind = p.selectLocalKind(js_ast.LocalKind.LocalLet);
      local.IsExport = ctx.kind === classKind.classKindExportStmt;
      local.Decls = [init(new js_ast.Decl(), {
        Binding: init(new js_ast.Binding(), { Data: new js_ast.BIdentifier(nameForClassDecorators.Ref), Loc: nameForClassDecorators.Loc }),
        ValueOrNil: initExpr,
      })];
      stmts.push(new js_ast.Stmt(local, ctx.classLoc));
    }
  } else {
    let classStmt: js_ast.S;
    if (ctx.kind === classKind.classKindStmt) {
      const sc = new js_ast.SClass(); sc.Class = ctx.classValue; classStmt = sc;
    } else if (ctx.kind === classKind.classKindExportStmt) {
      const sc = new js_ast.SClass(); sc.Class = ctx.classValue; sc.IsExport = true; classStmt = sc;
    } else {
      const sd = new js_ast.SExportDefault();
      sd.DefaultName = ctx.defaultName;
      const sc = new js_ast.SClass(); sc.Class = ctx.classValue;
      sd.Value = new js_ast.Stmt(sc, ctx.classLoc);
      classStmt = sd;
    }
    stmts.push(new js_ast.Stmt(classStmt, ctx.classLoc));
    if (ctx.classValue.Name !== null && result.innerClassNameRef.InnerIndex !== InvalidRef.InnerIndex) {
      if (p.currentScope!.ContainsDirectEval) p.symbols[ctx.classValue.Name.Ref.InnerIndex].Flags |= (p.symbols[result.innerClassNameRef.InnerIndex].Flags & ast.SymbolFlags.MustNotBeRenamed);
      p.mergeSymbols(result.innerClassNameRef, ctx.classValue.Name.Ref);
    }
  }
  for (const expr of suffixExprs) stmts.push(new js_ast.Stmt(init(new js_ast.SExpr(), { Value: expr }), expr.Loc));
  if (outerClassNameDecl !== null) stmts.push(outerClassNameDecl);
  if (nameForClassDecorators.Ref.InnerIndex !== InvalidRef.InnerIndex && ctx.kind === classKind.classKindExportDefaultStmt) {
    const ec = new js_ast.SExportClause();
    const item = new js_ast.ClauseItem(); item.Alias = "default"; item.Name = ctx.defaultName;
    ec.Items = [item];
    stmts.push(new js_ast.Stmt(ec, ctx.classLoc));
  }
  return [stmts, new js_ast.Expr()];
}

/** Go: func (p *parser) lowerClass(...) (js_parser_lower_class.go:683) —— 入口 */
export function lowerClass(
  p: parser, stmt: js_ast.Stmt, expr: js_ast.Expr, result: any, nameToKeep: string,
): [js_ast.Stmt[], js_ast.Expr] {
  const ctx = new lowerClassContext();
  ctx.nameToKeep = nameToKeep;
  ctx.extendsRef = InvalidRef;
  ctx.decoratorContextRef = InvalidRef;
  ctx.privateInstanceMethodRef = InvalidRef;
  ctx.privateStaticMethodRef = InvalidRef;
  if (stmt.Data === null) {
    const e = expr.Data as js_ast.EClass;
    ctx.classValue = e.Class;
    ctx.classExpr = expr;
    ctx.kind = classKind.classKindExpr;
    if (ctx.classValue.Name !== null) {
      const symbol = p.symbols[ctx.classValue.Name.Ref.InnerIndex];
      ctx.nameToKeep = symbol.OriginalName;
      if (result.innerClassNameRef.InnerIndex !== InvalidRef.InnerIndex) p.mergeSymbols(result.innerClassNameRef, ctx.classValue.Name.Ref);
      if (p.options.minifySyntax && symbol.UseCountEstimate === 0) ctx.classValue.Name = null;
    }
  } else if (stmt.Data instanceof js_ast.SClass) {
    ctx.classValue = stmt.Data.Class;
    if (ctx.classValue.Name !== null) ctx.nameToKeep = p.symbols[ctx.classValue.Name.Ref.InnerIndex].OriginalName;
    ctx.kind = stmt.Data.IsExport ? classKind.classKindExportStmt : classKind.classKindStmt;
  } else {
    const s = stmt.Data as js_ast.SExportDefault;
    const s2 = s.Value.Data as js_ast.SClass;
    ctx.classValue = s2.Class;
    if (ctx.classValue.Name !== null) ctx.nameToKeep = p.symbols[ctx.classValue.Name.Ref.InnerIndex].OriginalName;
    ctx.defaultName = s.DefaultName;
    ctx.kind = classKind.classKindExportDefaultStmt;
  }
  ctx.classLoc = stmt.Data === null ? expr.Loc : stmt.Loc;
  const classLoweringInfo = computeClassLoweringInfo(p, ctx.classValue);
  enableNameCapture(ctx, p, result);
  processProperties(ctx, p, classLoweringInfo, result);
  insertInitializersIntoConstructor(ctx, p, classLoweringInfo, result);
  return finishAndGenerateCode(ctx, p, result);
}
