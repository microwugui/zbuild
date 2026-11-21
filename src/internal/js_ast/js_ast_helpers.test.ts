// js_ast_helpers 的差分测试。
//
// 期望值全部来自 Go 实测：/root/esbuild 包内探针 internal/js_ast/tmphelpers_test.go（TestTmpHelpers）
// → testdata/js_ast/helpers.json。探针直接构造 Go 的 AST 节点并调用**真实的** js_ast helper，
// 所以既覆盖导出函数，也覆盖未导出函数（simplifyUnusedStringAdditionChain / isInt32OrUint32 /
// extract* / stringCompareUCS2 / approximatePrintedIntCharCount / joinStrings /
// foldAdditionPreProcess / isSideEffectFreeUnboundIdentifierRef）。
//
// TS 侧先从夹具里的 `dump` **反序列化**出 AST（undump），确保两边输入逐字段一致，
// 再调用同名函数，把结果 dump 回同一 schema 逐字段 deepEqual。
//
// 生成命令（可复现）：
//   cd /root/esbuild && HELPERS_OUT=/tmp/helpers.json go test ./internal/js_ast -run TestTmpHelpers
//   cp /tmp/helpers.json /root/port/testdata/js_ast/helpers.json
// 夹具 sha256 钉在 tools/unit-differential.json。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { init } from "../helpers/init.ts";

import * as js_ast from "./js_ast.ts";
import * as helpers from "./js_ast_helpers.ts";
import * as js_ident from "./js_ident.ts";
import { Loc } from "../logger/logger.ts";
import { LocRef, Ref } from "../ast/ast.ts";

const symNames = ["a", "b", "c", "x", "y", "z"];
const ref = (i: number): Ref => new Ref(0, i);
const loc = (n: number): Loc => new Loc(n);

const expected = JSON.parse(
  readFileSync(new URL("../../../testdata/js_ast/helpers.json", import.meta.url), "utf8"),
);

/** Go: math.Float64bits 的十进制字符串 */
function f64bits(v: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, v, false);
  let bits = 0n;
  for (let i = 0; i < 8; i++) bits = (bits << 8n) | BigInt(view.getUint8(i));
  return bits.toString();
}

function bitsToF64(s: string): number {
  let bits = BigInt(s);
  const bytes = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    bytes[i] = Number(bits & 0xffn);
    bits >>= 8n;
  }
  return new DataView(bytes.buffer).getFloat64(0, false);
}

function utf16Ints(u: Uint16Array | number[]): number[] {
  return Array.from(u);
}

// ---------------------------------------------------------------------------
// undump：夹具 dump → TS AST
// ---------------------------------------------------------------------------

function undumpExpr(m: any): js_ast.Expr {
  if (m === null) return new js_ast.Expr();
  let data: js_ast.E;
  switch (m.kind) {
    case "EIdentifier": {
      const e = new js_ast.EIdentifier(ref(symNames.indexOf(m.name)));
      e.CanBeRemovedIfUnused = m.canBeRemovedIfUnused;
      e.MustKeepDueToWithStmt = m.mustKeepDueToWithStmt;
      e.CallCanBeUnwrappedIfUnused = m.callCanBeUnwrappedIfUnused;
      data = e;
      break;
    }
    case "ENumber": data = new js_ast.ENumber(bitsToF64(m.bits)); break;
    case "EBigInt": data = new js_ast.EBigInt(m.value); break;
    case "EString": {
      const e = new js_ast.EString(new Uint16Array(m.value));
      e.PreferTemplate = m.preferTemplate;
      data = e;
      break;
    }
    case "EBoolean": data = new js_ast.EBoolean(m.value); break;
    case "ENull": data = new js_ast.ENull(); break;
    case "EUndefined": data = new js_ast.EUndefined(); break;
    case "EThis": data = new js_ast.EThis(); break;
    case "EMissing": data = new js_ast.EMissing(); break;
    case "ERegExp": data = new js_ast.ERegExp(m.value); break;
    case "EUnary": {
      const e = new js_ast.EUnary();
      e.Op = m.op;
      e.Value = undumpExpr(m.value);
      e.WasOriginallyTypeofIdentifier = m.wasTypeof;
      data = e;
      break;
    }
    case "EBinary": {
      const e = new js_ast.EBinary();
      e.Op = m.op;
      e.Left = undumpExpr(m.left);
      e.Right = undumpExpr(m.right);
      data = e;
      break;
    }
    case "ECall": {
      const e = new js_ast.ECall();
      e.Target = undumpExpr(m.target);
      e.Args = m.args.map(undumpExpr);
      e.OptionalChain = m.optionalChain;
      e.Kind = m.callKind;
      e.CanBeUnwrappedIfUnused = m.canBeUnwrappedIfUnused;
      data = e;
      break;
    }
    case "EDot": {
      const e = new js_ast.EDot();
      e.Target = undumpExpr(m.target);
      e.Name = m.name;
      e.OptionalChain = m.optionalChain;
      e.CanBeRemovedIfUnused = m.canBeRemovedIfUnused;
      e.IsSymbolInstance = m.isSymbolInstance;
      e.CallCanBeUnwrappedIfUnused = m.callCanBeUnwrappedIfUnused;
      data = e;
      break;
    }
    case "EIndex": {
      const e = new js_ast.EIndex();
      e.Target = undumpExpr(m.target);
      e.Index = undumpExpr(m.index);
      e.OptionalChain = m.optionalChain;
      e.CanBeRemovedIfUnused = m.canBeRemovedIfUnused;
      e.IsSymbolInstance = m.isSymbolInstance;
      e.CallCanBeUnwrappedIfUnused = m.callCanBeUnwrappedIfUnused;
      data = e;
      break;
    }
    case "EArray": {
      const e = new js_ast.EArray();
      e.Items = m.items.map(undumpExpr);
      e.IsSingleLine = m.isSingleLine;
      data = e;
      break;
    }
    case "ESpread": {
      const e = new js_ast.ESpread();
      e.Value = undumpExpr(m.value);
      data = e;
      break;
    }
    case "EObject": {
      const e = new js_ast.EObject();
      e.Properties = m.properties.map(undumpProperty);
      e.IsSingleLine = m.isSingleLine;
      data = e;
      break;
    }
    case "EIf": {
      const e = new js_ast.EIf();
      e.Test = undumpExpr(m.test);
      e.Yes = undumpExpr(m.yes);
      e.No = undumpExpr(m.no);
      data = e;
      break;
    }
    case "EAnnotation": {
      const e = new js_ast.EAnnotation();
      e.Flags = m.flags;
      e.Value = undumpExpr(m.value);
      data = e;
      break;
    }
    case "EInlinedEnum": {
      const e = new js_ast.EInlinedEnum();
      e.Value = undumpExpr(m.value);
      e.Comment = m.comment;
      data = e;
      break;
    }
    case "EFunction": {
      const e = new js_ast.EFunction();
      e.Fn = undumpFn(m.fn);
      data = e;
      break;
    }
    case "EArrow": {
      const e = new js_ast.EArrow();
      const fn = undumpFn(m.fn);
      e.Args = fn.Args;
      e.Body = fn.Body;
      e.IsAsync = fn.IsAsync;
      e.PreferExpr = m.preferExpr;
      e.HasRestArg = m.hasRestArg;
      data = e;
      break;
    }
    case "EClass": {
      const e = new js_ast.EClass();
      e.Class = undumpClass(m.class);
      data = e;
      break;
    }
    case "EImportMeta": data = new js_ast.EImportMeta(); break;
    case "ETemplate": {
      const e = new js_ast.ETemplate();
      e.TagOrNil = undumpExpr(m.tag);
      e.HeadCooked = m.headCooked === null ? null : new Uint16Array(m.headCooked);
      e.Parts = m.parts.map((p: any) => {
        const part = new js_ast.TemplatePart();
        part.Value = undumpExpr(p.value);
        part.TailCooked = p.tailCooked === null ? null : new Uint16Array(p.tailCooked);
        return part;
      });
      e.CanBeUnwrappedIfUnused = m.canBeUnwrappedIfUnused;
      data = e;
      break;
    }
    default:
      throw new Error(`undump: 未知 kind ${m.kind}`);
  }
  return new js_ast.Expr(data, loc(m.loc));
}

