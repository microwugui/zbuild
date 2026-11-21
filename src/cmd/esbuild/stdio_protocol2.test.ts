// 第 82 轮：encodePacket / decodePacket 字节差分（Go 探针固化 testdata/stdio-protocol2-go.json）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { encodePacket, decodePacket } from "./stdio_protocol.ts";
import type { Packet } from "./stdio_protocol.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/stdio-protocol2-go.json", import.meta.url)));
const SHA = "19e0b178396d38130b707cd783a24126fce46503cd9b78a59953b9f43a31839c";

const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");
const unb64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));
const U8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// Go dumpValue 的 TS 镜像（顺序：nil/bool/int/str/bytes/[]/map，map 键排序）
function dumpValue(v: any): string {
  if (v === null || v === undefined) return "nil";
  if (typeof v === "boolean") return "bool:" + String(v);
  if (typeof v === "number") return "int:" + String(v);
  if (typeof v === "string") return "str:" + v;
  if (v instanceof Uint8Array) return "bytes:" + new TextDecoder().decode(v);
  if (Array.isArray(v)) return "[" + v.map(dumpValue).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => k + "=" + dumpValue(v[k])).join(",") + "}";
}

// encode arg 描述符 → Packet。格式 <value>-<req|resp>-<id>
function parseEncode(arg: string): Packet {
  const i = arg.lastIndexOf("-");
  const j = arg.lastIndexOf("-", i - 1);
  const value = arg.slice(0, j);
  const req = arg.slice(j + 1, i) === "req";
  const id = Number(arg.slice(i + 1));
  const vals: Record<string, any> = {
    "nil": null, "bool-true": true, "bool-false": false,
    "int-42": 42, "int-neg": -7, "str-hello": "hello", "str-empty": "",
    "bytes-abc": U8("abc"),
    "array-mixed": [null, true, 7, "x", U8("y")],
    "map-sorted": { z: 1, a: "b", m: false },
    "nested": { arr: [1, { k: "v" }], n: null },
  };
  if (!(value in vals)) throw new Error(`unknown encode arg ${arg}`);
  return { value: vals[value], id, isRequest: req };
}

function decodeValue(name: string): Uint8Array | null {
  if (name === "truncated") return new Uint8Array([0, 0]);
  if (name === "empty") return new Uint8Array(0);
  const vals: Record<string, any> = {
    nil: null, true: true, false: false, int42: 42, str: "hello世界",
    bytes: U8("abc"), array: [null, true, 3, "x"], map: { b: 2, a: "z" },
  };
  if (!(name in vals)) throw new Error(`unknown decode arg ${name}`);
  return encodePacket({ value: vals[name], id: 0, isRequest: true });
}

type Row = { fn: string; arg: string; out: string };
const rows: Row[] = JSON.parse(new TextDecoder().decode(raw));

test("stdio-protocol2 fixture sha256 + encode/decode 逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA, "stdio-protocol2 fixture sha256");
  for (const r of rows) {
    let got: string;
    if (r.fn === "encodePacket") {
      got = b64(encodePacket(parseEncode(r.arg)));
    } else if (r.fn === "decodePacket") {
      const blob = decodeValue(r.arg);
      if (blob === null) throw new Error(`no blob for ${r.arg}`);
      const { packet, ok } = decodePacket(blob);
      if (!ok || packet === null) got = "!ok";
      else got = `id=${packet.id};req=${String(packet.isRequest)};${dumpValue(packet.value)}`;
      // 两个 malformed 行 out 是 boolStr(ok)
      if ((r.arg === "truncated" || r.arg === "empty") && r.out !== "!ok") got = String(ok);
    } else throw new Error(`unknown ${r.fn}`);
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 21);
});
