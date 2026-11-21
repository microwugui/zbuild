// 第 61 轮叶子优先规划：css_lexer 纯助手整簇（一次 Go 探针、5 函数、逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Loc, Range, Source } from "../logger/logger.ts";
import { String as TString, containsAtPreserveOrAtLicense, IsNameContinue, decodeEscapesInToken, RangeOfIdentifier } from "../css_lexer/css_lexer.ts";

const FIXTURE = new URL("../../../testdata/css-lexer-cluster-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "8274b780a36f61def09bf0fd98a092a428c111f9da2031196fee8d5955304e9d";

interface Row { fn: string; arg: string; out: string; }

test("css-lexer-cluster fixture sha256 + 46 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-lexer-cluster fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "T.String":
        got = TString(Number(r.arg));
        break;
      case "containsAtPreserveOrAtLicense":
        got = String(containsAtPreserveOrAtLicense(r.arg));
        break;
      case "IsNameContinue":
        got = String(IsNameContinue(Number(r.arg)));
        break;
      case "decodeEscapesInToken": {
        const outBytes = decodeEscapesInToken(r.arg);
        got = Buffer.from(outBytes, "utf8").toString("base64");
        break;
      }
      case "RangeOfIdentifier": {
        const p = r.arg.indexOf("|");
        const start = Number(r.arg.slice(0, p));
        const contents = r.arg.slice(p + 1);
        const src = new Source();
        src.Contents = new TextEncoder().encode(contents);
        const range = RangeOfIdentifier(src, new Loc(start));
        got = `${range.Loc.Start}:${range.Len}`;
        break;
      }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 46);
  void Range;
});
