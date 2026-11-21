// 第 44 轮叶子优先规划：css_ast Token / PseudoClassKind 真值表（Go 探针固化）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Token, HasNthIndex, Dir, Flip, Reverse, CompoundSelector, IsSingleAmpersand, IsInvalidBecauseEmpty } from "./css_ast.ts";

const FIXTURE = new URL("../../../testdata/css-ast-leaf-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "5bfe6d245a7aa116c0f6502da6e9a03dd1f75a82a892cbf2676df4acbc648c24";

interface Row { fn: string; text: string; unit: number; kind: number; out: string; }

test("css_ast 叶子真值表：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-ast-leaf fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  const consts: Record<string, number> = {};
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "TNumber": case "PseudoClassNthChild": case "PseudoClassNthOfType":
        consts[r.fn] = Number(r.out); got = r.out; break;
      case "PercentageValue": { const t = new Token(); t.Text = r.text; t.UnitOffset = r.unit; got = t.PercentageValue(); break; }
      case "DimensionValue": { const t = new Token(); t.Text = r.text; t.UnitOffset = r.unit; got = t.DimensionValue(); break; }
      case "DimensionUnit": { const t = new Token(); t.Text = r.text; t.UnitOffset = r.unit; got = t.DimensionUnit(); break; }
      case "IsZero": case "IsOne": {
        const t = new Token(); t.Text = r.text; t.Kind = r.kind;
        got = String(r.fn === "IsZero" ? t.IsZero() : t.IsOne()); break;
      }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} ${r.text}`);
  }
  // HasNthIndex（真值表未含）直接覆盖底座谓词
  assert.equal(HasNthIndex(5), true);
  assert.equal(HasNthIndex(8), true);
  assert.equal(HasNthIndex(6), true);
  assert.equal(HasNthIndex(9), false);
  assert.equal(HasNthIndex(0), false);
});

const F2 = new URL("../../../testdata/css-ast-leaf2-go.json", import.meta.url);
const b2 = new Uint8Array(readFileSync(F2));
const S2 = "d6401b8ae14b39e1f2d3e81048c8e55b89b8a240e9ab7dd4f8e4b113106325b5";
interface Row2 { fn: string; arg: string; unit: number; out: string; }

test("css_ast 叶子真值表 2：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(b2).digest("hex"), S2, "css-ast-leaf2 fixture sha256");
  const rows: Row2[] = JSON.parse(new TextDecoder().decode(b2));
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "MQCmpConst": got = r.out; break; // 常量记录，逐值断言在下方
      case "IsAngle": { const t = new Token(); t.Text = r.arg; t.Kind = 26; t.UnitOffset = r.unit; got = String(t.IsAngle()); break; }
      case "DimensionUnitIsSafeLength": { const t = new Token(); t.Text = r.arg; t.Kind = 26; t.UnitOffset = r.unit; got = String(t.DimensionUnitIsSafeLength()); break; }
      case "TurnIntoZero": { const t = new Token(); t.Text = r.arg; t.Kind = 26; t.UnitOffset = r.unit; const c = t.TurnLengthIntoNumberIfZero(); got = `${c}|${t.Kind}|${t.Text}`; break; }
      case "Dir": got = String(Dir(Number(r.arg))); break;
      case "Flip": got = String(Flip(Number(r.arg))); break;
      case "Reverse": got = String(Reverse(Number(r.arg))); break;
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} ${r.arg}`);
  }
});

const F3 = new URL("../../../testdata/css-selector-go.json", import.meta.url);
const b3 = new Uint8Array(readFileSync(F3));
const S3 = "db64a519ecf69e0a0482e1841bca53c2e5c39d0da04b9b10a693b31176c552be";
interface Row3 { fn: string; case: string; out: string; }

test("css_ast 选择器谓词：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(b3).digest("hex"), S3, "css-selector fixture sha256");
  const rows: Row3[] = JSON.parse(new TextDecoder().decode(b3));
  for (const r of rows) {
    const sel = new CompoundSelector();
    if (r.case === "amp") sel.NestingSelectorLocs = [0];
    if (r.case === "amp-combinator") { sel.NestingSelectorLocs = [0]; sel.Combinator = 32; }
    if (r.case === "two-amp") sel.NestingSelectorLocs = [0, 1];
    if (r.case === "type") sel.TypeSelector = {};
    if (r.case === "subclass") sel.SubclassSelectors = [{}];
    const got = String(r.fn === "IsSingleAmpersand" ? IsSingleAmpersand(sel) : IsInvalidBecauseEmpty(sel));
    assert.equal(got, r.out, `${r.fn} ${r.case}`);
  }
});

const F4 = new URL("../../../testdata/css-percentage-go.json", import.meta.url);
const b4 = new Uint8Array(readFileSync(F4));
const S4 = "9ea9197d75f5e32e2f4d5719d65e60d00e7e6383c4dae397cca422516719251c";
interface Row4 { fn: string; text: string; kind: number; ref: number; flags: number; out: string; ok: boolean; }

test("css_ast 百分比助手：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(b4).digest("hex"), S4, "css-percentage fixture sha256");
  const rows: Row4[] = JSON.parse(new TextDecoder().decode(b4));
  for (const r of rows) {
    const t = new Token(); t.Text = r.text; t.Kind = r.kind;
    if (r.kind === 34) t.UnitOffset = r.text.length - 1; // TPercentage
    const v = r.fn === "NumberOrFractionForPercentage"
      ? t.NumberOrFractionForPercentage(r.ref, r.flags)
      : t.ClampedFractionForPercentage();
    assert.equal(v.value.toFixed(6), r.out, `${r.fn} ${r.text} val`);
    assert.equal(v.ok, r.ok, `${r.fn} ${r.text} ok`);
  }
});