function undumpProperty(m: any): js_ast.Property {
  const p = new js_ast.Property();
  p.Kind = m.kind;
  p.Flags = m.flags;
  p.Key = undumpExpr(m.key);
  p.ValueOrNil = undumpExpr(m.value);
  p.InitializerOrNil = undumpExpr(m.initializer);
  p.Loc = loc(m.loc);
  return p;
}

function undumpBinding(m: any): js_ast.Binding {
  let data: js_ast.B;
  switch (m.kind) {
    case "BIdentifier": data = new js_ast.BIdentifier(ref(symNames.indexOf(m.name))); break;
    case "BMissing": data = new js_ast.BMissing(); break;
    case "BArray": {
      const b = new js_ast.BArray();
      b.Items = m.items.map((it: any) => {
        const a = new js_ast.ArrayBinding();
        a.Binding = undumpBinding(it.binding);
        a.Loc = loc(it.loc);
        if (it.default !== undefined) a.DefaultValueOrNil = undumpExpr(it.default);
        return a;
      });
      b.HasSpread = m.hasSpread;
      b.IsSingleLine = m.isSingleLine;
      data = b;
      break;
    }
    case "BObject": {
      const b = new js_ast.BObject();
      b.Properties = m.properties.map((pm: any) => {
        const p = new js_ast.PropertyBinding();
        p.Key = undumpExpr(pm.key);
        p.Value = undumpBinding(pm.value);
        p.IsComputed = pm.isComputed;
        p.IsSpread = pm.isSpread;
        p.PreferQuotedKey = pm.preferQuotedKey;
        p.Loc = loc(pm.loc);
        if (pm.default !== undefined) p.DefaultValueOrNil = undumpExpr(pm.default);
        return p;
      });
      b.IsSingleLine = m.isSingleLine;
      data = b;
      break;
    }
    default:
      throw new Error(`undump binding: 未知 kind ${m.kind}`);
  }
  const result = new js_ast.Binding();
  result.Data = data;
  result.Loc = loc(m.loc);
  return result;
}

function undumpFn(m: any): js_ast.Fn {
  const fn = new js_ast.Fn();
  fn.IsAsync = m.isAsync;
  fn.IsGenerator = m.isGenerator;
  if (m.name !== null) {
    fn.Name = new LocRef(loc(m.nameLoc), ref(symNames.indexOf(m.name)));
  } else {
    fn.Name = null;
  }
  fn.Args = m.args.map((a: any) => {
    const arg = new js_ast.Arg();
    arg.Binding = undumpBinding(a.binding);
    if (a.default !== undefined) arg.DefaultOrNil = undumpExpr(a.default);
    return arg;
  });
  fn.Body.Block.Stmts = m.body.map(undumpStmt);
  return fn;
}

