// 1:1 移植自 esbuild internal/js_ast/js_ast_helpers.go（v0.28.2，commit f6058f83）
//
// 包 `internal/js_ast` 的 56 个 helper（js_ast_helpers.go 全部）。
// 期望值来自 Go 探针 /root/esbuild/tmphelpersdump（本轮新增），夹具 testdata/js_ast/helpers.json。
//
// 两个跨语言约定（与 js_ast.ts 一致）：
//   - Go 的 []uint16 → Uint16Array；Go 的 string（UTF-8 字节串）在需要字节语义处 → Uint8Array。
//   - **Go 的 Expr/Stmt/Binding 是值类型（struct），TS 是类（引用）**。
//     Go 代码里 `expr.Data = ...`、`property.ValueOrNil.Data = ...` 只改局部副本，绝不写回原 AST；
//     TS 若直接赋字段就会 mutate 共享对象。本文件凡遇到这种写法都用「新建 Expr / 克隆节点」复刻值语义，
//     并在注释里标 `Go 值语义`。
//
// 明确未移植（inventory 里属于 js_ast.go，不属本文件）：
//   ExprToConstValue / ConstValueToExpr（依赖 strconv.FormatFloat 'g' 逐位复刻）、
//   GenerateNonUniqueNameFromPath（依赖 logger.PlatformIndependentPathDirBaseExt，M2）。

import * as js_ast from "./js_ast.ts";
import { Ref } from "../ast/ast.ts";
import { Loc } from "../logger/logger.ts";
import { Has as FeatureHas, JSFeature } from "../compat/compat.ts";
import {
  StringToUTF16,
  UTF16EqualsString,
  UTF16EqualsUTF16,
  UTF16ToString,
} from "../helpers/utf.ts";
import { utf8 } from "../logger/bytes.ts";

// ---------------------------------------------------------------------------
// 小工具（非 Go 函数，只为复刻值语义 / 字节串转换）
// ---------------------------------------------------------------------------

const utf8Decoder = new TextDecoder();

/** Go 的 helpers.StringToUTF16(s) 返回 []uint16；EString.Value 是 Uint16Array。 */
function utf16(s: string): Uint16Array {
  return new Uint16Array(StringToUTF16(utf8(s)));
}

/** Go 的 helpers.UTF16ToString(u) 返回 UTF-8 string。 */
function fromUTF16(u: Uint16Array | number[]): string {
  return utf8Decoder.decode(UTF16ToString(u));
}

/** Go 的 ast.Ref 是 struct，`==` 是值比较；TS 的 Ref 是类，不能用 ===。 */
function refEquals(a: Ref, b: Ref): boolean {
  return a.SourceIndex === b.SourceIndex && a.InnerIndex === b.InnerIndex;
}

/** Go 值语义：`expr.Data = X` 在 Go 里只改局部副本。 */
function withData(expr: js_ast.Expr, data: js_ast.E | null): js_ast.Expr {
  return new js_ast.Expr(data, expr.Loc);
}

/** Go 值语义：`expr.Loc = X`。 */
function withLoc(expr: js_ast.Expr, loc: Loc): js_ast.Expr {
  return new js_ast.Expr(expr.Data, loc);
}

/** Go 值语义：Property 是 struct，range 变量是副本。 */
function cloneProperty(p: js_ast.Property): js_ast.Property {
  return Object.assign(new js_ast.Property(), p);
}

/** Go 值语义：TemplatePart 是 struct，copy() 复制元素值。 */
function cloneTemplatePart(p: js_ast.TemplatePart): js_ast.TemplatePart {
  return Object.assign(new js_ast.TemplatePart(), p);
}

// ---------------------------------------------------------------------------
// 常量（Go: js_ast_helpers.go:200-230 / 1695-1705 / 1867-1875 / 1943-1950 / 2205-2212）
// ---------------------------------------------------------------------------

/** Go: type PrimitiveType uint8 (js_ast_helpers.go:200) */
export type PrimitiveType = number;
export const PrimitiveUnknown = 0;
export const PrimitiveMixed = 1;
export const PrimitiveNull = 2;
export const PrimitiveUndefined = 3;
export const PrimitiveBoolean = 4;
export const PrimitiveNumber = 5;
export const PrimitiveString = 6;
export const PrimitiveBigInt = 7;

/** Go: type SideEffects uint8 (js_ast_helpers.go:1943) */
export type SideEffects = number;
export const CouldHaveSideEffects = 0;
export const NoSideEffects = 1;

/** Go: type EqualityKind uint8 (js_ast_helpers.go:1548) */
export type EqualityKind = number;
export const LooseEquality = 0;
export const StrictEquality = 1;

/** Go: type StmtsCanBeRemovedIfUnusedFlags uint8 (js_ast_helpers.go:2205) */
export const KeepExportClauses = 1 << 0;
export const ReturnCanBeRemovedIfUnused = 1 << 1;

/** Go: type StringAdditionKind uint8 (js_ast_helpers.go:1867) */
export type StringAdditionKind = number;
export const StringAdditionNormal = 0;
export const StringAdditionWithNestedLeft = 1;

// ---------------------------------------------------------------------------
// 第 1 组：构造 / 谓词
// ---------------------------------------------------------------------------

/** Go: type HelperContext struct (js_ast_helpers.go:17) */
export class HelperContext {
  isUnbound: (ref: Ref) => boolean;

  constructor(isUnbound: (ref: Ref) => boolean) {
    this.isUnbound = isUnbound;
  }

  /** Go: func (ctx HelperContext) SimplifyUnusedExpr(expr Expr, unsupportedFeatures compat.JSFeature) Expr (js_ast_helpers.go:534) */
  SimplifyUnusedExpr(expr: js_ast.Expr, unsupportedFeatures: JSFeature): js_ast.Expr {
    const e = expr.Data;

    if (e instanceof js_ast.EAnnotation) {
      if (js_ast.Has(e.Flags, js_ast.AnnotationFlags.CanBeRemovedIfUnusedFlag)) return new js_ast.Expr();
    } else if (e instanceof js_ast.EInlinedEnum) {
      return this.SimplifyUnusedExpr(e.Value, unsupportedFeatures);
    } else if (e instanceof js_ast.ENull || e instanceof js_ast.EUndefined || e instanceof js_ast.EMissing ||
      e instanceof js_ast.EBoolean || e instanceof js_ast.ENumber || e instanceof js_ast.EBigInt ||
      e instanceof js_ast.EString || e instanceof js_ast.EThis || e instanceof js_ast.ERegExp ||
      e instanceof js_ast.EFunction || e instanceof js_ast.EArrow || e instanceof js_ast.EImportMeta) {
      return new js_ast.Expr();
    } else if (e instanceof js_ast.EDot) {
      if (e.CanBeRemovedIfUnused) return new js_ast.Expr();
    } else if (e instanceof js_ast.EIdentifier) {
      if (!e.MustKeepDueToWithStmt && (e.CanBeRemovedIfUnused || !this.isUnbound(e.Ref))) {
        return new js_ast.Expr();
      }
    } else if (e instanceof js_ast.ETemplate) {
      if (e.TagOrNil === null || e.TagOrNil.Data === null) {
        let comma = new js_ast.Expr();
        let templateLoc = new Loc(0);
        let template: js_ast.ETemplate | null = null;
        for (const part of e.Parts) {
          // If we know this value is some kind of primitive, then we know that
          // "ToString" has no side effects and can be avoided.
          if (KnownPrimitiveType(part.Value.Data) !== PrimitiveUnknown) {
            if (template !== null) {
              comma = JoinWithComma(comma, new js_ast.Expr(template, templateLoc));
              template = null;
            }
            comma = JoinWithComma(comma, this.SimplifyUnusedExpr(part.Value, unsupportedFeatures));
            continue;
          }

          // Make sure "ToString" is still evaluated on the value. We can't use
          // string addition here because that may evaluate "ValueOf" instead.
          if (template === null) {
            template = new js_ast.ETemplate();
            templateLoc = part.Value.Loc;
          }
          const newPart = new js_ast.TemplatePart();
          newPart.Value = part.Value;
          template.Parts.push(newPart);
        }
        if (template !== null) {
          comma = JoinWithComma(comma, new js_ast.Expr(template, templateLoc));
        }
        return comma;
      } else if (e.CanBeUnwrappedIfUnused) {
        // If the function call was annotated as being able to be removed if the
        // result is unused, then we can remove it and just keep the arguments.
        // Note that there are no implicit "ToString" operations for tagged
        // template literals.
        let comma = new js_ast.Expr();
        for (const part of e.Parts) {
          comma = JoinWithComma(comma, this.SimplifyUnusedExpr(part.Value, unsupportedFeatures));
        }
        return comma;
      }
    } else if (e instanceof js_ast.EArray) {
      // Arrays with "..." spread expressions can't be unwrapped because the
      // "..." triggers code evaluation via iterators. In that case, just trim
      // the other items instead and leave the array expression there.
      for (const spread of e.Items) {
        if (spread.Data instanceof js_ast.ESpread) {
          const items: js_ast.Expr[] = [];
          for (let item of e.Items) {
            item = this.SimplifyUnusedExpr(item, unsupportedFeatures);
            if (item.Data !== null) items.push(item);
          }

          // Don't mutate the original AST
          const clone = Object.assign(new js_ast.EArray(), e);
          clone.Items = items;
          return new js_ast.Expr(clone, expr.Loc);
        }
      }

      // Otherwise, the array can be completely removed. We only need to keep any
      // array items with side effects. Apply this simplification recursively.
      let result = new js_ast.Expr();
      for (const item of e.Items) {
        result = JoinWithComma(result, this.SimplifyUnusedExpr(item, unsupportedFeatures));
      }
      return result;
    } else if (e instanceof js_ast.EObject) {
      // Objects with "..." spread expressions can't be unwrapped because the
      // "..." triggers code evaluation via getters. In that case, just trim
      // the other items instead and leave the object expression there.
      for (const spread of e.Properties) {
        if (spread.Kind === js_ast.PropertyKind.PropertySpread) {
          const properties: js_ast.Property[] = [];
          for (const property of e.Properties) {
            // Spread properties must always be evaluated
            if (property.Kind !== js_ast.PropertyKind.PropertySpread) {
              // Go 值语义：property 是 range 副本
              const clone = cloneProperty(property);
              const value = this.SimplifyUnusedExpr(property.ValueOrNil ?? new js_ast.Expr(), unsupportedFeatures);
              if (value.Data !== null) {
                // Keep the value
                clone.ValueOrNil = value;
              } else if (!js_ast.Has(property.Flags, js_ast.PropertyFlags.PropertyIsComputed)) {
                // Skip this property if the key doesn't need to be computed
                continue;
              } else {
                // Replace values without side effects with "0" because it's short
                clone.ValueOrNil = new js_ast.Expr(new js_ast.ENumber());
              }
              properties.push(clone);
              continue;
            }
            properties.push(property);
          }

          // Don't mutate the original AST
          const clone = Object.assign(new js_ast.EObject(), e);
          clone.Properties = properties;
          return new js_ast.Expr(clone, expr.Loc);
        }
      }

      // Otherwise, the object can be completely removed. We only need to keep any
      // object properties with side effects. Apply this simplification recursively.
      let result = new js_ast.Expr();
      for (const property of e.Properties) {
        if (js_ast.Has(property.Flags, js_ast.PropertyFlags.PropertyIsComputed)) {
          // Make sure "ToString" is still evaluated on the key
          const binary = new js_ast.EBinary();
          binary.Op = js_ast.OpCode.BinOpAdd;
          binary.Left = property.Key;
          binary.Right = new js_ast.Expr(new js_ast.EString(), property.Key.Loc);
          result = JoinWithComma(result, new js_ast.Expr(binary, property.Key.Loc));
        }
        result = JoinWithComma(result, this.SimplifyUnusedExpr(property.ValueOrNil ?? new js_ast.Expr(), unsupportedFeatures));
      }
      return result;
    } else if (e instanceof js_ast.EIf) {
      const yes = this.SimplifyUnusedExpr(e.Yes, unsupportedFeatures);
      const no = this.SimplifyUnusedExpr(e.No, unsupportedFeatures);

      // "foo() ? 1 : 2" => "foo()"
      if (yes.Data === null && no.Data === null) {
        return this.SimplifyUnusedExpr(e.Test, unsupportedFeatures);
      }

      // "foo() ? 1 : bar()" => "foo() || bar()"
      if (yes.Data === null) {
        return JoinWithLeftAssociativeOp(js_ast.OpCode.BinOpLogicalOr, e.Test, no);
      }

      // "foo() ? bar() : 2" => "foo() && bar()"
      if (no.Data === null) {
        return JoinWithLeftAssociativeOp(js_ast.OpCode.BinOpLogicalAnd, e.Test, yes);
      }

      if (yes !== e.Yes || no !== e.No) {
        const result = new js_ast.EIf();
        result.Test = e.Test;
        result.Yes = yes;
        result.No = no;
        return new js_ast.Expr(result, expr.Loc);
      }
    } else if (e instanceof js_ast.EUnary) {
      switch (e.Op) {
        // These operators must not have any type conversions that can execute code
        // such as "toString" or "valueOf". They must also never throw any exceptions.
        case js_ast.OpCode.UnOpVoid:
        case js_ast.OpCode.UnOpNot:
          return this.SimplifyUnusedExpr(e.Value, unsupportedFeatures);

        case js_ast.OpCode.UnOpNeg:
          if (e.Value.Data instanceof js_ast.EBigInt) {
            // Consider negated bigints to have no side effects
            return new js_ast.Expr();
          }
          break;

        case js_ast.OpCode.UnOpTypeof:
          if (e.Value.Data instanceof js_ast.EIdentifier && e.WasOriginallyTypeofIdentifier) {
            // "typeof x" must not be transformed into if "x" since doing so could
            // cause an exception to be thrown. Instead we can just remove it since
            // "typeof x" is special-cased in the standard to never throw.
            return new js_ast.Expr();
          }
          return this.SimplifyUnusedExpr(e.Value, unsupportedFeatures);
      }
    } else if (e instanceof js_ast.EBinary) {
      let left = e.Left;
      let right = e.Right;

      switch (e.Op) {
        // These operators must not have any type conversions that can execute code
        // such as "toString" or "valueOf". They must also never throw any exceptions.
        case js_ast.OpCode.BinOpStrictEq:
        case js_ast.OpCode.BinOpStrictNe:
        case js_ast.OpCode.BinOpComma:
          return JoinWithComma(
            this.SimplifyUnusedExpr(left, unsupportedFeatures),
            this.SimplifyUnusedExpr(right, unsupportedFeatures),
          );

        // We can simplify "==" and "!=" even though they can call "toString" and/or
        // "valueOf" if we can statically determine that the types of both sides are
        // primitives. In that case there won't be any chance for user-defined
        // "toString" and/or "valueOf" to be called.
        case js_ast.OpCode.BinOpLooseEq:
        case js_ast.OpCode.BinOpLooseNe:
          if (MergedKnownPrimitiveTypes(left, right) !== PrimitiveUnknown) {
            return JoinWithComma(
              this.SimplifyUnusedExpr(left, unsupportedFeatures),
              this.SimplifyUnusedExpr(right, unsupportedFeatures),
            );
          }
          break;

        case js_ast.OpCode.BinOpLogicalAnd:
        case js_ast.OpCode.BinOpLogicalOr:
        case js_ast.OpCode.BinOpNullishCoalescing:
          // If this is a boolean logical operation and the result is unused, then
          // we know the left operand will only be used for its boolean value and
          // can be simplified under that assumption
          if (e.Op !== js_ast.OpCode.BinOpNullishCoalescing) {
            left = this.SimplifyBooleanExpr(left);
          }

          // Preserve short-circuit behavior: the left expression is only unused if
          // the right expression can be completely removed. Otherwise, the left
          // expression is important for the branch.
          right = this.SimplifyUnusedExpr(right, unsupportedFeatures);
          if (right.Data === null) {
            return this.SimplifyUnusedExpr(left, unsupportedFeatures);
          }

          // Try to take advantage of the optional chain operator to shorten code
          if (!FeatureHas(unsupportedFeatures, JSFeature.OptionalChain)) {
            if (left.Data instanceof js_ast.EBinary) {
              const binary = left.Data;
              // "a != null && a.b()" => "a?.b()"
              // "a == null || a.b()" => "a?.b()"
              if ((binary.Op === js_ast.OpCode.BinOpLooseNe && e.Op === js_ast.OpCode.BinOpLogicalAnd) ||
                (binary.Op === js_ast.OpCode.BinOpLooseEq && e.Op === js_ast.OpCode.BinOpLogicalOr)) {
                let test: js_ast.Expr | null = null;
                if (binary.Right.Data instanceof js_ast.ENull) {
                  test = binary.Left;
                } else if (binary.Left.Data instanceof js_ast.ENull) {
                  test = binary.Right;
                }

                if (test !== null && test.Data instanceof js_ast.EIdentifier &&
                  !test.Data.MustKeepDueToWithStmt && TryToInsertOptionalChain(test, right)) {
                  return right;
                }
              }
            }
          }
          break;

        case js_ast.OpCode.BinOpAdd: {
          const [result, isStringAddition] = simplifyUnusedStringAdditionChain(expr);
          if (isStringAddition) return result;
          break;
        }
      }

      if (left !== e.Left || right !== e.Right) {
        const result = new js_ast.EBinary();
        result.Op = e.Op;
        result.Left = left;
        result.Right = right;
        return new js_ast.Expr(result, expr.Loc);
      }
    } else if (e instanceof js_ast.ECall) {
      // A call that has been marked "__PURE__" can be removed if all arguments
      // can be removed. The annotation causes us to ignore the target.
      if (e.CanBeUnwrappedIfUnused) {
        let result = new js_ast.Expr();
        for (let arg of e.Args) {
          if (arg.Data instanceof js_ast.ESpread) {
            // Go 值语义：arg 是 range 副本
            const array = new js_ast.EArray();
            array.Items = [arg];
            array.IsSingleLine = true;
            arg = withData(arg, array);
          }
          result = JoinWithComma(result, this.SimplifyUnusedExpr(arg, unsupportedFeatures));
        }
        return result;
      }

      // Attempt to shorten IIFEs
      if (e.Args.length === 0) {
        const target = e.Target.Data;
        if (target instanceof js_ast.EFunction) {
          if (target.Fn.Args.length === 0) {
            // Just delete "(function() {})()" completely
            if (target.Fn.Body.Block.Stmts.length === 0) return new js_ast.Expr();
          }
        } else if (target instanceof js_ast.EArrow) {
          if (target.Args.length === 0) {
            // Just delete "(() => {})()" completely
            if (target.Body.Block.Stmts.length === 0) return new js_ast.Expr();

            if (target.Body.Block.Stmts.length === 1) {
              const s = target.Body.Block.Stmts[0].Data;
              if (s instanceof js_ast.SExpr) {
                if (!target.IsAsync) {
                  // Replace "(() => { foo() })()" with "foo()"
                  return s.Value;
                }
                // Replace "(async () => { foo() })()" with "(async () => foo())()"
                const clone = Object.assign(new js_ast.EArrow(), target);
                const ret = new js_ast.SReturn();
                ret.ValueOrNil = s.Value;
                clone.Body.Block.Stmts[0].Data = ret;
                clone.PreferExpr = true;
                const call = new js_ast.ECall();
                call.Target = new js_ast.Expr(clone, e.Target.Loc);
                return new js_ast.Expr(call, expr.Loc);
              }
              if (s instanceof js_ast.SReturn) {
                if (!target.IsAsync) {
                  // Replace "(() => foo())()" with "foo()"
                  return s.ValueOrNil ?? new js_ast.Expr();
                }
              }
            }
          }
        }
      }
    } else if (e instanceof js_ast.ENew) {
      // A constructor call that has been marked "__PURE__" can be removed if all
      // arguments can be removed. The annotation causes us to ignore the target.
      if (e.CanBeUnwrappedIfUnused) {
        let result = new js_ast.Expr();
        for (let arg of e.Args) {
          if (arg.Data instanceof js_ast.ESpread) {
            const array = new js_ast.EArray();
            array.Items = [arg];
            array.IsSingleLine = true;
            arg = withData(arg, array);
          }
          result = JoinWithComma(result, this.SimplifyUnusedExpr(arg, unsupportedFeatures));
        }
        return result;
      }
    }

    return expr;
  }

