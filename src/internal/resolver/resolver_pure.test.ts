// 第 65 轮叶子优先规划：resolver 纯字符串助手（Go 探针固化，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { globstarToEscapedRegexp, esmParsePackageName } from "./package_json.ts";

const FIXTURE = new URL("../../../testdata/resolver-pure2-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "82d66a5525761dfa123308ba20cae3d6a992dc3b6695df0f25c92cda6eb5e42d";

interface Row { fn: string; arg: string; out: string; }

test("resolver-pure fixture sha256 + 21 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "resolver-pure fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "globstarToEscapedRegexp": {
        const v = globstarToEscapedRegexp(r.arg);
        got = `${v.value}|${v.ok}`;
        break;
      }
      case "esmParsePackageName": {
        const v = esmParsePackageName(r.arg);
        got = `${v.name}|${v.subpath}|${v.ok}`;
        break;
      }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 21);
});
