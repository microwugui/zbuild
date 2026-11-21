// 1:1 移植自 esbuild internal/js_parser/ts_parser.go（v0.28.2，commit f6058f83）
//
// 第 27 轮只落 **独立判据**（不依赖 TypeScript 类型跳过器的谓词）：它们被 tmpgenpred 逐 token
// 与 Go 实测比对（`testdata/js_parser/ts-predicates.json`）。
// 第 35 轮 K-2：补落 type-skipper 全族，通道② Go 字节证据钉在
// `testdata/js_parser/k2-typeskip-go.json`（38 条 TS 类型片段，skipTypeScriptType 消费的字节偏移）。
//
// DEVIATION（receiver）：Go 是 `*parser` 的方法，TS 改为「首参 p: parser」的自由函数，
// 与 `js_parser_lower_class.ts` 同一约定（`tools/progress.ts` 按 Go 文件映射计数）。
//
// 注意：`case A, B, C:` 在 `node --experimental-strip-types` 下只匹配最后一个标签
// （第 27 轮最小复现），所以这里全部写成 if 链。

import { newParser, type parser, fnOrArrowDataParse, parseStmtOpts } from "./js_parser.ts";
import { init } from "../helpers/init.ts";
import * as ast from "../ast/ast.ts";
import { InvalidRef, LocRef, SymbolKind } from "../ast/ast.ts";
import { T } from "../js_lexer/tables.ts";
import { AddError } from "../logger/logger.ts";
import { Range as LogRange, Loc as LogLoc } from "../logger/logger.ts";
import { LexerPanic } from "../js_lexer/js_lexer.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import * as js_ast_helpers from "../js_ast/js_ast_helpers.ts";
import { StringToUTF16, UTF16ToString } from "../helpers/utf.ts";
import { IsIdentifierUTF16 } from "../js_ast/js_ident.ts";
import { Has, JSFeature } from "../compat/compat.ts";

/** Go: helpers.UTF16ToString + string —— TS 的 UTF16ToString 返回 UTF-8 字节，需再解码。 */
function utf16ToJS(u: Uint16Array | number[]): string {
  return new TextDecoder().decode(UTF16ToString(u));
}

/**
 * Go: func wrapInlinedEnum(value js_ast.Expr, comment string) js_ast.Expr (ts_parser.go:2075)
 * 1:1（第 42 轮 sweep）：comment 含注释结束符则不包注释，否则包 EInlinedEnum。
 * Go 探针实测：wrapInlinedEnum(值 1, 注释 A) 打印为「空格 1 空格 块注释 A」。
 */
export function wrapInlinedEnum(value: js_ast.Expr, comment: string): js_ast.Expr {
  if (comment.includes("*/")) return value;
  const e = new js_ast.EInlinedEnum();
  e.Value = value;
  e.Comment = comment;
  return new js_ast.Expr(e, value.Loc);
}

/** Go: type awaitOrYield uint8 (js_parser.go:632) */
const allowIdent = 0;

/** Go: type skipTypeFlags uint8 (ts_parser.go:176) */
export const isReturnTypeFlag = 1 << 0;
export const isIndexSignatureFlag = 1 << 1;
export const allowTupleLabelsFlag = 1 << 2;
export const disallowConditionalTypesFlag = 1 << 3;

/** Go: func (flags skipTypeFlags) has(flag skipTypeFlags) bool (ts_parser.go:177) */
export function has(flags: number, flag: number): boolean {
  return (flags & flag) !== 0;
}

function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Go: func (p *parser) tsLookAheadNextTokenIsOpenParenOrLessThanOrDot() (result bool) (ts_parser.go:1236) */
export function tsLookAheadNextTokenIsOpenParenOrLessThanOrDot(p: parser): boolean {
  const oldLexer = p.lexer;
  p.lexer = p.lexer.clone();
  p.lexer.Next();
  const result = p.lexer.Token === T.TOpenParen || p.lexer.Token === T.TLessThan || p.lexer.Token === T.TDot;
  p.lexer = oldLexer;
  return result;
}

/** Go: func (p *parser) tsIsIdentifier() bool (ts_parser.go:1251) */
export function tsIsIdentifier(p: parser): boolean {
  if (p.lexer.Token === T.TIdentifier) {
    // If we have a 'yield'/'await' keyword, and we're in the [yield]/[await] context,
    // then it is considered a keyword and is not an identifier.
    const name = bytesToString(p.lexer.Identifier.String);
    if (p.fnOrArrowDataParse.yield !== allowIdent && name === "yield") return false;
    if (p.fnOrArrowDataParse.await !== allowIdent && name === "await") return false;
    return true;
  }
  return false;
}

/** Go: func (p *parser) tsIsBinaryOperator() bool (ts_parser.go:1116) */
export function tsIsBinaryOperator(p: parser): boolean {
  const token = p.lexer.Token as number;
  if (token === T.TIn) return p.allowIn;

  if (
    token === T.TQuestionQuestion || token === T.TBarBar || token === T.TAmpersandAmpersand ||
    token === T.TBar || token === T.TCaret || token === T.TAmpersand ||
    token === T.TEqualsEquals || token === T.TExclamationEquals ||
    token === T.TEqualsEqualsEquals || token === T.TExclamationEqualsEquals ||
    token === T.TLessThan || token === T.TGreaterThan ||
    token === T.TLessThanEquals || token === T.TGreaterThanEquals || token === T.TInstanceof ||
    token === T.TLessThanLessThan || token === T.TGreaterThanGreaterThan ||
    token === T.TGreaterThanGreaterThanGreaterThan ||
    token === T.TPlus || token === T.TMinus || token === T.TAsterisk ||
    token === T.TSlash || token === T.TPercent || token === T.TAsteriskAsterisk
  ) {
    return true;
  }

  if (token === T.TIdentifier) {
    if (p.lexer.IsContextualKeyword("as") || p.lexer.IsContextualKeyword("satisfies")) return true;
  }
  return false;
}

/** Go: func (p *parser) tsIsStartOfExpression() bool (ts_parser.go:1159) */
export function tsIsStartOfExpression(p: parser): boolean {
  if (tsIsStartOfLeftHandSideExpression(p)) return true;

  const token = p.lexer.Token as number;
  if (
    token === T.TPlus || token === T.TMinus || token === T.TTilde || token === T.TExclamation ||
    token === T.TDelete || token === T.TTypeof || token === T.TVoid ||
    token === T.TPlusPlus || token === T.TMinusMinus || token === T.TLessThan ||
    token === T.TPrivateIdentifier || token === T.TAt
  ) {
    return true;
  }

  if (token === T.TIdentifier) {
    const name = bytesToString(p.lexer.Identifier.String);
    if (name === "await" || name === "yield") return true;
  }

  // Error tolerance: the start of a binary operator is treated as the start of an expression.
  if (tsIsBinaryOperator(p)) return true;
  return tsIsIdentifier(p);
}

/** Go: func (p *parser) tsIsStartOfLeftHandSideExpression() bool (ts_parser.go:1202) */
export function tsIsStartOfLeftHandSideExpression(p: parser): boolean {
  const token = p.lexer.Token as number;
  if (
    token === T.TThis || token === T.TSuper || token === T.TNull || token === T.TTrue ||
    token === T.TFalse || token === T.TNumericLiteral || token === T.TBigIntegerLiteral ||
    token === T.TStringLiteral || token === T.TNoSubstitutionTemplateLiteral || token === T.TTemplateHead ||
    token === T.TOpenParen || token === T.TOpenBracket || token === T.TOpenBrace ||
    token === T.TFunction || token === T.TClass || token === T.TNew ||
    token === T.TSlash || token === T.TSlashEquals || token === T.TIdentifier
  ) {
    return true;
  }

  if (token === T.TImport) return tsLookAheadNextTokenIsOpenParenOrLessThanOrDot(p);
  return tsIsIdentifier(p);
}

