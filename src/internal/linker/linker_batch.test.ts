// 第 122 批：linker 纯 helper 大批（Go 探针 25 例，逐字节）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Msg, MsgKind, NewDeferLog, DeferLogKind } from "../logger/logger.ts";
import { ImportConditions, MediaQuery, MQPlainOrBoolean, Token } from "../css_ast/css_ast.ts";
import {
  crossChunkImportArray, crossChunkImportItemArray, stableRefArray, chunkOrderArray,
  chunkReprJS, chunkReprCSS, wrappedLog, importConditionsAreEqual,
  isConditionalImportRedundant, hashWriteLengthPrefixed,
} from "./linker.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/linker-batch-go.json", import.meta.url)));
const SHA = "eb4c3c10ccdc07492178c988179a9e96ba29d093eeefb58fdb5d6ff1da0426be";
const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);
const mkTok = (text: string): Token => { const t = new Token(); t.Kind = 29; t.Text = text; return t; };
const cond = (layers: string[], supports: string[], media: string[]): ImportConditions => {
  const c = new ImportConditions();
  for (const s of layers) c.Layers.push(mkTok(s));
  for (const s of supports) c.Supports.push(mkTok(s));
  for (const s of media) { const q = new MediaQuery(); const d = new MQPlainOrBoolean(); d.Name = s; q.Data = d; c.Queries.push(q); }
  return c;
};
const mkMsg = (kind: number, text: string): Msg => { const m = new Msg(); m.Kind = kind; m.Data.Text = text; return m; };
const sortWith = (arr: any): void => {
  const order = arr.entries.map((_: any, i: number) => i);
  order.sort((i: number, j: number) => arr.Less(i, j) ? -1 : (arr.Less(j, i) ? 1 : 0));
  arr.entries = order.map((i: number) => arr.entries[i]);
};

test("linker-batch fixture sha256 + 25 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  const ccia = () => new crossChunkImportArray([{ chunkIndex: 3 }, { chunkIndex: 1 }, { chunkIndex: 2 }]);
  const ccii = () => new crossChunkImportItemArray([{ exportAlias: "z" }, { exportAlias: "a" }, { exportAlias: "m" }]);
  const sra = () => new stableRefArray([
    { StableSourceIndex: 2, Ref: { SourceIndex: 0, InnerIndex: 1 } },
    { StableSourceIndex: 1, Ref: { SourceIndex: 0, InnerIndex: 9 } },
    { StableSourceIndex: 2, Ref: { SourceIndex: 0, InnerIndex: 0 } },
  ]);
  const coa = () => new chunkOrderArray([{ distance: 5, tieBreaker: 1 }, { distance: 3, tieBreaker: 2 }, { distance: 5, tieBreaker: 0 }]);
  const refStr = (a: any): string[] => a.entries.map((x: any) => `${x.StableSourceIndex}:${x.Ref.InnerIndex}`);
  const ordStr = (a: any): string[] => a.entries.map((x: any) => `${x.distance}:${x.tieBreaker}`);
  for (const r of rows) {
    let got: any;
    switch (r.fn) {
      case "crossChunkImportArray.Len": got = ccia().Len(); break;
      case "crossChunkImportArray.Swap": { const a = ccia(); a.Swap(0, 1); got = a.entries.map((x: any) => x.chunkIndex); break; }
      case "crossChunkImportArray.Less": { const a = ccia(); got = a.Less(0, 1); break; }
      case "crossChunkImportArray.sort": { const a = ccia(); sortWith(a); got = a.entries.map((x: any) => x.chunkIndex); break; }
      case "crossChunkImportItemArray.Len": got = ccii().Len(); break;
      case "crossChunkImportItemArray.Swap": { const a = ccii(); a.Swap(0, 2); got = a.entries.map((x: any) => x.exportAlias); break; }
      case "crossChunkImportItemArray.Less": got = ccii().Less(0, 1); break;
      case "crossChunkImportItemArray.sort": { const a = ccii(); sortWith(a); got = a.entries.map((x: any) => x.exportAlias); break; }
      case "stableRefArray.Len": got = sra().Len(); break;
      case "stableRefArray.Swap": { const a = sra(); a.Swap(0, 2); got = refStr(a); break; }
      case "stableRefArray.Less": got = sra().Less(0, 2); break;
      case "stableRefArray.sort": { const a = sra(); sortWith(a); got = refStr(a); break; }
      case "chunkOrderArray.Len": got = coa().Len(); break;
      case "chunkOrderArray.Swap": { const a = coa(); a.Swap(0, 1); got = ordStr(a); break; }
      case "chunkOrderArray.Less": got = coa().Less(0, 2); break;
      case "chunkOrderArray.sort": { const a = coa(); sortWith(a); got = ordStr(a); break; }
      case "chunkReprJS.isChunk": new chunkReprJS().isChunk(); got = true; break;
      case "chunkReprCSS.isChunk": new chunkReprCSS().isChunk(); got = true; break;
      case "wrappedLog": {
        const base = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null);
        base.AddMsg(mkMsg(MsgKind.Error, "old"));
        const log = wrappedLog(base);
        const before = log.HasErrors();
        log.AddMsg(mkMsg(MsgKind.Warning, "warn"));
        const afterWarn = log.HasErrors();
        log.AddMsg(mkMsg(MsgKind.Error, "new"));
        got = { before, afterWarn, afterErr: log.HasErrors(), msgs: log.Done().map((m: any) => m.Data.Text) };
        break;
      }
      case "importConditionsAreEqual": {
        const a = [cond(["a"], ["supports(display:flex)"], ["screen"])];
        const b = [cond(["a"], ["supports(display:flex)"], ["screen"])];
        const c = [cond(["a"], [], ["screen"])];
        got = r.arg === "a|a" ? importConditionsAreEqual(a, b) : importConditionsAreEqual(a, c);
        break;
      }
      case "isConditionalImportRedundant": {
        const a = [cond(["a"], ["supports(display:flex)"], ["screen"])];
        const b = [cond(["a"], ["supports(display:flex)"], ["screen"])];
        const c = [cond(["a"], [], ["screen"])];
        const d = [cond(["a"], ["supports(display:flex)"], [])];
        got = r.arg === "a|a" ? isConditionalImportRedundant(a, b)
          : r.arg === "a|c" ? isConditionalImportRedundant(a, c) : isConditionalImportRedundant(a, d);
        break;
      }
      case "hashWriteLengthPrefixed": {
        const h = createHash("sha256");
        hashWriteLengthPrefixed(h as any, new TextEncoder().encode("abc"));
        hashWriteLengthPrefixed(h as any, new TextEncoder().encode("bc"));
        got = h.digest("hex");
        break;
      }
      default: throw new Error("unknown " + r.fn);
    }
    assert.equal(JSON.stringify(canon(got)), JSON.stringify(canon(r.out)), `${r.fn} ${JSON.stringify(r.arg)} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 25);
});
