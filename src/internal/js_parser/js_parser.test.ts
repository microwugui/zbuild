// js_parser 骨架子集的差分测试。
//
// 期望值全部来自 Go 实测：`testdata/js_parser/ast-dump.json` 由 /root/esbuild 里包内临时探针
// `internal/js_parser/tmpdump_test.go`（TestTmpASTDump / TestTmpGlobalName）生成：
//   - 对 testdata/js_parser/cases.json 的每个输入，用真实的 `js_parser.Parse` 解析
//     （jsx.Parse=1 & jsx.Preserve=1，ts.Parse=0），再把 AST 按**同一套 schema** dump 成 JSON。
//   - ParseGlobalName 同样用真实 Go 函数跑出结果（含 ok=false 的部分返回值语义）。
//
// TS 侧跑的是本仓库的 parser 骨架（js_parser.ts），dump 成同 schema 后逐节点 deepEqual。
// 因此这个测试同时验证三件事：parser 骨架本身的形状、js_ast 节点的字段语义、
// 以及**只能由 parser 驱动的 js_lexer 路径**（ScanRegExp / RescanCloseBraceAsTemplateToken /
// JSX 三个 Next* / Expect* 系 / decodeJSXEntities）。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as js_ast from "../js_ast/js_ast.ts";
import {
  Parse,
  ParseGlobalName,
  Options,
  DefineExpr,
  generateTempRefArg,
  isSameRegexp,
  jsxExprsEqual,
  isJumpStatement,
  jumpStmtsLookTheSame,
  stmtCaresAboutScope,
  stmtsCareAboutScope,
  dropFirstStatement,
  caseBodyCouldHaveFallThrough,
  findIdentifiers,
  shouldKeepStmtInDeadControlFlow,
  textForParenthesesSuggestion,
  defineValueCanBeUsedInAssignTarget,
  locAfterOp,
  isEvalOrArguments,
  newParser,
  parseStmtOpts,
  fnOrArrowDataParse,
  bindingOpts,
  deferredErrors,
  deferredArrowArgErrors,
  wasOriginallyDot,
  wasOriginallyIndex,
  parser as ParserClass,
} from "./js_parser.ts";
import type { parser } from "./js_parser.ts";
import { computeClassLoweringInfo, privateSymbolNeedsToBeLowered } from "./js_parser_lower_class.ts";
import {
  isStrictMode, isStrictModeOutputFormat, markStrictModeFeature, strictModeFeature, whyESM, whyStrictMode,
} from "./js_parser_lower.ts";
import {
  disallowConditionalTypesFlag,
  has,
  isReturnTypeFlag,
  isTSArrowFnJSX,
  tsCanFollowTypeArgumentsInExpression,
  tsIsBinaryOperator,
  tsIsIdentifier,
  tsIsStartOfExpression,
  tsIsStartOfLeftHandSideExpression,
  tsLookAheadNextTokenIsOpenParenOrLessThanOrDot,
} from "./ts_parser.ts";
import { duplicateCaseEquals, duplicateCaseHash } from "./js_parser.ts";
import { Log, Loc, MsgKind, Path, Range, Source } from "../logger/logger.ts";
import { SymbolFlags, SymbolKind } from "../ast/ast.ts";
import { JSFeature } from "../compat/compat.ts";
import { ImportAssertOrWith, LocRef } from "../ast/ast.ts";
import { Lexer, MaybeSubstring } from "../js_lexer/js_lexer.ts";
import { T } from "../js_lexer/tables.ts";
import { UTF16ToString } from "../helpers/utf.ts";
import { createHash } from "node:crypto";
import { Format as PrintFormat, Options as PrintOptions, Print } from "../js_printer/js_printer.ts";

/** 一个静默的 Log（Go 侧用 NewDeferLog 丢弃消息；Log 类的默认 AddMsg 就是空实现） */
function silentLog(): Log {
  return new Log();
}

function makeSource(contents: string): Source {
  const source = new Source();
  source.Contents = new TextEncoder().encode(contents);
  source.KeyPath = new Path();
  source.KeyPath.Text = "<stdin>";
  return source;
}

interface CaseIn {
  name: string;
  contents: string;
  jsx: boolean;
  ts: boolean;
}

interface CaseOut {
  name: string;
  ok: boolean;
  stmts?: unknown[];
  /** Go: parser 的 exprComments 副作用（loc.Start → 注释文本） */
  exprComments?: Record<string, string[]>;
}

const cases: CaseIn[] = JSON.parse(
  readFileSync(new URL("../../../testdata/js_parser/cases.json", import.meta.url), "utf8"),
);
const expected: CaseOut[] = JSON.parse(
  readFileSync(new URL("../../../testdata/js_parser/ast-dump.json", import.meta.url), "utf8"),
);
const globalNames: { input: string; ok: boolean; result: string[] }[] = JSON.parse(
  readFileSync(new URL("../../../testdata/js_parser/global-names.json", import.meta.url), "utf8"),
);

const decoder = new TextDecoder();

/** Go: math.Float64bits(v) 的十进制字符串（避免 JSON 精度损失） */
function f64bits(v: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, v, false);
  let bits = 0n;
  for (let i = 0; i < 8; i++) bits = (bits << 8n) | BigInt(view.getUint8(i));
  return bits.toString();
}

function utf16ToInts(v: Uint16Array): number[] {
  return Array.from(v);
}

class Dumper {
  ast: js_ast.AST;

  constructor(ast: js_ast.AST) {
    this.ast = ast;
  }

  symbolName(ref: { InnerIndex: number }): string {
    return this.ast.Symbols[ref.InnerIndex].OriginalName;
  }

  binding(b: js_ast.Binding): unknown {
    const d = b.Data;
    if (d instanceof js_ast.BIdentifier) {
      return { kind: "BIdentifier", name: this.symbolName(d.Ref), loc: b.Loc.Start };
    }
    if (d instanceof js_ast.BMissing) return { kind: "BMissing" };
    if (d instanceof js_ast.BArray) {
      return {
        kind: "BArray",
        closeBracketLoc: d.CloseBracketLoc.Start,
        hasSpread: d.HasSpread,
        isSingleLine: d.IsSingleLine,
        items: d.Items.map((item) => ({
          binding: this.binding(item.Binding),
          loc: item.Loc.Start,
          default: item.DefaultValueOrNil !== null ? this.expr(item.DefaultValueOrNil) : null,
        })),
      };
    }
    if (d instanceof js_ast.BObject) {
      return {
        kind: "BObject",
        closeBraceLoc: d.CloseBraceLoc.Start,
        isSingleLine: d.IsSingleLine,
        properties: d.Properties.map((p) => ({
          key: this.expr(p.Key),
          value: this.binding(p.Value),
          loc: p.Loc.Start,
          closeBracketLoc: p.CloseBracketLoc.Start,
          isComputed: p.IsComputed,
          isSpread: p.IsSpread,
          preferQuotedKey: p.PreferQuotedKey,
          default: p.DefaultValueOrNil !== null ? this.expr(p.DefaultValueOrNil) : null,
        })),
      };
    }
    return { kind: "UNSUPPORTED" };
  }

  property(p: js_ast.Property): unknown {
    const m: Record<string, unknown> = {
      kind: p.Kind,
      flags: p.Flags,
      loc: p.Loc.Start,
      closeBracketLoc: p.CloseBracketLoc.Start,
      key: this.expr(p.Key),
      value: p.ValueOrNil !== null ? this.expr(p.ValueOrNil) : null,
      initializer: p.InitializerOrNil !== null ? this.expr(p.InitializerOrNil) : null,
      classStaticBlock: p.ClassStaticBlock !== null
        ? { stmts: p.ClassStaticBlock.Block.Stmts.map((s) => this.stmt(s)), loc: p.ClassStaticBlock.Loc.Start }
        : null,
    };
    return m;
  }

  class(c: js_ast.Class): unknown {
    return {
      classKeywordLoc: c.ClassKeyword.Loc.Start,
      classKeywordLen: c.ClassKeyword.Len,
      bodyLoc: c.BodyLoc.Start,
      closeBraceLoc: c.CloseBraceLoc.Start,
      name: c.Name !== null ? this.symbolName(c.Name.Ref) : null,
      nameLoc: c.Name !== null ? c.Name.Loc.Start : null,
      extends: c.ExtendsOrNil !== null ? this.expr(c.ExtendsOrNil) : null,
      properties: c.Properties.map((p) => this.property(p)),
    };
  }

  fn(fn: js_ast.Fn): unknown {
    const m: Record<string, unknown> = {};
    if (fn.Name !== null) {
      m.name = this.symbolName(fn.Name.Ref);
      m.nameLoc = fn.Name.Loc.Start;
    } else {
      m.name = null;
    }
    m.isAsync = fn.IsAsync;
    m.isGenerator = fn.IsGenerator;
    m.args = fn.Args.map((arg) => this.binding(arg.Binding));
    m.body = fn.Body.Block.Stmts.map((stmt) => this.stmt(stmt));
    return m;
  }

  clauseItem(item: js_ast.ClauseItem): unknown {
    return {
      alias: item.Alias,
      aliasLoc: item.AliasLoc.Start,
      name: this.symbolName(item.Name.Ref),
      nameLoc: item.Name.Loc.Start,
      originalName: item.OriginalName,
    };
  }

  stmt(stmt: js_ast.Stmt): unknown {
    const m: Record<string, unknown> = { loc: stmt.Loc.Start };
    const s = stmt.Data;

    if (s instanceof js_ast.SEmpty) {
      m.kind = "SEmpty";
    } else if (s instanceof js_ast.SDebugger) {
      m.kind = "SDebugger";
    } else if (s instanceof js_ast.SDirective) {
      m.kind = "SDirective";
      m.value = utf16ToInts(s.Value);
    } else if (s instanceof js_ast.SExpr) {
      m.kind = "SExpr";
      m.value = this.expr(s.Value);
    } else if (s instanceof js_ast.SReturn) {
      m.kind = "SReturn";
      m.value = s.ValueOrNil !== null ? this.expr(s.ValueOrNil) : null;
    } else if (s instanceof js_ast.SBlock) {
      m.kind = "SBlock";
      m.stmts = s.Stmts.map((inner) => this.stmt(inner));
    } else if (s instanceof js_ast.SIf) {
      m.kind = "SIf";
      m.test = this.expr(s.Test);
      m.yes = this.stmt(s.Yes);
      m.no = s.NoOrNil !== null ? this.stmt(s.NoOrNil) : null;
    } else if (s instanceof js_ast.SFunction) {
      m.kind = "SFunction";
      m.fn = this.fn(s.Fn);
      m.isExport = s.IsExport;
    } else if (s instanceof js_ast.SClass) {
      m.kind = "SClass";
      m.class = this.class(s.Class);
      m.isExport = s.IsExport;
    } else if (s instanceof js_ast.SLocal) {
      m.kind = "SLocal";
      m.localKind = s.Kind;
      m.isExport = s.IsExport;
      m.decls = s.Decls.map((d) => ({
        binding: this.binding(d.Binding),
        value: d.ValueOrNil !== null ? this.expr(d.ValueOrNil) : null,
      }));
    } else if (s instanceof js_ast.SImport) {
      m.kind = "SImport";
      m.defaultName = s.DefaultName !== null ? this.symbolName(s.DefaultName.Ref) : null;
      m.defaultNameLoc = s.DefaultName !== null ? s.DefaultName.Loc.Start : null;
      m.items = s.Items !== null ? s.Items.map((item) => this.clauseItem(item)) : null;
      m.starName = s.StarNameLoc !== null ? this.symbolName(s.NamespaceRef) : null;
      m.starNameLoc = s.StarNameLoc !== null ? s.StarNameLoc.Start : null;
      m.isSingleLine = s.IsSingleLine;
      m.path = this.ast.ImportRecords[s.ImportRecordIndex].Path.Text;
      m.flags = this.ast.ImportRecords[s.ImportRecordIndex].Flags;
    } else if (s instanceof js_ast.SExportClause) {
      m.kind = "SExportClause";
      m.items = s.Items.map((item) => this.clauseItem(item));
      m.isSingleLine = s.IsSingleLine;
    } else if (s instanceof js_ast.SExportFrom) {
      m.kind = "SExportFrom";
      m.items = s.Items.map((item) => this.clauseItem(item));
      m.namespaceRef = this.symbolName(s.NamespaceRef);
      m.isSingleLine = s.IsSingleLine;
      m.path = this.ast.ImportRecords[s.ImportRecordIndex].Path.Text;
    } else if (s instanceof js_ast.SExportStar) {
      m.kind = "SExportStar";
      m.alias = s.Alias !== null ? { originalName: s.Alias.OriginalName, loc: s.Alias.Loc.Start } : null;
      m.namespaceRef = this.symbolName(s.NamespaceRef);
      m.path = this.ast.ImportRecords[s.ImportRecordIndex].Path.Text;
    } else if (s instanceof js_ast.SExportDefault) {
      m.kind = "SExportDefault";
      m.defaultName = this.symbolName(s.DefaultName.Ref);
      m.defaultNameLoc = s.DefaultName.Loc.Start;
      m.value = this.stmt(s.Value);
    } else if (s instanceof js_ast.SBreak) {
      m.kind = "SBreak";
      m.label = s.Label !== null ? this.symbolName(s.Label.Ref) : null;
    } else if (s instanceof js_ast.SContinue) {
      m.kind = "SContinue";
      m.label = s.Label !== null ? this.symbolName(s.Label.Ref) : null;
    } else if (s instanceof js_ast.SThrow) {
      m.kind = "SThrow";
      m.value = this.expr(s.Value);
    } else if (s instanceof js_ast.SWhile) {
      m.kind = "SWhile";
      m.test = this.expr(s.Test);
      m.body = this.stmt(s.Body);
      m.isSingleLineBody = s.IsSingleLineBody;
    } else if (s instanceof js_ast.SDoWhile) {
      m.kind = "SDoWhile";
      m.test = this.expr(s.Test);
      m.body = this.stmt(s.Body);
    } else if (s instanceof js_ast.SFor) {
      m.kind = "SFor";
      m.init = s.InitOrNil !== null ? this.stmt(s.InitOrNil) : null;
      m.test = s.TestOrNil !== null ? this.expr(s.TestOrNil) : null;
      m.update = s.UpdateOrNil !== null ? this.expr(s.UpdateOrNil) : null;
      m.body = this.stmt(s.Body);
      m.isSingleLineBody = s.IsSingleLineBody;
    } else if (s instanceof js_ast.SForIn) {
      m.kind = "SForIn";
      m.init = this.stmt(s.Init);
      m.value = this.expr(s.Value);
      m.body = this.stmt(s.Body);
      m.isSingleLineBody = s.IsSingleLineBody;
    } else if (s instanceof js_ast.SForOf) {
      m.kind = "SForOf";
      m.awaitLen = s.Await.Len;
      m.init = this.stmt(s.Init);
      m.value = this.expr(s.Value);
      m.body = this.stmt(s.Body);
      m.isSingleLineBody = s.IsSingleLineBody;
    } else if (s instanceof js_ast.SSwitch) {
      m.kind = "SSwitch";
      m.test = this.expr(s.Test);
      m.cases = s.Cases.map((c) => ({
        loc: c.Loc.Start,
        value: c.ValueOrNil !== null ? this.expr(c.ValueOrNil) : null,
        body: c.Body.map((inner) => this.stmt(inner)),
      }));
      m.bodyLoc = s.BodyLoc.Start;
      m.closeBraceLoc = s.CloseBraceLoc.Start;
    } else if (s instanceof js_ast.STry) {
      m.kind = "STry";
      m.blockLoc = s.BlockLoc.Start;
      m.block = s.Block.Stmts.map((inner) => this.stmt(inner));
      m.closeBraceLoc = s.Block.CloseBraceLoc.Start;
      m.catch = s.Catch !== null ? {
        loc: s.Catch.Loc.Start,
        blockLoc: s.Catch.BlockLoc.Start,
        binding: s.Catch.BindingOrNil !== null ? this.binding(s.Catch.BindingOrNil) : null,
        block: s.Catch.Block.Stmts.map((inner) => this.stmt(inner)),
      } : null;
      m.finally = s.Finally !== null ? {
        loc: s.Finally.Loc.Start,
        block: s.Finally.Block.Stmts.map((inner) => this.stmt(inner)),
      } : null;
    } else if (s instanceof js_ast.SLabel) {
      m.kind = "SLabel";
      m.name = this.symbolName(s.Name.Ref);
      m.nameLoc = s.Name.Loc.Start;
      m.stmt = this.stmt(s.Stmt);
      m.isSingleLineStmt = s.IsSingleLineStmt;
    } else {
      m.kind = "UNSUPPORTED";
    }
    return m;
  }