/** Go: func (p *parser) tsCanFollowTypeArgumentsInExpression() bool (ts_parser.go:1082) */
export function tsCanFollowTypeArgumentsInExpression(p: parser): boolean {
  const token = p.lexer.Token as number;
  if (token === T.TOpenParen || token === T.TNoSubstitutionTemplateLiteral || token === T.TTemplateHead) {
    return true;
  }
  if (
    token === T.TLessThan || token === T.TGreaterThan || token === T.TPlus || token === T.TMinus ||
    token === T.TGreaterThanEquals || token === T.TGreaterThanGreaterThan ||
    token === T.TGreaterThanGreaterThanEquals ||
    token === T.TGreaterThanGreaterThanGreaterThan ||
    token === T.TGreaterThanGreaterThanGreaterThanEquals
  ) {
    return false;
  }

  // We favor the type argument list interpretation when it is immediately followed by
  // a line break, a binary operator, or something that can't start an expression.
  return p.lexer.HasNewlineBefore || tsIsBinaryOperator(p) || !tsIsStartOfExpression(p);
}

/** Go: func (p *parser) isTSArrowFnJSX() (isTSArrowFn bool) (ts_parser.go:1052) */
export function isTSArrowFnJSX(p: parser): boolean {
  const oldLexer = p.lexer;
  p.lexer = p.lexer.clone();
  let isTSArrowFn = false;
  p.lexer.Next();

  // Look ahead to see if this should be an arrow function instead
  if ((p.lexer.Token as number) === T.TConst) p.lexer.Next();
  if ((p.lexer.Token as number) === T.TIdentifier) {
    p.lexer.Next();
    const token = p.lexer.Token as number;
    if (token === T.TComma || token === T.TEquals) {
      isTSArrowFn = true;
    } else if (token === T.TExtends) {
      p.lexer.Next();
      const after = p.lexer.Token as number;
      isTSArrowFn = after !== T.TEquals && after !== T.TGreaterThan && after !== T.TSlash;
    }
  }

  p.lexer = oldLexer;
  return isTSArrowFn;
}

// ===========================================================================
// 第 35 轮 K-2：TypeScript type-skipper 全族（ts_parser.go:216-1048）
// 通道② Go 字节证据：testdata/js_parser/k2-typeskip-go.json（38 条 TS 类型片段）
// DEVIATION：Go 是 receiver 方法，TS 用首参 p: parser（同 K-1 约定）
// ===========================================================================

/** Go: type skipTypeFlags uint8 (ts_parser.go:168) —— 已在文件顶部以常量定义 */
/** Go: type typeParameterFlags uint8 (ts_parser.go:657) */
const allowInOutVarianceAnnotations = 1 << 0;
const allowConstModifier = 1 << 1;
const allowEmptyTypeParameters = 1 << 2;

/** Go: type skipTypeScriptTypeParametersResult uint8 (ts_parser.go:664) */
export const skipTypeParamsResult = {
  didNotSkipAnything: 0,
  couldBeTypeCast: 1,
  definitelyTypeParameters: 2,
} as const;

/** Go: type tsTypeIdentifierKind uint8 (ts_parser.go:180) */
const tsTypeIdentifierNormal = 0;
const tsTypeIdentifierUnique = 1;
const tsTypeIdentifierAbstract = 2;
const tsTypeIdentifierAsserts = 3;
const tsTypeIdentifierPrefix = 4;
const tsTypeIdentifierPrimitive = 5;
const tsTypeIdentifierInfer = 6;

/** Go: var tsTypeIdentifierMap (ts_parser.go:189) */
const tsTypeIdentifierMap: Record<string, number> = {
  unique: tsTypeIdentifierUnique,
  abstract: tsTypeIdentifierAbstract,
  asserts: tsTypeIdentifierAsserts,
  keyof: tsTypeIdentifierPrefix,
  readonly: tsTypeIdentifierPrefix,
  any: tsTypeIdentifierPrimitive,
  never: tsTypeIdentifierPrimitive,
  unknown: tsTypeIdentifierPrimitive,
  undefined: tsTypeIdentifierPrimitive,
  object: tsTypeIdentifierPrimitive,
  number: tsTypeIdentifierPrimitive,
  string: tsTypeIdentifierPrimitive,
  boolean: tsTypeIdentifierPrimitive,
  bigint: tsTypeIdentifierPrimitive,
  symbol: tsTypeIdentifierPrimitive,
  infer: tsTypeIdentifierInfer,
};

/** Go: type skipTypeScriptTypeArgumentsOpts struct (ts_parser.go:794) */
export class skipTypeScriptTypeArgumentsOpts {
  isInsideJSXElement: boolean = false;
  isParseTypeArgumentsInExpression: boolean = false;
}

/** Go: func (p *parser) skipTypeScriptType(level js_ast.L) (ts_parser.go:164) */
export function skipTypeScriptType(p: parser, level: number): void {
  skipTypeScriptTypeWithFlags(p, level, 0);
}

/** Go: func (p *parser) skipTypeScriptReturnType() (ts_parser.go:160) */
export function skipTypeScriptReturnType(p: parser): void {
  skipTypeScriptTypeWithFlags(p, js_ast.L.LLowest, isReturnTypeFlag);
}

