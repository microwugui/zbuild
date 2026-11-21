// js_ast 类型层差分测试。
//
// 期望值全部来自 Go 实测：`testdata/js_ast/enums.json` 由 /root/esbuild 里的临时程序
// `tmpastdump` 生成（第 12 次推进），内容是：
//   - 每个 const 块的 `名字 → 数值`（名字经 `int(js_ast.X)` 转换，由 Go 编译器校验）
//   - 每个 OpCode 的 6 个判定函数、PropertyKind/LocalKind/ScopeKind/ExportsKind/ModuleType 的判定
//   - PropertyFlags.Has / AnnotationFlags.Has 的 8×8 真值表
//   - `types.E/S/B`：哪些类型实现了 Expr/Stmt/Binding 接口（由 shell 从 Go 源机械提取方法声明，
//     再由 Go 编译器校验；reflect 只用来取类型名）
//   - EnsureValidIdentifier、OpTable（53 项）
//
// 注意：这个文件里**没有手写的期望值**。改断言 = 造假，只能修实现。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as js_ast from "./js_ast.ts";
import { Loc } from "../logger/logger.ts";

interface Probe {
  enums: Record<string, Record<string, number>>;
  opBehavior: {
    op: number;
    isPrefix: boolean;
    unaryAssignTarget: number;
    isLeftAssociative: boolean;
    isRightAssociative: boolean;
    binaryAssignTarget: number;
    isShortCircuit: boolean;
  }[];
  propertyKind: { kind: number; isMethodDefinition: boolean }[];
  hasTable: { flags: number; flag: number; result: boolean }[];
  localKind: { kind: number; isUsing: boolean }[];
  scopeKind: { kind: number; stopsHoisting: boolean }[];
  exportsKind: { kind: number; isDynamic: boolean }[];
  moduleType: { kind: number; isCommonJS: boolean; isESM: boolean }[];
  types: { E: string[]; S: string[]; B: string[]; TSNamespaceMemberData: string[] };
  ensureValidIdentifier: { in: string; out: string }[];
  opTableLen: number;
  opTable: { text: string; level: number; isKeyword: boolean }[];
}

const probe: Probe = JSON.parse(
  readFileSync(new URL("../../../testdata/js_ast/enums.json", import.meta.url), "utf8"),
);

test("enum 名字→数值 与 Go 逐个相等", () => {
  const groups = Object.keys(probe.enums);
  assert.ok(groups.length >= 14, `夹具里只有 ${groups.length} 组枚举`);
  for (const group of groups) {
    const expected = probe.enums[group];
    const actual = (js_ast as unknown as Record<string, Record<string, number>>)[group];
    assert.ok(actual, `js_ast 缺少枚举 ${group}`);
    assert.deepEqual(
      Object.fromEntries(Object.keys(expected).sort().map((k) => [k, actual[k]])),
      Object.fromEntries(Object.keys(expected).sort().map((k) => [k, expected[k]])),
      `枚举 ${group} 的名字或数值不一致`,
    );
  }
});

test("OpCode 的 6 个判定函数（Go 全 53 个值）", () => {
  assert.equal(probe.opBehavior.length, 53);
  for (const e of probe.opBehavior) {
    const op = e.op;
    assert.equal(js_ast.IsPrefix(op), e.isPrefix, `IsPrefix(${op})`);
    assert.equal(js_ast.UnaryAssignTarget(op), e.unaryAssignTarget, `UnaryAssignTarget(${op})`);
    assert.equal(js_ast.IsLeftAssociative(op), e.isLeftAssociative, `IsLeftAssociative(${op})`);
    assert.equal(js_ast.IsRightAssociative(op), e.isRightAssociative, `IsRightAssociative(${op})`);
    assert.equal(js_ast.BinaryAssignTarget(op), e.binaryAssignTarget, `BinaryAssignTarget(${op})`);
    assert.equal(js_ast.IsShortCircuit(op), e.isShortCircuit, `IsShortCircuit(${op})`);
  }
});

test("PropertyKind.IsMethodDefinition 与 Go 相同", () => {
  for (const e of probe.propertyKind) {
    assert.equal(js_ast.IsMethodDefinition(e.kind), e.isMethodDefinition, `kind=${e.kind}`);
  }
});

test("PropertyFlags.Has / AnnotationFlags.Has 的 8×8 真值表（Go 实测）", () => {
  assert.equal(probe.hasTable.length, 8 * 8 * 2);
  for (const e of probe.hasTable) {
    assert.equal(js_ast.Has(e.flags, e.flag), e.result, `Has(${e.flags}, ${e.flag})`);
  }
});