  /** Go: func (ctx HelperContext) SimplifyBooleanExpr(expr Expr) Expr (js_ast_helpers.go:2096) */
  SimplifyBooleanExpr(expr: js_ast.Expr): js_ast.Expr {
    const e = expr.Data;

    if (e instanceof js_ast.EUnary) {
      if (e.Op === js_ast.OpCode.UnOpNot) {
        // "!!a" => "a"
        if (e.Value.Data instanceof js_ast.EUnary && e.Value.Data.Op === js_ast.OpCode.UnOpNot) {
          return this.SimplifyBooleanExpr(e.Value.Data.Value);
        }

        // "!!!a" => "!a"
        const unary = new js_ast.EUnary();
        unary.Op = js_ast.OpCode.UnOpNot;
        unary.Value = this.SimplifyBooleanExpr(e.Value);
        return new js_ast.Expr(unary, expr.Loc);
      }
    } else if (e instanceof js_ast.EBinary) {
      let left = e.Left;
      let right = e.Right;

      switch (e.Op) {
        case js_ast.OpCode.BinOpStrictEq:
        case js_ast.OpCode.BinOpStrictNe:
        case js_ast.OpCode.BinOpLooseEq:
        case js_ast.OpCode.BinOpLooseNe: {
          const r = extractNumericValue(right.Data);
          if (r[1] && r[0] === 0 && isInt32OrUint32(left.Data)) {
            // If the left is guaranteed to be an integer (e.g. not NaN,
            // Infinity, or a non-numeric value) then a test against zero
            // in a boolean context is unnecessary because the value is
            // only truthy if it's not zero.
            if (e.Op === js_ast.OpCode.BinOpStrictNe || e.Op === js_ast.OpCode.BinOpLooseNe) {
              // "if ((a >>> b) !== 0)" => "if (a >>> b)"
              return left;
            }
            // "if ((a >>> b) === 0)" => "if (!(a >>> b))"
            return Not(left);
          }
          break;
        }

        case js_ast.OpCode.BinOpLogicalAnd: {
          // "if (!!a && !!b)" => "if (a && b)"
          left = this.SimplifyBooleanExpr(left);
          right = this.SimplifyBooleanExpr(right);

          const [boolean, sideEffects, ok] = ToBooleanWithSideEffects(right.Data);
          if (ok && boolean && sideEffects === NoSideEffects) {
            // "if (anything && truthyNoSideEffects)" => "if (anything)"
            return left;
          }
          break;
        }

        case js_ast.OpCode.BinOpLogicalOr: {
          // "if (!!a || !!b)" => "if (a || b)"
          left = this.SimplifyBooleanExpr(left);
          right = this.SimplifyBooleanExpr(right);

          const [boolean, sideEffects, ok] = ToBooleanWithSideEffects(right.Data);
          if (ok && !boolean && sideEffects === NoSideEffects) {
            // "if (anything || falsyNoSideEffects)" => "if (anything)"
            return left;
          }
          break;
        }
      }

      if (left !== e.Left || right !== e.Right) {
        const result = new js_ast.EBinary();
        result.Op = e.Op;
        result.Left = left;
        result.Right = right;
        return new js_ast.Expr(result, expr.Loc);
      }
    } else if (e instanceof js_ast.EIf) {
      // "if (a ? !!b : !!c)" => "if (a ? b : c)"
      const yes = this.SimplifyBooleanExpr(e.Yes);
      const no = this.SimplifyBooleanExpr(e.No);

      const y = ToBooleanWithSideEffects(yes.Data);
      if (y[2] && y[1] === NoSideEffects) {
        if (y[0]) {
          // "if (anything1 ? truthyNoSideEffects : anything2)" => "if (anything1 || anything2)"
          return JoinWithLeftAssociativeOp(js_ast.OpCode.BinOpLogicalOr, e.Test, no);
        }
        // "if (anything1 ? falsyNoSideEffects : anything2)" => "if (!anything1 || anything2)"
        return JoinWithLeftAssociativeOp(js_ast.OpCode.BinOpLogicalAnd, Not(e.Test), no);
      }

      const n = ToBooleanWithSideEffects(no.Data);
      if (n[2] && n[1] === NoSideEffects) {
        if (n[0]) {
          // "if (anything1 ? anything2 : truthyNoSideEffects)" => "if (!anything1 || anything2)"
          return JoinWithLeftAssociativeOp(js_ast.OpCode.BinOpLogicalOr, Not(e.Test), yes);
        }
        // "if (anything1 ? anything2 : falsyNoSideEffects)" => "if (anything1 && anything2)"
        return JoinWithLeftAssociativeOp(js_ast.OpCode.BinOpLogicalAnd, e.Test, yes);
      }

      if (yes !== e.Yes || no !== e.No) {
        const result = new js_ast.EIf();
        result.Test = e.Test;
        result.Yes = yes;
        result.No = no;
        return new js_ast.Expr(result, expr.Loc);
      }
    } else {
      // "!![]" => "true"
      const boolean = ToBooleanWithSideEffects(expr.Data);
      if (boolean[2] && (boolean[1] === NoSideEffects || this.ExprCanBeRemovedIfUnused(expr))) {
        return new js_ast.Expr(new js_ast.EBoolean(boolean[0]), expr.Loc);
      }
    }

    return expr;
  }

  /** Go: func (ctx HelperContext) StmtsCanBeRemovedIfUnused(stmts []Stmt, flags StmtsCanBeRemovedIfUnusedFlags) bool (js_ast_helpers.go:2222) */
  StmtsCanBeRemovedIfUnused(stmts: js_ast.Stmt[], flags: number): boolean {
    for (const stmt of stmts) {
      const s = stmt.Data;

      if (s instanceof js_ast.SFunction || s instanceof js_ast.SEmpty) {
        // These never have side effects
      } else if (s instanceof js_ast.SImport) {
        // Let these be removed if they are unused. Note that we also need to
        // check if the imported file is marked as "sideEffects: false" before we
        // can remove a SImport statement. Otherwise the import must be kept for
        // its side effects.
      } else if (s instanceof js_ast.SClass) {
        if (!this.ClassCanBeRemovedIfUnused(s.Class)) return false;
      } else if (s instanceof js_ast.SReturn) {
        if ((flags & ReturnCanBeRemovedIfUnused) === 0 ||
          (s.ValueOrNil !== null && s.ValueOrNil.Data !== null && !this.ExprCanBeRemovedIfUnused(s.ValueOrNil))) {
          return false;
        }
      } else if (s instanceof js_ast.SExpr) {
        if (!this.ExprCanBeRemovedIfUnused(s.Value)) {
          if (!s.IsFromClassOrFnThatCanBeRemovedIfUnused) return false;
          // This statement was automatically generated when lowering a class
          // or function that we were able to analyze as having no side effects
          // before lowering. So we consider it to be removable.
        }
      } else if (s instanceof js_ast.SLocal) {
        // "await" is a side effect because it affects code timing
        if (s.Kind === js_ast.LocalKind.LocalAwaitUsing) return false;

        for (const decl of s.Decls) {
          // Check that the bindings are side-effect free
          const binding = decl.Binding.Data;
          if (binding instanceof js_ast.BIdentifier) {
            // An identifier binding has no side effects
          } else if (binding instanceof js_ast.BArray) {
            // Destructuring the initializer has no side effects if the
            // initializer is an array, since we assume the iterator is then
            // the built-in side-effect free array iterator.
            if (decl.ValueOrNil !== null && decl.ValueOrNil.Data instanceof js_ast.EArray) {
              for (const item of binding.Items) {
                if (item.DefaultValueOrNil !== null && item.DefaultValueOrNil.Data !== null &&
                  !this.ExprCanBeRemovedIfUnused(item.DefaultValueOrNil)) {
                  return false;
                }

                if (!(item.Binding.Data instanceof js_ast.BIdentifier || item.Binding.Data instanceof js_ast.BMissing)) {
                  // Right now we only handle an array pattern with identifier
                  // bindings or with empty holes (i.e. "missing" elements)
                  return false;
                }
              }
            } else {
              return false;
            }
          } else {
            // Consider anything else to potentially have side effects
            return false;
          }

          // Check that the initializer is side-effect free
          if (decl.ValueOrNil !== null && decl.ValueOrNil.Data !== null) {
            if (!this.ExprCanBeRemovedIfUnused(decl.ValueOrNil)) return false;

            // "using" declarations are only side-effect free if they are initialized to null or undefined
            if (js_ast.IsUsing(s.Kind)) {
              const t = KnownPrimitiveType(decl.ValueOrNil.Data);
              if (t !== PrimitiveNull && t !== PrimitiveUndefined) return false;
            }
          }
        }
      } else if (s instanceof js_ast.STry) {
        if (!this.StmtsCanBeRemovedIfUnused(s.Block.Stmts, 0) ||
          (s.Finally !== null && !this.StmtsCanBeRemovedIfUnused(s.Finally.Block.Stmts, 0))) {
          return false;
        }
      } else if (s instanceof js_ast.SExportFrom) {
        // Exports are tracked separately, so this isn't necessary
      } else if (s instanceof js_ast.SExportClause) {
        if ((flags & KeepExportClauses) !== 0) return false;
      } else if (s instanceof js_ast.SExportDefault) {
        const s2 = s.Value.Data;
        if (s2 instanceof js_ast.SExpr) {
          if (!this.ExprCanBeRemovedIfUnused(s2.Value)) return false;
        } else if (s2 instanceof js_ast.SFunction) {
          // These never have side effects
        } else if (s2 instanceof js_ast.SClass) {
          if (!this.ClassCanBeRemovedIfUnused(s2.Class)) return false;
        } else {
          throw new Error("Internal error");
        }
      } else {
        // Assume that all statements not explicitly special-cased here have side
        // effects, and cannot be removed even if unused
        return false;
      }
    }

    return true;
  }

  /** Go: func (ctx HelperContext) ClassCanBeRemovedIfUnused(class Class) bool (js_ast_helpers.go:2335) */
  ClassCanBeRemovedIfUnused(class_: js_ast.Class): boolean {
    if (class_.Decorators.length > 0) return false;

    // Note: This check is incorrect. Extending a non-constructible object can
    // throw an error, which is a side effect. But refusing to tree-shake every
    // class with a base class is not a useful thing for a bundler to do.
    if (class_.ExtendsOrNil !== null && class_.ExtendsOrNil.Data !== null &&
      !this.ExprCanBeRemovedIfUnused(class_.ExtendsOrNil)) {
      return false;
    }

    for (const property of class_.Properties) {
      if (property.Kind === js_ast.PropertyKind.PropertyClassStaticBlock) {
        if (!this.StmtsCanBeRemovedIfUnused(property.ClassStaticBlock!.Block.Stmts, 0)) return false;
        continue;
      }

      if (property.Decorators.length > 0) return false;

      if (js_ast.Has(property.Flags, js_ast.PropertyFlags.PropertyIsComputed) &&
        !IsPrimitiveLiteral(property.Key.Data) && !IsSymbolInstance(property.Key.Data)) {
        return false;
      }

      if (js_ast.IsMethodDefinition(property.Kind)) {
        if (property.ValueOrNil?.Data instanceof js_ast.EFunction) {
          for (const arg of property.ValueOrNil.Data.Fn.Args) {
            if (arg.Decorators.length > 0) return false;
          }
        }
      }

      if (js_ast.Has(property.Flags, js_ast.PropertyFlags.PropertyIsStatic)) {
        if (property.ValueOrNil !== null && property.ValueOrNil.Data !== null &&
          !this.ExprCanBeRemovedIfUnused(property.ValueOrNil)) {
          return false;
        }

        if (property.InitializerOrNil !== null && property.InitializerOrNil.Data !== null &&
          !this.ExprCanBeRemovedIfUnused(property.InitializerOrNil)) {
          return false;
        }

        // Legacy TypeScript static class fields are considered to have side
        // effects because they use assign semantics, not define semantics, and
        // that can trigger getters.
        if (property.Kind === js_ast.PropertyKind.PropertyField && !class_.UseDefineForClassFields) {
          return false;
        }
      }
    }

    return true;
  }

