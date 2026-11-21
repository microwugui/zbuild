// 第 100 轮成片端口：service handler 链端到端字节 oracle（8 例）。
// Go 探针 tools/go/tmpgen_service_chain_test.bak 真实调 handleTransformRequest/handleBuildRequest，
// dump encodePacket hex → testdata/service-chain-go.json。CLI 选项解析底座当轮接进 handler。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { serviceType } from "./service.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/service-chain-go.json", import.meta.url)));
const SHA = "ef2de93314a69bcfe9f8deb4014a774ab1967fdc76acc1efe5d35f223ec7b93a";
const rows = JSON.parse(new TextDecoder().decode(raw)) as { name: string; out: string }[];
const by = Object.fromEntries(rows.map((r) => [r.name, r.out]));
const enc = new TextEncoder();
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const tx = (flags: string[], input: string) => ({ inputFS: false, input: enc.encode(input), flags });
const bd = (flags: string[], stdin: string) => ({
  context: false, key: 0, write: false, entries: [], flags,
  absWorkingDir: "/root/port", nodePaths: [], stdinContents: enc.encode(stdin), stdinResolveDir: "/root/port",
});

test("service-chain 夹具 sha256（8 例）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("handleTransformRequest 逐字节等于 Go（含 err 包 / define / minify-whitespace / format / loader）", () => {
  const s = new serviceType();
  const cases: Record<string, [string[], string]> = {
    "tx-default": [[], "const x = 1; export {x};"],
    "tx-define": [["--define:DEBUG=false"], "if (DEBUG) foo(); export const y = 2;"],
    "tx-minify-ws": [["--minify-whitespace"], "const value = 1; export {value};"],
    "tx-format-esm": [["--format=esm"], "export const x = 1;"],
    "tx-loader-js": [["--loader=js"], "const x = 1; export {x};"],
    "tx-bad-flag": [["--no-such-flag"], "const x = 1;"],
  };
  const ids: Record<string, number> = { "tx-default": 1, "tx-define": 2, "tx-minify-ws": 3, "tx-format-esm": 4, "tx-loader-js": 5, "tx-bad-flag": 6 };
  for (const [name, [flags, input]] of Object.entries(cases)) {
    assert.equal(hex(s.handleTransformRequest(ids[name], tx(flags, input))), by[name], name);
  }
});

test("handleBuildRequest 逐字节等于 Go（stdin+bundle / err 包）", () => {
  const s = new serviceType();
  assert.equal(hex(s.handleBuildRequest(7, bd(["--bundle", "--format=esm", "--platform=node"], "const x = 1; console.log(x);\n"))), by["bd-stdin-esm"], "bd-stdin-esm");
  assert.equal(hex(s.handleBuildRequest(8, bd(["--no-such-flag"], "const x = 1;"))), by["bd-bad-flag"], "bd-bad-flag");
});