  expr(expr: js_ast.Expr): unknown {
    const m: Record<string, unknown> = { loc: expr.Loc.Start };
    const e = expr.Data;

    if (e === null) {
      // Go: dumpExpr 对 nil Data 走 default 分支，typeName(nil) == "nil"
      m.kind = "UNSUPPORTED";
      m.goType = "nil";
      return m;
    }

    if (e instanceof js_ast.EIdentifier) {
      m.kind = "EIdentifier";
      m.name = this.symbolName(e.Ref);
    } else if (e instanceof js_ast.ENumber) {
      m.kind = "ENumber";
      m.bits = f64bits(e.Value);
    } else if (e instanceof js_ast.EBigInt) {
      m.kind = "EBigInt";
      m.value = e.Value;
    } else if (e instanceof js_ast.EString) {
      m.kind = "EString";
      m.value = utf16ToInts(e.Value);
      m.preferTemplate = e.PreferTemplate;
    } else if (e instanceof js_ast.EBoolean) {
      m.kind = "EBoolean";
      m.value = e.Value;
    } else if (e instanceof js_ast.ENull) {
      m.kind = "ENull";
    } else if (e instanceof js_ast.EThis) {
      m.kind = "EThis";
    } else if (e instanceof js_ast.EUndefined) {
      m.kind = "EUndefined";
    } else if (e instanceof js_ast.ERegExp) {
      m.kind = "ERegExp";
      m.value = e.Value;
    } else if (e instanceof js_ast.EUnary) {
      m.kind = "EUnary";
      m.op = e.Op;
      m.value = this.expr(e.Value);
    } else if (e instanceof js_ast.EBinary) {
      m.kind = "EBinary";
      m.op = e.Op;
      m.isParenthesized = e.IsParenthesized;
      m.left = this.expr(e.Left);
      m.right = this.expr(e.Right);
    } else if (e instanceof js_ast.ECall) {
      m.kind = "ECall";
      m.optionalChain = e.OptionalChain;
      m.target = this.expr(e.Target);
      m.args = e.Args.map((arg) => this.expr(arg));
    } else if (e instanceof js_ast.EDot) {
      m.kind = "EDot";
      m.optionalChain = e.OptionalChain;
      m.target = this.expr(e.Target);
      m.name = e.Name;
    } else if (e instanceof js_ast.EIndex) {
      m.kind = "EIndex";
      m.optionalChain = e.OptionalChain;
      m.target = this.expr(e.Target);
      m.index = this.expr(e.Index);
    } else if (e instanceof js_ast.ESuper) {
      m.kind = "ESuper";
    } else if (e instanceof js_ast.ENewTarget) {
      m.kind = "ENewTarget";
      m.rangeLoc = e.Range.Loc.Start;
      m.rangeLen = e.Range.Len;
    } else if (e instanceof js_ast.ENew) {
      m.kind = "ENew";
      m.target = this.expr(e.Target);
      m.args = e.Args.map((arg) => this.expr(arg));
      m.closeParenLoc = e.CloseParenLoc.Start;
      m.isMultiLine = e.IsMultiLine;
    } else if (e instanceof js_ast.EIf) {
      m.kind = "EIf";
      m.test = this.expr(e.Test);
      m.yes = this.expr(e.Yes);
      m.no = this.expr(e.No);
    } else if (e instanceof js_ast.EAwait) {
      m.kind = "EAwait";
      m.value = this.expr(e.Value);
    } else if (e instanceof js_ast.EYield) {
      m.kind = "EYield";
      m.value = e.ValueOrNil !== null ? this.expr(e.ValueOrNil) : null;
      m.isStar = e.IsStar;
    } else if (e instanceof js_ast.EArray) {
      m.kind = "EArray";
      m.items = e.Items.map((item) => this.expr(item));
      m.isSingleLine = e.IsSingleLine;
      m.isParenthesized = e.IsParenthesized;
      m.closeBracketLoc = e.CloseBracketLoc.Start;
    } else if (e instanceof js_ast.EObject) {
      m.kind = "EObject";
      m.properties = e.Properties.map((p) => this.property(p));
      m.isSingleLine = e.IsSingleLine;
      m.isParenthesized = e.IsParenthesized;
      m.closeBraceLoc = e.CloseBraceLoc.Start;
    } else if (e instanceof js_ast.EArrow) {
      m.kind = "EArrow";
      m.args = e.Args.map((arg) => ({
        binding: this.binding(arg.Binding),
        default: arg.DefaultOrNil !== null ? this.expr(arg.DefaultOrNil) : null,
      }));
      m.body = e.Body.Block.Stmts.map((stmt) => this.stmt(stmt));
      m.bodyLoc = e.Body.Loc.Start;
      m.isAsync = e.IsAsync;
      m.hasRestArg = e.HasRestArg;
      m.preferExpr = e.PreferExpr;
      m.isParenthesized = e.IsParenthesized;
    } else if (e instanceof js_ast.EClass) {
      m.kind = "EClass";
      m.class = this.class(e.Class);
    } else if (e instanceof js_ast.ESpread) {
      m.kind = "ESpread";
      m.value = this.expr(e.Value);
    } else if (e instanceof js_ast.ETemplate) {
      m.kind = "ETemplate";
      m.tag = e.TagOrNil !== null ? this.expr(e.TagOrNil) : null;
      m.headRaw = e.TagOrNil !== null ? decoder.decode(e.HeadRaw) : null;
      m.headCooked = e.HeadCooked !== null ? utf16ToInts(e.HeadCooked) : null;
      m.parts = e.Parts.map((p) => ({
        value: this.expr(p.Value),
        tailLoc: p.TailLoc.Start,
        ...(e.TagOrNil !== null
          ? { tailRaw: decoder.decode(p.TailRaw), tailCooked: null }
          : { tailCooked: p.TailCooked !== null ? utf16ToInts(p.TailCooked) : null, tailRaw: null }),
      }));
    } else if (e instanceof js_ast.EJSXElement) {
      m.kind = "EJSXElement";
      m.tag = e.TagOrNil !== null ? this.expr(e.TagOrNil) : null;
      m.properties = e.Properties.map((p) => ({
        kind: p.Kind,
        flags: p.Flags,
        loc: p.Loc.Start,
        key: this.expr(p.Key),
        value: p.ValueOrNil !== null ? this.expr(p.ValueOrNil) : null,
      }));
      m.children = e.NullableChildren.map((c) => (c.Data === null ? null : this.expr(c)));
      m.isTagSingleLine = e.IsTagSingleLine;
    } else if (e instanceof js_ast.EJSXText) {
      m.kind = "EJSXText";
      m.raw = decoder.decode(e.Raw);
    } else if (e instanceof js_ast.EFunction) {
      m.kind = "EFunction";
      m.fn = this.fn(e.Fn);
      m.isParenthesized = e.IsParenthesized;
    } else if (e instanceof js_ast.EMissing) {
      m.kind = "EMissing";
    } else {
      m.kind = "UNSUPPORTED";
    }
    return m;
  }
}

/** 一个静默的 Log（Go 侧用 NewDeferLog 丢弃消息） */
test("declareSymbol 重复声明诊断与 Go 实测一致", () => {
  // 期望值来自真实 Go 二进制：
  //   printf 'let x; let x;' | /tmp/esbuild-go --loader=js
  //   ✘ [ERROR] The symbol "x" has already been declared
  //     The symbol "x" was originally declared here:
  const msgs: { Kind: number; Data: { Text: string }; Notes: { Text: string }[] }[] = [];
  const log = new Log();
  log.AddMsg = (msg) => {
    msgs.push(msg as unknown as { Kind: number; Data: { Text: string }; Notes: { Text: string }[] });
  };
  Parse(log, makeSource("let x; let x;"), new Options());
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].Kind, MsgKind.Error);
  assert.equal(msgs[0].Data.Text, 'The symbol "x" has already been declared');
  assert.equal(msgs[0].Notes.length, 1);
  assert.equal(msgs[0].Notes[0].Text, 'The symbol "x" was originally declared here:');
});

test(`Parse：${cases.length} 个输入的 AST 与 Go 实测逐节点一致`, () => {
  assert.equal(cases.length, expected.length);
  assert.ok(cases.length >= 20, "语料不得缩水");

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const want = expected[i];
    assert.equal(want.name, c.name, "夹具顺序必须与语料一致");

    const options = new Options();
    options.jsx.Parse = c.jsx;
    options.jsx.Preserve = true;
    options.ts.Parse = c.ts;

    const source = makeSource(c.contents);
    const { ast, ok } = Parse(silentLog(), source, options);

    assert.equal(ok, want.ok, `[${c.name}] ok`);
    if (!want.ok) continue;

    const actual: unknown[] = [];
    try {
      for (const part of ast.Parts) {
        for (const stmt of part.Stmts) actual.push(new Dumper(ast).stmt(stmt));
      }
    } catch (e) {
      throw new Error(`[${c.name}] dump 失败: ${(e as Error).message}`);
    }
    assert.deepEqual(actual, want.stmts, `[${c.name}] AST 不一致`);

    // Go: saveExprCommentsHere 的副作用（exprComments）也必须逐条一致。
    const actualComments: Record<string, string[]> = {};
    for (const [loc, list] of ast.ExprComments) actualComments[String(loc)] = list;
    assert.deepEqual(actualComments, want.exprComments ?? {}, `[${c.name}] exprComments 不一致`);
  }
});