  /** Go: func (ctx HelperContext) ExprCanBeRemovedIfUnused(expr Expr) bool (js_ast_helpers.go:2432) */
  ExprCanBeRemovedIfUnused(expr: js_ast.Expr): boolean {
    const e = expr.Data;

    if (e instanceof js_ast.EAnnotation) {
      return js_ast.Has(e.Flags, js_ast.AnnotationFlags.CanBeRemovedIfUnusedFlag);
    } else if (e instanceof js_ast.EInlinedEnum) {
      return this.ExprCanBeRemovedIfUnused(e.Value);
    } else if (e instanceof js_ast.ENull || e instanceof js_ast.EUndefined || e instanceof js_ast.EMissing ||
      e instanceof js_ast.EBoolean || e instanceof js_ast.ENumber || e instanceof js_ast.EBigInt ||
      e instanceof js_ast.EString || e instanceof js_ast.EThis || e instanceof js_ast.ERegExp ||
      e instanceof js_ast.EFunction || e instanceof js_ast.EArrow || e instanceof js_ast.EImportMeta) {
      return true;
    } else if (e instanceof js_ast.EDot) {
      return e.CanBeRemovedIfUnused;
    } else if (e instanceof js_ast.EClass) {
      return this.ClassCanBeRemovedIfUnused(e.Class);
    } else if (e instanceof js_ast.EIdentifier) {
      if (e.MustKeepDueToWithStmt) return false;

      // Unbound identifiers cannot be removed because they can have side effects.
      if (e.CanBeRemovedIfUnused || !this.isUnbound(e.Ref)) return true;
    } else if (e instanceof js_ast.EImportIdentifier) {
      // References to an ES6 import item are always side-effect free in an
      // ECMAScript environment.
      return true;
    } else if (e instanceof js_ast.EIf) {
      return this.ExprCanBeRemovedIfUnused(e.Test) &&
        ((this.isSideEffectFreeUnboundIdentifierRef(e.Yes, e.Test, true) || this.ExprCanBeRemovedIfUnused(e.Yes)) &&
          (this.isSideEffectFreeUnboundIdentifierRef(e.No, e.Test, false) || this.ExprCanBeRemovedIfUnused(e.No)));
    } else if (e instanceof js_ast.EArray) {
      for (let item of e.Items) {
        if (item.Data instanceof js_ast.ESpread) {
          if (item.Data.Value.Data instanceof js_ast.EArray) {
            // Spread of an inline array such as "[...[x]]" is side-effect free
            item = item.Data.Value;
          }
        }

        if (!this.ExprCanBeRemovedIfUnused(item)) return false;
      }
      return true;
    } else if (e instanceof js_ast.EObject) {
      for (const property of e.Properties) {
        // The key must still be evaluated if it's computed or a spread
        if (property.Kind === js_ast.PropertyKind.PropertySpread) return false;
        if (js_ast.Has(property.Flags, js_ast.PropertyFlags.PropertyIsComputed) &&
          !IsPrimitiveLiteral(property.Key.Data) && !IsSymbolInstance(property.Key.Data)) {
          return false;
        }
        if (property.ValueOrNil !== null && property.ValueOrNil.Data !== null &&
          !this.ExprCanBeRemovedIfUnused(property.ValueOrNil)) {
          return false;
        }
      }
      return true;
    } else if (e instanceof js_ast.ECall) {
      // A call that has been marked "__PURE__" can be removed if all arguments
      // can be removed. The annotation causes us to ignore the target.
      if (e.CanBeUnwrappedIfUnused) {
        for (const arg of e.Args) {
          if (!this.ExprCanBeRemovedIfUnused(arg)) return false;
        }
        return true;
      }
    } else if (e instanceof js_ast.ENew) {
      // A constructor call that has been marked "__PURE__" can be removed if all
      // arguments can be removed. The annotation causes us to ignore the target.
      if (e.CanBeUnwrappedIfUnused) {
        for (const arg of e.Args) {
          if (!this.ExprCanBeRemovedIfUnused(arg)) return false;
        }
        return true;
      }
    } else if (e instanceof js_ast.EUnary) {
      switch (e.Op) {
        // These operators must not have any type conversions that can execute code
        // such as "toString" or "valueOf". They must also never throw any exceptions.
        case js_ast.OpCode.UnOpVoid:
        case js_ast.OpCode.UnOpNot:
          return this.ExprCanBeRemovedIfUnused(e.Value);

        case js_ast.OpCode.UnOpNeg:
          if (e.Value.Data instanceof js_ast.EBigInt) {
            // Consider negated bigints to have no side effects
            return true;
          }
          break;

        case js_ast.OpCode.UnOpTypeof:
          if (e.Value.Data instanceof js_ast.EIdentifier && e.WasOriginallyTypeofIdentifier) {
            // Expressions such as "typeof x" never have any side effects
            return true;
          }
          return this.ExprCanBeRemovedIfUnused(e.Value);
      }
    } else if (e instanceof js_ast.EBinary) {
      switch (e.Op) {
        // These operators must not have any type conversions that can execute code
        // such as "toString" or "valueOf". They must also never throw any exceptions.
        case js_ast.OpCode.BinOpStrictEq:
        case js_ast.OpCode.BinOpStrictNe:
        case js_ast.OpCode.BinOpComma:
        case js_ast.OpCode.BinOpNullishCoalescing:
          return this.ExprCanBeRemovedIfUnused(e.Left) && this.ExprCanBeRemovedIfUnused(e.Right);

        // Special-case "||" to make sure "typeof x === 'undefined' || x" can be removed
        case js_ast.OpCode.BinOpLogicalOr:
          return this.ExprCanBeRemovedIfUnused(e.Left) &&
            (this.isSideEffectFreeUnboundIdentifierRef(e.Right, e.Left, false) || this.ExprCanBeRemovedIfUnused(e.Right));

        // Special-case "&&" to make sure "typeof x !== 'undefined' && x" can be removed
        case js_ast.OpCode.BinOpLogicalAnd:
          return this.ExprCanBeRemovedIfUnused(e.Left) &&
            (this.isSideEffectFreeUnboundIdentifierRef(e.Right, e.Left, true) || this.ExprCanBeRemovedIfUnused(e.Right));

        // For "==" and "!=", pretend the operator was actually "===" or "!==".
        case js_ast.OpCode.BinOpLooseEq:
        case js_ast.OpCode.BinOpLooseNe:
          return CanChangeStrictToLoose(e.Left, e.Right) &&
            this.ExprCanBeRemovedIfUnused(e.Left) && this.ExprCanBeRemovedIfUnused(e.Right);

        // Special-case "<" and ">" with string, number, or bigint arguments
        case js_ast.OpCode.BinOpLt:
        case js_ast.OpCode.BinOpGt:
        case js_ast.OpCode.BinOpLe:
        case js_ast.OpCode.BinOpGe: {
          const left = KnownPrimitiveType(e.Left.Data);
          switch (left) {
            case PrimitiveString:
            case PrimitiveNumber:
            case PrimitiveBigInt:
              return KnownPrimitiveType(e.Right.Data) === left &&
                this.ExprCanBeRemovedIfUnused(e.Left) && this.ExprCanBeRemovedIfUnused(e.Right);
          }
          break;
        }
      }
    } else if (e instanceof js_ast.ETemplate) {
      // A template can be removed if it has no tag and every value has no side
      // effects and results in some kind of primitive, since all primitives
      // have a "ToString" operation with no side effects.
      if (e.TagOrNil === null || e.TagOrNil.Data === null || e.CanBeUnwrappedIfUnused) {
        for (const part of e.Parts) {
          if (!this.ExprCanBeRemovedIfUnused(part.Value) ||
            KnownPrimitiveType(part.Value.Data) === PrimitiveUnknown) {
            return false;
          }
        }
        return true;
      }
    }

    // Assume all other expression types have side effects and cannot be removed
    return false;
  }

  /** Go: func (ctx HelperContext) isSideEffectFreeUnboundIdentifierRef(value Expr, guardCondition Expr, isYesBranch bool) bool (js_ast_helpers.go:2637) */
  isSideEffectFreeUnboundIdentifierRef(
    value: js_ast.Expr,
    guardCondition: js_ast.Expr,
    isYesBranch: boolean,
  ): boolean {
    if (value.Data instanceof js_ast.EIdentifier && this.isUnbound(value.Data.Ref)) {
      const id = value.Data;
      if (guardCondition.Data instanceof js_ast.EBinary) {
        const binary = guardCondition.Data;
        switch (binary.Op) {
          case js_ast.OpCode.BinOpStrictEq:
          case js_ast.OpCode.BinOpStrictNe:
          case js_ast.OpCode.BinOpLooseEq:
          case js_ast.OpCode.BinOpLooseNe: {
            // Pattern match for "typeof x !== <string>"
            let typeofExpr = binary.Left;
            let str = binary.Right;
            if (typeofExpr.Data instanceof js_ast.EString) {
              const temp = typeofExpr; typeofExpr = str; str = temp;
            }
            if (typeofExpr.Data instanceof js_ast.EUnary &&
              typeofExpr.Data.Op === js_ast.OpCode.UnOpTypeof &&
              typeofExpr.Data.WasOriginallyTypeofIdentifier) {
              if (str.Data instanceof js_ast.EString) {
                // In "typeof x !== 'undefined' ? x : null", the reference to "x" is side-effect free
                // In "typeof x === 'object' ? x : null", the reference to "x" is side-effect free
                if ((UTF16EqualsString(str.Data.Value, utf8("undefined")) === isYesBranch) ===
                  (binary.Op === js_ast.OpCode.BinOpStrictNe || binary.Op === js_ast.OpCode.BinOpLooseNe)) {
                  if (typeofExpr.Data.Value.Data instanceof js_ast.EIdentifier &&
                    refEquals(typeofExpr.Data.Value.Data.Ref, id.Ref)) {
                    return true;
                  }
                }
              }
            }
            break;
          }

          case js_ast.OpCode.BinOpLt:
          case js_ast.OpCode.BinOpGt:
          case js_ast.OpCode.BinOpLe:
          case js_ast.OpCode.BinOpGe: {
            // Pattern match for "typeof x < <string>"
            let typeofExpr = binary.Left;
            let str = binary.Right;
            if (typeofExpr.Data instanceof js_ast.EString) {
              const temp = typeofExpr; typeofExpr = str; str = temp;
              isYesBranch = !isYesBranch;
            }
            if (typeofExpr.Data instanceof js_ast.EUnary &&
              typeofExpr.Data.Op === js_ast.OpCode.UnOpTypeof &&
              typeofExpr.Data.WasOriginallyTypeofIdentifier) {
              if (str.Data instanceof js_ast.EString &&
                UTF16EqualsString(str.Data.Value, utf8("u"))) {
                // In "typeof x < 'u' ? x : null", the reference to "x" is side-effect free
                // In "typeof x > 'u' ? x : null", the reference to "x" is side-effect free
                if (isYesBranch === (binary.Op === js_ast.OpCode.BinOpLt || binary.Op === js_ast.OpCode.BinOpLe)) {
                  if (typeofExpr.Data.Value.Data instanceof js_ast.EIdentifier &&
                    refEquals(typeofExpr.Data.Value.Data.Ref, id.Ref)) {
                    return true;
                  }
                }
              }
            }
            break;
          }
        }
      }
    }
    return false;
  }

