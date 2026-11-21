// 第 162 批：compileYarnPnPData + resolveToUnqualified，Go 探针 11 例逐字节固化。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NewDeferLog, DeferLogKind, Source, Range } from "../logger/logger.ts";
import { ParseJSON, JSONOptions } from "../js_parser/json_parser.ts";
import { JSONFlavor } from "../js_lexer/js_lexer.ts";
import { realFS } from "../fs/fs_real.ts";
import {
  compileYarnPnPData, resolveToUnqualified, PnpData, pnpResult,
} from "./yarnpnp.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/pnp-go.json", import.meta.url)));
const SHA = "2cf05669f8e2507295bbc98e761ce5fbf9e6ff6113525bd513c077c196287613";

const rng = (r: any): any => r ? [r.Loc?.Start ?? 0, r.Len ?? 0] : [0, 0];
const iar = (a: any): any => [a?.ident ?? "", a?.reference ?? "", rng(a?.span)];

function dumpPnp(d: PnpData): any {
  let fel: any = null;
  if (d.fallbackExclusionList !== null) {
    const keys = Object.keys(d.fallbackExclusionList).sort();
    fel = keys.map((k) => [k, Object.keys(d.fallbackExclusionList![k]).sort()]);
  }
  let fp: any = null;
  if (d.fallbackPool !== null) {
    const keys = Object.keys(d.fallbackPool).sort();
    fp = keys.map((k) => [k, iar(d.fallbackPool![k])]);
  }
  let prd: any = null;
  if (d.packageRegistryData !== null) {
    const keys = Object.keys(d.packageRegistryData).sort();
    prd = keys.map((k) => {
      const inner = d.packageRegistryData![k];
      const rkeys = Object.keys(inner).sort();
      return [k, rkeys.map((r) => {
        const p = inner[r];
        const deps = Object.keys(p.packageDependencies).sort();
        return [r, [p.packageLocation, deps.map((dep) => [dep, iar(p.packageDependencies[dep])]), rng(p.packageDependenciesRange), p.discardFromLookup]];
      })];
    });
  }
  let plbl: any = null;
  if (d.packageLocatorsByLocations !== null) {
    const keys = Object.keys(d.packageLocatorsByLocations).sort();
    plbl = keys.map((k) => { const e = d.packageLocatorsByLocations![k]; return [k, iar(e.locator), e.discardFromLookup]; });
  }
  const ignorePattern = d.ignorePatternData ? d.ignorePatternData.source.replace(/\\\//g, "/") : "";
  return {
    absDirPath: d.absDirPath, absPath: d.absPath,
    enableTopLevelFallback: d.enableTopLevelFallback,
    fallbackExclusionList: fel, fallbackPool: fp,
    ignorePatternData: ignorePattern, invalidIgnorePatternData: d.invalidIgnorePatternData,
    packageRegistryData: prd, packageLocatorsByLocations: plbl,
  };
}
function dumpResult(r: pnpResult): any {
  return [r.status, r.pkgDirPath, r.pkgIdent, r.pkgSubpath, r.errorIdent, rng(r.errorRange)];
}

test("pnp fixture sha256 + 11 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  const fsobj = new realFS(false, "/");
  const fsRel = (from: string, to: string) => { const v = fsobj.Rel(from, to); return { ok: v.ok, value: v.value }; };

  let manifest: PnpData | null = null;
  for (const r of rows) {
    if (r.fn === "compileYarnPnPData") {
      const a = r.arg;
      const log = NewDeferLog(DeferLogKind.DeferLogAll, null);
      const source = new Source();
      source.Contents = new TextEncoder().encode(a.contents);
      source.KeyPath.Text = "/cache/install-state.gz.js";
      const opts = new JSONOptions(); opts.Flavor = JSONFlavor.TSConfigJSON;
      const parsed = ParseJSON(log, source, opts);
      const d = compileYarnPnPData("/cache/.pnp.js", "/cache", parsed.expr, source);
      if (a.name === "registry") manifest = d;
      assert.deepEqual(dumpPnp(d), r.out, `compileYarnPnPData: ${a.name}\n got: ${JSON.stringify(dumpPnp(d))}\nwant: ${JSON.stringify(r.out)}`);
    } else if (r.fn === "resolveToUnqualified") {
      const a = r.arg;
      const notes: string[] = [];
      const dl = { addNote: (s: string) => { notes.push(s); } };
      const res = resolveToUnqualified(a.spec, a.parent, manifest!, fsRel, dl);
      assert.deepEqual([dumpResult(res), notes], r.out, `resolveToUnqualified: ${a.spec} in ${a.parent}\n got: ${JSON.stringify([dumpResult(res), notes])}\nwant: ${JSON.stringify(r.out)}`);
    }
  }
});
