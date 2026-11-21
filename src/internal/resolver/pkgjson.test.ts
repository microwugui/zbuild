// 第 160 批：parsePackageJSON，Go 探针 24 例逐字节固化（Resolve 链核心构造器）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NewDeferLog, DeferLogKind, Source, Range } from "../logger/logger.ts";
import { realFS } from "../fs/fs_real.ts";
import {
  parsePackageJSON, packageJSON, pjEntryFull, pjMap,
} from "./package_json.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/pkgjson-go.json", import.meta.url)));
const SHA = "5658a78926eaca6e03536365022f91907653a9768be3cde61fc59dffa0dc17ff";

function dumpEntry(e: pjEntryFull): any {
  const rng = (r: any): any => r ? [r.Loc?.Start ?? 0, r.Len ?? 0] : [0, 0];
  return {
    k: e.kind, s: e.strData, tok: rng(e.firstToken),
    a: e.arrData.map(dumpEntry),
    m: e.mapData.map((p: any) => [p.key, dumpEntry(p.value), rng(p.keyRange)]),
    e: e.expansionKeys.map((p: any) => p.key),
  };
}
function dumpMap(m: pjMap | null): any {
  if (m === null) return null;
  return { key: m.propertyKey, loc: m.propertyKeyLoc?.Start ?? 0, root: dumpEntry(m.root as pjEntryFull) };
}
function dump(pj: packageJSON | null, msgs: string[]): any {
  if (pj === null) return { nil: true, msgs };
  const mfkeys = [...pj.mainFields.keys()].sort();
  const mf = mfkeys.map((k) => { const f = pj.mainFields.get(k)!; return [k, f.relPath, f.keyLoc.Start]; });
  const mtd: any = { type: pj.moduleTypeData.Type };
  if (pj.moduleTypeData.Source !== null) {
    mtd.range = [pj.moduleTypeData.Range.Loc.Start, pj.moduleTypeData.Range.Len];
  }
  let bm: any = null;
  if (pj.browserMap !== null) {
    const keys = [...pj.browserMap.keys()].sort();
    bm = keys.map((k) => [k, pj.browserMap!.get(k) ?? null]);
  }
  let sem: any = null;
  if (pj.sideEffectsMap !== null) {
    const keys = [...pj.sideEffectsMap.keys()].sort();
    sem = keys.map((k) => [k, pj.sideEffectsMap!.get(k)]);
  }
  let sed: any = null;
  if (pj.sideEffectsData !== null) {
    sed = [pj.sideEffectsData.IsSideEffectsArrayInJSON, [pj.sideEffectsData.Range.Loc.Start, pj.sideEffectsData.Range.Len]];
  }
  // Go regexp.String() 不转义 '/'，而 JS RegExp.source 会写成 '\/'；归一回 Go 形态
  const ser = pj.sideEffectsRegexps.map((re) => re.source.replace(/\\\//g, "/"));
  return {
    name: pj.name,
    mainFields: mf,
    moduleType: mtd,
    tsconfig: pj.tsconfig,
    browserMap: bm,
    sideEffectsMap: sem,
    sideEffectsData: sed,
    sideEffectsRegexps: ser,
    importsMap: dumpMap(pj.importsMap),
    exportsMap: dumpMap(pj.exportsMap),
    sourcePath: pj.source.KeyPath.Text,
    msgs,
  };
}

test("pkgjson fixture sha256 + 24 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const a = r.arg;
    const log = NewDeferLog(DeferLogKind.DeferLogAll, null);
    const map = new Map<string, string>([["/pkg/package.json", a.contents]]);
    const ctx: any = {
      fsObj: new realFS(false, "/"),
      log,
      tracker: null,
      platform: a.platform,
      mainFields: a.mainFields && a.mainFields.length ? a.mainFields : null,
      debugLogs: null,
      readFile: (path: string) => {
        const c = map.get(path);
        return c === undefined ? { contents: "", err: "ENOENT" } : { contents: c, err: null };
      },
    };
    const pj = parsePackageJSON("/pkg", ctx);
    const msgs = log.Done().map((m: any) => m.Data.Text);
    assert.deepEqual(dump(pj, msgs), r.out, `case: ${a.name}\n got: ${JSON.stringify(dump(pj, msgs))}\nwant: ${JSON.stringify(r.out)}`);
  }
});
