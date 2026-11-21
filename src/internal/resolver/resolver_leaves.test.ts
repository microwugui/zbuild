// 第 141 批：resolver 剩余叶子 8 函数（bundler import 路径），Go 探针 37 例逐字节。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ParseJSON, JSONOptions } from "../js_parser/json_parser.ts";
import { NewDeferLog, DeferLogKind, Source, Loc } from "../logger/logger.ts";
import { parseImportsExportsMap, pjEntryFull } from "./package_json.ts";
import { TSConfigJSON, TSAlwaysStrict, tsTargetKey } from "./tsconfig_json.ts";
import { checkForBuiltInNodeModules } from "./resolver.ts";
import { getDependencyTarget, getPackage, resolveViaFallback, findLocator, pnpIdentAndReference } from "./yarnpnp.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/resolver-leaves-go.json", import.meta.url)));
const SHA = "cd3cad9a5b6ac74536ccf89e19da865e16ddaa146c80a5107490373748396cf2";
const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);
const dumpEntry = (e: pjEntryFull): any => ({
  k: e.kind, s: e.strData, tok: [e.firstToken?.Loc?.Start ?? 0, e.firstToken?.Len ?? 0],
  a: e.arrData.map(dumpEntry), m: e.mapData.map((p: any) => [p.key, dumpEntry(p.value), [p.keyRange?.Loc?.Start ?? 0, p.keyRange?.Len ?? 0]]),
  e: e.expansionKeys.map((p: any) => p.key),
});

test("resolver-leaves fixture sha256 + 37 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const a = r.arg; let got: any;
    switch (r.fn) {
      case "parseImportsExportsMap": {
        const log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null);
        const source = new Source(); source.Contents = new TextEncoder().encode(a.src);
        // key path for IsInsideNodeModules-style checks (none here)
        const { expr, ok } = ParseJSON(log, source, new JSONOptions());
        if (!ok) got = { nil: true, msgs: [] };
        else {
          const m = parseImportsExportsMap(source, log, expr, "exports", new Loc(0));
          if (!m) got = { nil: true, msgs: [] };
          else got = { root: dumpEntry(m.root), key: m.propertyKey, msgs: log.Done().map((m: any) => m.Data.Text) };
        }
        break;
      }
      case "checkForBuiltInNodeModules": {
        const v = checkForBuiltInNodeModules(a.path, a.platform, a.format, a.kind, a.feat, () => {});
        got = [v.pair.Primary, v.pair.IsExternal, v.ok, v.sideEffects]; break;
      }
      case "applyExtendedConfig": {
        const base = new TSConfigJSON(); base.BaseURL = "/base"; base.BaseURLForPaths = "/base";
        base.tsTargetKey = new tsTargetKey(); base.tsTargetKey.LowerValue = "es2020"; base.tsTargetKey.Range = { Loc: { Start: 1 }, Len: 6 };
        base.TSAlwaysStrict = new TSAlwaysStrict(true); base.TSStrict = new TSAlwaysStrict(false);
        const d = new TSConfigJSON(); d.AbsPath = "/derived"; d.applyExtendedConfig(base);
        got = [d.BaseURL, d.BaseURLForPaths, d.tsTargetKey.LowerValue, d.tsTargetKey.Range.Loc.Start,
          d.TSAlwaysStrict?.Value ?? false, d.TSStrict?.Value ?? false]; break;
      }
      case "TSAlwaysStrictOrStrict": {
        let d = new TSConfigJSON();
        if (a.which === "strict") d.TSStrict = new TSAlwaysStrict(false);
        else if (a.which === "alwaysStrict") { d.TSStrict = new TSAlwaysStrict(false); d.TSAlwaysStrict = new TSAlwaysStrict(true); }
        const v = d.TSAlwaysStrictOrStrict();
        got = a.which === "none" ? (v === null) : (v ? v.Value : null); break;
      }
      case "getDependencyTarget": {
        const log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null);
        const source = new Source(); source.Contents = new TextEncoder().encode(a.json);
        const { expr, ok } = ParseJSON(log, source, new JSONOptions());
        if (!ok) got = [false, "", "", 0, 0];
        else { const v = getDependencyTarget(expr); got = [v.ok, v.ident, v.reference, v.span.Loc.Start, v.span.Len]; }
        break;
      }
      case "getPackage": {
        const m = mkManifest();
        const v = getPackage(m, a.ident, a.ref);
        got = [v.ok, v.pkg.packageLocation, Object.keys(v.pkg.packageDependencies).length]; break;
      }
      case "resolveViaFallback": {
        const m = mkManifest(); const v = resolveViaFallback(m, a.ident);
        got = [v.ok, v.ident, v.reference]; break;
      }
      case "findLocator": {
        const m = mkManifest();
        const fsRel = (from: string, to: string) => ({ ok: true, value: to.startsWith(from + "/") ? to.slice(from.length + 1) : to });
        const v = findLocator(m, a.url, fsRel);
        got = [v.ok, v.ident, v.reference]; break;
      }
      default: throw new Error("unknown " + r.fn);
    }
    assert.equal(JSON.stringify(canon(got)), JSON.stringify(canon(r.out)), `${r.fn} ${JSON.stringify(a)} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 37);
});

function mkManifest(): any {
  const ir = (i: string, r: string) => { const v = new pnpIdentAndReference(); v.ident = i; v.reference = r; return v; };
  return {
    absDirPath: "/repo",
    packageRegistryData: {
      "": { "": { packageDependencies: { react: ir("react", "18.0.0") }, packageLocation: "", discardFromLookup: false } },
      react: { "18.0.0": { packageDependencies: {}, packageLocation: "./node_modules/react", discardFromLookup: false } },
    },
    fallbackPool: { lodash: ir("lodash", "4.0.0") },
    packageLocatorsByLocations: {
      "./node_modules/react/": { locator: ir("react", "18.0.0"), discardFromLookup: false },
      "./node_modules/old/": { locator: ir("old", "1.0.0"), discardFromLookup: true },
    },
  };
}
