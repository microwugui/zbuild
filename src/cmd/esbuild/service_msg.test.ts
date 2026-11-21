// 第 82 轮：service 消息编解码纯函数差分（Go 探针固化 testdata/service-msg-go.json）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { encodeMessages, decodeMessages, decodeMessageToPrivate, encodeErrorPacket } from "./service.ts";
import type { ServiceMessage, Location } from "./service.ts";
import { MsgIDToString } from "../../internal/logger/msg_ids.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/service-msg-go.json", import.meta.url)));
const SHA = "6fa6531e9f7b300547ed31beb1931108235f0b0ba87c8addecf0fc772b0bd3b3";

// Go json.Marshal 的键排序 → TS 稳定 stringify
function canon(v: any): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (typeof v === "object") {
    if (v instanceof Uint8Array) return JSON.stringify(Buffer.from(v).toString("utf8"));
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

const LOC_A = { file: "a.js", namespace: "file", line: 3, column: 7, length: 5, lineText: "xy", suggestion: "try" } as any as Location;
const LOC_B = { file: "b.css", namespace: "ns", line: 1, column: 0, length: 0, lineText: "", suggestion: "" } as any as Location;
const MSGS: ServiceMessage[] = [
  { ID: "assign-to-constant", PluginName: "", Text: "cannot assign", Location: LOC_A,
    Notes: [{ Text: "note1", Location: LOC_B }, { Text: "note2", Location: null }], Detail: 42 },
  { ID: "", PluginName: "my-plugin", Text: "oops", Location: null, Notes: [], Detail: "s" },
  { ID: "bigint", PluginName: "", Text: "big", Location: LOC_B, Notes: [], Detail: null },
];

// 复刻 Go probe 的 encodeMessages 输入 → 期望 JSON
function expectedEncode(): string {
  return canon([
    { detail: 42, id: "assign-to-constant", location: { column: 7, file: "a.js", length: 5, line: 3, lineText: "xy", namespace: "file", suggestion: "try" },
      notes: [{ location: { column: 0, file: "b.css", length: 0, line: 1, lineText: "", namespace: "ns", suggestion: "" }, text: "note1" }, { location: null, text: "note2" }],
      pluginName: "", text: "cannot assign" },
    { detail: -1, id: "", location: null, notes: [], pluginName: "my-plugin", text: "oops" },
    { detail: -1, id: "bigint", location: { column: 0, file: "b.css", length: 0, line: 1, lineText: "", namespace: "ns", suggestion: "" }, notes: [], pluginName: "", text: "big" },
  ]);
}

type Row = { fn: string; arg: string; out: string };
const rows: Row[] = JSON.parse(new TextDecoder().decode(raw));
const byKey = (fn: string): string => rows.find((r) => r.fn === fn)!.out;

test("service-msg fixture sha256 + encode/decode 逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA, "service-msg fixture sha256");

  // encodeMessages
  assert.equal(canon(encodeMessages(MSGS)), expectedEncode(), "encodeMessages(three-msgs)");

  // encodeErrorPacket id=7 err=boom
  assert.equal(Buffer.from(encodeErrorPacket(7, "boom")).toString("base64"),
    JSON.parse(byKey("encodeErrorPacket")), "encodeErrorPacket(id7)");

  // decodeMessages roundtrip
  const locFlat = (l: Location | null): string => l === null ? "nil" :
    `${l.File}|${l.Namespace}|${l.Line}|${l.Column}|${l.Length}|${l.LineText}|${l.Suggestion}`;
  const detailInt = (v: unknown): number => typeof v === "number" ? v : -999;
  const dec = decodeMessages(encodeMessages(MSGS) as any);
  const dj = dec.map((m) => ({
    detail: detailInt(m.Detail), id: m.ID, loc: locFlat(m.Location), notes: m.Notes.length,
    notesData: m.Notes.map((n) => n.Text + "|" + locFlat(n.Location)),
    plugin: m.PluginName, text: m.Text,
  }));
  assert.equal(canon(dj), byKey("decodeMessages"), "decodeMessages(roundtrip)");

  // decodeMessageToPrivate
  const obj = {
    id: "assign-to-constant", pluginName: "p", text: "txt",
    location: { file: "x.js", namespace: "", line: 2, column: 1, length: 3, lineText: "z", suggestion: "" },
    detail: 9, notes: [{ text: "n1", location: null }],
  };
  const priv = decodeMessageToPrivate(obj);
  const pj = { id: MsgIDToString(priv.ID), plugin: priv.PluginName, text: priv.Data.Text,
    detail: priv.Data.UserDetail, notes: priv.Notes.length, locNil: priv.Data.Location === null };
  assert.equal(canon(pj), byKey("decodeMessageToPrivate"), "decodeMessageToPrivate(one)");
});
