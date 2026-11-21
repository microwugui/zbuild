// 第 113 轮：parser visit 内层整族（handleIdentifier / maybeRewritePropertyAccess / parseExprOrLetOrUsingStmt / binaryExprVisitor.checkAndPrepare /
// visitRightAndFinish）+ printer binaryExprVisitor.checkAndPrepare / visitRightAndFinish
// 端到端 Parse→Print 逐字节等于 Go（14 场景）。Go 期望来自 tools/go/tmpgen_visitfamily_test.go。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Log, Path, Source } from "../logger/logger.ts";
import { Parse, Options } from "./js_parser.ts";
import { Format, Options as PO, Print } from "../js_printer/js_printer.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/visit-family-go.json", import.meta.url)));
const SHA = "a631d6f27ea4e1d2093d31b661bdea20b84d52358b14663c6602e6a52f95c70d";
type Row = { name: string; out: string };
const rows = JSON.parse(new TextDecoder().decode(raw)) as Row[];

// 与 Go 探针同口径的用例表（顺序必须与夹具一致）
const cases: [string, string, boolean][] = [
  ["require-stub", "require(\"fs\");\n", false],
  ["let-stmt", "let x = 1;\nuse(x);\n", false],
  ["using-stmt", "using x = foo();\nuse(x);\n", false],
  ["const-ident", "const x = 1;\n", false],
  ["assign-import-err", "import { x } from \"m\";\nx = 1;\n", false],
  ["module-require", "module.require(\"x\");\n", false],
  ["const-order", "var x = 1 === y;\n", true],
  ["undef-null", "var x = y == void 0;\n", true],
  ["paren-add-mul", "var x = (a + b) * c;\n", true],
  ["pow-assoc", "var x = a ** b ** c;\n", true],
  ["comma", "var x = (a, b);\n", true],
  ["obj-prop", "var x = ({a: 1, b: 2}).a;\n", true],
  ["obj-prop-miss", "var x = ({a: 1}).z;\n", true],
  ["obj-method", "var x = ({a() {}}).a;\n", true],
];

function pp(src: string, minify: boolean): string {
  const s = new Source();
  s.Index = 0;
  s.Contents = new TextEncoder().encode(src);
  s.KeyPath = new Path();
  s.KeyPath.Text = "<stdin>";
  const o = new Options();
  o.minifySyntax = minify;
  const r = Parse(new Log(), s, o);
  if (!r.ok) return "PARSE_FAIL";
  const syms = r.ast.Symbols;
  const ren: any = {
    NameForSymbol(ref: { InnerIndex: number }) {
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
  po.MinifySyntax = minify;
  return new TextDecoder().decode(Print(r.ast, syms, ren, po).JS);
}

test("visit-family 夹具 sha256（14 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("parser/printer binaryExprVisitor 族逐字节等于 Go（Parse→Print）", () => {
  assert.equal(rows.length, cases.length);
  for (let i = 0; i < rows.length; i++) {
    assert.equal(cases[i][0], rows[i].name, `case ${i} name`);
    const out = pp(cases[i][1], cases[i][2]);
    const b64 = Buffer.from(out, "utf8").toString("base64");
    assert.equal(b64, rows[i].out, `scenario ${i}: ${rows[i].name}\n  got=${JSON.stringify(out)}`);
  }
});
