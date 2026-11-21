// 第 42 轮深水链：TypeScript enum / namespace 全链 1:1 移植的逐字节回归测试。
// 期望字节来自一次集中 Go 探针（tmpgenparseprint mode=ts），固化在
// testdata/enum-chain-go.json（sha256 b3686c1d…），源在 testdata/enum-chain-src/。
// 覆盖底座：parser 的 namespace/enum 字段、getOrCreateExportedNamespaceMembers、
// parseTypeScriptEnumStmt/parseTypeScriptNamespaceStmt、两个 generateClosure*、
// visit SEnum/SNamespace、EIdentifier/EDot 常量折叠、printer EInlinedEnum。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Log, Path, Source } from "../logger/logger.ts";
import { Options, Parse } from "./js_parser.ts";
import { Format, Options as PO, Print } from "../js_printer/js_printer.ts";

const oracle: { id: string; outBase64: string; ok: boolean }[] = JSON.parse(
  readFileSync(new URL("../../../testdata/enum-chain-go.json", import.meta.url), "utf8"),
);

function printTS(src: string): string {
  const s = new Source();
  s.Index = 0;
  s.Contents = new TextEncoder().encode(src);
  s.KeyPath = new Path();
  s.KeyPath.Text = "<stdin>";
  const o = new Options();
  o.ts.Parse = true;
  o.jsx.Parse = true;
  const r = Parse(new Log(), s, o);
  assert.equal(r.ok, true, `parse ok: ${src.slice(0, 40)}`);
  const syms = r.ast.Symbols;
  const ren = {
    NameForSymbol(ref: { InnerIndex: number }): string {
      let i = ref.InnerIndex;
      const seen = new Set<number>();
      while (i < syms.length && syms[i]?.Link && syms[i].Link.InnerIndex !== i && syms[i].Link.InnerIndex < syms.length) {
        const nx = syms[i].Link.InnerIndex;
        if (seen.has(nx)) break;
        seen.add(nx);
        i = nx;
      }
      return syms[i]?.OriginalName ?? "";
    },
  };
  const po = new PO();
  po.OutputFormat = Format.FormatESModule;
  return new TextDecoder().decode(Print(r.ast, syms, ren, po).JS);
}

test("enum/namespace 全链逐字节等于 Go 探针（7 例）", () => {
  for (const c of oracle) {
    const src = readFileSync(new URL(`../../../testdata/enum-chain-src/${c.id}.ts`, import.meta.url), "utf8");
    const want = Buffer.from(c.outBase64, "base64").toString("utf8");
    assert.equal(printTS(src), want, `enum-chain: ${c.id}`);
  }
});

test("module 作为普通标识符不被误判为 namespace（回归 120970d81283）", () => {
  assert.equal(printTS("module;\n"), "module;\n");
});
