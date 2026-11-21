// 1:1 移植自 esbuild internal/compat/css_table.go（v0.28.2，commit f6058f83）
// 第 69 轮叶子优先规划：CSSFeature 位助手。真值表由 Go 探针固化在 testdata/compat-cluster-go.json。
import { cssTable, StringToCSSFeature } from "./tables_generated.ts";
import { Semver, V, isVersionSupported, compareVersions } from "./compat.ts";
import { IsBrowser } from "./js_table.ts";

const toVRangeCss = (r: { S: number[]; E: number[] }): { start: V; end: V } => {
  const sv = new V(); sv.major = r.S[0]; sv.minor = r.S[1]; sv.patch = r.S[2];
  const ev = new V(); ev.major = r.E[0]; ev.minor = r.E[1]; ev.patch = r.E[2];
  return { start: sv, end: ev };
};

/** Go: func UnsupportedCSSFeatures(constraints map[Engine]Semver) CSSFeature (css_table.go:153) */
export function UnsupportedCSSFeatures(constraints: Map<number, Semver>): number {
  let unsupported = 0;
  const inlineStyle = StringToCSSFeature["inline-style"] ?? 0;
  for (const [featStr, engines] of Object.entries(cssTable)) {
    const feature = Number(featStr);
    if (feature === inlineStyle) continue;
    for (const [engStr, version] of constraints) {
      const eng = Number(engStr);
      if (!IsBrowser(eng)) continue;
      const ranges = (engines as Record<number, { S: number[]; E: number[] }[]>)[engStr];
      if (ranges === undefined || !isVersionSupported(ranges.map(toVRangeCss), version)) unsupported |= feature;
    }
  }
  return unsupported;
}

/** Go: type CSSFeature uint16 (css_table.go) */
export type CSSFeature = number;

/** Go: CSSFeature InlineStyle (css_table.go:9, 1<<6 = 64) —— Go 探针实测 */
export const CSSInlineStyle: CSSFeature = 64;

/** Go: func (features CSSFeature) Has(feature CSSFeature) bool (css_table.go:43) */
export function Has(features: CSSFeature, feature: CSSFeature): boolean {
  return (features & feature) !== 0;
}

/** Go: func (features CSSFeature) ApplyOverrides(overrides, mask CSSFeature) CSSFeature (css_table.go:47) */
export function ApplyOverrides(features: CSSFeature, overrides: CSSFeature, mask: CSSFeature): CSSFeature {
  return (features & ~mask) | (overrides & mask);
}