  /** Go: func (ctx HelperContext) MangleIfExpr(loc logger.Loc, e *EIf, unsupportedFeatures compat.JSFeature) Expr (js_ast_helpers.go:2788) */
  MangleIfExpr(loc: Loc, e: js_ast.EIf, unsupportedFeatures: JSFeature): js_ast.Expr {
    let test = e.Test;
    let yes = e.Yes;
    let no = e.No;

    // "(a, b) ? c : d" => "a, b ? c : d"
    if (test.Data instanceof js_ast.EBinary && test.Data.Op === js_ast.OpCode.BinOpComma) {
      const comma = test.Data;
      const inner = new js_ast.EIf();
      inner.Test = comma.Right;
      inner.Yes = yes;
      inner.No = no;
      return JoinWithComma(comma.Left, this.MangleIfExpr(comma.Right.Loc, inner, unsupportedFeatures));
    }

    // "!a ? b : c" => "a ? c : b"
    if (test.Data instanceof js_ast.EUnary && test.Data.Op === js_ast.OpCode.UnOpNot) {
      test = test.Data.Value;
      const temp = yes; yes = no; no = temp;
    }

    if (ValuesLookTheSame(yes.Data, no.Data)) {
      // "/* @__PURE__ */ a() ? b : b" => "b"
      if (this.ExprCanBeRemovedIfUnused(test)) return yes;

      // "a ? b : b" => "a, b"
      return JoinWithComma(test, yes);
    }

    // "a ? true : false" => "!!a"
    // "a ? false : true" => "!a"
    if (yes.Data instanceof js_ast.EBoolean) {
      if (no.Data instanceof js_ast.EBoolean) {
        if (yes.Data.Value && !no.Data.Value) return Not(Not(test));
        if (!yes.Data.Value && no.Data.Value) return Not(test);
      }
    }

    if (test.Data instanceof js_ast.EIdentifier) {
      const id = test.Data;
      // "a ? a : b" => "a || b"
      if (yes.Data instanceof js_ast.EIdentifier && refEquals(id.Ref, yes.Data.Ref)) {
        return JoinWithLeftAssociativeOp(js_ast.OpCode.BinOpLogicalOr, test, no);
      }

      // "a ? b : a" => "a && b"
      if (no.Data instanceof js_ast.EIdentifier && refEquals(id.Ref, no.Data.Ref)) {
        return JoinWithLeftAssociativeOp(js_ast.OpCode.BinOpLogicalAnd, test, yes);
      }
    }

    // "a ? b ? c : d : d" => "a && b ? c : d"
    if (yes.Data instanceof js_ast.EIf && ValuesLookTheSame(yes.Data.No.Data, no.Data)) {
      const result = new js_ast.EIf();
      result.Test = JoinWithLeftAssociativeOp(js_ast.OpCode.BinOpLogicalAnd, test, yes.Data.Test);
      result.Yes = yes.Data.Yes;
      result.No = no;
      return new js_ast.Expr(result, loc);
    }

    // "a ? b : c ? b : d" => "a || c ? b : d"
    if (no.Data instanceof js_ast.EIf && ValuesLookTheSame(yes.Data, no.Data.Yes.Data)) {
      const result = new js_ast.EIf();
      result.Test = JoinWithLeftAssociativeOp(js_ast.OpCode.BinOpLogicalOr, test, no.Data.Test);
      result.Yes = yes;
      result.No = no.Data.No;
      return new js_ast.Expr(result, loc);
    }

    // "a ? c : (b, c)" => "(a || b), c"
    if (no.Data instanceof js_ast.EBinary && no.Data.Op === js_ast.OpCode.BinOpComma &&
      ValuesLookTheSame(yes.Data, no.Data.Right.Data)) {
      return JoinWithComma(
        JoinWithLeftAssociativeOp(js_ast.OpCode.BinOpLogicalOr, test, no.Data.Left),
        no.Data.Right,
      );
    }

    // "a ? (b, c) : c" => "(a && b), c"
    if (yes.Data instanceof js_ast.EBinary && yes.Data.Op === js_ast.OpCode.BinOpComma &&
      ValuesLookTheSame(yes.Data.Right.Data, no.Data)) {
      return JoinWithComma(
        JoinWithLeftAssociativeOp(js_ast.OpCode.BinOpLogicalAnd, test, yes.Data.Left),
        yes.Data.Right,
      );
    }

    // "a ? b || c : c" => "(a && b) || c"
    if (yes.Data instanceof js_ast.EBinary && yes.Data.Op === js_ast.OpCode.BinOpLogicalOr &&
      ValuesLookTheSame(yes.Data.Right.Data, no.Data)) {
      const binary = new js_ast.EBinary();
      binary.Op = js_ast.OpCode.BinOpLogicalOr;
      binary.Left = JoinWithLeftAssociativeOp(js_ast.OpCode.BinOpLogicalAnd, test, yes.Data.Left);
      binary.Right = yes.Data.Right;
      return new js_ast.Expr(binary, loc);
    }

    // "a ? c : b && c" => "(a || b) && c"
    if (no.Data instanceof js_ast.EBinary && no.Data.Op === js_ast.OpCode.BinOpLogicalAnd &&
      ValuesLookTheSame(yes.Data, no.Data.Right.Data)) {
      const binary = new js_ast.EBinary();
      binary.Op = js_ast.OpCode.BinOpLogicalAnd;
      binary.Left = JoinWithLeftAssociativeOp(js_ast.OpCode.BinOpLogicalOr, test, no.Data.Left);
      binary.Right = no.Data.Right;
      return new js_ast.Expr(binary, loc);
    }

    // "a ? b(c, d) : b(e, d)" => "b(a ? c : e, d)"
    if (yes.Data instanceof js_ast.ECall && yes.Data.Args.length > 0) {
      const y = yes.Data;
      if (no.Data instanceof js_ast.ECall && no.Data.Args.length === y.Args.length &&
        y.HasSameFlagsAs(no.Data) && ValuesLookTheSame(y.Target.Data, no.Data.Target.Data)) {
        const n = no.Data;
        // Only do this if the condition can be reordered past the call target
        // without side effects.
        if (this.ExprCanBeRemovedIfUnused(test) && this.ExprCanBeRemovedIfUnused(y.Target)) {
          let sameTailArgs = true;
          for (let i = 1; i < y.Args.length; i++) {
            if (!ValuesLookTheSame(y.Args[i].Data, n.Args[i].Data)) {
              sameTailArgs = false;
              break;
            }
          }
          if (sameTailArgs) {
            const yesSpread = y.Args[0].Data instanceof js_ast.ESpread ? y.Args[0].Data : null;
            const noSpread = n.Args[0].Data instanceof js_ast.ESpread ? n.Args[0].Data : null;

            // "a ? b(...c) : b(...e)" => "b(...a ? c : e)"
            if (yesSpread !== null && noSpread !== null) {
              // Don't mutate the original AST
              const temp = new js_ast.EIf();
              temp.Test = test;
              temp.Yes = yesSpread.Value;
              temp.No = noSpread.Value;
              const clone = Object.assign(new js_ast.ECall(), y);
              clone.Args = [...clone.Args];
              const spread = new js_ast.ESpread();
              spread.Value = this.MangleIfExpr(loc, temp, unsupportedFeatures);
              clone.Args[0] = new js_ast.Expr(spread, loc);
              return new js_ast.Expr(clone, loc);
            }

            // "a ? b(c) : b(e)" => "b(a ? c : e)"
            if (yesSpread === null && noSpread === null) {
              // Don't mutate the original AST
              const temp = new js_ast.EIf();
              temp.Test = test;
              temp.Yes = y.Args[0];
              temp.No = n.Args[0];
              const clone = Object.assign(new js_ast.ECall(), y);
              clone.Args = [...clone.Args];
              clone.Args[0] = this.MangleIfExpr(loc, temp, unsupportedFeatures);
              return new js_ast.Expr(clone, loc);
            }
          }
        }
      }
    }

    // Try using the "??" or "?." operators
    if (test.Data instanceof js_ast.EBinary) {
      const binary = test.Data;
      let check: js_ast.Expr | null = null;
      let whenNull: js_ast.Expr = new js_ast.Expr();
      let whenNonNull: js_ast.Expr = new js_ast.Expr();

      switch (binary.Op) {
        case js_ast.OpCode.BinOpLooseEq:
          if (binary.Right.Data instanceof js_ast.ENull) {
            // "a == null ? _ : _"
            check = binary.Left; whenNull = yes; whenNonNull = no;
          } else if (binary.Left.Data instanceof js_ast.ENull) {
            // "null == a ? _ : _"
            check = binary.Right; whenNull = yes; whenNonNull = no;
          }
          break;

        case js_ast.OpCode.BinOpLooseNe:
          if (binary.Right.Data instanceof js_ast.ENull) {
            // "a != null ? _ : _"
            check = binary.Left; whenNonNull = yes; whenNull = no;
          } else if (binary.Left.Data instanceof js_ast.ENull) {
            // "null != a ? _ : _"
            check = binary.Right; whenNonNull = yes; whenNull = no;
          }
          break;
      }

      if (check !== null && this.ExprCanBeRemovedIfUnused(check)) {
        // "a != null ? a : b" => "a ?? b"
        if (!FeatureHas(unsupportedFeatures, JSFeature.NullishCoalescing) &&
          ValuesLookTheSame(check.Data, whenNonNull.Data)) {
          return JoinWithLeftAssociativeOp(js_ast.OpCode.BinOpNullishCoalescing, check, whenNull);
        }

        // "a != null ? a.b.c[d](e) : undefined" => "a?.b.c[d](e)"
        if (!FeatureHas(unsupportedFeatures, JSFeature.OptionalChain)) {
          if (whenNull.Data instanceof js_ast.EUndefined && TryToInsertOptionalChain(check, whenNonNull)) {
            return whenNonNull;
          }
        }
      }
    }

    // Don't mutate the original AST
    if (test !== e.Test || yes !== e.Yes || no !== e.No) {
      const result = new js_ast.EIf();
      result.Test = test;
      result.Yes = yes;
      result.No = no;
      return new js_ast.Expr(result, loc);
    }

    return new js_ast.Expr(e, loc);
  }
}

/** Go: func MakeHelperContext(isUnbound func(ast.Ref) bool) HelperContext (js_ast_helpers.go:18) */
export function MakeHelperContext(isUnbound: (ref: Ref) => boolean): HelperContext {
  return new HelperContext(isUnbound);
}

/** Go: func IsPropertyAccess(expr Expr) bool (js_ast_helpers.go:26) */
export function IsPropertyAccess(expr: js_ast.Expr): boolean {
  return expr.Data instanceof js_ast.EDot || expr.Data instanceof js_ast.EIndex;
}

/** Go: func IsOptionalChain(value Expr) bool (js_ast_helpers.go:34) */
export function IsOptionalChain(value: js_ast.Expr): boolean {
  const e = value.Data;
  if (e instanceof js_ast.EDot) return e.OptionalChain !== js_ast.OptionalChain.OptionalChainNone;
  if (e instanceof js_ast.EIndex) return e.OptionalChain !== js_ast.OptionalChain.OptionalChainNone;
  if (e instanceof js_ast.ECall) return e.OptionalChain !== js_ast.OptionalChain.OptionalChainNone;
  return false;
}

/** Go: func Assign(a Expr, b Expr) Expr (js_ast_helpers.go:46) */
export function Assign(a: js_ast.Expr, b: js_ast.Expr): js_ast.Expr {
  const binary = new js_ast.EBinary();
  binary.Op = js_ast.OpCode.BinOpAssign;
  binary.Left = a;
  binary.Right = b;
  return new js_ast.Expr(binary, a.Loc);
}

/** Go: func AssignStmt(a Expr, b Expr) Stmt (js_ast_helpers.go:50) */
export function AssignStmt(a: js_ast.Expr, b: js_ast.Expr): js_ast.Stmt {
  const stmt = new js_ast.SExpr();
  stmt.Value = Assign(a, b);
  return new js_ast.Stmt(stmt, a.Loc);
}

/** Go: func Not(expr Expr) Expr (js_ast_helpers.go:58) */
export function Not(expr: js_ast.Expr): js_ast.Expr {
  const [result, ok] = MaybeSimplifyNot(expr);
  if (ok) return result;
  const unary = new js_ast.EUnary();
  unary.Op = js_ast.OpCode.UnOpNot;
  unary.Value = expr;
  return new js_ast.Expr(unary, expr.Loc);
}

/**
 * Go: func MaybeSimplifyNot(expr Expr) (Expr, bool) (js_ast_helpers.go:73)
 * 返回 [expr, ok]。
 */
export function MaybeSimplifyNot(expr: js_ast.Expr): [js_ast.Expr, boolean] {
  const e = expr.Data;

  if (e instanceof js_ast.EAnnotation) {
    return MaybeSimplifyNot(e.Value);
  }

  if (e instanceof js_ast.EInlinedEnum) {
    const [value, ok] = MaybeSimplifyNot(e.Value);
    if (ok) return [value, true];
  }

  if (e instanceof js_ast.ENull || e instanceof js_ast.EUndefined) {
    return [new js_ast.Expr(new js_ast.EBoolean(true), expr.Loc), true];
  }

  if (e instanceof js_ast.EBoolean) {
    return [new js_ast.Expr(new js_ast.EBoolean(!e.Value), expr.Loc), true];
  }

  if (e instanceof js_ast.ENumber) {
    return [new js_ast.Expr(new js_ast.EBoolean(e.Value === 0 || Number.isNaN(e.Value)), expr.Loc), true];
  }

  if (e instanceof js_ast.EBigInt) {
    const [equal, ok] = CheckEqualityBigInt(e.Value, "0");
    if (ok) return [new js_ast.Expr(new js_ast.EBoolean(equal), expr.Loc), true];
  }

  if (e instanceof js_ast.EString) {
    return [new js_ast.Expr(new js_ast.EBoolean(e.Value.length === 0), expr.Loc), true];
  }

  if (e instanceof js_ast.EFunction || e instanceof js_ast.EArrow || e instanceof js_ast.ERegExp) {
    return [new js_ast.Expr(new js_ast.EBoolean(false), expr.Loc), true];
  }

  if (e instanceof js_ast.EUnary) {
    // "!!!a" => "!a"
    if (e.Op === js_ast.OpCode.UnOpNot && KnownPrimitiveType(e.Value.Data) === PrimitiveBoolean) {
      return [e.Value, true];
    }
  }

  if (e instanceof js_ast.EBinary) {
    const binary = (op: js_ast.OpCode): js_ast.Expr => {
      const result = new js_ast.EBinary();
      result.Op = op;
      result.Left = e.Left;
      result.Right = e.Right;
      return new js_ast.Expr(result, expr.Loc);
    };
    switch (e.Op) {
      // "!(a == b)" => "a != b"
      case js_ast.OpCode.BinOpLooseEq: return [binary(js_ast.OpCode.BinOpLooseNe), true];
      // "!(a != b)" => "a == b"
      case js_ast.OpCode.BinOpLooseNe: return [binary(js_ast.OpCode.BinOpLooseEq), true];
      // "!(a === b)" => "a !== b"
      case js_ast.OpCode.BinOpStrictEq: return [binary(js_ast.OpCode.BinOpStrictNe), true];
      // "!(a !== b)" => "a === b"
      case js_ast.OpCode.BinOpStrictNe: return [binary(js_ast.OpCode.BinOpStrictEq), true];
      // "!(a, b)" => "a, !b"
      case js_ast.OpCode.BinOpComma: {
        const result = new js_ast.EBinary();
        result.Op = js_ast.OpCode.BinOpComma;
        result.Left = e.Left;
        result.Right = Not(e.Right);
        return [new js_ast.Expr(result, expr.Loc), true];
      }
    }
  }

  return [new js_ast.Expr(), false];
}

/**
 * Go: func MaybeSimplifyEqualityComparison(loc logger.Loc, e *EBinary, unsupportedFeatures compat.JSFeature) (Expr, bool)
 * (js_ast_helpers.go:141)
 */
export function MaybeSimplifyEqualityComparison(
  loc: Loc,
  e: js_ast.EBinary,
  unsupportedFeatures: JSFeature,
): [js_ast.Expr, boolean] {
  let value = e.Left;
  let primitive = e.Right;

  // Detect when the primitive comes first and flip the order of our checks
  if (IsPrimitiveLiteral(value.Data)) {
    const temp = value;
    value = primitive;
    primitive = temp;
  }

  // "!x === true" => "!x"
  // "!x === false" => "!!x"
  // "!x !== true" => "!!x"
  // "!x !== false" => "!x"
  if (primitive.Data instanceof js_ast.EBoolean &&
    KnownPrimitiveType(value.Data) === PrimitiveBoolean) {
    if (primitive.Data.Value === (e.Op === js_ast.OpCode.BinOpLooseNe || e.Op === js_ast.OpCode.BinOpStrictNe)) {
      return [Not(value), true];
    } else {
      return [value, true];
    }
  }

  // "typeof x != 'undefined'" => "typeof x < 'u'"
  // "typeof x == 'undefined'" => "typeof x > 'u'"
  if (!FeatureHas(unsupportedFeatures, JSFeature.TypeofExoticObjectIsObject)) {
    // Only do this optimization if we know that the "typeof" operator won't
    // return something random. The only case of this happening was Internet
    // Explorer returning "unknown" for some objects, which messes with this
    // optimization. So we don't do this when targeting Internet Explorer.
    if (value.Data instanceof js_ast.EUnary && value.Data.Op === js_ast.OpCode.UnOpTypeof) {
      if (primitive.Data instanceof js_ast.EString &&
        UTF16EqualsString(primitive.Data.Value, utf8("undefined"))) {
        const flip = value === e.Right;
        let op: js_ast.OpCode = js_ast.OpCode.BinOpLt;
        if (((e.Op === js_ast.OpCode.BinOpLooseEq || e.Op === js_ast.OpCode.BinOpStrictEq) !== flip)) {
          op = js_ast.OpCode.BinOpGt;
        }
        // Go 值语义：`primitive.Data = &EString{...}` 只改局部副本
        primitive = withData(primitive, new js_ast.EString(utf16("u")));
        if (flip) {
          const temp = value;
          value = primitive;
          primitive = temp;
        }
        const result = new js_ast.EBinary();
        result.Op = op;
        result.Left = value;
        result.Right = primitive;
        return [new js_ast.Expr(result, loc), true];
      }
    }
  }

  return [new js_ast.Expr(), false];
}

/** Go: func IsSymbolInstance(data E) bool (js_ast_helpers.go:187) */
export function IsSymbolInstance(data: js_ast.E | null): boolean {
  if (data instanceof js_ast.EDot) return data.IsSymbolInstance;
  if (data instanceof js_ast.EIndex) return data.IsSymbolInstance;
  return false;
}

/** Go: func IsPrimitiveLiteral(data E) bool (js_ast_helpers.go:198) */
export function IsPrimitiveLiteral(data: js_ast.E | null): boolean {
  if (data instanceof js_ast.EAnnotation) return IsPrimitiveLiteral(data.Value.Data);
  if (data instanceof js_ast.EInlinedEnum) return IsPrimitiveLiteral(data.Value.Data);
  return data instanceof js_ast.ENull || data instanceof js_ast.EUndefined ||
    data instanceof js_ast.EString || data instanceof js_ast.EBoolean ||
    data instanceof js_ast.ENumber || data instanceof js_ast.EBigInt;
}

// ---------------------------------------------------------------------------
// 第 2 组：原始类型推断
// ---------------------------------------------------------------------------

/** Go: func MergedKnownPrimitiveTypes(a Expr, b Expr) PrimitiveType (js_ast_helpers.go:226) */
export function MergedKnownPrimitiveTypes(a: js_ast.Expr, b: js_ast.Expr): PrimitiveType {
  const x = KnownPrimitiveType(a.Data);
  if (x === PrimitiveUnknown) return PrimitiveUnknown;

  const y = KnownPrimitiveType(b.Data);
  if (y === PrimitiveUnknown) return PrimitiveUnknown;

  if (x === y) return x;
  return PrimitiveMixed; // Definitely some kind of primitive
}