function undumpStmt(m: any): js_ast.Stmt {
  let data: js_ast.S;
  switch (m.kind) {
    case "SEmpty": data = new js_ast.SEmpty(); break;
    case "SExpr": {
      const s = new js_ast.SExpr();
      s.Value = undumpExpr(m.value);
      s.IsFromClassOrFnThatCanBeRemovedIfUnused = m.fromClassOrFn;
      data = s;
      break;
    }
    case "SReturn": {
      const s = new js_ast.SReturn();
      s.ValueOrNil = undumpExpr(m.value);
      data = s;
      break;
    }
    case "SBlock": {
      const s = new js_ast.SBlock();
      s.Stmts = m.stmts.map(undumpStmt);
      data = s;
      break;
    }
    case "SLocal": {
      const s = new js_ast.SLocal();
      s.Kind = m.localKind;
      s.Decls = m.decls.map((d: any) => {
        const decl = new js_ast.Decl();
        decl.Binding = undumpBinding(d.binding);
        decl.ValueOrNil = undumpExpr(d.value);
        return decl;
      });
      data = s;
      break;
    }
    case "SFunction": {
      const s = new js_ast.SFunction();
      s.Fn = undumpFn(m.fn);
      data = s;
      break;
    }
    case "SClass": {
      const s = new js_ast.SClass();
      s.Class = undumpClass(m.class);
      data = s;
      break;
    }
    case "SImport": data = new js_ast.SImport(); break;
    case "SExportFrom": data = new js_ast.SExportFrom(); break;
    case "SExportClause": data = new js_ast.SExportClause(); break;
    case "SExportDefault": {
      const s = new js_ast.SExportDefault();
      s.Value = undumpStmt(m.value);
      data = s;
      break;
    }
    case "STry": {
      const s = new js_ast.STry();
      s.Block.Stmts = m.block.map(undumpStmt);
      if (m.finally !== null) {
        const f = new js_ast.Finally();
        f.Block.Stmts = m.finally.map(undumpStmt);
        s.Finally = f;
      }
      data = s;
      break;
    }
    case "SFor": data = new js_ast.SFor(); break;
    case "SWhile": data = new js_ast.SWhile(); break;
    case "SDoWhile": data = new js_ast.SDoWhile(); break;
    default:
      throw new Error(`undump stmt: 未知 kind ${m.kind}`);
  }
  return new js_ast.Stmt(data, loc(m.loc));
}

function undumpClass(m: any): js_ast.Class {
  const c = new js_ast.Class();
  c.UseDefineForClassFields = m.useDefineForClassFields;
  c.ExtendsOrNil = undumpExpr(m.extends);
  c.Properties = m.properties.map((pm: any) => {
    if (pm.staticStmts !== undefined) {
      const p = new js_ast.Property();
      p.Kind = pm.kind;
      p.ClassStaticBlock = new js_ast.ClassStaticBlock();
      p.ClassStaticBlock.Block.Stmts = pm.staticStmts.map(undumpStmt);
      return p;
    }
    return undumpProperty(pm);
  });
  return c;
}

// ---------------------------------------------------------------------------
// dump：TS AST → 夹具 schema
// ---------------------------------------------------------------------------

function dumpExpr(e: js_ast.Expr): any {
  if (e.Data === null) return null;
  const m: any = { loc: e.Loc.Start };
  const d = e.Data;

  if (d instanceof js_ast.EIdentifier) {
    m.kind = "EIdentifier";
    m.name = symNames[d.Ref.InnerIndex];
    m.canBeRemovedIfUnused = d.CanBeRemovedIfUnused;
    m.mustKeepDueToWithStmt = d.MustKeepDueToWithStmt;
    m.callCanBeUnwrappedIfUnused = d.CallCanBeUnwrappedIfUnused;
  } else if (d instanceof js_ast.ENumber) {
    m.kind = "ENumber";
    m.bits = f64bits(d.Value);
  } else if (d instanceof js_ast.EBigInt) {
    m.kind = "EBigInt";
    m.value = d.Value;
  } else if (d instanceof js_ast.EString) {
    m.kind = "EString";
    m.value = utf16Ints(d.Value);
    m.preferTemplate = d.PreferTemplate;
  } else if (d instanceof js_ast.EBoolean) {
    m.kind = "EBoolean";
    m.value = d.Value;
  } else if (d instanceof js_ast.ENull) {
    m.kind = "ENull";
  } else if (d instanceof js_ast.EUndefined) {
    m.kind = "EUndefined";
  } else if (d instanceof js_ast.EThis) {
    m.kind = "EThis";
  } else if (d instanceof js_ast.EMissing) {
    m.kind = "EMissing";
  } else if (d instanceof js_ast.ERegExp) {
    m.kind = "ERegExp";
    m.value = d.Value;
  } else if (d instanceof js_ast.EUnary) {
    m.kind = "EUnary";
    m.op = d.Op;
    m.value = dumpExpr(d.Value);
    m.wasTypeof = d.WasOriginallyTypeofIdentifier;
  } else if (d instanceof js_ast.EBinary) {
    m.kind = "EBinary";
    m.op = d.Op;
    m.left = dumpExpr(d.Left);
    m.right = dumpExpr(d.Right);
  } else if (d instanceof js_ast.ECall) {
    m.kind = "ECall";
    m.target = dumpExpr(d.Target);
    m.args = d.Args.map(dumpExpr);
    m.optionalChain = d.OptionalChain;
    m.callKind = d.Kind;
    m.canBeUnwrappedIfUnused = d.CanBeUnwrappedIfUnused;
  } else if (d instanceof js_ast.EDot) {
    m.kind = "EDot";
    m.target = dumpExpr(d.Target);
    m.name = d.Name;
    m.optionalChain = d.OptionalChain;
    m.canBeRemovedIfUnused = d.CanBeRemovedIfUnused;
    m.isSymbolInstance = d.IsSymbolInstance;
    m.callCanBeUnwrappedIfUnused = d.CallCanBeUnwrappedIfUnused;
  } else if (d instanceof js_ast.EIndex) {
    m.kind = "EIndex";
    m.target = dumpExpr(d.Target);
    m.index = dumpExpr(d.Index);
    m.optionalChain = d.OptionalChain;
    m.canBeRemovedIfUnused = d.CanBeRemovedIfUnused;
    m.isSymbolInstance = d.IsSymbolInstance;
    m.callCanBeUnwrappedIfUnused = d.CallCanBeUnwrappedIfUnused;
  } else if (d instanceof js_ast.EArray) {
    m.kind = "EArray";
    m.items = d.Items.map(dumpExpr);
    m.isSingleLine = d.IsSingleLine;
  } else if (d instanceof js_ast.ESpread) {
    m.kind = "ESpread";
    m.value = dumpExpr(d.Value);
  } else if (d instanceof js_ast.EObject) {
    m.kind = "EObject";
    m.properties = d.Properties.map(dumpProperty);
    m.isSingleLine = d.IsSingleLine;
  } else if (d instanceof js_ast.EIf) {
    m.kind = "EIf";
    m.test = dumpExpr(d.Test);
    m.yes = dumpExpr(d.Yes);
    m.no = dumpExpr(d.No);
  } else if (d instanceof js_ast.EAnnotation) {
    m.kind = "EAnnotation";
    m.flags = d.Flags;
    m.value = dumpExpr(d.Value);
  } else if (d instanceof js_ast.EInlinedEnum) {
    m.kind = "EInlinedEnum";
    m.value = dumpExpr(d.Value);
    m.comment = d.Comment;
  } else if (d instanceof js_ast.EFunction) {
    m.kind = "EFunction";
    m.fn = dumpFn(d.Fn);
  } else if (d instanceof js_ast.EArrow) {
    m.kind = "EArrow";
    const fn = new js_ast.Fn();
    fn.Args = d.Args;
    fn.Body = d.Body;
    fn.IsAsync = d.IsAsync;
    m.fn = dumpFn(fn);
    m.preferExpr = d.PreferExpr;
    m.hasRestArg = d.HasRestArg;
  } else if (d instanceof js_ast.EClass) {
    m.kind = "EClass";
    m.class = dumpClass(d.Class);
  } else if (d instanceof js_ast.EImportMeta) {
    m.kind = "EImportMeta";
  } else if (d instanceof js_ast.ETemplate) {
    m.kind = "ETemplate";
    m.canBeUnwrappedIfUnused = d.CanBeUnwrappedIfUnused;
    m.tag = d.TagOrNil === null ? null : dumpExpr(d.TagOrNil);
    m.headCooked = d.HeadCooked === null ? null : utf16Ints(d.HeadCooked);
    m.parts = d.Parts.map((p) => ({
      value: dumpExpr(p.Value),
      tailCooked: p.TailCooked === null ? null : utf16Ints(p.TailCooked),
    }));
  } else {
    m.kind = "UNSUPPORTED";
  }
  return m;
}

