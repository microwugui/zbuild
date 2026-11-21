// 第 159 批：ParseTSConfigJSON，Go 探针 32 例逐字节固化。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NewDeferLog, DeferLogKind, Source, Loc } from "../logger/logger.ts";
import { realFS } from "../fs/fs_real.ts";
import {
  ParseTSConfigJSON, TSConfigJSON, TSConfigPath, TSConfigPaths,
} from "./tsconfig_json.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/tsconfig-json-go.json", import.meta.url)));
const SHA = "153e872f0b59f5e38bae88764e2dcec69cf196bdfee7234262c926fd91206534";

function dump(c: TSConfigJSON | null, msgs: string[]): any {
  if (c === null) return { nil: true, msgs };
  let paths: any = null;
  if (c.Paths !== null) {
    const keys = [...c.Paths.Map.keys()].sort();
    const arr = keys.map((k) => {
      const items = (c.Paths!.Map.get(k) ?? []).map((p: TSConfigPath) => [p.Text, p.Loc.Start]);
      return [k, items];
    });
    paths = { src: c.Paths.Source.KeyPath.Text, map: arr };
  }
  let tsTarget: any = null;
  if (c.tsTargetKey.Range.Len > 0 || c.tsTargetKey.LowerValue !== "") {
    tsTarget = [
      c.tsTargetKey.LowerValue,
      c.tsTargetKey.Source ? c.tsTargetKey.Source.KeyPath.Text : "",
      [c.tsTargetKey.Range.Loc.Start, c.tsTargetKey.Range.Len],
    ];
  }
  let strict: any = null;
  if (c.TSStrict !== null) strict = [c.TSStrict.Name, c.TSStrict.Value, [c.TSStrict.Range.Loc.Start, c.TSStrict.Range.Len]];
  let alwaysStrict: any = null;
  if (c.TSAlwaysStrict !== null) alwaysStrict = [c.TSAlwaysStrict.Name, c.TSAlwaysStrict.Value, [c.TSAlwaysStrict.Range.Loc.Start, c.TSAlwaysStrict.Range.Len]];
  return {
    absPath: c.AbsPath,
    baseURL: c.BaseURL,
    baseURLForPaths: c.BaseURLForPaths,
    paths,
    tsTarget,
    strict,
    alwaysStrict,
    jsx: {
      jsx: c.JSXSettings.JSX,
      factory: c.JSXSettings.JSXFactory,
      fragment: c.JSXSettings.JSXFragmentFactory,
      importSource: c.JSXSettings.JSXImportSource,
    },
    settings: {
      experimentalDecorators: c.Settings.ExperimentalDecorators,
      importsNotUsedAsValues: c.Settings.ImportsNotUsedAsValues,
      preserveValueImports: c.Settings.PreserveValueImports,
      target: c.Settings.Target,
      useDefineForClassFields: c.Settings.UseDefineForClassFields,
      verbatimModuleSyntax: c.Settings.VerbatimModuleSyntax,
    },
    msgs,
  };
}

test("tsconfig-json fixture sha256 + 32 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  const fsobj = new realFS(false, "/");
  for (const r of rows) {
    const a = r.arg;
    const log = NewDeferLog(DeferLogKind.DeferLogAll, null);
    const source = new Source();
    source.Contents = new TextEncoder().encode(a.src);
    source.KeyPath.Text = "/work/tsconfig.json";
    let ext: ((p: string, range: any) => TSConfigJSON | null) | null = null;
    if (a.extends) {
      ext = (s: string) => {
        const base = new TSConfigJSON();
        base.BaseURL = "BASE:" + s;
        base.BaseURLForPaths = "/base";
        base.JSXSettings.JSX = 3; // TSJSXReact
        return base;
      };
    }
    const res = ParseTSConfigJSON(log, source, fsobj, a.fileDir, a.configDir, ext);
    const msgs = log.Done().map((m: any) => m.Data.Text);
    assert.deepEqual(dump(res, msgs), r.out, `case: ${a.src}`);
  }
});
