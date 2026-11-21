// 1:1 移植自 esbuild internal/css_parser/css_decls_gradient.go（v0.28.2，commit f6058f83）
// 第 49 轮叶子优先规划：CSS 渐变插值纯助手。真值表由 Go 探针固化在 testdata/css-color3-go.json。
import { F64, NewF64, Lerp, Max2 } from "../helpers/float.ts";
import { colorSpace, isPolar, lin_srgb, lin_srgb_to_xyz, xyz_to_lin_srgb, gam_srgb, xyz_to_colorSpace, colorSpace_to_xyz } from "./css_color_spaces.ts";
import { T, Token } from "../css_ast/css_ast.ts";
import { degreesForAngle, parseColor, hexR, hexG, hexB, hexA, lowerAndMinifyColor } from "./css_decls_color.ts";
import { commaToken } from "./css_decls.ts";
import { IsNumeric } from "../css_lexer/css_lexer.ts";
import { TokensEqual } from "../css_ast/css_ast.ts";
import { CSSParser } from "./css_parser.ts";
import { looksLikeColor } from "./css_decls_color.ts";

/** Go: hueMethod 枚举（css_color_spaces.go:44，Go 探针实测） */
export const hueMethod = {
  shorterHue: 0,
  longerHue: 1,
  increasingHue: 2,
  decreasingHue: 3,
} as const;

/** Go: func formatFloat(value F64, decimals int) string (css_decls_gradient.go:805) */
export function formatFloat(value: F64, decimals: number): string {
  const v = value.Value();
  if (Number.isNaN(v)) return "NaN";
  if (!Number.isFinite(v)) return v < 0 ? "-Inf" : "+Inf";
  // Go strconv.FormatFloat(v, 'f', decimals, 64) 是「精确二进制值 → 十进制，最近值、平局取偶」；
  // JS toFixed 是「平局取大」，恰好半值处（例 3.125 → 2 位）会差 1。这里用 BigInt 精确复刻。
  const negative = v < 0 || Object.is(v, -0);
  const abs = Math.abs(v);
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, abs);
  const hi = buf.getUint32(0), lo = buf.getUint32(4);
  const expBits = (hi >>> 20) & 0x7ff;
  let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let exp = expBits === 0 ? -1074 : expBits - 1023 - 52;
  if (expBits !== 0) mantissa |= 1n << 52n;
  let num = mantissa * (10n ** BigInt(decimals));
  let den = 1n;
  if (exp >= 0) num <<= BigInt(exp);
  else den <<= BigInt(-exp);
  let q = num / den;
  const rem2 = (num % den) * 2n;
  if (rem2 > den || (rem2 === den && (q & 1n) === 1n)) q += 1n;
  let text = q.toString();
  if (decimals > 0) {
    text = text.padStart(decimals + 1, "0");
    text = text.slice(0, text.length - decimals) + "." + text.slice(text.length - decimals);
    text = text.replace(/0+$/, "").replace(/\.$/, "");
  }
  return (negative ? "-" : "") + text;
}

/** Go: func interpolateHues(a, b, t F64, hueMethod hueMethod) F64 (css_decls_gradient.go:908) */
export function interpolateHues(a: F64, b: F64, t: F64, method: number): F64 {
  a = a.DivConst(360);
  b = b.DivConst(360);
  a = a.Sub(a.Floor());
  b = b.Sub(b.Floor());
  switch (method) {
    case hueMethod.shorterHue: {
      const delta = b.Sub(a);
      if (delta.Value() > 0.5) a = a.AddConst(1);
      if (delta.Value() < -0.5) b = b.AddConst(1);
      break;
    }
    case hueMethod.longerHue: {
      const delta = b.Sub(a);
      if (delta.Value() > 0 && delta.Value() < 0.5) a = a.AddConst(1);
      if (delta.Value() > -0.5 && delta.Value() <= 0) b = b.AddConst(1);
      break;
    }
    case hueMethod.increasingHue:
      if (b.Value() < a.Value()) b = b.AddConst(1);
      break;
    case hueMethod.decreasingHue:
      if (a.Value() < b.Value()) a = a.AddConst(1);
      break;
  }
  return Lerp(a, b, t).MulConst(360);
}

/** Go: func premultiply(v0, v1, v2, alpha F64, colorSpace colorSpace) (F64, F64, F64) (css_decls_gradient.go:1008) */
export function premultiply(v0: F64, v1: F64, v2: F64, alpha: F64, cs: number): [F64, F64, F64] {
  if (alpha.Value() < 1) {
    switch (cs) {
      case colorSpace.colorSpace_hsl:
      case colorSpace.colorSpace_hwb:
        v2 = v2.Mul(alpha);
        break;
      case colorSpace.colorSpace_lch:
      case colorSpace.colorSpace_oklch:
        v0 = v0.Mul(alpha);
        break;
      default:
        v0 = v0.Mul(alpha);
        v2 = v2.Mul(alpha);
        break;
    }
    v1 = v1.Mul(alpha);
  }
  return [v0, v1, v2];
}

