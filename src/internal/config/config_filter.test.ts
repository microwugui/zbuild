// 第 83 轮：config.compileFilter / CompileFilterForPlugin 差分（Go 探针固化 testdata/config-filter-go.json）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { compileFilter, CompileFilterForPlugin, String as FormatString } from "./config.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/config-filter-go.json", import.meta.url)));
const SHA = "8c92627469c91bf2e7e983076aee2f88d1643a63e76e288f7189c8161bca0850";

type Row = { fn: string; arg: string; out: string };
const rows: Row[] = JSON.parse(new TextDecoder().decode(raw));

// Go 的 pattern 回显：对 (?i) 内联标志，Go re.String() 保留原样；JS 侧用 source + i flag 还原
function jsPattern(re: RegExp): string {
  const prefix = re.flags.includes("i") ? "(?i)" : "";
  // JS RegExp.source 会把 / 转成 \/，Go re.String() 保留原样
  return prefix + re.source.replace(/\\\//g, "/");
}

test("config-filter fixture sha256 + compileFilter/CompileFilterForPlugin/Format.String 逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA, "config-filter fixture sha256");
  for (const r of rows) {
    let got: string;
    if (r.fn === "Format.String") {
      got = FormatString(Number(r.arg));
    } else if (r.fn === "compileFilter") {
      const re = compileFilter(r.arg);
      got = re === null ? "nil" : "ok:" + jsPattern(re);
    } else if (r.fn === "CompileFilterForPlugin") {
      const [p, k, ...rest] = r.arg.split("|");
      const filter = rest.join("|");
      const res = CompileFilterForPlugin(p, k, filter);
      got = res.error !== null ? "err:" + res.error : "ok:" + jsPattern(res.regex!);
    } else throw new Error(`unknown ${r.fn}`);
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
});
