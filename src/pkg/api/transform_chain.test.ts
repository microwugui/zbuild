// 第 97/98 轮成片端口：Transform 编排链端到端字节 oracle。
// Go 探针 tools/go/tmpgen_transform_chain_test.bak（调用真实 api.Transform →
// transformImpl → ScanBundle/Compile）→ testdata/transform-chain3-go.json（51 例 / 6 档）。
// 第 98 轮做真：defines 透进 Parse（DEBUG→false / VERSION→"…" + if(false) DCE）、
// target features 透进 Parse/Print；不再 void defs、不再只写 Print。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Transform } from "./api.ts";
import { Target, Charset } from "./api_impl.ts";
import type { TransformOptions } from "./api_impl.ts";
import { Format } from "../../internal/config/config.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/transform-chain3-go.json", import.meta.url)));
const SHA = "941d6d62646bb810a17f2580e9cde610fc33cf986ff532b995aae2cefd5d2dfa";
const rows = JSON.parse(new TextDecoder().decode(raw)) as { name: string; gear: string; src: string; code: string }[];
const dec = new TextDecoder();

const gearOpts: Record<string, TransformOptions> = {
  default: { Format: Format.FormatESModule, Target: Target.ESNext },
  "minify-ws": { Format: Format.FormatESModule, Target: Target.ESNext, MinifyWhitespace: true },
  "line-limit": { Format: Format.FormatESModule, Target: Target.ESNext, LineLimit: 30 },
  ascii: { Format: Format.FormatESModule, Target: Target.ESNext, Charset: Charset.CharsetASCII },
  defines: { Format: Format.FormatESModule, Target: Target.ESNext, Define: new Map([["DEBUG", "false"], ["VERSION", '"1.2.3"']]) },
  "target-es5": { Format: Format.FormatESModule, Target: Target.ES5 },
};

test("transform-chain 夹具 sha256（51 行）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("Transform 编排链逐字节等于 Go（6 档 / 51 例，含 defines DCE）", () => {
  for (const r of rows) {
    const res = Transform(r.src, gearOpts[r.gear]);
    assert.equal(res.Errors.length, 0, `${r.gear}/${r.name}: errors`);
    assert.equal(dec.decode(res.Code), r.code, `${r.gear}/${r.name}: byte mismatch`);
  }
});