/** Go: func unpremultiply(v0, v1, v2, alpha F64, colorSpace colorSpace) (F64, F64, F64) (css_decls_gradient.go:1024) */
export function unpremultiply(v0: F64, v1: F64, v2: F64, alpha: F64, cs: number): [F64, F64, F64] {
  if (alpha.Value() > 0 && alpha.Value() < 1) {
    switch (cs) {
      case colorSpace.colorSpace_hsl:
      case colorSpace.colorSpace_hwb:
        v2 = v2.Div(alpha);
        break;
      case colorSpace.colorSpace_lch:
      case colorSpace.colorSpace_oklch:
        v0 = v0.Div(alpha);
        break;
      default:
        v0 = v0.Div(alpha);
        v2 = v2.Div(alpha);
        break;
    }
    v1 = v1.Div(alpha);
  }
  return [v0, v1, v2];
}

/** Go: gradientKind 枚举（css_decls_gradient.go:16，Go 探针实测） */
export const gradientKind = { linearGradient: 0, radialGradient: 1, conicGradient: 2 } as const;

/** Go: type valueWithUnit struct (css_decls_gradient.go:442) */
export interface valueWithUnit { unit: string; value: F64; }

/** Go: func makeDimensionOrPercentToken(loc logger.Loc, value F64, unit string) css_ast.Token (css_decls_gradient.go:809) */
export function makeDimensionOrPercentToken(loc: number, value: F64, unit: string): Token {
  const token = new Token();
  token.Loc = loc;
  token.Text = formatFloat(value, 2);
  if (unit === "%") token.Kind = T.TPercentage;
  else { token.Kind = T.TDimension; token.UnitOffset = token.Text.length; }
  token.Text += unit;
  return token;
}

/** Go: func interpolateColors(a0, a1, a2, b0, b1, b2 F64, colorSpace colorSpace, hueMethod hueMethod, t F64) (F64, F64, F64) (css_decls_gradient.go:947) */
export function interpolateColors(a0: F64, a1: F64, a2: F64, b0: F64, b1: F64, b2: F64, cs: number, method: number, t: F64): [F64, F64, F64] {
  const v1 = Lerp(a1, b1, t);
  let v0: F64, v2: F64;
  switch (cs) {
    case colorSpace.colorSpace_hsl:
    case colorSpace.colorSpace_hwb:
      v2 = Lerp(a2, b2, t); v0 = interpolateHues(a0, b0, t, method);
      break;
    case colorSpace.colorSpace_lch:
    case colorSpace.colorSpace_oklch:
      v0 = Lerp(a0, b0, t); v2 = interpolateHues(a2, b2, t, method);
      break;
    default:
      v0 = Lerp(a0, b0, t); v2 = Lerp(a2, b2, t);
      break;
  }
  return [v0, v1, v2];
}

/** Go: func interpolatePositions(a, b []valueWithUnit, t F64) []valueWithUnit (css_decls_gradient.go:970) */
export function interpolatePositions(a: valueWithUnit[], b: valueWithUnit[], t: F64): valueWithUnit[] {
  const result: valueWithUnit[] = [];
  const findUnit = (unit: string): number => {
    for (let i = 0; i < result.length; i++) if (result[i].unit === unit) return i;
    result.push({ unit, value: new F64(0) });
    return result.length - 1;
  };
  for (const term of a) {
    const ptr = result[findUnit(term.unit)];
    ptr.value = t.Neg().AddConst(1).Mul(term.value).Add(ptr.value);
  }
  for (const term of b) {
    const ptr = result[findUnit(term.unit)];
    ptr.value = t.Mul(term.value).Add(ptr.value);
  }
  if (result.length > 1) {
    for (let i = 0; i < result.length; i++) {
      if (result[i].value.Value() === 0) { result.splice(i, 1); break; }
    }
  }
  return result;
}

/** Go: func tryToParseValue(token css_ast.Token, kind gradientKind) (valueWithUnit, bool) (css_decls_gradient.go:636) */
export function tryToParseValue(token: Token, kind: number): { result: valueWithUnit; ok: boolean } {
  const result: valueWithUnit = { unit: "", value: new F64(0) };
  if (kind === gradientKind.conicGradient) {
    switch (token.Kind) {
      case T.TDimension: {
        const d = degreesForAngle(token);
        if (!d.ok) return { result, ok: false };
        result.value = new F64(d.value).MulConst(100.0 / 360);
        result.unit = "%";
        break;
      }
      case T.TPercentage: {
        const p = parseFloat(token.PercentageValue());
        if (Number.isNaN(p)) return { result, ok: false };
        result.value = new F64(p); result.unit = "%";
        break;
      }
      default: return { result, ok: false };
    }
  } else {
    switch (token.Kind) {
      case T.TNumber: {
        const zero = parseFloat(token.Text);
        if (Number.isNaN(zero) || zero !== 0) return { result, ok: false };
        result.value = new F64(0); result.unit = "%";
        break;
      }
      case T.TDimension: {
        const dv = parseFloat(token.DimensionValue());
        if (Number.isNaN(dv)) return { result, ok: false };
        result.value = new F64(dv); result.unit = token.DimensionUnit();
        break;
      }
      case T.TPercentage: {
        const pv = parseFloat(token.PercentageValue());
        if (Number.isNaN(pv)) return { result, ok: false };
        result.value = new F64(pv); result.unit = "%";
        break;
      }
      default: return { result, ok: false };
    }
  }
  return { result, ok: true };
}

