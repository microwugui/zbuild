// 第 102 轮成片端口：CLI 公开解析入口逐字节等于 Go（16 例 / 4 解析器）。
// Go 探针 tools/go/tmpgen_cli_chain_test.bak → testdata/cli-chain-go.json。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ParseBuildOptions, ParseTransformOptions, ParseServeOptions } from "./cli.ts";
import { parseOptionsForRun } from "./cli_impl.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/cli-chain-go.json", import.meta.url)));
const SHA = "2f39aa2f572bba2579263cdee446e8ea890fa24bbe3e3d123c50bdac78d5cd4c";
const rows = JSON.parse(new TextDecoder().decode(raw)) as { name: string; out: any }[];
const by = Object.fromEntries(rows.map((r) => [r.name, r.out]));

const defs = (m: Map<string, string> | undefined): string[] => m ? [...m.entries()].map(([k, v]) => `${k}=${v}`).sort() : [];
const bmap = (o: any) => ({
  bundle: !!o.Bundle, format: o.Format ?? 0, platform: o.Platform ?? 0,
  minifyWS: !!o.MinifyWhitespace, minifySyntax: !!o.MinifySyntax, minifyIdent: !!o.MinifyIdentifiers,
  target: o.Target ?? 0, metafile: !!o.Metafile, write: !!o.Write, logLimit: o.LogLimit ?? 0, logLevel: o.LogLevel ?? 0,
  entryPoints: o.EntryPoints ?? [], defines: defs(o.Define),
});
const tmap = (o: any) => ({
  format: o.Format ?? 0, minifyWS: !!o.MinifyWhitespace, minifySyntax: !!o.MinifySyntax,
  target: o.Target ?? 0, logLimit: o.LogLimit ?? 0, logLevel: o.LogLevel ?? 0, defines: defs(o.Define),
});
const smap = (o: any) => ({
  port: o.Port, host: o.Host, servedir: o.Servedir, keyfile: o.Keyfile,
  certfile: o.Certfile, fallback: o.Fallback, origin: o.CORS?.Origin ?? null,
});

test("cli-chain 夹具 sha256（16 例）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("ParseBuildOptions / ParseTransformOptions / ParseServeOptions / parseOptionsForRun 逐字节等于 Go", () => {
  for (const [name, args] of [
    ["pb-basic", ["in.js", "--bundle", "--format=esm", "--platform=node"]],
    ["pb-minify", ["a.js", "--minify", "--target=es2015"]],
    ["pb-define", ["in.js", "--define:DEBUG=false", "--metafile"]],
    ["pb-bad", ["--no-such"]],
  ] as [string, string[]][]) {
    const { options, err } = ParseBuildOptions(args);
    assert.deepEqual(err === null ? bmap(options) : { err }, by[name], name);
  }
  for (const [name, args] of [
    ["pt-basic", ["--loader=ts", "--format=esm"]],
    ["pt-minify", ["--minify", "--target=es2020"]],
    ["pt-define", ["--define:DEBUG=false"]],
    ["pt-bad", ["--no-such"]],
  ] as [string, string[]][]) {
    const { options, err } = ParseTransformOptions(args);
    assert.deepEqual(err === null ? tmap(options) : { err }, by[name], name);
  }
  for (const [name, args] of [
    ["ps-basic", ["--serve=8000", "in.js"]],
    ["ps-host", ["--serve=127.0.0.1:3000", "--servedir=public", "in.js"]],
    ["ps-origin", ["--serve=8080", "--cors-origin=*,foo", "in.js"]],
    ["ps-none", ["in.js", "--bundle"]],
    ["ps-bad", ["--serve=notaport"]],
  ] as [string, string[]][]) {
    const { options, rest, err } = ParseServeOptions(args);
    assert.deepEqual(err === null ? { opts: smap(options), rest } : { err }, by[name], name);
  }
  for (const [name, args] of [
    ["pfr-build", ["in.js", "--bundle", "--format=esm"]],
    ["pfr-transform", ["--loader=ts", "--minify"]],
    ["pfr-bad", ["--no-such"]],
  ] as [string, string[]][]) {
    const r = parseOptionsForRun(args);
    const m: any = { errText: r.errText, watch: r.extras.watch, watchDelay: r.extras.watchDelay };
    if (r.build) m.build = bmap(r.build);
    if (r.transform) m.transform = tmap(r.transform);
    assert.deepEqual(m, by[name], name);
  }
});
