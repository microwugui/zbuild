// 1:1 移植自 esbuild internal/css_parser/css_decls_color.go（v0.28.2，commit f6058f83）
// 第 44 轮叶子优先规划：uint32 颜色位运算助手。真值表由 Go 探针固化在
// testdata/css-color-leaf-go.json。
import { F64, Lerp } from "../helpers/float.ts";
import { T, Token } from "../css_ast/css_ast.ts";
import { gam_srgb, xyz_to_lin_srgb } from "./css_color_spaces.ts";

/** Go: func parseHex(text string) (uint32, bool) (css_decls_color.go:201) */
export function parseHex(text: string): { value: number; ok: boolean } {
  let hex = 0;
  for (const c of text) {
    hex = (hex << 4) >>> 0;
    const cp = c.charCodeAt(0);
    if (cp >= 0x30 && cp <= 0x39) hex |= cp - 0x30;
    else if (cp >= 0x61 && cp <= 0x66) hex |= cp - (0x61 - 10);
    else if (cp >= 0x41 && cp <= 0x46) hex |= cp - (0x41 - 10);
    else return { value: 0, ok: false };
  }
  return { value: hex >>> 0, ok: true };
}

/** Go: func floatToStringForColor(a float64) string (css_decls_color.go:234) */
export function floatToStringForColor(a: number): string {
  let text = a.toFixed(3);
  while (text.endsWith("0")) text = text.slice(0, -1);
  if (text.endsWith(".")) text = text.slice(0, -1);
  return text;
}

/** Go math.Round（半值远离零）*/
function goRound(x: number): number {
  return x >= 0 ? Math.floor(x + 0.5) : Math.ceil(x - 0.5);
}

/** Go: func floatToByte(f float64) uint32 (css_decls_color.go:804) */
export function floatToByte(f: number): number {
  let i = goRound(f * 255);
  if (i < 0) i = 0;
  else if (i > 255) i = 255;
  return i >>> 0;
}

/** Go: func compactHex(v uint32) uint32 (css_decls_color.go:220) */
export function compactHex(v: number): number {
  return ((v & 0x0ff00000) >>> 12) | ((v & 0x00000ff0) >>> 4);
}

/** Go: func expandHex(v uint32) uint32 (css_decls_color.go:225) */
export function expandHex(v: number): number {
  return (((v & 0xf000) << 16) | ((v & 0xff00) << 12) | ((v & 0x0ff0) << 8) |
    ((v & 0x00ff) << 4) | (v & 0x000f)) >>> 0;
}

/** Go: func hexR(v uint32) int (css_decls_color.go:229) */
export function hexR(v: number): number { return v >>> 24; }
/** Go: func hexG(v uint32) int (css_decls_color.go:230) */
export function hexG(v: number): number { return (v >>> 16) & 255; }
/** Go: func hexB(v uint32) int (css_decls_color.go:231) */
export function hexB(v: number): number { return (v >>> 8) & 255; }
/** Go: func hexA(v uint32) int (css_decls_color.go:232) */
export function hexA(v: number): number { return v & 255; }

/** Go 的 strconv.ParseFloat：整串必须是合法 float 字面量，否则视为报错 */
function goParseFloat(text: string): number | null {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null;
  const v = parseFloat(text);
  return Number.isNaN(v) ? null : v;
}

/** Go: func hueToRgb(t1 F64, t2 F64, hue F64) F64 (css_decls_color.go:781) */
export function hueToRgb(t1: F64, t2: F64, hue: F64): F64 {
  hue = hue.Sub(hue.Floor());
  hue = hue.MulConst(6);
  let f: F64;
  if (hue.Value() < 1) f = Lerp(t1, t2, hue);
  else if (hue.Value() < 3) f = t2;
  else if (hue.Value() < 4) f = Lerp(t1, t2, hue.Neg().AddConst(4));
  else f = t1;
  return f;
}