/** Go: func removeColorInterpolation(tokens []css_ast.Token) ([]css_ast.Token, colorSpace, hueMethod, bool) (css_decls_gradient.go:362) */
export function removeColorInterpolation(tokens: Token[]): { remaining: Token[]; space: number; method: number; ok: boolean } {
  const spaceMap: Record<string, number> = {
    "a98-rgb": colorSpace.colorSpace_a98_rgb, "display-p3": colorSpace.colorSpace_display_p3,
    "hsl": colorSpace.colorSpace_hsl, "hwb": colorSpace.colorSpace_hwb, "lab": colorSpace.colorSpace_lab,
    "lch": colorSpace.colorSpace_lch, "oklab": colorSpace.colorSpace_oklab, "oklch": colorSpace.colorSpace_oklch,
    "prophoto-rgb": colorSpace.colorSpace_prophoto_rgb, "rec2020": colorSpace.colorSpace_rec2020,
    "srgb": colorSpace.colorSpace_srgb, "srgb-linear": colorSpace.colorSpace_srgb_linear,
    "xyz": colorSpace.colorSpace_xyz, "xyz-d50": colorSpace.colorSpace_xyz_d50, "xyz-d65": colorSpace.colorSpace_xyz_d65,
  };
  for (let i = 0; i + 1 < tokens.length; i++) {
    const tkn = tokens[i];
    if (tkn.Kind === T.TIdent && tkn.Text.toLowerCase() === "in") {
      const space = tokens[i + 1];
      if (space.Kind === T.TIdent) {
        let cs: number = 0;
        let method: number = hueMethod.shorterHue;
        const start = i;
        let end = i + 2;
        const key = space.Text.toLowerCase();
        if (!(key in spaceMap)) return { remaining: [], space: 0, method: 0, ok: false };
        cs = spaceMap[key];
        if (isPolar(cs) && i + 3 < tokens.length) {
          const hue = tokens[i + 3];
          if (hue.Kind === T.TIdent && hue.Text.toLowerCase() === "hue") {
            const m = tokens[i + 2];
            if (m.Kind === T.TIdent) {
              const mk = m.Text.toLowerCase();
              const methods: Record<string, number> = { shorter: 0, longer: 1, increasing: 2, decreasing: 3 };
              if (!(mk in methods)) return { remaining: [], space: 0, method: 0, ok: false };
              method = methods[mk];
              end = i + 4;
            }
          }
        }
        const remaining = tokens.slice(0, start).concat(tokens.slice(end)).map((t) => {
          const c = new Token();
          c.Kind = t.Kind; c.Text = t.Text; c.Whitespace = t.Whitespace; c.UnitOffset = t.UnitOffset; c.Loc = t.Loc;
          return c;
        });
        if (remaining.length > 0) {
          remaining[0].Whitespace &= ~1;
          remaining[remaining.length - 1].Whitespace &= ~2;
        }
        return { remaining, space: cs, method, ok: true };
      }
    }
  }
  return { remaining: [], space: 0, method: 0, ok: false };
}

// ============================================================================
// 第 111 批：gradient token 助手 4 函数（Go 探针 7 例，逐字节等于 Go）。
// 真值表固化于 testdata/css-grad-go.json（4a4b67b7…）。
// ============================================================================
import { Token as ASTToken, T as AT } from "../css_ast/css_ast.ts";
import { tryToConvertToHexWithoutClipping } from "./css_decls_color.ts";

/** Go: func makePositionToken(loc logger.Loc, positionTerms []valueWithUnit) css_ast.Token (css_decls_gradient.go:822) */
export function makePositionToken(loc: number, positionTerms: valueWithUnit[]): ASTToken {
  if (positionTerms.length === 1) return makeDimensionOrPercentToken(loc, positionTerms[0].value, positionTerms[0].unit);
  const children: ASTToken[] = [];
  for (let i = 0; i < positionTerms.length; i++) {
    if (i > 0) {
      const plus = new ASTToken(); plus.Loc = loc; plus.Kind = AT.TDelimPlus; plus.Text = "+"; plus.Whitespace = 1 | 2;
      children.push(plus);
    }
    children.push(makeDimensionOrPercentToken(loc, positionTerms[i].value, positionTerms[i].unit));
  }
  const t = new ASTToken(); t.Loc = loc; t.Kind = AT.TFunction; t.Text = "calc"; t.Children = children;
  return t;
}

