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
  Loc,
  MakeLineColumnTracker,
  Range,
  type Log,
  type LineColumnTracker,
  type Source,
} from "../logger/logger.ts";
import { StringToUTF16, UTF16ToString } from "../helpers/utf.ts";
import { InvalidRef, LocRef, Ref, Symbol, SymbolKind } from "../ast/ast.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import { Lexer, LexerPanic, MaybeSubstring } from "../js_lexer/js_lexer.ts";
import { T, Keywords } from "../js_lexer/tables.ts";

const decoder = new TextDecoder();

function bytesToString(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** Go: helpers.StringToUTF16(string) → Uint16Array（AST 的 EString.Value 类型） */
function utf16FromString(text: string): Uint16Array {
  return new Uint16Array(StringToUTF16(new TextEncoder().encode(text)));
}

/** Go: config.TSOptions 的字段子集（config 包整包未移植，见 PLAN.md「第 11 次推进」§3） */
export interface TSOptions {
  Parse: boolean;
  NoAmbiguousLessThan: boolean;
}

/** Go: config.JSXOptions 的字段子集（同上） */
export interface JSXOptions {
  Parse: boolean;
  Preserve: boolean;
}

/** Go: js_parser.Options（只落骨架用到的字段；injectedFiles/defines 等留给后续） */
export class Options {
  ts: TSOptions = { Parse: false, NoAmbiguousLessThan: false };
  jsx: JSXOptions = { Parse: true, Preserve: false };
}

/** Go: type parseStmtOpts struct */
export class parseStmtOpts {
  isModuleScope: boolean = false;
  allowDirectivePrologue: boolean = false;
  isExport: boolean = false;
}

/** Go: type propertyOpts struct（js_parser.go）的 JS 子集 */
export class propertyOpts {
  isClass: boolean = false;
  isAsync: boolean = false;
  isGenerator: boolean = false;
  isStatic: boolean = false;
  classHasExtends: boolean = false;
  classKeyword: Range = new Range();
}

/** Go: type exprFlag uint8 */
export type exprFlag = number;
export const exprFlag = {
  exprFlagNone: 0,
  exprFlagDecorator: 1 << 0,
} as const;

/** Go: type parser struct（字段取骨架实际用到的部分） */
export class parser {
  log: Log;
  source: Source;
  tracker: LineColumnTracker;
  lexer: Lexer;
  options: Options;

  symbols: Symbol[] = [];
  allocatedNames: Uint8Array[] = [];
  currentScope: js_ast.Scope | null = null;
  moduleScope: js_ast.Scope | null = null;
  allowIn: boolean = true;
  allowDirectivePrologue: boolean = false;

  constructor(log: Log, source: Source, lexer: Lexer, options: Options) {
    this.log = log;
    this.source = source;
    this.tracker = MakeLineColumnTracker(source);
    this.lexer = lexer;
    this.options = options;
  }

  // -------------------------------------------------------------------------
  // 作用域 / 符号
  // -------------------------------------------------------------------------

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
    return 0;
  }

  /** Go: func (p *parser) popScope() */
  popScope(): void {
    this.currentScope = this.currentScope!.Parent;
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

  /** Go: func (p *parser) declareSymbol(kind ast.SymbolKind, loc logger.Loc, name string) ast.Ref */
  declareSymbol(kind: SymbolKind, loc: Loc, name: string): Ref {
    const ref = this.newSymbol(kind, name);

    // SKELETON: Go 在这里调用 canMergeSymbols() 处理 var/function/let/const 的合并规则；
    // 骨架只保留「同名符号取第一个」这一种行为（corpus 里没有重复声明）。
    const existing = this.currentScope!.Members.get(name);
    if (existing !== undefined) {
      return existing.Ref;
    }

    const member = new js_ast.ScopeMember();
    member.Ref = ref;
    member.Loc = loc;
    this.currentScope!.Members.set(name, member);
    return ref;
  }

  /** Go: func (p *parser) findSymbol(loc logger.Loc, name string) findSymbolResult */
  findSymbol(loc: Loc, name: string): Ref | null {
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
    return this.lexer.Loc();
  }

  // -------------------------------------------------------------------------
  // 语句
  // -------------------------------------------------------------------------

  /** Go: func (p *parser) parseStmtsUpTo(end js_lexer.T, opts parseStmtOpts) []js_ast.Stmt */
  parseStmtsUpTo(end: T, opts: parseStmtOpts): js_ast.Stmt[] {
    const stmts: js_ast.Stmt[] = [];
    let isDirectivePrologue = opts.allowDirectivePrologue;

    while (this.lexer.Token !== end) {
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
            stmt.Data = Object.assign(new js_ast.SDirective(), {
              Value: str.Value,
              LegacyOctalLoc: str.LegacyOctalLoc,
            });
            isDirectivePrologue = true;
          }
        }
      }

      stmts.push(stmt);
    }
    return stmts;
  }

  /** Go: func (p *parser) parseStmt(opts parseStmtOpts) js_ast.Stmt */
  parseStmt(opts: parseStmtOpts): js_ast.Stmt {
    const loc = this.lexer.Loc();

    switch (this.lexer.Token) {
      case T.TExport: {
        this.lexer.Next();
        switch (this.lexer.Token) {
          case T.TClass:
          case T.TConst:
          case T.TFunction:
          case T.TVar:
            // Go 的 opts 是值类型；TS 是类，必须克隆后改。
            const exportOpts = Object.assign(new parseStmtOpts(), opts, { isExport: true });
            return this.parseStmt(exportOpts);

          case T.TIdentifier:
            // Go: "export let ..."（`let` 是上下文关键字，token 仍是 TIdentifier）
            if (this.lexer.IsContextualKeyword("let")) {
              const exportLetOpts = Object.assign(new parseStmtOpts(), opts, { isExport: true });
              return this.parseStmt(exportLetOpts);
            }
            break;
        }
        this.lexer.Unexpected();
        return new js_ast.Stmt(js_ast.SEmptyShared, loc);
      }

      case T.TSemicolon: {
        this.lexer.Next();
        return new js_ast.Stmt(js_ast.SEmptyShared, loc);
      }

      case T.TOpenBrace: {
        const stmts = this.parseBlockStmts();
        return new js_ast.Stmt(Object.assign(new js_ast.SBlock(), {
          Stmts: stmts.stmts,
          CloseBraceLoc: stmts.closeBraceLoc,
        }), loc);
      }

      case T.TVar: {
        this.lexer.Next();
        const decls = this.parseAndDeclareDecls(SymbolKind.SymbolHoisted, opts);
        this.lexer.ExpectOrInsertSemicolon();
        return new js_ast.Stmt(Object.assign(new js_ast.SLocal(), {
          Decls: decls,
          Kind: js_ast.LocalKind.LocalVar,
          IsExport: opts.isExport,
        }), loc);
      }

      case T.TConst: {
        this.lexer.Next();
        const decls = this.parseAndDeclareDecls(SymbolKind.SymbolConst, opts);
        this.lexer.ExpectOrInsertSemicolon();
        return new js_ast.Stmt(Object.assign(new js_ast.SLocal(), {
          Decls: decls,
          Kind: js_ast.LocalKind.LocalConst,
          IsExport: opts.isExport,
        }), loc);
      }

      case T.TFunction:
        return this.parseFnStmt(loc, opts, false);

      case T.TClass:
        return this.parseClassStmt(loc, opts);

      case T.TIf: {
        this.lexer.Next();
        this.lexer.Expect(T.TOpenParen);
        const test = this.parseExpr(js_ast.L.LLowest);
        this.lexer.Expect(T.TCloseParen);
        const yes = this.parseStmt(new parseStmtOpts());
        let noOrNil: js_ast.Stmt | null = null;
        if (this.lexer.Token === T.TElse) {
          this.lexer.Next();
          noOrNil = this.parseStmt(new parseStmtOpts());
        }
        return new js_ast.Stmt(Object.assign(new js_ast.SIf(), {
          Test: test,
          Yes: yes,
          NoOrNil: noOrNil,
        }), loc);
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
        return new js_ast.Stmt(Object.assign(new js_ast.SReturn(), { ValueOrNil: valueOrNil }), loc);
      }

      case T.TDebugger:
        this.lexer.Next();
        this.lexer.ExpectOrInsertSemicolon();
        return new js_ast.Stmt(js_ast.SDebuggerShared, loc);

      case T.TIdentifier:
        // SKELETON: Go 用 willNeedBindingPattern() 前瞻区分 `let` 声明与普通标识符；
        // 骨架只在 `let` 后面紧跟标识符时才当成声明（corpus 覆盖这一形态）。
        if (this.lexer.IsContextualKeyword("let")) {
          return this.parseLetStmt(loc, opts);
        }
        break;
    }

    // Expression statement
    const value = this.parseExpr(js_ast.L.LLowest);
    this.lexer.ExpectOrInsertSemicolon();
    return new js_ast.Stmt(Object.assign(new js_ast.SExpr(), { Value: value }), loc);
  }

  /** 骨架：`let` 是上下文关键字（js_lexer 里没有 TLet token） */
  parseLetStmt(loc: Loc, opts: parseStmtOpts): js_ast.Stmt {
    this.lexer.Next();
    const decls = this.parseAndDeclareDecls(SymbolKind.SymbolOther, opts);
    this.lexer.ExpectOrInsertSemicolon();
    return new js_ast.Stmt(Object.assign(new js_ast.SLocal(), {
      Decls: decls,
      Kind: js_ast.LocalKind.LocalLet,
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
  parseAndDeclareDecls(kind: SymbolKind, opts: parseStmtOpts): js_ast.Decl[] {
    const decls: js_ast.Decl[] = [];

    for (;;) {
      const binding = this.parseBinding(kind);
      let valueOrNil: js_ast.Expr | null = null;
      if (this.lexer.Token === T.TEquals) {
        this.lexer.Next();
        valueOrNil = this.parseExpr(js_ast.L.LComma);
      }
      decls.push(Object.assign(new js_ast.Decl(), { Binding: binding, ValueOrNil: valueOrNil }));

      if (this.lexer.Token !== T.TComma) {
        break;
      }
      this.lexer.Next();
    }

    return decls;
  }

  /** Go: func (p *parser) parseBinding(opts parseBindingOpts) js_ast.Binding */
  parseBinding(kind: SymbolKind): js_ast.Binding {
    const loc = this.lexer.Loc();
    // SKELETON: Go 支持数组/对象解构与默认值，且由 declareBinding() 单独声明符号；
    // 骨架只支持标识符绑定，并在解析时直接声明符号（kind 由 parseAndDeclareDecls 传入）。
    if (this.lexer.Token !== T.TIdentifier) {
      this.lexer.Expected(T.TIdentifier);
    }
    const ref = this.declareSymbol(kind, loc, bytesToString(this.lexer.Identifier.String));
    this.lexer.Next();
    return Object.assign(new js_ast.Binding(), {
      Data: new js_ast.BIdentifier(ref),
      Loc: loc,
    });
  }

  /** Go: func (p *parser) parseFnStmt(loc logger.Loc, opts parseStmtOpts, isAsync bool, asyncRange logger.Range) js_ast.Stmt */
  parseFnStmt(loc: Loc, opts: parseStmtOpts, isAsync: boolean): js_ast.Stmt {
    this.lexer.Next();
    const fn = this.parseFn(loc, isAsync, false /* isGenerator */, true /* isStatement */);
    return new js_ast.Stmt(Object.assign(new js_ast.SFunction(), { Fn: fn, IsExport: opts.isExport }), loc);
  }

  /**
   * Go: func (p *parser) parseFn(loc logger.Loc, opts parseFnOpts) (fn js_ast.Fn, hadBody bool)
   *
   * SKELETON: 只支持「标识符参数 + 可选默认值以外的简单形态」；参数作用域与函数体作用域
   * 按 Go 的 ScopeFunctionArgs/ScopeFunctionBody 两层建立（函数体作用域会复制参数名，
   * 见 pushScopeForParsePass 的注释）。
   */
  parseFn(loc: Loc, isAsync: boolean, isGenerator: boolean, isStatement: boolean): js_ast.Fn {
    const fn = new js_ast.Fn();
    fn.IsAsync = isAsync;
    fn.IsGenerator = isGenerator;

    // Function name
    if (this.lexer.Token === T.TIdentifier) {
      const nameLoc = this.lexer.Loc();
      const name = bytesToString(this.lexer.Identifier.String);
      const ref = this.declareSymbol(SymbolKind.SymbolHoistedFunction, nameLoc, name);
      fn.Name = new LocRef(nameLoc, ref);
      this.lexer.Next();
    } else if (isStatement) {
      this.lexer.Expected(T.TIdentifier);
    }

    // Argument list
    this.lexer.Expect(T.TOpenParen);
    fn.OpenParenLoc = this.lexer.Loc();

    this.pushScopeForParsePass(js_ast.ScopeKind.ScopeFunctionArgs, loc);
    const argsScope = this.currentScope!;

    while (this.lexer.Token !== T.TCloseParen) {
      if (fn.Args.length > 0) {
        this.lexer.Expect(T.TComma);
        if (this.lexer.Token === T.TCloseParen) break;
      }
      const argLoc = this.lexer.Loc();
      if (this.lexer.Token !== T.TIdentifier) {
        this.lexer.Expected(T.TIdentifier);
      }
      const argName = bytesToString(this.lexer.Identifier.String);
      const ref = this.declareSymbol(SymbolKind.SymbolHoisted, argLoc, argName);
      this.lexer.Next();

      const arg = new js_ast.Arg();
      arg.Binding = Object.assign(new js_ast.Binding(), {
        Data: new js_ast.BIdentifier(ref),
        Loc: argLoc,
      });
      fn.Args.push(arg);
    }
    this.lexer.Expect(T.TCloseParen);

    // Function body
    this.pushScopeForParsePass(js_ast.ScopeKind.ScopeFunctionBody, this.lexer.Loc());
    // Go: 函数体作用域复制参数作用域的成员（重声明参数会报错）
    for (const [name, member] of argsScope.Members) {
      if (this.symbols[member.Ref.InnerIndex].Kind !== SymbolKind.SymbolHoistedFunction) {
        this.currentScope!.Members.set(name, member);
      }
    }
    const bodyLoc = this.lexer.Loc();
    const block = this.parseBlockStmts();
    fn.Body = Object.assign(new js_ast.FnBody(), {
      Block: Object.assign(new js_ast.SBlock(), {
        Stmts: block.stmts,
        CloseBraceLoc: block.closeBraceLoc,
      }),
      Loc: bodyLoc,
    });
    this.popScope();
    this.popScope();

    return fn;
  }

  // -------------------------------------------------------------------------
  // class
  // -------------------------------------------------------------------------

  /** Go: func (p *parser) parseClassStmt(loc logger.Loc, opts parseStmtOpts) js_ast.Stmt */
  parseClassStmt(loc: Loc, opts: parseStmtOpts): js_ast.Stmt {
    let name: js_ast.LocRef | null = null;
    const classKeyword = this.lexer.Range();
    if (this.lexer.Token === T.TClass) {
      this.lexer.Next();
    } else {
      this.lexer.Expected(T.TClass);
    }

    // Go: !opts.isNameOptional（骨架子集没有 export default class，所以恒为必选名字）
    {
      const nameLoc = this.lexer.Loc();
      const nameText = bytesToString(this.lexer.Identifier.String);
      this.lexer.Expect(T.TIdentifier);
      name = new js_ast.LocRef(nameLoc, this.declareSymbol(SymbolKind.SymbolClass, nameLoc, nameText));
    }

    this.pushScopeForParsePass(js_ast.ScopeKind.ScopeClassName, loc);
    const classValue = this.parseClass(classKeyword, name);
    this.popScope();

    return new js_ast.Stmt(Object.assign(new js_ast.SClass(), {
      Class: classValue,
      IsExport: opts.isExport,
    }), loc);
  }

  /** Go: func (p *parser) parseClassExpr(decorators []js_ast.Decorator) js_ast.Expr */
  parseClassExpr(): js_ast.Expr {
    const classKeyword = this.lexer.Range();
    this.lexer.Expect(T.TClass);
    let name: js_ast.LocRef | null = null;

    this.pushScopeForParsePass(js_ast.ScopeKind.ScopeClassName, classKeyword.Loc);

    // Parse an optional class name
    if (this.lexer.Token === T.TIdentifier) {
      const nameLoc = this.lexer.Loc();
      const nameText = bytesToString(this.lexer.Identifier.String);
      name = new js_ast.LocRef(nameLoc, this.newSymbol(SymbolKind.SymbolOther, nameText));
      this.lexer.Next();
    }

    const classValue = this.parseClass(classKeyword, name);
    this.popScope();

    return new js_ast.Expr(Object.assign(new js_ast.EClass(), { Class: classValue }), classKeyword.Loc);
  }

  /** Go: func (p *parser) parseClass(classKeyword logger.Range, name *ast.LocRef, classOpts parseClassOpts) js_ast.Class */
  parseClass(classKeyword: Range, name: js_ast.LocRef | null): js_ast.Class {
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
    // Go: UseDefineForClassFields: !p.options.ts.Parse → true
    classValue.UseDefineForClassFields = true;
    return classValue;
  }

  // -------------------------------------------------------------------------
  // 表达式
  // -------------------------------------------------------------------------

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
        const nextOpts = Object.assign(new propertyOpts(), opts, { isGenerator: true });
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
                    Object.assign(new propertyOpts(), opts),
                  );
                }
                break;

              case "set":
                if (!opts.isAsync) {
                  return this.parseProperty(
                    startLoc,
                    js_ast.PropertyKind.PropertySetter,
                    Object.assign(new propertyOpts(), opts),
                  );
                }
                break;

              case "async":
                if (!this.lexer.HasNewlineBefore && !opts.isAsync) {
                  const asyncOpts = Object.assign(new propertyOpts(), opts, { isAsync: true });
                  return this.parseProperty(startLoc, js_ast.PropertyKind.PropertyMethod, asyncOpts);
                }
                break;

              case "static":
                if (!opts.isStatic && !opts.isAsync && opts.isClass) {
                  const staticOpts = Object.assign(new propertyOpts(), opts, { isStatic: true });
                  return this.parseProperty(startLoc, kind, staticOpts);
                }
                break;
            }
          } else if (this.lexer.Token === T.TOpenBrace && name === "static") {
            // "static { ... }" class static block
            const loc = this.lexer.Loc();
            this.lexer.Next();

            this.pushScopeForParsePass(js_ast.ScopeKind.ScopeClassStaticInit, loc);
            const stmts = this.parseStmtsUpTo(T.TCloseBrace, new parseStmtOpts());
            this.popScope();

            const closeBraceLoc = this.lexer.Loc();
            this.lexer.Expect(T.TCloseBrace);
            return Object.assign(new js_ast.Property(), {
              Kind: js_ast.PropertyKind.PropertyClassStaticBlock,
              Loc: startLoc,
              ClassStaticBlock: Object.assign(new js_ast.ClassStaticBlock(), {
                Loc: loc,
                Block: Object.assign(new js_ast.SBlock(), { Stmts: stmts, CloseBraceLoc: closeBraceLoc }),
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
          return Object.assign(new js_ast.Property(), {
            Kind: kind,
            Loc: startLoc,
            Key: key,
            ValueOrNil: value,
            InitializerOrNil: null,
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
        initializerOrNil = this.parseExpr(js_ast.L.LComma);
      }

      this.lexer.ExpectOrInsertSemicolon();
      if (opts.isStatic) flags |= js_ast.PropertyFlags.PropertyIsStatic;
      return Object.assign(new js_ast.Property(), {
        Loc: startLoc,
        Kind: kind,
        Flags: flags,
        Key: key,
        InitializerOrNil: initializerOrNil,
        CloseBracketLoc: closeBracketLoc,
      });
    }

    // Parse a method expression
    if (this.lexer.Token === T.TOpenParen || js_ast.IsMethodDefinition(kind) || opts.isClass) {
      const loc = this.lexer.Loc();
      const fn = this.parseFn(loc, opts.isAsync, opts.isGenerator, false /* isStatement */);
      fn.IsUniqueFormalParameters = true;
      const value = new js_ast.Expr(new js_ast.EFunction(fn), loc);

      switch (kind) {
        case js_ast.PropertyKind.PropertyGetter:
        case js_ast.PropertyKind.PropertySetter:
          break;
        default:
          kind = js_ast.PropertyKind.PropertyMethod;
      }

      if (opts.isStatic) flags |= js_ast.PropertyFlags.PropertyIsStatic;
      return Object.assign(new js_ast.Property(), {
        Loc: startLoc,
        Kind: kind,
        Flags: flags,
        Key: key,
        ValueOrNil: value,
        CloseBracketLoc: closeBracketLoc,
      });
    }

    // Parse an object key/value pair
    this.lexer.Expect(T.TColon);
    const value = this.parseExpr(js_ast.L.LComma);
    return Object.assign(new js_ast.Property(), {
      Loc: startLoc,
      Kind: kind,
      Flags: flags,
      Key: key,
      ValueOrNil: value,
      CloseBracketLoc: closeBracketLoc,
    });
  }

  /** Go: func (p *parser) parseObjectLiteral(loc logger.Loc) js_ast.Expr 的子集 */
  parseObjectLiteral(loc: Loc): js_ast.Expr {
    this.lexer.Expect(T.TOpenBrace);
    let isSingleLine = !this.lexer.HasNewlineBefore;
    const properties: js_ast.Property[] = [];

    while (this.lexer.Token !== T.TCloseBrace) {
      if (this.lexer.Token === T.TDotDotDot) {
        const dotLoc = this.saveExprCommentsHere();
        this.lexer.Next();
        const value = this.parseExpr(js_ast.L.LComma);
        properties.push(Object.assign(new js_ast.Property(), {
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
    const closeBraceLoc = this.lexer.Loc();
    this.lexer.Expect(T.TCloseBrace);
    return new js_ast.Expr(Object.assign(new js_ast.EObject(), {
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
    const left = this.parsePrefix(level, flags);
    return this.parseSuffix(left, level, flags);
  }

  /** Go: func (p *parser) parsePrefix(level js_ast.L, errors *deferredErrors, flags exprFlag) js_ast.Expr */
  parsePrefix(level: js_ast.L, _flags: exprFlag): js_ast.Expr {
    const loc = this.lexer.Loc();

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
        return new js_ast.Expr(Object.assign(new js_ast.ETemplate(), {
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

      case T.TIdentifier: {
        const name = this.lexer.Identifier;
        const ref = this.storeNameInRef(name);
        this.lexer.Next();
        return new js_ast.Expr(
          new js_ast.EIdentifier(this.resolveName(this.loadNameFromRef(ref), loc)),
          loc,
        );
      }

      case T.TOpenParen: {
        this.lexer.Next();
        const value = this.parseExpr(js_ast.L.LLowest);
        this.lexer.Expect(T.TCloseParen);
        if (value.Data instanceof js_ast.EArray) {
          value.Data.IsParenthesized = true;
        } else if (value.Data instanceof js_ast.EObject) {
          value.Data.IsParenthesized = true;
        } else if (value.Data instanceof js_ast.EBinary) {
          value.Data.IsParenthesized = true;
        } else if (value.Data instanceof js_ast.EFunction) {
          value.Data.IsParenthesized = true;
        }
        return value;
      }

      case T.TOpenBracket: {
        this.lexer.Next();
        const items: js_ast.Expr[] = [];
        let isSingleLine = !this.lexer.HasNewlineBefore;

        while (this.lexer.Token !== T.TCloseBracket) {
          if (items.length > 0) {
            if (this.lexer.Token !== T.TComma) break;
            if (this.lexer.HasNewlineBefore) isSingleLine = false;
            this.lexer.Next();
            if (this.lexer.HasNewlineBefore) isSingleLine = false;
            if (this.lexer.Token === T.TCloseBracket) break;
          }

          if (this.lexer.Token === T.TDotDotDot) {
            const dotsLoc = this.saveExprCommentsHere();
            this.lexer.Next();
            const item = this.parseExpr(js_ast.L.LComma);
            items.push(new js_ast.Expr(new js_ast.ESpread(item), dotsLoc));
          } else {
            items.push(this.parseExpr(js_ast.L.LComma));
          }
        }

        if (this.lexer.HasNewlineBefore) isSingleLine = false;
        const closeBracketLoc = this.saveExprCommentsHere();
        this.lexer.Expect(T.TCloseBracket);

        return new js_ast.Expr(Object.assign(new js_ast.EArray(), {
          Items: items,
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
        return new js_ast.Expr(Object.assign(new js_ast.EUnary(), { Op: op, Value: value }), loc);
      }

      case T.TMinusMinus:
      case T.TPlusPlus: {
        const op = this.lexer.Token === T.TMinusMinus ? js_ast.OpCode.UnOpPreDec : js_ast.OpCode.UnOpPreInc;
        this.lexer.Next();
        return new js_ast.Expr(Object.assign(new js_ast.EUnary(), {
          Op: op,
          Value: this.parseExpr(js_ast.L.LPrefix),
        }), loc);
      }

      case T.TFunction: {
        this.lexer.Next();
        const fn = this.parseFn(loc, false /* isAsync */, false /* isGenerator */, false /* isStatement */);
        return new js_ast.Expr(Object.assign(new js_ast.EFunction(), { Fn: fn }), loc);
      }

      case T.TClass:
        return this.parseClassExpr();

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

  /** Go: func (p *parser) parseSuffix(left js_ast.Expr, level js_ast.L, errors *deferredErrors, flags exprFlag) js_ast.Expr */
  parseSuffix(left: js_ast.Expr, level: js_ast.L, _flags: exprFlag): js_ast.Expr {
    for (;;) {
      switch (this.lexer.Token) {
        case T.TDot: {
          if (level >= js_ast.L.LMember) return left;
          this.lexer.Next();
          if (!this.lexer.IsIdentifierOrKeyword()) {
            this.lexer.Expected(T.TIdentifier);
          }
          const name = bytesToString(this.lexer.Identifier.String);
          const nameLoc = this.lexer.Loc();
          this.lexer.Next();
          left = new js_ast.Expr(Object.assign(new js_ast.EDot(), {
            Target: left,
            Name: name,
            NameLoc: nameLoc,
          }), left.Loc);
          break;
        }

        case T.TOpenBracket: {
          if (level >= js_ast.L.LMember) return left;
          this.lexer.Next();
          const index = this.parseExpr(js_ast.L.LLowest);
          const closeBracketLoc = this.lexer.Loc();
          this.lexer.Expect(T.TCloseBracket);
          left = new js_ast.Expr(Object.assign(new js_ast.EIndex(), {
            Target: left,
            Index: index,
            CloseBracketLoc: closeBracketLoc,
          }), left.Loc);
          break;
        }

        case T.TOpenParen: {
          if (level >= js_ast.L.LCall) return left;
          const args = this.parseCallArgs();
          left = new js_ast.Expr(Object.assign(new js_ast.ECall(), {
            Target: left,
            Args: args.args,
            CloseParenLoc: args.closeParenLoc,
            IsMultiLine: args.isMultiLine,
          }), left.Loc);
          break;
        }

        case T.TNoSubstitutionTemplateLiteral: {
          const headLoc = this.lexer.Loc();
          const head = this.lexer.CookedAndRawTemplateContents();
          this.lexer.Next();
          left = new js_ast.Expr(Object.assign(new js_ast.ETemplate(), {
            TagOrNil: left,
            HeadLoc: headLoc,
            HeadCooked: head.cooked,
            HeadRaw: head.raw,
          }), left.Loc);
          break;
        }

        case T.TTemplateHead: {
          const headLoc = this.lexer.Loc();
          const head = this.lexer.CookedAndRawTemplateContents();
          const parts = this.parseTemplateParts(true /* includeRaw */);
          left = new js_ast.Expr(Object.assign(new js_ast.ETemplate(), {
            TagOrNil: left,
            HeadLoc: headLoc,
            HeadCooked: head.cooked,
            HeadRaw: head.raw,
            Parts: parts,
          }), left.Loc);
          break;
        }

        default: {
          const op = opForBinaryToken(this.lexer.Token);
          if (op === null) return left;
          if (level >= op.level) return left;

          this.lexer.Next();
          const right = this.parseExpr(op.rightLevel);
          left = new js_ast.Expr(Object.assign(new js_ast.EBinary(), {
            Op: op.op,
            Left: left,
            Right: right,
          }), left.Loc);
          break;
        }
      }
    }
  }

  /** Go: func (p *parser) parseCallArgs() (args []js_ast.Expr, closeParenLoc logger.Loc, isMultiLine bool) */
  parseCallArgs(): { args: js_ast.Expr[]; closeParenLoc: Loc; isMultiLine: boolean } {
    const args: js_ast.Expr[] = [];
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
        args.push(new js_ast.Expr(new js_ast.ESpread(this.parseExpr(js_ast.L.LComma)), loc));
      } else {
        args.push(this.parseExpr(js_ast.L.LComma));
      }
    }

    if (this.lexer.HasNewlineBefore) isMultiLine = true;
    const closeParenLoc = this.lexer.Loc();
    this.lexer.Expect(T.TCloseParen);
    return { args, closeParenLoc, isMultiLine };
  }

  /** Go: func (p *parser) parseStringLiteral() js_ast.Expr */
  parseStringLiteral(): js_ast.Expr {
    const loc = this.lexer.Loc();
    const text = this.lexer.StringLiteral();

    const value = Object.assign(new js_ast.EString(), {
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
      tag = new js_ast.Expr(Object.assign(new js_ast.EDot(), {
        Target: tag,
        Name: memberText,
        NameLoc: memberRange.Loc,
      }), loc);
      tagRange.Len = memberRange.Loc.Start + memberRange.Len - tagRange.Loc.Start;
    }

    return { tagRange, tagName: chain, tagOrNil: tag };
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
                    Object.assign(new js_ast.EJSXText(), { Raw: this.lexer.Raw() }),
                    stringLoc,
                  );
                } else {
                  value = new js_ast.Expr(
                    Object.assign(new js_ast.EString(), { Value: this.lexer.StringLiteral() }),
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
            properties.push(Object.assign(new js_ast.Property(), {
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
            properties.push(Object.assign(new js_ast.Property(), {
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
      return new js_ast.Expr(Object.assign(new js_ast.EJSXElement(), {
        TagOrNil: startTagOrNil,
        Properties: properties,
        CloseLoc: closeLoc,
        IsTagSingleLine: isSingleLine,
      }), loc);
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
              Object.assign(new js_ast.EJSXText(), { Raw: this.lexer.Raw() }),
              this.lexer.Loc(),
            ));
          } else {
            const str = this.lexer.StringLiteral();
            if (str.length > 0) {
              nullableChildren.push(new js_ast.Expr(
                Object.assign(new js_ast.EString(), { Value: str }),
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
              new js_ast.ESpread(this.parseExpr(js_ast.L.LLowest)),
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

          return new js_ast.Expr(Object.assign(new js_ast.EJSXElement(), {
            TagOrNil: startTagOrNil,
            Properties: properties,
            NullableChildren: nullableChildren,
            CloseLoc: lessThanLoc,
            IsTagSingleLine: isSingleLine,
          }), loc);
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
  toAST(stmts: js_ast.Stmt[], hashbang: string): js_ast.AST {
    const ast = new js_ast.AST();
    const part = new js_ast.Part();
    part.Stmts = stmts;
    part.CanBeRemovedIfUnused = true;
    ast.Parts = [part];
    ast.Symbols = this.symbols;
    ast.ModuleScope = this.moduleScope;
    ast.Hashbang = hashbang;
    return ast;
  }
}

// ---------------------------------------------------------------------------
// 包级入口
// ---------------------------------------------------------------------------

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
    const stmts = p.parseStmtsUpTo(T.TEndOfFile, opts);

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

    const ast = p.toAST(stmts, hashbang);
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

/** Go: func ParseGlobalName(log logger.Log, source logger.Source) (result []string, ok bool) */
export function ParseGlobalName(log: Log, source: Source): { result: string[]; ok: boolean } {
  let ok = true;
  const result: string[] = [];
  try {
    const lexer = Lexer.NewLexerGlobalName(log, source);

    // Start off with an identifier or a keyword that results in an object
    result.push(bytesToString(lexer.Identifier.String));
    switch (lexer.Token) {
      case T.TThis:
        lexer.Next();
        break;

      case T.TImport:
        // Handle "import.meta"
        lexer.Next();
        lexer.Expect(T.TDot);
        result.push(bytesToString(lexer.Identifier.String));
        lexer.ExpectContextualKeyword("meta");
        break;

      default:
        lexer.Expect(T.TIdentifier);
    }

    // Follow with dot or index expressions
    while (lexer.Token !== T.TEndOfFile) {
      switch (lexer.Token) {
        case T.TDot:
          lexer.Next();
          if (!lexer.IsIdentifierOrKeyword()) {
            lexer.Expect(T.TIdentifier);
          }
          result.push(bytesToString(lexer.Identifier.String));
          lexer.Next();
          break;

        case T.TOpenBracket:
          lexer.Next();
          result.push(bytesToString(UTF16ToString(lexer.StringLiteral())));
          lexer.Expect(T.TStringLiteral);
          lexer.Expect(T.TCloseBracket);
          break;

        default:
          lexer.Expect(T.TDot);
      }
    }

    return { result, ok };
  } catch (e) {
    if (e instanceof LexerPanic) {
      // Go 的命名返回值在 panic 时仍然带着已经 append 的部分
      ok = false;
      return { result, ok };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 小工具（Go 的 fmt / helpers 里本文件用到的那一点）
// ---------------------------------------------------------------------------

function codeUnits(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Go: fmt.Sprintf("%q", s)（骨架只用于 ASCII 名字/标签） */
function goQuoted(s: string): string {
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
      return { op: js_ast.OpCode.BinOpPow, level: js_ast.L.LExponentiation, rightLevel: js_ast.L.LPrefix };
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
      return { op: js_ast.OpCode.BinOpLogicalOr, level: js_ast.L.LLogicalOr, rightLevel: js_ast.L.LLogicalAnd };
    case T.TAmpersandAmpersand:
      return {
        op: js_ast.OpCode.BinOpLogicalAnd,
        level: js_ast.L.LLogicalAnd,
        rightLevel: js_ast.L.LBitwiseOr,
      };
    case T.TBar: return { op: js_ast.OpCode.BinOpBitwiseOr, level: js_ast.L.LBitwiseOr, rightLevel: js_ast.L.LBitwiseXor };
    case T.TCaret:
      return { op: js_ast.OpCode.BinOpBitwiseXor, level: js_ast.L.LBitwiseXor, rightLevel: js_ast.L.LBitwiseAnd };
    case T.TAmpersand:
      return { op: js_ast.OpCode.BinOpBitwiseAnd, level: js_ast.L.LBitwiseAnd, rightLevel: js_ast.L.LEquals };
    case T.TLessThanLessThan:
      return { op: js_ast.OpCode.BinOpShl, level: js_ast.L.LShift, rightLevel: js_ast.L.LShift };
    case T.TGreaterThanGreaterThan:
      return { op: js_ast.OpCode.BinOpShr, level: js_ast.L.LShift, rightLevel: js_ast.L.LShift };
    case T.TGreaterThanGreaterThanGreaterThan:
      return { op: js_ast.OpCode.BinOpUShr, level: js_ast.L.LShift, rightLevel: js_ast.L.LShift };
    case T.TEquals: return { op: js_ast.OpCode.BinOpAssign, level: js_ast.L.LAssign, rightLevel: js_ast.L.LAssign };
    case T.TPlusEquals:
      return { op: js_ast.OpCode.BinOpAddAssign, level: js_ast.L.LAssign, rightLevel: js_ast.L.LAssign };
    case T.TMinusEquals:
      return { op: js_ast.OpCode.BinOpSubAssign, level: js_ast.L.LAssign, rightLevel: js_ast.L.LAssign };
    case T.TAsteriskEquals:
      return { op: js_ast.OpCode.BinOpMulAssign, level: js_ast.L.LAssign, rightLevel: js_ast.L.LAssign };
    case T.TSlashEquals:
      return { op: js_ast.OpCode.BinOpDivAssign, level: js_ast.L.LAssign, rightLevel: js_ast.L.LAssign };
    case T.TQuestionQuestionEquals:
      return {
        op: js_ast.OpCode.BinOpNullishCoalescingAssign,
        level: js_ast.L.LAssign,
        rightLevel: js_ast.L.LAssign,
      };
    case T.TAmpersandAmpersandEquals:
      return {
        op: js_ast.OpCode.BinOpLogicalAndAssign,
        level: js_ast.L.LAssign,
        rightLevel: js_ast.L.LAssign,
      };
    case T.TBarBarEquals:
      return {
        op: js_ast.OpCode.BinOpLogicalOrAssign,
        level: js_ast.L.LAssign,
        rightLevel: js_ast.L.LAssign,
      };
  }
  return null;
}