/** Go: func packRGBA(rf F64, gf F64, bf F64, a uint32) uint32 (css_decls_color.go:797) */
export function packRGBA(rf: F64, gf: F64, bf: F64, a: number): number {
  const r = floatToByte(rf.Value());
  const g = floatToByte(gf.Value());
  const b = floatToByte(bf.Value());
  return (((r << 24) | (g << 16) | (b << 8) | a) >>> 0);
}

/** Go: func parseColorByte(token css_ast.Token, scale float64) (uint32, bool) (css_decls_color.go:821) */
export function parseColorByte(token: Token, scale: number): { value: number; ok: boolean } {
  let i = 0;
  let ok = false;
  if (token.Kind === T.TNumber) {
    const f = goParseFloat(token.Text);
    if (f !== null) { i = goRound(f * scale); ok = true; }
  } else if (token.Kind === T.TPercentage) {
    const f = goParseFloat(token.PercentageValue());
    if (f !== null) { i = goRound(f * (255.0 / 100.0)); ok = true; }
  }
  if (i < 0) i = 0;
  else if (i > 255) i = 255;
  return { value: i >>> 0, ok };
}

/** Go: func degreesForAngle(token css_ast.Token) (float64, bool) (css_decls_color.go:245) */
export function degreesForAngle(token: Token): { value: number; ok: boolean } {
  if (token.Kind === T.TNumber) {
    const value = goParseFloat(token.Text);
    if (value !== null) return { value, ok: true };
  } else if (token.Kind === T.TDimension) {
    const value = goParseFloat(token.DimensionValue());
    if (value !== null) {
      switch (token.DimensionUnit()) {
        case "deg": return { value, ok: true };
        case "grad": return { value: value * (360.0 / 400.0), ok: true };
        case "rad": return { value: value * (180.0 / Math.PI), ok: true };
        case "turn": return { value: value * 360.0, ok: true };
      }
    }
  }
  return { value: 0, ok: false };
}

/** Go: func lowerAlphaPercentageToNumber(token css_ast.Token) css_ast.Token (css_decls_color.go:269) */
export function lowerAlphaPercentageToNumber(token: Token): Token {
  if (token.Kind === T.TPercentage) {
    const value = goParseFloat(token.Text.slice(0, token.Text.length - 1));
    if (value !== null) {
      token.Kind = T.TNumber;
      token.Text = floatToStringForColor(value / 100.0);
    }
  }
  return token;
}

/** Go: func hslToRgb(hue, sat, light F64) (r, g, b F64) (css_decls_color.go:766) */
export function hslToRgb(hue: F64, sat: F64, light: F64): [F64, F64, F64] {
  hue = hue.DivConst(360.0);
  let t2: F64;
  if (light.Value() <= 0.5) t2 = sat.AddConst(1).Mul(light);
  else t2 = light.Add(sat).Sub(light.Mul(sat));
  const t1 = light.MulConst(2).Sub(t2);
  return [
    hueToRgb(t1, t2, hue.AddConst(1.0 / 3.0)),
    hueToRgb(t1, t2, hue),
    hueToRgb(t1, t2, hue.SubConst(1.0 / 3.0)),
  ];
}

/** Go: func parseAlphaByte(token css_ast.Token) (uint32, bool) (css_decls_color.go:814) */
export function parseAlphaByte(token: Token): { value: number; ok: boolean } {
  if (token.Kind === 0) return { value: 255, ok: true };
  return parseColorByte(token, 255);
}

/** Go: func tryToConvertToHexWithoutClipping(x, y, z F64, a uint32) (uint32, bool) (css_decls_color.go:847) */
export function tryToConvertToHexWithoutClipping(x: F64, y: F64, z: F64, a: number): { value: number; ok: boolean } {
  const [r, g, b] = gam_srgb(...xyz_to_lin_srgb(x, y, z));
  if (r.Value() < -0.5 / 255 || r.Value() > 255.5 / 255 ||
      g.Value() < -0.5 / 255 || g.Value() > 255.5 / 255 ||
      b.Value() < -0.5 / 255 || b.Value() > 255.5 / 255) {
    return { value: 0, ok: false };
  }
  return { value: packRGBA(r, g, b, a), ok: true };
}