/** Go: func makeColorToken(loc, x, y, z, a F64) css_ast.Token (css_decls_gradient.go:848) */
export function makeColorToken(loc: number, x: any, y: any, z: any, a: any): ASTToken {
  const color = new ASTToken(); color.Loc = loc;
  const alpha = Math.round(a.MulConst(255).Value()) >>> 0;
  const hex = tryToConvertToHexWithoutClipping(x, y, z, alpha);
  if (hex.ok) {
    color.Kind = 28 /* THash */;
    color.Text = alpha === 255 ? (hex.value >>> 8).toString(16).padStart(6, "0") : (hex.value >>> 0).toString(16).padStart(8, "0");
  } else {
    const mk = (kind: number, text: string, ws: number): ASTToken => {
      const t = new ASTToken(); t.Loc = loc; t.Kind = kind; t.Text = text; t.Whitespace = ws; return t;
    };
    const children: ASTToken[] = [
      mk(AT.TIdent, "xyz", 2), mk(AT.TNumber, formatFloat(x, 3), 1 | 2),
      mk(AT.TNumber, formatFloat(y, 3), 1 | 2), mk(AT.TNumber, formatFloat(z, 3), 1),
    ];
    if (a.Value() < 1) {
      children.push(mk(AT.TDelimSlash, "/", 1 | 2), mk(AT.TNumber, formatFloat(a, 3), 1));
    }
    color.Kind = AT.TFunction; color.Text = "color"; color.Children = children;
  }
  return color;
}

/** Go: func switchToSinglePositions(double []colorStop) []colorStop (css_decls_gradient.go:325) */
export function switchToSinglePositions(double: ColorStop[]): ColorStop[] {
  const single: ColorStop[] = [];
  for (const stop0 of double) {
    const stop = cloneStop(stop0);
    for (let i = 0; i < stop.positions.length; i++) stop.positions[i].Whitespace = 1;
    while (stop.positions.length > 1) {
      const clone = cloneStop(stop);
      clone.positions = stop.positions.slice(0, 1);
      clone.midpoint = new ASTToken();
      single.push(clone);
      stop.positions = stop.positions.slice(1);
    }
    single.push(stop);
  }
  return single;
}

/** Go: func switchToDoublePositions(single []colorStop) []colorStop (css_decls_gradient.go:342) */
export function switchToDoublePositions(single: ColorStop[]): ColorStop[] {
  const double: ColorStop[] = [];
  for (let i = 0; i < single.length; i++) {
    const stop = single[i];
    if (i + 1 < single.length && stop.positions.length === 1 && stop.midpoint.Kind === 0) {
      const next = single[i + 1];
      if (next.positions.length === 1 && TokensEqualIW([stop.color], [next.color])) {
        const d = new ColorStop();
        d.color = stop.color; d.positions = [stop.positions[0], next.positions[0]]; d.midpoint = next.midpoint;
        double.push(d); i++; continue;
      }
    }
    double.push(stop);
  }
  return double;
}

/** Go: type colorStop struct (css_decls_gradient.go:31) */
export class ColorStop {
  positions: ASTToken[] = [];
  color: ASTToken = new ASTToken();
  midpoint: ASTToken = new ASTToken();
}
function cloneStop(s: ColorStop): ColorStop {
  const c = new ColorStop(); c.positions = s.positions.slice(); c.color = s.color; c.midpoint = s.midpoint; return c;
}
function TokensEqualIW(a: ASTToken[], b: ASTToken[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].Kind !== b[i].Kind || a[i].Text !== b[i].Text || a[i].PayloadIndex !== b[i].PayloadIndex) return false;
  return true;
}

// ============================================================================
// 第 112 批：removeImpliedPositions（Go 探针 6 例，逐字节等于 Go）。
// 真值表固化于 testdata/css-rmip-go.json（dc5ca5be…）。
// ============================================================================
/** Go: func removeImpliedPositions(kind gradientKind, colorStops []colorStop) []colorStop (css_decls_gradient.go:259) */
export function removeImpliedPositions(kind: number, colorStops: ColorStop[]): ColorStop[] {
  if (colorStops.length === 0) return colorStops;
  const positions: valueWithUnit[] = new Array(colorStops.length);
  for (let i = 0; i < colorStops.length; i++) {
    const stop = colorStops[i];
    if (stop.positions.length === 1) {
      const parsed = tryToParseValue(stop.positions[0], kind);
      if (parsed.ok) { positions[i] = parsed.result; continue; }
    }
    positions[i] = { unit: "", value: NewF64(NaN) };
  }
  let start = 0;
  while (start < colorStops.length) {
    const startPos = positions[start];
    if (!Number.isNaN(startPos.value.Value())) {
      let end = start + 1;
      while (colorStops[end - 1].midpoint.Kind === 0 && end < colorStops.length) {
        const endPos = positions[end];
        if (Number.isNaN(endPos.value.Value()) || endPos.unit !== startPos.unit) break;
        let implied = true;
        for (let i = start + 1; i < end; i++) {
          const t = NewF64((i - start) / (end - start));
          const impliedValue = Lerp(startPos.value, endPos.value, t);
          if (Math.abs(positions[i].value.Value() - impliedValue.Value()) > 0.01) { implied = false; break; }
        }
        if (!implied) break;
        end++;
      }
      if (end - start > 1) {
        for (let i = start + 1; i + 1 < end; i++) colorStops[i].positions = [];
        start = end - 1;
        continue;
      }
    }
    start++;
  }
  const first = colorStops[0].positions;
  if (first.length === 1 && ((first[0].Kind === AT.TPercentage && pctVal(first[0].Text) === "0") ||
      (first[0].Kind === AT.TDimension && first[0].Text.slice(0, first[0].UnitOffset) === "0"))) {
    colorStops[0].positions = [];
  }
  const last = colorStops[colorStops.length - 1].positions;
  if (last.length === 1 && last[0].Kind === AT.TPercentage && pctVal(last[0].Text) === "100") {
    colorStops[colorStops.length - 1].positions = [];
  }
  return colorStops;
}
function pctVal(text: string): string { return text.length > 0 ? text.slice(0, text.length - 1) : ""; }

