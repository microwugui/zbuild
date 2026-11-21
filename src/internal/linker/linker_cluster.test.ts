// 第 93 轮叶子优先规划：linker 助手簇（3 函数一次探针，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendOrExtendPartRange, hashWriteUint32, generateGlobalNamePrefix } from "./linker.ts";
import { StringToJSFeature } from "../compat/tables_generated.ts";

const FIXTURE = new URL("../../../testdata/linker-cluster-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "391f460ccb980616551ff283e9eccaa68d68c4235d62edc16cc74d4b5027407f";

interface Row { fn: string; arg: string; out: string; }
const hex = (b: Uint8Array): string => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

test("linker-cluster fixture sha256 + 14 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "linker-cluster fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    if (r.fn === "generateGlobalNamePrefix") {
      const p = r.arg.split("|");
      const gn = Buffer.from(p[0], "base64").toString("utf8");
      const minify = p[1] === "true", ascii = p[2] === "true", noLogical = p[3] === "true";
      const unsupported = noLogical ? BigInt(StringToJSFeature["logical-assignment"]) : 0n;
      got = generateGlobalNamePrefix([gn], minify, ascii, unsupported);
    } else if (r.fn === "appendOrExtendPartRange") {
      const p1 = r.arg.lastIndexOf("|"), p2 = r.arg.lastIndexOf("|", p1 - 1);
      const raw: number[][] = JSON.parse(r.arg.slice(0, p2));
      const src = Number(r.arg.slice(p2 + 1, p1)), part = Number(r.arg.slice(p1 + 1));
      const ranges = raw.map((x) => ({ sourceIndex: x[0], partIndexBegin: x[1], partIndexEnd: x[2] }));
      got = appendOrExtendPartRange(ranges, src, part).map((x) => `${x.sourceIndex}:${x.partIndexBegin}:${x.partIndexEnd};`).join("");
    } else if (r.fn === "hashWriteUint32") {
      // verify the 4 bytes then sha256
      const bytes = hashWriteUint32(Number(r.arg));
      // compute sha256 async-free via node crypto
      const h = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
      got = h;
    } else throw new Error(`unknown ${r.fn}`);
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 14);
  void hex;
});