// ============================================================================
// 第 113 批：parseColor / looksLikeColor（Go 探针 22 例；xyz 走 1-ULP known-deviation 口径）。
// 真值表固化于 testdata/css-pcolor-go.json（9b1a5776…）；颜色名表由 Go 导出 color_names_generated.ts。
// ============================================================================
import { colorNameToHex } from "./color_names_generated.ts";
import {
  lin_srgb, lin_srgb_to_xyz,
  lin_a98rgb, lin_a98rgb_to_xyz, lin_p3, lin_p3_to_xyz,
  lin_prophoto, lin_prophoto_to_xyz, d50_to_d65, lin_2020, lin_2020_to_xyz,
  lab_to_xyz, lch_to_lab, oklab_to_xyz, oklch_to_oklab,
} from "./css_color_spaces.ts";
import { NewF64 } from "../helpers/float.ts";

/** Go: type parsedColor struct (css_decls_color.go:423) */
export interface ParsedColor { x: F64; y: F64; z: F64; hex: number; hasColorSpace: boolean; }
const zeroPC = (): ParsedColor => ({ x: new F64(0), y: new F64(0), z: new F64(0), hex: 0, hasColorSpace: false });
const AllowAnyPercentage = 3, AllowPercentageAbove100 = 2;

/** Go: func hwbToRgb(hue, white, black F64) (F64,F64,F64) (css_decls_color.go:752) */
function hwbToRgb(hue: F64, white: F64, black: F64): [F64, F64, F64] {
  if (white.Add(black).Value() >= 1) { const gray = white.Div(white.Add(black)); return [gray, gray, gray]; }
  const delta = white.Add(black).Neg().AddConst(1);
  const [r0, g0, b0] = hslToRgb(hue, new F64(1), new F64(0.5));
  return [delta.Mul(r0).Add(white), delta.Mul(g0).Add(white), delta.Mul(b0).Add(white)];
}