// ============================================================================
// 第 114 批：tryToParseColorStops（Go 探针 20 例，fixture css-cps-go.json）。
// xyz/rgb/alpha 走 1-ULP known-deviation 口径 toFixed(10)；位置/单位/失败分支逐字节。
// ============================================================================
/** Go: type parsedColorStop struct (css_decls_gradient.go:447) */
export class ParsedColorStop {
  positionTerms: valueWithUnit[] = [];
  midpoint: valueWithUnit | null = null;
  x = new F64(0); y = new F64(0); z = new F64(0); alpha = new F64(0);
  r = new F64(0); g = new F64(0); b = new F64(0);
  v0 = new F64(0); v1 = new F64(0); v2 = new F64(0);
  hasColorSpace = false;
}

/** Go 结构体值语义的快照克隆（双位置展开时 append 的是当时的值） */
function cloneParsedStop(s: ParsedColorStop): ParsedColorStop {
  const c = new ParsedColorStop();
  c.positionTerms = s.positionTerms.slice();
  c.midpoint = s.midpoint === null ? null : { unit: s.midpoint.unit, value: s.midpoint.value };
  c.x = s.x; c.y = s.y; c.z = s.z; c.alpha = s.alpha;
  c.r = s.r; c.g = s.g; c.b = s.b;
  c.v0 = s.v0; c.v1 = s.v1; c.v2 = s.v2;
  c.hasColorSpace = s.hasColorSpace;
  return c;
}

/** Go: func tryToParseColorStops(gradient parsedGradient) ([]parsedColorStop, bool) (css_decls_gradient.go:464) */
export function tryToParseColorStops(gradient: { colorStops: ColorStop[]; kind: number }): { result: ParsedColorStop[]; ok: boolean } {
  const colorStops: ParsedColorStop[] = [];

  for (const stop of gradient.colorStops) {
    const { color, ok: colorOk } = parseColor(stop.color);
    if (!colorOk) return { result: [], ok: false };
    let r: F64, g: F64, b: F64;
    if (!color.hasColorSpace) {
      r = NewF64(hexR(color.hex) / 255);
      g = NewF64(hexG(color.hex) / 255);
      b = NewF64(hexB(color.hex) / 255);
      const [x, y, z] = lin_srgb_to_xyz(...lin_srgb(r, g, b));
      color.x = x; color.y = y; color.z = z;
    } else {
      [r, g, b] = gam_srgb(...xyz_to_lin_srgb(color.x, color.y, color.z));
    }
    const parsedStop = new ParsedColorStop();
    parsedStop.x = color.x; parsedStop.y = color.y; parsedStop.z = color.z;
    parsedStop.r = r; parsedStop.g = g; parsedStop.b = b;
    parsedStop.alpha = NewF64(hexA(color.hex) / 255);
    parsedStop.hasColorSpace = color.hasColorSpace;

    for (let i = 0; i < stop.positions.length; i++) {
      const parsed = tryToParseValue(stop.positions[i], gradient.kind);
      if (!parsed.ok) return { result: [], ok: false };
      parsedStop.positionTerms = [parsed.result];
      // Go 的 parsedStop 是值类型：此处 append 的是快照，后续位置不会回写已入队的 stop。
      if (i + 1 < stop.positions.length) colorStops.push(cloneParsedStop(parsedStop));
    }

    if (stop.midpoint.Kind !== TEndOfFile) {
      const parsed = tryToParseValue(stop.midpoint, gradient.kind);
      if (!parsed.ok) return { result: [], ok: false };
      parsedStop.midpoint = parsed.result;
    }

    colorStops.push(parsedStop);
  }

  if (colorStops.length > 0) {
    const infos: { fromPos: valueWithUnit; toPos: valueWithUnit; fromCount: number; toCount: number }[] =
      new Array(colorStops.length);

    // Fill in missing positions for the endpoints first
    if (colorStops[0].positionTerms.length === 0) colorStops[0].positionTerms = [{ value: NewF64(0), unit: "%" }];
    const lastIdx = colorStops.length - 1;
    if (colorStops[lastIdx].positionTerms.length === 0) colorStops[lastIdx].positionTerms = [{ value: NewF64(100), unit: "%" }];

    // Set all positions to be greater than the position before them
    for (let i = 0; i < colorStops.length; i++) {
      const stop = colorStops[i];
      let prevPos: valueWithUnit = { unit: "", value: NewF64(0) };
      for (let j = i - 1; j >= 0; j--) {
        const prev = colorStops[j];
        if (prev.midpoint !== null) { prevPos = prev.midpoint; break; }
        if (prev.positionTerms.length === 1) { prevPos = prev.positionTerms[0]; break; }
      }
      if (stop.positionTerms.length === 1) {
        if (prevPos.unit === stop.positionTerms[0].unit) {
          stop.positionTerms[0].value = Max2(prevPos.value, stop.positionTerms[0].value);
          colorStops[i].positionTerms = stop.positionTerms;
        }
        prevPos = stop.positionTerms[0];
      }
      if (stop.midpoint !== null && prevPos.unit === stop.midpoint.unit) {
        const mid = stop.midpoint;
        mid.value = Max2(prevPos.value, mid.value);
        colorStops[i].midpoint = mid;
      }
    }

    // Scan over all other stops with missing positions
    for (let i = 0; i < colorStops.length; i++) {
      const stop = colorStops[i];
      if (stop.positionTerms.length === 1) continue;
      const info = { fromPos: { unit: "", value: NewF64(0) }, toPos: { unit: "", value: NewF64(0) }, fromCount: 0, toCount: 0 };
      infos[i] = info;
      for (let from = i - 1; from >= 0; from--) {
        const fromStop = colorStops[from];
        info.fromCount++;
        if (fromStop.midpoint !== null) { info.fromPos = fromStop.midpoint; break; }
        if (fromStop.positionTerms.length === 1) { info.fromPos = fromStop.positionTerms[0]; break; }
      }
      for (let to = i; to < colorStops.length; to++) {
        info.toCount++;
        const toStop = colorStops[to];
        if (toStop.midpoint !== null) { info.toPos = toStop.midpoint; break; }
        if (to + 1 < colorStops.length) {
          const next = colorStops[to + 1];
          if (next.positionTerms.length === 1) { info.toPos = next.positionTerms[0]; break; }
        }
      }
    }

    // Then fill in all other missing positions
    for (let i = 0; i < colorStops.length; i++) {
      const stop = colorStops[i];
      if (stop.positionTerms.length !== 1) {
        const info = infos[i];
        const t = NewF64(info.fromCount / (info.fromCount + info.toCount));
        if (info.fromPos.unit === info.toPos.unit) {
          colorStops[i].positionTerms = [{ value: Lerp(info.fromPos.value, info.toPos.value, t), unit: info.fromPos.unit }];
        } else {
          colorStops[i].positionTerms = [
            { value: t.Neg().AddConst(1).Mul(info.fromPos.value), unit: info.fromPos.unit },
            { value: t.Mul(info.toPos.value), unit: info.toPos.unit },
          ];
        }
      }
    }

    // Midpoints are only supported if they use the same units as their neighbors
    // Go 这里直接取 colorStops[i+1]（末 stop 带 midpoint 会 panic），此处保持同样的访问形态。
    for (let i = 0; i < colorStops.length; i++) {
      const stop = colorStops[i];
      if (stop.midpoint !== null) {
        const next = colorStops[i + 1]!;
        if (stop.positionTerms.length !== 1 || stop.midpoint.unit !== stop.positionTerms[0].unit ||
            next.positionTerms.length !== 1 || stop.midpoint.unit !== next.positionTerms[0].unit) {
          return { result: [], ok: false };
        }
      }
    }
  }

  return { result: colorStops, ok: true };
}
const TEndOfFile = 0;

