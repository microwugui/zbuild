// 第 43 轮 G-3 单次使用代入 + switch minify 全链（substituteSingleUseSymbolInStmt/InExpr、
// minifySwitchStmt）。byte oracle 由 Go 0.28.2 二进制 `/tmp/esbuild-go --minify-whitespace
// --minify-syntax --format=esm` 实测，固化在 testdata/js_parser/g3-substitute-go.json。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Log, Path, Source } from "../logger/logger.ts";
import { Parse, Options } from "./js_parser.ts";
import { Format, Options as PO, Print } from "../js_printer/js_printer.ts";

const FIXTURE = new URL("../../../testdata/js_parser/g3-substitute-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "b5829bb0d0eb4385c6cdf7d98bab7afbb3c0f188d909b56125bb6eb13fe82716";

function minify(src: string): string {
  const s = new Source();
  s.Index = 0;
  s.Contents = new TextEncoder().encode(src);
  s.KeyPath = new Path();
  s.KeyPath.Text = "<stdin>";
  const o = new Options();
  o.minifyWhitespace = true;
  o.minifySyntax = true;
  const r = Parse(new Log(), s, o);
  assert.equal(r.ok, true, `parse ok: ${src}`);
  const syms = r.ast.Symbols;
  const ren = { NameForSymbol(ref: { InnerIndex: number }) { return syms[ref.InnerIndex].OriginalName; } };
  const po = new PO();
  po.OutputFormat = Format.FormatESModule;
  po.MinifyWhitespace = true;
  po.MinifySyntax = true;
  return new TextDecoder().decode(Print(r.ast, syms, ren, po).JS).trim();
}

test("G-3 substitute/switch Go 字节证据：fixture sha256 + 逐例 minify 输出相等", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "g3-substitute fixture sha256");
  const rows: { src: string; go: string }[] = JSON.parse(new TextDecoder().decode(bytes));
  assert.equal(rows.length, 8, "8 例");
  for (const row of rows) {
    assert.equal(minify(row.src), row.go, `minify ${JSON.stringify(row.src)}`);
  }
});
