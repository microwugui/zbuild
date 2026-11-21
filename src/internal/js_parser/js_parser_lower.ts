// 1:1 移植自 esbuild internal/js_parser/js_parser_lower.go（v0.28.2，f6058f83）
//
// strict-mode 闭包：isStrictMode / isStrictModeOutputFormat / whyStrictMode /
// markStrictModeFeature。Go 行号 132/136/155/205。第 29 轮落地，供 E-s1c 的
// EIdentifier 分支（validateDeclaredSymbolName）使用。
import * as js_ast from "../js_ast/js_ast.ts";
import * as js_ast_helpers from "../js_ast/js_ast_helpers.ts";
import { Assign, JoinWithComma, ConvertBindingToExpr, CouldHaveSideEffects, NoSideEffects } from "../js_ast/js_ast_helpers.ts";
import { Has as HasFeature, JSFeature } from "../compat/compat.ts";
import { AddError, AddErrorWithNotes, MakeLineColumnTracker, MsgData, Range, Loc } from "../logger/logger.ts";
import * as ast from "../ast/ast.ts";
import { Ref } from "../ast/ast.ts";
import { StringToUTF16, UTF16EqualsString } from "../helpers/utf.ts";
import { init as initObj } from "../helpers/init.ts";
import { goQuoted, generateTempRefArg } from "./js_parser.ts";
import type { parser } from "./js_parser.ts";
import { extractPrivateIndex, extractSuperProperty, lowerPrivateSet, lowerPrivateGet, lowerPrivateSetBinOp, lowerSuperPropertySetBinOp, lowerSuperPropertyOrPrivateInAssign, lowerSuperPropertyGet, shouldLowerSuperPropertyAccess, privateSymbolNeedsToBeLowered } from "./js_parser_lower_class.ts";

/** Go: type strictModeFeature uint8 (js_parser_lower.go:138) */
export type strictModeFeature = number;
export const strictModeFeature = {
  withStatement: 0,
  deleteBareName: 1,
  forInVarInit: 2,
  evalOrArguments: 3,
  reservedWord: 4,
  legacyOctalLiteral: 5,
  legacyOctalEscape: 6,
  ifElseFunctionStmt: 7,
  labelFunctionStmt: 8,
  duplicateLexicallyDeclaredNames: 9,
} as const;

/** Go: type whyESM uint8 (js_parser.go:18269) */
export type whyESM = number;
export const whyESM = {
  whyESMUnknown: 0,
  whyESMExportKeyword: 1,
  whyESMImportMeta: 2,
  whyESMTopLevelAwait: 3,
  whyESMFileMJS: 4,
  whyESMFileMTS: 5,
  whyESMTypeModulePackageJSON: 6,
  whyESMImportStatement: 7,
} as const;

/** Go: func couldPotentiallyThrow(data js_ast.E) bool (js_parser_lower.go:1886) */
export function couldPotentiallyThrow(data: js_ast.E | null): boolean {
  if (
    data instanceof js_ast.ENull || data instanceof js_ast.EUndefined ||
    data instanceof js_ast.EBoolean || data instanceof js_ast.ENumber ||
    data instanceof js_ast.EBigInt || data instanceof js_ast.EString ||
    data instanceof js_ast.EFunction || data instanceof js_ast.EArrow
  ) {
    return false;
  }
  return true;
}

/** Go: func (p *parser) isStrictMode() bool (js_parser_lower.go:132) */
export function isStrictMode(p: parser): boolean {
  return p.currentScope!.StrictMode !== js_ast.StrictModeKind.SloppyMode;
}

/** Go: func (p *parser) isStrictModeOutputFormat() bool (js_parser_lower.go:136) */
export function isStrictModeOutputFormat(p: parser): boolean {
  return p.options.outputFormat === 3; // Go: config.FormatESModule
}


/** Go: func (p *parser) whyStrictMode(scope *js_ast.Scope) (string, []logger.MsgData) (js_parser_lower.go:205) */
export function whyStrictMode(p: parser, scope: js_ast.Scope): [string, MsgData[] | null] {
  let where = "in strict mode";
  let notes: MsgData[] | null = null;
  switch (scope.StrictMode) {
    case js_ast.StrictModeKind.ImplicitStrictModeClass:
      notes = [p.tracker.MsgData(p.enclosingClassKeyword, "All code inside a class is implicitly in strict mode")];
      break;
    case js_ast.StrictModeKind.ImplicitStrictModeTSAlwaysStrict: {
      const ts = p.options.tsAlwaysStrict!;
      const t = MakeLineColumnTracker(ts.Source!);
      notes = [t.MsgData(ts.Range, `TypeScript's ${goQuoted(ts.Name)} setting was enabled here:`)];
      break;
    }
    case js_ast.StrictModeKind.ImplicitStrictModeJSXAutomaticRuntime:
      notes = [
        p.tracker.MsgData(new Range(p.firstJSXElementLoc, 1), "This file is implicitly in strict mode due to the JSX element here:"),
        initObj(new MsgData(), {
          Text: 'When React\'s "automatic" JSX transform is enabled, using a JSX element automatically inserts ' +
            'an "import" statement at the top of the file for the corresponding the JSX helper function. ' +
            'This means the file is considered an ECMAScript module, and all ECMAScript modules use strict mode.',
        }),
      ];
      break;
    case js_ast.StrictModeKind.ExplicitStrictMode:
      notes = [p.tracker.MsgData(
        p.source.RangeOfString(scope.UseStrictLoc),
        'Strict mode is triggered by the "use strict" directive here:',
      )];
      break;
    case js_ast.StrictModeKind.ImplicitStrictModeESM:
      [, notes] = p.whyESModule();
      where = "in an ECMAScript module";
      break;
  }
  return [where, notes];
}

/** Go: func (p *parser) markStrictModeFeature(feature strictModeFeature, r logger.Range, detail string) (js_parser_lower.go:155) */
export function markStrictModeFeature(p: parser, feature: strictModeFeature, r: Range, detail: string): void {
  let text = "";
  let canBeTransformed = false;
  switch (feature) {
    case strictModeFeature.withStatement: text = "With statements"; break;
    case strictModeFeature.deleteBareName: text = "Delete of a bare identifier"; break;
    case strictModeFeature.forInVarInit: text = "Variable initializers inside for-in loops"; canBeTransformed = true; break;
    case strictModeFeature.evalOrArguments: text = `Declarations with the name ${goQuoted(detail)}`; break;
    case strictModeFeature.reservedWord: text = `${goQuoted(detail)} is a reserved word and`; break;
    case strictModeFeature.legacyOctalLiteral: text = "Legacy octal literals"; break;
    case strictModeFeature.legacyOctalEscape: text = "Legacy octal escape sequences"; break;
    case strictModeFeature.ifElseFunctionStmt: text = "Function declarations inside if statements"; break;
    case strictModeFeature.labelFunctionStmt: text = "Function declarations inside labels"; break;
    case strictModeFeature.duplicateLexicallyDeclaredNames: text = "Duplicate lexically-declared names"; break;
    default: text = "This feature";
  }

  if (isStrictMode(p)) {
    const [where, notes] = whyStrictMode(p, p.currentScope!);
    AddErrorWithNotes(p.log, p.tracker, r, `${text} cannot be used ${where}`, notes ?? []);
  } else if (!canBeTransformed && isStrictModeOutputFormat(p)) {
    AddError(p.log, p.tracker, r, `${text} cannot be used with the "esm" output format due to strict mode`);
  }
}

// ---------------------------------------------------------------------------
// 第 40 轮：lowering 主链（js_parser_lower.go 的「纯」降级函数）。
// es2015/16/17 三档实测置位 OptionalChain/Nullish/LogicalAssignment/
// ObjectRestSpread/ExponentOperator/AsyncAwait，但 TS 的 visit pass 此前一个都没接，
// 故三档字节长期停在 3592/3630/3797。这里 1:1 移植并在 visitExprInOut 接线。
// receiver 用首参 p: parser（与 js_parser_lower_class.ts 同口径）。
// ---------------------------------------------------------------------------

function mkExpr(data: js_ast.E | null, loc: Loc): js_ast.Expr {
  return new js_ast.Expr(data, loc);
}

/** Go: func (p *parser) lowerNullishCoalescing(loc, left, right) Expr (js_parser_lower.go:966) */
export function lowerNullishCoalescing(p: parser, loc: Loc, left: js_ast.Expr, right: js_ast.Expr): js_ast.Expr {
  // "x ?? y" => "x != null ? x : y"
  const [leftFunc, wrapFunc] = p.captureValueWithPossibleSideEffects(loc, 2, left, 0 /* valueDefinitelyNotMutated */);
  return wrapFunc(mkExpr(initObj(new js_ast.EIf(), {
    Test: mkExpr(initObj(new js_ast.EBinary(), {
      Op: js_ast.OpCode.BinOpLooseNe,
      Left: leftFunc(),
      Right: mkExpr(js_ast.ENullShared, loc),
    }), loc),
    Yes: leftFunc(),
    No: right,
  }), loc));
}

/** Go: func (p *parser) lowerAssignmentOperator(value, callback) Expr (js_parser_lower.go:816) */
export function lowerAssignmentOperator(
  p: parser,
  value: js_ast.Expr,
  callback: (a: js_ast.Expr, b: js_ast.Expr) => js_ast.Expr,
): js_ast.Expr {
  const left = value.Data;
  if (left instanceof js_ast.EDot) {
    if (left.OptionalChain === js_ast.OptionalChain.OptionalChainNone) {
      const [referenceFunc, wrapFunc] = p.captureValueWithPossibleSideEffects(value.Loc, 2, left.Target, 0);
      const mk = (): js_ast.Expr => mkExpr(initObj(new js_ast.EDot(), { Target: referenceFunc(), Name: left.Name, NameLoc: left.NameLoc }), value.Loc);
      return wrapFunc(callback(mk(), mk()));
    }
  } else if (left instanceof js_ast.EIndex) {
    if (left.OptionalChain === js_ast.OptionalChain.OptionalChainNone) {
      const [targetFunc, targetWrapFunc] = p.captureValueWithPossibleSideEffects(value.Loc, 2, left.Target, 0);
      const [indexFunc, indexWrapFunc] = p.captureValueWithPossibleSideEffects(value.Loc, 2, left.Index, 0);
      const mk = (): js_ast.Expr => mkExpr(initObj(new js_ast.EIndex(), { Target: targetFunc(), Index: indexFunc() }), value.Loc);
      return targetWrapFunc(indexWrapFunc(callback(mk(), mk())));
    }
  } else if (left instanceof js_ast.EIdentifier) {
    p.recordUsage(left.Ref);
    return callback(mkExpr(new js_ast.EIdentifier(left.Ref), value.Loc), value);
  }
  return value;
}

