// 1:1 移植自 esbuild internal/compat/js_table.go（v0.28.2，commit f6058f83）
// 第 69 轮叶子优先规划：Engine / JSFeature 助手。真值表由 Go 探针固化在 testdata/compat-cluster-go.json。
import { jsTable, StringToJSFeature } from "./tables_generated.ts";
import { Semver, V, isVersionSupported } from "./compat.ts";

const toVRange = (r: { S: number[]; E: number[] }): { start: V; end: V } => {
  const sv = new V(); sv.major = r.S[0]; sv.minor = r.S[1]; sv.patch = r.S[2];
  const ev = new V(); ev.major = r.E[0]; ev.minor = r.E[1]; ev.patch = r.E[2];
  return { start: sv, end: ev };
};

/** Go: func UnsupportedJSFeatures(constraints map[Engine]Semver) JSFeature (js_table.go:925) */
export function UnsupportedJSFeatures(constraints: Map<number, Semver>): bigint {
  let unsupported = 0n;
  const inlineScript = BigInt(StringToJSFeature["inline-script"] ?? 0);
  for (const [featStr, engines] of Object.entries(jsTable)) {
    const feature = BigInt(featStr);
    if (feature === inlineScript) continue;
    for (const [engStr, version] of constraints) {
      const ranges = (engines as Record<number, { S: number[]; E: number[] }[]>)[engStr];
      if (ranges === undefined || !isVersionSupported(ranges.map(toVRange), version)) unsupported |= feature;
    }
  }
  return unsupported;
}

/** Go: type Engine uint8 (js_table.go) */
export type Engine = number;

/** Go: func (e Engine) IsBrowser() bool (js_table.go:52) */
export function IsBrowser(e: Engine): boolean {
  // Chrome, Edge, Firefox, IE, IOS, Opera, Safari
  return e === 0 || e === 2 || e === 4 || e === 6 || e === 7 || e === 9 || e === 11;
}

/** Go: func (e Engine) String() string (js_table.go:22) */
export function String(e: Engine): string {
  const names = ["chrome", "deno", "edge", "es", "firefox", "hermes", "ie", "ios", "node", "opera", "rhino", "safari"];
  return names[e] ?? "";
}

/** Go: type JSFeature uint64 (js_table.go:60) */
export type JSFeature = bigint;

/** Go: func (features JSFeature) Has(feature JSFeature) bool (js_table.go:190) */
export function Has(features: JSFeature, feature: JSFeature): boolean {
  return (features & feature) !== 0n;
}

/** Go: func (features JSFeature) ApplyOverrides(overrides, mask JSFeature) JSFeature (js_table.go:194) */
export function ApplyOverrides(features: JSFeature, overrides: JSFeature, mask: JSFeature): JSFeature {
  return (features & ~mask) | (overrides & mask);
}