/** Go: func KnownPrimitiveType(expr E) PrimitiveType (js_ast_helpers.go:245) */
export function KnownPrimitiveType(expr: js_ast.E | null): PrimitiveType {
  if (expr instanceof js_ast.EAnnotation) return KnownPrimitiveType(expr.Value.Data);
  if (expr instanceof js_ast.EInlinedEnum) return KnownPrimitiveType(expr.Value.Data);
  if (expr instanceof js_ast.ENull) return PrimitiveNull;
  if (expr instanceof js_ast.EUndefined) return PrimitiveUndefined;
  if (expr instanceof js_ast.EBoolean) return PrimitiveBoolean;
  if (expr instanceof js_ast.ENumber) return PrimitiveNumber;
  if (expr instanceof js_ast.EString) return PrimitiveString;
  if (expr instanceof js_ast.EBigInt) return PrimitiveBigInt;

  if (expr instanceof js_ast.ETemplate) {
    if (expr.TagOrNil === null || expr.TagOrNil.Data === null) return PrimitiveString;
  }

  if (expr instanceof js_ast.EIf) return MergedKnownPrimitiveTypes(expr.Yes, expr.No);

  if (expr instanceof js_ast.EUnary) {
    switch (expr.Op) {
      case js_ast.OpCode.UnOpVoid: return PrimitiveUndefined;
      case js_ast.OpCode.UnOpTypeof: return PrimitiveString;
      case js_ast.OpCode.UnOpNot:
      case js_ast.OpCode.UnOpDelete: return PrimitiveBoolean;
      case js_ast.OpCode.UnOpPos: return PrimitiveNumber; // Cannot be bigint because that throws an exception
      case js_ast.OpCode.UnOpNeg:
      case js_ast.OpCode.UnOpCpl: {
        const value = KnownPrimitiveType(expr.Value.Data);
        if (value === PrimitiveBigInt) return PrimitiveBigInt;
        if (value !== PrimitiveUnknown && value !== PrimitiveMixed) return PrimitiveNumber;
        return PrimitiveMixed; // Can be number or bigint
      }
      case js_ast.OpCode.UnOpPreDec:
      case js_ast.OpCode.UnOpPreInc:
      case js_ast.OpCode.UnOpPostDec:
      case js_ast.OpCode.UnOpPostInc:
        return PrimitiveMixed; // Can be number or bigint
    }
  }

  if (expr instanceof js_ast.EBinary) {
    switch (expr.Op) {
      case js_ast.OpCode.BinOpStrictEq:
      case js_ast.OpCode.BinOpStrictNe:
      case js_ast.OpCode.BinOpLooseEq:
      case js_ast.OpCode.BinOpLooseNe:
      case js_ast.OpCode.BinOpLt:
      case js_ast.OpCode.BinOpGt:
      case js_ast.OpCode.BinOpLe:
      case js_ast.OpCode.BinOpGe:
      case js_ast.OpCode.BinOpInstanceof:
      case js_ast.OpCode.BinOpIn:
        return PrimitiveBoolean;

      case js_ast.OpCode.BinOpLogicalOr:
      case js_ast.OpCode.BinOpLogicalAnd:
        return MergedKnownPrimitiveTypes(expr.Left, expr.Right);

      case js_ast.OpCode.BinOpNullishCoalescing: {
        const left = KnownPrimitiveType(expr.Left.Data);
        const right = KnownPrimitiveType(expr.Right.Data);
        if (left === PrimitiveNull || left === PrimitiveUndefined) return right;
        if (left !== PrimitiveUnknown) {
          if (left !== PrimitiveMixed) return left; // Definitely not null or undefined
          if (right !== PrimitiveUnknown) return PrimitiveMixed; // Definitely some kind of primitive
        }
        break;
      }

      case js_ast.OpCode.BinOpAdd: {
        const left = KnownPrimitiveType(expr.Left.Data);
        const right = KnownPrimitiveType(expr.Right.Data);
        if (left === PrimitiveString || right === PrimitiveString) return PrimitiveString;
        if (left === PrimitiveBigInt && right === PrimitiveBigInt) return PrimitiveBigInt;
        if (left !== PrimitiveUnknown && left !== PrimitiveMixed && left !== PrimitiveBigInt &&
          right !== PrimitiveUnknown && right !== PrimitiveMixed && right !== PrimitiveBigInt) {
          return PrimitiveNumber;
        }
        return PrimitiveMixed; // Can be number or bigint or string (or an exception)
      }

      case js_ast.OpCode.BinOpAddAssign: {
        const right = KnownPrimitiveType(expr.Right.Data);
        if (right === PrimitiveString) return PrimitiveString;
        return PrimitiveMixed; // Can be number or bigint or string (or an exception)
      }

      case js_ast.OpCode.BinOpSub:
      case js_ast.OpCode.BinOpSubAssign:
      case js_ast.OpCode.BinOpMul:
      case js_ast.OpCode.BinOpMulAssign:
      case js_ast.OpCode.BinOpDiv:
      case js_ast.OpCode.BinOpDivAssign:
      case js_ast.OpCode.BinOpRem:
      case js_ast.OpCode.BinOpRemAssign:
      case js_ast.OpCode.BinOpPow:
      case js_ast.OpCode.BinOpPowAssign:
      case js_ast.OpCode.BinOpBitwiseAnd:
      case js_ast.OpCode.BinOpBitwiseAndAssign:
      case js_ast.OpCode.BinOpBitwiseOr:
      case js_ast.OpCode.BinOpBitwiseOrAssign:
      case js_ast.OpCode.BinOpBitwiseXor:
      case js_ast.OpCode.BinOpBitwiseXorAssign:
      case js_ast.OpCode.BinOpShl:
      case js_ast.OpCode.BinOpShlAssign:
      case js_ast.OpCode.BinOpShr:
      case js_ast.OpCode.BinOpShrAssign:
      case js_ast.OpCode.BinOpUShr:
      case js_ast.OpCode.BinOpUShrAssign:
        return PrimitiveMixed; // Can be number or bigint (or an exception)

      case js_ast.OpCode.BinOpAssign:
      case js_ast.OpCode.BinOpComma:
        return KnownPrimitiveType(expr.Right.Data);
    }
  }

  return PrimitiveUnknown;
}

/** Go: func CanChangeStrictToLoose(a Expr, b Expr) bool (js_ast_helpers.go:376) */
export function CanChangeStrictToLoose(a: js_ast.Expr, b: js_ast.Expr): boolean {
  const x = KnownPrimitiveType(a.Data);
  const y = KnownPrimitiveType(b.Data);
  return x === y && x !== PrimitiveUnknown && x !== PrimitiveMixed;
}

/** Go: func TypeofWithoutSideEffects(data E) (string, bool) (js_ast_helpers.go:385) */
export function TypeofWithoutSideEffects(data: js_ast.E | null): [string, boolean] {
  if (data instanceof js_ast.EAnnotation) {
    if (js_ast.Has(data.Flags, js_ast.AnnotationFlags.CanBeRemovedIfUnusedFlag)) {
      return TypeofWithoutSideEffects(data.Value.Data);
    }
  } else if (data instanceof js_ast.EInlinedEnum) {
    return TypeofWithoutSideEffects(data.Value.Data);
  } else if (data instanceof js_ast.ENull) {
    return ["object", true];
  } else if (data instanceof js_ast.EUndefined) {
    return ["undefined", true];
  } else if (data instanceof js_ast.EBoolean) {
    return ["boolean", true];
  } else if (data instanceof js_ast.ENumber) {
    return ["number", true];
  } else if (data instanceof js_ast.EBigInt) {
    return ["bigint", true];
  } else if (data instanceof js_ast.EString) {
    return ["string", true];
  } else if (data instanceof js_ast.EFunction || data instanceof js_ast.EArrow) {
    return ["function", true];
  }

  return ["", false];
}

// ---------------------------------------------------------------------------
// 第 3 组：拼接
// ---------------------------------------------------------------------------

/** Go: func JoinWithLeftAssociativeOp(op OpCode, a Expr, b Expr) Expr (js_ast_helpers.go:429) */
export function JoinWithLeftAssociativeOp(op: js_ast.OpCode, a: js_ast.Expr, b: js_ast.Expr): js_ast.Expr {
  // "(a, b) op c" => "a, b op c"
  if (a.Data instanceof js_ast.EBinary && a.Data.Op === js_ast.OpCode.BinOpComma) {
    // Don't mutate the original AST
    const clone = Object.assign(new js_ast.EBinary(), a.Data);
    clone.Right = JoinWithLeftAssociativeOp(op, clone.Right, b);
    return new js_ast.Expr(clone, a.Loc);
  }

  // "a op (b op c)" => "(a op b) op c"
  // "a op (b op (c op d))" => "((a op b) op c) op d"
  for (; ;) {
    if (b.Data instanceof js_ast.EBinary && b.Data.Op === op) {
      a = JoinWithLeftAssociativeOp(op, a, b.Data.Left);
      b = b.Data.Right;
    } else {
      break;
    }
  }

  // "a op b" => "a op b"
  const result = new js_ast.EBinary();
  result.Op = op;
  result.Left = a;
  result.Right = b;
  return new js_ast.Expr(result, a.Loc);
}

/** Go: func JoinWithComma(a Expr, b Expr) Expr (js_ast_helpers.go:454) */
export function JoinWithComma(a: js_ast.Expr, b: js_ast.Expr): js_ast.Expr {
  if (a.Data === null) return b;
  if (b.Data === null) return a;
  const result = new js_ast.EBinary();
  result.Op = js_ast.OpCode.BinOpComma;
  result.Left = a;
  result.Right = b;
  return new js_ast.Expr(result, a.Loc);
}

/** Go: func JoinAllWithComma(all []Expr) (result Expr) (js_ast_helpers.go:464) */
export function JoinAllWithComma(all: js_ast.Expr[]): js_ast.Expr {
  let result = new js_ast.Expr();
  for (const value of all) result = JoinWithComma(result, value);
  return result;
}

/** Go: func simplifyUnusedStringAdditionChain(expr Expr) (Expr, bool) (js_ast_helpers.go:893) */
function simplifyUnusedStringAdditionChain(expr: js_ast.Expr): [js_ast.Expr, boolean] {
  const e = expr.Data;

  if (e instanceof js_ast.EString) {
    // "'x' + y" => "'' + y"
    return [new js_ast.Expr(new js_ast.EString(), expr.Loc), true];
  }

  if (e instanceof js_ast.EBinary) {
    if (e.Op === js_ast.OpCode.BinOpAdd) {
      const [left, leftIsStringAddition] = simplifyUnusedStringAdditionChain(e.Left);

      const right = e.Right.Data;
      if (right instanceof js_ast.EString) {
        // "('' + x) + 'y'" => "'' + x"
        if (leftIsStringAddition) return [left, true];

        // "x + 'y'" => "x + ''"
        if (!leftIsStringAddition && right.Value.length > 0) {
          const binary = new js_ast.EBinary();
          binary.Op = js_ast.OpCode.BinOpAdd;
          binary.Left = left;
          binary.Right = new js_ast.Expr(new js_ast.EString(), e.Right.Loc);
          return [new js_ast.Expr(binary, expr.Loc), true];
        }
      }

      // Don't mutate the original AST
      if (left !== e.Left) {
        const binary = new js_ast.EBinary();
        binary.Op = js_ast.OpCode.BinOpAdd;
        binary.Left = left;
        binary.Right = e.Right;
        // Go 值语义：expr.Data = ... 只改局部副本
        expr = withData(expr, binary);
      }

      return [expr, leftIsStringAddition];
    }
  }

  return [expr, false];
}

/** Go: func ConvertBindingToExpr(binding Binding, wrapIdentifier func(logger.Loc, ast.Ref) Expr) Expr (js_ast_helpers.go:471) */
export function ConvertBindingToExpr(
  binding: js_ast.Binding,
  wrapIdentifier: ((loc: Loc, ref: Ref) => js_ast.Expr) | null,
): js_ast.Expr {
  const loc = binding.Loc;
  const b = binding.Data;

  if (b instanceof js_ast.BMissing) {
    return new js_ast.Expr(new js_ast.EMissing(), loc);
  }

  if (b instanceof js_ast.BIdentifier) {
    if (wrapIdentifier !== null) return wrapIdentifier(loc, b.Ref);
    return new js_ast.Expr(new js_ast.EIdentifier(b.Ref), loc);
  }

  if (b instanceof js_ast.BArray) {
    const exprs: js_ast.Expr[] = [];
    for (let i = 0; i < b.Items.length; i++) {
      const item = b.Items[i];
      let expr = ConvertBindingToExpr(item.Binding, wrapIdentifier);
      if (b.HasSpread && i + 1 === b.Items.length) {
        // Go 值语义：expr 是局部变量
        const spread = new js_ast.ESpread();
        spread.Value = expr;
        expr = new js_ast.Expr(spread, expr.Loc);
      } else if (item.DefaultValueOrNil !== null && item.DefaultValueOrNil.Data !== null) {
        expr = Assign(expr, item.DefaultValueOrNil);
      }
      exprs.push(expr);
    }
    const array = new js_ast.EArray();
    array.Items = exprs;
    array.IsSingleLine = b.IsSingleLine;
    return new js_ast.Expr(array, loc);
  }

  if (b instanceof js_ast.BObject) {
    const properties: js_ast.Property[] = [];
    for (const property of b.Properties) {
      const value = ConvertBindingToExpr(property.Value, wrapIdentifier);
      let kind: js_ast.PropertyKind = js_ast.PropertyKind.PropertyField;
      if (property.IsSpread) kind = js_ast.PropertyKind.PropertySpread;
      let flags: js_ast.PropertyFlags = 0;
      if (property.IsComputed) flags |= js_ast.PropertyFlags.PropertyIsComputed;
      const result = new js_ast.Property();
      result.Kind = kind;
      result.Flags = flags;
      result.Key = property.Key;
      result.ValueOrNil = value;
      result.InitializerOrNil = property.DefaultValueOrNil;
      properties.push(result);
    }
    const object = new js_ast.EObject();
    object.Properties = properties;
    object.IsSingleLine = b.IsSingleLine;
    return new js_ast.Expr(object, loc);
  }

  throw new Error("Internal error");
}

// ---------------------------------------------------------------------------
// 第 4 组：数值 / 字符串提取与折叠
// ---------------------------------------------------------------------------

/** Go: func ToInt32(f float64) int32 (js_ast_helpers.go:931) */
export function ToInt32(f: number): number {
  // The easy way
  const i = f | 0;
  if (i === f) return i;

  // Special-case non-finite numbers (casting them is unspecified behavior in Go)
  if (Number.isNaN(f) || !Number.isFinite(f)) return 0;

  // The hard way
  const j = (Math.abs(f) % 4294967296) | 0;
  if (f < 0 || Object.is(f, -0)) {
    return (-j) | 0;
  }
  return j;
}

/** Go: func ToUint32(f float64) uint32 (js_ast_helpers.go:951) */
export function ToUint32(f: number): number {
  return ToInt32(f) >>> 0;
}

// If this returns true, we know the result can't be NaN
/** Go: func isInt32OrUint32(data E) bool (js_ast_helpers.go:956) */
export function isInt32OrUint32(data: js_ast.E | null): boolean {
  if (data instanceof js_ast.EBinary) {
    switch (data.Op) {
      case js_ast.OpCode.BinOpUShr: // This is the only bitwise operator that can't return a bigint (because it throws instead)
        return true;
      case js_ast.OpCode.BinOpLogicalOr:
      case js_ast.OpCode.BinOpLogicalAnd:
        return isInt32OrUint32(data.Left.Data) && isInt32OrUint32(data.Right.Data);
    }
  } else if (data instanceof js_ast.EIf) {
    return isInt32OrUint32(data.Yes.Data) && isInt32OrUint32(data.No.Data);
  }
  return false;
}

/** Go: func ToNumberWithoutSideEffects(data E) (float64, bool) (js_ast_helpers.go:973) */
export function ToNumberWithoutSideEffects(data: js_ast.E | null): [number, boolean] {
  if (data instanceof js_ast.EAnnotation) return ToNumberWithoutSideEffects(data.Value.Data);
  if (data instanceof js_ast.EInlinedEnum) return ToNumberWithoutSideEffects(data.Value.Data);
  if (data instanceof js_ast.ENull) return [0, true];
  if (data instanceof js_ast.EUndefined || data instanceof js_ast.ERegExp) return [NaN, true];

  if (data instanceof js_ast.EArray) {
    if (data.Items.length === 0) return [0, true]; // "+[]" => "0"
  } else if (data instanceof js_ast.EObject) {
    if (data.Properties.length === 0) return [NaN, true]; // "+{}" => "NaN"
  } else if (data instanceof js_ast.EBoolean) {
    return [data.Value ? 1 : 0, true];
  } else if (data instanceof js_ast.ENumber) {
    return [data.Value, true];
  } else if (data instanceof js_ast.EString) {
    if (data.Value.length === 0) return [0, true]; // "+''" => "0"

    // "+'1'" => "1"
    const num = StringToEquivalentNumberValue(data.Value);
    if (num[1]) return [num[0], true];
  }

  return [0, false];
}