/** Go: func (p *parser) lowerExponentiationAssignmentOperator(loc, e) Expr (js_parser_lower.go:884) */
export function lowerExponentiationAssignmentOperator(p: parser, loc: Loc, e: js_ast.EBinary): js_ast.Expr {
  const pi = extractPrivateIndex(p, e.Left);
  if (pi !== null) {
    const [targetFunc, targetWrapFunc] = p.captureValueWithPossibleSideEffects(loc, 2, pi.target, 0);
    return targetWrapFunc(lowerPrivateSet(p, targetFunc(), pi.loc, pi.private,
      p.callRuntime(loc, "__pow", [lowerPrivateGet(p, targetFunc(), pi.loc, pi.private), e.Right])));
  }
  return lowerAssignmentOperator(p, e.Left, (a, b) =>
    js_ast_helpers.Assign(a, p.callRuntime(loc, "__pow", [b, e.Right])));
}

/** Go: func (p *parser) lowerNullishCoalescingAssignmentOperator(loc, e) (Expr, bool) (js_parser_lower.go:901) */
export function lowerNullishCoalescingAssignmentOperator(p: parser, loc: Loc, e: js_ast.EBinary): [js_ast.Expr, boolean] {
  const pi = extractPrivateIndex(p, e.Left);
  if (pi !== null) {
    if (HasFeature(p.options.unsupportedJSFeatures, JSFeature.NullishCoalescing)) {
      const [targetFunc, targetWrapFunc] = p.captureValueWithPossibleSideEffects(loc, 2, pi.target, 0);
      const left = lowerPrivateGet(p, targetFunc(), pi.loc, pi.private);
      const right = lowerPrivateSet(p, targetFunc(), pi.loc, pi.private, e.Right);
      return [targetWrapFunc(lowerNullishCoalescing(p, loc, left, right)), true];
    }
    const [targetFunc, targetWrapFunc] = p.captureValueWithPossibleSideEffects(loc, 2, pi.target, 0);
    return [targetWrapFunc(mkExpr(initObj(new js_ast.EBinary(), {
      Op: js_ast.OpCode.BinOpNullishCoalescing,
      Left: lowerPrivateGet(p, targetFunc(), pi.loc, pi.private),
      Right: lowerPrivateSet(p, targetFunc(), pi.loc, pi.private, e.Right),
    }), loc)), true];
  }

  if (HasFeature(p.options.unsupportedJSFeatures, JSFeature.LogicalAssignment)) {
    return [lowerAssignmentOperator(p, e.Left, (a, b) => {
      if (HasFeature(p.options.unsupportedJSFeatures, JSFeature.NullishCoalescing)) {
        // "a ??= b" => "(_a = a) != null ? _a : a = b"
        return lowerNullishCoalescing(p, loc, a, js_ast_helpers.Assign(b, e.Right));
      }
      // "a ??= b" => "a ?? (a = b)"
      return mkExpr(initObj(new js_ast.EBinary(), {
        Op: js_ast.OpCode.BinOpNullishCoalescing,
        Left: a,
        Right: js_ast_helpers.Assign(b, e.Right),
      }), loc);
    }), true];
  }
  return [new js_ast.Expr(), false];
}

/** Go: func (p *parser) lowerLogicalAssignmentOperator(loc, e, op) (Expr, bool) (js_parser_lower.go:939) */
export function lowerLogicalAssignmentOperator(p: parser, loc: Loc, e: js_ast.EBinary, op: js_ast.OpCode): [js_ast.Expr, boolean] {
  const pi = extractPrivateIndex(p, e.Left);
  if (pi !== null) {
    const [targetFunc, targetWrapFunc] = p.captureValueWithPossibleSideEffects(loc, 2, pi.target, 0);
    return [targetWrapFunc(mkExpr(initObj(new js_ast.EBinary(), {
      Op: op,
      Left: lowerPrivateGet(p, targetFunc(), pi.loc, pi.private),
      Right: lowerPrivateSet(p, targetFunc(), pi.loc, pi.private, e.Right),
    }), loc)), true];
  }

  if (HasFeature(p.options.unsupportedJSFeatures, JSFeature.LogicalAssignment)) {
    return [lowerAssignmentOperator(p, e.Left, (a, b) =>
      mkExpr(initObj(new js_ast.EBinary(), {
        Op: op,
        Left: a,
        Right: js_ast_helpers.Assign(b, e.Right),
      }), loc)), true];
  }
  return [new js_ast.Expr(), false];
}

/** Go: func (p *parser) maybeLowerSetBinOp(left, op, right) Expr (js_parser_lower.go:1896) */
export function maybeLowerSetBinOp(p: parser, left: js_ast.Expr, op: js_ast.OpCode, right: js_ast.Expr): js_ast.Expr {
  const pi = extractPrivateIndex(p, left);
  if (pi !== null) return lowerPrivateSetBinOp(p, pi.target, pi.loc, pi.private, op, right);
  const property = extractSuperProperty(p, left);
  if (property !== null) return lowerSuperPropertySetBinOp(p, left.Loc, property, op, right);
  return new js_ast.Expr();
}

/** Go: func (p *parser) lowerObjectSpread(loc, e) Expr (js_parser_lower.go:1010) */
export function lowerObjectSpread(p: parser, loc: Loc, e: js_ast.EObject): js_ast.Expr {
  let needsLowering = false;
  if (HasFeature(p.options.unsupportedJSFeatures, JSFeature.ObjectRestSpread)) {
    for (const property of e.Properties) {
      if (property.Kind === js_ast.PropertyKind.PropertySpread) { needsLowering = true; break; }
    }
  }
  if (!needsLowering) return mkExpr(e, loc);

  let result: js_ast.Expr = new js_ast.Expr();
  let properties: js_ast.Property[] = [];
  for (const property of e.Properties) {
    if (property.Kind !== js_ast.PropertyKind.PropertySpread) { properties.push(property); continue; }
    if (properties.length > 0 || result.Data === null) {
      if (result.Data === null) {
        result = mkExpr(initObj(new js_ast.EObject(), { Properties: properties, IsSingleLine: e.IsSingleLine }), loc);
      } else {
        result = p.callRuntime(loc, "__spreadProps", [result, mkExpr(initObj(new js_ast.EObject(), { Properties: properties, IsSingleLine: e.IsSingleLine }), loc)]);
      }
      properties = [];
    }
    result = p.callRuntime(loc, "__spreadValues", [result, property.ValueOrNil ?? new js_ast.Expr()]);
  }
  if (properties.length > 0) {
    result = p.callRuntime(loc, "__spreadProps", [result, mkExpr(initObj(new js_ast.EObject(), {
      Properties: properties, IsSingleLine: e.IsSingleLine, CloseBraceLoc: e.CloseBraceLoc,
    }), loc)]);
  }
  return result;
}

/** Go: func bindingHasObjectRest(binding) bool (js_parser_lower.go:1277) */
export function bindingHasObjectRest(binding: js_ast.Binding): boolean {
  const b = binding.Data;
  if (b instanceof js_ast.BArray) {
    for (const item of b.Items) if (bindingHasObjectRest(item.Binding)) return true;
  } else if (b instanceof js_ast.BObject) {
    for (const property of b.Properties) {
      if (property.IsSpread || bindingHasObjectRest(property.Value)) return true;
    }
  }
  return false;
}