/** Go: func (p *parser) skipTypeScriptTypeWithFlags(level, flags) (ts_parser.go:216) */
export function skipTypeScriptTypeWithFlags(p: parser, level: number, flags: number): void {
  const L = js_ast.L;
  // Go 用 labeled loop + break loop；TS 用外层 while(true) + break label
  outer:
  while (true) {
    const t = p.lexer.Token as number;
    if (
      t === T.TNumericLiteral || t === T.TBigIntegerLiteral || t === T.TStringLiteral ||
      t === T.TNoSubstitutionTemplateLiteral || t === T.TTrue || t === T.TFalse ||
      t === T.TNull || t === T.TVoid
    ) {
      p.lexer.Next();
    } else if (t === T.TConst) {
      const r = p.lexer.Range();
      p.lexer.Next();
      if (has(flags, allowTupleLabelsFlag) && (p.lexer.Token as number) === T.TColon) {
        AddError(p.log, p.tracker, r, 'Unexpected "const"');
      }
    } else if (t === T.TThis) {
      p.lexer.Next();
      if (p.lexer.IsContextualKeyword("is") && !p.lexer.HasNewlineBefore) {
        p.lexer.Next();
        skipTypeScriptType(p, L.LLowest);
        return;
      }
    } else if (t === T.TMinus) {
      p.lexer.Next();
      if ((p.lexer.Token as number) === T.TBigIntegerLiteral) p.lexer.Next();
      else p.lexer.Expect(T.TNumericLiteral);
    } else if (t === T.TAmpersand || t === T.TBar) {
      // "type Foo = | A | B" / "& A & B"
      p.lexer.Next();
      continue;
    } else if (t === T.TImport) {
      p.lexer.Next();
      if (has(flags, allowTupleLabelsFlag) && ((p.lexer.Token as number) === T.TColon || (p.lexer.Token as number) === T.TQuestion)) return;
      p.lexer.Expect(T.TOpenParen);
      p.lexer.Expect(T.TStringLiteral);
      if ((p.lexer.Token as number) === T.TComma) {
        p.lexer.Next();
        skipTypeScriptObjectType(p);
        if ((p.lexer.Token as number) === T.TComma) p.lexer.Next();
      }
      p.lexer.Expect(T.TCloseParen);
    } else if (t === T.TNew) {
      p.lexer.Next();
      if (has(flags, allowTupleLabelsFlag) && ((p.lexer.Token as number) === T.TColon || (p.lexer.Token as number) === T.TQuestion)) return;
      skipTypeScriptTypeParameters(p, allowConstModifier);
      skipTypeScriptParenOrFnType(p);
    } else if (t === T.TLessThan) {
      skipTypeScriptTypeParameters(p, allowConstModifier);
      skipTypeScriptParenOrFnType(p);
    } else if (t === T.TOpenParen) {
      skipTypeScriptParenOrFnType(p);
    } else if (t === T.TIdentifier) {
      const kind = tsTypeIdentifierMap[bytesToString(p.lexer.Identifier.String)] ?? tsTypeIdentifierNormal;
      let checkTypeParameters = true;
      if (kind === tsTypeIdentifierPrefix) {
        p.lexer.Next();
        if (
          (p.lexer.Token !== T.TColon && p.lexer.Token !== T.TQuestion && p.lexer.Token !== T.TIn) ||
          (!has(flags, isIndexSignatureFlag) && !has(flags, allowTupleLabelsFlag))
        ) {
          skipTypeScriptType(p, L.LPrefix);
        }
        break outer;
      } else if (kind === tsTypeIdentifierInfer) {
        p.lexer.Next();
        if (
          (p.lexer.Token !== T.TColon && p.lexer.Token !== T.TQuestion && p.lexer.Token !== T.TIn) ||
          (!has(flags, isIndexSignatureFlag) && !has(flags, allowTupleLabelsFlag))
        ) {
          p.lexer.Expect(T.TIdentifier);
          if ((p.lexer.Token as number) === T.TExtends) {
            trySkipTypeScriptConstraintOfInferTypeWithBacktracking(p, flags);
          }
        }
        break outer;
      } else if (kind === tsTypeIdentifierUnique) {
        p.lexer.Next();
        if (p.lexer.IsContextualKeyword("symbol")) {
          p.lexer.Next();
          break outer;
        }
      } else if (kind === tsTypeIdentifierAbstract) {
        p.lexer.Next();
        if ((p.lexer.Token as number) === T.TNew) continue;
      } else if (kind === tsTypeIdentifierAsserts) {
        p.lexer.Next();
        if (has(flags, isReturnTypeFlag) && !p.lexer.HasNewlineBefore && ((p.lexer.Token as number) === T.TIdentifier || (p.lexer.Token as number) === T.TThis)) {
          p.lexer.Next();
        }
      } else if (kind === tsTypeIdentifierPrimitive) {
        p.lexer.Next();
        checkTypeParameters = false;
      } else {
        p.lexer.Next();
      }

      if (p.lexer.IsContextualKeyword("is") && !p.lexer.HasNewlineBefore) {
        p.lexer.Next();
        skipTypeScriptType(p, L.LLowest);
        return;
      }
      if (checkTypeParameters && !p.lexer.HasNewlineBefore) {
        skipTypeScriptTypeArguments(p, new skipTypeScriptTypeArgumentsOpts());
      }
    } else if (t === T.TTypeof) {
      p.lexer.Next();
      if (has(flags, allowTupleLabelsFlag) && ((p.lexer.Token as number) === T.TColon || (p.lexer.Token as number) === T.TQuestion)) return;
      if ((p.lexer.Token as number) === T.TImport) {
        continue;
      } else {
        if (!p.lexer.IsIdentifierOrKeyword()) p.lexer.Expect(T.TIdentifier);
        p.lexer.Next();
        while ((p.lexer.Token as number) === T.TDot) {
          p.lexer.Next();
          if (!p.lexer.IsIdentifierOrKeyword() && (p.lexer.Token as number) !== T.TPrivateIdentifier) {
            p.lexer.Expect(T.TIdentifier);
          }
          p.lexer.Next();
        }
        if (!p.lexer.HasNewlineBefore) skipTypeScriptTypeArguments(p, new skipTypeScriptTypeArgumentsOpts());
      }
    } else if (t === T.TOpenBracket) {
      p.lexer.Next();
      while ((p.lexer.Token as number) !== T.TCloseBracket) {
        if ((p.lexer.Token as number) === T.TDotDotDot) p.lexer.Next();
        skipTypeScriptTypeWithFlags(p, L.LLowest, allowTupleLabelsFlag);
        if ((p.lexer.Token as number) === T.TQuestion) p.lexer.Next();
        if ((p.lexer.Token as number) === T.TColon) {
          p.lexer.Next();
          skipTypeScriptType(p, L.LLowest);
        }
        if ((p.lexer.Token as number) !== T.TComma) break;
        p.lexer.Next();
      }
      p.lexer.Expect(T.TCloseBracket);
    } else if (t === T.TOpenBrace) {
      skipTypeScriptObjectType(p);
    } else if (t === T.TTemplateHead) {
      while (true) {
        p.lexer.Next();
        skipTypeScriptType(p, L.LLowest);
        p.lexer.RescanCloseBraceAsTemplateToken();
        if ((p.lexer.Token as number) === T.TTemplateTail) {
          p.lexer.Next();
          break;
        }
      }
    } else {
      if (has(flags, allowTupleLabelsFlag) && p.lexer.IsIdentifierOrKeyword()) {
        if ((p.lexer.Token as number) !== T.TFunction) {
          AddError(p.log, p.tracker, p.lexer.Range(), `Unexpected ${JSON.stringify(bytesToString(p.lexer.Raw()))}`);
        }
        p.lexer.Next();
        if ((p.lexer.Token as number) !== T.TColon && (p.lexer.Token as number) !== T.TQuestion) {
          p.lexer.Expect(T.TColon);
        }
        return;
      }
      p.lexer.Unexpected();
    }
    break;
  }

  while (true) {
    const t = p.lexer.Token as number;
    if (t === T.TBar) {
      if (level >= js_ast.L.LBitwiseOr) return;
      p.lexer.Next();
      skipTypeScriptTypeWithFlags(p, js_ast.L.LBitwiseOr, flags);
    } else if (t === T.TAmpersand) {
      if (level >= js_ast.L.LBitwiseAnd) return;
      p.lexer.Next();
      skipTypeScriptTypeWithFlags(p, js_ast.L.LBitwiseAnd, flags);
    } else if (t === T.TExclamation) {
      if (p.lexer.HasNewlineBefore) return;
      p.lexer.Next();
    } else if (t === T.TDot) {
      p.lexer.Next();
      if (!p.lexer.IsIdentifierOrKeyword()) p.lexer.Expect(T.TIdentifier);
      p.lexer.Next();
      if (!p.lexer.HasNewlineBefore) skipTypeScriptTypeArguments(p, new skipTypeScriptTypeArgumentsOpts());
    } else if (t === T.TOpenBracket) {
      if (p.lexer.HasNewlineBefore) return;
      p.lexer.Next();
      if ((p.lexer.Token as number) !== T.TCloseBracket) skipTypeScriptType(p, js_ast.L.LLowest);
      p.lexer.Expect(T.TCloseBracket);
    } else if (t === T.TExtends) {
      if (p.lexer.HasNewlineBefore || has(flags, disallowConditionalTypesFlag)) return;
      p.lexer.Next();
      skipTypeScriptTypeWithFlags(p, js_ast.L.LLowest, disallowConditionalTypesFlag);
      p.lexer.Expect(T.TQuestion);
      skipTypeScriptType(p, js_ast.L.LLowest);
      p.lexer.Expect(T.TColon);
      skipTypeScriptType(p, js_ast.L.LLowest);
    } else {
      return;
    }
  }
}