test("ParseGlobalName：与 Go 实测一致（含 panic 时的部分返回值）", () => {
  for (const want of globalNames) {
    const source = makeSource(want.input);
    const { result, ok } = ParseGlobalName(silentLog(), source);
    assert.equal(ok, want.ok, `[${want.input}] ok`);
    assert.deepEqual(result, want.result, `[${want.input}] result`);
  }
});

// 期望值来自真实 Go 二进制（/tmp/esbuild-go，即本仓库 1:1 对照的 esbuild 0.28.2）：
//   echo 'using x' | /tmp/esbuild-go --loader=js
//   ✘ [ERROR] The declaration "x" must be initialized
test("requireInitializers 的诊断文案与 Go 实测一致", () => {
  const msgs: string[] = [];
  const log = silentLog();
  log.AddMsg = (msg) => { msgs.push(msg.Data.Text); };
  Parse(log, makeSource("using x"), new Options());
  assert.equal(msgs[0], 'The declaration "x" must be initialized');
});

test("Parse 的错误路径：非法输入返回 ok=false，不抛异常", () => {
  const options = new Options();
  const source = makeSource("x = ;");
  assert.equal(Parse(silentLog(), source, options).ok, false);

  // 第 19 次推进起 M1 全量 4,238 例（均为 Go 可解析输入）TS 侧 parse/print 失败为 0，
  // 原先用 `import.meta` / `for (async of [])` 当「未实现哨兵」的断言已失效（两者现已支持）。
  // 目前没有已知的「Go 可解析、TS 不可解析」输入，因此不再保留哨兵断言；
  // M1 的 tsError 回升应以 m1.json 的 tsErrors 为准，而不是这里的硬编码。
});

// 第 22 次推进：访问器参数个数诊断（keyNameForError + Go 的 getter/setter 规则）
// 期望值来自真实 Go 二进制（/tmp/esbuild-go）：
//   x = { get a(b) {} };      → ✘ [ERROR] Getter "a" must have zero arguments
//   x = { set a() {} };       → ✘ [ERROR] Setter "a" must have exactly one argument
//   x = { set a(b, c) {} };   → 同上（位置取第二个参数）
//   class Foo { get #a(b) {} } → ✘ [ERROR] Getter "#a" must have zero arguments
test("访问器参数个数诊断与 Go 实测文案一致（含私有名 #a）", () => {
  const cases: [string, string][] = [
    ["x = { get a(b) {} };", 'Getter "a" must have zero arguments'],
    ["x = { set a() {} };", 'Setter "a" must have exactly one argument'],
    ["x = { set a(b, c) {} };", 'Setter "a" must have exactly one argument'],
    ["class Foo { get #a(b) {} }", 'Getter "#a" must have zero arguments'],
  ];
  for (const [input, want] of cases) {
    const msgs: string[] = [];
    const log = silentLog();
    log.AddMsg = (msg) => { msgs.push(msg.Data.Text); };
    Parse(log, makeSource(input), new Options());
    assert.equal(msgs[0], want, input);
  }
});

// 第 22 次推进：重复对象 key 警告（warnAboutDuplicateProperties）
// 期望值来自真实 Go 二进制：x = {a: 1, a: 2, __proto__: 1, __proto__: 2, get b(){}, set b(v){}};
//   ▲ [WARNING] Duplicate key "a" in object literal [duplicate-object-key]
//   ＋ The original key "a" is here:
// 说明：__proto__ 重复不报；get b/set b 成对不报。
test("重复对象 key 警告与 Go 实测一致（__proto__ / get+set 不报）", () => {
  const msgs: { kind: number; text: string; notes: string[] }[] = [];
  const log = silentLog();
  log.AddMsg = (msg) => {
    msgs.push({ kind: msg.Kind, text: msg.Data.Text, notes: msg.Notes.map((n) => n.Text) });
  };
  Parse(
    log,
    makeSource("x = {a: 1, a: 2, __proto__: 1, __proto__: 2, get b(){}, set b(v){}};"),
    new Options(),
  );
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].kind, MsgKind.Warning);
  assert.equal(msgs[0].text, 'Duplicate key "a" in object literal');
  assert.deepEqual(msgs[0].notes, ['The original key "a" is here:']);
});

// 第 22 次推进：单语句上下文的 lexical 声明禁止（forbidLexicalDecl / forbidUsingInSwitch）
// 期望值来自真实 Go 二进制（/tmp/esbuild-go --loader=js）：
//   if (1) let x;                  → Cannot use a declaration in a single-statement context
//   while (1) function f(){}       → 同上
//   if (1) class C {}              → 同上
//   switch (x) { case 1: using y = a; } → Cannot use a "using" declaration directly inside a switch case
// 对照（Go 不报）：if (1) function f(){}、x: function f(){}
test("单语句上下文的声明诊断与 Go 实测一致（含 switch 里的 using）", () => {
  const cases: [string, string][] = [
    ["if (1) let x;", "Cannot use a declaration in a single-statement context"],
    ["while (1) function f(){}", "Cannot use a declaration in a single-statement context"],
    ["if (1) class C {}", "Cannot use a declaration in a single-statement context"],
    ['switch (x) { case 1: using y = a; }', 'Cannot use a "using" declaration directly inside a switch case'],
  ];
  for (const [input, want] of cases) {
    const msgs: string[] = [];
    const log = silentLog();
    log.AddMsg = (msg) => { msgs.push(msg.Data.Text); };
    Parse(log, makeSource(input), new Options());
    assert.ok(msgs.includes(want), `${input} => ${JSON.stringify(msgs)}`);
  }
  for (const input of ["if (1) function f(){}", "x: function f(){}"]) {
    const msgs: string[] = [];
    const log = silentLog();
    log.AddMsg = (msg) => { msgs.push(msg.Data.Text); };
    Parse(log, makeSource(input), new Options());
    assert.deepEqual(msgs, [], input);
  }
});

// 第 22 次推进：scopeMemberArray（Go: Len/Swap/Less）的真实执行证据。
// hoistSymbols 对每个非 hoisting 作用域排序成员；这里构造两个 ≥2 成员的作用域
// （块 let a, let b + 函数体 let c, d），确保排序路径被覆盖。
test("scopeMemberArray 排序在 ≥2 成员的作用域上执行（不改变输出）", () => {
  const { ast, ok } = Parse(silentLog(), makeSource("{ let a; let b; } function f(){ let c, d; }"), new Options());
  assert.equal(ok, true);
  assert.ok(ast.Parts.length > 0);
});

// ---------------------------------------------------------------------------
// 第 23 次推进：F 批（visit pass）前置 + G 批纯谓词 —— 15 个包级整函数
//
// 期望值全部来自 Go 实测：`testdata/js_parser/visit-predicates.json`
// （sha256 91be54bbac6648900cb1d145e4f4f20c5e97d160915a219330f21f1f327a3e7a，23,501 字节）
// 由 /root/esbuild 的包内临时探针 `internal/js_parser/tmpvisit_test.go`（TestTmpVisitPredicates）
// 生成（探针存仓：`tools/go/tmpgenvisit_test.go`，用完即删），复现：
//   cp tools/go/tmpgenvisit_test.go /root/esbuild/internal/js_parser/tmpvisit_test.go
//   cd /root/esbuild && go test ./internal/js_parser -run TestTmpVisitPredicates -count=1 -v \
//     | sed -n '/^{/,$p' > testdata/js_parser/visit-predicates.json
// 探针拿真实的 `js_parser.Parse` 解析 21 个片段，再在 Go 侧调同名函数：
//   isJumpStatement / stmtCaresAboutScope / caseBodyCouldHaveFallThrough / findIdentifiers /
//   shouldKeepStmtInDeadControlFlow / jumpStmtsLookTheSame / textForParenthesesSuggestion /
//   locAfterOp / defineValueCanBeUsedInAssignTarget / isEvalOrArguments / isSameRegexp / jsxExprsEqual
// ---------------------------------------------------------------------------
const visitPredicates = JSON.parse(
  readFileSync(new URL("../../../testdata/js_parser/visit-predicates.json", import.meta.url), "utf8"),
);

/** 建 parser + 首个 token 已 lex 完的 lexer（`Lexer.NewLexer` 内部已经 Next() 一次） */
function makeParser(contents: string, options: Options = new Options(), log: Log = silentLog()): parser {
  const source = makeSource(contents);
  return newParser(log, source, Lexer.NewLexer(log, source, options.ts), options);
}

test("visit/minify 谓词与 Go 实测逐项相等（21 片段 + 231 对 jumpStmtsLookTheSame）", () => {
  const all: js_ast.Stmt[] = [];
  for (const want of visitPredicates.stmts) {
    const { ast, ok } = Parse(silentLog(), makeSource(want.input), new Options());
    assert.equal(ok, true, want.input);
    const stmts: js_ast.Stmt[] = [];
    for (const part of ast.Parts) stmts.push(...part.Stmts);
    assert.ok(stmts.length > 0, want.input);
    const stmt = stmts[0];
    all.push(stmt);

    assert.equal(isJumpStatement(stmt.Data), want.isJumpStatement, `${want.input} isJumpStatement`);
    assert.equal(stmtCaresAboutScope(stmt.Data), want.stmtCaresAboutScope, `${want.input} stmtCaresAboutScope`);
    assert.equal(caseBodyCouldHaveFallThrough([stmt]), want.couldFallThrough, `${want.input} couldFallThrough`);

    const block = new js_ast.SBlock();
    block.Stmts = [stmt];
    assert.equal(
      caseBodyCouldHaveFallThrough([new js_ast.Stmt(block, stmt.Loc)]),
      want.couldFallThroughBlock,
      `${want.input} couldFallThroughBlock`,
    );

    if (stmt.Data instanceof js_ast.SLocal) {
      let ids: js_ast.Decl[] = [];
      for (const decl of stmt.Data.Decls) ids = findIdentifiers(decl.Binding, ids);
      assert.equal(ids.length, want.identifierCount, `${want.input} identifierCount`);
    }

    // 这一行会就地裁掉 SLocal 的非标识符 decl，必须放在 identifierCount 之后（同探针顺序）
    assert.equal(
      shouldKeepStmtInDeadControlFlow(stmt),
      want.shouldKeepInDeadControlFlow,
      `${want.input} shouldKeepInDeadControlFlow`,
    );
  }

  for (const want of visitPredicates.pairs) {
    assert.equal(
      jumpStmtsLookTheSame(all[want.i].Data, all[want.j].Data),
      want.lookTheSame,
      `jumpStmtsLookTheSame(${want.i}, ${want.j})`,
    );
  }
});

test("括号建议 / 操作符后位置 / 赋值目标 / eval-arguments / 正则与 DefineExpr 相等：与 Go 实测相等", () => {
  for (const want of visitPredicates.parentheses) {
    assert.equal(textForParenthesesSuggestion(want.input), want.text, `textForParenthesesSuggestion(${want.input})`);
  }

  // locAfterOp：Go 侧 dump 的是 "a + b + c;" 外层 EBinary 的左右 loc 与 locAfterOp 结果
  const binAst = Parse(silentLog(), makeSource("a + b + c;"), new Options()).ast;
  const bin = (binAst.Parts[0].Stmts[0].Data as js_ast.SExpr).Value.Data as js_ast.EBinary;
  const locs = visitPredicates.locAfterOp;
  assert.equal(bin.Left.Loc.Start, locs.leftStart);
  assert.equal(bin.Right.Loc.Start, locs.rightStart);
  assert.equal(locAfterOp(bin).Start, locs.afterOp);
  // 交换左右操作数的场景（Go 注释里的 "transposed the operands"）
  const swapped = new js_ast.EBinary();
  swapped.Left = new js_ast.Expr(null, new Loc(10));
  swapped.Right = new js_ast.Expr(null, new Loc(4));
  assert.equal(locAfterOp(swapped).Start, locs.transposedAfterOp);

  for (const want of visitPredicates.assignTarget) {
    const ast = Parse(silentLog(), makeSource(want.input), new Options()).ast;
    const e = (ast.Parts[0].Stmts[0].Data as js_ast.SExpr).Value;
    assert.equal(defineValueCanBeUsedInAssignTarget(e.Data), want.ok, `defineValueCanBeUsedInAssignTarget(${want.input})`);
  }

  for (const want of visitPredicates.evalOrArguments) {
    assert.equal(isEvalOrArguments(want.input), want.isEvalOrArguments, `isEvalOrArguments(${want.input})`);
  }

  const regexp = [isSameRegexp(/a+/, /a+/), isSameRegexp(/a+/, /a*/), isSameRegexp(null, /a*/), isSameRegexp(null, null)];
  for (let i = 0; i < regexp.length; i++) {
    assert.equal(regexp[i], visitPredicates.sameRegexp[i].same, `isSameRegexp #${i}`);
  }

  const partsEq = (): DefineExpr => {
    const e = new DefineExpr();
    e.Parts = ["a", "b"];
    return e;
  };
  const partsShort = (): DefineExpr => {
    const e = new DefineExpr();
    e.Parts = ["a"];
    return e;
  };
  const withConst = (value: boolean): DefineExpr => {
    const e = partsEq();
    e.Constant = new js_ast.EBoolean(value);
    return e;
  };
  const jsx = [
    jsxExprsEqual(partsEq(), partsEq()),
    jsxExprsEqual(partsEq(), partsShort()),
    jsxExprsEqual(partsEq(), withConst(true)),
    jsxExprsEqual(withConst(true), partsEq()),
    jsxExprsEqual(withConst(true), withConst(true)),
    jsxExprsEqual(withConst(true), withConst(false)),
  ];
  for (let i = 0; i < jsx.length; i++) {
    assert.equal(jsx[i], visitPredicates.jsxExprsEqual[i].equal, `jsxExprsEqual #${i}`);
  }
});

