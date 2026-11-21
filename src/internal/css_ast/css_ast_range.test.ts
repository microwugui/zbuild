// 第 91 轮叶子优先规划：css_ast Range/Equal 助手（Go 探针固化）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Loc, Range } from "../logger/logger.ts";
import { NameToken, NamespacedName, CompoundSelector } from "./css_ast.ts";

const FIXTURE = new URL("../../../testdata/css-ast-range-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "e272463394c9f6aead5d81d7dca1b31776ad8ba2db152ba53d6f826d7ea61e13";

interface Row { fn: string; arg: string; out: string; }
const dump = (r: Range): string => `${r.Loc.Start}:${r.Len}`;
const splitBy = (s: string, c: string): string[] => { const o: string[] = []; let st = 0; for (let i = 0; i < s.length; i++) if (s[i] === c) { o.push(s.slice(st, i)); st = i + 1; } o.push(s.slice(st)); return o; };

test("css-ast-range fixture sha256 + 12 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-ast-range fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    if (r.fn === "NameToken.Equal") {
      const p = splitBy(r.arg, "|");
      const a = new NameToken(); a.Text = p[0]; a.Kind = Number(p[1]);
      const b = new NameToken(); b.Text = p[2]; b.Kind = Number(p[3]);
      got = String(a.Equal(b));
    } else if (r.fn === "NamespacedName.Range") {
      const p = splitBy(r.arg, "|");
      const n = new NamespacedName();
      n.Name.Range = new Range(new Loc(Number(p[3])), Number(p[4]));
      if (p[0] === "1") { const pre = new NameToken(); pre.Range = new Range(new Loc(Number(p[1])), Number(p[2])); n.NamespacePrefix = pre; }
      got = dump(n.Range());
    } else if (r.fn === "CompoundSelector.Range") {
      const p = splitBy(r.arg, "|");
      const sel = new CompoundSelector();
      sel.Combinator = Number(p[0]); sel.CombinatorLoc = Number(p[1]);
      if (p[2] !== "-1") sel.NestingSelectorLocs = splitBy(p[2], ",").map(Number);
      if (p[3] !== "") sel.SubclassSelectors = splitBy(p[3], ";").map((x) => { const ab = splitBy(x, ":"); return { range: new Range(new Loc(Number(ab[0])), Number(ab[1])) }; });
      got = dump(sel.Range());
    } else throw new Error(`unknown ${r.fn}`);
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 12);
});