/** Go: func parseColor(token css_ast.Token) (parsedColor, bool) (css_decls_color.go:465) */
export function parseColor(token: Token): { color: ParsedColor; ok: boolean } {
  const text = token.Text;
  if (token.Kind === T.TIdent) {
    const hex = colorNameToHex[text.toLowerCase()];
    if (hex !== undefined) { const c = zeroPC(); c.hex = hex >>> 0; return { color: c, ok: true }; }
  } else if (token.Kind === 28 /* THash */) {
    switch (text.length) {
      case 3: { const h = parseHex(text); if (h.ok) { const c = zeroPC(); c.hex = ((expandHex(h.value) << 8) >>> 0 | 0xff) >>> 0; return { color: c, ok: true }; } break; }
      case 4: { const h = parseHex(text); if (h.ok) { const c = zeroPC(); c.hex = expandHex(h.value) >>> 0; return { color: c, ok: true }; } break; }
      case 6: { const h = parseHex(text); if (h.ok) { const c = zeroPC(); c.hex = ((h.value << 8) >>> 0 | 0xff) >>> 0; return { color: c, ok: true }; } break; }
      case 8: { const h = parseHex(text); if (h.ok) { const c = zeroPC(); c.hex = h.value >>> 0; return { color: c, ok: true }; } break; }
    }
  } else if (token.Kind === T.TFunction) {
    const lower = text.toLowerCase();
    const args = token.Children ?? [];
    if (lower === "rgb" || lower === "rgba") {
      let r = new Token(), g = new Token(), b = new Token(), a = new Token();
      if (args.length === 3) { [r, g, b] = args; }
      else if (args.length === 5) {
        if (args[1].Kind === T.TComma && args[3].Kind === T.TComma) { r = args[0]; g = args[2]; b = args[4]; }
        else if (args[3].Kind === T.TDelimSlash) { [r, g, b, a] = [args[0], args[1], args[2], args[4]]; }
      } else if (args.length === 7) {
        if (args[1].Kind === T.TComma && args[3].Kind === T.TComma && args[5].Kind === T.TComma) { [r, g, b, a] = [args[0], args[2], args[4], args[6]]; }
      }
      const rr = parseColorByte(r, 1), gg = parseColorByte(g, 1), bb = parseColorByte(b, 1), aa = parseAlphaByte(a);
      if (rr.ok && gg.ok && bb.ok && aa.ok) {
        const c = zeroPC(); c.hex = (((rr.value << 24) >>> 0) | (gg.value << 16) | (bb.value << 8) | aa.value) >>> 0;
        return { color: c, ok: true };
      }
    } else if (lower === "hsl" || lower === "hsla") {
      let h = new Token(), s = new Token(), l = new Token(), a = new Token();
      if (args.length === 3) { [h, s, l] = args; }
      else if (args.length === 5) {
        if (args[1].Kind === T.TComma && args[3].Kind === T.TComma) { h = args[0]; s = args[2]; l = args[4]; }
        else if (args[3].Kind === T.TDelimSlash) { [h, s, l, a] = [args[0], args[1], args[2], args[4]]; }
      } else if (args.length === 7) {
        if (args[1].Kind === T.TComma && args[3].Kind === T.TComma && args[5].Kind === T.TComma) { [h, s, l, a] = [args[0], args[2], args[4], args[6]]; }
      }
      const hd = degreesForAngle(h), sf = s.ClampedFractionForPercentage(), lf = l.ClampedFractionForPercentage(), aa = parseAlphaByte(a);
      if (hd.ok && sf.ok && lf.ok && aa.ok) {
        const [r, g, b] = hslToRgb(new F64(hd.value), new F64(sf.value), new F64(lf.value));
        const c = zeroPC(); c.hex = packRGBA(r, g, b, aa.value) >>> 0; return { color: c, ok: true };
      }
    } else if (lower === "hwb") {
      let h = new Token(), s = new Token(), l = new Token(), a = new Token();
      if (args.length === 3) { [h, s, l] = args; }
      else if (args.length === 5) { if (args[3].Kind === T.TDelimSlash) { [h, s, l, a] = [args[0], args[1], args[2], args[4]]; } }
      const hd = degreesForAngle(h), wf = s.ClampedFractionForPercentage(), bf = l.ClampedFractionForPercentage(), aa = parseAlphaByte(a);
      if (hd.ok && wf.ok && bf.ok && aa.ok) {
        const [r, g, b] = hwbToRgb(new F64(hd.value), new F64(wf.value), new F64(bf.value));
        const c = zeroPC(); c.hex = packRGBA(r, g, b, aa.value) >>> 0; return { color: c, ok: true };
      }
    } else if (lower === "color") {
      let cs = new Token(), alpha = new Token();
      if (args.length === 4) { cs = args[0]; }
      else if (args.length === 6) { if (args[4].Kind === T.TDelimSlash) { cs = args[0]; alpha = args[5]; } }
      if (cs.Kind === T.TIdent) {
        const v0 = args[1].NumberOrFractionForPercentage(1, 0), v1 = args[2].NumberOrFractionForPercentage(1, 0), v2 = args[3].NumberOrFractionForPercentage(1, 0), aa = parseAlphaByte(alpha);
        if (v0.ok && v1.ok && v2.ok && aa.ok) {
          const a0 = new F64(v0.value), a1 = new F64(v1.value), a2 = new F64(v2.value);
          const c = zeroPC(); c.hex = aa.value; c.hasColorSpace = true;
          switch (cs.Text.toLowerCase()) {
            case "a98-rgb": { const [r, g, b] = lin_a98rgb(a0, a1, a2); [c.x, c.y, c.z] = lin_a98rgb_to_xyz(r, g, b); return { color: c, ok: true }; }
            case "display-p3": { const [r, g, b] = lin_p3(a0, a1, a2); [c.x, c.y, c.z] = lin_p3_to_xyz(r, g, b); return { color: c, ok: true }; }
            case "prophoto-rgb": { const [r, g, b] = lin_prophoto(a0, a1, a2); let [x, y, z] = lin_prophoto_to_xyz(r, g, b); [c.x, c.y, c.z] = d50_to_d65(x, y, z); return { color: c, ok: true }; }
            case "rec2020": { const [r, g, b] = lin_2020(a0, a1, a2); [c.x, c.y, c.z] = lin_2020_to_xyz(r, g, b); return { color: c, ok: true }; }
            case "srgb": { const [r, g, b] = lin_srgb(a0, a1, a2); [c.x, c.y, c.z] = lin_srgb_to_xyz(r, g, b); return { color: c, ok: true }; }
            case "srgb-linear": { [c.x, c.y, c.z] = lin_srgb_to_xyz(a0, a1, a2); return { color: c, ok: true }; }
            case "xyz": case "xyz-d65": { c.x = a0; c.y = a1; c.z = a2; return { color: c, ok: true }; }
            case "xyz-d50": { [c.x, c.y, c.z] = d50_to_d65(a0, a1, a2); return { color: c, ok: true }; }
          }
        }
      }
    } else if (lower === "lab" || lower === "lch" || lower === "oklab" || lower === "oklch") {
      let v0 = new Token(), v1 = new Token(), v2 = new Token(), alpha = new Token();
      if (args.length === 3) { [v0, v1, v2] = args; }
      else if (args.length === 5) { if (args[3].Kind === T.TDelimSlash) { [v0, v1, v2, alpha] = [args[0], args[1], args[2], args[4]]; } }
      if (v0.Kind !== 0) {
        const aa = parseAlphaByte(alpha);
        if (aa.ok) {
          if (lower === "lab") {
            const a = v0.NumberOrFractionForPercentage(100, 0), b = v1.NumberOrFractionForPercentage(125, AllowAnyPercentage), cc = v2.NumberOrFractionForPercentage(125, AllowAnyPercentage);
            if (a.ok && b.ok && cc.ok) { const c = zeroPC(); [c.x, c.y, c.z] = d50_to_d65(...lab_to_xyz(new F64(a.value), new F64(b.value), new F64(cc.value))); c.hex = aa.value; c.hasColorSpace = true; return { color: c, ok: true }; }
          } else if (lower === "lch") {
            const a = v0.NumberOrFractionForPercentage(100, 0), b = v1.NumberOrFractionForPercentage(125, AllowPercentageAbove100), hd = degreesForAngle(v2);
            if (a.ok && b.ok && hd.ok) { const c = zeroPC(); const [l, aa1, bb] = lch_to_lab(new F64(a.value), new F64(b.value), new F64(hd.value)); [c.x, c.y, c.z] = d50_to_d65(...lab_to_xyz(l, aa1, bb)); c.hex = aa.value; c.hasColorSpace = true; return { color: c, ok: true }; }
          } else if (lower === "oklab") {
            const a = v0.NumberOrFractionForPercentage(1, 0), b = v1.NumberOrFractionForPercentage(0.4, AllowAnyPercentage), cc = v2.NumberOrFractionForPercentage(0.4, AllowAnyPercentage);
            if (a.ok && b.ok && cc.ok) { const c = zeroPC(); [c.x, c.y, c.z] = oklab_to_xyz(new F64(a.value), new F64(b.value), new F64(cc.value)); c.hex = aa.value; c.hasColorSpace = true; return { color: c, ok: true }; }
          } else if (lower === "oklch") {
            const a = v0.NumberOrFractionForPercentage(1, 0), b = v1.NumberOrFractionForPercentage(0.4, AllowPercentageAbove100), hd = degreesForAngle(v2);
            if (a.ok && b.ok && hd.ok) { const c = zeroPC(); const [l, aa1, bb] = oklch_to_oklab(new F64(a.value), new F64(b.value), new F64(hd.value)); [c.x, c.y, c.z] = oklab_to_xyz(l, aa1, bb); c.hex = aa.value; c.hasColorSpace = true; return { color: c, ok: true }; }
          }
        }
      }
    }
  }
  return { color: zeroPC(), ok: false };
}

