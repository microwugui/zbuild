// 第 51 轮叶子优先规划：css_parser 媒体/四方向 token 助手（Go 探针固化，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { MQCmp, Token } from "../css_ast/css_ast.ts";
import { isSingleIdent, scanMediaComparison, scanMediaValue } from "./css_parser_media.ts";
import { expandTokenQuad } from "./css_decls.ts";

const FIXTURE = new URL("../../../testdata/css-media-token-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "df68a56aaa03aaf821c2b8f0a43fe7758ee72101f4fdcb4b2dd76a01b4f9485f";

interface Row { fn: string; arg: string; out: string; }
interface TokIn { kind: number; text?: string; ws?: number; loc?: number; }
function build(s: string): Token[] {
  const ins: TokIn[] = JSON.parse(s);
  return ins.map((x) => {
    const t = new Token();
    t.Kind = x.kind;
    t.Text = x.text ?? "";
    t.Whitespace = x.ws ?? 0;
    t.Loc = x.loc ?? 0;
    return t;
  });
}
function dumpToks(ts: Token[]): string {
  return ts.map((t) => `${t.Kind}:${t.Text}:${t.Whitespace}:${t.Loc}`).join(";");
}

test("css-media-token fixture sha256 + 25 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-media-token fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "isSingleIdent": {
        const v = isSingleIdent(build(r.arg));
        got = `${v.value}|${v.loc}|${v.ok}`;
        break;
      }
      case "scanMediaComparison": {
        const v = scanMediaComparison(build(r.arg));
        got = `${v.cmp}|${dumpToks(v.rest)}`;
        break;
      }
      case "scanMediaValue": {
        const v = scanMediaValue(build(r.arg));
        got = `${dumpToks(v.value)}|${dumpToks(v.rest)}`;
        break;
      }
      case "expandTokenQuad": {
        const sep = r.arg.indexOf("|");
        const allowed = r.arg.slice(0, sep);
        const v = expandTokenQuad(build(r.arg.slice(sep + 1)), allowed);
        got = `${dumpToks(v.result)}|${v.ok}`;
        break;
      }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 25);
  void MQCmp;
});