/** Go: func (p *parser) skipTypeScriptObjectType() (ts_parser.go:557) */
export function skipTypeScriptObjectType(p: parser): void {
  p.lexer.Expect(T.TOpenBrace);
  while ((p.lexer.Token as number) !== T.TCloseBrace) {
    if ((p.lexer.Token as number) === T.TPlus || (p.lexer.Token as number) === T.TMinus) p.lexer.Next();
    let foundKey = false;
    while (
      p.lexer.IsIdentifierOrKeyword() ||
      (p.lexer.Token as number) === T.TStringLiteral ||
      (p.lexer.Token as number) === T.TNumericLiteral
    ) {
      p.lexer.Next();
      foundKey = true;
    }
    if ((p.lexer.Token as number) === T.TOpenBracket) {
      p.lexer.Next();
      skipTypeScriptTypeWithFlags(p, js_ast.L.LLowest, isIndexSignatureFlag);
      if ((p.lexer.Token as number) === T.TColon) {
        p.lexer.Next();
        skipTypeScriptType(p, js_ast.L.LLowest);
      } else if ((p.lexer.Token as number) === T.TIn) {
        p.lexer.Next();
        skipTypeScriptType(p, js_ast.L.LLowest);
        if (p.lexer.IsContextualKeyword("as")) {
          p.lexer.Next();
          skipTypeScriptType(p, js_ast.L.LLowest);
        }
      }
      p.lexer.Expect(T.TCloseBracket);
      if ((p.lexer.Token as number) === T.TPlus || (p.lexer.Token as number) === T.TMinus) p.lexer.Next();
      foundKey = true;
    }
    if (foundKey && ((p.lexer.Token as number) === T.TQuestion || (p.lexer.Token as number) === T.TExclamation)) p.lexer.Next();
    skipTypeScriptTypeParameters(p, allowConstModifier);
    const t = p.lexer.Token as number;
    if (t === T.TColon) {
      if (!foundKey) p.lexer.Expect(T.TIdentifier);
      p.lexer.Next();
      skipTypeScriptType(p, js_ast.L.LLowest);
    } else if (t === T.TOpenParen) {
      skipTypeScriptFnArgs(p);
      if ((p.lexer.Token as number) === T.TColon) {
        p.lexer.Next();
        skipTypeScriptReturnType(p);
      }
    } else {
      if (!foundKey) p.lexer.Unexpected();
    }
    const t2 = p.lexer.Token as number;
    if (t2 === T.TCloseBrace) {
      // done
    } else if (t2 === T.TComma || t2 === T.TSemicolon) {
      p.lexer.Next();
    } else {
      if (!p.lexer.HasNewlineBefore) p.lexer.Unexpected();
    }
  }
  p.lexer.Expect(T.TCloseBrace);
}

/** Go: func (p *parser) skipTypeScriptTypeParameters(flags) (ts_parser.go:678) */
export function skipTypeScriptTypeParameters(p: parser, flags: number): number {
  if ((p.lexer.Token as number) !== T.TLessThan) return skipTypeParamsResult.didNotSkipAnything;
  p.lexer.Next();
  let result: number = skipTypeParamsResult.couldBeTypeCast;
  if ((flags & allowEmptyTypeParameters) !== 0 && (p.lexer.Token as number) === T.TGreaterThan) {
    p.lexer.Next();
    return skipTypeParamsResult.definitelyTypeParameters;
  }
  while (true) {
    let hasIn = false;
    let hasOut = false;
    let expectIdentifier = true;
    let invalidModifierRange = new LogRange();

    while (true) {
      if ((p.lexer.Token as number) === T.TConst) {
        if (invalidModifierRange.Len === 0 && (flags & allowConstModifier) === 0) invalidModifierRange = p.lexer.Range();
        result = skipTypeParamsResult.definitelyTypeParameters;
        p.lexer.Next();
        expectIdentifier = true;
        continue;
      }
      if ((p.lexer.Token as number) === T.TIn) {
        if (invalidModifierRange.Len === 0 && ((flags & allowInOutVarianceAnnotations) === 0 || hasIn || hasOut)) invalidModifierRange = p.lexer.Range();
        p.lexer.Next();
        hasIn = true;
        expectIdentifier = true;
        continue;
      }
      if (p.lexer.IsContextualKeyword("out")) {
        const r = p.lexer.Range();
        if (invalidModifierRange.Len === 0 && (flags & allowInOutVarianceAnnotations) === 0) invalidModifierRange = r;
        p.lexer.Next();
        if (invalidModifierRange.Len === 0 && hasOut && ((p.lexer.Token as number) === T.TIn || (p.lexer.Token as number) === T.TIdentifier)) invalidModifierRange = r;
        hasOut = true;
        expectIdentifier = false;
        continue;
      }
      break;
    }
    if (invalidModifierRange.Len > 0) {
      AddError(p.log, p.tracker, invalidModifierRange, `The modifier ${JSON.stringify(bytesToString(p.source.TextForRange(invalidModifierRange)))} is not valid here:`);
    }
    if (expectIdentifier || (p.lexer.Token as number) === T.TIdentifier) p.lexer.Expect(T.TIdentifier);
    if ((p.lexer.Token as number) === T.TExtends) {
      result = skipTypeParamsResult.definitelyTypeParameters;
      p.lexer.Next();
      skipTypeScriptType(p, js_ast.L.LLowest);
    }
    if ((p.lexer.Token as number) === T.TEquals) {
      result = skipTypeParamsResult.definitelyTypeParameters;
      p.lexer.Next();
      skipTypeScriptType(p, js_ast.L.LLowest);
    }
    if ((p.lexer.Token as number) !== T.TComma) break;
    p.lexer.Next();
    if ((p.lexer.Token as number) === T.TGreaterThan) {
      result = skipTypeParamsResult.definitelyTypeParameters;
      break;
    }
  }
  p.lexer.ExpectGreaterThan(false);
  return result;
}

/** Go: func (p *parser) skipTypeScriptTypeArguments(opts) bool (ts_parser.go:800) */
export function skipTypeScriptTypeArguments(p: parser, opts: skipTypeScriptTypeArgumentsOpts): boolean {
  const t = p.lexer.Token as number;
  if (t !== T.TLessThan && t !== T.TLessThanEquals && t !== T.TLessThanLessThan && t !== T.TLessThanLessThanEquals) return false;
  p.lexer.ExpectLessThan(false);
  while (true) {
    skipTypeScriptType(p, js_ast.L.LLowest);
    if ((p.lexer.Token as number) !== T.TComma) break;
    p.lexer.Next();
  }
  if (!opts.isParseTypeArgumentsInExpression) {
    p.lexer.ExpectGreaterThan(opts.isInsideJSXElement);
  } else {
    if (opts.isInsideJSXElement) p.lexer.ExpectInsideJSXElement(T.TGreaterThan);
    else p.lexer.Expect(T.TGreaterThan);
  }
  return true;
}

/** 通用 backtracking helper：Go 用 defer recover(LexerPanic) 回滚 lexer 值拷贝；
 *  TS 的 Lexer 是对象，用 clone() 做值语义（浅拷贝），panic 时恢复原对象。 */
function withBacktracking<T>(p: parser, fn: () => T, onPanic: T): T {
  const oldLexer = p.lexer;
  p.lexer = p.lexer.clone();
  p.lexer.IsLogDisabled = true;
  try {
    const result = fn();
    p.lexer.IsLogDisabled = oldLexer.IsLogDisabled;
    return result;
  } catch (e) {
    if (e instanceof LexerPanic) {
      p.lexer = oldLexer;
      return onPanic;
    }
    throw e;
  }
}

/** Go: func (p *parser) trySkipTypeArgumentsInExpressionWithBacktracking() bool (ts_parser.go:843) */
export function trySkipTypeArgumentsInExpressionWithBacktracking(p: parser): boolean {
  return withBacktracking(p, () => {
    if (skipTypeScriptTypeArguments(p, (() => { const o = new skipTypeScriptTypeArgumentsOpts(); o.isParseTypeArgumentsInExpression = true; return o; })())) {
      if (!tsCanFollowTypeArgumentsInExpression(p)) p.lexer.Unexpected();
    }
    return true;
  }, false);
}

/** Go: func (p *parser) trySkipTypeScriptTypeParametersThenOpenParenWithBacktracking() (ts_parser.go:870) */
export function trySkipTypeScriptTypeParametersThenOpenParenWithBacktracking(p: parser): number {
  return withBacktracking(p, () => {
    const result = skipTypeScriptTypeParameters(p, allowConstModifier);
    if ((p.lexer.Token as number) !== T.TOpenParen) p.lexer.Unexpected();
    return result;
  }, skipTypeParamsResult.didNotSkipAnything);
}

/** Go: func (p *parser) trySkipTypeScriptArrowReturnTypeWithBacktracking() bool (ts_parser.go:895) */
export function trySkipTypeScriptArrowReturnTypeWithBacktracking(p: parser): boolean {
  return withBacktracking(p, () => {
    p.lexer.Expect(T.TColon);
    skipTypeScriptReturnType(p);
    if ((p.lexer.Token as number) !== T.TEqualsGreaterThan) p.lexer.Unexpected();
    return true;
  }, false);
}