/** Go: func looksLikeColor(token css_ast.Token) bool (css_decls_color.go:429) */
export function looksLikeColor(token: Token): boolean {
  if (token.Kind === T.TIdent) return colorNameToHex[token.Text.toLowerCase()] !== undefined;
  if (token.Kind === 28 /* THash */) { if ([3,4,6,8].includes(token.Text.length)) return parseHex(token.Text).ok; }
  if (token.Kind === T.TFunction) {
    switch (token.Text.toLowerCase()) {
      case "color-mix": case "color": case "hsl": case "hsla": case "hwb": case "lab": case "lch": case "oklab": case "oklch": case "rgb": case "rgba": return true;
    }
  }
  return false;
}

// ============================================================================
// 第 133 批：tryToGenerateColor / lowerAndMinifyColor（Go 探针 44 例，color-lower-go.json）。
// ============================================================================
import { CSSParser } from "./css_parser.ts";
import { commaToken } from "./css_decls.ts";
import { IsNumeric } from "../css_lexer/css_lexer.ts";
import { gamut_mapping_xyz_to_srgb } from "./css_color_spaces.ts";
import { alphaFractionTable } from "./alpha_fraction_generated.ts";
import { shortColorName } from "./short_color_name_generated.ts";
const HexRGBA = 32, RebeccaPurple = 4096, Modern_RGB_HSL = 1024, HWB = 16, ColorFunctions = 1;
const hasFeature = (p: CSSParser, bit: number): boolean => (Number(p.options.unsupportedCSSFeatures ?? 0) & bit) !== 0;

