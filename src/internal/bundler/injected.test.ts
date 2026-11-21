// 第 116 轮：scanner.preprocessInjectedFiles（InjectedDefines 缝）逐字节等于 Go（3 场景）。
// Go 期望：tools/go/tmpgen_injected_test.go → testdata/injected-go.json（SHA 192d9fad…）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { preprocessInjectedFiles } from "./bundler.ts";
import { NewDeferLog, DeferLogKind, Source, Path } from "../logger/logger.ts";
import { MockFS, MockUnix } from "../fs/fs_mock.ts";
import { MakeCacheSet } from "../cache/cache.ts";
import * as js_ast from "../js_ast/js_ast.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/injected-go.json", import.meta.url)));
const SHA = "192d9fad2b49856d827204e54d75981d44134a697fc34a51178bcf30205c415d";
const rows = JSON.parse(new TextDecoder().decode(raw)) as any[];

type Def = { Name: string; Data: any; Contents: string };
type TC = { name: string; defines: Def[] };
const cases: TC[] = [
  { name: "empty", defines: [] },
  { name: "one-number", defines: [{ Name: "foo", Data: new js_ast.ENumber(42), Contents: "42" }] },
  { name: "two-defines", defines: [
    { Name: "a", Data: new js_ast.EString(Uint16Array.from([0x68, 0x69])), Contents: '"hi"' },
    { Name: "b-c", Data: new js_ast.EBoolean(true), Contents: "true" },
  ] },
];

function mkDefines(defs: Def[]): any[] {
  return defs.map((d) => {
    const src = new Source();
    src.Contents = new TextEncoder().encode(d.Contents);
    return { Name: d.Name, Data: d.Data, Source: src };
  });
}

function run(tc: TC): any[] {
  const s: any = {
    log: NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null),
    fs: MockFS(new Map(), MockUnix, "/"),
    caches: MakeCacheSet(),
    timer: {},
    visited: new Map<string, number>(),
    resultChannel: [],
    results: new Array(32).fill(undefined),
    remaining: 0,
    options: { InjectedDefines: mkDefines(tc.defines), InjectPaths: [] },
  };
  preprocessInjectedFiles(s);
  const got: any[] = [];
  while (s.remaining > 0) { got.push(s.resultChannel.shift()); s.remaining--; }
  // sort by key like Go probe; pair with InjectedFiles by key
  got.sort((a, b) => a.file.inputFile.Source.KeyPath.Text < b.file.inputFile.Source.KeyPath.Text ? -1 : 1);
  const byKey = new Map<string, any>();
  for (const f of s.options.InjectedFiles) byKey.set(f.Source.KeyPath.Text, f);
  return got.map((res) => {
    const inp = res.file.inputFile;
    const repr = inp.Repr;
    const syms = (repr?.AST?.Symbols ?? []).map((sy: any) => sy.OriginalName)
      .filter((n: string) => !n.startsWith("require_"));
    return {
      name: tc.name,
      defineName: byKey.get(inp.Source.KeyPath.Text)?.DefineName,
      keyText: inp.Source.KeyPath.Text,
      sourceIdx: inp.Source.Index,
      identName: inp.Source.IdentifierName,
      contents: new TextDecoder().decode(inp.Source.Contents),
      loader: inp.Loader,
      sideKind: inp.SideEffects.Kind,
      symbols: syms,
      numParts: repr?.AST?.Parts?.length ?? 0,
      hasLazy: !!repr?.AST?.HasLazyExport,
    };
  });
}

test("injected 夹具 sha256（3 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("preprocessInjectedFiles 逐字节等于 Go", () => {
  const expected: any[] = [];
  for (const tc of cases) expected.push(...run(tc));
  assert.deepEqual(expected, rows);
});