/** Go: func (p *parser) trySkipTypeScriptArrowArgsWithBacktracking() bool (ts_parser.go:1001) */
export function trySkipTypeScriptArrowArgsWithBacktracking(p: parser): boolean {
  return withBacktracking(p, () => {
    skipTypeScriptFnArgs(p);
    p.lexer.Expect(T.TEqualsGreaterThan);
    return true;
  }, false);
}

/** Go: func (p *parser) trySkipTypeScriptConstraintOfInferTypeWithBacktracking(flags) bool (ts_parser.go:1024) */
export function trySkipTypeScriptConstraintOfInferTypeWithBacktracking(p: parser, flags: number): boolean {
  return withBacktracking(p, () => {
    p.lexer.Expect(T.TExtends);
    skipTypeScriptTypeWithFlags(p, js_ast.L.LPrefix, disallowConditionalTypesFlag);
    if (!has(flags, disallowConditionalTypesFlag) && (p.lexer.Token as number) === T.TQuestion) p.lexer.Unexpected();
    return true;
  }, false);
}

/** Go: func (p *parser) skipTypeScriptParenOrFnType() (ts_parser.go:150) */
export function skipTypeScriptParenOrFnType(p: parser): void {
  if (trySkipTypeScriptArrowArgsWithBacktracking(p)) {
    skipTypeScriptReturnType(p);
  } else {
    p.lexer.Expect(T.TOpenParen);
    skipTypeScriptType(p, js_ast.L.LLowest);
    p.lexer.Expect(T.TCloseParen);
  }
}

/** Go: func (p *parser) skipTypeScriptFnArgs() (ts_parser.go:104) */
export function skipTypeScriptFnArgs(p: parser): void {
  p.lexer.Expect(T.TOpenParen);
  while ((p.lexer.Token as number) !== T.TCloseParen) {
    if ((p.lexer.Token as number) === T.TDotDotDot) p.lexer.Next();
    skipTypeScriptBinding(p);
    if ((p.lexer.Token as number) === T.TQuestion) p.lexer.Next();
    if ((p.lexer.Token as number) === T.TColon) {
      p.lexer.Next();
      skipTypeScriptType(p, js_ast.L.LLowest);
    }
    if ((p.lexer.Token as number) !== T.TComma) break;
    p.lexer.Next();
  }
  p.lexer.Expect(T.TCloseParen);
}

/** Go: func (p *parser) skipTypeScriptBinding() (ts_parser.go:19) */
export function skipTypeScriptBinding(p: parser): void {
  const t = p.lexer.Token as number;
  if (t === T.TIdentifier || t === T.TThis) {
    p.lexer.Next();
  } else if (t === T.TOpenBracket) {
    p.lexer.Next();
    while ((p.lexer.Token as number) === T.TComma) p.lexer.Next();
    while ((p.lexer.Token as number) !== T.TCloseBracket) {
      if ((p.lexer.Token as number) === T.TDotDotDot) p.lexer.Next();
      skipTypeScriptBinding(p);
      if ((p.lexer.Token as number) !== T.TComma) break;
      p.lexer.Next();
    }
    p.lexer.Expect(T.TCloseBracket);
  } else if (t === T.TOpenBrace) {
    p.lexer.Next();
    while ((p.lexer.Token as number) !== T.TCloseBrace) {
      let foundIdentifier = false;
      const pt = p.lexer.Token as number;
      if (pt === T.TDotDotDot) {
        p.lexer.Next();
        if ((p.lexer.Token as number) !== T.TIdentifier) p.lexer.Unexpected();
        foundIdentifier = true;
        p.lexer.Next();
      } else if (pt === T.TIdentifier) {
        foundIdentifier = true;
        p.lexer.Next();
      } else if (pt === T.TStringLiteral || pt === T.TNumericLiteral) {
        p.lexer.Next();
      } else {
        if (p.lexer.IsIdentifierOrKeyword()) p.lexer.Next();
        else p.lexer.Unexpected();
      }
      if ((p.lexer.Token as number) === T.TColon || !foundIdentifier) {
        p.lexer.Expect(T.TColon);
        skipTypeScriptBinding(p);
      }
      if ((p.lexer.Token as number) !== T.TComma) break;
      p.lexer.Next();
    }
    p.lexer.Expect(T.TCloseBrace);
  } else {
    p.lexer.Unexpected();
  }
}

/** Go: func (p *parser) isTypeScriptArrowReturnTypeAfterQuestionAndBeforeColon(...) bool (ts_parser.go:929)
 *  这是 esbuild 的 "gross hack"：在临时 parser 上解析箭头函数体后丢弃。
 *  Go 用 DeferLog + newParser(原 source/lexer/options) 建临时 parser；TS 用 newParser 忠实移植。 */
export function isTypeScriptArrowReturnTypeAfterQuestionAndBeforeColon(p: parser, awaitValue: number = 0): boolean {
  try {
    // Go: p := newParser(logger.NewDeferLog(...), originalParser.source, originalParser.lexer, &originalParser.options)
    const np = newParser(p.log, p.source, p.lexer, p.options);
    np.allowIn = p.allowIn;
    np.lexer.IsLogDisabled = true;
    np.pushScopeForParsePass(js_ast.ScopeKind.ScopeEntry, new LogLoc(0));
    np.pushScopeForParsePass(js_ast.ScopeKind.ScopeFunctionArgs, new LogLoc(1));
    np.lexer.Expect(T.TColon);
    skipTypeScriptReturnType(np);
    np.parseArrowBody([], awaitValue !== 0);
    np.lexer.Expect(T.TColon);
    return true;
  } catch (e) {
    if (e instanceof LexerPanic) return false;
    throw e;
  }
}

// ===========================================================================
// 第 35 轮 K-3（第一批）：TS interface/type stmt 跳过器（ts_parser.go:1271/1306）
// 通道② Go 字节证据：testdata/js_parser/k3-skipper-go.json（6 条 stmt，消费字节偏移）
// ===========================================================================

/** Go: func (p *parser) skipTypeScriptInterfaceStmt(opts parseStmtOpts) (ts_parser.go:1271) */
export function skipTypeScriptInterfaceStmt(p: parser, opts: { isModuleScope: boolean }): void {
  const name = p.lexer.Identifier.String;
  p.lexer.Expect(T.TIdentifier);
  if (opts.isModuleScope) p.localTypeNames.set(bytesToString(name), true);
  skipTypeScriptTypeParameters(p, allowInOutVarianceAnnotations | allowEmptyTypeParameters);
  if ((p.lexer.Token as number) === T.TExtends) {
    p.lexer.Next();
    while (true) {
      skipTypeScriptType(p, js_ast.L.LLowest);
      if ((p.lexer.Token as number) !== T.TComma) break;
      p.lexer.Next();
    }
  }
  if (p.lexer.IsContextualKeyword("implements")) {
    p.lexer.Next();
    while (true) {
      skipTypeScriptType(p, js_ast.L.LLowest);
      if ((p.lexer.Token as number) !== T.TComma) break;
      p.lexer.Next();
    }
  }
  skipTypeScriptObjectType(p);
}

/** Go: func (p *parser) skipTypeScriptTypeStmt(opts parseStmtOpts) (ts_parser.go:1306) */
export function skipTypeScriptTypeStmt(p: parser, opts: { isModuleScope: boolean; isExport: boolean }): void {
  if (opts.isExport) {
    const t = p.lexer.Token as number;
    if (t === T.TOpenBrace) {
      p.parseExportClause();
      if (p.lexer.IsContextualKeyword("from")) {
        p.lexer.Next();
        p.parsePath();
      }
      p.lexer.ExpectOrInsertSemicolon();
      return;
    }
    if (t === T.TAsterisk) {
      p.lexer.Next();
      if (p.lexer.IsContextualKeyword("as")) {
        p.lexer.Next();
        p.parseClauseAlias("export");
        p.lexer.Next();
      }
      p.lexer.ExpectContextualKeyword("from");
      p.parsePath();
      p.lexer.ExpectOrInsertSemicolon();
      return;
    }
  }
  const name = p.lexer.Identifier.String;
  p.lexer.Expect(T.TIdentifier);
  if (opts.isModuleScope) p.localTypeNames.set(bytesToString(name), true);
  skipTypeScriptTypeParameters(p, allowInOutVarianceAnnotations | allowEmptyTypeParameters);
  p.lexer.Expect(T.TEquals);
  skipTypeScriptType(p, js_ast.L.LLowest);
  p.lexer.ExpectOrInsertSemicolon();
}