function dumpProperty(p: js_ast.Property): any {
  return {
    kind: p.Kind,
    flags: p.Flags,
    loc: p.Loc.Start,
    key: dumpExpr(p.Key),
    value: p.ValueOrNil === null ? null : dumpExpr(p.ValueOrNil),
    initializer: p.InitializerOrNil === null ? null : dumpExpr(p.InitializerOrNil),
  };
}

function dumpFn(fn: js_ast.Fn): any {
  return {
    isAsync: fn.IsAsync,
    isGenerator: fn.IsGenerator,
    name: fn.Name === null ? null : symNames[fn.Name.Ref.InnerIndex],
    ...(fn.Name === null ? {} : { nameLoc: fn.Name.Loc.Start }),
    args: fn.Args.map((a) => {
      const m: any = { binding: dumpBinding(a.Binding) };
      if (a.DefaultOrNil !== null) m.default = dumpExpr(a.DefaultOrNil);
      return m;
    }),
    body: fn.Body.Block.Stmts.map(dumpStmt),
  };
}

function dumpBinding(b: js_ast.Binding): any {
  const m: any = { loc: b.Loc.Start };
  const d = b.Data;
  if (d instanceof js_ast.BIdentifier) {
    m.kind = "BIdentifier";
    m.name = symNames[d.Ref.InnerIndex];
  } else if (d instanceof js_ast.BMissing) {
    m.kind = "BMissing";
  } else if (d instanceof js_ast.BArray) {
    m.kind = "BArray";
    m.items = d.Items.map((it) => {
      const im: any = { binding: dumpBinding(it.Binding), loc: it.Loc.Start };
      if (it.DefaultValueOrNil !== null) im.default = dumpExpr(it.DefaultValueOrNil);
      return im;
    });
    m.hasSpread = d.HasSpread;
    m.isSingleLine = d.IsSingleLine;
  } else if (d instanceof js_ast.BObject) {
    m.kind = "BObject";
    m.properties = d.Properties.map((p) => {
      const pm: any = {
        key: dumpExpr(p.Key),
        value: dumpBinding(p.Value),
        isComputed: p.IsComputed,
        isSpread: p.IsSpread,
        preferQuotedKey: p.PreferQuotedKey,
        loc: p.Loc.Start,
      };
      if (p.DefaultValueOrNil !== null) pm.default = dumpExpr(p.DefaultValueOrNil);
      return pm;
    });
    m.isSingleLine = d.IsSingleLine;
  } else {
    m.kind = "UNSUPPORTED";
  }
  return m;
}

function dumpClass(c: js_ast.Class): any {
  return {
    useDefineForClassFields: c.UseDefineForClassFields,
    extends: c.ExtendsOrNil === null ? null : dumpExpr(c.ExtendsOrNil),
    properties: c.Properties.map((p) => {
      if (p.Kind === js_ast.PropertyKind.PropertyClassStaticBlock && p.ClassStaticBlock !== null) {
        return { kind: p.Kind, staticStmts: p.ClassStaticBlock.Block.Stmts.map(dumpStmt) };
      }
      return dumpProperty(p);
    }),
  };
}