// ---------------------------------------------------------------------------
// 第 23 次推进：15 个 parser 侧整函数（作用域栈 / 符号合并 / 临时变量 / 标签 / 词法态）
//
// 这一组是 unit·临时 等级（不是 Go 逐字节差分）：断言写成 Go 函数注释里的不变量，
// 以及 Go 探针实测到的事实（临时变量名 `_a`/`_b` 来自 `DefaultNameMinifierJS`，
// 十进制串 `0x10 → 16` 与 legacy octal 标记来自 tmpsscan / tmplex 两个探针实测）。
// ---------------------------------------------------------------------------
test("popAndDiscardScope / discardScopesUpTo：作用域栈回滚（Go js_parser.go:1272 / :1322）", () => {
  const p = makeParser("a;");
  const moduleScope = p.currentScope!;
  assert.equal(p.scopesInOrder.length, 1);

  const i1 = p.pushScopeForParsePass(js_ast.ScopeKind.ScopeBlock, new Loc(1));
  p.pushScopeForParsePass(js_ast.ScopeKind.ScopeBlock, new Loc(2));
  assert.equal(p.scopesInOrder.length, 3);
  assert.equal(moduleScope.Children.length, 1);

  // popAndDiscardScope：反序摘掉 [scopeIndex, ...) 的所有子作用域，再回到父作用域。
  // Go 的调用点都是在刚 push 的那一层里调（内部只上移一层），所以这里先 popScope() 对齐。
  p.popScope();
  p.popAndDiscardScope(i1);
  assert.equal(p.scopesInOrder.length, i1);
  assert.equal(p.currentScope, moduleScope);
  assert.equal(moduleScope.Children.length, 0);

  // discardScopesUpTo：作用域已 pop 掉、但还挂在父的 Children 上时，把它从父里摘掉
  const i2 = p.pushScopeForParsePass(js_ast.ScopeKind.ScopeBlock, new Loc(3));
  assert.equal(moduleScope.Children.length, 1);
  p.popScope();
  assert.equal(p.currentScope, moduleScope);
  p.discardScopesUpTo(i2);
  assert.equal(p.scopesInOrder.length, i2);
  assert.equal(moduleScope.Children.length, 0);
});

test("mergeSymbols：Link 链 + MergeContentsWith（Go js_parser.go:1358）", () => {
  const p = makeParser("a;");
  const a = p.newSymbol(SymbolKind.SymbolHoisted, "a");
  const b = p.newSymbol(SymbolKind.SymbolHoisted, "b");
  p.symbols[a.InnerIndex].UseCountEstimate = 2;
  p.symbols[b.InnerIndex].UseCountEstimate = 3;

  // old == new 时原样返回
  assert.equal(p.mergeSymbols(a, a).Equals(a), true);

  const merged = p.mergeSymbols(a, b);
  assert.equal(merged.Equals(b), true);
  assert.equal(p.symbols[a.InnerIndex].Link.Equals(b), true);
  // Go: newSymbol.MergeContentsWith(oldSymbol) —— 使用计数累加
  assert.equal(p.symbols[b.InnerIndex].UseCountEstimate, 5);
});

test("declareBinding：逐标识符 declareSymbol（Go js_parser.go:1719）", () => {
  const p = makeParser("let foo; x");
  const binding = new js_ast.Binding();
  const id = new js_ast.BIdentifier();
  binding.Data = id;
  binding.Loc = new Loc(4);
  // Go 的 binding 里存的是名字 ref（storeNameInRef），declareBinding 用 loadNameFromRef 取回
  id.Ref = p.storeNameInRef({ String: new TextEncoder().encode("foo"), Start: 0 } as never);

  p.declareBinding(SymbolKind.SymbolHoisted, binding, new parseStmtOpts());

  const member = p.currentScope!.Members.get("foo");
  assert.ok(member !== undefined);
  assert.equal(member!.Ref.Equals(id.Ref), true);
  // isTypeScriptDeclare 且不在 namespace 里 → 不声明（Go 的同一个 if）
  const p2 = makeParser("let foo;");
  const binding2 = new js_ast.Binding();
  const id2 = new js_ast.BIdentifier();
  binding2.Data = id2;
  id2.Ref = p2.storeNameInRef({ String: new TextEncoder().encode("bar"), Start: 0 } as never);
  const opts = new parseStmtOpts();
  opts.isTypeScriptDeclare = true;
  p2.declareBinding(SymbolKind.SymbolHoisted, binding2, opts);
  assert.equal(p2.currentScope!.Members.get("bar"), undefined);
});

test("makePromiseRef / makeRegExpRef / makeBigIntRef：同一 ref 复用且 RegExp/BigInt 进 Generated", () => {
  const p = makeParser("a;");
  assert.equal(p.makePromiseRef().Equals(p.makePromiseRef()), true);
  assert.equal(p.makeRegExpRef().Equals(p.makeRegExpRef()), true);
  assert.equal(p.makeBigIntRef().Equals(p.makeBigIntRef()), true);
  assert.equal(p.symbols[p.makePromiseRef().InnerIndex].Kind, SymbolKind.SymbolUnbound);
  const generated = p.moduleScope!.Generated.map((r) => r.InnerIndex);
  assert.ok(generated.includes(p.makeRegExpRef().InnerIndex));
  assert.ok(generated.includes(p.makeBigIntRef().InnerIndex));
  assert.ok(!generated.includes(p.makePromiseRef().InnerIndex));
});

test("generateTempRef：名字序列 _a/_b 与可选名（Go js_parser.go:8624）", () => {
  const p = makeParser("a;");
  const first = p.generateTempRef(generateTempRefArg.tempRefNoDeclare, "");
  const second = p.generateTempRef(generateTempRefArg.tempRefNoDeclare, "");
  const named = p.generateTempRef(generateTempRefArg.tempRefNeedsDeclare, "myTemp");
  assert.equal(p.symbols[first.InnerIndex].OriginalName, "_a");
  assert.equal(p.symbols[second.InnerIndex].OriginalName, "_b");
  assert.equal(p.symbols[named.InnerIndex].OriginalName, "myTemp");
  // tempRefNoDeclare 不进 tempRefsToDeclare；tempRefNeedsDeclare 进
  assert.equal(p.tempRefsToDeclare.length, 1);
  assert.equal(p.tempRefsToDeclare[0].ref.Equals(named), true);
  assert.equal(p.tempLetsToDeclare.length, 0);
  assert.ok(p.moduleScope!.Generated.length >= 3);
});

test("findLabelSymbol：命中标签 / 未命中报 Go 文案并建 unbound（Go js_parser.go:8758）", () => {
  const p = makeParser("lbl: while (a) break lbl;");
  p.pushScopeForParsePass(js_ast.ScopeKind.ScopeLabel, new Loc(0));
  const scope = p.currentScope!;
  scope.Label = new LocRef();
  scope.Label.Ref = p.newSymbol(SymbolKind.SymbolLabel, "lbl");
  scope.LabelStmtIsLoop = true;

  const hit = p.findLabelSymbol(new Loc(19), "lbl");
  assert.equal(hit.ok, true);
  assert.equal(hit.isLoop, true);
  assert.equal(hit.ref.Equals(scope.Label.Ref), true);
  assert.equal(p.symbols[hit.ref.InnerIndex].UseCountEstimate, 1);

  const msgs: string[] = [];
  const log = silentLog();
  log.AddMsg = (msg) => { msgs.push(msg.Data.Text); };
  const p2 = makeParser("lbl: while (a) break lbl;", new Options(), log);
  p2.pushScopeForParsePass(js_ast.ScopeKind.ScopeLabel, new Loc(0));
  p2.currentScope!.Label = new LocRef();
  p2.currentScope!.Label.Ref = p2.newSymbol(SymbolKind.SymbolLabel, "lbl");
  const miss = p2.findLabelSymbol(new Loc(19), "nope");
  assert.equal(miss.ok, false);
  assert.equal(miss.isLoop, false);
  assert.equal(p2.symbols[miss.ref.InnerIndex].Kind, SymbolKind.SymbolUnbound);
  // Go: fmt.Sprintf("There is no containing label named %q", name)
  assert.deepEqual(msgs, ['There is no containing label named "nope"']);
});

test("ignoreUsage 回滚使用计数，ignoreUsageOfIdentifierInDotChain 只穿透 dot/字符串下标", () => {
  const p = makeParser("a.b[c].d; e[f].g;");
  const a = p.newSymbol(SymbolKind.SymbolUnbound, "a");
  p.recordUsage(a);
  assert.equal(p.symbols[a.InnerIndex].UseCountEstimate, 1);
  p.ignoreUsage(a);
  assert.equal(p.symbols[a.InnerIndex].UseCountEstimate, 0);

  // a.b["c"].d：链上所有标识符都被回滚
  const ast = Parse(silentLog(), makeSource("a.b[c].d;"), new Options()).ast;
  const chain = (ast.Parts[0].Stmts[0].Data as js_ast.SExpr).Value;
  const p3 = makeParser("a.b[c].d;");
  const symA = p3.newSymbol(SymbolKind.SymbolUnbound, "a");
  p3.recordUsage(symA);
  const id = new js_ast.EIdentifier();
  id.Ref = symA;
  const dotOuter = new js_ast.EDot();
  dotOuter.Target = new js_ast.Expr(id, new Loc(0));
  const strIndex = new js_ast.EIndex();
  strIndex.Index = new js_ast.Expr(new js_ast.EString(), new Loc(2));
  strIndex.Target = new js_ast.Expr(dotOuter, new Loc(2));
  p3.ignoreUsageOfIdentifierInDotChain(new js_ast.Expr(strIndex, new Loc(0)));
  assert.equal(p3.symbols[symA.InnerIndex].UseCountEstimate, 0);

  // e[f].g：下标不是字符串字面量 → 不回头，e 的计数不变
  const p4 = makeParser("e[f].g;");
  const symE = p4.newSymbol(SymbolKind.SymbolUnbound, "e");
  p4.recordUsage(symE);
  const idE = new js_ast.EIdentifier();
  idE.Ref = symE;
  const numIndex = new js_ast.EIndex();
  numIndex.Index = new js_ast.Expr(new js_ast.EIdentifier(), new Loc(2));
  numIndex.Target = new js_ast.Expr(idE, new Loc(0));
  const dotE = new js_ast.EDot();
  dotE.Target = new js_ast.Expr(numIndex, new Loc(0));
  p4.ignoreUsageOfIdentifierInDotChain(new js_ast.Expr(dotE, new Loc(0)));
  assert.equal(p4.symbols[symE.InnerIndex].UseCountEstimate, 1);
  assert.ok(chain.Data !== null);
});

test("valueToSubstituteForRequire：mode=0 走 requireRef（Go js_parser.go:1863）", () => {
  const p = makeParser("require(x)");
  p.requireRef = p.newSymbol(SymbolKind.SymbolUnbound, "require");
  const value = p.valueToSubstituteForRequire(new Loc(3));
  assert.ok(value.Data instanceof js_ast.EIdentifier);
  assert.equal((value.Data as js_ast.EIdentifier).Ref.Equals(p.requireRef), true);
  assert.equal(value.Loc.Start, 3);
  assert.equal(p.symbols[p.requireRef.InnerIndex].UseCountEstimate, 1);
});

test("pushScopeForVisitPass：消费 scopesInOrder[0] 并校验 (kind, loc)（Go js_parser.go:8657）", () => {
  const p = makeParser("a;");
  const first = p.scopesInOrder[0];
  assert.equal(p.scopesInOrder.length, 1);
  p.pushScopeForVisitPass(js_ast.ScopeKind.ScopeEntry, new Loc(0));
  assert.equal(p.currentScope, first.scope);
  assert.equal(p.scopesInOrder.length, 0);

  const p2 = makeParser("a;");
  assert.throws(() => p2.pushScopeForVisitPass(js_ast.ScopeKind.ScopeBlock, new Loc(0)), /Expected scope/);
});

