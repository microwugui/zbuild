// 第 38 轮：comma-target 语义保护 —— ② ts 4,108→4,122（+14，三轮零推进后首次真动）。
// 根因：TS 在 parse 期 fold logical（false||x→x），早于 call/tag/typeof/delete 的形态判定，
// 导致 "原本不是属性访问/标识符" 的信息丢失，printer 漏掉 "(0, x)" 语义保护。
// Go 在 visit 期才 fold，故这些 flag 按 fold 前的原始形态判定。期望字节来自 tmpgenparseprint(mode=ts)。
import test from "node:test";
import assert from "node:assert/strict";
import { Log, Path, Source } from "../logger/logger.ts";
import { Parse, Options } from "./js_parser.ts";
import { Format, Options as PO, Print } from "../js_printer/js_printer.ts";

function ts(src: string): string {
  const s = new Source();
  s.Index = 0;
  s.Contents = new TextEncoder().encode(src);
  s.KeyPath = new Path();
  s.KeyPath.Text = "<stdin>";
  const o = new Options();
  o.ts.Parse = true;
  o.jsx.Parse = true;
  const r = Parse(new Log(), s, o);
  assert.equal(r.ok, true, `parse ok: ${src}`);
  const syms = r.ast.Symbols;
  const ren = { NameForSymbol(ref: { InnerIndex: number }) {
    let i = ref.InnerIndex;
    const seen = new Set<number>();
    while (i < syms.length && syms[i]?.Link && syms[i].Link.InnerIndex !== i && syms[i].Link.InnerIndex < syms.length) {
      const nx = syms[i].Link.InnerIndex;
      if (seen.has(nx)) break;
      seen.add(nx); i = nx;
    }
    return syms[i]?.OriginalName ?? "";
  } };
  const p = new PO();
  p.OutputFormat = Format.FormatESModule;
  return new TextDecoder().decode(Print(r.ast, syms, ren, p).JS).trim();
}

const cases: [string, string][] = [
  ["(false || x[y])``", "(0, x[y])``;"],
  ["(null ?? x.y)``", "(0, x.y)``;"],
  ["(true && x[y])``", "(0, x[y])``;"],
  ["let x = (false || y[z])()", "let x = (0, y[z])();"],
  ["let x = (null ?? y.z)()", "let x = (0, y.z)();"],
  ["typeof (0 || x)", "typeof (0, x);"],
  ["return typeof (true && x)", "return typeof (0, x);"],
  ["delete (false || x)", "delete (0, x);"],
  ["delete (null ?? x)", "delete (0, x);"],
  ["typeof (1 && x)", "typeof (0, x);"],
];

test("comma-target 语义保护：call/tag/typeof/delete 的 fold 目标与 Go 字节逐例相等", () => {
  for (const [src, want] of cases) {
    assert.equal(ts(src), want, `ts ${JSON.stringify(src)}`);
  }
});
