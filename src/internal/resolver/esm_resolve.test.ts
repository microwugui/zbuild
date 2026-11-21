// 第 140 批：ESM resolution 族 + resolver 小助手（bundler import 路径核心，Go 探针 232 例逐字节）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  mkEntry, pjDebug, esmHandlePostConditions, esmPackageTargetResolve,
  esmPackageImportsExportsResolve, esmPackageImportsResolve, esmPackageExportsResolve,
  esmPackageTargetReverseResolve, esmPackageImportsExportsReverseResolve, esmPackageExportsReverseResolve,
  esmReverseExact, esmReversePattern, esmReversePrefix,
} from "./package_json.ts";
import { isExternal, MakePrettyPaths, flushDebugLogs, tsConfigForDir } from "./resolver.ts";
import { NewDeferLog, DeferLogKind, AddIDWithNotes, Source, MakeLineColumnTracker } from "../logger/logger.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/esm-resolve-go.json", import.meta.url)));
const SHA = "d025beb42231a6a1e89dbd00e35a9b409f1c0397fc92251f682bf2f645612028";
const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);

// a fresh debugLogs accumulator mirroring Go debugLogs
const mkDL = () => {
  const notes: string[] = []; let indent = "";
  return {
    notes,
    addNote(t: string) { notes.push(indent !== "" ? indent + t : t); },
    increaseIndent() { indent += "  "; },
    decreaseIndent() { indent = indent.slice(2); },
  };
};
const dDump = (d: pjDebug): any => [d.invalidBecause, d.unmatchedConditions.map((s) => [s.Text, s.Range.Loc.Start, s.Range.Len]), d.token?.Loc?.Start ?? 0, d.token?.Len ?? 0, d.isBecauseOfNullLiteral];
const rDump = (r: { resolved: string; status: number; debug: pjDebug }, dl: any): any => [r.resolved, r.status, dDump(r.debug), dl.notes];
const revDump = (r: { ok: boolean; subpath: string; token: any }, dl: any): any => [r.ok, r.subpath, r.token?.Loc?.Start ?? 0, r.token?.Len ?? 0, dl.notes];

test("esm-resolve fixture sha256 + 232 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const arg = r.arg; let got: any;
    switch (r.fn) {
      case "esmHandlePostConditions": {
        const dl = mkDL(); const d = new pjDebug();
        got = rDump(esmHandlePostConditions(arg.resolved, arg.st, d, dl), dl); break;
      }
      case "esmPackageTargetResolve": {
        const dl = mkDL(); const conds: Record<string, boolean> = {}; for (const c of arg.conds) conds[c] = true;
        got = rDump(esmPackageTargetResolve("/pkg", mkEntry(arg.tgt), arg.sub, arg.pat, arg.internal, conds, dl), dl); break;
      }
      case "esmPackageImportsExportsResolve": {
        const dl = mkDL(); const conds: Record<string, boolean> = { import: true };
        got = rDump(esmPackageImportsExportsResolve(arg.key, mkEntry(arg.obj), "/pkg", arg.isImports, conds, dl), dl); break;
      }
      case "esmPackageImportsResolve": {
        const dl = mkDL(); const conds: Record<string, boolean> = { import: true };
        const obj = { k: 3, t: [200, 1], m: [
          ["./exact.js", { k: 1, s: "./a.js", t: [201, 3] }, [201, 9]],
          ["./wild/*", { k: 1, s: "./w/*.js", t: [202, 3] }, [202, 7]],
          ["./dir/", { k: 1, s: "./d/", t: [203, 3] }, [203, 6]],
        ] };
        got = rDump(esmPackageImportsResolve(arg.key, mkEntry(obj), conds, dl), dl); break;
      }
      case "esmPackageExportsResolve": {
        const dl = mkDL(); const conds: Record<string, boolean> = { import: true };
        const obj = { k: 3, t: [200, 1], m: [
          ["./exact.js", { k: 1, s: "./a.js", t: [201, 3] }, [201, 9]],
          ["./wild/*", { k: 1, s: "./w/*.js", t: [202, 3] }, [202, 7]],
          ["./dir/", { k: 1, s: "./d/", t: [203, 3] }, [203, 6]],
        ] };
        got = rDump(esmPackageExportsResolve("/pkg", arg.sub, mkEntry(obj), conds, dl), dl); break;
      }
      case "esmPackageExportsReverseResolve": {
        const dl = mkDL(); const conds: Record<string, boolean> = { import: true };
        const obj = { k: 3, t: [200, 1], m: [
          ["./exact.js", { k: 1, s: "./a.js", t: [201, 3] }, [201, 9]],
          ["./wild/*", { k: 1, s: "./w/*.js", t: [202, 3] }, [202, 7]],
          ["./dir/", { k: 1, s: "./d/", t: [203, 3] }, [203, 6]],
        ] };
        got = revDump(esmPackageExportsReverseResolve(arg.query, mkEntry(obj), conds), dl); break;
      }
      case "esmPackageTargetReverseResolve": {
        const dl = mkDL(); const conds: Record<string, boolean> = { import: true };
        got = revDump(esmPackageTargetReverseResolve(arg.query, arg.key, mkEntry(arg.target), arg.kind, conds), dl); break;
      }
      case "MakePrettyPaths": {
        const fsObj = { Cwd: () => "/root/port", Rel: (_c: string, p: string) => ({ ok: true, value: p.replace("/root/port/", "") }) };
        got = [MakePrettyPaths(fsObj, arg.text, arg.ns, arg.suffix ?? "", false).Abs, MakePrettyPaths(fsObj, arg.text, arg.ns, arg.suffix ?? "", false).Rel]; break;
      }
      case "isExternal": {
        const pats = [{ Prefix: "lodash/", Suffix: "" }];
        got = isExternal({ react: true }, pats, arg.path, arg.kind, mkDL()); break;
      }
      case "flushDebugLogs": {
        const log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null);
        const dl = mkDL(); (dl as any).what = "desc"; dl.addNote("n1");
        const src = new Source(); src.Contents = new TextEncoder().encode("");
        const tracker = MakeLineColumnTracker(src);
        const add = (lg: any, id: number, kind: number, _tr: any, range: any, text: string, notes: any[]) =>
          AddIDWithNotes(lg, id, kind, tracker, range, text, notes);
        flushDebugLogs(log, dl, arg.mode, add);
        got = log.Done().map((m: any) => [m.Kind, m.Data.Text]); break;
      }
      default: throw new Error("unknown " + r.fn);
    }
    assert.equal(JSON.stringify(canon(got)), JSON.stringify(canon(r.out)),
      `${r.fn} ${JSON.stringify(arg)} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 232);
});

test("tsConfigForDir 三分支直测（V8 覆盖）", () => {
  const tc = { x: 1 };
  assert.equal(tsConfigForDir({ isInsideNodeModules: true }, tc), null);
  assert.equal(tsConfigForDir({ isInsideNodeModules: false, enclosingTSConfigJSON: tc }, null), tc);
  assert.equal(tsConfigForDir({ isInsideNodeModules: false, enclosingTSConfigJSON: tc }, tc), tc);
  assert.equal(tsConfigForDir(null, null), null);
});