test("checkForLegacyOctalLiteral / parseBigIntOrStringIfUnsupported：词法态驱动", () => {
  const source = makeSource("0x10n");
  const options = new Options();
  // Lexer.NewLexer 内部已经 Next() 过一次，这里不再推进（Go 的 NewLexer 同构）
  const lexer = Lexer.NewLexer(silentLog(), source, options.ts);
  assert.equal(lexer.Token, T.TBigIntegerLiteral);
  assert.equal(new TextDecoder().decode(lexer.Identifier.String), "0x10");
  const p = newParser(silentLog(), source, lexer, options);

  const asBigInt = p.parseBigIntOrStringIfUnsupported().Data;
  assert.ok(asBigInt instanceof js_ast.EBigInt);
  assert.equal((asBigInt as js_ast.EBigInt).Value, "0x10");

  // unsupportedJSFeatures 含 Bigint → 降级成十进制字符串（Go: big.Int 的 Scan 输出 16）
  const p2 = newParser(silentLog(), source, Lexer.NewLexer(silentLog(), source, options.ts), options);
  p2.options = new Options();
  p2.options.unsupportedJSFeatures = BigInt(1) << BigInt(5);
  const asString = p2.parseBigIntOrStringIfUnsupported().Data;
  assert.ok(asString instanceof js_ast.EString);
  assert.equal(new TextDecoder().decode(UTF16ToString((asString as js_ast.EString).Value)), "16");

  const octalSource = makeSource("010");
  const octalOptions = new Options();
  const octalLexer = Lexer.NewLexer(silentLog(), octalSource, octalOptions.ts);
  assert.equal(octalLexer.IsLegacyOctalLiteral, true);
  const p3 = newParser(silentLog(), octalSource, octalLexer, octalOptions);
  const number = new js_ast.ENumber(8);
  p3.checkForLegacyOctalLiteral(number);
  assert.ok(p3.legacyOctalLiterals !== null);
  assert.ok(p3.legacyOctalLiterals!.has(number));
  assert.equal(p3.legacyOctalLiterals!.get(number)!.Len > 0, true);

  const decimalSource = makeSource("10");
  const decimalLexer = Lexer.NewLexer(silentLog(), decimalSource, octalOptions.ts);
  assert.equal(decimalLexer.IsLegacyOctalLiteral, false);
  const p4 = newParser(silentLog(), decimalSource, decimalLexer, octalOptions);
  p4.checkForLegacyOctalLiteral(new js_ast.ENumber(10));
  assert.equal(p4.legacyOctalLiterals, null);
});

// 第 23 次推进：stmtsCareAboutScope / dropFirstStatement
// 期望值来自 Go 实测（包内临时探针 TestTmpDropFirst，用完即删）：
//   cd /root/esbuild && go test ./internal/js_parser -run TestTmpDropFirst -count=1 -v
//   "{ a; b; }"     cares=false dropped=SExpr        replaced=block(len=2 firstEmpty=true)
//   "{ a; let x; }" cares=false dropped=block(len=1) replaced=block(len=2 firstEmpty=true)
//   "{ let x; }"    cares=false dropped=block(len=0) replaced=block(len=1 firstEmpty=true)
//   "{ a; }"        cares=false dropped=block(len=0) replaced=block(len=1 firstEmpty=true)
//   "a;"            cares=false dropped=SEmpty       replaced=SEmpty
test("stmtsCareAboutScope / dropFirstStatement 与 Go 实测一致", () => {  const parseFirst = (input: string): js_ast.Stmt => {
    const ast = Parse(silentLog(), makeSource(input), new Options()).ast;
    for (const part of ast.Parts) {
      if (part.Stmts.length > 0) return part.Stmts[0];
    }
    throw new Error(`no stmts: ${input}`);
  };
  const cloneBlock = (stmt: js_ast.Stmt): js_ast.Stmt => {
    const block = stmt.Data;
    if (block instanceof js_ast.SBlock) {
      const copied = new js_ast.SBlock();
      copied.Stmts = block.Stmts.slice();
      return new js_ast.Stmt(copied, stmt.Loc);
    }
    return stmt;
  };

  const cases: [string, string, number, number][] = [
    ["{ a; b; }", "SExpr", 0, 2],
    ["{ a; let x; }", "SBlock", 1, 2],
    ["{ let x; }", "SBlock", 0, 1],
    ["{ a; }", "SBlock", 0, 1],
  ];
  for (const [input, droppedKind, droppedLen, replacedLen] of cases) {
    const body = parseFirst(input);
    assert.equal(stmtsCareAboutScope([body]), false, `${input} stmtsCareAboutScope`);

    const dropped = dropFirstStatement(cloneBlock(body), null);
    if (droppedKind === "SExpr") {
      assert.ok(dropped.Data instanceof js_ast.SExpr, `${input} dropped kind`);
    } else {
      assert.ok(dropped.Data instanceof js_ast.SBlock, `${input} dropped kind`);
      assert.equal((dropped.Data as js_ast.SBlock).Stmts.length, droppedLen, `${input} dropped len`);
    }

    const replaced = dropFirstStatement(cloneBlock(body), new js_ast.Stmt(js_ast.SEmptyShared, body.Loc));
    assert.ok(replaced.Data instanceof js_ast.SBlock, `${input} replaced kind`);
    const replacedBlock = replaced.Data as js_ast.SBlock;
    assert.equal(replacedBlock.Stmts.length, replacedLen, `${input} replaced len`);
    assert.equal(replacedBlock.Stmts[0].Data, js_ast.SEmptyShared, `${input} replaced[0]`);
  }

  // "{ a; let x; }" 无 replace 时首个语句被裁掉，剩下的是 let（Go: block(len=1)）
  const localBody = parseFirst("{ a; let x; }");
  const droppedLocal = dropFirstStatement(cloneBlock(localBody), null);
  assert.ok(droppedLocal.Data instanceof js_ast.SBlock);
  assert.equal((droppedLocal.Data as js_ast.SBlock).Stmts.length, 1);
  assert.ok((droppedLocal.Data as js_ast.SBlock).Stmts[0].Data instanceof js_ast.SLocal);

  // 非块体：两个分支都直接返回（Go: dropped=SEmpty replaced=SEmpty）
  const exprBody = parseFirst("a;");
  assert.ok(dropFirstStatement(exprBody, null).Data instanceof js_ast.SEmpty);
  assert.ok(dropFirstStatement(exprBody, new js_ast.Stmt(js_ast.SEmptyShared, exprBody.Loc)).Data instanceof js_ast.SEmpty);
});

// ---------------------------------------------------------------------------
// 第 24 轮：D 批 3 个（willNeedBindingPattern / parseExprOrBindings / parseFnBody）
// + F-s1a（visitBinding + visitAndAppendStmt 的 SLocal 分支）
//
// 期望值来源：
//   ① willNeedBindingPattern / parseFnBody 的数值 → Go 包内临时探针 TestTmpD24（已删）：
//      cd /root/esbuild && go test ./internal/js_parser -run TestTmpD24 -count=1 -v
//      willNeedBindingPattern("= b", allowIn=true) = true
//      willNeedBindingPattern("in b", allowIn=true) = false / (allowIn=false) = true
//      willNeedBindingPattern("of b", allowIn=false) = true / (allowIn=true) = false
//      willNeedBindingPattern("x b", allowIn=false) = false
//      parseFnBody: loc=3 stmts=2 firstKind=*js_ast.SDirective lastKind=*js_ast.SLocal closeBrace=30
//   ② SLocal 语料的输出字节 → `tools/go/tmpgenparseprint`（M1 常驻差分通道）：
//      cd /root/esbuild && go run ./tmpgenparseprint < <manifest 指向下面三个文件> > out.json
//      三个输入的 sourceSha256 已钉在下面的表里，输出字符串就是 Go 的 outBase64 解码结果。
// ---------------------------------------------------------------------------

test("willNeedBindingPattern 与 Go 实测一致（token × allowIn）", () => {
  const cases: [string, boolean, boolean][] = [
    ["= b", true, true],
    ["in b", true, false],
    ["in b", false, true],
    ["of b", false, true],
    ["of b", true, false],
    ["x b", false, false],
  ];
  for (const [contents, allowIn, want] of cases) {
    const p = makeParser(contents);
    p.allowIn = allowIn;
    assert.equal(p.willNeedBindingPattern(), want, `${contents} allowIn=${allowIn}`);
  }
});

test("parseFnBody 与 Go 实测一致（loc / 语句数 / 首尾种类 / closeBrace）", () => {
  const contents = `   { "use strict"; let x = 1; }`;
  const p = makeParser(contents);
  // Go 的 pushScopeForParsePass 要求 FunctionBody 的父是 FunctionArgs
  p.pushScopeForParsePass(js_ast.ScopeKind.ScopeFunctionArgs, new Loc(1));
  const body = p.parseFnBody(new fnOrArrowDataParse());
  assert.equal(body.Loc.Start, 3);
  assert.equal(body.Block.Stmts.length, 2);
  assert.ok(body.Block.Stmts[0].Data instanceof js_ast.SDirective);
  assert.ok(body.Block.Stmts[1].Data instanceof js_ast.SLocal);
  assert.equal(body.Block.CloseBraceLoc.Start, 30);
  // parseFnBody 的 defer popScope() 把作用域退回参数作用域
  assert.equal(p.currentScope!.Kind, js_ast.ScopeKind.ScopeFunctionArgs);
  assert.equal(p.allowIn, true);
});

test("SLocal 语料：TS parse+print 与 Go 字节逐字节相等（tmpgenparseprint）", () => {
  // sourceSha256 是语料文件本身的哈希（钉死）；want 是 Go 的 outBase64 解码结果
  const cases: [string, string, string][] = [
    [
      "1.js",
      "eb5ff2e30e6926770559c61466b492f088c5cd407bf4c830153e02815dc63e04",
      "let a = 1, b;\nconst c = 2;\nvar d = null;\n",
    ],
    [
      "2.js",
      "a1c0d0b75a589147bed89ccc65cfe14deee31106bb33970c0b18634283481072",
      '{\n  let e = "x";\n}\nfunction f(p = 1) {\n  var q = p;\n}\n',
    ],
    [
      "3.js",
      "2d7eb868b55c85371b9a2c44878f5abae7c4c828e0224f5c67ea1256fcb56ed4",
      "let { a, b: [c = 1] } = obj;\nlet comp = a + c;\n",
    ],
    [
      "4.js",
      "85bf008f074df286c92459194494dce8d8dc36c9617a5593ed111bf36da32c03",
      "function f() {\n  let a = 1, b;\n  {\n    const c = 2;\n  }\n  if (a) {\n    var d = null;\n  }\n  for (let i = 0; i < 1; i++) {\n    let e = i;\n  }\n  return b;\n}\nf();\n",
    ],
  ];

  for (const [name, sourceSha, want] of cases) {
    const bytes = new Uint8Array(readFileSync(new URL(`../../../testdata/js_parser/slocal-corpus/${name}`, import.meta.url)));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), sourceSha, `${name} 语料哈希`);

    const source = makeSource(new TextDecoder().decode(bytes));
    const parsed = Parse(silentLog(), source, new Options());
    assert.equal(parsed.ok, true, name);

    const symbols = parsed.ast.Symbols;
    const renamer = {
      NameForSymbol(ref: { InnerIndex: number }): string {
        return symbols[ref.InnerIndex].OriginalName;
      },
    };
    const printOptions = new PrintOptions();
    printOptions.OutputFormat = PrintFormat.FormatESModule;
    const out = new TextDecoder().decode(Print(parsed.ast, symbols, renamer, printOptions).JS);
    assert.equal(out, want, `${name} 输出字节`);
  }
});

test("E-s1b：EThis / EImportMeta 与 Go 字节一致，valueForThis / valueForImportMeta 直接执行", () => {
  const bytes = new Uint8Array(
    readFileSync(new URL("../../../testdata/js_parser/es1b-corpus/this-import-meta.js", import.meta.url)),
  );
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "308addbf5945bf19befe4049128225c289c7ffe04461a6830d073496802239e2",
  );

  // Go 实测（tmpgenparseprint，mode=js）：import.meta 让文件算 ESM 导出 →
  // 顶层 "this;" 被 valueForThis 换成 undefined，再被 SExpr 的 trim 删掉
  const parsed = Parse(silentLog(), makeSource(new TextDecoder().decode(bytes)), new Options());
  assert.equal(parsed.ok, true);
  const symbols = parsed.ast.Symbols;
  const printOptions = new PrintOptions();
  printOptions.OutputFormat = PrintFormat.FormatESModule;
  const out = new TextDecoder().decode(Print(parsed.ast, symbols, {
    NameForSymbol(ref: { InnerIndex: number }) { return symbols[ref.InnerIndex].OriginalName; },
  }, printOptions).JS);
  assert.equal(out, "import.meta;\nfunction f() {\n  return this;\n}\n");

  // valueForThis：顶层 → EUndefined；函数内（nested）→ null
  const p = makeParser("this;");
  p.isFileConsideredToHaveESMExports = true;
  const topValue = p.valueForThis(new Loc(0), true, 0, false, false);
  assert.ok(topValue !== null && topValue.Data instanceof js_ast.EUndefined);
  p.isThisNested = true;
  assert.equal(p.valueForThis(new Loc(0), true, 0, false, false), null);

  // valueForImportMeta：M1 默认（mode=PassThrough）不替换；unsupported 时生成并复用 import_meta 符号
  const p2 = makeParser("import.meta;");
  assert.equal(p2.valueForImportMeta(new Loc(0)), null);
  p2.options = new Options();
  p2.options.unsupportedJSFeatures = JSFeature.ImportMeta;
  const first = p2.valueForImportMeta(new Loc(0));
  const second = p2.valueForImportMeta(new Loc(8));
  assert.ok(first !== null && first.Data instanceof js_ast.EIdentifier);
  assert.ok(second !== null && second.Data instanceof js_ast.EIdentifier);
  const firstRef = (first.Data as js_ast.EIdentifier).Ref;
  const secondRef = (second.Data as js_ast.EIdentifier).Ref;
  assert.equal(firstRef.InnerIndex, secondRef.InnerIndex);
  assert.ok(p2.moduleScope!.Generated.some((ref) => ref.InnerIndex === firstRef.InnerIndex));
});

