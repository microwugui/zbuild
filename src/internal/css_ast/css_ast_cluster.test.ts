// 第 60 轮叶子优先规划：css_ast 纯簇（一次 Go 探针、5 函数、逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NthIndex, MQCmpString, PseudoClassKindString, SSPseudoClass, UsesPseudoElement } from "./css_ast.ts";
import { MaybeCorrectDeclarationTypo } from "./css_decl_table.ts";

const FIXTURE = new URL("../../../testdata/css-ast-cluster-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "d5db172350f6c2af84298a4189ea68a543f8af7b370f400204a62142766db8c0";

interface Row { fn: string; arg: string; out: string; }

test("css-ast-cluster fixture sha256 + 42 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-ast-cluster fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "NthIndex.Minify": {
        const p = r.arg.indexOf("|");
        const idx = new NthIndex();
        idx.A = r.arg.slice(0, p); idx.B = r.arg.slice(p + 1);
        idx.Minify();
        got = idx.A + "|" + idx.B;
        break;
      }
      case "MQCmp.String":
        got = MQCmpString(Number(r.arg));
        break;
      case "PseudoClassKind.String":
        got = PseudoClassKindString(Number(r.arg));
        break;
      case "UsesPseudoElement": {
        const ins: { name: string; isElement: boolean }[] = JSON.parse(r.arg);
        const sels = ins.map((x) => {
          const ss = new SSPseudoClass(); ss.Name = x.name; ss.IsElement = x.isElement;
          return { SubclassSelectors: [ss] } as never;
        });
        got = String(UsesPseudoElement(sels));
        break;
      }
      case "MaybeCorrectDeclarationTypo": {
        const v = MaybeCorrectDeclarationTypo(r.arg);
        got = `${v.value}|${v.ok}`;
        break;
      }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 42);
});
