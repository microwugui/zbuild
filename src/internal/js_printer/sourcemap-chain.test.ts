// 第 44 轮 sourcemap builder 整链：addSourceMapping / addSourceMappingForName（js_printer.go:333/339）。
// byte oracle 由 Go 0.28.2 包内探针（internal/js_printer/tmpgen_sourcemap_test.go，跑完即删）
// 用 MakeChunkBuilder + 两方法 + GenerateChunk 的 mappings 字节实测，
// 固化在 testdata/js_printer/sourcemap-chain-go.json。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Loc } from "../logger/logger.ts";
import { Ref, Symbol } from "../ast/ast.ts";
import { GenerateLineOffsetTables, MakeChunkBuilder } from "../sourcemap/sourcemap.ts";
import { printer, Options, type Renamer } from "./js_printer.ts";

const FIXTURE = new URL("../../../testdata/js_printer/sourcemap-chain-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "f551f730300bd38c5f605b4fd7d7ff635a0561db5ddbd79d3d25f3e524da8dd8";

interface Row { name: string; mappings: string; }

const SRC = "let alpha = 1;\nconsole.log(alpha);\n";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function run(name: string): string {
  const tables = GenerateLineOffsetTables(SRC, 2);
  const opts = new Options();
  opts.AddSourceMappings = true;
  opts.LineOffsetTables = tables;
  const sym = new Symbol();
  sym.OriginalName = "alpha";
  sym.Link = new Ref(0, 0); // chain terminator; followSymbols 的环保护据此停在自身
  const symbols = [sym];
  const renamer: Renamer = { NameForSymbol() { return "alpha"; } };
  const p = new printer(symbols, renamer, opts);
  p.builder = MakeChunkBuilder(null, tables, false);
  switch (name) {
    case "add-loc":
      p.addSourceMapping(new Loc(0));
      break;
    case "add-two":
      p.addSourceMapping(new Loc(0));
      p.addSourceMapping(new Loc(4));
      break;
    case "add-name":
      p.addSourceMappingForName(new Loc(4), "alpha", new Ref(0, 0));
      break;
    case "add-name-diff":
      p.addSourceMappingForName(new Loc(4), "renamed", new Ref(0, 0));
      break;
  }
  const chunk = p.builder.GenerateChunk(encoder.encode(SRC));
  return decoder.decode(chunk.Buffer.Data);
}

test("sourcemap builder 整链：fixture sha256 + 4 例 mappings 等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "sourcemap-chain fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  assert.equal(rows.length, 4, "4 例");
  for (const row of rows) {
    assert.equal(run(row.name), row.mappings, `sourcemap ${row.name}`);
  }
});