test("visit pass 递归：函数体/块/if/for 里的 SLocal 分支真的被执行（F-s1b）", () => {
  // 4.js 的 Go 字节断言已在上面；这里用 prototype 计数证明「只有顶层」不成立：
  // visitBinding 只在 visit pass 调用，6 个绑定分布在 FunctionBody / Block 作用域里。
  const contents = new TextDecoder().decode(
    new Uint8Array(readFileSync(new URL("../../../testdata/js_parser/slocal-corpus/4.js", import.meta.url))),
  );
  const kinds: number[] = [];
  const orig = ParserClass.prototype.visitBinding;
  ParserClass.prototype.visitBinding = function (this: ParserClass, binding: js_ast.Binding, opts: bindingOpts) {
    if (this.currentScope !== null) kinds.push(this.currentScope.Kind);
    return orig.call(this, binding, opts);
  };
  try {
    const { ok } = Parse(silentLog(), makeSource(contents), new Options());
    assert.equal(ok, true);
  } finally {
    ParserClass.prototype.visitBinding = orig;
  }

  assert.equal(kinds.length, 6);
  assert.ok(kinds.includes(js_ast.ScopeKind.ScopeFunctionBody), `kinds=${JSON.stringify(kinds)}`);
  assert.ok(kinds.filter((k) => k === js_ast.ScopeKind.ScopeBlock).length >= 4, `kinds=${JSON.stringify(kinds)}`);
});

test("visitBinding / visitAndAppendStmt：SLocal 分支真实执行", () => {
  const p = makeParser("   let a = 1, b;");
  const binding = new js_ast.Binding();
  const id = new js_ast.BIdentifier();
  binding.Data = id;
  binding.Loc = new Loc(1);
  id.Ref = p.newSymbol(SymbolKind.SymbolHoisted, "x");

  // 不开 duplicateArgCheck 时只走 BIdentifier 的基线路径
  const opts = new bindingOpts();
  p.visitBinding(binding, opts);
  assert.equal(opts.duplicateArgCheck, null);

  // 开了之后：第一次记录范围，第二次报 Go 原文案
  const msgs: string[] = [];
  const log = silentLog();
  log.AddMsg = (msg) => { msgs.push(msg.Data.Text); };
  const p2 = makeParser("   function f(a, a) {}", new Options(), log);
  const dup = new bindingOpts();
  dup.duplicateArgCheck = new Map();
  const arg = new js_ast.Binding();
  const argId = new js_ast.BIdentifier();
  arg.Data = argId;
  arg.Loc = new Loc(14);
  argId.Ref = p2.newSymbol(SymbolKind.SymbolHoisted, "a");
  p2.visitBinding(arg, dup);
  p2.visitBinding(arg, dup);
  assert.deepEqual(msgs, ['"a" cannot be bound multiple times in the same parameter list']);

  // visitAndAppendStmt 的 SLocal 分支：visitBinding + 初始化器 visitExpr + selectLocalKind
  const p3 = makeParser("   let v = 1;");
  const local = new js_ast.SLocal();
  local.Kind = js_ast.LocalKind.LocalLet;
  const decl = new js_ast.Decl();
  decl.Binding = new js_ast.Binding();
  const declId = new js_ast.BIdentifier();
  declId.Ref = p3.newSymbol(SymbolKind.SymbolHoisted, "v");
  decl.Binding.Data = declId;
  decl.ValueOrNil = new js_ast.Expr(new js_ast.ENumber(1), new Loc(11));
  local.Decls = [decl];

  p3.currentScope = p3.moduleScope;
  const out: js_ast.Stmt[] = [];
  p3.visitAndAppendStmt(out, new js_ast.Stmt(local, new Loc(3)));
  assert.equal(out.length, 1);
  const visited = out[0].Data as js_ast.SLocal;
  assert.ok(visited instanceof js_ast.SLocal);
  assert.equal(visited.Kind, js_ast.LocalKind.LocalLet);
  assert.equal(visited.Decls.length, 1);
  assert.equal(p3.nameToKeep, "v");

  // 非 SLocal 的种类原样追加（passthrough）
  const p4 = makeParser("   a;");
  const passthrough: js_ast.Stmt[] = [];
  const exprStmt = new js_ast.Stmt(initExprStmt(), new Loc(3));
  p4.visitAndAppendStmt(passthrough, exprStmt);
  assert.equal(passthrough.length, 1);
  assert.equal(passthrough[0], exprStmt);
});

function initExprStmt(): js_ast.SExpr {
  const s = new js_ast.SExpr();
  s.Value = new js_ast.Expr(new js_ast.ENumber(1), new Loc(3));
  return s;
}

// deferredErrors.mergeInto（Go: js_parser.go:1953）与 isValidAssignmentTarget（Go: js_parser.go:13377）：
// 两者在 M1 的 visit 分支里只在特定入参下才会被调到，这里直接给入参跑一遍。
test("deferredErrors.mergeInto 与 isValidAssignmentTarget 直接执行", () => {
  const from = new deferredErrors();
  const to = new deferredErrors();

  // from 空 → to 不变；from 有值 → 覆盖；invalidParens 两边都有 → 拼接
  from.mergeInto(to);
  assert.equal(to.invalidExprDefaultValue.Len, 0);
  assert.deepEqual(to.invalidParens, []);

  from.invalidExprDefaultValue = new Range(new Loc(3), 2);
  to.invalidExprAfterQuestion = new Range(new Loc(9), 1);
  from.invalidParens = [new Range(new Loc(12), 1)];
  from.arraySpreadFeature = new Range(new Loc(14), 1);
  from.mergeInto(to);
  assert.equal(to.invalidExprDefaultValue.Len, 2);
  assert.equal(to.invalidExprAfterQuestion.Len, 1); // 保留 to 原值
  assert.equal(to.arraySpreadFeature.Len, 1);
  assert.equal(to.invalidParens.length, 1);

  const from2 = new deferredErrors();
  from2.invalidParens = [new Range(new Loc(20), 1)];
  from2.mergeInto(to);
  assert.equal(to.invalidParens.length, 2);
  assert.equal(to.invalidParens[1].Loc.Start, 20);

  const p = makeParser("   a.b[c];");
  const ast = Parse(silentLog(), makeSource("   a; a.b; a[b]; 1;"), new Options()).ast;
  const exprs = ast.Parts.flatMap((part) => part.Stmts).map((stmt) => (stmt.Data as js_ast.SExpr).Value);
  assert.equal(p.isValidAssignmentTarget(exprs[0]), true); // EIdentifier
  assert.equal(p.isValidAssignmentTarget(exprs[1]), true); // EDot
  assert.equal(p.isValidAssignmentTarget(exprs[2]), true); // EIndex
  assert.equal(p.isValidAssignmentTarget(exprs[3]), false); // ENumber
  // EObject / EArray：只看 IsParenthesized（Go 不递归检查）
  assert.equal(p.isValidAssignmentTarget(new js_ast.Expr(new js_ast.EObject(), new Loc(0))), true);
  assert.equal(p.isValidAssignmentTarget(new js_ast.Expr(new js_ast.EArray(), new Loc(0))), true);
  const parenthesized = new js_ast.EArray();
  parenthesized.IsParenthesized = true;
  assert.equal(p.isValidAssignmentTarget(new js_ast.Expr(parenthesized, new Loc(0))), false);
});

test("F-s2：import/export 全形态与 Go 字节逐字节相等（tmpgenparseprint, mode=js）", () => {
  const cases: [string, string, string][] = [
    [
      "all-forms.js",
      "eebdc702d5f1c9b4596c65a0e610f6d1b76029949d329259593d86952385e13e",
      'import a, { b as c, d } from "p1";\nimport * as ns from "p2";\nimport "p3";\nlet x = 0, w = 0;\nfunction y() {\n}\nexport { x, y as z };\nexport { w } from "p4";\nexport * from "p5";\nexport * as ns2 from "p6";\nexport default function f() {\n}\nexport function g() {\n}\nexport class K {\n}\nexport let q = 1;\n',
    ],
    [
      "order-sensitive.js",
      "63d4c3534095ab0f569e51251e4be46b3786a409c46b49d98f55a3c184216401",
      "export { x };\nlet x = 1;\nexport { y as def };\nvar y = 2;\n",
    ],
  ];

  for (const [name, sourceSha, want] of cases) {
    const bytes = new Uint8Array(
      readFileSync(new URL(`../../../testdata/js_parser/export-corpus/${name}`, import.meta.url)),
    );
    assert.equal(createHash("sha256").update(bytes).digest("hex"), sourceSha, `${name} 语料哈希`);

    const parsed = Parse(silentLog(), makeSource(new TextDecoder().decode(bytes)), new Options());
    assert.equal(parsed.ok, true, name);

    const symbols = parsed.ast.Symbols;
    const printOptions = new PrintOptions();
    printOptions.OutputFormat = PrintFormat.FormatESModule;
    const out = new TextDecoder().decode(Print(parsed.ast, symbols, {
      NameForSymbol(ref: { InnerIndex: number }) { return symbols[ref.InnerIndex].OriginalName; },
    }, printOptions).JS);
    assert.equal(out, want, `${name} 输出字节`);
  }
});

test("F-s2：appendPart / scanForImportsAndExports / recordExport 真实执行（part 边界与 ImportRecordIndices）", () => {
  // Go 实测（JSX automatic runtime，`<div/>`）：生成的 import 是**独立 part**，
  // 且该 part 会被 scanForImportsAndExports 再扫一遍（所以 indices 是 [0 0]，与 Go 一致）；
  // 本体语句在另一个 part，indices 为空。旧写法（toAST 里 `importRecords.map`）只会有 1 个 part 且 indices=[0]。
  const opts = new Options();
  opts.jsx.AutomaticRuntime = true;
  const jsx = Parse(silentLog(), makeSource("<div/>"), opts);
  assert.equal(jsx.ok, true);
  assert.equal(jsx.ast.ImportRecords.length, 1);
  assert.equal(jsx.ast.Parts.length, 2);
  assert.deepEqual(jsx.ast.Parts[0].ImportRecordIndices, [0, 0]);
  assert.deepEqual(jsx.ast.Parts[1].ImportRecordIndices, []);
  assert.ok(jsx.ast.Parts[0].Stmts[0].Data instanceof js_ast.SImport);
  assert.equal(jsx.ast.Parts[0].DeclaredSymbols.length, 2);

  // visit 期 SImport 的三类符号都进 declaredSymbols
  const dyn = Parse(silentLog(), makeSource('import a, { b as c } from "a";'), new Options());
  const names = dyn.ast.Parts[0].DeclaredSymbols.map((d) => dyn.ast.Symbols[d.Ref.InnerIndex].OriginalName);
  assert.ok(names.includes("a"), JSON.stringify(names));
  assert.ok(names.includes("c"), JSON.stringify(names));
  assert.ok(names.includes("import_a"), JSON.stringify(names));
  assert.deepEqual(dyn.ast.Parts[0].ImportRecordIndices, [0]);

  // namedExports / namedImports / exportStarImportRecords
  const ex = Parse(
    silentLog(),
    makeSource('export { x }; let x = 1; export * from "p"; export * as n from "q"; export { w } from "r";'),
    new Options(),
  );
  assert.equal(ex.ok, true);
  assert.deepEqual([...ex.ast.NamedExports.keys()].sort(), ["n", "w", "x"]);
  assert.deepEqual(ex.ast.ExportStarImportRecords, [0]);
  const named = [...ex.ast.NamedImports.values()];
  assert.equal(named.length, 2);
  assert.ok(named.some((n) => n.AliasIsStar && n.IsExported), JSON.stringify(named));
  assert.ok(named.some((n) => n.Alias === "w" && n.IsExported && !n.AliasIsStar), JSON.stringify(named));

  // "export {x}; let x" —— 顺序敏感：x 必须解析到 let x 的符号，而不是 unbound
  const clause = ex.ast.Parts[0].Stmts[0].Data as js_ast.SExportClause;
  assert.equal(clause.Items.length, 1);
  const ref = clause.Items[0].Name.Ref;
  assert.equal(ex.ast.Symbols[ref.InnerIndex].OriginalName, "x");
  assert.notEqual(ex.ast.Symbols[ref.InnerIndex].Kind, SymbolKind.SymbolUnbound);
});