test("LocalKind.IsUsing / ScopeKind.StopsHoisting / ExportsKind.IsDynamic / ModuleType.*", () => {
  for (const e of probe.localKind) {
    assert.equal(js_ast.IsUsing(e.kind), e.isUsing, `IsUsing(${e.kind})`);
  }
  for (const e of probe.scopeKind) {
    assert.equal(js_ast.StopsHoisting(e.kind), e.stopsHoisting, `StopsHoisting(${e.kind})`);
  }
  for (const e of probe.exportsKind) {
    assert.equal(js_ast.IsDynamic(e.kind), e.isDynamic, `IsDynamic(${e.kind})`);
  }
  for (const e of probe.moduleType) {
    assert.equal(js_ast.IsCommonJS(e.kind), e.isCommonJS, `IsCommonJS(${e.kind})`);
    assert.equal(js_ast.IsESM(e.kind), e.isESM, `IsESM(${e.kind})`);
  }
});

test("Expr/Stmt/Binding 的类型集合与 Go 的方法集一致，且每个 is* 标记都真的被调用", () => {
  const exported = (js_ast as unknown as Record<string, unknown>);
  const classesOf = (base: Function): string[] =>
    Object.entries(exported)
      .filter(([, v]) => typeof v === "function" && (v as Function).prototype instanceof base)
      .map(([k]) => k)
      .sort();

  const actualE = classesOf(js_ast.E);
  const actualS = classesOf(js_ast.S);
  const actualB = classesOf(js_ast.B);

  assert.deepEqual(actualE, [...probe.types.E].sort(), "Expr 类型集合");
  assert.deepEqual(actualS, [...probe.types.S].sort(), "Stmt 类型集合");
  assert.deepEqual(actualB, [...probe.types.B].sort(), "Binding 类型集合");

  for (const name of actualE) {
    const ctor = exported[name] as new () => js_ast.E;
    const instance = new ctor();
    assert.ok(instance instanceof js_ast.E);
    assert.equal(instance.isExpr(), undefined);
    assert.ok(!(instance instanceof js_ast.S) && !(instance instanceof js_ast.B), `${name} 不应同时是 Stmt/Binding`);
  }
  for (const name of actualS) {
    const ctor = exported[name] as new () => js_ast.S;
    const instance = new ctor();
    assert.equal(instance.isStmt(), undefined);
    assert.ok(!(instance instanceof js_ast.E), `${name} 不应同时是 Expr`);
  }
  for (const name of actualB) {
    const ctor = exported[name] as new () => js_ast.B;
    const instance = new ctor();
    assert.equal(instance.isBinding(), undefined);
  }
});

test("TSNamespaceMemberData 的类型集合与 Go 的方法集一致", () => {
  const exported = js_ast as unknown as Record<string, unknown>;
  const actual = Object.entries(exported)
    .filter(([, v]) => typeof v === "function" && (v as Function).prototype instanceof js_ast.TSNamespaceMemberData)
    .map(([k]) => k)
    .sort();
  assert.deepEqual(actual, [...probe.types.TSNamespaceMemberData].sort());

  for (const name of actual) {
    const ctor = exported[name] as new () => js_ast.TSNamespaceMemberData;
    assert.equal(new ctor().isTSNamespaceMember(), undefined, name);
  }
});

test("EnsureValidIdentifier 与 Go 逐例相同（含非 ASCII / 数字开头 / 空串）", () => {
  assert.ok(probe.ensureValidIdentifier.length >= 15);
  for (const e of probe.ensureValidIdentifier) {
    assert.equal(js_ast.EnsureValidIdentifier(e.in), e.out, `EnsureValidIdentifier(${JSON.stringify(e.in)})`);
  }
});

// 第 16 次推进：两个 import 命名前置函数。期望值来自 Go 探针 tmpgenpaths16（真实调用
// js_ast.GenerateNonUniqueNameFromPath / logger.PlatformIndependentPathDirBaseExt）。
const pathsFixture = JSON.parse(
  readFileSync(new URL("../../../testdata/js_ast/paths.json", import.meta.url), "utf8"),
) as {
  generateNonUniqueNameFromPath: { in: string; out: string }[];
  platformIndependentPathDirBaseExt: { in: string; dir: string; base: string; ext: string }[];
};

test("GenerateNonUniqueNameFromPath 与 Go 逐例相同（含 index / Windows / 非 ASCII）", () => {
  assert.ok(pathsFixture.generateNonUniqueNameFromPath.length >= 30);
  for (const e of pathsFixture.generateNonUniqueNameFromPath) {
    assert.equal(js_ast.GenerateNonUniqueNameFromPath(e.in), e.out, `GenerateNonUniqueNameFromPath(${JSON.stringify(e.in)})`);
  }
});

