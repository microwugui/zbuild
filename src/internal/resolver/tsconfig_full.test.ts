// 第 168 批：parseTSConfig + parseTSConfigFromSource，Go 探针 8 例逐字节固化。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NewDeferLog, DeferLogKind, Source, Path } from "../logger/logger.ts";
import { MockFS, MockUnix } from "../fs/fs_mock.ts";
import { TSConfigJSON } from "./tsconfig_json.ts";
import { parseTSConfig, parseTSConfigFromSource } from "./resolver.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/tsconfig-full-go.json", import.meta.url)));
const SHA = "cde2d6b6919561b099284a1e62735431341876e41f9cdf91ccde06f662ece2c7";

const rng = (r: any): any => [r.Loc.Start, r.Len];
function dumpConfig(c: TSConfigJSON | null): any {
  if (c === null) return null;
  let paths: any = null;
  if (c.Paths !== null) {
    const keys = [...c.Paths.Map.keys()].sort();
    paths = { src: c.Paths.Source.KeyPath.Text, map: keys.map((k) => [k, (c.Paths!.Map.get(k) ?? []).map((p: any) => [p.Text, p.Loc.Start])]) };
  }
  let tsTarget: any = null;
  if (c.tsTargetKey.Range.Len > 0 || c.tsTargetKey.LowerValue !== "") {
    tsTarget = [c.tsTargetKey.LowerValue, c.tsTargetKey.Source ? c.tsTargetKey.Source.KeyPath.Text : "", rng(c.tsTargetKey.Range)];
  }
  let strict: any = null, always: any = null;
  if (c.TSStrict !== null) strict = [c.TSStrict.Name, c.TSStrict.Value, rng(c.TSStrict.Range)];
  if (c.TSAlwaysStrict !== null) always = [c.TSAlwaysStrict.Name, c.TSAlwaysStrict.Value, rng(c.TSAlwaysStrict.Range)];
  return {
    absPath: c.AbsPath, baseURL: c.BaseURL, baseURLForPaths: c.BaseURLForPaths,
    paths, tsTarget, strict, alwaysStrict: always, jsx: c.JSXSettings.JSX,
    settings: [c.Settings.ExperimentalDecorators, c.Settings.ImportsNotUsedAsValues, c.Settings.PreserveValueImports, c.Settings.Target, c.Settings.UseDefineForClassFields, c.Settings.VerbatimModuleSyntax],
  };
}

test("tsconfig-full fixture sha256 + 8 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const a = r.arg;
    const notes: string[] = [];
    const dl = { addNote: (s: string) => { notes.push(s); }, increaseIndent: () => {}, decreaseIndent: () => {} };
    const tree: Record<string, string> = {};
    if (a.contents !== "" || a.name === "bad-json") tree["/proj/tsconfig.json"] = a.contents;
    const fsobj = MockFS(tree, MockUnix, "/");
    const log = NewDeferLog(DeferLogKind.DeferLogAll, null);
    const ctx: any = { fsObj: fsobj, log, debugLogs: dl, preserveSymlinks: false,
      readFile: (path: string) => { const c = tree[path]; return c === undefined ? { contents: "", err: "no such file or directory" } : { contents: c, err: null }; } };
    let res: { config: TSConfigJSON | null; err: string };
    if (r.fn === "parseTSConfig") {
      res = parseTSConfig(ctx, "/proj/tsconfig.json", null, "/proj");
    } else {
      const src = new Source(); const kp = new Path(); kp.Text = "/proj/tsconfig.json"; kp.Namespace = "file"; src.KeyPath = kp; src.Contents = new TextEncoder().encode(a.contents);
      res = parseTSConfigFromSource(ctx, src, null, "/proj");
    }
    const msgs = log.Done().map((m: any) => m.Data.Text);
    assert.deepEqual([dumpConfig(res.config), res.err, msgs], r.out, `${r.fn} ${a.name}\n got ${JSON.stringify([dumpConfig(res.config), res.err, msgs])}\nwant ${JSON.stringify(r.out)}`);
  }
});
