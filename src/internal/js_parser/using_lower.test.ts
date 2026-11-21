// 第 109 批：js_parser_lower using 声明降级整族逐字节等于 Go（5 场景）。
// 覆盖 shouldLowerUsingDeclarations / lowerUsingDeclarationContext / scanStmts /
// finalize / lowerUsingDeclarationInForOf，全部经 visitStmts 主链接进 Parse+Print。
// Go 期望值来自 tools/go/tmpgen_usinglower_test.go（Parse+Print，target=es2015，不经 linker）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Log, Source, Path } from "../logger/logger.ts";
import { Parse, Options } from "./js_parser.ts";
import { Format, Options as PO, Print } from "../js_printer/js_printer.ts";

const ES2015_BITS = 0x165fe46fc5c5ffb9n;

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/using-lower-go.json", import.meta.url)));
const SHA = "417e200ee8dedfc2767b1cfc1ba9bca6a2404313960769b122d903ad10b2991d";
const rows = JSON.parse(new TextDecoder().decode(raw)) as { name: string; out: string }[];

function run(src: string): string {
  const s = new Source();
  s.Index = 0;
  s.Contents = new TextEncoder().encode(src);
  s.KeyPath = new Path();
  s.KeyPath.Text = "<stdin>";
  const o = new Options();
  o.unsupportedJSFeatures = ES2015_BITS;
  o.originalTargetEnv = '"es2015"';
  const r = Parse(new Log(), s, o);
  assert.equal(r.ok, true, "parse ok");
  const syms = r.ast.Symbols;
  const ren = { NameForSymbol(ref: { InnerIndex: number }) {
    let i = ref.InnerIndex;
    const seen = new Set<number>();
    while (i < syms.length && syms[i]?.Link && syms[i].Link.InnerIndex !== i && syms[i].Link.InnerIndex < syms.length) {
      const nx = syms[i].Link.InnerIndex;
      if (seen.has(nx)) break;
      seen.add(nx);
      i = nx;
    }
    return syms[i]?.OriginalName ?? "";
  } };
  const po = new PO();
  po.OutputFormat = Format.FormatESModule;
  return new TextDecoder().decode(Print(r.ast, syms, ren, po).JS);
}

const SOURCES = [
  "using x = getResource();\nconsole.log(x);\n",
  "{\n  using a = foo(), b = bar();\n  use(a, b);\n}\n",
  "async function f() {\n  await using x = getResource();\n  return x;\n}\n",
  "for (using x of items) { use(x); }\n",
  '"use strict";\nimport "side";\nusing x = foo();\nuse(x);\n',
];

test("using-lower 夹具 sha256（5 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("using 降级整族逐字节等于 Go（Parse+Print，target=es2015）", () => {
  assert.equal(rows.length, 5);
  for (let i = 0; i < rows.length; i++) {
    const want = new TextDecoder().decode(Uint8Array.from(atob(rows[i].out), (c) => c.charCodeAt(0)));
    assert.equal(run(SOURCES[i]), want, `scenario ${i}: ${rows[i].name}`);
  }
});
