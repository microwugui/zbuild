// 第 62 轮叶子优先规划：pkg/api 纯字符串助手整簇（一次 Go 探针、3 函数、逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { escapeForAttribute, parseRangeInt } from "./serve_other.ts";
import { validatePathTemplate } from "./api_impl.ts";

const FIXTURE = new URL("../../../testdata/api-pure-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "21b4f2e25821c73e3b097dee37897d0c8fd111dc3d518e4939ff126a79c9aefd";

interface Row { fn: string; arg: string; out: string; }

test("api-pure fixture sha256 + 22 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "api-pure fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "parseRangeInt": {
        const [text, max] = r.arg.split("|");
        const v = parseRangeInt(text, Number(max));
        got = `${v.value}|${v.ok}`;
        break;
      }
      case "escapeForAttribute":
        got = escapeForAttribute(r.arg);
        break;
      case "validatePathTemplate":
        got = validatePathTemplate(r.arg).map((p) => `${p.Placeholder}:${p.Data};`).join("");
        break;
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 22);
});