/** Go: cssPrefixTable (css_table.go:195) —— Go 探针逐项固化，第 87 轮 */
const CSS_PREFIX_TABLE: Record<number, [number,number,number,number,number][]> = {
  15: [[0,84,0,0,16],[2,84,0,0,16],[4,80,0,0,2],[7,15,4,0,16],[9,73,0,0,16],[11,15,4,0,16]],
  16: [[7,18,0,0,16],[11,18,0,0,16]],
  20: [[0,120,0,0,16],[2,15,0,0,4],[2,120,0,0,16],[9,106,0,0,16],[11,5,0,0,16]],
  81: [[0,130,0,0,16],[2,130,0,0,16],[7,0,0,0,16],[9,116,0,0,16],[11,0,0,0,16]],
  91: [[0,55,0,0,16],[7,13,0,0,16],[9,42,0,0,16],[11,13,1,0,16]],
  137: [[0,33,0,0,16],[7,12,0,0,16],[9,20,0,0,16],[11,9,1,0,16]],
  170: [[0,138,0,0,16],[2,138,0,0,16],[4,0,0,0,16],[7,0,0,0,16],[9,122,0,0,16],[11,0,0,0,16]],
  171: [[2,79,0,0,4],[4,43,0,0,2],[6,0,0,0,4],[7,17,0,0,16],[11,17,0,0,16]],
  174: [[7,0,0,0,16],[11,0,0,0,16]],
  202: [[0,120,0,0,16],[2,120,0,0,16],[7,15,4,0,16],[9,106,0,0,16],[11,15,4,0,16]],
  203: [[0,120,0,0,16],[2,120,0,0,16],[7,15,4,0,16],[9,106,0,0,16],[11,15,4,0,16]],
  204: [[0,120,0,0,16],[2,120,0,0,16],[7,15,4,0,16],[9,0,0,0,16],[11,15,4,0,16]],
  205: [[0,120,0,0,16],[2,120,0,0,16],[7,15,4,0,16],[9,106,0,0,16],[11,15,4,0,16]],
  206: [[0,120,0,0,16],[2,120,0,0,16],[7,15,4,0,16],[9,106,0,0,16],[11,15,4,0,16]],
  207: [[0,120,0,0,16],[2,120,0,0,16],[7,15,4,0,16],[9,106,0,0,16],[11,15,4,0,16]],
  208: [[0,120,0,0,16],[2,120,0,0,16],[7,15,4,0,16],[9,106,0,0,16],[11,15,4,0,16]],
  211: [[0,138,0,0,16],[2,138,0,0,16],[7,0,0,0,16],[9,122,0,0,16],[11,0,0,0,16]],
  213: [[0,138,0,0,16],[2,138,0,0,16],[7,0,0,0,16],[9,122,0,0,16],[11,0,0,0,16]],
  215: [[0,138,0,0,16],[2,138,0,0,16],[7,0,0,0,16],[9,122,0,0,16],[11,0,0,0,16]],
  217: [[0,138,0,0,16],[2,138,0,0,16],[7,0,0,0,16],[9,122,0,0,16],[11,0,0,0,16]],
  257: [[7,13,0,0,16],[11,13,0,0,16]],
  258: [[0,0,0,0,16],[2,0,0,0,16],[9,0,0,0,16],[11,15,4,0,16]],
  279: [[4,91,0,0,2],[9,15,0,0,8]],
  286: [[4,36,0,0,2],[7,12,2,0,16],[11,12,1,0,16]],
  287: [[4,36,0,0,2],[7,12,2,0,16],[11,12,1,0,16]],
  288: [[7,12,2,0,16],[11,12,1,0,16]],
  291: [[0,99,0,0,16],[2,99,0,0,16],[9,85,0,0,16]],
  292: [[0,99,0,0,16],[2,99,0,0,16],[9,85,0,0,16]],
  293: [[0,99,0,0,16],[2,99,0,0,16],[9,85,0,0,16]],
  296: [[11,14,0,0,16]],
  300: [[2,79,0,0,4],[7,0,0,0,16]],
  316: [[0,54,0,0,16],[2,79,0,0,4],[4,69,0,0,2],[6,0,0,0,4],[7,0,0,0,16],[9,41,0,0,16],[11,3,0,0,1],[11,0,0,0,16]],
  321: [[0,138,0,0,16],[2,138,0,0,16],[4,0,0,0,16],[7,0,0,0,16],[9,122,0,0,16],[11,0,0,0,16]],
};

/** Go: func CSSPrefixData(constraints map[Engine]Semver) map[css_ast.D]CSSPrefix (css_table.go:400) */
export function CSSPrefixData(constraints: Map<number, Semver>): Map<number, number> {
  const entries = new Map<number, number>();
  for (const [propStr, items] of Object.entries(CSS_PREFIX_TABLE)) {
    const property = Number(propStr);
    let prefixes = 0;
    for (const [eng, maj, min, pat, pfx] of items) {
      if (!IsBrowser(eng)) continue;
      for (const [cEng, version] of constraints) {
        if (cEng !== eng) continue;
        const zero = maj === 0 && min === 0 && pat === 0;
        const v = new V(); v.major = maj; v.minor = min; v.patch = pat;
        if (zero || compareVersions(v, version) > 0) prefixes |= pfx;
      }
    }
    if (prefixes !== 0) entries.set(property, prefixes);
  }
  return entries;
}