test("F-s2：recordExport 的重复导出诊断与 SExportClause 的 unbound 剥离（Go 文案）", () => {
  const msgs: string[] = [];
  const log = new Log();
  log.AddMsg = (msg) => { msgs.push(msg.Data.Text); };
  const dup = Parse(log, makeSource("let x = 1; export { x }; export { x };"), new Options());
  assert.equal(dup.ok, true);
  assert.ok(msgs.some((t) => t.includes('Multiple exports with the same name "x"')), JSON.stringify(msgs));

  const msgs2: string[] = [];
  const log2 = new Log();
  log2.AddMsg = (msg) => { msgs2.push(msg.Data.Text); };
  const unbound = Parse(log2, makeSource("export { nope };"), new Options());
  assert.ok(msgs2.some((t) => t.includes('"nope" is not declared in this file')), JSON.stringify(msgs2));
  const clause = unbound.ast.Parts[0].Stmts[0].Data as js_ast.SExportClause;
  assert.equal(clause.Items.length, 0);
});

test("F-s2：scanForUnusedTSImportEquals 的定点删除（Go js_parser.go:17313）", () => {
  const p = makeParser("");

  // 构造 `import a = foo.a`：WasTSImportEquals + a 的使用计数为 0
  const a = p.newSymbol(SymbolKind.SymbolImport, "a");
  const foo = p.newSymbol(SymbolKind.SymbolUnbound, "foo");
  const dot = new js_ast.EDot();
  dot.Target = new js_ast.Expr(new js_ast.EIdentifier(foo), new Loc(8));
  dot.Name = "a";
  const decl = new js_ast.Decl();
  decl.Binding = new js_ast.Binding();
  decl.Binding.Loc = new Loc(0);
  decl.Binding.Data = new js_ast.BIdentifier(a);
  decl.ValueOrNil = new js_ast.Expr(dot, new Loc(8));
  const s = new js_ast.SLocal();
  s.Decls = [decl];
  s.WasTSImportEquals = true;
  const stmt = new js_ast.Stmt(s, new Loc(0));

  const removed = p.scanForUnusedTSImportEquals([stmt]);
  assert.equal(removed.stmts.length, 0);
  assert.equal(removed.removedImportEquals, true);
  // ignoreUsage 把被引用的标识符使用计数回滚（真实路径里 findSymbol 已 recordUsage 过一次）
  p.symbols[foo.InnerIndex].UseCountEstimate = 1;
  p.symbols[a.InnerIndex].UseCountEstimate = 0;
  const removed2 = p.scanForUnusedTSImportEquals([stmt]);
  assert.equal(removed2.stmts.length, 0);
  assert.equal(p.symbols[foo.InnerIndex].UseCountEstimate, 0);

  // 使用过的 import-equals 保留
  p.symbols[a.InnerIndex].UseCountEstimate = 1;
  const kept = p.scanForUnusedTSImportEquals([stmt]);
  assert.equal(kept.stmts.length, 1);
  assert.equal(kept.keptImportEquals, true);
  assert.equal(kept.removedImportEquals, false);
});

test("F-s1c：visitClass 全量（static block / private / decorator / computed key）与 Go 字节一致", () => {
  const bytes = new Uint8Array(
    readFileSync(new URL("../../../testdata/js_parser/class-corpus/class-features.js", import.meta.url)),
  );
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "8739dc2736b78c67ad8a2fcf2a8c9f061eb49e0173eefbed726bd129aea07aca",
  );

  const parsed = Parse(silentLog(), makeSource(new TextDecoder().decode(bytes)), new Options());
  assert.equal(parsed.ok, true);
  const symbols = parsed.ast.Symbols;
  const printOptions = new PrintOptions();
  printOptions.OutputFormat = PrintFormat.FormatESModule;
  const out = new TextDecoder().decode(Print(parsed.ast, symbols, {
    NameForSymbol(ref: { InnerIndex: number }) { return symbols[ref.InnerIndex].OriginalName; },
  }, printOptions).JS);
  assert.equal(
    out,
    "class A {\n  static #p = 1;\n  #q = 2;\n  static {\n    this.x = A.#p;\n  }\n  [key] = 3;\n  get #g() {\n    return this.#q;\n  }\n  #m() {\n    return 1;\n  }\n  static #sm() {\n    return 2;\n  }\n  @dec method() {\n  }\n  static s = this;\n}\nclass B extends A {\n  constructor() {\n    super();\n  }\n  #x;\n}\nexport default class {\n  static y = this;\n}\n",
  );
});

test("F-s1c：computeClassLoweringInfo / privateSymbolNeedsToBeLowered 真实执行", () => {
  const p = makeParser("");
  const cls = new js_ast.Class();
  const field = new js_ast.Property();
  field.Kind = js_ast.PropertyKind.PropertyField;
  field.Key = new js_ast.Expr(new js_ast.EString(), new Loc(0));
  cls.Properties.push(field);

  // esnext：不支持特性集为空 → 全部不降级
  let info = computeClassLoweringInfo(p, cls);
  assert.equal(info.lowerAllInstanceFields, false);
  assert.equal(info.lowerAllStaticFields, false);
  assert.equal(info.shimSuperCtorCalls, false);

  // ClassField（Go 探针实测 128）→ 实例字段降级
  p.options.unsupportedJSFeatures = JSFeature.ClassField;
  info = computeClassLoweringInfo(p, cls);
  assert.equal(info.lowerAllInstanceFields, true);
  assert.equal(info.lowerAllStaticFields, false);

  // static block + ClassStaticBlocks（32768）→ lowerAllStaticFields
  p.options.unsupportedJSFeatures = JSFeature.ClassStaticBlocks;
  field.Kind = js_ast.PropertyKind.PropertyClassStaticBlock;
  info = computeClassLoweringInfo(p, cls);
  assert.equal(info.lowerAllStaticFields, true);

  // privateSymbolNeedsToBeLowered 只认 PrivateSymbolMustBeLowered（SymbolFeature 属 M3）
  p.options.unsupportedJSFeatures = 0n;
  const priv = new js_ast.EPrivateIdentifier(p.newSymbol(SymbolKind.SymbolPrivateField, "#x"));
  assert.equal(privateSymbolNeedsToBeLowered(p, priv), false);
  p.symbols[priv.Ref.InnerIndex].Flags |= SymbolFlags.PrivateSymbolMustBeLowered;
  assert.equal(privateSymbolNeedsToBeLowered(p, priv), true);
});

interface PredRow {
  src: string;
  index: number;
  token: number;
  isIdent: boolean;
  isBinary: boolean;
  isStart: boolean;
  isStartLHS: boolean;
  canFollow: boolean;
  isArrowJSX: boolean;
  lookahead: boolean;
}

test("K-1：TS 语法的独立判据与 Go 实测逐项一致（tmpgenpred）", () => {
  const bytes = new Uint8Array(
    readFileSync(new URL("../../../testdata/js_parser/ts-predicates.json", import.meta.url)),
  );
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "f7ea0ae28502945cb3ee25ed413908d4cdca62872f57438fd7cb14c3800a7165",
  );

  const rows: PredRow[] = JSON.parse(new TextDecoder().decode(bytes));
  let i = 0;
  while (i < rows.length) {
    const src = rows[i].src;
    const p = makeParser(src);
    for (let index = 0; i < rows.length && rows[i].src === src; i++, index++) {
      const row = rows[i];
      const at = `${JSON.stringify(src)}@${index}`;
      assert.equal(index, row.index, `${at} index`);
      assert.equal(p.lexer.Token as number, row.token, `${at} token`);
      assert.equal(tsIsIdentifier(p), row.isIdent, `${at} tsIsIdentifier`);
      assert.equal(tsIsBinaryOperator(p), row.isBinary, `${at} tsIsBinaryOperator`);
      assert.equal(tsIsStartOfExpression(p), row.isStart, `${at} tsIsStartOfExpression`);
      assert.equal(tsIsStartOfLeftHandSideExpression(p), row.isStartLHS, `${at} tsIsStartOfLeftHandSideExpression`);
      assert.equal(tsCanFollowTypeArgumentsInExpression(p), row.canFollow, `${at} tsCanFollowTypeArgumentsInExpression`);
      assert.equal(isTSArrowFnJSX(p), row.isArrowJSX, `${at} isTSArrowFnJSX`);
      assert.equal(
        tsLookAheadNextTokenIsOpenParenOrLessThanOrDot(p),
        row.lookahead,
        `${at} tsLookAheadNextTokenIsOpenParenOrLessThanOrDot`,
      );
      if ((p.lexer.Token as number) !== T.TEndOfFile) p.lexer.Next();
    }
  }

  // skipTypeFlags.has（Go: ts_parser.go:177）
  assert.equal(has(isReturnTypeFlag, isReturnTypeFlag), true);
  assert.equal(has(0, isReturnTypeFlag), false);
  assert.equal(has(disallowConditionalTypesFlag, isReturnTypeFlag), false);
});

test("G-1：duplicateCaseHash / duplicateCaseEquals 直接执行（Go js_parser.go:925 / :979）", () => {
  const p0 = makeParser("");
  const str = (s: string) =>
    new js_ast.Expr(new js_ast.EString(new Uint16Array([...s].map((c) => c.charCodeAt(0)))), new Loc(0));
  const num = (n: number) => new js_ast.Expr(new js_ast.ENumber(n), new Loc(0));
  const id = (name: string) =>
    new js_ast.Expr(new js_ast.EIdentifier(p0.newSymbol(SymbolKind.SymbolUnbound, name)), new Loc(0));
  const dot = (target: js_ast.Expr, name: string) => {
    const e = new js_ast.EDot();
    e.Target = target;
    e.Name = name;
    return new js_ast.Expr(e, new Loc(0));
  };

  // 同值 → equals=true；不同值 → false
  assert.deepEqual(duplicateCaseEquals(str("a"), str("a")), [true, false]);
  assert.deepEqual(duplicateCaseEquals(str("a"), str("b")), [false, false]);
  assert.deepEqual(duplicateCaseEquals(num(1), num(1)), [true, false]);
  assert.deepEqual(duplicateCaseEquals(num(1), num(2)), [false, false]);
  assert.deepEqual(duplicateCaseEquals(num(0), str("0")), [false, false]);

  // EDot / EIndex 的 couldBeIncorrect = true（Go 注释：可能有副作用的对象比较）
  const foo = id("foo");
  assert.deepEqual(duplicateCaseEquals(dot(foo, "bar"), dot(foo, "bar")), [true, true]);
  assert.deepEqual(duplicateCaseEquals(dot(foo, "bar"), dot(foo, "baz")), [false, false]);

  // hash：可哈希的类型 ok=true，不可哈希的（ECall 等）ok=false
  for (const e of [str("a"), num(1), id("x"), dot(id("foo"), "bar")]) {
    const [h, ok] = duplicateCaseHash(e);
    assert.equal(ok, true, JSON.stringify(e.Data));
    assert.equal(typeof h, "number");
  }
  assert.equal(duplicateCaseHash(new js_ast.Expr(new js_ast.ECall(), new Loc(0)))[1], false);

  // 相同的表达式必须同 hash
  assert.equal(duplicateCaseHash(str("a"))[0], duplicateCaseHash(str("a"))[0]);
  assert.equal(duplicateCaseHash(num(1))[0], duplicateCaseHash(num(1))[0]);
  assert.notEqual(duplicateCaseHash(str("a"))[0], duplicateCaseHash(num(1))[0]);
});

// ---------------------------------------------------------------------------
// 第 28 次推进：B 批（解析期诊断 / defines / mangled props）—— 11 个整函数的直接执行证据
//
// 期望值来源（强弱分开写）：
//   - 空值合并 / await / yield / 无效绑定 / define 赋值 / 不可表示标识符：真实 Go 二进制
//     `/tmp/esbuild-go`（0.28.2，commit f6058f83）实测，命令与原文见各用例注释；
//   - assert 关键字警告 / JSON 导入断言 notes：Go 同名函数的逐字文案
//     （`js_parser.go:6744` / `js_parser.go:2117`，`PrettyPrintTargetEnvironment` 见 `config.go:852`）。
// ---------------------------------------------------------------------------

test("B-28：空值合并优先级的两个方向与 Go 实测一致", () => {
  // printf 'a ?? b || c' | esbuild --loader=js
  //   ✘ [ERROR] Cannot use "||" with "??" without parentheses
  // printf 'a || b ?? c' | esbuild --loader=js
  //   ✘ [ERROR] Cannot use "??" with "||" without parentheses
  const cases = [
    { src: "a ?? b", advance: false, op: "||", want: 'Cannot use "||" with "??" without parentheses' },
    { src: "a ?? b", advance: true, op: "||", want: 'Cannot use "??" with "||" without parentheses' },
  ];
  for (const c of cases) {
    const msgs: { text: string; notes: string[] }[] = [];
    const log = silentLog();
    log.AddMsg = (m) => msgs.push({ text: m.Data.Text, notes: m.Notes.map((n) => n.Text) });
    const p = makeParser(c.src, new Options(), log);
    if (c.advance) p.lexer.Next(); // 让 lexer.Token 停在 "??"，走 Go 的交换分支
    p.logNullishCoalescingErrorPrecedenceError(c.op);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].text, c.want);
    assert.ok(msgs[0].notes[0].startsWith("Expressions of the form"), msgs[0].notes[0]);
  }
});