/** Go: func ToStringWithoutSideEffects(data E) (string, bool) (js_ast_helpers.go:1024) */
export function ToStringWithoutSideEffects(data: js_ast.E | null): [string, boolean] {
  if (data instanceof js_ast.ENull) return ["null", true];
  if (data instanceof js_ast.EUndefined) return ["undefined", true];
  if (data instanceof js_ast.EBoolean) return [data.Value ? "true" : "false", true];

  if (data instanceof js_ast.EBigInt) {
    // Only do this if there is no radix
    if (data.Value.length < 2 || data.Value[0] !== "0") return [data.Value, true];
  } else if (data instanceof js_ast.ENumber) {
    const str = TryToStringOnNumberSafely(data.Value, 10);
    if (str[1]) return [str[0], true];
  } else if (data instanceof js_ast.ERegExp) {
    return [data.Value, true];
  } else if (data instanceof js_ast.EDot) {
    // This is dumb but some JavaScript obfuscators use this to generate string literals
    if (data.Name === "constructor") {
      if (data.Target.Data instanceof js_ast.EString) {
        return ["function String() { [native code] }", true];
      }
      if (data.Target.Data instanceof js_ast.ERegExp) {
        return ["function RegExp() { [native code] }", true];
      }
    }
  }

  return ["", false];
}

/** Go: func extractNumericValue(data E) (float64, bool) (js_ast_helpers.go:1069) */
function extractNumericValue(data: js_ast.E | null): [number, boolean] {
  if (data instanceof js_ast.EAnnotation) return extractNumericValue(data.Value.Data);
  if (data instanceof js_ast.EInlinedEnum) return extractNumericValue(data.Value.Data);
  if (data instanceof js_ast.ENumber) return [data.Value, true];
  return [0, false];
}

/** Go: func extractNumericValues(left Expr, right Expr) (float64, float64, bool) (js_ast_helpers.go:1084) */
function extractNumericValues(left: js_ast.Expr, right: js_ast.Expr): [number, number, boolean] {
  const a = extractNumericValue(left.Data);
  if (a[1]) {
    const b = extractNumericValue(right.Data);
    if (b[1]) return [a[0], b[0], true];
  }
  return [0, 0, false];
}

/** Go: func extractStringValue(data E) ([]uint16, bool) (js_ast_helpers.go:1093) */
function extractStringValue(data: js_ast.E | null): [Uint16Array, boolean] {
  if (data instanceof js_ast.EAnnotation) return extractStringValue(data.Value.Data);
  if (data instanceof js_ast.EInlinedEnum) return extractStringValue(data.Value.Data);
  if (data instanceof js_ast.EString) return [data.Value, true];
  return [new Uint16Array(0), false];
}

/** Go: func extractStringValues(left Expr, right Expr) ([]uint16, []uint16, bool) (js_ast_helpers.go:1108) */
function extractStringValues(left: js_ast.Expr, right: js_ast.Expr): [Uint16Array, Uint16Array, boolean] {
  const a = extractStringValue(left.Data);
  if (a[1]) {
    const b = extractStringValue(right.Data);
    if (b[1]) return [a[0], b[0], true];
  }
  return [new Uint16Array(0), new Uint16Array(0), false];
}

/** Go: func stringCompareUCS2(a []uint16, b []uint16) int (js_ast_helpers.go:1117) */
export function stringCompareUCS2(a: Uint16Array | number[], b: Uint16Array | number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const delta = a[i] - b[i];
    if (delta !== 0) return delta;
  }
  return a.length - b.length;
}

/** Go: func approximatePrintedIntCharCount(intValue float64) int (js_ast_helpers.go:1132) */
export function approximatePrintedIntCharCount(intValue: number): number {
  let count = 1 + Math.floor(Math.max(0, Math.floor(Math.log10(Math.abs(intValue)))));
  if (intValue < 0) count++;
  return count;
}

/** Go: func ShouldFoldBinaryOperatorWhenMinifying(binary *EBinary) bool (js_ast_helpers.go:1140) */
export function ShouldFoldBinaryOperatorWhenMinifying(binary: js_ast.EBinary): boolean {
  switch (binary.Op) {
    // Equality tests should always result in smaller code when folded
    case js_ast.OpCode.BinOpLooseEq:
    case js_ast.OpCode.BinOpLooseNe:
    case js_ast.OpCode.BinOpStrictEq:
    case js_ast.OpCode.BinOpStrictNe:
    // Minification always folds right signed shift operations since they are
    // unlikely to result in larger output. Note: ">>>" could result in
    // bigger output such as "-1 >>> 0" becoming "4294967295".
    case js_ast.OpCode.BinOpShr:
    // Minification always folds the following bitwise operations since they
    // are unlikely to result in larger output.
    case js_ast.OpCode.BinOpBitwiseAnd:
    case js_ast.OpCode.BinOpBitwiseOr:
    case js_ast.OpCode.BinOpBitwiseXor:
    case js_ast.OpCode.BinOpLt:
    case js_ast.OpCode.BinOpGt:
    case js_ast.OpCode.BinOpLe:
    case js_ast.OpCode.BinOpGe:
      return true;

    case js_ast.OpCode.BinOpAdd: {
      // Addition of small-ish integers can definitely be folded without issues
      const [left, right, ok] = extractNumericValues(binary.Left, binary.Right);
      if (ok && left === Math.trunc(left) && Math.abs(left) <= 0xffff_ffff &&
        right === Math.trunc(right) && Math.abs(right) <= 0xffff_ffff) {
        return true;
      }

      // String addition should pretty much always be more compact when folded
      const [, , strings] = extractStringValues(binary.Left, binary.Right);
      if (strings) return true;
      break;
    }

    case js_ast.OpCode.BinOpSub: {
      // Subtraction of small-ish integers can definitely be folded without issues
      const [left, right, ok] = extractNumericValues(binary.Left, binary.Right);
      if (ok && left === Math.trunc(left) && Math.abs(left) <= 0xffff_ffff &&
        right === Math.trunc(right) && Math.abs(right) <= 0xffff_ffff) {
        return true;
      }
      break;
    }

    case js_ast.OpCode.BinOpMul: {
      // Allow multiplication of small-ish integers to be folded
      const [left, right, ok] = extractNumericValues(binary.Left, binary.Right);
      if (ok && left === Math.trunc(left) && Math.abs(left) <= 0xff &&
        right === Math.trunc(right) && Math.abs(right) <= 0xff) {
        return true;
      }
      break;
    }

    case js_ast.OpCode.BinOpDiv: {
      // "0/0" => "NaN"
      // "1/0" => "Infinity"
      // "1/-0" => "-Infinity"
      const [left, right, ok] = extractNumericValues(binary.Left, binary.Right);
      if (ok && right === 0) return true;
      break;
    }

    case js_ast.OpCode.BinOpShl: {
      // "1 << 3" => "8"
      // "1 << 24" => "1 << 24" (since "1<<24" is shorter than "16777216")
      const [left, right, ok] = extractNumericValues(binary.Left, binary.Right);
      if (ok) {
        const leftLen = approximatePrintedIntCharCount(left);
        const rightLen = approximatePrintedIntCharCount(right);
        const resultLen = approximatePrintedIntCharCount(
          (ToInt32(left) << (ToUint32(right) & 31)) | 0,
        );
        return resultLen <= leftLen + 2 + rightLen;
      }
      break;
    }

    case js_ast.OpCode.BinOpUShr: {
      // "10 >>> 1" => "5"
      // "-1 >>> 0" => "-1 >>> 0" (since "-1>>>0" is shorter than "4294967295")
      const [left, right, ok] = extractNumericValues(binary.Left, binary.Right);
      if (ok) {
        const leftLen = approximatePrintedIntCharCount(left);
        const rightLen = approximatePrintedIntCharCount(right);
        const resultLen = approximatePrintedIntCharCount(ToUint32(left) >>> (ToUint32(right) & 31));
        return resultLen <= leftLen + 3 + rightLen;
      }
      break;
    }

    case js_ast.OpCode.BinOpLogicalAnd:
    case js_ast.OpCode.BinOpLogicalOr:
    case js_ast.OpCode.BinOpNullishCoalescing:
      if (IsPrimitiveLiteral(binary.Left.Data)) return true;
      break;
  }
  return false;
}

/** Go: func FoldBinaryOperator(loc logger.Loc, e *EBinary) Expr (js_ast_helpers.go:1235) */
export function FoldBinaryOperator(loc: Loc, e: js_ast.EBinary): js_ast.Expr {
  switch (e.Op) {
    case js_ast.OpCode.BinOpAdd: {
      const [left, right, ok] = extractNumericValues(e.Left, e.Right);
      if (ok) return new js_ast.Expr(new js_ast.ENumber(left + right), loc);
      const [sl, sr, sok] = extractStringValues(e.Left, e.Right);
      if (sok) return new js_ast.Expr(new js_ast.EString(joinStrings(sl, sr)), loc);
      break;
    }

    case js_ast.OpCode.BinOpSub: {
      const [left, right, ok] = extractNumericValues(e.Left, e.Right);
      if (ok) return new js_ast.Expr(new js_ast.ENumber(left - right), loc);
      break;
    }

    case js_ast.OpCode.BinOpMul: {
      const [left, right, ok] = extractNumericValues(e.Left, e.Right);
      if (ok) return new js_ast.Expr(new js_ast.ENumber(left * right), loc);
      break;
    }

    case js_ast.OpCode.BinOpDiv: {
      const [left, right, ok] = extractNumericValues(e.Left, e.Right);
      if (ok) return new js_ast.Expr(new js_ast.ENumber(left / right), loc);
      break;
    }

    case js_ast.OpCode.BinOpRem: {
      const [left, right, ok] = extractNumericValues(e.Left, e.Right);
      if (ok) return new js_ast.Expr(new js_ast.ENumber(left % right), loc);
      break;
    }

    case js_ast.OpCode.BinOpPow: {
      const [left, right, ok] = extractNumericValues(e.Left, e.Right);
      if (ok) return new js_ast.Expr(new js_ast.ENumber(Math.pow(left, right)), loc);
      break;
    }

    case js_ast.OpCode.BinOpShl: {
      const [left, right, ok] = extractNumericValues(e.Left, e.Right);
      if (ok) return new js_ast.Expr(new js_ast.ENumber((ToInt32(left) << (ToUint32(right) & 31)) | 0), loc);
      break;
    }

    case js_ast.OpCode.BinOpShr: {
      const [left, right, ok] = extractNumericValues(e.Left, e.Right);
      if (ok) return new js_ast.Expr(new js_ast.ENumber(ToInt32(left) >> (ToUint32(right) & 31)), loc);
      break;
    }

    case js_ast.OpCode.BinOpUShr: {
      const [left, right, ok] = extractNumericValues(e.Left, e.Right);
      if (ok) return new js_ast.Expr(new js_ast.ENumber(ToUint32(left) >>> (ToUint32(right) & 31)), loc);
      break;
    }

    case js_ast.OpCode.BinOpBitwiseAnd: {
      const [left, right, ok] = extractNumericValues(e.Left, e.Right);
      if (ok) return new js_ast.Expr(new js_ast.ENumber(ToInt32(left) & ToInt32(right)), loc);
      break;
    }

    case js_ast.OpCode.BinOpBitwiseOr: {
      const [left, right, ok] = extractNumericValues(e.Left, e.Right);
      if (ok) return new js_ast.Expr(new js_ast.ENumber(ToInt32(left) | ToInt32(right)), loc);
      break;
    }

    case js_ast.OpCode.BinOpBitwiseXor: {
      const [left, right, ok] = extractNumericValues(e.Left, e.Right);
      if (ok) return new js_ast.Expr(new js_ast.ENumber(ToInt32(left) ^ ToInt32(right)), loc);
      break;
    }

    case js_ast.OpCode.BinOpLt: {
      const [left, right, ok] = extractNumericValues(e.Left, e.Right);
      if (ok) return new js_ast.Expr(new js_ast.EBoolean(left < right), loc);
      const [sl, sr, sok] = extractStringValues(e.Left, e.Right);
      if (sok) return new js_ast.Expr(new js_ast.EBoolean(stringCompareUCS2(sl, sr) < 0), loc);
      break;
    }

    case js_ast.OpCode.BinOpGt: {
      const [left, right, ok] = extractNumericValues(e.Left, e.Right);
      if (ok) return new js_ast.Expr(new js_ast.EBoolean(left > right), loc);
      const [sl, sr, sok] = extractStringValues(e.Left, e.Right);
      if (sok) return new js_ast.Expr(new js_ast.EBoolean(stringCompareUCS2(sl, sr) > 0), loc);
      break;
    }

    case js_ast.OpCode.BinOpLe: {
      const [left, right, ok] = extractNumericValues(e.Left, e.Right);
      if (ok) return new js_ast.Expr(new js_ast.EBoolean(left <= right), loc);
      const [sl, sr, sok] = extractStringValues(e.Left, e.Right);
      if (sok) return new js_ast.Expr(new js_ast.EBoolean(stringCompareUCS2(sl, sr) <= 0), loc);
      break;
    }

    case js_ast.OpCode.BinOpGe: {
      const [left, right, ok] = extractNumericValues(e.Left, e.Right);
      if (ok) return new js_ast.Expr(new js_ast.EBoolean(left >= right), loc);
      const [sl, sr, sok] = extractStringValues(e.Left, e.Right);
      if (sok) return new js_ast.Expr(new js_ast.EBoolean(stringCompareUCS2(sl, sr) >= 0), loc);
      break;
    }

    case js_ast.OpCode.BinOpLooseEq:
    case js_ast.OpCode.BinOpStrictEq: {
      const [left, right, ok] = extractNumericValues(e.Left, e.Right);
      if (ok) return new js_ast.Expr(new js_ast.EBoolean(left === right), loc);
      const [sl, sr, sok] = extractStringValues(e.Left, e.Right);
      if (sok) return new js_ast.Expr(new js_ast.EBoolean(stringCompareUCS2(sl, sr) === 0), loc);
      break;
    }

    case js_ast.OpCode.BinOpLooseNe:
    case js_ast.OpCode.BinOpStrictNe: {
      const [left, right, ok] = extractNumericValues(e.Left, e.Right);
      if (ok) return new js_ast.Expr(new js_ast.EBoolean(left !== right), loc);
      const [sl, sr, sok] = extractStringValues(e.Left, e.Right);
      if (sok) return new js_ast.Expr(new js_ast.EBoolean(stringCompareUCS2(sl, sr) !== 0), loc);
      break;
    }

    case js_ast.OpCode.BinOpLogicalAnd: {
      const [boolean, sideEffects, ok] = ToBooleanWithSideEffects(e.Left.Data);
      if (ok) {
        if (!boolean) return e.Left;
        if (sideEffects === NoSideEffects) return e.Right;
      }
      break;
    }

    case js_ast.OpCode.BinOpLogicalOr: {
      const [boolean, sideEffects, ok] = ToBooleanWithSideEffects(e.Left.Data);
      if (ok) {
        if (boolean) return e.Left;
        if (sideEffects === NoSideEffects) return e.Right;
      }
      break;
    }

    case js_ast.OpCode.BinOpNullishCoalescing: {
      const [isNullOrUndefined, sideEffects, ok] = ToNullOrUndefinedWithSideEffects(e.Left.Data);
      if (ok) {
        if (!isNullOrUndefined) return e.Left;
        if (sideEffects === NoSideEffects) return e.Right;
      }
      break;
    }
  }

  return new js_ast.Expr();
}

/** Go: func IsBinaryNullAndUndefined(left Expr, right Expr, op OpCode) (Expr, Expr, bool) (js_ast_helpers.go:1379) */
export function IsBinaryNullAndUndefined(
  left: js_ast.Expr,
  right: js_ast.Expr,
  op: js_ast.OpCode,
): [js_ast.Expr, js_ast.Expr, boolean] {
  if (left.Data instanceof js_ast.EBinary && left.Data.Op === op) {
    const a = left.Data;
    if (right.Data instanceof js_ast.EBinary && right.Data.Op === op) {
      const b = right.Data;
      let idA = a.Left, eqA = a.Right;
      let idB = b.Left, eqB = b.Right;

      // Detect when the identifier comes second and flip the order of our checks
      if (eqA.Data instanceof js_ast.EIdentifier) {
        const temp = idA; idA = eqA; eqA = temp;
      }
      if (eqB.Data instanceof js_ast.EIdentifier) {
        const temp = idB; idB = eqB; eqB = temp;
      }

      if (idA.Data instanceof js_ast.EIdentifier) {
        if (idB.Data instanceof js_ast.EIdentifier && refEquals(idA.Data.Ref, idB.Data.Ref)) {
          // "a === null || a === void 0"
          if (eqA.Data instanceof js_ast.ENull) {
            if (eqB.Data instanceof js_ast.EUndefined) {
              return [a.Left, a.Right, true];
            }
          }

          // "a === void 0 || a === null"
          if (eqA.Data instanceof js_ast.EUndefined) {
            if (eqB.Data instanceof js_ast.ENull) {
              return [b.Left, b.Right, true];
            }
          }
        }
      }
    }
  }

  return [new js_ast.Expr(), new js_ast.Expr(), false];
}