function dumpStmt(s: js_ast.Stmt): any {
  const m: any = { loc: s.Loc.Start };
  const d = s.Data;
  if (d instanceof js_ast.SEmpty) {
    m.kind = "SEmpty";
  } else if (d instanceof js_ast.SExpr) {
    m.kind = "SExpr";
    m.value = dumpExpr(d.Value);
    m.fromClassOrFn = d.IsFromClassOrFnThatCanBeRemovedIfUnused;
  } else if (d instanceof js_ast.SReturn) {
    m.kind = "SReturn";
    m.value = d.ValueOrNil === null ? null : dumpExpr(d.ValueOrNil);
  } else if (d instanceof js_ast.SBlock) {
    m.kind = "SBlock";
    m.stmts = d.Stmts.map(dumpStmt);
  } else if (d instanceof js_ast.SLocal) {
    m.kind = "SLocal";
    m.localKind = d.Kind;
    m.decls = d.Decls.map((decl) => ({
      binding: dumpBinding(decl.Binding),
      value: decl.ValueOrNil === null ? null : dumpExpr(decl.ValueOrNil),
    }));
  } else if (d instanceof js_ast.SFunction) {
    m.kind = "SFunction";
    m.fn = dumpFn(d.Fn);
  } else if (d instanceof js_ast.SClass) {
    m.kind = "SClass";
    m.class = dumpClass(d.Class);
  } else if (d instanceof js_ast.SImport) {
    m.kind = "SImport";
  } else if (d instanceof js_ast.SExportFrom) {
    m.kind = "SExportFrom";
  } else if (d instanceof js_ast.SExportClause) {
    m.kind = "SExportClause";
  } else if (d instanceof js_ast.SExportDefault) {
    m.kind = "SExportDefault";
    m.value = dumpStmt(d.Value);
  } else if (d instanceof js_ast.STry) {
    m.kind = "STry";
    m.block = d.Block.Stmts.map(dumpStmt);
    m.finally = d.Finally === null ? null : d.Finally.Block.Stmts.map(dumpStmt);
  } else if (d instanceof js_ast.SFor) {
    m.kind = "SFor";
  } else if (d instanceof js_ast.SWhile) {
    m.kind = "SWhile";
  } else if (d instanceof js_ast.SDoWhile) {
    m.kind = "SDoWhile";
  } else {
    m.kind = "UNSUPPORTED";
  }
  return m;
}

// ---------------------------------------------------------------------------
// 构造器（与 Go 探针一一对应）
// ---------------------------------------------------------------------------

const num = (v: number) => new js_ast.Expr(new js_ast.ENumber(v), loc(1));
const str = (s: string) =>
  new js_ast.Expr(new js_ast.EString(new Uint16Array(Array.from(s, (c) => c.charCodeAt(0)))), loc(1));
const boolean = (v: boolean) => new js_ast.Expr(new js_ast.EBoolean(v), loc(1));
const ident = (i: number) => new js_ast.Expr(new js_ast.EIdentifier(ref(i)), loc(2));
const nullE = () => new js_ast.Expr(new js_ast.ENull(), loc(1));
const undefinedE = () => new js_ast.Expr(new js_ast.EUndefined(), loc(1));
const binary = (op: number, l: js_ast.Expr, r: js_ast.Expr) => {
  const e = new js_ast.EBinary();
  e.Op = op;
  e.Left = l;
  e.Right = r;
  return new js_ast.Expr(e, loc(4));
};
const call = (t: js_ast.Expr, ...args: js_ast.Expr[]) => {
  const e = new js_ast.ECall();
  e.Target = t;
  e.Args = args;
  return new js_ast.Expr(e, loc(5));
};
const dot = (t: js_ast.Expr, name: string) => {
  const e = new js_ast.EDot();
  e.Target = t;
  e.Name = name;
  return new js_ast.Expr(e, loc(5));
};
const array = (...items: js_ast.Expr[]) => {
  const e = new js_ast.EArray();
  e.Items = items;
  return new js_ast.Expr(e, loc(6));
};
const spread = (v: js_ast.Expr) => {
  const e = new js_ast.ESpread();
  e.Value = v;
  return new js_ast.Expr(e, loc(6));
};
const object = (...props: js_ast.Property[]) => {
  const e = new js_ast.EObject();
  e.Properties = props;
  return new js_ast.Expr(e, loc(6));
};
const ifE = (t: js_ast.Expr, y: js_ast.Expr, n: js_ast.Expr) => {
  const e = new js_ast.EIf();
  e.Test = t;
  e.Yes = y;
  e.No = n;
  return new js_ast.Expr(e, loc(7));
};
const prop = (
  kind: number,
  flags: number,
  key: js_ast.Expr,
  value: js_ast.Expr,
  init: js_ast.Expr,
): js_ast.Property => {
  const p = new js_ast.Property();
  p.Kind = kind;
  p.Flags = flags;
  p.Key = key;
  p.ValueOrNil = value.Data === null ? null : value;
  p.InitializerOrNil = init.Data === null ? null : init;
  return p;
};
const sExpr = (v: js_ast.Expr) =>
  new js_ast.Stmt(init(new js_ast.SExpr(), { Value: v }), loc(10));
const emptyExpr = () => new js_ast.Expr();

const ctx = helpers.MakeHelperContext((r) => r.InnerIndex < 2);
const noFeatures = 0n;

test("helpers 夹具不得缩水", () => {
  assert.equal(expected.exprs.length, 86);
  assert.equal(expected.folds.length, 25);
  assert.equal(expected.cmps.length, 13);
  assert.equal(expected.joins.length, 14);
  assert.equal(expected.bindings.length, 5);
  assert.equal(expected.stmts.length, 9);
  assert.equal(expected.classes.length, 8);
});

