// 第 77 轮 · 多文件 bundle 驱动回归：依赖内联 + 跨文件链接 + legal 注释 EOF + 空行分隔。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bundleWithImports } from "./bundle_multi.ts";
import { createHash } from "node:crypto";

const dec = new TextDecoder();
const enc = new TextEncoder();
const goBytes = new Uint8Array(readFileSync(new URL("../testdata/b1multi/entry.go.js", import.meta.url)));
const SHA = "4e02e0d2434d33c167d6475717fe72f21218ee8111c7ec4a7bc61c07c200f188";

test("多文件 bundle 逐字节等于 Go --bundle（含 class 内层名 / legal 注释 / 空行分隔）", () => {
  assert.equal(createHash("sha256").update(goBytes).digest("hex"), SHA);
  const got = bundleWithImports("testdata/b1multi/entry.js");
  assert.equal(got.ok, true, got.error);
  assert.equal(dec.decode(got.output), dec.decode(goBytes));
});

test("bundle_with_imports 已接 three 多入口：依赖被内联（不再停在 import 首差 byte 39）", () => {
  const got = bundleWithImports("testdata/three/package/build/three.module.js");
  assert.equal(got.ok, true, got.error);
  const text = dec.decode(got.output);
  // 依赖的源码路径注释出现在入口前；入口自身语句跟在后面；不再有未内联的 import 行。
  assert.ok(text.startsWith("// testdata/three/package/build/three.core.js\n"));
  assert.ok(text.indexOf("// testdata/three/package/build/three.module.js") > 100000);
  assert.ok(!/^import /m.test(text), "输出中不应残留 import 语句");
});