test("OpTable 53 项与 Go 逐项相同", () => {
  assert.equal(js_ast.OpTable.length, probe.opTableLen);
  assert.equal(probe.opTable.length, probe.opTableLen);
  for (let i = 0; i < probe.opTable.length; i++) {
    assert.equal(js_ast.OpTable[i].Text, probe.opTable[i].text, `OpTable[${i}].Text`);
    assert.equal(js_ast.OpTable[i].Level, probe.opTable[i].level, `OpTable[${i}].Level`);
    assert.equal(js_ast.OpTable[i].IsKeyword, probe.opTable[i].isKeyword, `OpTable[${i}].IsKeyword`);
  }
});

test("结构体零值与 Go 的零值语义一致（指针字段是 null、切片是空数组、Loc 归零）", () => {
  const expr = new js_ast.Expr();
  assert.equal(expr.Data, null);
  assert.equal(expr.Loc.Start, 0);

  const stmt = new js_ast.Stmt();
  assert.equal(stmt.Data, null);

  const fn = new js_ast.Fn();
  assert.equal(fn.Name, null);
  assert.deepEqual(fn.Args, []);
  assert.equal(fn.ArgumentsRef.SourceIndex, 0);
  assert.equal(fn.OpenParenLoc.Start, 0);

  const cls = new js_ast.Class();
  assert.equal(cls.Name, null);
  assert.equal(cls.ExtendsOrNil, null);
  assert.deepEqual(cls.Properties, []);

  const scope = new js_ast.Scope();
  assert.equal(scope.Parent, null);
  assert.equal(scope.Members.size, 0);
  assert.equal(scope.StrictMode, js_ast.StrictModeKind.SloppyMode);

  const template = new js_ast.ETemplate();
  assert.equal(template.TagOrNil, null);
  assert.equal(template.HeadCooked, null, "Go 的 nil []uint16 必须保持 null");
  assert.deepEqual(template.Parts, []);
});

test("共享实例与 Go 的共享变量一致（BMissingShared/EMissingShared/...）", () => {
  assert.ok(js_ast.BMissingShared instanceof js_ast.BMissing);
  assert.ok(js_ast.EMissingShared instanceof js_ast.EMissing);
  assert.ok(js_ast.ENullShared instanceof js_ast.ENull);
  assert.ok(js_ast.ESuperShared instanceof js_ast.ESuper);
  assert.ok(js_ast.EThisShared instanceof js_ast.EThis);
  assert.ok(js_ast.EUndefinedShared instanceof js_ast.EUndefined);
  assert.ok(js_ast.SDebuggerShared instanceof js_ast.SDebugger);
  assert.ok(js_ast.SEmptyShared instanceof js_ast.SEmpty);
  assert.equal(js_ast.STypeScriptShared.WasDeclareClass, false);
  assert.equal(js_ast.STypeScriptSharedWasDeclareClass.WasDeclareClass, true);
});

test("Scope.RecursiveSetStrictMode 与 Go 的递归语义相同（只覆盖 SloppyMode 子树）", () => {
  const root = new js_ast.Scope();
  const child = new js_ast.Scope();
  const grandChild = new js_ast.Scope();
  const strictChild = new js_ast.Scope();
  strictChild.StrictMode = js_ast.StrictModeKind.ExplicitStrictMode;

  root.Children.push(child, strictChild);
  child.Children.push(grandChild);

  root.RecursiveSetStrictMode(js_ast.StrictModeKind.ImplicitStrictModeESM);
  assert.equal(root.StrictMode, js_ast.StrictModeKind.ImplicitStrictModeESM);
  assert.equal(child.StrictMode, js_ast.StrictModeKind.ImplicitStrictModeESM);
  assert.equal(grandChild.StrictMode, js_ast.StrictModeKind.ImplicitStrictModeESM);
  assert.equal(strictChild.StrictMode, js_ast.StrictModeKind.ExplicitStrictMode, "非 SloppyMode 不得被覆盖");
});

test("HasSameFlagsAs 三处只比较各自的 flag 位（Go: ECall/EDot/EIndex）", () => {
  const a = new js_ast.ECall();
  const b = new js_ast.ECall();
  assert.equal(a.HasSameFlagsAs(b), true);
  b.OptionalChain = js_ast.OptionalChain.OptionalChainStart;
  assert.equal(a.HasSameFlagsAs(b), false);
  b.OptionalChain = js_ast.OptionalChain.OptionalChainNone;
  b.CanBeUnwrappedIfUnused = true;
  assert.equal(a.HasSameFlagsAs(b), false);

  // 不相关的字段（Args/Loc）不影响判定
  const d1 = new js_ast.EDot();
  const d2 = new js_ast.EDot();
  d2.Name = "x";
  d2.Target = new js_ast.Expr(new js_ast.ENumber(1), new Loc(3));
  assert.equal(d1.HasSameFlagsAs(d2), true);

  const i1 = new js_ast.EIndex();
  const i2 = new js_ast.EIndex();
  i2.IsSymbolInstance = true;
  assert.equal(i1.HasSameFlagsAs(i2), false);
});
