// 第 86 轮：validatePath / validateExternals 共享 Go 探针（一次 12 行逐字节）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { MockFS } from "../../internal/fs/fs_mock.ts";
import { NewDeferLog, DeferLogKind } from "../../internal/logger/logger.ts";
import { ExternalSettings, ExternalMatchers } from "../../internal/config/config.ts";
import { validatePath, validateExternals, pluginImpl } from "./api_impl.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/api-validate2-go.json", import.meta.url)));
const SHA = "e6939624f932a7020875e20c1b693dbf0836020b34ff5d5135a50c2bf7ea3d6d";
const fx = JSON.parse(new TextDecoder().decode(raw)) as { rows: { fn: string; arg: string; out: string; errors: string[] }[] };

function vpaCases(name: string): string[] {
  return ({
    empty: [], relative: ["./foo", "../bar"], package: ["react"], mixed: ["", "./x", "/abs/y"],
  } as Record<string, string[]>)[name];
}
function extCases(name: string): string[] {
  return ({
    empty: [], package: ["react", "lodash/fp"], relative: ["./foo", "../bar"],
    wildcard: ["foo/*", "./src/*.js"], "multi-wildcard": ["a*b*c"], absolute: ["/tmp/x"],
    mixed: ["react", "./local", "a/*", "/abs/z"],
  } as Record<string, string[]>)[name];
}
function extJSON(s: ExternalSettings): string {
  const norm = (m: ExternalMatchers) => {
    const exact = [...m.Exact.entries()].filter(([, v]) => v).map(([k]) => k).sort();
    const patterns = m.Patterns.map((p) => p.Prefix + "\u0000" + p.Suffix);
    return { exact, patterns };
  };
  return JSON.stringify({ post: norm(s.PostResolve), pre: norm(s.PreResolve) });
}

test("api-validate2 夹具 sha256", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("validatePath / validateExternals 逐字节等于 Go（12 例共享 harness）", () => {
  assert.equal(fx.rows.length, 16);
  for (const r of fx.rows) {
    const fsObj = MockFS({}, 0, "/home/user/project");
    const log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null);
    let got: string;
    if (r.fn === "validatePath") got = validatePath(log, fsObj, r.arg, "test path");
    else if (r.fn === "validateExternals") got = extJSON(validateExternals(log, fsObj, extCases(r.arg)));
    else if (r.fn === "validatePathsArray") {
      const arr = new pluginImpl(log, fsObj, "test-plugin").validatePathsArray(vpaCases(r.arg), "load");
      // Go nil slice 序列化为 null，TS 空数组为 []；对调用方（range/遍历）行为一致，归一化比较。
      got = arr.length === 0 && r.out === "null" ? "null" : JSON.stringify(arr);
    }
    else throw new Error("unknown fn " + r.fn);
    assert.equal(got, r.out, `${r.fn}(${r.arg}) out`);
    assert.deepEqual(log.Peek().map((m) => m.Data.Text), r.errors, `${r.fn}(${r.arg}) errors`);
  }
});