test("exprs：86 个表达式的谓词 / 变换与 Go 实测一致", () => {
  for (const c of expected.exprs) {
    const e = undumpExpr(c.dump);
    assert.deepEqual(dumpExpr(e), c.dump, `[${c.name}] undump 往返`);

    assert.equal(helpers.KnownPrimitiveType(e.Data), c.knownPrimitiveType, `[${c.name}] KnownPrimitiveType`);
    assert.equal(helpers.IsPrimitiveLiteral(e.Data), c.isPrimitiveLiteral, `[${c.name}] IsPrimitiveLiteral`);
    assert.equal(helpers.IsSymbolInstance(e.Data), c.isSymbolInstance, `[${c.name}] IsSymbolInstance`);
    assert.equal(helpers.IsPropertyAccess(e), c.isPropertyAccess, `[${c.name}] IsPropertyAccess`);
    assert.equal(helpers.IsOptionalChain(e), c.isOptionalChain, `[${c.name}] IsOptionalChain`);

    assert.deepEqual(helpers.TypeofWithoutSideEffects(e.Data), c.typeof, `[${c.name}] TypeofWithoutSideEffects`);

    const [numVal, numOk] = helpers.ToNumberWithoutSideEffects(e.Data);
    // NaN 的位模式在 Go（math.NaN() = 0x7FF8000000000001）与 V8（0x7FF8000000000000）不同，
    // 这是两套运行时的表示差异，不是移植行为差异；两边都是 NaN 时视为一致。
    const actualNumBits = f64bits(numVal);
    const expectedNumBits = c.toNumber[0];
    assert.ok(
      actualNumBits === expectedNumBits ||
        (Number.isNaN(bitsToF64(actualNumBits)) && Number.isNaN(bitsToF64(expectedNumBits))),
      `[${c.name}] ToNumberWithoutSideEffects`,
    );
    assert.equal(numOk, c.toNumber[1], `[${c.name}] ToNumberWithoutSideEffects ok`);
    assert.deepEqual(helpers.ToStringWithoutSideEffects(e.Data), c.toString, `[${c.name}] ToStringWithoutSideEffects`);

    const [boolVal, sideEffects, boolOk] = helpers.ToBooleanWithSideEffects(e.Data);
    assert.deepEqual([boolVal, sideEffects, boolOk], c.toBoolean, `[${c.name}] ToBooleanWithSideEffects`);

    const [nullVal, nullSide, nullOk] = helpers.ToNullOrUndefinedWithSideEffects(e.Data);
    assert.deepEqual([nullVal, nullSide, nullOk], c.toNullOrUndefined, `[${c.name}] ToNullOrUndefinedWithSideEffects`);

    assert.equal(ctx.ExprCanBeRemovedIfUnused(e), c.canBeRemoved, `[${c.name}] ExprCanBeRemovedIfUnused`);
    assert.deepEqual(dumpExpr(ctx.SimplifyUnusedExpr(e, noFeatures)), c.simplifyUnused, `[${c.name}] SimplifyUnusedExpr`);
    assert.deepEqual(dumpExpr(ctx.SimplifyBooleanExpr(e)), c.simplifyBoolean, `[${c.name}] SimplifyBooleanExpr`);
    assert.deepEqual(dumpExpr(helpers.Not(e)), c.not, `[${c.name}] Not`);
  }
});

test("folds：ShouldFoldBinaryOperatorWhenMinifying / FoldBinaryOperator", () => {
  for (const c of expected.folds) {
    const e = undumpExpr(c.dump);
    assert.deepEqual(dumpExpr(e), c.dump, `[${c.name}] undump 往返`);
    const b = e.Data as js_ast.EBinary;
    assert.equal(helpers.ShouldFoldBinaryOperatorWhenMinifying(b), c.shouldFold, `[${c.name}] shouldFold`);
    assert.deepEqual(dumpExpr(helpers.FoldBinaryOperator(e.Loc, b)), c.folded, `[${c.name}] folded`);
  }
});

test("cmps：CheckEqualityIfNoSideEffects / ValuesLookTheSame / CanChangeStrictToLoose", () => {
  const kinds: number[] = [];
  for (const c of expected.cmps) {
    const l = undumpExpr(c.l);
    const r = undumpExpr(c.r);
    // 夹具里 kind 没有单独存：用名字后缀区分 strict/loose
    const kind = c.name.endsWith("-loose") ? helpers.LooseEquality : helpers.StrictEquality;
    kinds.push(kind);
    assert.deepEqual([...helpers.CheckEqualityIfNoSideEffects(l.Data, r.Data, kind)], c.equality, `[${c.name}] equality`);
    assert.equal(helpers.ValuesLookTheSame(l.Data, r.Data), c.lookSame, `[${c.name}] lookSame`);
    assert.equal(helpers.CanChangeStrictToLoose(l, r), c.canStrictToLoose, `[${c.name}] canStrictToLoose`);
  }
  assert.equal(kinds.length, 13);
});

test("scalars：ToInt32 / ToUint32 / approximatePrintedIntCharCount / StringToEquivalentNumberValue / TryToStringOnNumberSafely", () => {
  const f64s = [0, -0, 1, -1, 0.5, 2147483647, 2147483648, -2147483648, 4294967295, 4294967296, 1e20, -1e20, NaN, Infinity, -Infinity, 3.7, -3.7];
  const s = expected.scalars;
  assert.deepEqual(f64s.map(helpers.ToInt32), s.int32, "ToInt32");
  assert.deepEqual(f64s.map(helpers.ToUint32), s.uint32, "ToUint32");
  assert.deepEqual(f64s.map((x) => Number.isFinite(x) ? helpers.approximatePrintedIntCharCount(x) : null), s.approx, "approximatePrintedIntCharCount");

  const strs = ["", "0", "1", "-5", "123", "1a", "-0", "01", "999999999999"];
  assert.deepEqual(
    strs.map((x) => {
      const [v, ok] = helpers.StringToEquivalentNumberValue(new Uint16Array(Array.from(x, (c) => c.charCodeAt(0))));
      return [f64bits(v), ok];
    }),
    s.numFromStr,
    "StringToEquivalentNumberValue",
  );

  assert.deepEqual(
    f64s.map((x) => {
      const [v, ok] = helpers.TryToStringOnNumberSafely(x, 10);
      return [v, ok];
    }),
    s.toString,
    "TryToStringOnNumberSafely",
  );
});

