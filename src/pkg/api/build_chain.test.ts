// 第 99 轮成片端口：build 引擎主干链端到端字节 oracle（api.Build → contextImpl → Rebuild →
// bundle1/bundle_multi 已验驱动）。Go 探针 tools/go/tmpgen_build_chain_test.bak 调真实 api.Build
// （内部 ScanBundle→Link→Compile）→ testdata/build-chain-go.json（5 例）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Build, Context } from "./api.ts";
import { Platform, Target } from "./api_impl.ts";
import { Format } from "../../internal/config/config.ts";
import type { BuildOptionsInput } from "./api_impl.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/build-chain-go.json", import.meta.url)));
const SHA = "d59eb733b4970960fed06827c9c1e7431a8db9a7c3bf33475fa0f8c931091e62";
const rows = JSON.parse(new TextDecoder().decode(raw)) as { entry: string; sha: string; bytes: number; log: string; code?: string }[];
const by = Object.fromEntries(rows.map((r) => [r.entry, r]));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const base: BuildOptionsInput = {
  AbsWorkingDir: "/root/port", Bundle: true, Format: Format.FormatESModule,
  Platform: Platform.PlatformNode, Target: Target.ESNext, Write: false,
};

test("build-chain 夹具 sha256（5 例）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("Build 主干链逐字节等于 Go api.Build（file + stdin）", () => {
  // file 入口（cwd=/root/port + 相对路径，口径同 three_verify）
  for (const [name, entry] of [["cwd-core", "testdata/three/package/build/three.core.js"], ["cwd-module", "testdata/three/package/build/three.module.js"]] as const) {
    const res = Build({ ...base, EntryPoints: [entry] });
    assert.equal(res.Errors.length, 0, `${name}: errors`);
    assert.equal(res.OutputFiles.length, 1, `${name}: one output`);
    assert.equal(sha(res.OutputFiles[0].Contents), by[name].sha, `${name}: sha`);
    assert.equal(res.OutputFiles[0].Contents.length, by[name].bytes, `${name}: bytes`);
  }
  // stdin 单文件（夹具含完整 code）
  const stdins: Record<string, string> = {
    "stdin-simple": "var x = 1; console.log(x);\n",
    "stdin-export": "export const foo = 42;\n",
    "stdin-comment": "// hi\nexport const y = 2;\n",
  };
  for (const [name, src] of Object.entries(stdins)) {
    const res = Build({ ...base, Stdin: { Contents: src, ResolveDir: "/root/port", Sourcefile: "<stdin>", Loader: 0 } });
    assert.equal(res.Errors.length, 0, `${name}: errors`);
    assert.equal(sha(res.OutputFiles[0].Contents), by[name].sha, `${name}: sha`);
    assert.equal(new TextDecoder().decode(res.OutputFiles[0].Contents), by[name].code, `${name}: bytes`);
  }
});

test("Context 返回可 Rebuild 的句柄，逐字节等于 Build", () => {
  const src = "export const foo = 42;\n";
  const { ctx, err } = Context({ ...base, Stdin: { Contents: src, ResolveDir: "/root/port", Sourcefile: "<stdin>", Loader: 0 } });
  assert.equal(err, null);
  const a = sha(ctx.Rebuild().OutputFiles[0].Contents);
  const b = sha(by["stdin-export"].code ? new TextEncoder().encode(by["stdin-export"].code!) : new Uint8Array());
  assert.equal(a, b, "Context.Rebuild == Build == Go");
});
