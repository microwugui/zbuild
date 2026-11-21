// 第 86 轮：api→service 链共享 harness（api.FormatMessages / api.AnalyzeMetafile 经 service handler）
// Go 探针 tmpgen_api_chain_test.go 一次驱动 9 例，固化 testdata/api-chain-go.json。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { serviceType } from "./service.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/api-chain-go.json", import.meta.url)));
const SHA = "c91d40a3db72a4469d80aac5428ff2052e30c5b3cd706a482055602d30b63ea8";
const fx = JSON.parse(new TextDecoder().decode(raw)) as { rows: { name: string; out: string }[] };
const by = Object.fromEntries(fx.rows.map((r) => [r.name, r.out]));
const hx = (b: Uint8Array) => Buffer.from(b).toString("hex");

const SIMPLE_MF = `{"outputs":{"out.js":{"entryPoint":"src/index.js","bytes":100,"inputs":{"src/index.js":{"bytesInOutput":100}}}}}`;

test("api→service 链夹具 sha256", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("handleAnalyzeMetafileRequest 真链（含非空 metafile）逐字节等于 Go", () => {
  const s = new serviceType();
  assert.equal(hx(s.handleAnalyzeMetafileRequest(9, { metafile: "", color: false, verbose: false })), by["analyze-empty"]);
  assert.equal(hx(s.handleAnalyzeMetafileRequest(9, { metafile: "{", color: false, verbose: false })), by["analyze-bad"]);
  assert.equal(hx(s.handleAnalyzeMetafileRequest(9, { metafile: SIMPLE_MF, color: false, verbose: false })), by["analyze-simple"]);
  assert.equal(hx(s.handleAnalyzeMetafileRequest(9, { metafile: SIMPLE_MF, color: false, verbose: true })), by["analyze-simple-verbose"]);
});

test("handleFormatMessagesRequest 真链（default/clang/visualstudio）逐字节等于 Go", () => {
  const s = new serviceType();
  const req = (style: string) => ({
    messages: [{ id: "", pluginName: "", text: "simple error", location: null, notes: [], detail: -1 }],
    isWarning: false, color: false, terminalWidth: 80, logStyle: style,
  });
  assert.equal(hx(s.handleFormatMessagesRequest(7, req("default"))), by["format-default"]);
  assert.equal(hx(s.handleFormatMessagesRequest(7, req("clang"))), by["format-clang"]);
  assert.equal(hx(s.handleFormatMessagesRequest(7, req("visualstudio"))), by["format-visualstudio"]);
  assert.equal(hx(s.handleFormatMessagesRequest(7, req("xyz"))), by["format-invalid"]);
  assert.equal(hx(s.handleFormatMessagesRequest(8, { messages: [], isWarning: false, color: false, terminalWidth: 80 })), by["format-empty"]);
});
