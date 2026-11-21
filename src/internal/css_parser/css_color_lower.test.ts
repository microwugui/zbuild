// 第 133 批：tryToGenerateColor / lowerAndMinifyColor（Go 探针 44 例，逐字节）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Token } from "../css_ast/css_ast.ts";
import { NewF64 } from "../helpers/float.ts";
import { CSSParser } from "./css_parser.ts";
import { tryToGenerateColor, lowerAndMinifyColor } from "./css_decls_color.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/color-lower-go.json", import.meta.url)));
const SHA = "720ea68c098b808d10bb29a6fa5eb0767313212c8a79ab2076a4fd283f0f5b31";
const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);
const mk = (feature: number, minify: boolean): CSSParser => { const p = new CSSParser(); p.options.unsupportedCSSFeatures = feature; p.options.minifySyntax = minify; return p; };
function toTok(x: any): Token {
  const t = new Token(); t.Kind = x.k; t.Text = x.t; t.UnitOffset = x.u ?? 0;
  if (x.c) t.Children = x.c.map(toTok);
  return t;
}
const dump = (t: Token): any => ({ k: t.Kind, t: t.Text, u: t.UnitOffset, c: (t.Children ?? []).map(dump) });

test("color-lower fixture sha256 + 44 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  const colors: Record<string, any> = {
    opaque: { x:NewF64(0), y:NewF64(0), z:NewF64(0), hex:0xff0000ff, hasColorSpace:false },
    alpha: { x:NewF64(0), y:NewF64(0), z:NewF64(0), hex:0x11223380, hasColorSpace:false },
    colorspace: { x:NewF64(0.1), y:NewF64(0.2), z:NewF64(0.3), hex:0xff, hasColorSpace:true },
    outofgamut: { x:NewF64(3), y:NewF64(0.2), z:NewF64(0.3), hex:0xff, hasColorSpace:true },
  };
  const toks: Record<string, any> = {
    hash4:{k:28,t:"1234"}, hash8:{k:28,t:"11223344"}, hash3:{k:28,t:"f00"},
    rebeccapurple:{k:29,t:"rebeccapurple"},
    "rgb-space":{k:27,t:"rgb",c:[{k:30,t:"1"},{k:30,t:"2"},{k:30,t:"3"}]},
    "rgba-slash":{k:27,t:"rgba",c:[{k:30,t:"1"},{k:30,t:"2"},{k:30,t:"3"},{k:24,t:"/"},{k:34,t:"50%"}]},
    "hsl-deg":{k:27,t:"hsl",c:[{k:26,t:"1deg",u:1},{k:34,t:"2%"},{k:34,t:"3%"}]},
  };
  for (const r of rows) {
    const a = r.arg, p = mk(a.feature, a.minify), clip = { value: false };
    let got: any;
    if (r.fn === "tryToGenerateColor") {
      const t = toTok({k:27,t:"rgb"});
      got = { tok: dump(tryToGenerateColor(p, t, colors[a.name], clip)), clip: clip.value };
    } else {
      got = { tok: dump(lowerAndMinifyColor(p, toTok(toks[a.name]), clip)), clip: clip.value };
    }
    assert.equal(JSON.stringify(canon(got)), JSON.stringify(canon(r.out)), `${r.fn} ${JSON.stringify(a)} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 44);
});
