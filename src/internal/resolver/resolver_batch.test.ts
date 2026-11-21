// 第 123 批：resolver 纯 helper 大批（Go 探针 40 例，逐字节）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NewDeferLog, DeferLogKind, Source, Loc, MakeLineColumnTracker } from "../logger/logger.ts";
import { isSlash, getSubstitutedPathWithConfigDirTemplate, parseMemberExpressionForJSX, isValidTSConfigPathPattern, isValidTSConfigPathNoBaseURLPattern } from "./tsconfig_json.ts";
import { parseBareIdentifier } from "./yarnpnp.ts";
import { expansionKeysArray } from "./package_json.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/resolver-batch-go.json", import.meta.url)));
const SHA = "77c5bc65cac7f1bf5c8f327dd295ecde23a3385f2a8f2dbcac0ee5d3fb27ae16";
const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);
const mk = (text: string) => {
  const log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null);
  const source = new Source(); source.Contents = new TextEncoder().encode(text);
  const tracker = MakeLineColumnTracker(source);
  return { log, source, tracker, errs: () => log.Done().map((m: any) => `${m.Kind}|${m.Data.Text}`) };
};

test("resolver-batch fixture sha256 + 40 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: any;
    const text = String(r.arg ?? "");
    switch (r.fn) {
      case "isSlash": got = isSlash(text.charCodeAt(0)); break;
      case "getSubstitutedPathWithConfigDirTemplate": got = getSubstitutedPathWithConfigDirTemplate(text, "/root/port"); break;
      case "parseMemberExpressionForJSX": {
        const s = mk(text);
        got = { parts: parseMemberExpressionForJSX(s.log, s.source, s.tracker, 0, text), errs: s.errs() };
        break;
      }
      case "isValidTSConfigPathPattern": {
        const s = mk(text);
        got = { ok: isValidTSConfigPathPattern(text, s.log, s.source, s.tracker, 0), errs: s.errs() };
        break;
      }
      case "isValidTSConfigPathNoBaseURLPattern": {
        const s = mk(text);
        got = { ok: isValidTSConfigPathNoBaseURLPattern(text, s.log, s.source, { tracker: s.tracker }, 0), errs: s.errs() };
        break;
      }
      case "parseBareIdentifier": { const v = parseBareIdentifier(text); got = { ident: v.ident, sub: v.modulePath, ok: v.ok }; break; }
      case "expansionKeysArray.Len": got = new expansionKeysArray([{ key: "z/*" }, { key: "a/" }, { key: "b*" }]).Len(); break;
      case "expansionKeysArray.Swap": { const a = new expansionKeysArray([{ key: "z/*" }, { key: "a/" }, { key: "b*" }]); a.Swap(0, 1); got = a.entries.map((e: any) => e.key); break; }
      case "expansionKeysArray.Less": { const a = new expansionKeysArray([{ key: "z/*" }, { key: "a/" }, { key: "b*" }]); a.Swap(0, 1); got = a.Less(0, 1); break; }
      case "expansionKeysArray.sort": {
        const a = new expansionKeysArray([{ key: "z/*" }, { key: "a/" }, { key: "b*" }]);
        const order = a.entries.map((_, i) => i);
        order.sort((i, j) => a.Less(i, j) ? -1 : (a.Less(j, i) ? 1 : 0));
        a.entries = order.map((i) => a.entries[i]);
        got = a.entries.map((e: any) => e.key);
        break;
      }
      default: throw new Error("unknown " + r.fn);
    }
    assert.equal(JSON.stringify(canon(got)), JSON.stringify(canon(r.out)), `${r.fn} ${JSON.stringify(r.arg)} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 40);
});