// ============================================================================
// 第 115 批：generateGradient + tryToExpandGradient（Go 探针 12 例，css-cps2-go.json）。
// 生成 token 的 Kind/Text/Whitespace 逐字节；插值色彩结果走 toFixed(10) known-deviation。
// ============================================================================
/** Go: type parsedGradient struct (css_decls_gradient.go:24) */
export interface ParsedGradient {
  leadingTokens: Token[];
  colorStops: ColorStop[];
  kind: number;
  repeating: boolean;
}

/** Go: func (p *parser) generateGradient(token css_ast.Token, gradient parsedGradient) css_ast.Token (css_decls_gradient.go:147) */
export function generateGradient(token: Token, gradient: ParsedGradient, minifyWhitespace: boolean): Token {
  const children: Token[] = [];
  const comma = commaToken(token.Loc, minifyWhitespace);

  children.push(...gradient.leadingTokens);
  for (const stop of gradient.colorStops) {
    if (children.length > 0) children.push(comma);
    if (stop.positions.length === 0 && stop.midpoint.Kind === 0) stop.color.Whitespace &= ~2 /* WhitespaceAfter */;
    children.push(stop.color);
    children.push(...stop.positions);
    if (stop.midpoint.Kind !== 0) children.push(comma, stop.midpoint);
  }
  token.Children = children;
  return token;
}