/** Go: func CheckEqualityBigInt(a string, b string) (equal bool, ok bool) (js_ast_helpers.go:1416) */
export function CheckEqualityBigInt(a: string, b: string): [boolean, boolean] {
  // Equal literals are always equal
  if (a === b) return [true, true];

  // Unequal literals are unequal if neither has a radix. Leading zeros are
  // disallowed in bigint literals without a radix, so in this case we know
  // each value is in canonical form.
  if ((a.length < 2 || a[0] !== "0") && (b.length < 2 || b[0] !== "0")) {
    return [false, true];
  }

  return [false, false];
}

/** Go: func CheckEqualityIfNoSideEffects(left E, right E, kind EqualityKind) (equal bool, ok bool) (js_ast_helpers.go:1442) */
export function CheckEqualityIfNoSideEffects(
  left: js_ast.E | null,
  right: js_ast.E | null,
  kind: EqualityKind,
): [boolean, boolean] {
  if (right instanceof js_ast.EInlinedEnum) {
    return CheckEqualityIfNoSideEffects(left, right.Value.Data, kind);
  }

  if (left instanceof js_ast.EInlinedEnum) {
    return CheckEqualityIfNoSideEffects(left.Value.Data, right, kind);
  }

  if (left instanceof js_ast.ENull) {
    if (right instanceof js_ast.ENull) return [true, true]; // "null === null" is true
    if (right instanceof js_ast.EUndefined) return [kind === LooseEquality, true]; // "null == undefined" true; "null === undefined" false
    if (IsPrimitiveLiteral(right)) return [false, true]; // "null == (not null or undefined)" is false
    return [false, false];
  }

  if (left instanceof js_ast.EUndefined) {
    if (right instanceof js_ast.EUndefined) return [true, true];
    if (right instanceof js_ast.ENull) return [kind === LooseEquality, true];
    if (IsPrimitiveLiteral(right)) return [false, true];
    return [false, false];
  }

  if (left instanceof js_ast.EBoolean) {
    if (right instanceof js_ast.EBoolean) {
      // "false === false" is true
      return [left.Value === right.Value, true];
    }
    if (right instanceof js_ast.ENumber) {
      if (kind === LooseEquality) {
        if (left.Value) return [right.Value === 1, true]; // "true == 1" is true
        return [right.Value === 0, true]; // "false == 0" is true
      }
      // "true === 1" is false
      return [false, true];
    }
    if (right instanceof js_ast.ENull || right instanceof js_ast.EUndefined) {
      // "(not null or undefined) == undefined" is false
      return [false, true];
    }
    if (kind === StrictEquality && IsPrimitiveLiteral(right)) {
      // "boolean === (not boolean)" is false
      return [false, true];
    }
    return [false, false];
  }

  if (left instanceof js_ast.ENumber) {
    if (right instanceof js_ast.ENumber) {
      // "0 === 0" is true
      return [left.Value === right.Value, true];
    }
    if (right instanceof js_ast.EBoolean) {
      if (kind === LooseEquality) {
        if (right.Value) return [left.Value === 1, true]; // "1 == true" is true
        return [left.Value === 0, true]; // "0 == false" is true
      }
      // "1 === true" is false
      return [false, true];
    }
    if (right instanceof js_ast.ENull || right instanceof js_ast.EUndefined) {
      return [false, true];
    }
    if (kind === StrictEquality && IsPrimitiveLiteral(right)) {
      // "number === (not number)" is false
      return [false, true];
    }
    return [false, false];
  }

  if (left instanceof js_ast.EBigInt) {
    if (right instanceof js_ast.EBigInt) {
      // "0n === 0n" is true
      return CheckEqualityBigInt(left.Value, right.Value);
    }
    if (right instanceof js_ast.ENull || right instanceof js_ast.EUndefined) {
      return [false, true];
    }
    if (kind === StrictEquality && IsPrimitiveLiteral(right)) {
      // "bigint === (not bigint)" is false
      return [false, true];
    }
    return [false, false];
  }

  if (left instanceof js_ast.EString) {
    if (right instanceof js_ast.EString) {
      // "'a' === 'a'" is true
      return [UTF16EqualsUTF16(left.Value, right.Value), true];
    }
    if (right instanceof js_ast.ENull || right instanceof js_ast.EUndefined) {
      return [false, true];
    }
    if (kind === StrictEquality && IsPrimitiveLiteral(right)) {
      // "string === (not string)" is false
      return [false, true];
    }
    return [false, false];
  }

  return [false, false];
}

/** Go: func ValuesLookTheSame(left E, right E) bool (js_ast_helpers.go:1593) */
export function ValuesLookTheSame(left: js_ast.E | null, right: js_ast.E | null): boolean {
  if (right instanceof js_ast.EInlinedEnum) {
    return ValuesLookTheSame(left, right.Value.Data);
  }

  if (left instanceof js_ast.EInlinedEnum) {
    return ValuesLookTheSame(left.Value.Data, right);
  }

  if (left instanceof js_ast.EIdentifier) {
    if (right instanceof js_ast.EIdentifier && refEquals(left.Ref, right.Ref)) return true;
  } else if (left instanceof js_ast.EDot) {
    if (right instanceof js_ast.EDot && left.HasSameFlagsAs(right) &&
      left.Name === right.Name && ValuesLookTheSame(left.Target.Data, right.Target.Data)) {
      return true;
    }
  } else if (left instanceof js_ast.EIndex) {
    if (right instanceof js_ast.EIndex && left.HasSameFlagsAs(right) &&
      ValuesLookTheSame(left.Target.Data, right.Target.Data) &&
      ValuesLookTheSame(left.Index.Data, right.Index.Data)) {
      return true;
    }
  } else if (left instanceof js_ast.EIf) {
    if (right instanceof js_ast.EIf && ValuesLookTheSame(left.Test.Data, right.Test.Data) &&
      ValuesLookTheSame(left.Yes.Data, right.Yes.Data) && ValuesLookTheSame(left.No.Data, right.No.Data)) {
      return true;
    }
  } else if (left instanceof js_ast.EUnary) {
    if (right instanceof js_ast.EUnary && left.Op === right.Op &&
      ValuesLookTheSame(left.Value.Data, right.Value.Data)) {
      return true;
    }
  } else if (left instanceof js_ast.EBinary) {
    if (right instanceof js_ast.EBinary && left.Op === right.Op &&
      ValuesLookTheSame(left.Left.Data, right.Left.Data) &&
      ValuesLookTheSame(left.Right.Data, right.Right.Data)) {
      return true;
    }
  } else if (left instanceof js_ast.ECall) {
    if (right instanceof js_ast.ECall && left.HasSameFlagsAs(right) &&
      left.Args.length === right.Args.length && ValuesLookTheSame(left.Target.Data, right.Target.Data)) {
      for (let i = 0; i < left.Args.length; i++) {
        if (!ValuesLookTheSame(left.Args[i].Data, right.Args[i].Data)) return false;
      }
      return true;
    }
  } else if (left instanceof js_ast.ENumber) {
    // Special-case to distinguish between negative an non-negative zero when mangling
    // "a ? -0 : 0" => "a ? -0 : 0"
    if (right instanceof js_ast.ENumber && left.Value === 0 && right.Value === 0 &&
      Object.is(left.Value, -0) !== Object.is(right.Value, -0)) {
      return false;
    }
  }

  const [equal, ok] = CheckEqualityIfNoSideEffects(left, right, StrictEquality);
  return ok && equal;
}

/** Go: func TryToInsertOptionalChain(test Expr, expr Expr) bool (js_ast_helpers.go:1661) */
export function TryToInsertOptionalChain(test: js_ast.Expr, expr: js_ast.Expr): boolean {
  const e = expr.Data;

  if (e instanceof js_ast.EDot) {
    if (ValuesLookTheSame(test.Data, e.Target.Data)) {
      e.OptionalChain = js_ast.OptionalChain.OptionalChainStart;
      return true;
    }
    if (TryToInsertOptionalChain(test, e.Target)) {
      if (e.OptionalChain === js_ast.OptionalChain.OptionalChainNone) {
        e.OptionalChain = js_ast.OptionalChain.OptionalChainContinue;
      }
      return true;
    }
  } else if (e instanceof js_ast.EIndex) {
    if (ValuesLookTheSame(test.Data, e.Target.Data)) {
      e.OptionalChain = js_ast.OptionalChain.OptionalChainStart;
      return true;
    }
    if (TryToInsertOptionalChain(test, e.Target)) {
      if (e.OptionalChain === js_ast.OptionalChain.OptionalChainNone) {
        e.OptionalChain = js_ast.OptionalChain.OptionalChainContinue;
      }
      return true;
    }
  } else if (e instanceof js_ast.ECall) {
    if (ValuesLookTheSame(test.Data, e.Target.Data)) {
      e.OptionalChain = js_ast.OptionalChain.OptionalChainStart;
      return true;
    }
    if (TryToInsertOptionalChain(test, e.Target)) {
      if (e.OptionalChain === js_ast.OptionalChain.OptionalChainNone) {
        e.OptionalChain = js_ast.OptionalChain.OptionalChainContinue;
      }
      return true;
    }
  }

  return false;
}

/** Go: func joinStrings(a []uint16, b []uint16) []uint16 (js_ast_helpers.go:1703) */
export function joinStrings(a: Uint16Array | number[], b: Uint16Array | number[]): Uint16Array {
  const data = new Uint16Array(a.length + b.length);
  data.set(a, 0);
  data.set(b, a.length);
  return data;
}

/** Go: func TryToStringOnNumberSafely(n float64, radix int) (string, bool) (js_ast_helpers.go:1715) */
export function TryToStringOnNumberSafely(n: number, radix: number): [string, boolean] {
  const i = n | 0;
  if (i === n) return [i.toString(radix), true];
  if (Number.isNaN(n)) return ["NaN", true];
  if (n === Infinity) return ["Infinity", true];
  if (n === -Infinity) return ["-Infinity", true];
  return ["", false];
}

/** Go: func foldAdditionPreProcess(expr Expr) Expr (js_ast_helpers.go:1732) */
function foldAdditionPreProcess(expr: js_ast.Expr): js_ast.Expr {
  const e = expr.Data;

  if (e instanceof js_ast.EInlinedEnum) {
    // "See through" inline enum constants
    expr = e.Value;
  } else if (e instanceof js_ast.EArray) {
    // "[] + x" => "'' + x"
    // "[1,2] + x" => "'1,2' + x"
    const items: string[] = [];
    let allStrings = true;
    for (const item of e.Items) {
      if (item.Data instanceof js_ast.EUndefined || item.Data instanceof js_ast.ENull) {
        items.push("");
        continue;
      }
      const str = ToStringWithoutSideEffects(item.Data);
      let value: js_ast.EString | null = null;
      if (str[1]) {
        // Go 值语义：item.Data 赋值只改局部副本
        value = new js_ast.EString(utf16(str[0]));
      } else if (item.Data instanceof js_ast.EString) {
        value = item.Data;
      }
      if (value === null) {
        allStrings = false;
        break;
      }
      items.push(fromUTF16(value.Value));
    }
    if (allStrings && items.length === e.Items.length) {
      // Go 值语义：expr.Data = ...
      expr = withData(expr, new js_ast.EString(utf16(items.join(","))));
    }
  } else if (e instanceof js_ast.EObject) {
    // "{} + x" => "'[object Object]' + x"
    if (e.Properties.length === 0) {
      expr = withData(expr, new js_ast.EString(utf16("[object Object]")));
    }
  }

  return expr;
}

/** Go: func FoldStringAddition(left Expr, right Expr, kind StringAdditionKind) Expr (js_ast_helpers.go:1779) */
export function FoldStringAddition(
  left: js_ast.Expr,
  right: js_ast.Expr,
  kind: StringAdditionKind,
): js_ast.Expr {
  left = foldAdditionPreProcess(left);
  right = foldAdditionPreProcess(right);

  // Transforming the left operand into a string is not safe if it comes from
  // a nested AST node. The following transforms are invalid:
  //
  //   "0 + 1 + 'x'" => "0 + '1x'"
  //   "0 + 1 + `${x}`" => "0 + `1${x}`"
  if (kind !== StringAdditionWithNestedLeft) {
    if (right.Data instanceof js_ast.EString || right.Data instanceof js_ast.ETemplate) {
      const str = ToStringWithoutSideEffects(left.Data);
      if (str[1]) {
        // Go 值语义
        left = withData(left, new js_ast.EString(utf16(str[0])));
      }
    }
  }

  const l = left.Data;

  if (l instanceof js_ast.EString) {
    // "'x' + 0" => "'x' + '0'"
    {
      const str = ToStringWithoutSideEffects(right.Data);
      if (str[1]) {
        // Go 值语义
        right = withData(right, new js_ast.EString(utf16(str[0])));
      }
    }

    const r = right.Data;
    if (r instanceof js_ast.EString) {
      // "'x' + 'y'" => "'xy'"
      const string = new js_ast.EString(joinStrings(l.Value, r.Value));
      string.PreferTemplate = l.PreferTemplate || r.PreferTemplate;
      return new js_ast.Expr(string, left.Loc);
    }

    if (r instanceof js_ast.ETemplate) {
      if (r.TagOrNil === null || r.TagOrNil.Data === null) {
        // "'x' + `y${z}`" => "`xy${z}`"
        const template = new js_ast.ETemplate();
        template.HeadLoc = left.Loc;
        template.HeadCooked = joinStrings(
          l.Value,
          r.HeadCooked ?? new Uint16Array(0),
        );
        template.Parts = r.Parts;
        return new js_ast.Expr(template, left.Loc);
      }
    }

    // "'' + typeof x" => "typeof x"
    if (l.Value.length === 0 && KnownPrimitiveType(right.Data) === PrimitiveString) {
      return right;
    }
  } else if (l instanceof js_ast.ETemplate) {
    if (l.TagOrNil === null || l.TagOrNil.Data === null) {
      // "`${x}` + 0" => "`${x}` + '0'"
      {
        const str = ToStringWithoutSideEffects(right.Data);
        if (str[1]) {
          // Go 值语义
          right = withData(right, new js_ast.EString(utf16(str[0])));
        }
      }

      const r = right.Data;
      if (r instanceof js_ast.EString) {
        // "`${x}y` + 'z'" => "`${x}yz`"
        const n = l.Parts.length;
        let head = l.HeadCooked ?? new Uint16Array(0);
        // Go 的 copy(parts, l.Parts) 复制结构体值；TS 必须显式克隆元素。
        const parts = l.Parts.map(cloneTemplatePart);
        if (n === 0) {
          head = joinStrings(head, r.Value);
        } else {
          parts[n - 1].TailCooked = joinStrings(parts[n - 1].TailCooked ?? new Uint16Array(0), r.Value);
        }
        const template = new js_ast.ETemplate();
        template.HeadLoc = l.HeadLoc;
        template.HeadCooked = head;
        template.Parts = parts;
        return new js_ast.Expr(template, left.Loc);
      }

      if (r instanceof js_ast.ETemplate) {
        if (r.TagOrNil === null || r.TagOrNil.Data === null) {
          // "`${a}b` + `x${y}`" => "`${a}bx${y}`"
          const n = l.Parts.length;
          let head = l.HeadCooked ?? new Uint16Array(0);
          const parts: js_ast.TemplatePart[] = [];
          for (let i = 0; i < n; i++) parts.push(cloneTemplatePart(l.Parts[i]));
          for (const p of r.Parts) parts.push(cloneTemplatePart(p));
          if (n === 0) {
            head = joinStrings(head, r.HeadCooked ?? new Uint16Array(0));
          } else {
            parts[n - 1].TailCooked = joinStrings(
              parts[n - 1].TailCooked ?? new Uint16Array(0),
              r.HeadCooked ?? new Uint16Array(0),
            );
          }
          const template = new js_ast.ETemplate();
          template.HeadLoc = l.HeadLoc;
          template.HeadCooked = head;
          template.Parts = parts;
          return new js_ast.Expr(template, left.Loc);
        }
      }
    }
  }

  // "typeof x + ''" => "typeof x"
  if (right.Data instanceof js_ast.EString && right.Data.Value.length === 0 &&
    KnownPrimitiveType(left.Data) === PrimitiveString) {
    return left;
  }

  return new js_ast.Expr();
}

