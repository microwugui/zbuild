// 第 103 轮成片端口：CLI 主循环 runImpl 端到端字节契约（stdout / stderr / exit）。
// Go 探针 tools/go/tmpgen_run_chain_test.bak（真实 cli.Run 重定向 IO）→ testdata/run-chain-go.json。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runImpl } from "./cli_impl.ts";
import { Run, RunWithPlugins } from "./cli.ts";
import type { FileLike } from "../../internal/logger/logger.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/run-chain-go.json", import.meta.url)));
const SHA = "375bbf8cccc439b95b9d0d7333397b1e7a3f868ba605bf3f368b7f7e19af24b0";
const rows = JSON.parse(new TextDecoder().decode(raw)) as { name: string; exit: number; out: string; err: string }[];
const by = Object.fromEntries(rows.map((r) => [r.name, r]));
const enc = new TextEncoder();
const hex = (b: Uint8Array | Uint8Array<ArrayBufferLike>) => Buffer.from(b).toString("hex");

const cases: Record<string, [string[], string]> = {
  "tx-ts": [["--loader=ts", "--format=esm"], "export const x = 1;\n"],
  "tx-minify": [["--minify-whitespace"], "const value = 1; export {value};\n"],
  "bd-stdin": [["--bundle", "--format=esm"], "const x = 1; console.log(x);\n"],
  "tx-badflag": [["--no-such"], "const x = 1;\n"],
  "bd-badflag": [["in.js", "--no-such"], ""],
};

test("run-chain 夹具 sha256（5 例）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("runImpl 逐字节等于 Go cli.Run（stdout / stderr / exit）", () => {
  for (const [name, [args, stdin]] of Object.entries(cases)) {
    let out: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    const errChunks: Uint8Array[] = [];
    const errFile: FileLike = { WriteString: (b) => { errChunks.push(b); } };
    const exit = runImpl(args, enc.encode(stdin), (b: Uint8Array) => { out = b; }, errFile);
    const errBuf = Buffer.concat(errChunks.map((c) => Buffer.from(c)));
    assert.equal(exit, by[name].exit, `${name}: exit`);
    assert.equal(hex(out), by[name].out, `${name}: stdout`);
    assert.equal(errBuf.toString("hex"), by[name].err, `${name}: stderr`);
  }
});

test("Run / RunWithPlugins 公开入口委托 runImpl 逐字节等于 Go", () => {
  for (const [name, [args, stdin]] of Object.entries(cases)) {
    let out: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    const errChunks: Uint8Array[] = [];
    const stderr: FileLike = { WriteString: (b) => { errChunks.push(b); } };
    const io = { stdin: enc.encode(stdin), writeOut: (b: Uint8Array) => { out = b; }, stderr };
    const exit = name === "tx-ts" ? Run(args, io) : RunWithPlugins(args, [], io);
    const errBuf = Buffer.concat(errChunks.map((c) => Buffer.from(c)));
    assert.equal(exit, by[name].exit, `${name}: exit`);
    assert.equal(hex(out), by[name].out, `${name}: stdout`);
    assert.equal(errBuf.toString("hex"), by[name].err, `${name}: stderr`);
  }
});
