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
import { Parse, ParseGlobalName, Options } from "./js_parser.ts";
import { Log, Path, Source } from "../logger/logger.ts";

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
    } else {
      m.kind = "UNSUPPORTED";
    }
    return m;
  }

  expr(expr: js_ast.Expr): unknown {
    const m: Record<string, unknown> = { loc: expr.Loc.Start };
    const e = expr.Data;

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
      m.target = this.expr(e.Target);
      m.args = e.Args.map((arg) => this.expr(arg));
    } else if (e instanceof js_ast.EDot) {
      m.kind = "EDot";
      m.target = this.expr(e.Target);
      m.name = e.Name;
    } else if (e instanceof js_ast.EIndex) {
      m.kind = "EIndex";
      m.target = this.expr(e.Target);
      m.index = this.expr(e.Index);
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
test("Parse：22 个输入的 AST 与 Go 实测逐节点一致", () => {
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

test("Parse 的错误路径：非法输入返回 ok=false，不抛异常", () => {
  const options = new Options();
  const source = makeSource("x = ;");
  assert.equal(Parse(silentLog(), source, options).ok, false);

  // 骨架不支持的语法必须走 Expected/Unexpected（抛 LexerPanic 被 Parse 接住），
  // 不允许「静默吞掉」或返回半个 AST。
  const unsupported = makeSource("class Foo {}");
  assert.equal(Parse(silentLog(), unsupported, options).ok, false);
});