test("joins：拼接 / 折叠 / mangle 与 Go 实测一致", () => {
  const tmpl = (head: string, parts: js_ast.TemplatePart[]) => {
    const e = new js_ast.ETemplate();
    e.HeadCooked = new Uint16Array(Array.from(head, (c) => c.charCodeAt(0)));
    e.Parts = parts;
    return new js_ast.Expr(e, loc(11));
  };
  const part = (value: js_ast.Expr, tail: string | null) => {
    const p = new js_ast.TemplatePart();
    p.Value = value;
    p.TailCooked = tail === null ? null : new Uint16Array(Array.from(tail, (c) => c.charCodeAt(0)));
    return p;
  };

  const actual = new Map<string, js_ast.Expr>([
    ["join-comma", helpers.JoinWithComma(num(1), num(2))],
    ["join-comma-nil-left", helpers.JoinWithComma(emptyExpr(), num(2))],
    ["join-comma-nil-right", helpers.JoinWithComma(num(1), emptyExpr())],
    ["join-all", helpers.JoinAllWithComma([num(1), num(2), num(3)])],
    ["join-left-assoc", helpers.JoinWithLeftAssociativeOp(js_ast.OpCode.BinOpAdd, num(1), binary(js_ast.OpCode.BinOpAdd, num(2), num(3)))],
    ["join-left-assoc-comma", helpers.JoinWithLeftAssociativeOp(js_ast.OpCode.BinOpAdd, binary(js_ast.OpCode.BinOpComma, num(1), num(2)), num(3))],
    ["assign", helpers.Assign(ident(2), num(1))],
    ["fold-string-add", helpers.FoldStringAddition(str("a"), num(1), helpers.StringAdditionNormal)],
    ["fold-string-add-template", helpers.FoldStringAddition(str("a"), tmpl("b", [part(ident(2), null)]), helpers.StringAdditionNormal)],
    ["inline-template", helpers.InlinePrimitivesIntoTemplate(loc(11), (() => {
      const e = new js_ast.ETemplate();
      e.HeadCooked = new Uint16Array(Array.from("a", (c) => c.charCodeAt(0)));
      e.Parts = [part(str("b"), "c")];
      return e;
    })())],
    ["mangle-object-spread", (() => {
      const e = new js_ast.EObject();
      e.Properties = helpers.MangleObjectSpread([
        prop(js_ast.PropertyKind.PropertySpread, 0, emptyExpr(), object(prop(js_ast.PropertyKind.PropertyField, 0, str("k"), num(1), emptyExpr())), emptyExpr()),
      ]);
      return new js_ast.Expr(e, loc(6));
    })()],
    ["mangle-if-call", (() => {
      const e = ifE(ident(2), call(ident(3), num(1), num(2)), call(ident(3), num(3), num(2)));
      return ctx.MangleIfExpr(e.Loc, e.Data as js_ast.EIf, noFeatures);
    })()],
    ["mangle-if-nullish", (() => {
      const e = ifE(binary(js_ast.OpCode.BinOpLooseNe, ident(2), nullE()), ident(2), undefinedE());
      return ctx.MangleIfExpr(e.Loc, e.Data as js_ast.EIf, noFeatures);
    })()],
    ["mangle-if-same", (() => {
      const e = ifE(ident(2), num(1), num(1));
      return ctx.MangleIfExpr(e.Loc, e.Data as js_ast.EIf, noFeatures);
    })()],
  ]);

  for (const c of expected.joins) {
    assert.deepEqual(dumpExpr(actual.get(c.name)!), c.dump, `[${c.name}]`);
  }
  assert.equal(actual.size, 14);
});

test("bindings：ConvertBindingToExpr / ForEachIdentifierBinding", () => {
  for (const c of expected.bindings) {
    const b = undumpBinding(c.dump);
    assert.deepEqual(dumpBinding(b), c.dump, `[${c.name}] undump 往返`);

    const wrap = (l: Loc, r: Ref) => {
      const e = new js_ast.EIdentifier(r);
      e.CanBeRemovedIfUnused = true;
      return new js_ast.Expr(e, l);
    };
    assert.deepEqual(dumpExpr(helpers.ConvertBindingToExpr(b, wrap)), c.asExpr, `[${c.name}] ConvertBindingToExpr`);

    const idents: unknown[] = [];
    helpers.ForEachIdentifierBinding(b, (l, id) => {
      idents.push([l.Start, symNames[id.Ref.InnerIndex]]);
    });
    assert.deepEqual(idents, c.idents, `[${c.name}] ForEachIdentifierBinding`);
  }
});

test("stmts / classes：StmtsCanBeRemovedIfUnused / ClassCanBeRemovedIfUnused", () => {
  for (const c of expected.stmts) {
    const stmts = c.dump.map(undumpStmt);
    assert.deepEqual(stmts.map(dumpStmt), c.dump, `[${c.name}] undump 往返`);
    assert.equal(ctx.StmtsCanBeRemovedIfUnused(stmts, 0), c.canRemove, `[${c.name}] canRemove`);
  }
  for (const c of expected.classes) {
    const cls = undumpClass(c.dump);
    assert.deepEqual(dumpClass(cls), c.dump, `[${c.name}] undump 往返`);
    assert.equal(ctx.ClassCanBeRemovedIfUnused(cls), c.canRemove, `[${c.name}] canRemove`);
  }
});

test("misc：IsBinaryNullAndUndefined / TryToInsertOptionalChain / InlineSpreadsOfArrayLiterals", () => {
  const byName = new Map(expected.misc.map((m: any) => [m.name, m.dump]));

  {
    const [l, r, ok] = helpers.IsBinaryNullAndUndefined(
      binary(js_ast.OpCode.BinOpLooseEq, ident(2), nullE()),
      binary(js_ast.OpCode.BinOpLooseEq, ident(2), undefinedE()),
      js_ast.OpCode.BinOpLogicalOr,
    );
    assert.deepEqual([dumpExpr(l), dumpExpr(r), ok], byName.get("is-binary-null-undefined"));
  }
  {
    const target = dot(ident(2), "b");
    const inserted = helpers.TryToInsertOptionalChain(ident(2), target);
    assert.deepEqual([inserted, dumpExpr(target)], byName.get("try-insert-optional-chain"));
  }
  {
    const items = helpers.InlineSpreadsOfArrayLiterals([
      spread(array(num(1), new js_ast.Expr(new js_ast.EMissing(), loc(1)))),
      ident(2),
    ]);
    const e = new js_ast.EArray();
    e.Items = items;
    assert.deepEqual(dumpExpr(new js_ast.Expr(e, loc(6))), byName.get("inline-spreads"));
  }
});