// ---------------------------------------------------------------------------
// 第 39 轮 K-3：TS import-equals 解析（ts_parser.go:1540）—— 通道② 端到端。
// ---------------------------------------------------------------------------

/** Go: func (p *parser) parseTypeScriptImportEqualsStmt(loc, opts, defaultNameLoc, defaultName) js_ast.Stmt (ts_parser.go:1540) */
export function parseTypeScriptImportEqualsStmt(
  p: parser, loc: LogLoc, opts: { isExport: boolean; isTypeScriptDeclare: boolean },
  defaultNameLoc: LogLoc, defaultName: string,
): js_ast.Stmt {
  p.lexer.Expect(T.TEquals);
  const kind = p.selectLocalKind(js_ast.LocalKind.LocalConst);
  const name = p.lexer.Identifier;
  // TS 扁平符号数组下用 resolveName（建带 OriginalName 的 Unbound 符号）；Go 用 storeNameInRef 编码名
  let value = new js_ast.Expr(new js_ast.EIdentifier(p.resolveName(bytesToString(name.String), p.lexer.Loc())), p.lexer.Loc());
  p.lexer.Expect(T.TIdentifier);
  const nameStr = bytesToString(name.String);
  if (nameStr === "require" && (p.lexer.Token as number) === T.TOpenParen) {
    // "import ns = require('x')"
    p.lexer.Next();
    const path = new js_ast.Expr(new js_ast.EString(p.lexer.StringLiteral()), p.lexer.Loc());
    p.lexer.Expect(T.TStringLiteral);
    p.lexer.Expect(T.TCloseParen);
    const call = new js_ast.ECall();
    call.Target = value;
    call.Args = [path];
    value = new js_ast.Expr(call, value.Loc);
  } else {
    // "import Foo = Bar" / "import Foo = Bar.Baz"
    while ((p.lexer.Token as number) === T.TDot) {
      p.lexer.Next();
      const dot = new js_ast.EDot();
      dot.Target = value;
      dot.Name = bytesToString(p.lexer.Identifier.String);
      dot.NameLoc = p.lexer.Loc();
      dot.CanBeRemovedIfUnused = true;
      value = new js_ast.Expr(dot, value.Loc);
      p.lexer.Expect(T.TIdentifier);
    }
  }
  p.lexer.ExpectOrInsertSemicolon();
  if (opts.isTypeScriptDeclare) {
    return new js_ast.Stmt(js_ast.STypeScriptShared, loc);
  }
  const ref = p.declareSymbol(ast.SymbolKind.SymbolConst, defaultNameLoc, defaultName);
  const decl = init(new js_ast.Decl(), {
    Binding: init(new js_ast.Binding(), { Data: new js_ast.BIdentifier(ref), Loc: defaultNameLoc }),
    ValueOrNil: value,
  });
  const local = init(new js_ast.SLocal(), { Kind: kind, Decls: [decl], IsExport: opts.isExport, WasTSImportEquals: true });
  return new js_ast.Stmt(local, loc);
}

// ===========================================================================
// 第 42 轮深水链：TypeScript enum / namespace 解析底座（ts_parser.go 1360–2087）
// 全部按 Go 1:1 移植为「首参 p: parser」自由函数（与 K/J 批同约定）。
// 一个集中 Go 探针的 byte oracle 钉在 testdata/enum-chain-go.json（sha256 b3686c1d…）。
// ===========================================================================

/** Go: func (p *parser) getOrCreateExportedNamespaceMembers(name string, isExport bool) js_ast.TSNamespaceMembers (ts_parser.go:1598) */
export function getOrCreateExportedNamespaceMembers(p: parser, name: string, isExport: boolean): js_ast.TSNamespaceMembers {
  const scope = p.currentScope;
  if (scope !== null) {
    const existingMember = scope.Members.get(name);
    if (existingMember !== undefined) {
      const memberData = p.refToTSNamespaceMemberData.get(existingMember.Ref.InnerIndex);
      if (memberData instanceof js_ast.TSNamespaceMemberNamespace) return memberData.ExportedMembers;
    }
    if (isExport && scope.TSNamespace !== null) {
      const existing = scope.TSNamespace.ExportedMembers.get(name);
      if (existing !== undefined && existing.Data instanceof js_ast.TSNamespaceMemberNamespace) {
        return existing.Data.ExportedMembers;
      }
    }
  }
  return new Map();
}

/** Go: func (p *parser) parseTypeScriptEnumStmt(loc, opts) js_ast.Stmt (ts_parser.go:1360) */
export function parseTypeScriptEnumStmt(p: parser, loc: LogLoc, opts: import("./js_parser.ts").parseStmtOpts): js_ast.Stmt {
  p.lexer.Expect(T.TEnum);
  const nameLoc = p.lexer.Loc();
  const nameText = p.lexer.Identifier.String;
  p.lexer.Expect(T.TIdentifier);
  const name = new LocRef(nameLoc, InvalidRef);

  const exportedMembers = getOrCreateExportedNamespaceMembers(p, bytesToString(nameText), opts.isExport);
  const tsNamespace = new js_ast.TSNamespaceScope();
  tsNamespace.ExportedMembers = exportedMembers;
  tsNamespace.IsEnumScope = true;
  const enumMemberData = new js_ast.TSNamespaceMemberNamespace();
  enumMemberData.ExportedMembers = exportedMembers;

  const scopeIndex = p.scopesInOrder.length;
  if (!opts.isTypeScriptDeclare) {
    name.Ref = p.declareSymbol(SymbolKind.SymbolTSEnum, nameLoc, bytesToString(nameText));
    p.pushScopeForParsePass(js_ast.ScopeKind.ScopeEntry, loc);
    p.currentScope!.TSNamespace = tsNamespace;
    p.refToTSNamespaceMemberData.set(name.Ref.InnerIndex, enumMemberData);
  }

  p.lexer.Expect(T.TOpenBrace);
  const values: js_ast.EnumValue[] = [];

  const oldFnOrArrowData = p.fnOrArrowDataParse;
  p.fnOrArrowDataParse = new fnOrArrowDataParse();
  p.fnOrArrowDataParse.isThisDisallowed = true;

  while (p.lexer.Token !== T.TCloseBrace) {
    const nameRange = p.lexer.Range();
    const value = new js_ast.EnumValue();
    value.Loc = nameRange.Loc;
    value.Ref = InvalidRef;

    let nameStr: string;
    if (p.lexer.Token === T.TStringLiteral) {
      value.Name = new Uint16Array(p.lexer.StringLiteral());
      nameStr = utf16ToJS(value.Name);
    } else if (p.lexer.IsIdentifierOrKeyword()) {
      nameStr = bytesToString(p.lexer.Identifier.String);
      value.Name = new Uint16Array(StringToUTF16(new TextEncoder().encode(nameStr)));
    } else {
      p.lexer.Expect(T.TIdentifier);
      nameStr = "";
    }
    p.lexer.Next();

    if (!opts.isTypeScriptDeclare && IsIdentifierUTF16(value.Name)) {
      value.Ref = p.declareSymbol(SymbolKind.SymbolOther, value.Loc, nameStr);
    }

    if (p.lexer.Token === T.TEquals) {
      p.lexer.Next();
      value.ValueOrNil = p.parseExpr(js_ast.L.LComma);
    }

    values.push(value);
    const member = new js_ast.TSNamespaceMember();
    member.Loc = value.Loc;
    member.Data = new js_ast.TSNamespaceMemberProperty();
    member.IsEnumValue = true;
    exportedMembers.set(nameStr, member);

    if (p.lexer.Token !== T.TComma && p.lexer.Token !== T.TSemicolon) {
      if (p.lexer.IsIdentifierOrKeyword() || p.lexer.Token === T.TStringLiteral) {
        const errorLoc = value.ValueOrNil === null ? new LogLoc(nameRange.End()) : p.lexer.Loc();
        const nextName = p.lexer.Token === T.TStringLiteral
          ? utf16ToJS(new Uint16Array(p.lexer.StringLiteral()))
          : bytesToString(p.lexer.Identifier.String);
        const errorText = value.ValueOrNil === null
          ? "Expected \",\" after \"" + nameStr + "\" in enum"
          : "Expected \",\" before \"" + nextName + "\" in enum";
        AddError(p.log, p.tracker, new LogRange(errorLoc, 0), errorText);
        throw new LexerPanic();
      }
      break;
    }
    p.lexer.Next();
  }

  p.fnOrArrowDataParse = oldFnOrArrowData;

  if (!opts.isTypeScriptDeclare) {
    if (p.currentScope!.Members.has(bytesToString(nameText))) {
      tsNamespace.ArgRef = p.newSymbol(SymbolKind.SymbolHoisted, "_" + bytesToString(nameText));
      p.currentScope!.Generated.push(tsNamespace.ArgRef);
    } else {
      tsNamespace.ArgRef = p.declareSymbol(SymbolKind.SymbolHoisted, nameLoc, bytesToString(nameText));
    }
    p.refToTSNamespaceMemberData.set(tsNamespace.ArgRef.InnerIndex, enumMemberData);
    p.popScope();
  }

  p.lexer.Expect(T.TCloseBrace);

  if (opts.isTypeScriptDeclare) {
    return new js_ast.Stmt(js_ast.STypeScriptShared, loc);
  }

  if (p.scopesInOrderForEnum === null) p.scopesInOrderForEnum = new Map();
  p.scopesInOrderForEnum.set(loc.Start, p.scopesInOrder.slice(scopeIndex));

  const sEnum = new js_ast.SEnum();
  sEnum.Name = name;
  sEnum.Arg = tsNamespace.ArgRef;
  sEnum.Values = values;
  sEnum.IsExport = opts.isExport;
  return new js_ast.Stmt(sEnum, loc);
}