/** Go: func exprHasObjectRest(expr) bool (js_parser_lower.go:1295) */
export function exprHasObjectRest(expr: js_ast.Expr): boolean {
  const e = expr.Data;
  if (e instanceof js_ast.EBinary) {
    if (e.Op === js_ast.OpCode.BinOpAssign && exprHasObjectRest(e.Left)) return true;
  } else if (e instanceof js_ast.EArray) {
    for (const item of e.Items) if (exprHasObjectRest(item)) return true;
  } else if (e instanceof js_ast.EObject) {
    for (const property of e.Properties) {
      if (property.Kind === js_ast.PropertyKind.PropertySpread || exprHasObjectRest(property.ValueOrNil ?? new js_ast.Expr())) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 可选链降级（js_parser_lower.go:495-814）。exprIn/exprOut 用 type-only import
// 避免运行时循环（js_parser.ts ←→ js_parser_lower.ts 已有 goQuoted 值循环，惰性求值）。
// ---------------------------------------------------------------------------

/** Go: func (p *parser) lowerOptionalChain(expr, in, childOut) (Expr, exprOut) (js_parser_lower.go:495) */
export function lowerOptionalChain(
  p: parser,
  expr: js_ast.Expr,
  visitIn: import("./js_parser.ts").exprIn,
  childOut: import("./js_parser.ts").exprOut,
  out: import("./js_parser.ts").exprOut,
): js_ast.Expr {
  const loc = expr.Loc;
  let valueWhenUndefined: js_ast.Expr = mkExpr(js_ast.EUndefinedShared, loc);
  let endsWithPropertyAccess = false;
  let containsPrivateName = false;
  let startsWithCall = false;
  const originalExpr = expr;
  const chain: js_ast.Expr[] = [];

  // Step 1: flatten chain (outside-in → backwards-filled array)
  flatten: for (;;) {
    chain.push(expr);
    const d = expr.Data;
    if (d instanceof js_ast.EDot) {
      expr = d.Target;
      if (chain.length === 1) endsWithPropertyAccess = true;
      if (d.OptionalChain === js_ast.OptionalChain.OptionalChainStart) break flatten;
    } else if (d instanceof js_ast.EIndex) {
      expr = d.Target;
      if (chain.length === 1) endsWithPropertyAccess = true;
      if (d.Index.Data instanceof js_ast.EPrivateIdentifier && privateSymbolNeedsToBeLowered(p, d.Index.Data)) {
        containsPrivateName = true;
      }
      if (d.OptionalChain === js_ast.OptionalChain.OptionalChainStart) break flatten;
    } else if (d instanceof js_ast.ECall) {
      expr = d.Target;
      if (d.OptionalChain === js_ast.OptionalChain.OptionalChainStart) { startsWithCall = true; break flatten; }
    } else if (d instanceof js_ast.EUnary) {
      valueWhenUndefined = mkExpr(new js_ast.EBoolean(true), loc);
      expr = d.Value;
    } else {
      throw new Error("Internal error: lowerOptionalChain");
    }
  }

  // dead code elimination
  if (p.options.minifySyntax) {
    const [isNullOrUndefined, sideEffects, ok] = js_ast_helpers.ToNullOrUndefinedWithSideEffects(expr.Data);
    if (ok && isNullOrUndefined) {
      if (sideEffects === CouldHaveSideEffects) {
        return js_ast_helpers.JoinWithComma(p.astHelpers.SimplifyUnusedExpr(expr, p.options.unsupportedJSFeatures), valueWhenUndefined);
      }
      return valueWhenUndefined;
    }
  } else if (expr.Data instanceof js_ast.ENull || expr.Data instanceof js_ast.EUndefined) {
    return valueWhenUndefined;
  }

  // optional call off a private name needs this capture
  if (extractPrivateIndex(p, expr) !== null) containsPrivateName = true;

  if (!HasFeature(p.options.unsupportedJSFeatures, JSFeature.OptionalChain) && !containsPrivateName) {
    return originalExpr;
  }

  // Step 2: capture value for "this" for initial ECall
  let thisArg: js_ast.Expr = new js_ast.Expr();
  let targetWrapFunc: ((e: js_ast.Expr) => js_ast.Expr) | null = null;
  if (startsWithCall) {
    if (childOut.thisArgFunc !== null) {
      thisArg = childOut.thisArgFunc();
    } else {
      const d = expr.Data;
      if (d instanceof js_ast.EDot) {
        if (d.Target.Data instanceof js_ast.ESuper) {
          if (shouldLowerSuperPropertyAccess(p, d.Target)) {
            const key = mkExpr(new js_ast.EString(new Uint16Array(StringToUTF16(new TextEncoder().encode(d.Name)))), d.NameLoc);
            expr = lowerSuperPropertyGet(p, expr.Loc, key);
          }
          thisArg = mkExpr(js_ast.EThisShared, loc);
        } else {
          const [targetFunc, wrapFunc] = p.captureValueWithPossibleSideEffects(loc, 2, d.Target, 0);
          expr = mkExpr(initObj(new js_ast.EDot(), { Target: targetFunc(), Name: d.Name, NameLoc: d.NameLoc }), loc);
          thisArg = targetFunc();
          targetWrapFunc = wrapFunc;
        }
      } else if (d instanceof js_ast.EIndex) {
        if (d.Target.Data instanceof js_ast.ESuper) {
          if (shouldLowerSuperPropertyAccess(p, d.Target)) expr = lowerSuperPropertyGet(p, expr.Loc, d.Index);
          thisArg = mkExpr(js_ast.EThisShared, loc);
        } else {
          const [targetFunc, wrapFunc] = p.captureValueWithPossibleSideEffects(loc, 2, d.Target, 0);
          targetWrapFunc = wrapFunc;
          if (d.Index.Data instanceof js_ast.EPrivateIdentifier && privateSymbolNeedsToBeLowered(p, d.Index.Data)) {
            expr = lowerPrivateGet(p, targetFunc(), d.Index.Loc, d.Index.Data);
            thisArg = targetFunc();
          } else {
            expr = mkExpr(initObj(new js_ast.EIndex(), { Target: targetFunc(), Index: d.Index }), loc);
            thisArg = targetFunc();
          }
        }
      }
    }
  }

  // Step 3: capture starting value
  const [exprFunc, exprWrapFunc] = p.captureValueWithPossibleSideEffects(loc, 2, expr, 0);
  expr = exprFunc();
  let result = exprFunc();

  // Step 4: wrap by each expression, inside-out
  let parentThisArgFunc: (() => js_ast.Expr) | null = null;
  let parentThisArgWrapFunc: ((e: js_ast.Expr) => js_ast.Expr) | null = null;
  let privateThisFunc: (() => js_ast.Expr) | null = null;
  let privateThisWrapFunc: ((e: js_ast.Expr) => js_ast.Expr) | null = null;
  for (let i = chain.length - 1; i >= 0; i--) {
    if (i === 0 && visitIn.storeThisArgForParentOptionalChain && endsWithPropertyAccess) {
      [parentThisArgFunc, parentThisArgWrapFunc] = p.captureValueWithPossibleSideEffects(result.Loc, 2, result, 0);
      result = parentThisArgFunc();
    }
    const c = chain[i].Data;
    if (c instanceof js_ast.EDot) {
      result = mkExpr(initObj(new js_ast.EDot(), { Target: result, Name: c.Name, NameLoc: c.NameLoc }), loc);
    } else if (c instanceof js_ast.EIndex) {
      if (c.Index.Data instanceof js_ast.EPrivateIdentifier && privateSymbolNeedsToBeLowered(p, c.Index.Data)) {
        if (i > 0 && chain[i - 1].Data instanceof js_ast.ECall) {
          [privateThisFunc, privateThisWrapFunc] = p.captureValueWithPossibleSideEffects(loc, 2, result, 0);
          result = privateThisFunc();
        }
        result = lowerPrivateGet(p, result, c.Index.Loc, c.Index.Data);
        continue;
      }
      result = mkExpr(initObj(new js_ast.EIndex(), { Target: result, Index: c.Index }), loc);
    } else if (c instanceof js_ast.ECall) {
      if (i === chain.length - 1 && thisArg.Data !== null) {
        result = mkExpr(initObj(new js_ast.ECall(), {
          Target: mkExpr(initObj(new js_ast.EDot(), { Target: result, Name: "call", NameLoc: loc }), loc),
          Args: [thisArg, ...c.Args],
          CanBeUnwrappedIfUnused: c.CanBeUnwrappedIfUnused,
          IsMultiLine: c.IsMultiLine,
          Kind: js_ast.CallKind.TargetWasOriginallyPropertyAccess,
        }), loc);
        break;
      }
      if (privateThisFunc !== null) {
        result = privateThisWrapFunc!(mkExpr(initObj(new js_ast.ECall(), {
          Target: mkExpr(initObj(new js_ast.EDot(), { Target: result, Name: "call", NameLoc: loc }), loc),
          Args: [privateThisFunc(), ...c.Args],
          CanBeUnwrappedIfUnused: c.CanBeUnwrappedIfUnused,
          IsMultiLine: c.IsMultiLine,
          Kind: js_ast.CallKind.TargetWasOriginallyPropertyAccess,
        }), loc));
        privateThisFunc = null;
        break;
      }
      result = mkExpr(initObj(new js_ast.ECall(), {
        Target: result, Args: c.Args,
        CanBeUnwrappedIfUnused: c.CanBeUnwrappedIfUnused,
        IsMultiLine: c.IsMultiLine, Kind: c.Kind,
      }), loc);
    } else if (c instanceof js_ast.EUnary) {
      result = mkExpr(initObj(new js_ast.EUnary(), {
        Op: js_ast.OpCode.UnOpDelete, Value: result,
        WasOriginallyDeleteOfIdentifierOrPropertyAccess: c.WasOriginallyDeleteOfIdentifierOrPropertyAccess,
      }), loc);
    } else {
      throw new Error("Internal error: lowerOptionalChain chain");
    }
  }

  // Step 5: wrap in conditional
  result = mkExpr(initObj(new js_ast.EIf(), {
    Test: mkExpr(initObj(new js_ast.EBinary(), {
      Op: js_ast.OpCode.BinOpLooseEq, Left: expr, Right: mkExpr(js_ast.ENullShared, loc),
    }), loc),
    Yes: valueWhenUndefined, No: result,
  }), loc);
  if (exprWrapFunc !== null) result = exprWrapFunc(result);
  if (targetWrapFunc !== null) result = targetWrapFunc(result);
  if (childOut.thisArgWrapFunc !== null) result = childOut.thisArgWrapFunc(result);
  out.thisArgFunc = parentThisArgFunc;
  out.thisArgWrapFunc = parentThisArgWrapFunc;
  return result;
}

/** Go: func (p *parser) lowerParenthesizedOptionalChain(loc, e, childOut) Expr (js_parser_lower.go:803) */
export function lowerParenthesizedOptionalChain(
  p: parser, loc: Loc, e: js_ast.ECall, childOut: import("./js_parser.ts").exprOut,
): js_ast.Expr {
  const call = mkExpr(initObj(new js_ast.ECall(), {
    Target: mkExpr(initObj(new js_ast.EDot(), { Target: e.Target, Name: "call", NameLoc: loc }), loc),
    Args: [childOut.thisArgFunc!(), ...e.Args],
    IsMultiLine: e.IsMultiLine,
    Kind: js_ast.CallKind.TargetWasOriginallyPropertyAccess,
  }), loc);
  return childOut.thisArgWrapFunc !== null ? childOut.thisArgWrapFunc(call) : call;
}

/** Go: type objRestMode uint8 (js_parser_lower.go:1406) */
export type objRestMode = number;
export const objRestMode = {
  objRestReturnValueIsUnused: 0,
  objRestMustReturnInitExpr: 1,
} as const;

/** Go: func (p *parser) lowerAssign(rootExpr, rootInit, mode) (Expr, bool) (js_parser_lower.go:1414) */
export function lowerAssign(p: parser, rootExpr0: js_ast.Expr, rootInit0: js_ast.Expr, mode: objRestMode): [js_ast.Expr, boolean] {
  const lowered = lowerSuperPropertyOrPrivateInAssign(p, rootExpr0);
  const rootExpr = lowered.expr;
  const didLower = lowered.didLower;

  let expr: js_ast.Expr = new js_ast.Expr();
  const assign = (left: js_ast.Expr, right: js_ast.Expr): void => {
    expr = JoinWithComma(expr, js_ast_helpers.Assign(left, right));
  };

  const [initWrapFunc, ok] = lowerObjectRestHelper(p, rootExpr, rootInit0, assign, generateTempRefArg.tempRefNeedsDeclare, mode);
  if (ok) {
    if (initWrapFunc !== null) expr = initWrapFunc(expr);
    return [expr, true];
  }
  if (didLower) return [js_ast_helpers.Assign(rootExpr, rootInit0), true];
  return [new js_ast.Expr(), false];
}

/** Go: func (p *parser) lowerObjectRestToDecls(rootExpr, rootInit, decls) ([]Decl, bool) (js_parser_lower.go:1436) */
export function lowerObjectRestToDecls(p: parser, rootExpr: js_ast.Expr, rootInit: js_ast.Expr, decls0: js_ast.Decl[]): [js_ast.Decl[], boolean] {
  const decls = decls0.slice();
  const assign = (left: js_ast.Expr, right: js_ast.Expr): void => {
    const binding = p.convertExprToBinding(left);
    decls.push(initObj(new js_ast.Decl(), { Binding: binding, ValueOrNil: right }));
  };
  const [, ok] = lowerObjectRestHelper(p, rootExpr, rootInit, assign, generateTempRefArg.tempRefNoDeclare, objRestMode.objRestReturnValueIsUnused);
  if (ok) return [decls, true];
  return [[], false];
}

/** Go: func (p *parser) lowerObjectRestHelper(...) (wrapFunc, ok) (js_parser_lower.go:1452) */
export function lowerObjectRestHelper(
  p: parser,
  rootExpr: js_ast.Expr,
  rootInit0: js_ast.Expr,
  assign: (left: js_ast.Expr, right: js_ast.Expr) => void,
  declare: number,
  mode: objRestMode,
): [( (expr: js_ast.Expr) => js_ast.Expr ) | null, boolean] {
  if (!HasFeature(p.options.unsupportedJSFeatures, JSFeature.ObjectRestSpread)) return [null, false];

  // Check if this could possibly contain an object rest binding
  const rootData = rootExpr.Data;
  if (!(rootData instanceof js_ast.EArray) && !(rootData instanceof js_ast.EObject)) return [null, false];

  // Scan for object rest bindings and initialize rest binding containment
  const containsRestBinding = new Map<js_ast.E, boolean>();
  const findRestBindings = (expr: js_ast.Expr): boolean => {
    let found = false;
    const e = expr.Data;
    if (e instanceof js_ast.EBinary) {
      if (e.Op === js_ast.OpCode.BinOpAssign && findRestBindings(e.Left)) found = true;
    } else if (e instanceof js_ast.EArray) {
      for (const item of e.Items) if (findRestBindings(item)) found = true;
    } else if (e instanceof js_ast.EObject) {
      for (const property of e.Properties) {
        if (property.Kind === js_ast.PropertyKind.PropertySpread || findRestBindings(property.ValueOrNil ?? new js_ast.Expr())) found = true;
      }
    }
    if (found && e !== null) containsRestBinding.set(e, true);
    return found;
  };
  findRestBindings(rootExpr);
  if (containsRestBinding.size === 0) return [null, false];

  let rootInit = rootInit0;
  let wrapFunc: ((expr: js_ast.Expr) => js_ast.Expr) | null = null;

  const captureIntoRef = (expr: js_ast.Expr): Ref => {
    const ref = p.generateTempRef(declare, "");
    assign(mkExpr(new js_ast.EIdentifier(ref), expr.Loc), expr);
    p.recordUsage(ref);
    return ref;
  };

  const lowerObjectRestPattern = (
    before: js_ast.Property[],
    binding: js_ast.Expr,
    init0: js_ast.Expr,
    capturedKeys: (() => js_ast.Expr)[],
    isSingleLine: boolean,
  ): void => {
    let init = init0;
    if (before.length > 0) {
      const ref = captureIntoRef(init);
      assign(mkExpr(initObj(new js_ast.EObject(), { Properties: before, IsSingleLine: isSingleLine }), before[0].Key.Loc),
        mkExpr(new js_ast.EIdentifier(ref), init.Loc));
      init = mkExpr(new js_ast.EIdentifier(ref), init.Loc);
      p.recordUsage(ref);
      p.recordUsage(ref);
    }
    const keysToExclude = capturedKeys.map((capturedKey) => capturedKey());
    assign(binding, p.callRuntime(binding.Loc, "__objRest", [init,
      mkExpr(initObj(new js_ast.EArray(), { Items: keysToExclude, IsSingleLine: isSingleLine }), binding.Loc)]));
  };

  let visit: (expr: js_ast.Expr, init: js_ast.Expr, capturedKeys: (() => js_ast.Expr)[]) => void;
  visit = (expr: js_ast.Expr, init: js_ast.Expr, capturedKeys: (() => js_ast.Expr)[]): void => {
    const e = expr.Data;
    if (e instanceof js_ast.EArray) {
      for (let i = 0; i < e.Items.length; i++) {
        const item = e.Items[i];
        if (item.Data !== null && containsRestBinding.get(item.Data)) {
          splitArrayPattern(e.Items.slice(0, i), item, e.Items.slice(i + 1), init, e.IsSingleLine);
          return;
        }
      }
    } else if (e instanceof js_ast.EObject) {
      const last = e.Properties.length - 1;
      const endsWithRestBinding = last >= 0 && e.Properties[last].Kind === js_ast.PropertyKind.PropertySpread;
      for (let i = 0; i < e.Properties.length; i++) {
        const property = e.Properties[i];
        if (property.Kind === js_ast.PropertyKind.PropertySpread) {
          lowerObjectRestPattern(e.Properties.slice(0, i), property.ValueOrNil ?? new js_ast.Expr(), init, capturedKeys, e.IsSingleLine);
          return;
        }
        if (endsWithRestBinding) {
          const [key, capturedKey] = captureKeyForObjectRest(p, property.Key);
          property.Key = key;
          capturedKeys = capturedKeys.concat([capturedKey]);
        }
        const valueData = property.ValueOrNil?.Data ?? null;
        if (valueData !== null && containsRestBinding.get(valueData)) {
          splitObjectPattern(e.Properties.slice(0, i + 1), e.Properties.slice(i + 1), init, capturedKeys, e.IsSingleLine);
          return;
        }
      }
    }
    assign(expr, init);
  };

  const splitArrayPattern = (
    before: js_ast.Expr[],
    split0: js_ast.Expr,
    after: js_ast.Expr[],
    init: js_ast.Expr,
    isSingleLine: boolean,
  ): void => {
    const split = split0;
    let binding: js_ast.Expr = split;
    if (binding.Data instanceof js_ast.EBinary && binding.Data.Op === js_ast.OpCode.BinOpAssign) {
      binding = binding.Data.Left;
    }
    const splitRef = p.generateTempRef(declare, "");
    const deferredBinding = binding.Data!;
    binding.Data = new js_ast.EIdentifier(splitRef);
    const items = before.concat([split]);

    let tailExpr: js_ast.Expr = new js_ast.Expr();
    let tailInit: js_ast.Expr = new js_ast.Expr();
    if (after.length > 0) {
      const tailRef = p.generateTempRef(declare, "");
      const loc = after[0].Loc;
      tailExpr = mkExpr(initObj(new js_ast.EArray(), { Items: after, IsSingleLine: isSingleLine }), loc);
      tailInit = mkExpr(new js_ast.EIdentifier(tailRef), loc);
      items.push(mkExpr(initObj(new js_ast.ESpread(), { Value: mkExpr(new js_ast.EIdentifier(tailRef), loc) }), loc));
      p.recordUsage(tailRef);
      p.recordUsage(tailRef);
    }

    assign(mkExpr(initObj(new js_ast.EArray(), { Items: items, IsSingleLine: isSingleLine }), split.Loc), init);
    visit(mkExpr(deferredBinding, split.Loc), mkExpr(new js_ast.EIdentifier(splitRef), split.Loc), []);
    p.recordUsage(splitRef);
    if (after.length > 0) visit(tailExpr, tailInit, []);
  };

  const splitObjectPattern = (
    upToSplit: js_ast.Property[],
    afterSplit: js_ast.Property[],
    init0: js_ast.Expr,
    capturedKeys: (() => js_ast.Expr)[],
    isSingleLine: boolean,
  ): void => {
    let init = init0;
    let afterSplitInit: js_ast.Expr = new js_ast.Expr();
    if (afterSplit.length > 0) {
      const ref = captureIntoRef(init);
      init = mkExpr(new js_ast.EIdentifier(ref), init.Loc);
      afterSplitInit = mkExpr(new js_ast.EIdentifier(ref), init.Loc);
    }
    const split = upToSplit[upToSplit.length - 1];
    const binding = split.ValueOrNil ?? new js_ast.Expr();
    const splitRef = p.generateTempRef(declare, "");
    const deferredBinding = binding.Data!;
    binding.Data = new js_ast.EIdentifier(splitRef);
    p.recordUsage(splitRef);
    assign(mkExpr(initObj(new js_ast.EObject(), { Properties: upToSplit, IsSingleLine: isSingleLine }), binding.Loc), init);
    visit(mkExpr(deferredBinding, binding.Loc), mkExpr(new js_ast.EIdentifier(splitRef), binding.Loc), []);
    p.recordUsage(splitRef);
    if (afterSplit.length > 0) {
      visit(mkExpr(initObj(new js_ast.EObject(), { Properties: afterSplit, IsSingleLine: isSingleLine }), binding.Loc), afterSplitInit, capturedKeys);
    }
  };

  if (mode === objRestMode.objRestMustReturnInitExpr) {
    const [initFunc, initWrapFunc] = p.captureValueWithPossibleSideEffects(rootInit.Loc, 2, rootInit, 1 /* valueCouldBeMutated */);
    rootInit = initFunc();
    wrapFunc = (expr: js_ast.Expr): js_ast.Expr => initWrapFunc(JoinWithComma(expr, initFunc()));
  }

  visit(rootExpr, rootInit, []);
  return [wrapFunc, true];
}

/** Go: func (p *parser) captureKeyForObjectRest(originalKey) (finalKey, capturedKey) (js_parser_lower.go:1723) */
export function captureKeyForObjectRest(p: parser, originalKey: js_ast.Expr): [js_ast.Expr, () => js_ast.Expr] {
  const loc = originalKey.Loc;
  let finalKey = originalKey;
  let capturedKey: () => js_ast.Expr;
  const k = originalKey.Data;
  if (k instanceof js_ast.EString) {
    capturedKey = () => mkExpr(new js_ast.EString(k.Value), loc);
  } else if (k instanceof js_ast.ENumber) {
    capturedKey = () => mkExpr(initObj(new js_ast.EBinary(), {
      Op: js_ast.OpCode.BinOpAdd,
      Left: mkExpr(new js_ast.ENumber(k.Value), loc),
      Right: mkExpr(new js_ast.EString(), loc),
    }), loc);
  } else if (k instanceof js_ast.EIdentifier) {
    capturedKey = () => {
      p.recordUsage(k.Ref);
      return p.callRuntime(loc, "__restKey", [mkExpr(new js_ast.EIdentifier(k.Ref), loc)]);
    };
  } else {
    const tempRef = p.generateTempRef(generateTempRefArg.tempRefNeedsDeclare, "");
    finalKey = js_ast_helpers.Assign(mkExpr(new js_ast.EIdentifier(tempRef), loc), originalKey);
    capturedKey = () => {
      p.recordUsage(tempRef);
      return p.callRuntime(loc, "__restKey", [mkExpr(new js_ast.EIdentifier(tempRef), loc)]);
    };
  }
  return [finalKey, capturedKey];
}

/** Go: func (p *parser) lowerObjectRestInDecls(decls) []Decl (js_parser_lower.go:1317) */
export function lowerObjectRestInDecls(p: parser, decls: js_ast.Decl[]): js_ast.Decl[] {
  if (!HasFeature(p.options.unsupportedJSFeatures, JSFeature.ObjectRestSpread)) return decls;
  for (let i = 0; i < decls.length; i++) {
    const decl = decls[i];
    if (decl.ValueOrNil !== null && bindingHasObjectRest(decl.Binding)) {
      const clone = decls.slice(0, i);
      for (const d of decls.slice(i)) {
        if (d.ValueOrNil !== null) {
          const target = ConvertBindingToExpr(d.Binding, null);
          const [result, ok] = lowerObjectRestToDecls(p, target, d.ValueOrNil, clone);
          if (ok) { clone.length = 0; clone.push(...result); continue; }
        }
        clone.push(d);
      }
      return clone;
    }
  }
  return decls;
}

/** Go: func (p *parser) lowerObjectRestInForLoopInit(init, body) (js_parser_lower.go:1345) */
export function lowerObjectRestInForLoopInit(p: parser, init: js_ast.Stmt, body: js_ast.Stmt): void {
  if (!HasFeature(p.options.unsupportedJSFeatures, JSFeature.ObjectRestSpread)) return;
  let bodyPrefixStmt: js_ast.Stmt = new js_ast.Stmt();
  const s = init.Data;
  if (s instanceof js_ast.SExpr) {
    if (exprHasObjectRest(s.Value)) {
      const ref = p.generateTempRef(generateTempRefArg.tempRefNeedsDeclare, "");
      const [expr, ok] = lowerAssign(p, s.Value, mkExpr(new js_ast.EIdentifier(ref), init.Loc), objRestMode.objRestReturnValueIsUnused);
      if (ok) {
        p.recordUsage(ref);
        s.Value.Data = new js_ast.EIdentifier(ref);
        bodyPrefixStmt = mkStmt(new js_ast.SExpr(), expr.Loc, (ss) => { ss.Value = expr; });
      }
    }
  } else if (s instanceof js_ast.SLocal) {
    if (s.Decls.length === 1 && bindingHasObjectRest(s.Decls[0].Binding)) {
      const ref = p.generateTempRef(generateTempRefArg.tempRefNoDeclare, "");
      const decl = initObj(new js_ast.Decl(), { Binding: s.Decls[0].Binding, ValueOrNil: mkExpr(new js_ast.EIdentifier(ref), init.Loc) });
      p.recordUsage(ref);
      const decls = lowerObjectRestInDecls(p, [decl]);
      s.Decls[0].Binding.Data = new js_ast.BIdentifier(ref);
      bodyPrefixStmt = mkStmt(initObj(new js_ast.SLocal(), { Kind: s.Kind, Decls: decls }), init.Loc);
    }
  }
  if (bodyPrefixStmt.Data !== null) {
    const b = body.Data;
    if (b instanceof js_ast.SBlock) {
      b.Stmts = [bodyPrefixStmt, ...b.Stmts];
    } else {
      body.Data = initObj(new js_ast.SBlock(), { Stmts: [bodyPrefixStmt, body] });
    }
  }
}

/** Go: func (p *parser) lowerObjectRestInCatchBinding(catch) (js_parser_lower.go:1390) */
export function lowerObjectRestInCatchBinding(p: parser, catchNode: js_ast.Catch): void {
  if (!HasFeature(p.options.unsupportedJSFeatures, JSFeature.ObjectRestSpread)) return;
  const binding = catchNode.BindingOrNil;
  if (binding !== null && bindingHasObjectRest(binding)) {
    const ref = p.generateTempRef(generateTempRefArg.tempRefNoDeclare, "");
    const decl = initObj(new js_ast.Decl(), { Binding: binding, ValueOrNil: mkExpr(new js_ast.EIdentifier(ref), binding.Loc) });
    p.recordUsage(ref);
    const decls = lowerObjectRestInDecls(p, [decl]);
    catchNode.BindingOrNil.Data = new js_ast.BIdentifier(ref);
    catchNode.Block.Stmts = [mkStmt(initObj(new js_ast.SLocal(), { Kind: js_ast.LocalKind.LocalLet, Decls: decls }), binding.Loc), ...catchNode.Block.Stmts];
  }
}

function mkStmt(data: js_ast.S | null, loc: Loc, setup?: (s: any) => void): js_ast.Stmt {
  if (setup && data) setup(data);
  return new js_ast.Stmt(data, loc);
}

/** Go: func (p *parser) lowerTemplateLiteral(loc, e, tagThisFunc, tagWrapFunc) Expr (js_parser_lower.go:1765)。第 109 批从 js_parser.ts 归置到本文件（与 Go 文件布局一致，消除名实不符）。 */
export function lowerTemplateLiteral(
  p: parser,
  loc: Loc,
  e: js_ast.ETemplate,
  tagThisFunc: (() => js_ast.Expr) | null,
  tagWrapFunc: ((expr: js_ast.Expr) => js_ast.Expr) | null,
): js_ast.Expr {
  if (e.TagOrNil === null) {
    let value = mkExpr(initObj(new js_ast.EString(), { Value: e.HeadCooked!, LegacyOctalLoc: e.LegacyOctalLoc }), loc);
    for (const part of e.Parts) {
      let args: js_ast.Expr[];
      if (part.TailCooked !== null && part.TailCooked.length > 0) {
        args = [part.Value, mkExpr(initObj(new js_ast.EString(), { Value: part.TailCooked }), part.TailLoc)];
      } else {
        args = [part.Value];
      }
      value = mkExpr(initObj(new js_ast.ECall(), {
        Target: mkExpr(initObj(new js_ast.EDot(), { Target: value, Name: "concat", NameLoc: part.Value.Loc }), loc),
        Args: args,
        Kind: js_ast.CallKind.TargetWasOriginallyPropertyAccess,
      }), loc);
    }
    return value;
  }

  let needsRaw = false;
  const cooked: js_ast.Expr[] = [];
  const rawArr: js_ast.Expr[] = [];
  const args: js_ast.Expr[] = [mkExpr(null, loc)];
  if (e.HeadCooked === null) {
    cooked.push(mkExpr(js_ast.EUndefinedShared, e.HeadLoc));
    needsRaw = true;
  } else {
    cooked.push(mkExpr(initObj(new js_ast.EString(), { Value: e.HeadCooked }), e.HeadLoc));
    if (!UTF16EqualsString(e.HeadCooked, e.HeadRaw)) needsRaw = true;
  }
  rawArr.push(mkExpr(initObj(new js_ast.EString(), { Value: new Uint16Array(StringToUTF16(e.HeadRaw)) }), e.HeadLoc));
  for (const part of e.Parts) {
    args.push(part.Value);
    if (part.TailCooked === null) {
      cooked.push(mkExpr(js_ast.EUndefinedShared, part.TailLoc));
      needsRaw = true;
    } else {
      cooked.push(mkExpr(initObj(new js_ast.EString(), { Value: part.TailCooked }), part.TailLoc));
      if (!UTF16EqualsString(part.TailCooked, part.TailRaw)) needsRaw = true;
    }
    rawArr.push(mkExpr(initObj(new js_ast.EString(), { Value: new Uint16Array(StringToUTF16(part.TailRaw)) }), part.TailLoc));
  }
  const cookedArray = mkExpr(initObj(new js_ast.EArray(), { Items: cooked, IsSingleLine: true }), e.HeadLoc);
  let arrays: js_ast.Expr[];
  if (needsRaw) {
    arrays = [cookedArray, mkExpr(initObj(new js_ast.EArray(), { Items: rawArr, IsSingleLine: true }), e.HeadLoc)];
  } else {
    arrays = [cookedArray];
  }
  const templateObj = p.callRuntime(e.HeadLoc, "__template", arrays);
  const tempRef = p.generateTopLevelTempRef();
  p.recordUsage(tempRef);
  p.recordUsage(tempRef);
  args[0] = mkExpr(initObj(new js_ast.EBinary(), {
    Op: js_ast.OpCode.BinOpLogicalOr,
    Left: mkExpr(new js_ast.EIdentifier(tempRef), loc),
    Right: mkExpr(initObj(new js_ast.EBinary(), {
      Op: js_ast.OpCode.BinOpAssign,
      Left: mkExpr(new js_ast.EIdentifier(tempRef), loc),
      Right: templateObj,
    }), loc),
  }), loc);
  if (tagThisFunc !== null) {
    return tagWrapFunc!(mkExpr(initObj(new js_ast.ECall(), {
      Target: mkExpr(initObj(new js_ast.EDot(), { Target: e.TagOrNil, Name: "call", NameLoc: e.HeadLoc }), loc),
      Args: [tagThisFunc(), ...args],
      Kind: js_ast.CallKind.TargetWasOriginallyPropertyAccess,
    }), loc));
  }
  let kind: js_ast.CallKind = js_ast.CallKind.NormalCall;
  if (e.TagWasOriginallyPropertyAccess) kind = js_ast.CallKind.TargetWasOriginallyPropertyAccess;
  return mkExpr(initObj(new js_ast.ECall(), { Target: e.TagOrNil, Args: args, Kind: kind }), loc);
}

// ---------------------------------------------------------------------------
// 第 109 批：using 声明降级整族（js_parser_lower.go:1906-2155）。ES2015 目标置位
// compat.Using 触发。Go 探针 tmpgenparseprint es2015 模式逐字节核对 Parse+Print 输出。
// ---------------------------------------------------------------------------

/** Go: func (p *parser) shouldLowerUsingDeclarations(stmts []js_ast.Stmt) bool (js_parser_lower.go:1906) */
export function shouldLowerUsingDeclarations(p: parser, stmts: js_ast.Stmt[]): boolean {
  const uf = p.options.unsupportedJSFeatures;
  for (const stmt of stmts) {
    const local = stmt.Data;
    if (!(local instanceof js_ast.SLocal)) continue;
    if (
      (local.Kind === js_ast.LocalKind.LocalUsing && HasFeature(uf, JSFeature.Using)) ||
      (local.Kind === js_ast.LocalKind.LocalAwaitUsing && (
        HasFeature(uf, JSFeature.Using) ||
        HasFeature(uf, JSFeature.AsyncAwait) ||
        (HasFeature(uf, JSFeature.AsyncGenerator) && p.fnOrArrowDataVisit.isGenerator)
      ))
    ) {
      return true;
    }
  }
  return false;
}

/** Go: type lowerUsingDeclarationContext struct (js_parser_lower.go:1919) */
export class LowerUsingDeclarationContext {
  firstUsingLoc: Loc = new Loc(0);
  stackRef: Ref;
  hasAwaitUsing: boolean = false;

  constructor(stackRef: Ref) {
    this.stackRef = stackRef;
  }

  /** Go: func (ctx *lowerUsingDeclarationContext) scanStmts(p, stmts) (js_parser_lower.go:1931) */
  scanStmts(p: parser, stmts: js_ast.Stmt[]): void {
    for (const stmt of stmts) {
      const local = stmt.Data;
      if (local instanceof js_ast.SLocal && js_ast.IsUsing(local.Kind)) {
        if (this.firstUsingLoc.Start === 0) this.firstUsingLoc = stmt.Loc;
        if (local.Kind === js_ast.LocalKind.LocalAwaitUsing) this.hasAwaitUsing = true;
        for (let i = 0; i < local.Decls.length; i++) {
          const decl = local.Decls[i];
          if (decl.ValueOrNil !== null && decl.ValueOrNil.Data !== null) {
            const valueLoc = decl.ValueOrNil.Loc;
            p.recordUsage(this.stackRef);
            const args: js_ast.Expr[] = [
              mkExpr(new js_ast.EIdentifier(this.stackRef), valueLoc),
              decl.ValueOrNil,
            ];
            if (local.Kind === js_ast.LocalKind.LocalAwaitUsing) {
              args.push(mkExpr(new js_ast.EBoolean(true), valueLoc));
            }
            decl.ValueOrNil = p.callRuntime(valueLoc, "__using", args);
          }
        }
        if (p.options.willWrapModuleInTryCatchForUsing && p.currentScope!.Parent === null) {
          local.Kind = js_ast.LocalKind.LocalVar;
        } else {
          local.Kind = p.selectLocalKind(js_ast.LocalKind.LocalConst);
        }
      }
    }
  }

  /** Go: func (ctx *lowerUsingDeclarationContext) finalize(p, stmts, shouldHoistFunctions) []Stmt (js_parser_lower.go:1964) */
  finalize(p: parser, stmts: js_ast.Stmt[], shouldHoistFunctions: boolean): js_ast.Stmt[] {
    const result: js_ast.Stmt[] = [];
    let exports: js_ast.ClauseItem[] = [];
    let end = 0;

    for (const stmt of stmts) {
      const s = stmt.Data;
      if (
        s instanceof js_ast.SDirective || s instanceof js_ast.SImport ||
        s instanceof js_ast.SExportFrom || s instanceof js_ast.SExportStar
      ) {
        result.push(stmt);
        continue;
      } else if (s instanceof js_ast.SExportClause) {
        exports = exports.concat(s.Items);
        continue;
      } else if (s instanceof js_ast.SFunction) {
        if (shouldHoistFunctions) { result.push(stmt); continue; }
      } else if (s instanceof js_ast.SExportDefault) {
        if (s.Value.Data instanceof js_ast.SFunction && shouldHoistFunctions) { result.push(stmt); continue; }
      } else if (s instanceof js_ast.SLocal) {
        if (s.IsExport) {
          js_ast_helpers.ForEachIdentifierBindingInDecls(s.Decls, (bLoc: Loc, b: js_ast.BIdentifier) => {
            const item = new js_ast.ClauseItem();
            item.Alias = p.symbols[b.Ref.InnerIndex].OriginalName;
            item.AliasLoc = bLoc;
            item.Name = new ast.LocRef(bLoc, b.Ref);
            exports.push(item);
            s.Kind = js_ast.LocalKind.LocalVar;
          });
          s.IsExport = false;
        }
      }
      stmts[end] = stmt;
      end++;
    }
    stmts.length = end;

    const caughtRef = p.newSymbol(ast.SymbolKind.SymbolOther, "_");
    const errorRef = p.newSymbol(ast.SymbolKind.SymbolOther, "_error");
    const hasErrorRef = p.newSymbol(ast.SymbolKind.SymbolOther, "_hasError");

    let scope = p.currentScope!;
    while (!js_ast.StopsHoisting(scope.Kind)) scope = scope.Parent!;
    const isTopLevel = scope === p.moduleScope;
    scope.Generated.push(this.stackRef, caughtRef, errorRef, hasErrorRef);
    for (const ref of [this.stackRef, caughtRef, errorRef, hasErrorRef]) {
      const d = new js_ast.DeclaredSymbol();
      d.Ref = ref;
      d.IsTopLevel = isTopLevel;
      p.declaredSymbols.push(d);
    }

    const loc = this.firstUsingLoc;
    p.recordUsage(this.stackRef);
    p.recordUsage(errorRef);
    p.recordUsage(hasErrorRef);
    const callDispose = p.callRuntime(loc, "__callDispose", [
      mkExpr(new js_ast.EIdentifier(this.stackRef), loc),
      mkExpr(new js_ast.EIdentifier(errorRef), loc),
      mkExpr(new js_ast.EIdentifier(hasErrorRef), loc),
    ]);

    let finallyStmts: js_ast.Stmt[];
    if (this.hasAwaitUsing) {
      const promiseRef = p.generateTempRef(generateTempRefArg.tempRefNoDeclare, "_promise");
      scope.Generated.push(promiseRef);
      const pd = new js_ast.DeclaredSymbol();
      pd.Ref = promiseRef;
      pd.IsTopLevel = isTopLevel;
      p.declaredSymbols.push(pd);

      p.recordUsage(promiseRef);
      const awaitExpr = maybeLowerAwait(p, loc, initObj(new js_ast.EAwait(), {
        Value: mkExpr(new js_ast.EIdentifier(promiseRef), loc),
      }));
      p.recordUsage(promiseRef);
      finallyStmts = [
        mkStmt(initObj(new js_ast.SLocal(), { Decls: [initObj(new js_ast.Decl(), {
          Binding: initObj(new js_ast.Binding(), { Data: new js_ast.BIdentifier(promiseRef), Loc: loc }),
          ValueOrNil: callDispose,
        })] }), loc),
        mkStmt(initObj(new js_ast.SExpr(), { Value: mkExpr(initObj(new js_ast.EBinary(), {
          Op: js_ast.OpCode.BinOpLogicalAnd,
          Left: mkExpr(new js_ast.EIdentifier(promiseRef), loc),
          Right: awaitExpr,
        }), loc) }), loc),
      ];
    } else {
      finallyStmts = [mkStmt(initObj(new js_ast.SExpr(), { Value: callDispose }), loc)];
    }

    p.recordUsage(caughtRef);
    result.push(
      mkStmt(initObj(new js_ast.SLocal(), { Decls: [initObj(new js_ast.Decl(), {
        Binding: initObj(new js_ast.Binding(), { Data: new js_ast.BIdentifier(this.stackRef), Loc: loc }),
        ValueOrNil: mkExpr(new js_ast.EArray(), loc),
      })] }), loc),
      mkStmt(initObj(new js_ast.STry(), {
        BlockLoc: loc,
        Block: initObj(new js_ast.SBlock(), { Stmts: stmts }),
        Catch: initObj(new js_ast.Catch(), {
          Loc: loc,
          BindingOrNil: initObj(new js_ast.Binding(), { Data: new js_ast.BIdentifier(caughtRef), Loc: loc }),
          Block: initObj(new js_ast.SBlock(), { Stmts: [mkStmt(initObj(new js_ast.SLocal(), { Decls: [
            initObj(new js_ast.Decl(), {
              Binding: initObj(new js_ast.Binding(), { Data: new js_ast.BIdentifier(errorRef), Loc: loc }),
              ValueOrNil: mkExpr(new js_ast.EIdentifier(caughtRef), loc),
            }),
            initObj(new js_ast.Decl(), {
              Binding: initObj(new js_ast.Binding(), { Data: new js_ast.BIdentifier(hasErrorRef), Loc: loc }),
              ValueOrNil: mkExpr(new js_ast.EBoolean(true), loc),
            }),
          ] }), loc)] }),
          BlockLoc: loc,
        }),
        Finally: initObj(new js_ast.Finally(), {
          Loc: loc,
          Block: initObj(new js_ast.SBlock(), { Stmts: finallyStmts }),
        }),
      }), loc),
    );
    if (exports.length > 0) {
      result.push(mkStmt(initObj(new js_ast.SExportClause(), { Items: exports }), loc));
    }
    return result;
  }
}

/** Go: func (p *parser) lowerUsingDeclarationContext() lowerUsingDeclarationContext (js_parser_lower.go:1925) */
export function lowerUsingDeclarationContext(p: parser): LowerUsingDeclarationContext {
  return new LowerUsingDeclarationContext(p.newSymbol(ast.SymbolKind.SymbolOther, "_stack"));
}

/** Go: func (p *parser) lowerUsingDeclarationInForOf(loc, init, body) (js_parser_lower.go:2126) */
export function lowerUsingDeclarationInForOf(p: parser, loc: Loc, init: js_ast.SLocal, body: js_ast.Stmt): void {
  const binding = init.Decls[0].Binding;
  const id = binding.Data as js_ast.BIdentifier;
  const tempRef = p.generateTempRef(generateTempRefArg.tempRefNoDeclare, "_" + p.symbols[id.Ref.InnerIndex].OriginalName);
  let block: js_ast.SBlock;
  if (body.Data instanceof js_ast.SBlock) {
    block = body.Data;
  } else {
    block = new js_ast.SBlock();
    if (!(body.Data instanceof js_ast.SEmpty)) block.Stmts.push(body);
    body.Data = block;
  }
  const blockStmts: js_ast.Stmt[] = [
    mkStmt(initObj(new js_ast.SLocal(), {
      Kind: init.Kind,
      Decls: [initObj(new js_ast.Decl(), {
        Binding: initObj(new js_ast.Binding(), { Loc: binding.Loc, Data: new js_ast.BIdentifier(id.Ref) }),
        ValueOrNil: mkExpr(new js_ast.EIdentifier(tempRef), binding.Loc),
      })],
    }), loc),
    ...block.Stmts,
  ];
  const ctx = lowerUsingDeclarationContext(p);
  ctx.scanStmts(p, blockStmts);
  block.Stmts = ctx.finalize(p, blockStmts, p.options.willWrapModuleInTryCatchForUsing && p.currentScope!.Parent === null);
  init.Kind = js_ast.LocalKind.LocalVar;
  id.Ref = tempRef;
}

// ---------------------------------------------------------------------------
// 第 41 轮：async / generator / for-await 降级（js_parser_lower.go 238/254/265/276/1069/1090）。
// es2015/16 实测置位 Generator/AsyncAwait/AsyncGenerator/ForAwait，Go 把 async 函数降级成
// __async(... function*(){ yield ... })，TS 此前原样打印。这里 1:1 移植并接 visitFn/visitArrow/
// EAwait/SForOf 调用点。
// ---------------------------------------------------------------------------

/** Go: func (p *parser) markSyntaxFeature(feature, r) bool (js_parser_lower.go:18) —— 只落本轮需要的 async 分支 */
export function markSyntaxFeature(p: parser, feature: bigint, r: Range): boolean {
  if (!HasFeature(p.options.unsupportedJSFeatures, feature)) return false;
  // 本轮只从 markAsyncFn 走到这里，feature ∈ {AsyncAwait, AsyncGenerator}。
  // Go 全表的 "Transforming X to Y is not supported yet" 诊断不影响 M1 输出字节（走 warning 通道），
  // 这里按可降级处理（返回 false = 无错误），降级本身由 lowerFunction/maybeLowerAwait 完成。
  void p; void r;
  return false;
}

/** Go: func (p *parser) markAsyncFn(asyncRange, isGenerator) bool (js_parser_lower.go:238) */
export function markAsyncFn(p: parser, asyncRange: Range, isGenerator: boolean): boolean {
  if (!HasFeature(p.options.unsupportedJSFeatures, JSFeature.Generator)) return false;
  const feature = isGenerator ? JSFeature.AsyncGenerator : JSFeature.AsyncAwait;
  return markSyntaxFeature(p, feature, asyncRange);
}

/** Go: func (p *parser) captureThis() Ref (js_parser_lower.go:254) */
export function captureThis(p: parser): Ref {
  if (p.thisCaptureRef === null) {
    p.thisCaptureRef = p.newSymbol(1 /* SymbolHoisted */, "_this");
  }
  p.recordUsage(p.thisCaptureRef);
  return p.thisCaptureRef;
}

/** Go: func (p *parser) captureArguments() Ref (js_parser_lower.go:265) */
export function captureArguments(p: parser): Ref {
  if (p.argumentsCaptureRef === null) {
    p.argumentsCaptureRef = p.newSymbol(1 /* SymbolHoisted */, "_arguments");
  }
  p.recordUsage(p.argumentsCaptureRef);
  return p.argumentsCaptureRef;
}

/** Go: func (p *parser) maybeLowerAwait(loc, e) Expr (js_parser_lower.go:1069) */
export function maybeLowerAwait(p: parser, loc: Loc, e: js_ast.EAwait): js_ast.Expr {
  if (p.fnOrArrowDataVisit.isGenerator &&
      (HasFeature(p.options.unsupportedJSFeatures, JSFeature.AsyncAwait) ||
       HasFeature(p.options.unsupportedJSFeatures, JSFeature.AsyncGenerator))) {
    return mkExpr(initObj(new js_ast.EYield(), {
      ValueOrNil: mkExpr(initObj(new js_ast.ENew(), {
        Target: p.importFromRuntime(loc, "__await"),
        Args: [e.Value],
      }), loc),
    }), loc);
  }
  if (HasFeature(p.options.unsupportedJSFeatures, JSFeature.AsyncAwait)) {
    return mkExpr(initObj(new js_ast.EYield(), { ValueOrNil: e.Value }), loc);
  }
  return mkExpr(e, loc);
}

/** Go: func (p *parser) lowerFunction(...) (js_parser_lower.go:276) —— async/async-generator 降级 */
export function lowerFunction(
  p: parser,
  fn: js_ast.Fn,
  isArrow: boolean,
): void {
  // Step 1: 函数参数里的对象 rest 降级（复用第 40 轮对象 rest）
  if (HasFeature(p.options.unsupportedJSFeatures, JSFeature.ObjectRestSpread)) {
    const prefixStmts: js_ast.Stmt[] = [];
    for (let i = 0; i < fn.Args.length; i++) {
      const arg = fn.Args[i];
      if (bindingHasObjectRest(arg.Binding)) {
        const ref = p.generateTempRef(generateTempRefArg.tempRefNoDeclare, "");
        const target = ConvertBindingToExpr(arg.Binding, null);
        const init = mkExpr(new js_ast.EIdentifier(ref), arg.Binding.Loc);
        p.recordUsage(ref);
        const [decls, ok] = lowerObjectRestToDecls(p, target, init, []);
        if (ok) {
          arg.Binding.Data = new js_ast.BIdentifier(ref);
          prefixStmts.push(mkStmt(initObj(new js_ast.SLocal(), { Kind: js_ast.LocalKind.LocalVar, Decls: decls }), arg.Binding.Loc));
        }
      }
    }
    if (prefixStmts.length > 0) fn.Body.Block.Stmts = [...prefixStmts, ...fn.Body.Block.Stmts];
  }

  // Step 2: async 降级
  const isGen = fn.IsGenerator;
  if (fn.IsAsync && (
    HasFeature(p.options.unsupportedJSFeatures, JSFeature.AsyncAwait) ||
    (isGen && HasFeature(p.options.unsupportedJSFeatures, JSFeature.AsyncGenerator))
  )) {
    // this 值
    let thisValue = valueForThisLower(p, fn.Body.Loc);
    if (isArrow && !p.hasThisUsage) {
      thisValue = mkExpr(js_ast.ENullShared, fn.Body.Loc);
    } else if (thisValue === null) {
      thisValue = mkExpr(js_ast.EThisShared, fn.Body.Loc);
    }

    // 把函数体搬进嵌套 generator 函数
    // Go 是值语义：`innerFn.Body.Block = fn.Body.Block` 拷走原语句，再把外层 Block.Stmts 清空。
    // TS 是引用语义：必须显式克隆 Block（否则清空外层会连带清空内层，且回填 return 时成环）。
    const innerFn = new js_ast.Fn();
    innerFn.IsGenerator = true;
    const innerBlock = initObj(new js_ast.SBlock(), { Stmts: fn.Body.Block.Stmts, CloseBraceLoc: fn.Body.Block.CloseBraceLoc });
    innerFn.Body = initObj(new js_ast.FnBody(), { Loc: fn.Body.Loc, Block: innerBlock });
    const bodyBlock = fn.Body.Block;
    bodyBlock.Stmts = [];

    // 判断参数求值是否会抛（决定是否 move arguments 到内层）
    let couldThrowErrors = false;
    for (const arg of fn.Args) {
      if (!(arg.Binding.Data instanceof js_ast.BIdentifier) ||
          (arg.DefaultOrNil !== null && couldPotentiallyThrow(arg.DefaultOrNil.Data))) {
        couldThrowErrors = true; break;
      }
    }
    const usesArgumentsRef = !isArrow && p.argumentsRef.InnerIndex !== InvalidRefInner &&
      (p.currentPart?.SymbolUses.get(refKey(p.argumentsRef))?.CountEstimate ?? 0) > 0;

    let forwardedArgs: js_ast.Expr;
    if (!couldThrowErrors && !usesArgumentsRef) {
      forwardedArgs = mkExpr(js_ast.ENullShared, fn.Body.Loc);
    } else {
      innerFn.Args = fn.Args;
      innerFn.HasRestArg = fn.HasRestArg;
      fn.Args = [];
      fn.HasRestArg = false;
      // 补 dummy 参数保证 length
      for (let i = 0; i < innerFn.Args.length; i++) {
        const arg = innerFn.Args[i];
        if (arg.DefaultOrNil !== null || (innerFn.HasRestArg && i + 1 === innerFn.Args.length)) break;
        const argRef = p.newSymbol(0 /* SymbolOther */, "_" + i);
        p.currentScope!.Generated.push(argRef);
        fn.Args.push(initObj(new js_ast.Arg(), { Binding: initObj(new js_ast.Binding(), { Data: new js_ast.BIdentifier(argRef), Loc: arg.Binding.Loc }) }));
      }
      if (!isArrow) {
        forwardedArgs = mkExpr(new js_ast.EIdentifier(p.argumentsRef), fn.Body.Loc);
      } else {
        if (fn.Args.length < innerFn.Args.length) {
          const argRef = p.newSymbol(0, "_" + fn.Args.length);
          p.currentScope!.Generated.push(argRef);
          fn.Args.push(initObj(new js_ast.Arg(), { Binding: initObj(new js_ast.Binding(), { Data: new js_ast.BIdentifier(argRef), Loc: fn.Body.Loc }) }));
          fn.HasRestArg = true;
        }
        const items: js_ast.Expr[] = [];
        for (let i = 0; i < fn.Args.length; i++) {
          const id = fn.Args[i].Binding.Data as js_ast.BIdentifier;
          let item = mkExpr(new js_ast.EIdentifier(id.Ref), fn.Args[i].Binding.Loc);
          if (fn.HasRestArg && i + 1 === fn.Args.length) item = mkExpr(initObj(new js_ast.ESpread(), { Value: item }), item.Loc);
          items.push(item);
        }
        forwardedArgs = mkExpr(initObj(new js_ast.EArray(), { Items: items, IsSingleLine: true }), fn.Body.Loc);
      }
    }

    let name: string;
    if (isGen) { name = "__asyncGenerator"; fn.IsGenerator = false; }
    else { name = "__async"; }
    fn.IsAsync = false;
    const callAsync = p.callRuntime(fn.Body.Loc, name, [thisValue, forwardedArgs, mkExpr(initObj(new js_ast.EFunction(), { Fn: innerFn }), fn.Body.Loc)]);
    bodyBlock.Stmts = [mkStmt(initObj(new js_ast.SReturn(), { ValueOrNil: callAsync }), fn.Body.Loc)];
  }
}

// valueForThis 的 lower 用简化版：M1 的 mode=PassThrough 时不替换，恒 null。
function valueForThisLower(p: parser, loc: Loc): js_ast.Expr | null {
  return p.valueForThis(loc, false, 0, false, false);
}

const InvalidRefInner = -1;
function refKey(ref: import("../ast/ast.ts").Ref): string {
  return ref.SourceIndex + ":" + ref.InnerIndex;
}

/** Go: func (p *parser) lowerForAwaitLoop(loc, loop, stmts) []Stmt (js_parser_lower.go:1090) */
export function lowerForAwaitLoop(p: parser, loc: Loc, loop: js_ast.SForOf, stmts: js_ast.Stmt[]): js_ast.Stmt[] {
  const iterRef = p.generateTempRef(generateTempRefArg.tempRefNoDeclare, "iter");
  const moreRef = p.generateTempRef(generateTempRefArg.tempRefNoDeclare, "more");
  const tempRef = p.generateTempRef(generateTempRefArg.tempRefNoDeclare, "temp");
  const errorRef = p.generateTempRef(generateTempRefArg.tempRefNoDeclare, "error");
  p.recordUsage(iterRef); p.recordUsage(moreRef); p.recordUsage(tempRef); p.recordUsage(errorRef);

  const init = loop.Init.Data;
  if (init instanceof js_ast.SLocal) {
    if (init.Decls.length === 1) {
      init.Decls[0].ValueOrNil = mkExpr(initObj(new js_ast.EDot(), {
        Target: mkExpr(new js_ast.EIdentifier(tempRef), loc), NameLoc: loc, Name: "value",
      }), loc);
    }
  } else if (init instanceof js_ast.SExpr) {
    // Go 值语义：`Left: init.Value` 拷走旧 Expr，再改 init.Value.Data。
    // TS 引用语义：必须保留旧 Expr 的独立副本作为 Left，否则 Left===init.Value 成环。
    const leftExpr = mkExpr(init.Value.Data, init.Value.Loc);
    init.Value.Data = initObj(new js_ast.EBinary(), {
      Op: js_ast.OpCode.BinOpAssign, Left: leftExpr,
      Right: mkExpr(initObj(new js_ast.EDot(), { Target: mkExpr(new js_ast.EIdentifier(tempRef), loc), NameLoc: loc, Name: "value" }), loc),
    });
  }

  const body: js_ast.Stmt[] = [loop.Init];
  let closeBraceLoc = new Loc(0);
  if (loop.Body.Data instanceof js_ast.SBlock) {
    body.push(...loop.Body.Data.Stmts);
    closeBraceLoc = loop.Body.Data.CloseBraceLoc;
  } else {
    body.push(loop.Body);
  }

  const awaitIterNext = mkExpr(initObj(new js_ast.ECall(), {
    Target: mkExpr(initObj(new js_ast.EDot(), { Target: mkExpr(new js_ast.EIdentifier(iterRef), loc), NameLoc: loc, Name: "next" }), loc),
    Kind: js_ast.CallKind.TargetWasOriginallyPropertyAccess,
  }), loc);
  const awaitTempCallIter = mkExpr(initObj(new js_ast.ECall(), {
    Target: mkExpr(initObj(new js_ast.EDot(), { Target: mkExpr(new js_ast.EIdentifier(tempRef), loc), NameLoc: loc, Name: "call" }), loc),
    Args: [mkExpr(new js_ast.EIdentifier(iterRef), loc)],
    Kind: js_ast.CallKind.TargetWasOriginallyPropertyAccess,
  }), loc);
  const loweredNext = maybeLowerAwait(p, awaitIterNext.Loc, initObj(new js_ast.EAwait(), { Value: awaitIterNext }));
  const loweredCall = maybeLowerAwait(p, awaitTempCallIter.Loc, initObj(new js_ast.EAwait(), { Value: awaitTempCallIter }));

  const mkDecl = (ref: Ref, value: js_ast.Expr | null = null): js_ast.Decl =>
    initObj(new js_ast.Decl(), { Binding: initObj(new js_ast.Binding(), { Data: new js_ast.BIdentifier(ref) }), ValueOrNil: value });
  const assign = (left: js_ast.Expr, right: js_ast.Expr, op: js_ast.OpCode = js_ast.OpCode.BinOpAssign): js_ast.Expr =>
    mkExpr(initObj(new js_ast.EBinary(), { Op: op, Left: left, Right: right }), left.Loc);
  const idExpr = (ref: Ref): js_ast.Expr => mkExpr(new js_ast.EIdentifier(ref), loc);
  const dotExpr = (target: js_ast.Expr, name: string): js_ast.Expr =>
    mkExpr(initObj(new js_ast.EDot(), { Target: target, NameLoc: loc, Name: name }), loc);

  const forInit = mkStmt(initObj(new js_ast.SLocal(), {
    Kind: js_ast.LocalKind.LocalVar,
    Decls: [mkDecl(iterRef, p.callRuntime(loc, "__forAwait", [loop.Value])), mkDecl(moreRef), mkDecl(tempRef), mkDecl(errorRef)],
  }), loc);
  const test = assign(
    idExpr(moreRef),
    mkExpr(initObj(new js_ast.EUnary(), {
      Op: js_ast.OpCode.UnOpNot,
      Value: mkExpr(initObj(new js_ast.EDot(), {
        Target: assign(idExpr(tempRef), loweredNext),
        NameLoc: loc, Name: "done",
      }), loc),
    }), loc),
  );
  const update = assign(idExpr(moreRef), mkExpr(new js_ast.EBoolean(false), loc));
  const forBody = mkStmt(initObj(new js_ast.SBlock(), { Stmts: body, CloseBraceLoc: closeBraceLoc }), loop.Body.Loc);
  const loweredFor = mkStmt(initObj(new js_ast.SFor(), {
    IsLoweredForAwait: true, InitOrNil: forInit, TestOrNil: test, UpdateOrNil: update, Body: forBody,
  }), loc);

  const catchBlock = mkStmt(initObj(new js_ast.STry(), {
    BlockLoc: loc,
    Block: initObj(new js_ast.SBlock(), { Stmts: [loweredFor] }),
    Catch: initObj(new js_ast.Catch(), {
      Loc: loc,
      BindingOrNil: initObj(new js_ast.Binding(), { Data: new js_ast.BIdentifier(tempRef), Loc: loc }),
      Block: initObj(new js_ast.SBlock(), { Stmts: [mkStmt(initObj(new js_ast.SExpr(), {
        Value: assign(idExpr(errorRef), mkExpr(initObj(new js_ast.EArray(), {
          Items: [idExpr(tempRef)], IsSingleLine: true,
        }), loc)),
      }), loc)] }),
    }),
    Finally: initObj(new js_ast.Finally(), {
      Loc: loc,
      Block: initObj(new js_ast.SBlock(), { Stmts: [mkStmt(initObj(new js_ast.STry(), {
        BlockLoc: loc,
        Block: initObj(new js_ast.SBlock(), { Stmts: [mkStmt(initObj(new js_ast.SExpr(), {
          Value: assign(
            assign(idExpr(moreRef), assign(idExpr(tempRef), dotExpr(idExpr(iterRef), "return")), js_ast.OpCode.BinOpLogicalAnd),
            loweredCall, js_ast.OpCode.BinOpLogicalAnd),
        }), loc)] }),
        Finally: initObj(new js_ast.Finally(), {
          Loc: loc,
          Block: initObj(new js_ast.SBlock(), { Stmts: [mkStmt(initObj(new js_ast.SIf(), {
            Test: mkExpr(new js_ast.EIdentifier(errorRef), loc),
            Yes: mkStmt(initObj(new js_ast.SThrow(), {
              Value: mkExpr(initObj(new js_ast.EIndex(), {
                Target: mkExpr(new js_ast.EIdentifier(errorRef), loc),
                Index: mkExpr(new js_ast.ENumber(0), loc),
              }), loc),
            }), loc),
          }), loc)] }),
        }),
      }), loc)] }),
    }),
  }), loc);
  return [...stmts, catchBlock];
}