/** Go: func tryToExpandGradient(loc, gradient, colorStops, remaining, colorSpace, hueMethod) bool (css_decls_gradient.go:695) */
export function tryToExpandGradient(
  loc: number,
  gradient: ParsedGradient,
  colorStops: ParsedColorStop[],
  remaining: Token[],
  cs: number,
  method: number,
): boolean {
  // Convert color stops into the interpolation color space
  for (const stop of colorStops) {
    const [v0, v1, v2] = xyz_to_colorSpace(stop.x, stop.y, stop.z, cs);
    [stop.v0, stop.v1, stop.v2] = premultiply(v0, v1, v2, stop.alpha, cs);
  }

  const newColorStops: ColorStop[] = [];
  const generateColorStops = (
    depth: number,
    from: ParsedColorStop, to: ParsedColorStop,
    prevX: F64, prevY: F64, prevZ: F64, prevR: F64, prevG: F64, prevB: F64, prevA: F64, prevT: F64,
    nextX: F64, nextY: F64, nextZ: F64, nextR: F64, nextG: F64, nextB: F64, nextA: F64, nextT: F64,
  ): void => {
    if (depth > 4) return;

    const t = prevT.Add(nextT).DivConst(2);
    let positionT = t;

    // Handle midpoints (which we have already checked uses the same units)
    if (from.midpoint !== null) {
      const fromPos = from.positionTerms[0].value;
      const toPos = to.positionTerms[0].value;
      const stopPos = Lerp(fromPos, toPos, t);
      const H = from.midpoint.value.Sub(fromPos).Div(toPos.Sub(fromPos));
      const P = stopPos.Sub(fromPos).Div(toPos.Sub(fromPos));
      if (H.Value() <= 0) positionT = NewF64(1);
      else if (H.Value() >= 1) positionT = NewF64(0);
      else positionT = P.Pow(NewF64(-1).Div(H.Log2()));
    }

    let [v0, v1, v2] = interpolateColors(from.v0, from.v1, from.v2, to.v0, to.v1, to.v2, cs, method, positionT);
    const a = Lerp(from.alpha, to.alpha, positionT);
    [v0, v1, v2] = unpremultiply(v0, v1, v2, a, cs);
    const [x, y, z] = colorSpace_to_xyz(v0, v1, v2, cs);

    // Stop when the color is similar enough to the sRGB midpoint
    const epsilon = 4.0 / 255;
    const [r, g, b] = gam_srgb(...xyz_to_lin_srgb(x, y, z));
    const dr = r.Mul(a).Sub(prevR.Mul(prevA).Add(nextR.Mul(nextA)).DivConst(2));
    const dg = g.Mul(a).Sub(prevG.Mul(prevA).Add(nextG.Mul(nextA)).DivConst(2));
    const db = b.Mul(a).Sub(prevB.Mul(prevA).Add(nextB.Mul(nextA)).DivConst(2));
    if (dr.Squared().Add(dg.Squared()).Add(db.Squared()).Value() < epsilon * epsilon) return;

    // Recursive split before this stop
    generateColorStops(depth + 1, from, to,
      prevX, prevY, prevZ, prevR, prevG, prevB, prevA, prevT,
      x, y, z, r, g, b, a, t);

    // Generate this stop
    const color = makeColorToken(loc, x, y, z, a);
    const positionTerms = interpolatePositions(from.positionTerms, to.positionTerms, t);
    const position = makePositionToken(loc, positionTerms);
    position.Whitespace = 1 /* WhitespaceBefore */;
    const s = new ColorStop();
    s.color = color; s.positions = [position];
    newColorStops.push(s);

    // Recursive split after this stop
    generateColorStops(depth + 1, from, to,
      x, y, z, r, g, b, a, t,
      nextX, nextY, nextZ, nextR, nextG, nextB, nextA, nextT);
  };

  for (let i = 0; i < colorStops.length; i++) {
    const stop = colorStops[i];
    const color = makeColorToken(loc, stop.x, stop.y, stop.z, stop.alpha);
    const position = makePositionToken(loc, stop.positionTerms);
    position.Whitespace = 1 /* WhitespaceBefore */;
    const s = new ColorStop();
    s.color = color; s.positions = [position];
    newColorStops.push(s);

    // Generate new color stops in between as needed
    if (i + 1 < colorStops.length) {
      const next = colorStops[i + 1];
      generateColorStops(0, stop, next,
        stop.x, stop.y, stop.z, stop.r, stop.g, stop.b, stop.alpha, NewF64(0),
        next.x, next.y, next.z, next.r, next.g, next.b, next.alpha, NewF64(1));
    }
  }

  gradient.leadingTokens = remaining;
  gradient.colorStops = newColorStops;
  return true;
}

