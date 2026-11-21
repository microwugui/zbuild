// 第 117 轮：scanImportsAndExports CSS URL inlining 缝逐字节等于 Go（4 场景）。
// Go 期望：testdata/scanimports-go.json（SHA cdbcd008…）。底座 URLForCSS 已 1:1 移植。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { scanImportsAndExports, type SIImportRecord } from "./linker.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/scanimports-go.json", import.meta.url)));
const SHA = "cdbcd0085a2ebb9af1e366d0bde2be71ec81920310cd6ceb81edaf68b07cf4a4";
const rows = JSON.parse(new TextDecoder().decode(raw)) as any[];

type TC = { name: string; urlForCSS: string; urlForCode: string; emptyLoader: boolean; uniqueKeyPrefix: string };
const cases: TC[] = [
  { name: "js-to-css", urlForCSS: "data:text/css;base64,AAAA", urlForCode: "", emptyLoader: false, uniqueKeyPrefix: "key" },
  { name: "js-empty-loader", urlForCSS: "data:text/plain;base64,BBBB", urlForCode: "", emptyLoader: true, uniqueKeyPrefix: "key" },
  { name: "js-unique-key", urlForCSS: "/static/key_hash.js", urlForCode: "", emptyLoader: false, uniqueKeyPrefix: "key" },
  { name: "copy-file", urlForCSS: "", urlForCode: "/static/copied.png", emptyLoader: false, uniqueKeyPrefix: "key" },
];

function run(tc: TC): any {
  const record: SIImportRecord = {
    Path: { Text: "", Namespace: "file" },
    SourceIndex: tc.urlForCode !== "" ? 0 : 1,
    CopySourceIndex: tc.urlForCode !== "" ? 2 : 0,
    Flags: 0,
  };
  const cssRepr = { AST: { ImportRecords: [record] } };
  const jsFile = { InputFile: { Repr: { AST: { URLForCSS: tc.urlForCSS } }, IsEmptyLoader: tc.emptyLoader } };
  const copyFile = { InputFile: { Repr: { URLForCode: tc.urlForCode } } };
  const files = [null, jsFile, copyFile];
  scanImportsAndExports(cssRepr as any, files, tc.uniqueKeyPrefix);
  return {
    name: tc.name,
    records: [{
      path: record.Path.Text,
      namespace: record.Path.Namespace,
      flags: record.Flags,
      sourceValid: record.SourceIndex !== 0,
      copyValid: record.CopySourceIndex !== 0,
    }],
  };
}

test("scanimports 夹具 sha256（4 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("scanImportsAndExports CSS URL inlining 逐字节等于 Go", () => {
  for (let i = 0; i < rows.length; i++) assert.deepEqual(run(cases[i]), rows[i], `scenario ${i}: ${rows[i].name}`);
});
