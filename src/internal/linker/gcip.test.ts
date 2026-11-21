// 第 158 批：generateChunksInParallel（并发生成 + 最终输出），Go 探针 2 例逐字节。
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
import { linkerContext, chunkInfo, chunkReprJS } from "./linker.ts";
import { generateChunksInParallel } from "./linker.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/gcip-go.json", import.meta.url)));
const SHA = "36883163e7f5461105d27fe1af9588d6c8eeab582027d9192135cb8e37873c04";
const enc = new TextEncoder();
const dec = new TextDecoder();

function baseCtx(): linkerContext {
  const c = new linkerContext();
  c.graph = new LinkerGraph(); c.graph.Files = [new LinkerFile()];
  c.graph.Symbols = ast.NewSymbolMap(1);
  const r = new JSRepr(); r.AST.ModuleScope = new js_ast.Scope(); c.graph.Files[0].InputFile.Repr = r;
  c.fs = MockFS({}, MockUnix, "/");
  c.uniqueKeyPrefix = "TEST"; c.uniqueKeyPrefixBytes = enc.encode("TEST");
  c.log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, new Map());
  return c;
}
function dumpOutputs(c: linkerContext, files: any[]): any {
  return files.map((f) => ({ path: c.fs.Rel("/p/out", f.AbsPath).value, contents: Buffer.from(f.Contents).toString("hex"), exec: !!f.IsExecutable, merge: !!f.CanBeMerged }));
}
function tpl(data: string, ph: number): any { return { Data: data, Placeholder: ph }; }

const ROWS: { fn: string; arg: any; run: () => any }[] = [
  { fn: "generateChunksInParallel", arg: { case: "hash-chunk" }, run: () => {
    const c = baseCtx();
    c.options = { AbsOutputDir: "/p/out", SourceMap: 0 };
    const ch = new chunkInfo();
    ch.uniqueKey = "TESTC00000000";
    ch.finalTemplate = [tpl("./", 1), tpl("entry", 2), tpl("-", 3), tpl(".js", 0)];
    ch.chunkRepr = new chunkReprJS();
    ch.waitForIsolatedHash = () => new Uint8Array([1, 2, 3, 4]);
    c.chunks = [ch];
    return dumpOutputs(c, generateChunksInParallel(c, []));
  }},
  { fn: "generateChunksInParallel", arg: { case: "static-path" }, run: () => {
    const c = baseCtx();
    c.options = { AbsOutputDir: "/p/out", SourceMap: 0 };
    const ch = new chunkInfo(); ch.uniqueKey = "TESTC00000000"; ch.finalTemplate = [tpl("out.js", 0)];
    ch.chunkRepr = new chunkReprJS();
    ch.waitForIsolatedHash = () => new Uint8Array([9]);
    c.chunks = [ch];
    return dumpOutputs(c, generateChunksInParallel(c, []));
  }},
];

test("gcip fixture sha256 + 2 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(dec.decode(bytes));
  assert.equal(rows.length, ROWS.length);
  for (let i = 0; i < rows.length; i++) {
    assert.equal(ROWS[i].fn, rows[i].fn);
    assert.deepEqual(ROWS[i].arg, rows[i].arg, `arg@${i}`);
    assert.deepEqual(ROWS[i].run(), rows[i].out, `${JSON.stringify(rows[i].arg)} mismatch`);
  }
});