/** Go: func (p *parser) parseTypeScriptNamespaceStmt(loc, opts) js_ast.Stmt (ts_parser.go:1623) */
export function parseTypeScriptNamespaceStmt(p: parser, loc: LogLoc, opts: parseStmtOpts): js_ast.Stmt {
  const nameLoc = p.lexer.Loc();
  const nameText = p.lexer.Identifier.String;
  p.lexer.Next();

  const nameStr = bytesToString(nameText);
  const exportedMembers = getOrCreateExportedNamespaceMembers(p, nameStr, opts.isExport);
  const tsNamespace = new js_ast.TSNamespaceScope();
  tsNamespace.ExportedMembers = exportedMembers;
  const nsMemberData = new js_ast.TSNamespaceMemberNamespace();
  nsMemberData.ExportedMembers = exportedMembers;

  const name = new LocRef(nameLoc, InvalidRef);
  p.pushScopeForParsePass(js_ast.ScopeKind.ScopeEntry, loc);
  p.currentScope!.TSNamespace = tsNamespace;

  const oldHasNonLocal = p.hasNonLocalExportDeclareInsideNamespace;
  const oldFnOrArrowData = p.fnOrArrowDataParse;
  p.hasNonLocalExportDeclareInsideNamespace = false;
  p.fnOrArrowDataParse = new fnOrArrowDataParse();
  p.fnOrArrowDataParse.isThisDisallowed = true;
  p.fnOrArrowDataParse.isReturnDisallowed = true;

  let stmts: js_ast.Stmt[];
  if (p.lexer.Token === T.TDot) {
    const dotLoc = p.lexer.Loc();
    p.lexer.Next();
    const innerOpts = new parseStmtOpts();
    innerOpts.isExport = true;
    innerOpts.isNamespaceScope = true;
    innerOpts.isTypeScriptDeclare = opts.isTypeScriptDeclare;
    stmts = [parseTypeScriptNamespaceStmt(p, dotLoc, innerOpts)];
  } else if (opts.isTypeScriptDeclare && p.lexer.Token !== T.TOpenBrace) {
    p.lexer.ExpectOrInsertSemicolon();
    stmts = [];
  } else {
    p.lexer.Expect(T.TOpenBrace);
    const bodyOpts = new parseStmtOpts();
    bodyOpts.isNamespaceScope = true;
    bodyOpts.isTypeScriptDeclare = opts.isTypeScriptDeclare;
    stmts = p.parseStmtsUpTo(T.TCloseBrace, bodyOpts);
    p.lexer.Next();
  }

  const hasNonLocal = p.hasNonLocalExportDeclareInsideNamespace;
  p.hasNonLocalExportDeclareInsideNamespace = oldHasNonLocal;
  p.fnOrArrowDataParse = oldFnOrArrowData;

  for (const stmt of stmts) {
    const s = stmt.Data;
    if (s instanceof js_ast.SFunction && s.Fn.Name !== null && s.IsExport) {
      const n = p.symbols[s.Fn.Name.Ref.InnerIndex].OriginalName;
      const member = new js_ast.TSNamespaceMember();
      member.Loc = s.Fn.Name.Loc;
      member.Data = new js_ast.TSNamespaceMemberProperty();
      exportedMembers.set(n, member);
      p.refToTSNamespaceMemberData.set(s.Fn.Name.Ref.InnerIndex, member.Data);
    } else if (s instanceof js_ast.SClass && s.Class.Name !== null && s.IsExport) {
      const n = p.symbols[s.Class.Name.Ref.InnerIndex].OriginalName;
      const member = new js_ast.TSNamespaceMember();
      member.Loc = s.Class.Name.Loc;
      member.Data = new js_ast.TSNamespaceMemberProperty();
      exportedMembers.set(n, member);
      p.refToTSNamespaceMemberData.set(s.Class.Name.Ref.InnerIndex, member.Data);
    } else if (s instanceof js_ast.SLocal && s.IsExport) {
      js_ast_helpers.ForEachIdentifierBindingInDecls(s.Decls, (bLoc: LogLoc, b: js_ast.BIdentifier) => {
        const n = p.symbols[b.Ref.InnerIndex].OriginalName;
        const member = new js_ast.TSNamespaceMember();
        member.Loc = bLoc;
        member.Data = new js_ast.TSNamespaceMemberProperty();
        exportedMembers.set(n, member);
        p.refToTSNamespaceMemberData.set(b.Ref.InnerIndex, member.Data);
      });
    }
  }

  let importEqualsCount = 0;
  for (const stmt of stmts) {
    if (stmt.Data instanceof js_ast.SLocal && (stmt.Data as js_ast.SLocal).WasTSImportEquals && !(stmt.Data as js_ast.SLocal).IsExport) importEqualsCount++;
  }

  if ((stmts.length === importEqualsCount && !hasNonLocal) || opts.isTypeScriptDeclare) {
    p.popAndDiscardScope(p.scopesInOrder.length);
    if (opts.isModuleScope) p.localTypeNames.set(nameStr, true);
    return new js_ast.Stmt(js_ast.STypeScriptShared, loc);
  }

  if (p.currentScope!.Members.has(nameStr)) {
    tsNamespace.ArgRef = p.newSymbol(SymbolKind.SymbolHoisted, "_" + nameStr);
    p.currentScope!.Generated.push(tsNamespace.ArgRef);
  } else {
    tsNamespace.ArgRef = p.declareSymbol(SymbolKind.SymbolHoisted, nameLoc, nameStr);
  }
  p.refToTSNamespaceMemberData.set(tsNamespace.ArgRef.InnerIndex, nsMemberData);

  p.popScope();
  name.Ref = p.declareSymbol(SymbolKind.SymbolTSNamespace, nameLoc, nameStr);
  p.refToTSNamespaceMemberData.set(name.Ref.InnerIndex, nsMemberData);

  const sNamespace = new js_ast.SNamespace();
  sNamespace.Name = name;
  sNamespace.Arg = tsNamespace.ArgRef;
  sNamespace.Stmts = stmts;
  sNamespace.IsExport = opts.isExport;
  return new js_ast.Stmt(sNamespace, loc);
}

