// 第 112 批：removeImpliedPositions（Go 探针 6 例，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Token } from "../css_ast/css_ast.ts";
import { removeImpliedPositions, ColorStop } from "./css_decls_gradient.ts";

const FIXTURE = new URL("../../../testdata/css-rmip-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "dc5ca5beca3ee4e5256ec5e23784138ab7122acfc960b103e67bb016418f37a3";
interface Row { kind: number; stops: any[]; out: any }
function toStop(x: any): ColorStop { const s = new ColorStop(); s.positions = (x.pos??[]).map((p: any) => { const t = new Token(); t.Kind = p.k; t.Text = p.t; t.UnitOffset = p.u ?? 0; return t; }); const ct = new Token(); ct.Kind = x.color.k; ct.Text = x.color.t; s.color = ct; s.midpoint = new Token(); s.midpoint.Kind = x.mid ? x.mid.k : 0; return s; }
function dumpStops(ss: ColorStop[]): any { return ss.map((s) => [s.positions.map((t) => [t.Kind, t.Text]), [s.color.Kind, s.color.Text], s.midpoint.Kind]); }

test("css-rmip fixture sha256 + 6 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-rmip fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const got = dumpStops(removeImpliedPositions(r.kind, r.stops.map(toStop)));
    assert.equal(JSON.stringify(got), JSON.stringify(r.out), `${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 6);
});
