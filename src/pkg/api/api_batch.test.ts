// 第 121 批：api 纯助手大批量（Go 探针 27 例，api-batch-go.json）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Msg, MsgData, MsgKind, Log, NewDeferLog, DeferLogKind, MsgLocation, OutputOptions, TerminalInfo } from "../../internal/logger/logger.ts";
import { StringToMaximumMsgID } from "../../internal/logger/msg_ids.ts";
import {
  convertMessagesToPublic, convertMessagesToInternal, convertErrorsAndWarningsToInternal,
  validateRegex, validateKeepNames, metafileArray,
} from "./api_impl.ts";
import type { PublicMessage } from "./api_impl.ts";
import { convertEngineName } from "./api_js_table.ts";
import { ContextError } from "./api.ts";
import { errorsToString } from "./serve_other.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/api-batch-go.json", import.meta.url)));
const SHA = "89eed0b9db6a5461fc92a0b02b0117588a32ef19b6d08d2a41d4c217393e73dd";
const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);

function mkLoc(file: string, line: number): MsgLocation {
  const l = new MsgLocation(); l.File.Abs = file; l.File.Rel = file; l.Namespace = "file";
  l.Line = line; l.Column = 2; l.Length = 3; l.LineText = new TextEncoder().encode("line " + file); l.Suggestion = "sug";
  return l;
}
function mkMsg(id: string, kind: number, text: string, loc: MsgLocation | null, notes: string[] = []): Msg {
  const m = new Msg(); m.ID = StringToMaximumMsgID(id); m.PluginName = "plug"; m.Kind = kind;
  m.Data.Text = text; m.Data.Location = loc;
  for (const n of notes) { const d = new MsgData(); d.Text = n; d.Location = loc; m.Notes.push(d); }
  return m;
}
const srcMsgs = (): Msg[] => [
  mkMsg("css-syntax-error", MsgKind.Warning, "warn", mkLoc("a.css", 3), ["note1"]),
  mkMsg("package.json", MsgKind.Error, "err", null),
  mkMsg("not-a-real-id", MsgKind.Info, "info", mkLoc("b.js", 1)),
];
const loc = (file: string, line: number, ns = "", text = "", sug = "", col = 0): any => ({ File: file, Namespace: ns, Line: line, Column: col, Length: file === "x.css" ? 4 : 0, LineText: text, Suggestion: sug });
const pubMsgs = (): PublicMessage[] => [
  { ID: "css-syntax-error", PluginName: "p", Text: "hello", Location: loc("x.css", 2, "", "abc", "s", 1), Notes: [{ Text: "n", Location: loc("y.css", 3, "ns") }], Detail: null },
  { ID: "bogus", PluginName: "", Text: "world", Location: null, Notes: [], Detail: null },
];
const dInternal = (m: Msg): any => {
  const l = m.Data.Location;
  return { id: m.ID, plugin: m.PluginName, kind: m.Kind, text: m.Data.Text,
    loc: l === null ? null : { abs: l.File.Abs, rel: l.File.Rel, ns: l.Namespace, line: l.Line, col: l.Column, len: l.Length, text: new TextDecoder().decode(l.LineText), sug: l.Suggestion },
    notes: m.Notes.map((n) => ({ text: n.Text, loc: n.Location !== null })) };
};
const dPublic = (m: PublicMessage): any => ({
  id: m.ID, plugin: m.PluginName, text: m.Text, detail: m.Detail ?? null,
  loc: m.Location === null ? null : { file: m.Location.File, ns: m.Location.Namespace, line: m.Location.Line, col: m.Location.Column, len: m.Location.Length, text: m.Location.LineText, sug: m.Location.Suggestion },
  notes: m.Notes.map((n) => ({ text: n.Text, loc: n.Location !== null })),
});
const dLog = (log: Log): string[] => log.Done().map((m: any) => `${m.Kind}|${m.Data.Text}`);

test("api-batch fixture sha256 + 27 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: any;
    switch (r.fn) {
      case "convertEngineName": got = convertEngineName(Number(r.arg)); break;
      case "ContextError.Error": got = new ContextError(r.arg === 0 ? [] : [{ ID: "", PluginName: "", Text: "first error", Location: null, Notes: [], Detail: null }]).Error(); break;
      case "metafileArray.Len": got = new metafileArray([{ name: "a.js", size: 10 }, { name: "b.js", size: 20 }, { name: "c.js", size: 10 }]).Len(); break;
      case "metafileArray": {
        const a = new metafileArray([{ name: "a.js", size: 10 }, { name: "b.js", size: 20 }, { name: "c.js", size: 10 }]);
        const less = a.Less(0, 1);
        a.Swap(0, 1);
        a.Swap(0, 1);
        assert.equal(less, false);
        a.entries.sort((x: any, y: any) => a.LessOn(x, y) ? -1 : (a.LessOn(y, x) ? 1 : 0));
        got = a.entries.map((e: any) => e.name);
        break;
      }
      case "convertMessagesToPublic": got = convertMessagesToPublic(Number(r.arg), srcMsgs(), Number(r.arg)).map(dPublic); break;
      case "convertMessagesToInternal": got = convertMessagesToInternal([], MsgKind.Warning, pubMsgs()).map(dInternal); break;
      case "convertErrorsAndWarningsToInternal": {
        const errs: PublicMessage[] = [
          { ID: "", PluginName: "", Text: "e1", Location: loc("a", 3), Notes: [], Detail: null },
          { ID: "", PluginName: "", Text: "e2", Location: loc("a", 1), Notes: [], Detail: null },
        ];
        const warns: PublicMessage[] = [{ ID: "", PluginName: "", Text: "w1", Location: loc("b", 2), Notes: [], Detail: null }];
        got = convertErrorsAndWarningsToInternal(errs, warns).map(dInternal);
        break;
      }
      case "errorsToString": got = errorsToString(pubMsgs()); break;
      case "validateRegex": {
        const log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null);
        const re = validateRegex(log, "banner", String(r.arg));
        got = { ok: re !== null, errs: dLog(log) };
        break;
      }
      case "validateKeepNames": {
        const a = r.arg as any[];
        const log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null);
        validateKeepNames(log, { KeepNames: a[0], OriginalTargetEnv: a[1], UnsupportedJSFeatures: a[2], UnsupportedJSFeatureOverridesMask: a[2] });
        got = dLog(log);
        break;
      }
      default: throw new Error("unknown fn " + r.fn);
    }
    assert.equal(JSON.stringify(canon(got)), JSON.stringify(canon(r.out)), `${r.fn} ${JSON.stringify(r.arg)} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 27);
});
