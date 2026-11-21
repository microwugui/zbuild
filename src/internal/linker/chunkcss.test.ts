// 第 157 批：generateChunkCSS 本体（assembly 路径），Go 探针 2 例逐字节。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as ast from "../ast/ast.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import { InputFile, JSRepr } from "../graph/input.ts";
import { LinkerGraph, LinkerFile } from "../graph/graph.ts";
import { MockFS, MockUnix } from "../fs/fs_mock.ts";
import { NewDeferLog, DeferLogKind } from "../logger/logger.ts";
import { linkerContext, chunkInfo, chunkReprCSS } from "./linker.ts";
import { generateChunkCSS } from "./linker.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/chunkcss-go.json", import.meta.url)));
const SHA = "3296bdd814172571e8bfe553f98b77bf51aaf725de041a8eba4c96c39a471be5";
const dec = new TextDecoder();

function build(banner: string, footer: string): linkerContext {
  const c = new linkerContext();
  c.graph = new LinkerGraph(); c.graph.Files = [new LinkerFile()];
  c.graph.Symbols = ast.NewSymbolMap(1);
  const rt = new JSRepr(); rt.AST.ModuleScope = new js_ast.Scope(); c.graph.Files[0].InputFile.Repr = rt;
  c.fs = MockFS({}, MockUnix, "/");
  c.options = { CSSBanner: banner, CSSFooter: footer, LegalComments: 0, Mode: 2 };
  c.uniqueKeyPrefix = "TEST"; c.uniqueKeyPrefixBytes = new TextEncoder().encode("TEST");
  c.log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, new Map());
  c.dataForSourceMaps = () => [];
  return c;
}
function ioDump(io: any): any {
  if (io.pieces === null) return { bytes: Buffer.from(io.joiner.Done()).toString("hex") };
  return { pieces: io.pieces.map((p: any) => [Buffer.from(p.data).toString("hex"), p.kind, p.index]) };
}
const ROWS: { fn: string; arg: any; run: () => any }[] = [
  { fn: "generateChunkCSS", arg: { case: "banner-footer" }, run: () => {
    const c = build("/* css banner */", "/* css footer */");
    const ch = new chunkInfo(); ch.chunkRepr = new chunkReprCSS(); ch.finalTemplate = [{ Data: "chunk.css", Placeholder: 0 } as any];
    c.chunks = [ch]; generateChunkCSS(c, 0, { done: () => {} });
    return ioDump(ch.intermediateOutput);
  }},
  { fn: "generateChunkCSS", arg: { case: "empty" }, run: () => {
    const c = build("", "");
    const ch = new chunkInfo(); ch.chunkRepr = new chunkReprCSS(); ch.finalTemplate = [{ Data: "chunk.css", Placeholder: 0 } as any];
    c.chunks = [ch]; generateChunkCSS(c, 0, { done: () => {} });
    return ioDump(ch.intermediateOutput);
  }},
];
test("chunkcss fixture sha256 + 2 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(dec.decode(bytes));
  assert.equal(rows.length, ROWS.length);
  for (let i = 0; i < rows.length; i++) {
    assert.equal(ROWS[i].fn, rows[i].fn);
    assert.deepEqual(ROWS[i].arg, rows[i].arg, `arg@${i}`);
    assert.deepEqual(ROWS[i].run(), rows[i].out, `${JSON.stringify(rows[i].arg)} mismatch`);
  }
});