test("B-28：箭头参数与无效绑定的三条诊断（Go 实测）", () => {
  // printf 'async function f() { (x = await y) => 0 }' | esbuild --loader=js
  //   ✘ [ERROR] Cannot use an "await" expression here:
  // printf 'function* f() { (x = yield y) => 0 }' | esbuild --loader=js
  //   ✘ [ERROR] Cannot use a "yield" expression here:
  // printf '(a + b) => 0' | esbuild --loader=js
  //   ✘ [ERROR] Invalid binding pattern
  const msgs: string[] = [];
  const log = silentLog();
  log.AddMsg = (m) => msgs.push(m.Data.Text);
  // 注意：期望文案来自 Go；这里的 source 必须有足够字节承载 Range（越界 Range 会让 tracker 的
  // 行号计算走到 pre-existing 的死循环，与本批函数无关）。
  const p = makeParser("await yield ()", new Options(), log);
  const arrowErrors = new deferredArrowArgErrors();
  arrowErrors.invalidExprAwait = new Range(new Loc(0), 5);
  arrowErrors.invalidExprYield = new Range(new Loc(6), 5);
  p.logArrowArgErrors(arrowErrors);

  const errors = new deferredErrors();
  errors.invalidParens = [new Range(new Loc(0), 1)];
  p.logDeferredArrowArgErrors(errors);

  assert.deepEqual(msgs, [
    'Cannot use an "await" expression here:',
    'Cannot use a "yield" expression here:',
    "Invalid binding pattern",
  ]);
});

test("B-28：defined 常量赋值警告（含复合表达式的拼接顺序）与 Go 实测一致", () => {
  // printf 'x = 2; console.log(x)' | esbuild --loader=js --define:x=1
  //   ▲ [WARNING] Suspicious assignment to defined constant "x" [assign-to-define]
  const msgs: { kind: number; id: number; text: string; notes: string[] }[] = [];
  const log = silentLog();
  log.AddMsg = (m) => msgs.push({ kind: m.Kind, id: m.ID, text: m.Data.Text, notes: m.Notes.map((n) => n.Text) });
  const p = makeParser("", new Options(), log);

  // Go: EIdentifier 的 Ref 是 name ref（parse 期 storeNameInRef 产生），不是符号 ref
  const nameRef = (name: string) => p.storeNameInRef(new MaybeSubstring(new TextEncoder().encode(name), 0));
  const id = (name: string) => new js_ast.Expr(new js_ast.EIdentifier(nameRef(name)), new Loc(0));
  p.logAssignToDefine(new Range(new Loc(0), 1), "x", id("x"));

  const dot = new js_ast.EDot();
  dot.Target = id("a");
  dot.Name = "b";
  p.logAssignToDefine(new Range(new Loc(0), 1), "ignored", new js_ast.Expr(dot, new Loc(0)));

  const index = new js_ast.EIndex();
  index.Target = id("a");
  index.Index = new js_ast.Expr(new js_ast.EString(new Uint16Array(["b"].map((c) => c.charCodeAt(0)))), new Loc(0));
  p.logAssignToDefine(new Range(new Loc(0), 1), "ignored", new js_ast.Expr(index, new Loc(0)));

  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].kind, MsgKind.Warning);
  assert.equal(msgs[0].text, 'Suspicious assignment to defined constant "x"');
  assert.ok(msgs[0].notes[0].startsWith('The expression "x" has been configured to be replaced with a constant'));
  // Go: EDot → "a.b"；EIndex(EString) → "a['b']"（QuoteSingle 是单引号，parts 逆序后 join）
  assert.equal(msgs[1].text, 'Suspicious assignment to defined constant "a.b"');
  assert.equal(msgs[2].text, `Suspicious assignment to defined constant "a['b']"`);
});

test("B-28：不可表示标识符（es5 + charset=ascii）与 Go 实测一致", () => {
  // printf 'let 𠮷 = 1; console.log(𠮷)' | esbuild --loader=js --target=es5 --charset=ascii
  //   ✘ [ERROR] "𠮷" cannot be escaped in the configured target environment ("es5") but you can set the charset to "utf8" ...
  const msgs: string[] = [];
  const log = silentLog();
  log.AddMsg = (m) => msgs.push(m.Data.Text);
  const options = new Options();
  options.asciiOnly = true;
  options.originalTargetEnv = '"es5"'; // Go: StringArrayToQuotedCommaSeparatedString（带引号）
  options.unsupportedJSFeatures = JSFeature.UnicodeEscapes;
  const p = makeParser("", options, log);
  p.checkForUnrepresentableIdentifier(new Loc(0), "𠮷");
  p.checkForUnrepresentableIdentifier(new Loc(0), "𠮷"); // 同一个名字只报一次
  assert.deepEqual(msgs, [
    '"𠮷" cannot be escaped in the configured target environment ("es5") but you can set the charset to "utf8" to allow unescaped Unicode characters',
  ]);
});

test("C-28：mangled props 四个函数（isMangledProp / symbolForMangledProp / dotOrMangledPropParse / dotOrMangledPropVisit）", () => {
  const options = new Options();
  options.mangleProps = /^_/;
  const p = makeParser("", options);

  assert.equal(p.isMangledProp("_foo"), true);
  assert.equal(p.isMangledProp("__proto__"), false); // Go: permanentReservedProps
  assert.equal(p.isMangledProp("bar"), false);

  options.reserveProps = /^_keep$/;
  assert.equal(p.isMangledProp("_keep"), false);
  assert.equal(p.reservedProps?.get("_keep"), true);

  const a = p.symbolForMangledProp("_foo");
  const b = p.symbolForMangledProp("_foo");
  assert.equal(a.InnerIndex, b.InnerIndex);
  assert.equal(p.symbols[a.InnerIndex].Kind, SymbolKind.SymbolMangledProp);
  assert.equal(p.symbols[a.InnerIndex].UseCountEstimate, 2);

  const target = new js_ast.Expr(new js_ast.EIdentifier(p.newSymbol(SymbolKind.SymbolUnbound, "a")), new Loc(0));
  const name = new MaybeSubstring(new TextEncoder().encode("_foo"), 0);
  const parsed = p.dotOrMangledPropParse(target, name, new Loc(2), js_ast.OptionalChain.OptionalChainNone, wasOriginallyDot);
  assert.ok(parsed instanceof js_ast.EIndex);
  // Go: (original != wasOriginallyIndex || p.options.mangleQuoted) —— quoted index 默认不变成 mangled prop
  const quoted = p.dotOrMangledPropParse(target, name, new Loc(2), js_ast.OptionalChain.OptionalChainNone, wasOriginallyIndex);
  assert.ok(quoted instanceof js_ast.EDot);
  assert.equal((quoted as js_ast.EDot).Name, "_foo");

  assert.ok(p.dotOrMangledPropVisit(target, "_foo", new Loc(2)) instanceof js_ast.EIndex);
  assert.ok(p.dotOrMangledPropVisit(target, "bar", new Loc(2)) instanceof js_ast.EDot);
});

test("B-28：assert 关键字警告 + JSON 导入断言 notes（Go 源码逐字文案）", () => {
  const msgs: { kind: number; id: number; text: string; notes: string[]; suggestion: string }[] = [];
  const log = silentLog();
  log.AddMsg = (m) => msgs.push({
    kind: m.Kind, id: m.ID, text: m.Data.Text, notes: m.Notes.map((n) => n.Text),
    suggestion: m.Data.Location?.Suggestion ?? "",
  });
  const options = new Options();
  // Go: unsupportedJSFeatures.Has(ImportAssertions) && !Has(ImportAttributes)
  options.originalTargetEnv = '"es2025"';
  options.unsupportedJSFeatures = JSFeature.ImportAssertions;
  const p = makeParser("", options, log);
  p.maybeWarnAboutAssertKeyword(new Loc(0));

  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].kind, MsgKind.Warning);
  assert.equal(msgs[0].text, 'The "assert" keyword is not supported in the configured target environment ("es2025")');
  assert.deepEqual(msgs[0].notes, ['Did you mean to use "with" instead of "assert"?']);
  assert.equal(msgs[0].suggestion, "with");

  const record = new js_ast.ImportRecord();
  record.AssertOrWith = new ImportAssertOrWith();
  record.AssertOrWith.Entries.push({
    Key: [..."type"].map((c) => c.charCodeAt(0)),
    Value: [..."json"].map((c) => c.charCodeAt(0)),
    KeyLoc: new Loc(0),
    ValueLoc: new Loc(0),
    PreferQuotedKey: false,
  });
  const notes = p.notesForAssertTypeJSON(record, "default");
  assert.equal(notes[0].Text, "The JSON import assertion is here:");
  assert.equal(
    notes[1].Text,
    'You can either keep the import assertion and only use the "default" import, or you can remove the import assertion and use the "default" import.',
  );
});

// ---------------------------------------------------------------------------
// 第 29 轮：strict-mode 闭包 6 个函数（js_parser_lower.go:132/136/155/205 +
// js_parser.go:18283/6387）—— 期望值来自 /tmp/esbuild-go 实跑，见各用例注释。
// ---------------------------------------------------------------------------

test("strict-29：isStrictMode / isStrictModeOutputFormat 与 Go 的两种 strict 判据一致", () => {
  const p = makeParser("use strict");
  const scope = new js_ast.Scope();
  scope.StrictMode = js_ast.StrictModeKind.SloppyMode;
  p.currentScope = scope;
  assert.equal(isStrictMode(p), false);
  scope.StrictMode = js_ast.StrictModeKind.ExplicitStrictMode;
  assert.equal(isStrictMode(p), true);
  assert.equal(isStrictModeOutputFormat(p), false);
  p.options.outputFormat = 3; // Go: config.FormatESModule
  assert.equal(isStrictModeOutputFormat(p), true);
});

test("strict-29：markStrictModeFeature 的三条诊断与 Go 实测一致", () => {
  // printf 'with (x) y' | esbuild --format=esm
  //   ✘ [ERROR] With statements cannot be used with the "esm" output format due to strict mode
  // printf '"use strict"; with (x) y' | esbuild
  //   ✘ [ERROR] With statements cannot be used in strict mode
  //   ＋ Strict mode is triggered by the "use strict" directive here:
  const msgs: { text: string; notes: string[] }[] = [];
  const log = silentLog();
  log.AddMsg = (m) => msgs.push({ text: m.Data.Text, notes: m.Notes.map((n) => n.Text) });
  const p = makeParser("use strict", new Options(), log);
  const scope = new js_ast.Scope();
  scope.StrictMode = js_ast.StrictModeKind.SloppyMode;
  scope.UseStrictLoc = new Loc(1);
  p.currentScope = scope;

  p.options.outputFormat = 3;
  markStrictModeFeature(p, strictModeFeature.withStatement, new Range(new Loc(0), 4), "");
  assert.equal(msgs[0].text, 'With statements cannot be used with the "esm" output format due to strict mode');

  p.options.outputFormat = 0;
  scope.StrictMode = js_ast.StrictModeKind.ExplicitStrictMode;
  markStrictModeFeature(p, strictModeFeature.withStatement, new Range(new Loc(0), 4), "");
  assert.equal(msgs[1].text, "With statements cannot be used in strict mode");
  assert.deepEqual(msgs[1].notes, ['Strict mode is triggered by the "use strict" directive here:']);

  scope.StrictMode = js_ast.StrictModeKind.SloppyMode;
  p.options.outputFormat = 3;
  markStrictModeFeature(p, strictModeFeature.forInVarInit, new Range(new Loc(0), 4), "");
  assert.equal(msgs.length, 2); // canBeTransformed=true：esm 下不报错
});

test("strict-29：whyESModule / whyStrictMode / validateDeclaredSymbolName 的 notes 与 Go 一致", () => {
  // printf 'function eval() {}' | esbuild --format=esm
  //   ✘ [ERROR] Declarations with the name "eval" cannot be used with the "esm" output format due to strict mode
  const msgs: { text: string; notes: string[] }[] = [];
  const log = silentLog();
  log.AddMsg = (m) => msgs.push({ text: m.Data.Text, notes: m.Notes.map((n) => n.Text) });
  const p = makeParser("use strict", new Options(), log);
  const scope = new js_ast.Scope();
  scope.StrictMode = js_ast.StrictModeKind.SloppyMode;
  scope.UseStrictLoc = new Loc(1);
  p.currentScope = scope;

  p.esmExportKeyword = new Range(new Loc(0), 6);
  assert.equal(p.whyESModule()[0], whyESM.whyESMExportKeyword);
  assert.ok(p.whyESModule()[1]![0].Text.includes('of the "export" keyword here:'));
  p.esmExportKeyword = new Range();
  p.esmImportStatementKeyword = new Range(new Loc(0), 6);
  assert.equal(p.whyESModule()[0], whyESM.whyESMImportStatement);

  scope.StrictMode = js_ast.StrictModeKind.ExplicitStrictMode;
  const [where, notes] = whyStrictMode(p, scope);
  assert.equal(where, "in strict mode");
  assert.deepEqual(notes!.map((n) => n.Text), ['Strict mode is triggered by the "use strict" directive here:']);

  p.validateDeclaredSymbolName(new Loc(0), "eval");
  assert.ok(msgs[0].text.includes('Declarations with the name "eval" cannot be used in strict mode'));
});