test("idents：js_ident 10 个函数与 Go 实测一致", () => {
  const utf16Of = (s: string): number[] => {
    const out: number[] = [];
    for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return out;
  };
  const hex = (b: Uint8Array): string => Array.from(b, (c) => c.toString(16).padStart(2, "0")).join("");

  const inputs = [
    "", "a", "_", "$", "0", "1a", "a-b", "π", "日本語", "a\u200c", "\u200c", "a\u200d",
    "𝕒", "℘", "a\u0301", "é", "z9", "Z_", "with space", "await",
  ];
  assert.equal(expected.idents.length, inputs.length);

  for (let i = 0; i < inputs.length; i++) {
    const s = inputs[i];
    const c = expected.idents[i];
    assert.equal(c.name, s, "夹具顺序必须与输入一致");
    assert.deepEqual(c.utf16, utf16Of(s), `[${s}] utf16 输入一致性`);

    const bytes = new TextEncoder().encode(s);
    assert.equal(js_ident.IsIdentifier(bytes), c.isIdentifier, `[${s}] IsIdentifier`);
    assert.equal(js_ident.IsIdentifierES5AndESNext(bytes), c.isES5, `[${s}] IsIdentifierES5AndESNext`);

    const utf16 = new Uint16Array(utf16Of(s));
    assert.equal(js_ident.IsIdentifierUTF16(utf16), c.isIdentifierUTF16, `[${s}] IsIdentifierUTF16`);
    assert.equal(js_ident.IsIdentifierES5AndESNextUTF16(utf16), c.isES5UTF16, `[${s}] IsIdentifierES5AndESNextUTF16`);

    assert.equal(hex(js_ident.ForceValidIdentifier(new TextEncoder().encode("#"), bytes)), c.forcedHex, `[${s}] ForceValidIdentifier(#)`);
    assert.equal(hex(js_ident.ForceValidIdentifier(new Uint8Array(0), bytes)), c.forcedNoPrefixHex, `[${s}] ForceValidIdentifier()`);
  }

  assert.equal(expected.codepoints.length, 11);
  for (const c of expected.codepoints) {
    assert.equal(js_ident.IsIdentifierStart(c.cp), c.start, `[U+${c.cp.toString(16)}] Start`);
    assert.equal(js_ident.IsIdentifierStartES5AndESNext(c.cp), c.startES5, `[U+${c.cp.toString(16)}] StartES5`);
    assert.equal(js_ident.IsIdentifierContinue(c.cp), c.continue, `[U+${c.cp.toString(16)}] Continue`);
    assert.equal(js_ident.IsIdentifierContinueES5AndESNext(c.cp), c.continueES5, `[U+${c.cp.toString(16)}] ContinueES5`);
  }
});

test("extras：AssignStmt / MaybeSimplifyEqualityComparison / isInt32OrUint32 / ForEachIdentifierBindingInDecls", () => {
  const byName = new Map(expected.extras.map((m: any) => [m.name, m]));
  assert.equal(byName.size, 7);

  const unaryOf = (op: number, v: js_ast.Expr) => {
    const e = new js_ast.EUnary();
    e.Op = op;
    e.Value = v;
    return new js_ast.Expr(e, loc(3));
  };
  const bIdentOf = (i: number) => {
    const b = new js_ast.Binding();
    b.Loc = loc(2);
    b.Data = new js_ast.BIdentifier(ref(i));
    return b;
  };
  const bObjectOf = (...props: js_ast.PropertyBinding[]) => {
    const b = new js_ast.Binding();
    b.Loc = loc(2);
    const o = new js_ast.BObject();
    o.Properties = props;
    b.Data = o;
    return b;
  };

  assert.deepEqual(dumpStmt(helpers.AssignStmt(ident(2), num(1))), byName.get("assign-stmt")!.dump, "AssignStmt");

  const eqCases: [string, js_ast.Expr][] = [
    ["eq-bool", binary(js_ast.OpCode.BinOpStrictEq, unaryOf(js_ast.OpCode.UnOpNot, ident(2)), boolean(true))],
    ["eq-typeof-undefined", binary(js_ast.OpCode.BinOpLooseEq, unaryOf(js_ast.OpCode.UnOpTypeof, ident(2)), str("undefined"))],
  ];
  for (const [name, e] of eqCases) {
    const [v, ok] = helpers.MaybeSimplifyEqualityComparison(e.Loc, e.Data as js_ast.EBinary, 0n);
    const want = byName.get(`eqsimplify-${name}`)!;
    assert.deepEqual(dumpExpr(v), want.dump, `[${name}] dump`);
    assert.equal(ok, want.ok, `[${name}] ok`);
  }

  const int32Cases: [string, js_ast.Expr][] = [
    ["ushr", binary(js_ast.OpCode.BinOpUShr, num(1), num(2))],
    ["logical-or-ushr", binary(js_ast.OpCode.BinOpLogicalOr, binary(js_ast.OpCode.BinOpUShr, num(1), num(2)), binary(js_ast.OpCode.BinOpUShr, num(3), num(4)))],
    ["add", binary(js_ast.OpCode.BinOpAdd, num(1), num(2))],
  ];
  for (const [name, e] of int32Cases) {
    assert.equal(helpers.isInt32OrUint32(e.Data), byName.get(`isint32-${name}`)!.b, `[${name}] isInt32OrUint32`);
  }

  const decls: js_ast.Decl[] = [];
  {
    const d = new js_ast.Decl();
    d.Binding = bIdentOf(2);
    d.ValueOrNil = num(1);
    decls.push(d);
  }
  {
    const p = new js_ast.PropertyBinding();
    p.Key = str("k");
    p.Value = bIdentOf(3);
    p.Loc = loc(2);
    const d = new js_ast.Decl();
    d.Binding = bObjectOf(p);
    d.ValueOrNil = num(1);
    decls.push(d);
  }
  const idents: unknown[] = [];
  helpers.ForEachIdentifierBindingInDecls(decls, (l, b) => {
    idents.push([l.Start, symNames[b.Ref.InnerIndex]]);
  });
  assert.deepEqual(idents, byName.get("foreach-decls")!.idents, "ForEachIdentifierBindingInDecls");
});
