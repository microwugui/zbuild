// 第 81 轮事故恢复：补回被 round-80 删除的孤儿测试所提供的两处覆盖。
// RefsAreEquivalent / MediaQueriesEqual 由 Go 包内探针固化于
// testdata/css-ast-equal-go.json（SHA 钉死），逐例 bool 等于 Go 真实调用。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Ref, Symbol, SymbolMap, SymbolKind, InvalidRef } from "../ast/ast.ts";
import {
  CrossFileEqualityCheck, MediaQuery, MQPlainOrBoolean, MQRange, Token,
  MediaQueriesEqual,
} from "./css_ast.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/css-ast-equal-go.json", import.meta.url)));
const SHA = "d365da98ef2c95bf8d01f20c1d4571367254e9662445d4dfb30f513f5da814b3";

const mkRef = (r: { ii: number; si: number }): Ref => new Ref(r.si >>> 0, r.ii >>> 0);
const mkTok = (t: { k: number; t: string }): Token => { const x = new Token(); x.Kind = t.k; x.Text = t.t; return x; };
const mkToks = (a: { k: number; t: string }[] | undefined): Token[] => (a ?? []).map(mkTok);

function mkCheck(c: any): CrossFileEqualityCheck | null {
  if (c === null || c === undefined) return null;
  const check = new CrossFileEqualityCheck();
  const symA = (c.symA ?? []).map((s: any) => {
    const sym = new Symbol();
    sym.Kind = s.kind; sym.OriginalName = s.name; sym.Link = InvalidRef;
    return sym;
  });
  const symB = (c.symB ?? []).map((s: any) => {
    const sym = new Symbol();
    sym.Kind = s.kind; sym.OriginalName = s.name; sym.Link = InvalidRef;
    return sym;
  });
  check.Symbols = new SymbolMap([symA, symB]);
  return check;
}

function mkQueries(list: any[]): MediaQuery[] {
  return list.map((q) => {
    const mq = new MediaQuery();
    if (q.ty === "plain") {
      const d = new MQPlainOrBoolean(); d.Name = q.text; d.ValueOrNil = mkToks(q.toks); mq.Data = d;
    } else if (q.ty === "range") {
      const d = new MQRange();
      d.Name = q.text; d.Before = mkToks(q.before); d.After = mkToks(q.after);
      d.BeforeCmp = q.bc; d.AfterCmp = q.ac; mq.Data = d;
    } else throw new Error(`unknown MQ type ${q.ty}`);
    return mq;
  });
}

type Row = { fn: string; a: any; b: any; check: any; out: string };
const rows: Row[] = JSON.parse(new TextDecoder().decode(raw));

test("css-ast equal fixture sha256 + RefsAreEquivalent / MediaQueriesEqual 逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA, "css-ast-equal fixture sha256");
  for (const r of rows) {
    let got: boolean;
    if (r.fn === "RefsAreEquivalent") {
      const check = mkCheck(r.check);
      // Go: check.RefsAreEquivalent(a, b)。check 为 null 时只有 refs 相等才成立。
      if (check === null) {
        const a = mkRef(r.a), b = mkRef(r.b);
        got = a.InnerIndex === b.InnerIndex && a.SourceIndex === b.SourceIndex;
      } else {
        got = check.RefsAreEquivalent(mkRef(r.a), mkRef(r.b));
      }
    } else if (r.fn === "MediaQueriesEqual") {
      got = MediaQueriesEqual(mkQueries(r.a), mkQueries(r.b), mkCheck(r.check));
    } else continue;
    assert.equal(String(got), r.out, `${r.fn}(${JSON.stringify(r.a)},${JSON.stringify(r.b)})`);
  }
});
