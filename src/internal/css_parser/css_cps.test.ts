// 第 114 批：tryToParseColorStops（Go 探针 20 例）。位置/单位/失败分支逐字节；
// xyz/rgb/alpha 走 1-ULP known-deviation 口径 toFixed(10)（Go math vs V8）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Token } from "../css_ast/css_ast.ts";
import { ColorStop, ParsedColorStop, tryToParseColorStops } from "./css_decls_gradient.ts";

const FIXTURE = new URL("../../../testdata/css-cps-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "a275fe3d566f496f33ce298de324212b6841495473f51afa5f80b9c7bf80366d";
interface Row { kind: number; stops: any[]; out: any }

function toTok(x: any): Token {
  const t = new Token();
  t.Kind = x.k; t.Text = x.t; t.UnitOffset = x.u ?? 0;
  if (x.c) t.Children = x.c.map(toTok);
  return t;
}
function toStop(x: any): ColorStop {
  const s = new ColorStop();
  s.color = toTok(x.color);
  s.positions = (x.pos ?? []).map(toTok);
  s.midpoint = x.mid ? toTok(x.mid) : new Token();
  return s;
}
const f = (v: any): string => v.Value().toFixed(10);
function dump(stops: ParsedColorStop[]): any {
  return stops.map((s) => ({
    pt: s.positionTerms.map((p) => [f(p.value), p.unit]),
    mid: s.midpoint === null ? null : [f(s.midpoint.value), s.midpoint.unit],
    xyza: [f(s.x), f(s.y), f(s.z), f(s.alpha)],
    rgba: [f(s.r), f(s.g), f(s.b), f(s.alpha)],
    has: s.hasColorSpace,
  }));
}

test("css-cps fixture sha256 + 20 例等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-cps fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const { result, ok } = tryToParseColorStops({ kind: r.kind, colorStops: r.stops.map(toStop) });
    if (r.out === "FAIL") { assert.equal(ok, false, `expect FAIL ${JSON.stringify(r.stops)}`); continue; }
    assert.equal(ok, true, `expect ok ${JSON.stringify(r.stops)}`);
    const got = dump(result);
    assert.equal(JSON.stringify(got), JSON.stringify(r.out), `${JSON.stringify(r.stops)} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 20);
});
