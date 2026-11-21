// 第 93 批：computeChunkReservedNames（renamer 底座，解决 document→document2 冲突）。
// Go 探针 tools/go/tmpgen_reserved_test.bak → testdata/reserved-names-go.json（4 行）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { computeChunkReservedNames } from "./renamer.ts";
import { NewSymbolMap } from "../ast/ast.ts";
import { Source, Path, PrettyPaths, Log } from "../logger/logger.ts";
import { Options, Parse } from "../js_parser/js_parser.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/reserved-names-go.json", import.meta.url)));
const SHA = "1e138042a4af939c571a3dfa806e92e74e6e2b5c8f297cd2f43d44f74c98a5b9";
const rows = JSON.parse(new TextDecoder().decode(raw)) as any[];

function reservedFor(mode: number, format: number, platform: number): string[] {
  const src = new Source();
  src.Contents = new TextEncoder().encode("document.hidden = 1; window.foo = 2; function connect(document){ return document.x }");
  src.KeyPath = new Path(); src.KeyPath.Text = "<test>"; src.KeyPath.Namespace = "file";
  src.PrettyPaths = new PrettyPaths(); src.PrettyPaths.Abs = "<test>"; src.PrettyPaths.Rel = "<test>";
  const o = new Options(); o.mode = mode; o.outputFormat = format;
  const r = Parse(new Log(), src, o);
  assert.equal(r.ok, true);
  const ast: any = r.ast;
  const sm = NewSymbolMap(1);
  sm.SymbolsForSource[0] = ast.Symbols;
  const names = computeChunkReservedNames([ast.ModuleScope], sm, mode, format, platform);
  const watch = ["document", "window", "exports", "module", "require", "Promise", "connect"];
  return watch.filter((w) => (names.get(w) ?? 0) !== 0).sort();
}

test("reserved-names 夹具 sha256（4 行）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("computeChunkReservedNames：4 组 mode/format/platform 逐字节等于 Go", () => {
  for (const r of rows) {
    assert.deepEqual(reservedFor(r.mode, r.format, r.platform), r.reserved, `config ${r.name}`);
  }
});
