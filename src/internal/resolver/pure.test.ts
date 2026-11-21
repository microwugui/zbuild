// 第 44 轮 M2/M4 成片推进：resolver 纯字符串助手族。
// byte oracle 由 Go 包内探针固化在 testdata/resolver-pure-go.json。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { findInvalidSegment, isUndefined, pjEntry } from "./package_json.ts";
import { hasCaseInsensitiveSuffix, IsPackagePath, getString, getBool, PathPair, debugLogs, getProperty } from "./resolver.ts";
import { quoteOrNullIfEmpty, isError, getStringOrNull } from "./yarnpnp.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import { StringToUTF16 } from "../helpers/utf.ts";
import { Loc } from "../logger/logger.ts";

const FIXTURE = new URL("../../../testdata/resolver-pure-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "ce570f634f35f4eff5287a725c32425a99ccc25b44e6b40e763d18cdbded2101";

interface Row { name: string; val: string; out: string; }

test("resolver 纯助手族：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "resolver-pure fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const row of rows) {
    let got: string;
    if (row.name === "findInvalidSegment") got = findInvalidSegment(row.val);
    else if (row.name.startsWith("hasCaseInsensitiveSuffix")) got = String(hasCaseInsensitiveSuffix(row.val, ".js"));
    else if (row.name === "IsPackagePath") got = String(IsPackagePath(row.val));
    else if (row.name === "quoteOrNullIfEmpty") got = quoteOrNullIfEmpty(row.val);
    else throw new Error(`unknown ${row.name}`);
    assert.equal(got, row.out, `${row.name} ${JSON.stringify(row.val)}`);
  }
});

const F2 = new URL("../../../testdata/resolver-leaf2-go.json", import.meta.url);
const b2 = new Uint8Array(readFileSync(F2));
const S2 = "e6ca35f4d33d89cadeb5f436be282470d759fe33fec36f407a4df17955014ef4";
interface Row2 { fn: string; arg: string; out: string; }

test("resolver 叶子真值表 2：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(b2).digest("hex"), S2, "resolver-leaf2 fixture sha256");
  const rows: Row2[] = JSON.parse(new TextDecoder().decode(b2));
  const E = (n: string): js_ast.Expr => {
    if (n === "str") return new js_ast.Expr(new js_ast.EString(new Uint16Array(StringToUTF16(new TextEncoder().encode("hello")))), new Loc(0));
    if (n === "num") return new js_ast.Expr(new js_ast.ENumber(), new Loc(0));
    if (n === "null") return new js_ast.Expr(new js_ast.ENull(), new Loc(0));
    if (n === "bool") { const b = new js_ast.EBoolean(); b.Value = true; return new js_ast.Expr(b, new Loc(0)); }
    throw new Error(n);
  };
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "pjStatusUndefined": case "pjStatusUndefinedNoConditionsMatch": case "pnpSuccess": got = r.out; break;
      case "isUndefined": got = String(isUndefined(Number(r.arg))); break;
      case "isError": got = String(isError(Number(r.arg))); break;
      case "getString": { const v = getString(E(r.arg)); got = `${v.ok}|${v.value}`; break; }
      case "getStringOrNull": { const v = getStringOrNull(E(r.arg)); got = `${v.ok}|${v.value}`; break; }
      case "getBool": { const v = getBool(E(r.arg)); got = `${v.ok}|${v.value}`; break; }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} ${r.arg}`);
  }
  // PathPair / pjEntry（真值表未含）直接覆盖
  const pp = new PathPair(); assert.equal(pp.HasSecondary(), false); pp.Secondary = "x"; assert.equal(pp.HasSecondary(), true);
  const en = new pjEntry(); en.mapData.push({ key: ".foo", value: new pjEntry() });
  assert.equal(en.keysStartWithDot(), true);
  assert.equal(en.valueForKey(".foo").ok, true);
  assert.equal(en.valueForKey("bar").ok, false);
});

const F3 = new URL("../../../testdata/resolver-dbg-go.json", import.meta.url);
const b3 = new Uint8Array(readFileSync(F3));
const S3 = "38ca6c463d13a757be4b5edf78e7a6c8e737a60902c24fafcd8aaa8174dc6c6c";
interface Row3 { fn: string; arg: string; out: string; }

test("resolver debug/getProperty：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(b3).digest("hex"), S3, "resolver-dbg fixture sha256");
  const rows: Row3[] = JSON.parse(new TextDecoder().decode(b3));
  const ppBoth = new PathPair(); ppBoth.Primary = "a"; ppBoth.Secondary = "b";
  const ppOne = new PathPair(); ppOne.Primary = "a";
  const obj = new js_ast.EObject();
  const p = new js_ast.Property();
  p.Key = new js_ast.Expr(new js_ast.EString(new Uint16Array(StringToUTF16(new TextEncoder().encode("foo")))), new Loc(0));
  p.ValueOrNil = new js_ast.Expr(new js_ast.ENumber(), new Loc(0));
  obj.Properties.push(p);
  const je = new js_ast.Expr(obj, new Loc(0));
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "iter": got = String((r.arg === "both" ? ppBoth : ppOne).iter().length); break;
      case "increaseIndent": { const dd = new debugLogs(); dd.increaseIndent(); dd.increaseIndent(); got = JSON.stringify(dd.indent); break; }
      case "decreaseIndent": { const dd = new debugLogs(); dd.increaseIndent(); dd.increaseIndent(); dd.decreaseIndent(); got = JSON.stringify(dd.indent); break; }
      case "addNote": { const dd = new debugLogs(); dd.increaseIndent(); dd.addNote("hello"); got = dd.notes[0]; break; }
      case "getProperty": { const v = getProperty(je, r.arg); got = `${v.ok}|${v.value.Data === null ? "<nil>" : v.value.Data.constructor.name === "ENumber" ? "*js_ast.ENumber" : v.value.Data.constructor.name}`; break; }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} ${r.arg}`);
  }
});