/** Go: func (p *parser) tryToGenerateColor(token css_ast.Token, color parsedColor, wouldClipColor *bool) css_ast.Token (css_decls_color.go:857) */
export function tryToGenerateColor(p: CSSParser, token: Token, color: ParsedColor, wouldClipColor: { value: boolean } | null): Token {
  let hex = 0;
  if (!color.hasColorSpace) hex = color.hex >>> 0;
  else {
    const converted = tryToConvertToHexWithoutClipping(color.x, color.y, color.z, color.hex);
    if (converted.ok) hex = converted.value >>> 0;
    else if (wouldClipColor !== null) { wouldClipColor.value = true; return token; }
    else {
      const [r, g, b] = gamut_mapping_xyz_to_srgb(color.x, color.y, color.z);
      hex = packRGBA(r, g, b, color.hex) >>> 0;
    }
  }
  const hx = (v: number, n: number): string => (v >>> 0).toString(16).padStart(n, "0");
  if (hexA(hex) === 255) {
    token.Children = null;
    const name = shortColorName.get(hex >>> 0);
    if (name !== undefined && p.options.minifySyntax) { token.Kind = T.TIdent; token.Text = name; }
    else {
      token.Kind = 28 /* THash */;
      const v = (hex >>> 8) >>> 0, compact = compactHex(v);
      token.Text = (p.options.minifySyntax && v === expandHex(compact) >>> 0) ? hx(compact, 3) : hx(v, 6);
    }
  } else if (!hasFeature(p, HexRGBA)) {
    token.Children = null; token.Kind = 28;
    const compact = compactHex(hex);
    token.Text = (p.options.minifySyntax && (hex >>> 0) === expandHex(compact) >>> 0) ? hx(compact, 4) : hx(hex, 8);
  } else {
    token.Kind = T.TFunction; token.Text = "rgba";
    const comma = commaToken(token.Loc, p.options.minifyWhitespace);
    let alpha = alphaFractionTable.slice(hexA(hex) * 4, hexA(hex) * 4 + 4);
    const space = alpha.indexOf(" ");
    if (space !== -1) alpha = alpha.slice(0, space);
    const mk = (text: string): Token => { const t = new Token(); t.Loc = token.Loc; t.Kind = T.TNumber; t.Text = text; return t; };
    token.Children = [mk(String(hexR(hex))), comma, mk(String(hexG(hex))), comma, mk(String(hexB(hex))), comma, mk(alpha)];
  }
  return token;
}