// ============================================================================
// 第 116 批：parseGradient（Go 探针 18 例，css-pg-go.json，逐字节）。
// ============================================================================
/** Go: func parseGradient(token css_ast.Token) (gradient parsedGradient, success bool) (css_decls_gradient.go:37) */
export function parseGradient(token: Token): { gradient: ParsedGradient; ok: boolean } {
  const gradient: ParsedGradient = { leadingTokens: [], colorStops: [], kind: 0, repeating: false };
  if (token.Kind !== AT.TFunction) return { gradient, ok: false };

  switch (token.Text.toLowerCase()) {
    case "linear-gradient": gradient.kind = gradientKind.linearGradient; break;
    case "radial-gradient": gradient.kind = gradientKind.radialGradient; break;
    case "conic-gradient": gradient.kind = gradientKind.conicGradient; break;
    case "repeating-linear-gradient": gradient.kind = gradientKind.linearGradient; gradient.repeating = true; break;
    case "repeating-radial-gradient": gradient.kind = gradientKind.radialGradient; gradient.repeating = true; break;
    case "repeating-conic-gradient": gradient.kind = gradientKind.conicGradient; gradient.repeating = true; break;
    default: return { gradient, ok: false };
  }

  // Bail if any token is a "var()" since it may introduce commas
  let tokens: Token[] = (token.Children ?? []).slice();
  for (const t of tokens) {
    if (t.Kind === AT.TFunction && t.Text.toLowerCase() === "var") return { gradient, ok: false };
  }

  // Try to strip the initial tokens
  if (tokens.length > 0 && !looksLikeColor(tokens[0])) {
    let i = 0;
    while (i < tokens.length && tokens[i].Kind !== AT.TComma) i++;
    gradient.leadingTokens = tokens.slice(0, i);
    tokens = i < tokens.length ? tokens.slice(i + 1) : [];
  }

  // Try to parse the color stops
  while (tokens.length > 0) {
    const color = tokens[0];
    if (!looksLikeColor(color)) return { gradient, ok: false };
    tokens = tokens.slice(1);

    const positions: Token[] = [];
    while (positions.length < 2 && tokens.length > 0) {
      const position = tokens[0];
      if (IsNumeric(position.Kind) || (position.Kind === AT.TFunction && position.Text.toLowerCase() === "calc")) {
        positions.push(position);
      } else break;
      tokens = tokens.slice(1);
    }

    let midpoint = new Token();
    if (tokens.length > 0) {
      if (tokens[0].Kind !== AT.TComma) return { gradient, ok: false };
      tokens = tokens.slice(1);
      if (tokens.length === 0) return { gradient, ok: false };
      if (tokens.length > 0 && IsNumeric(tokens[0].Kind)) {
        midpoint = tokens[0];
        tokens = tokens.slice(1);
        if (tokens.length === 0 || tokens[0].Kind !== AT.TComma) return { gradient, ok: false };
        tokens = tokens.slice(1);
      }
    }

    const s = new ColorStop();
    s.color = color; s.positions = positions; s.midpoint = midpoint;
    gradient.colorStops.push(s);
  }

  return { gradient, ok: true };
}


// ============================================================================
// 第 134 批：lowerAndMinifyGradient（Go 探针 60 例，grad-lower-go.json）。
// ============================================================================
const GradientMidpoints = 8, ColorFunctionsBit = 1, GradientInterpolationBit = 4, GradientDoublePosition = 2;
const feature = (p: CSSParser, bit: number): boolean => (Number(p.options.unsupportedCSSFeatures ?? 0) & bit) !== 0;

/** Go: func (p *parser) lowerAndMinifyGradient(token css_ast.Token, wouldClipColor *bool) css_ast.Token (css_decls_gradient.go:170) */
export function lowerAndMinifyGradient(p: CSSParser, token: Token, wouldClipColor: { value: boolean } | null): Token {
  const parsed = parseGradient(token);
  if (!parsed.ok) return token;
  const gradient = parsed.gradient;
  let lowerMidpoints = feature(p, GradientMidpoints);
  const lowerColorSpaces = feature(p, ColorFunctionsBit);
  const lowerInterpolation = feature(p, GradientInterpolationBit);
  if (lowerInterpolation) lowerMidpoints = lowerColorSpaces || lowerMidpoints;

  let didExpand = false;
  if (lowerMidpoints || lowerColorSpaces || lowerInterpolation) {
    const stops = tryToParseColorStops({ colorStops: gradient.colorStops, kind: gradient.kind });
    if (stops.ok) {
      let hasColorSpace = false, hasMidpoint = false;
      for (const stop of stops.result) {
        if (stop.hasColorSpace) hasColorSpace = true;
        if (stop.midpoint !== null) hasMidpoint = true;
      }
      const remaining = removeColorInterpolation(gradient.leadingTokens);
      if ((remaining.ok && lowerInterpolation) || (hasColorSpace && lowerColorSpaces) || (hasMidpoint && lowerMidpoints)) {
        if (remaining.ok) {
          tryToExpandGradient(token.Loc, gradient, stops.result, remaining.remaining, remaining.space, remaining.method);
        } else {
          tryToExpandGradient(token.Loc, gradient, stops.result, gradient.leadingTokens,
            hasColorSpace ? colorSpace.colorSpace_oklab : colorSpace.colorSpace_srgb, hueMethod.shorterHue);
        }
        didExpand = true;
      }
    }
  }

  for (const stop of gradient.colorStops) stop.color = lowerAndMinifyColor(p, stop.color, wouldClipColor);

  if (feature(p, GradientDoublePosition)) {
    if (gradient.colorStops.some((s) => s.positions.length > 1)) gradient.colorStops = switchToSinglePositions(gradient.colorStops);
  } else if (p.options.minifySyntax) {
    for (let i = 0; i < gradient.colorStops.length; i++) {
      const stop = gradient.colorStops[i];
      if (i > 0 && stop.positions.length === 1) {
        const prev = gradient.colorStops[i - 1];
        if (prev.positions.length === 1 && prev.midpoint.Kind === 0 && TokensEqual([prev.color], [stop.color], null)) {
          gradient.colorStops = switchToDoublePositions(gradient.colorStops);
          break;
        }
      }
    }
  }
  if (p.options.minifySyntax || didExpand) gradient.colorStops = removeImpliedPositions(gradient.kind, gradient.colorStops);
  return generateGradient(token, gradient, p.options.minifyWhitespace);
}