/** Go: func InlinePrimitivesIntoTemplate(loc logger.Loc, e *ETemplate) Expr (js_ast_helpers.go:1889) */
export function InlinePrimitivesIntoTemplate(loc: Loc, e: js_ast.ETemplate): js_ast.Expr {
  // Can't inline strings if there's a custom template tag
  if (e.TagOrNil !== null && e.TagOrNil.Data !== null) {
    return new js_ast.Expr(e, loc);
  }

  let headCooked = e.HeadCooked ?? new Uint16Array(0);
  const parts: js_ast.TemplatePart[] = [];

  for (const part of e.Parts) {
    // Go 值语义：part 是 range 副本；TS 克隆后操作。
    const clone = cloneTemplatePart(part);
    if (clone.Value.Data instanceof js_ast.EInlinedEnum) {
      clone.Value = clone.Value.Data.Value;
    }
    const str = ToStringWithoutSideEffects(clone.Value.Data);
    if (str[1]) {
      clone.Value = withData(clone.Value, new js_ast.EString(utf16(str[0])));
    }
    if (clone.Value.Data instanceof js_ast.EString) {
      if (parts.length === 0) {
        headCooked = joinStrings(joinStrings(headCooked, clone.Value.Data.Value), clone.TailCooked ?? new Uint16Array(0));
      } else {
        const prevPart = parts[parts.length - 1];
        prevPart.TailCooked = joinStrings(
          joinStrings(prevPart.TailCooked ?? new Uint16Array(0), clone.Value.Data.Value),
          clone.TailCooked ?? new Uint16Array(0),
        );
      }
    } else {
      parts.push(clone);
    }
  }

  // Become a plain string if there are no substitutions
  if (parts.length === 0) {
    const string = new js_ast.EString(headCooked);
    string.PreferTemplate = true;
    return new js_ast.Expr(string, loc);
  }

  const template = new js_ast.ETemplate();
  template.HeadLoc = e.HeadLoc;
  template.HeadCooked = headCooked;
  template.Parts = parts;
  return new js_ast.Expr(template, loc);
}

/** Go: func ToNullOrUndefinedWithSideEffects(data E) (bool, SideEffects, bool) (js_ast_helpers.go:1939) */
export function ToNullOrUndefinedWithSideEffects(
  data: js_ast.E | null,
): [boolean, SideEffects, boolean] {
  if (data instanceof js_ast.EAnnotation) {
    const [isNullOrUndefined, sideEffects, ok] = ToNullOrUndefinedWithSideEffects(data.Value.Data);
    if (js_ast.Has(data.Flags, js_ast.AnnotationFlags.CanBeRemovedIfUnusedFlag)) {
      return [isNullOrUndefined, NoSideEffects, ok];
    }
    return [isNullOrUndefined, sideEffects, ok];
  }

  if (data instanceof js_ast.EInlinedEnum) return ToNullOrUndefinedWithSideEffects(data.Value.Data);

  // Never null or undefined
  if (data instanceof js_ast.EBoolean || data instanceof js_ast.ENumber ||
    data instanceof js_ast.EString || data instanceof js_ast.ERegExp ||
    data instanceof js_ast.EFunction || data instanceof js_ast.EArrow ||
    data instanceof js_ast.EBigInt) {
    return [false, NoSideEffects, true];
  }

  // Never null or undefined
  if (data instanceof js_ast.EObject || data instanceof js_ast.EArray || data instanceof js_ast.EClass) {
    return [false, CouldHaveSideEffects, true];
  }

  // Always null or undefined
  if (data instanceof js_ast.ENull || data instanceof js_ast.EUndefined) {
    return [true, NoSideEffects, true];
  }

  if (data instanceof js_ast.EUnary) {
    switch (data.Op) {
      // Always number or bigint
      case js_ast.OpCode.UnOpPos:
      case js_ast.OpCode.UnOpNeg:
      case js_ast.OpCode.UnOpCpl:
      case js_ast.OpCode.UnOpPreDec:
      case js_ast.OpCode.UnOpPreInc:
      case js_ast.OpCode.UnOpPostDec:
      case js_ast.OpCode.UnOpPostInc:
      // Always boolean
      case js_ast.OpCode.UnOpNot:
      case js_ast.OpCode.UnOpDelete:
        return [false, CouldHaveSideEffects, true];

      // Always boolean
      case js_ast.OpCode.UnOpTypeof:
        if (data.WasOriginallyTypeofIdentifier) {
          // Expressions such as "typeof x" never have any side effects
          return [false, NoSideEffects, true];
        }
        return [false, CouldHaveSideEffects, true];

      // Always undefined
      case js_ast.OpCode.UnOpVoid:
        return [true, CouldHaveSideEffects, true];
    }
  }

  if (data instanceof js_ast.EBinary) {
    switch (data.Op) {
      // Always string or number or bigint
      case js_ast.OpCode.BinOpAdd:
      case js_ast.OpCode.BinOpAddAssign:
      // Always number or bigint
      case js_ast.OpCode.BinOpSub:
      case js_ast.OpCode.BinOpMul:
      case js_ast.OpCode.BinOpDiv:
      case js_ast.OpCode.BinOpRem:
      case js_ast.OpCode.BinOpPow:
      case js_ast.OpCode.BinOpSubAssign:
      case js_ast.OpCode.BinOpMulAssign:
      case js_ast.OpCode.BinOpDivAssign:
      case js_ast.OpCode.BinOpRemAssign:
      case js_ast.OpCode.BinOpPowAssign:
      case js_ast.OpCode.BinOpShl:
      case js_ast.OpCode.BinOpShr:
      case js_ast.OpCode.BinOpUShr:
      case js_ast.OpCode.BinOpShlAssign:
      case js_ast.OpCode.BinOpShrAssign:
      case js_ast.OpCode.BinOpUShrAssign:
      case js_ast.OpCode.BinOpBitwiseOr:
      case js_ast.OpCode.BinOpBitwiseAnd:
      case js_ast.OpCode.BinOpBitwiseXor:
      case js_ast.OpCode.BinOpBitwiseOrAssign:
      case js_ast.OpCode.BinOpBitwiseAndAssign:
      case js_ast.OpCode.BinOpBitwiseXorAssign:
      // Always boolean
      case js_ast.OpCode.BinOpLt:
      case js_ast.OpCode.BinOpLe:
      case js_ast.OpCode.BinOpGt:
      case js_ast.OpCode.BinOpGe:
      case js_ast.OpCode.BinOpIn:
      case js_ast.OpCode.BinOpInstanceof:
      case js_ast.OpCode.BinOpLooseEq:
      case js_ast.OpCode.BinOpLooseNe:
      case js_ast.OpCode.BinOpStrictEq:
      case js_ast.OpCode.BinOpStrictNe:
        return [false, CouldHaveSideEffects, true];

      case js_ast.OpCode.BinOpComma: {
        const [isNullOrUndefined, , ok] = ToNullOrUndefinedWithSideEffects(data.Right.Data);
        if (ok) return [isNullOrUndefined, CouldHaveSideEffects, true];
        break;
      }
    }
  }

  return [false, NoSideEffects, false];
}

/** Go: func ToBooleanWithSideEffects(data E) (bool, SideEffects, bool) (js_ast_helpers.go:2014) */
export function ToBooleanWithSideEffects(
  data: js_ast.E | null,
): [boolean, SideEffects, boolean] {
  if (data instanceof js_ast.EAnnotation) {
    const [boolean, sideEffects, ok] = ToBooleanWithSideEffects(data.Value.Data);
    if (js_ast.Has(data.Flags, js_ast.AnnotationFlags.CanBeRemovedIfUnusedFlag)) {
      return [boolean, NoSideEffects, ok];
    }
    return [boolean, sideEffects, ok];
  }

  if (data instanceof js_ast.EInlinedEnum) return ToBooleanWithSideEffects(data.Value.Data);

  if (data instanceof js_ast.ENull || data instanceof js_ast.EUndefined) return [false, NoSideEffects, true];
  if (data instanceof js_ast.EBoolean) return [data.Value, NoSideEffects, true];
  if (data instanceof js_ast.ENumber) return [data.Value !== 0 && !Number.isNaN(data.Value), NoSideEffects, true];

  if (data instanceof js_ast.EBigInt) {
    const [equal, ok] = CheckEqualityBigInt(data.Value, "0");
    return [!equal, NoSideEffects, ok];
  }

  if (data instanceof js_ast.EString) return [data.Value.length > 0, NoSideEffects, true];
  if (data instanceof js_ast.EFunction || data instanceof js_ast.EArrow || data instanceof js_ast.ERegExp) {
    return [true, NoSideEffects, true];
  }
  if (data instanceof js_ast.EObject || data instanceof js_ast.EArray || data instanceof js_ast.EClass) {
    return [true, CouldHaveSideEffects, true];
  }

  if (data instanceof js_ast.EUnary) {
    switch (data.Op) {
      case js_ast.OpCode.UnOpVoid:
        return [false, CouldHaveSideEffects, true];

      case js_ast.OpCode.UnOpTypeof:
        // Never an empty string
        if (data.WasOriginallyTypeofIdentifier) {
          // Expressions such as "typeof x" never have any side effects
          return [true, NoSideEffects, true];
        }
        return [true, CouldHaveSideEffects, true];

      case js_ast.OpCode.UnOpNot: {
        const [boolean, sideEffects, ok] = ToBooleanWithSideEffects(data.Value.Data);
        if (ok) return [!boolean, sideEffects, true];
        break;
      }
    }
  }

  if (data instanceof js_ast.EBinary) {
    switch (data.Op) {
      case js_ast.OpCode.BinOpLogicalOr: {
        // "anything || truthy" is truthy
        const [boolean, , ok] = ToBooleanWithSideEffects(data.Right.Data);
        if (ok && boolean) return [true, CouldHaveSideEffects, true];
        break;
      }

      case js_ast.OpCode.BinOpLogicalAnd: {
        // "anything && falsy" is falsy
        const [boolean, , ok] = ToBooleanWithSideEffects(data.Right.Data);
        if (ok && !boolean) return [false, CouldHaveSideEffects, true];
        break;
      }

      case js_ast.OpCode.BinOpComma: {
        // "anything, truthy/falsy" is truthy/falsy
        const [boolean, , ok] = ToBooleanWithSideEffects(data.Right.Data);
        if (ok) return [boolean, CouldHaveSideEffects, true];
        break;
      }
    }
  }

  return [false, CouldHaveSideEffects, false];
}

/** Go: func StringToEquivalentNumberValue(value []uint16) (float64, bool) (js_ast_helpers.go:2684) */
export function StringToEquivalentNumberValue(value: Uint16Array | number[]): [number, boolean] {
  if (value.length > 0) {
    let intValue = 0;
    let isNegative = false;
    let start = 0;

    if (value[0] === 0x2d /* '-' */ && value.length > 1) {
      isNegative = true;
      start++;
    }

    for (let i = start; i < value.length; i++) {
      const c = value[i];
      if (c < 0x30 /* '0' */ || c > 0x39 /* '9' */) return [0, false];
      intValue = (intValue * 10 + (c - 0x30)) | 0;
    }

    if (isNegative) intValue = (-intValue) | 0;

    if (UTF16EqualsString(value, utf8(intValue.toString(10)))) {
      return [intValue, true];
    }
  }

  return [0, false];
}

/** Go: func InlineSpreadsOfArrayLiterals(values []Expr) (results []Expr) (js_ast_helpers.go:2716) */
export function InlineSpreadsOfArrayLiterals(values: js_ast.Expr[]): js_ast.Expr[] {
  const results: js_ast.Expr[] = [];
  for (const value of values) {
    if (value.Data instanceof js_ast.ESpread) {
      if (value.Data.Value.Data instanceof js_ast.EArray) {
        for (const item of value.Data.Value.Data.Items) {
          if (item.Data instanceof js_ast.EMissing) {
            results.push(new js_ast.Expr(js_ast.EUndefinedShared, item.Loc));
          } else {
            results.push(item);
          }
        }
        continue;
      }
    }
    results.push(value);
  }
  return results;
}

/** Go: func MangleObjectSpread(properties []Property) []Property (js_ast_helpers.go:2737) */
export function MangleObjectSpread(properties: js_ast.Property[]): js_ast.Property[] {
  const result: js_ast.Property[] = [];
  for (const property of properties) {
    if (property.Kind === js_ast.PropertyKind.PropertySpread) {
      const v = property.ValueOrNil?.Data ?? null;
      if (v instanceof js_ast.EBoolean || v instanceof js_ast.ENull || v instanceof js_ast.EUndefined ||
        v instanceof js_ast.ENumber || v instanceof js_ast.EBigInt || v instanceof js_ast.ERegExp ||
        v instanceof js_ast.EFunction || v instanceof js_ast.EArrow) {
        // This value is ignored because it doesn't have any of its own properties
        continue;
      }

      if (v instanceof js_ast.EObject) {
        let done = false;
        for (let i = 0; i < v.Properties.length; i++) {
          const p = v.Properties[i];

          // Getters are evaluated at iteration time. The property
          // descriptor is not inlined into the caller. Since we are not
          // evaluating code at compile time, just bail if we hit one
          // and preserve the spread with the remaining properties.
          // Also bail if we hit a verbatim "__proto__" key.
          let bail = p.Kind === js_ast.PropertyKind.PropertyGetter ||
            p.Kind === js_ast.PropertyKind.PropertySetter;
          if (!bail && p.Kind === js_ast.PropertyKind.PropertyField &&
            !js_ast.Has(p.Flags, js_ast.PropertyFlags.PropertyIsComputed)) {
            if (p.Key.Data instanceof js_ast.EString &&
              UTF16EqualsString(p.Key.Data.Value, utf8("__proto__"))) {
              bail = true;
            }
          }
          if (bail) {
            // Don't mutate the original AST
            const clone = Object.assign(new js_ast.EObject(), v);
            clone.Properties = v.Properties.slice(i);
            // Go 值语义：property 是 range 副本
            result.push(Object.assign(cloneProperty(property), { ValueOrNil: withData(property.ValueOrNil!, clone) }));
            done = true;
            break;
          }

          result.push(p);
        }
        if (done) continue;
        continue;
      }
    }
    result.push(property);
  }
  return result;
}

/** Go: func ForEachIdentifierBindingInDecls(decls []Decl, callback func(logger.Loc, *BIdentifier)) (js_ast_helpers.go:2990) */
export function ForEachIdentifierBindingInDecls(
  decls: js_ast.Decl[],
  callback: (loc: Loc, b: js_ast.BIdentifier) => void,
): void {
  for (const decl of decls) ForEachIdentifierBinding(decl.Binding, callback);
}

/** Go: func ForEachIdentifierBinding(binding Binding, callback func(logger.Loc, *BIdentifier)) (js_ast_helpers.go:2996) */
export function ForEachIdentifierBinding(
  binding: js_ast.Binding,
  callback: (loc: Loc, b: js_ast.BIdentifier) => void,
): void {
  const b = binding.Data;
  if (b instanceof js_ast.BMissing) {
    // 空
  } else if (b instanceof js_ast.BIdentifier) {
    callback(binding.Loc, b);
  } else if (b instanceof js_ast.BArray) {
    for (const item of b.Items) ForEachIdentifierBinding(item.Binding, callback);
  } else if (b instanceof js_ast.BObject) {
    for (const property of b.Properties) ForEachIdentifierBinding(property.Value, callback);
  }
}
