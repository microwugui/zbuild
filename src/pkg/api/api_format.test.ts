// 第 142 批：analyzeMetafileImpl / formatMsgsImpl / prettyPrintPath（build API 输出链，Go 探针 25 例）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { MockFS } from "../../internal/fs/fs_mock.ts";
import { analyzeMetafileImpl, formatMsgsImpl, prettyPrintPath } from "./api_impl.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/api-format-go.json", import.meta.url)));
const SHA = "9a82ae2d7d761825d7776bf8e8c8cba1488c3ad573397ce65be58941e84add89";
const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);

test("api-format fixture sha256 + 25 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  const mfs = MockFS(new Map(), 0, "/root/port");
  for (const r of rows) {
    const a = r.arg; let got: any;
    if (r.fn === "analyzeMetafileImpl") got = analyzeMetafileImpl(a.mf, { Color: a.color, Verbose: a.verbose });
    else if (r.fn === "formatMsgsImpl") {
      const msgs = [
        { ID: "", PluginName: "", Text: "simple error", Location: null, Notes: [], Detail: null },
        { ID: "", PluginName: "", Text: "with note", Location: null, Notes: [{ Text: "note one", Location: null }, { Text: "note two", Location: null }], Detail: null },
      ];
      got = formatMsgsImpl(msgs as any, { Kind: a.kind, Color: a.color, TerminalWidth: 80 });
    } else if (r.fn === "prettyPrintPath") got = prettyPrintPath(mfs, a.path);
    else throw new Error("unknown " + r.fn);
    assert.equal(JSON.stringify(canon(got)), JSON.stringify(canon(r.out)),
      `${r.fn} ${JSON.stringify(a)} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 25);
});
