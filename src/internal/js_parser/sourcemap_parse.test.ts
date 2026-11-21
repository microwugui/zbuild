// 第 104 轮：ParseSourceMap 逐字节等于 Go（17 例）。
// Go 探针 tools/go/tmpgen_smparse_test.go → testdata/sourcemap-parse-go.json。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Source, Log, NewDeferLog, DeferLogKind, MsgKind } from "../logger/logger.ts";
import { ParseSourceMap } from "./sourcemap_parser.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/sourcemap-parse-go.json", import.meta.url)));
const SHA = "f63b6f6c8aae9910fc13df24aed165e4feac3f3f723e8659a2e756d4dc6f821a";
type Row = { name: string; out: any; msgs: { id: number; kind: number; text: string }[] };
const rows = JSON.parse(new TextDecoder().decode(raw)) as Row[];
const by = Object.fromEntries(rows.map((r) => [r.name, r]));

const cases: [string, string, string, string][] = [
  ["valid-simple", `{"version":3,"sources":["a.js"],"names":["foo"],"mappings":"AAAAA","sourcesContent":["let foo = 1"]}`, "<stdin>", ""],
  ["valid-multi", `{"version":3,"sources":["a.js","b.js"],"names":["x","y"],"mappings":"AAAAA,CAAC;AACD"}`, "<stdin>", ""],
  ["valid-no-names", `{"version":3,"sources":["a.js"],"mappings":"AAAA"}`, "<stdin>", ""],
  ["invalid-json", `{`, "<stdin>", ""],
  ["non-object", `[1,2,3]`, "<stdin>", ""],
  ["no-version", `{"sources":["a.js"],"mappings":"AAAA"}`, "<stdin>", ""],
  ["bad-version", `{"version":2,"sources":["a.js"],"mappings":"AAAA"}`, "<stdin>", ""],
  ["empty-mappings", `{"version":3,"sources":["a.js"],"mappings":""}`, "<stdin>", ""],
  ["empty-sources", `{"version":3,"sources":[],"mappings":"AAAA"}`, "<stdin>", ""],
  ["bad-mappings-char", `{"version":3,"sources":["a.js"],"names":["x"],"mappings":"AAAA!"}`, "<stdin>", ""],
  ["bad-source-index", `{"version":3,"sources":["a.js"],"names":["x"],"mappings":"ACAA"}`, "<stdin>", ""],
  ["source-root", `{"version":3,"sourceRoot":"/static","sources":["a.js"],"mappings":"AAAA"}`, "<stdin>", ""],
  ["source-root-slash", `{"version":3,"sourceRoot":"/static/","sources":["a.js"],"mappings":"AAAA"}`, "<stdin>", ""],
  ["with-sections", `{"version":3,"sections":[{"offset":{"line":0,"column":0},"map":{"version":3,"sources":["a.js"],"names":["x"],"mappings":"AAAAA"}}]}`, "<stdin>", ""],
  ["bad-sections-type", `{"sections":123}`, "<stdin>", ""],
  ["file-url", `{"version":3,"sources":["a.js"],"mappings":"AAAA"}`, "/p/src/main.js", "file"],
  ["null-source-entry", `{"version":3,"sources":[null,"a.js"],"mappings":"AAAA"}`, "<stdin>", ""],
];

function dump(sm: ReturnType<typeof ParseSourceMap>): any {
  if (sm === null) return { nil: true, sources: null, contents: null, mappings: null, names: null };
  return {
    nil: false,
    sources: sm.Sources.length ? sm.Sources : null,
    contents: sm.SourcesContent.map((c) => ({ q: c.Quoted, v: Array.from(c.Value) })),
    mappings: sm.Mappings.map((m) => ({ gl: m.GeneratedLine, gc: m.GeneratedColumn, si: m.SourceIndex, ol: m.OriginalLine, oc: m.OriginalColumn, on: m.OriginalName.GetIndex(), onv: m.OriginalName.IsValid() })),
    names: sm.Names.length ? sm.Names : null,
  };
}

test("sourcemap-parse 夹具 sha256（17 例）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("ParseSourceMap 逐字节等于 Go（合法/非法/无版本/sections/错误 mappings）", () => {
  assert.equal(cases.length, rows.length, "case count");
  for (const [name, src, keypath, ns] of cases) {
    const log = NewDeferLog(DeferLogKind.DeferLogAll, null);
    const s = new Source();
    s.Contents = new TextEncoder().encode(src);
    s.KeyPath.Text = keypath; s.KeyPath.Namespace = ns;
    const sm = ParseSourceMap(log, s);
    assert.deepEqual(dump(sm), by[name].out, `${name}: out`);
    const msgs = log.Done().map((m) => ({ id: m.ID, kind: m.Kind, text: m.Data.Text }));
    assert.deepEqual(msgs, by[name].msgs, `${name}: msgs`);
  }
});
