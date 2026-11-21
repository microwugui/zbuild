// 第 44 轮 define 链：isDotOrIndexDefineMatch + instantiateDefineExprFromData + visit 接线。
// byte oracle 由 Go 0.28.2 包内探针（internal/js_parser/tmpgen_define_test.go，跑完即删）
// 用 config.ProcessDefines + js_parser.Parse + js_printer.Print 实测，固化在
// testdata/js_parser/define-chain-go.json。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Log, Path, Source } from "../logger/logger.ts";
import { Parse, Options, DefineData, ParseDefineExpr } from "./js_parser.ts";
import { Format, Options as PO, Print } from "../js_printer/js_printer.ts";

const FIXTURE = new URL("../../../testdata/js_parser/define-chain-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "450ade70a3d2febed62214f667cab6e1bc7ed5b7c63e7c775bb422742867a4f4";

interface Row { name: string; src: string; defines: [string, string][]; go: string; }

function render(src: string, defines: [string, string][]): string {
  const s = new Source();
  s.Index = 0;
  s.Contents = new TextEncoder().encode(src);
  s.KeyPath = new Path();
  s.KeyPath.Text = "<stdin>";
  const o = new Options();
  for (const [keyText, valueText] of defines) {
    const [expr] = ParseDefineExpr(valueText);
    const def = new DefineData();
    def.KeyParts = keyText.split(".");
    def.DefineExpr = expr;
    o.defines.push(def);
  }
  const r = Parse(new Log(), s, o);
  assert.equal(r.ok, true, `parse ok: ${src}`);
  const syms = r.ast.Symbols;
  const ren = { NameForSymbol(ref: { InnerIndex: number }) { return syms[ref.InnerIndex].OriginalName; } };
  const po = new PO();
  po.OutputFormat = Format.FormatESModule;
  return new TextDecoder().decode(Print(r.ast, syms, ren, po).JS).trim();
}

test("define 链 Go 字节证据：fixture sha256 + 逐例 define 替换相等", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "define-chain fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  assert.equal(rows.length, 10, "10 例");
  for (const row of rows) {
    assert.equal(render(row.src, row.defines), row.go, `define ${row.name}`);
  }
});
