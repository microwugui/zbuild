// 第 166 批：loadAsIndexWithBrowserRemapping + DebugMeta.LogErrorMsg，Go 探针 9 例逐字节固化。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NewDeferLog, DeferLogKind, Source, Path, Range, Loc, MsgData } from "../logger/logger.ts";
import { MockFS, MockUnix } from "../fs/fs_mock.ts";
import { dirInfo, packageJSON } from "./package_json.ts";
import { loadAsIndexWithBrowserRemapping, DebugMeta, suggestionRangeEnd, suggestionRangeFull } from "./resolver.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/remap-go.json", import.meta.url)));
const SHA = "5ed51c2817ef4b7c087788593a3f1faf1399ac891859fc3816cd52c383499719";

const dumpMsg = (m: any): any => {
  const loc: any = {};
  if (m.Data.Location !== null) { loc.suggestion = m.Data.Location.Suggestion; loc.line = m.Data.Location.Line; loc.column = m.Data.Location.Column; }
  return { kind: m.Kind, text: m.Data.Text, loc, notes: m.Notes.map((n: any) => n.Text) };
};

test("remap fixture sha256 + 9 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    if (r.fn === "loadAsIndexWithBrowserRemapping") {
      const name = r.arg.name;
      const entries: Record<string, string> = name === "index-remapped" ? { "/pkg/browser.js": "" }
        : name === "index-disabled" || name === "index-remap-miss" ? { "/pkg/index.js": "" }
        : { "/pkg/index.js": "" };
      const bm: Record<string, string | null> | null = name === "index-remapped" ? { index: "./browser.js" }
        : name === "index-disabled" ? { index: null }
        : name === "index-remap-miss" ? { index: "./missing.js" } : null;
      const fsobj = MockFS(entries, MockUnix, "/");
      const scope = new dirInfo(); scope.absPath = "/pkg"; scope.entries = fsobj.ReadDirectory("/pkg").dir;
      const pj = new packageJSON(); pj.source.KeyPath.Text = "/pkg/package.json"; pj.browserMap = bm === null ? null : new Map(Object.entries(bm));
      scope.packageJSON = pj;
      const di = new dirInfo(); di.absPath = "/pkg"; di.entries = scope.entries; di.enclosingBrowserScope = scope; di.parent = scope;
      const notes: string[] = [];
      let indent = "";
      const dl = { addNote: (s: string) => { notes.push(indent + s); }, increaseIndent: () => { indent += "  "; }, decreaseIndent: () => { indent = indent.slice(2); } };
      const log = NewDeferLog(DeferLogKind.DeferLogAll, null);
      const dirInfoCtx: any = { fsObj: fsobj, log, debugLogs: dl, platform: 0, mainFields: null, preserveSymlinks: false, dirCache: new Map(), pnpManifestWasChecked: true, readFile: () => ({ contents: "", err: "no such file or directory" }) };
      const ctx: any = { fsObj: fsobj, log, debugLogs: dl, platform: 0, extensionOrder: [".js", ".ts"], dirInfoCtx };
      const got = loadAsIndexWithBrowserRemapping(ctx, di, "/pkg", [".js", ".ts"]);
      assert.deepEqual([got.text, got.namespace, got.flags, got.ok, got.diffCase], r.out,
        `${name}\n got ${JSON.stringify([got.text, got.namespace, got.flags, got.ok, got.diffCase])}\nwant ${JSON.stringify(r.out)}`);
    } else if (r.fn === "LogErrorMsg") {
      const a = { name: r.arg.name };
      const cfg: Record<string, any> = {
        plain: { sugMsg: "", sugText: "", text: "some error", suggestion: "", sr: suggestionRangeFull, start: 2, len: 5, src: true, note: "" },
        "with-suggestion": { sugMsg: "try this", sugText: "replacement", text: "typo error", suggestion: "final", sr: suggestionRangeFull, start: 0, len: 4, src: true, note: "" },
        "suggestion-end": { sugMsg: "try this", sugText: "replacement", text: "typo error", suggestion: "", sr: suggestionRangeEnd, start: 0, len: 9, src: true, note: "" },
        "with-note": { sugMsg: "", sugText: "", text: "error", suggestion: "", sr: suggestionRangeFull, start: 0, len: 1, src: true, note: "extra info" },
        "no-source": { sugMsg: "try this", sugText: "rep", text: "error", suggestion: "", sr: suggestionRangeFull, start: 0, len: 1, src: false, note: "" },
      }[a.name]!;
      const log = NewDeferLog(DeferLogKind.DeferLogAll, null);
      let source: Source | null = null;
      if (cfg.src) { source = new Source(); source.Contents = new TextEncoder().encode("abcdefghij"); source.KeyPath.Text = "/src.js"; }
      const dm = new DebugMeta(); dm.suggestionMessage = cfg.sugMsg; dm.suggestionText = cfg.sugText; dm.suggestionRange = cfg.sr;
      const notes: MsgData[] = []; if (cfg.note) { const d = new MsgData(); d.Text = cfg.note; notes.push(d); }
      dm.LogErrorMsg(log, source, new Range(new Loc(cfg.start), cfg.len), cfg.text, cfg.suggestion, notes);
      assert.deepEqual(log.Done().map(dumpMsg), r.out,
        `${a.name}\n got ${JSON.stringify(log.Done().map(dumpMsg))}\nwant ${JSON.stringify(r.out)}`);
    }
  }
});