/** helper: make EIdentifier expr */
function enumIdent(p: parser, ref: ast.Ref, loc: LogLoc): js_ast.Expr {
  return new js_ast.Expr(new js_ast.EIdentifier(ref), loc);
}
/** helper: make EObject expr */
function enumObject(loc: LogLoc): js_ast.Expr {
  return new js_ast.Expr(new js_ast.EObject(), loc);
}
/** helper: follow symbol link chain */
function enumFollowSymbols(p: parser, ref: ast.Ref): ast.Ref {
  let r = ref;
  let guard = 0;
  while (p.symbols[r.InnerIndex] && !p.symbols[r.InnerIndex].Link.Equals(InvalidRef) && guard++ < p.symbols.length) {
    r = p.symbols[r.InnerIndex].Link;
  }
  return r;
}

/** Go: func (p *parser) generateClosureForTypeScriptNamespaceOrEnum(...) []js_ast.Stmt (ts_parser.go:1822) */
export function generateClosureForTypeScriptNamespaceOrEnum(
  p: parser, stmts: js_ast.Stmt[], stmtLoc: LogLoc, isExport: boolean, nameLoc: LogLoc,
  nameRef: ast.Ref, argRef: ast.Ref, stmtsInsideClosure: js_ast.Stmt[],
): js_ast.Stmt[] {
  nameRef = enumFollowSymbols(p, nameRef);
  const symbol = p.symbols[nameRef.InnerIndex];

  if ((symbol.Kind === SymbolKind.SymbolTSNamespace || symbol.Kind === SymbolKind.SymbolTSEnum) && !p.emittedNamespaceVars.get(nameRef.InnerIndex)) {
    const decl = new js_ast.Decl();
    const binding = new js_ast.Binding();
    binding.Loc = nameLoc;
    binding.Data = new js_ast.BIdentifier(nameRef);
    decl.Binding = binding;
    p.emittedNamespaceVars.set(nameRef.InnerIndex, true);
    if (p.currentScope === p.moduleScope) {
      const local = new js_ast.SLocal();
      local.Kind = js_ast.LocalKind.LocalVar;
      local.Decls = [decl];
      local.IsExport = isExport;
      stmts.push(new js_ast.Stmt(local, stmtLoc));
    } else {
      const local = new js_ast.SLocal();
      local.Kind = js_ast.LocalKind.LocalLet;
      local.Decls = [decl];
      stmts.push(new js_ast.Stmt(local, stmtLoc));
    }
  }

  // M1: minifySyntax=false → "name || (name = {})"（Go 1886；无外层 Assign）
  const logicalOr1 = new js_ast.EBinary();
  logicalOr1.Op = js_ast.OpCode.BinOpLogicalOr;
  logicalOr1.Left = enumIdent(p, nameRef, nameLoc);
  logicalOr1.Right = js_ast_helpers.Assign(enumIdent(p, nameRef, nameLoc), enumObject(nameLoc));
  const argExpr = new js_ast.Expr(logicalOr1, nameLoc);
  p.recordUsage(nameRef);
  p.recordUsage(nameRef);

  // M1: Arrow bit clear → EArrow with PreferExpr=false
  const arg = new js_ast.Arg();
  const argBinding = new js_ast.Binding();
  argBinding.Loc = nameLoc;
  argBinding.Data = new js_ast.BIdentifier(argRef);
  arg.Binding = argBinding;
  const body = new js_ast.FnBody();
  body.Loc = stmtLoc;
  body.Block.Stmts = stmtsInsideClosure;
  const arrow = new js_ast.EArrow();
  arrow.Args = [arg];
  arrow.Body = body;
  arrow.PreferExpr = false;
  const call = new js_ast.ECall();
  call.Target = new js_ast.Expr(arrow, stmtLoc);
  call.Args = [argExpr];
  const callExprStmt = new js_ast.SExpr();
  callExprStmt.Value = new js_ast.Expr(call, stmtLoc);
  stmts.push(new js_ast.Stmt(callExprStmt, stmtLoc));
  return stmts;
}

/** Go: func (p *parser) generateClosureForTypeScriptEnum(...) []js_ast.Stmt (ts_parser.go:1954) */
export function generateClosureForTypeScriptEnum(
  p: parser, stmts: js_ast.Stmt[], stmtLoc: LogLoc, isExport: boolean, nameLoc: LogLoc,
  nameRef: ast.Ref, argRef: ast.Ref, exprsInsideClosure: js_ast.Expr[], allValuesArePure: boolean,
): js_ast.Stmt[] {
  if (p.currentScope !== p.moduleScope) {
    let stmtsInside: js_ast.Stmt[] = [];
    for (const expr of exprsInsideClosure) { const se = new js_ast.SExpr(); se.Value = expr; stmtsInside.push(new js_ast.Stmt(se, expr.Loc)); }
    return generateClosureForTypeScriptNamespaceOrEnum(p, stmts, stmtLoc, isExport, nameLoc, nameRef, argRef, stmtsInside);
  }

  nameRef = enumFollowSymbols(p, nameRef);

  const argExpr = enumIdent(p, argRef, nameLoc);
  const stmtsInsideClosure: js_ast.Stmt[] = [];
  // M1 minifySyntax=false: each expr as stmt, then return argExpr
  for (const expr of exprsInsideClosure) { const se = new js_ast.SExpr(); se.Value = expr; stmtsInsideClosure.push(new js_ast.Stmt(se, expr.Loc)); }
  const retStmt = new js_ast.SReturn(); retStmt.ValueOrNil = argExpr;
  stmtsInsideClosure.push(new js_ast.Stmt(retStmt, argExpr.Loc));

  const arg = new js_ast.Arg();
  const argBinding = new js_ast.Binding();
  argBinding.Loc = nameLoc;
  argBinding.Data = new js_ast.BIdentifier(argRef);
  arg.Binding = argBinding;
  const body = new js_ast.FnBody();
  body.Loc = stmtLoc;
  body.Block.Stmts = stmtsInsideClosure;
  const arrow = new js_ast.EArrow();
  arrow.Args = [arg];
  arrow.Body = body;
  arrow.PreferExpr = false;
  const targetExpr = new js_ast.Expr(arrow, stmtLoc);

  const call = new js_ast.ECall();
  call.Target = targetExpr;
  const logicalOr2 = new js_ast.EBinary();
  logicalOr2.Op = js_ast.OpCode.BinOpLogicalOr;
  logicalOr2.Left = enumIdent(p, nameRef, nameLoc);
  logicalOr2.Right = enumObject(nameLoc);
  const orExpr = new js_ast.Expr(logicalOr2, nameLoc);
  call.Args = [orExpr];
  call.CanBeUnwrappedIfUnused = allValuesArePure;

  const decl = new js_ast.Decl();
  const binding = new js_ast.Binding();
  binding.Loc = nameLoc;
  binding.Data = new js_ast.BIdentifier(nameRef);
  decl.Binding = binding;
  decl.ValueOrNil = new js_ast.Expr(call, stmtLoc);
  p.recordUsage(nameRef);

  const local = new js_ast.SLocal();
  local.Kind = js_ast.LocalKind.LocalVar;
  local.Decls = [decl];
  local.IsExport = isExport && !p.emittedNamespaceVars.get(nameRef.InnerIndex);
  stmts.push(new js_ast.Stmt(local, stmtLoc));
  p.emittedNamespaceVars.set(nameRef.InnerIndex, true);
  return stmts;
}
