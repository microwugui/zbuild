// 第 101 轮：service 链补齐 entries / mangleCache / metafile 三条编码路径逐字节验。
// Go 探针 tools/go/tmpgen_service_chain2_test.bak → testdata/service-chain2-go.json（3 例）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { serviceType } from "./service.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/service-chain2-go.json", import.meta.url)));
const SHA = "d7a9888f7ca9795a12f877974ba2c11b91ea67bc3fa4facb59cb217f60b06d6d";
const rows = JSON.parse(new TextDecoder().decode(raw)) as { name: string; out: string }[];
const by = Object.fromEntries(rows.map((r) => [r.name, r.out]));
const enc = new TextEncoder();
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

test("service-chain2 夹具 sha256（3 例）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("entries / mangleCache / metafile 逐字节等于 Go", () => {
  // entries: EntryPointsAdvanced
  {
    const s = new serviceType();
    const out = s.handleBuildRequest(21, {
      context: false, key: 0, write: false,
      entries: [["my-out", "testdata/svc_entry.js"]],
      flags: ["--format=esm", "--platform=node"],
      absWorkingDir: "/root/port", nodePaths: [],
    });
    assert.equal(hex(out), by["bd-entries"], "bd-entries");
  }
  // mangleCache round-trip
  {
    const s = new serviceType();
    const out = s.handleTransformRequest(22, {
      inputFS: false, input: enc.encode("const obj = { fooBar: 1 }; export {obj};"),
      flags: ["--mangle-props=_"], mangleCache: { fooBar: "a" },
    });
    assert.equal(hex(out), by["tx-mangle-cache"], "tx-mangle-cache");
  }
  // metafile
  {
    const s = new serviceType();
    const out = s.handleBuildRequest(23, {
      context: false, key: 0, write: false, entries: [],
      flags: ["--bundle", "--format=esm", "--metafile"],
      absWorkingDir: "/root/port", nodePaths: [],
      stdinContents: enc.encode("const x = 1; console.log(x);\n"), stdinResolveDir: "/root/port",
    });
    assert.equal(hex(out), by["bd-metafile"], "bd-metafile");
  }
});
