// 第 107 轮：parser.convertSymbolUseToCall 逐字节等于 Go（5 场景状态机）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parser } from "./js_parser.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import { Ref } from "../ast/ast.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/sym-use-go.json", import.meta.url)));
const SHA = "c6a185069006752806d3f426d986d03477a0170548f38be76f9c44991ecc9932";
const rows = JSON.parse(new TextDecoder().decode(raw)) as any[];

const ref = new Ref(1, 0), other = new Ref(1, 1);
function su(n: number): js_ast.SymbolUse { const u = new js_ast.SymbolUse(); u.CountEstimate = n; return u; }
function cu(c: number, s: number): js_ast.SymbolCallUse { const u = new js_ast.SymbolCallUse(); u.CallCountEstimate = c; u.SingleArgNonSpreadCallCountEstimate = s; return u; }

function run(idx: number): any {
  const uses = new Map<string, js_ast.SymbolUse>();
  const calls = new Map<string, js_ast.SymbolCallUse>();
  if (idx === 0) uses.set("1:0", su(1));
  else if (idx === 1) uses.set("1:0", su(3));
  else if (idx === 2) { uses.set("1:0", su(2)); calls.set("1:0", cu(4, 2)); }
  else if (idx === 3) { uses.set("1:0", su(1)); uses.set("1:1", su(5)); }
  else if (idx === 4) { /* empty */ }
  const part = new js_ast.Part();
  part.SymbolUses = uses; part.SymbolCallUses = calls;
  // 直接构造 parser 所需字段（convertSymbolUseToCall 只碰 currentPart）
  const p = Object.create(parser.prototype) as parser;
  (p as any).currentPart = part;
  const single = idx === 0 || idx === 2;
  p.convertSymbolUseToCall(ref, single);
  const uOut: any = {}, cOut: any = {};
  for (const [k, v] of part.SymbolUses) uOut[k] = v.CountEstimate >>> 0;
  for (const [k, v] of part.SymbolCallUses) cOut[k] = [v.CallCountEstimate >>> 0, v.SingleArgNonSpreadCallCountEstimate >>> 0];
  return { name: rows[idx].name, uses: uOut, callUses: cOut };
}

test("sym-use 夹具 sha256（5 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("convertSymbolUseToCall 状态机逐字节等于 Go（5 场景）", () => {
  assert.equal(rows.length, 5);
  for (let i = 0; i < rows.length; i++) assert.deepEqual(run(i), rows[i], `scenario ${i}: ${rows[i].name}`);
});
