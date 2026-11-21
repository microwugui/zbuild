// 第 95 轮叶子优先规划：css_parser 媒体特征簇（3 函数一次探针，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Token, MediaQuery, MQPlainOrBoolean, MQNot, MQRange } from "../css_ast/css_ast.ts";
import { parsePlainOrBooleanMediaFeature, parseRangeMediaFeature, lowerMediaRange } from "./css_parser_media.ts";

const FIXTURE = new URL("../../../testdata/media-cluster-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "d317f4a410f15bbeaac52c49047709b796b1a1699b117e0b126dc2f3863178dc";

interface Row { fn: string; arg: string; out: string; }
const mkToks = (pairs: [number, string][]): Token[] => pairs.map(([k, t]) => { const tk = new Token(); tk.Kind = k; tk.Text = t; return tk; });
const dumpToks = (ts: Token[]): string => ts.map((t) => `${t.Kind}:${t.Text};`).join("");
const dumpMQ = (q: MediaQuery): string => {
  const d = q.Data;
  if (d instanceof MQPlainOrBoolean) return "plain|" + d.Name + "|";
  if (d instanceof MQNot) return "not|" + dumpMQ(d.Inner);
  if (d instanceof MQRange) return "range|" + d.Name + "|" + d.BeforeCmp + "|" + d.AfterCmp + "|" + dumpToks(d.Before) + "|" + dumpToks(d.After);
  return "other|";
};

test("media-cluster fixture sha256 + 12 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "media-cluster fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    if (r.fn === "parsePlainOrBooleanMediaFeature") {
      const v = parsePlainOrBooleanMediaFeature(mkToks(JSON.parse(r.arg)));
      got = v.ok ? `true|${v.result!.Name}|${dumpToks(v.result!.ValueOrNil)}` : "false";
    } else if (r.fn === "parseRangeMediaFeature") {
      const v = parseRangeMediaFeature(mkToks(JSON.parse(r.arg)));
      got = v.ok ? `true|${v.result!.Name}|${v.result!.BeforeCmp}|${v.result!.AfterCmp}|${dumpToks(v.result!.Before)}|${dumpToks(v.result!.After)}` : "false";
    } else if (r.fn === "lowerMediaRange") {
      const p = r.arg.indexOf("|"); const p2 = r.arg.indexOf("|", p + 1);
      const name = r.arg.slice(0, p);
      const cmp = Number(r.arg.slice(p + 1, p2));
      const rest = r.arg.slice(p2 + 1);
      got = dumpMQ(lowerMediaRange(0, name, cmp, mkToks(JSON.parse(rest))));
    } else throw new Error(`unknown ${r.fn}`);
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 12);
});
