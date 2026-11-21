// 第 44 轮 M2/M4 成片推进：data URL 解析整链（ParseDataURL / DecodeMIMEType / DecodeData）。
// byte oracle 由 Go 0.28.2 包内探针固化在 testdata/resolver-dataurl-go.json。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ParseDataURL } from "./dataurl.ts";

const FIXTURE = new URL("../../../testdata/resolver-dataurl-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "52a65df5fa6fe46fb833d3528fe73caf7ff683110bb4c80b0d068e08cd3354bf";

interface Row { url: string; mime: string; data: string; isB64: boolean; kind: number; decoded: string; ok: boolean; }

test("data URL 解析链：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "dataurl fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const row of rows) {
    const { parsed, ok } = ParseDataURL(row.url);
    assert.equal(ok, row.ok, `ok ${row.url}`);
    assert.equal(parsed.mimeType, row.mime, `mime ${row.url}`);
    assert.equal(parsed.data, row.data, `data ${row.url}`);
    assert.equal(parsed.isBase64, row.isB64, `isBase64 ${row.url}`);
    assert.equal(parsed.DecodeMIMEType(), row.kind, `kind ${row.url}`);
    if (ok) {
      const { value, err } = parsed.DecodeData();
      if (row.decoded.startsWith("ERR:")) assert.notEqual(err, null, `err ${row.url}`);
      else { assert.equal(err, null, `no err ${row.url}`); assert.equal(value, row.decoded, `decoded ${row.url}`); }
    }
  }
});
