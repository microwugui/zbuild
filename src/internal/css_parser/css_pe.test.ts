// 第 117 批：parser token 助手 5 函数（Go 探针 16 例，逐字节含 logger 消息）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Tokenize } from "../css_lexer/css_lexer.ts";
import { Source, Loc, NewDeferLog, DeferLogKind, MakeLineColumnTracker } from "../logger/logger.ts";
import { CSSParser } from "./css_parser.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/css-pe-go.json", import.meta.url)));
const SHA = "e0773fdac9cc6e5ce23c755a6c5f4b0493184bfcea343a870a393be5ffe61b46";
const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);

test("css-pe fixture sha256 + 16 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null);
    const source = new Source();
    source.Contents = new TextEncoder().encode(r.src);
    const p = new CSSParser();
    p.tokens = Tokenize(source).tokens;
    p.source = source;
    p.index = r.index;
    p.log = log;
    p.tracker = MakeLineColumnTracker(source);
    p.prevError = new Loc(0);
    let ret = true;
    switch (r.fn) {
      case "expect": ret = p.expect(r.kind); break;
      case "expectWithMatchingLoc": ret = p.expectWithMatchingLoc(r.kind, r.match ?? 0); break;
      case "unexpected": p.unexpected(); break;
      case "parseComponentValue": p.parseComponentValue(); break;
      case "parseBlock": p.parseBlock(r.kind, 8 /* TCloseParen */); break;
      default: throw new Error("unknown " + r.fn);
    }
    const msgs = log.Done().map((m: any) => {
      const o: any = { text: m.Data.Text, kind: m.Kind, line: m.Data.Location?.Line ?? 0, col: m.Data.Location?.Column ?? 0, len: m.Data.Location?.Length ?? 0 };
      if (m.Notes.length) o.notes = m.Notes.map((n: any) => n.Text);
      return o;
    });
    const got = { index: p.index, ret, msgs };
    assert.equal(JSON.stringify(canon(got)), JSON.stringify(canon(r.out)), `${r.fn} ${r.src} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 16);
});