/** Go: func (p *parser) lowerAndMinifyColor(token css_ast.Token, wouldClipColor *bool) css_ast.Token (css_decls_color.go:280) */
export function lowerAndMinifyColor(p: CSSParser, token: Token, wouldClipColor: { value: boolean } | null): Token {
  const text = token.Text;
  switch (token.Kind) {
    case 28 /* THash */:
      if (hasFeature(p, HexRGBA)) {
        if (text.length === 4 || text.length === 8) {
          const parsed = parseHex(text);
          if (parsed.ok) {
            const hex = text.length === 4 ? (expandHex(parsed.value) >>> 0) : (parsed.value >>> 0);
            const c = zeroPC(); c.hex = hex;
            return tryToGenerateColor(p, token, c, null);
          }
        }
      }
      break;
    case T.TIdent:
      if (hasFeature(p, RebeccaPurple) && text.toLowerCase() === "rebeccapurple") { token.Kind = 28; token.Text = "663399"; }
      break;
    case T.TFunction: {
      const lower = text.toLowerCase();
      if (lower === "rgb" || lower === "rgba" || lower === "hsl" || lower === "hsla") {
        if (hasFeature(p, Modern_RGB_HSL)) {
          const args = token.Children ?? [];
          let removeAlpha = false, addAlpha = false;
          if ((lower === "hsl" || lower === "hsla") && args.length > 0) {
            const d = degreesForAngle(args[0]);
            if (d.ok) { args[0].Kind = T.TNumber; args[0].Text = floatToStringForColor(d.value); }
          }
          if (args.length === 3 && IsNumeric(args[0].Kind) && IsNumeric(args[1].Kind) && IsNumeric(args[2].Kind)) {
            removeAlpha = true;
            args[0].Whitespace = 0; args[1].Whitespace = 0;
            const comma = commaToken(token.Loc, p.options.minifyWhitespace);
            token.Children = [args[0], comma, args[1], comma, args[2]];
          } else if (args.length === 5) {
            if (IsNumeric(args[0].Kind) && args[1].Kind === 10 /* TComma */ && IsNumeric(args[2].Kind) && args[3].Kind === 10 && IsNumeric(args[4].Kind)) removeAlpha = true;
            else if (IsNumeric(args[0].Kind) && IsNumeric(args[1].Kind) && IsNumeric(args[2].Kind) && args[3].Kind === 24 /* TDelimSlash */ && IsNumeric(args[4].Kind)) {
              addAlpha = true;
              args[0].Whitespace = 0; args[1].Whitespace = 0; args[2].Whitespace = 0;
              const comma = commaToken(token.Loc, p.options.minifyWhitespace);
              token.Children = [args[0], comma, args[1], comma, args[2], comma, lowerAlphaPercentageToNumber(args[4])];
            }
          } else if (args.length === 7 && IsNumeric(args[0].Kind) && args[1].Kind === 10 && IsNumeric(args[2].Kind) && args[3].Kind === 10 &&
                     IsNumeric(args[4].Kind) && args[5].Kind === 10 && IsNumeric(args[6].Kind)) {
            addAlpha = true;
            args[6] = lowerAlphaPercentageToNumber(args[6]);
          }
          if (removeAlpha) {
            if (lower === "rgba") token.Text = "rgb";
            else if (lower === "hsla") token.Text = "hsl";
          } else if (addAlpha) {
            if (lower === "rgb") token.Text = "rgba";
            else if (lower === "hsl") token.Text = "hsla";
          }
        }
      } else if (lower === "hwb" && hasFeature(p, HWB)) {
        const c = parseColor(token); if (c.ok) return tryToGenerateColor(p, token, c.color, wouldClipColor);
      } else if (["color", "lab", "lch", "oklab", "oklch"].includes(lower) && hasFeature(p, ColorFunctions)) {
        const c = parseColor(token); if (c.ok) return tryToGenerateColor(p, token, c.color, wouldClipColor);
      }
      break;
    }
  }
  if (p.options.minifySyntax) {
    const c = parseColor(token);
    if (c.ok) token = tryToGenerateColor(p, token, c.color, wouldClipColor);
  }
  return token;
}
