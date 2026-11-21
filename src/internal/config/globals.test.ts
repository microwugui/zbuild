// 第 84 轮：knownGlobals 全表 + ProcessDefines 差分（Go 探针固化 testdata/process-defines-go.json）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as js_ast from "../js_ast/js_ast.ts";
import { knownGlobals, ProcessDefines, type FullDefineData, type DefineExprData } from "./globals.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/process-defines-go.json", import.meta.url)));
const SHA = "c7df0a45d7917358505778f1e48ece5b1b108bf57dcc9bd9204c5da939062b44";

type GoDesc = { keyParts: string; flags: number; expr: string };

function describeExpr(e: DefineExprData | null): string {
  if (e === null) return "nil";
  const c = e.Constant;
  if (c instanceof js_ast.EUndefined) return "const:undefined";
  if (c instanceof js_ast.ENumber) {
    const v = c.Value;
    if (Number.isNaN(v)) return "const:NaN";
    if (v === Infinity) return "const:Infinity";
    if (v === -Infinity) return "const:-Infinity";
    return "const:num:" + String(v);
  }
  if (e.Parts.length > 0) return "parts:" + e.Parts.join(".");
  return "expr";
}
function describe(d: FullDefineData): GoDesc {
  return { keyParts: d.KeyParts.join("."), flags: d.Flags, expr: describeExpr(d.DefineExpr) };
}
function parseUser(spec: string): FullDefineData {
  const [kp, fl, ex] = spec.split("|");
  let expr: DefineExprData | null = null;
  if (ex.startsWith("parts:")) expr = { Constant: null, Parts: ex.slice(6).split(".") };
  return { KeyParts: kp === "" ? [] : kp.split("."), DefineExpr: expr, Flags: Number(fl) };
}

test("globals knownGlobals table + ProcessDefines 逐字节等于 Go（8 例 + 807 项表）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA, "fixture sha256");
  const fx = JSON.parse(new TextDecoder().decode(raw));
  assert.equal(knownGlobals.length, fx.table.length, "knownGlobals 表长度");
  for (let i = 0; i < fx.table.length; i++) {
    assert.equal(knownGlobals[i].join("."), fx.table[i], `table[${i}]`);
  }
  for (const c of fx.cases) {
    const ud = (c.userDefines ?? []).map(parseUser);
    const pd = ProcessDefines(ud);
    const gotIdent: Record<string, GoDesc> = {};
    for (const [k, v] of pd.IdentifierDefines) gotIdent[k] = describe(v);
    assert.deepEqual(gotIdent, c.identifiers, `${c.name} identifiers`);
    const gotDot: Record<string, GoDesc[]> = {};
    for (const [k, arr] of pd.DotDefines) {
      gotDot[k] = arr.map(describe).sort((a, b) => a.keyParts < b.keyParts ? -1 : a.keyParts > b.keyParts ? 1 : 0);
    }
    assert.deepEqual(gotDot, c.dots, `${c.name} dots`);
  }
});
