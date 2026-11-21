// 1:1 移植自 esbuild internal/css_parser/css_color_spaces.go（v0.28.2，commit f6058f83）
// 第 44 轮叶子优先规划：颜色空间底座（isPolar / multiplyMatrices）。
// 真值表由 Go 探针固化在 testdata/css-colorspace-go.json。
import { F64, Min2 as min2, Max2 as max2, Min3 as min3, Max3 as max3 } from "../helpers/float.ts";

/** Go: colorSpace 枚举（Go 探针实测） */
export const colorSpace = {
  colorSpace_a98_rgb: 0,
  colorSpace_display_p3: 1,
  colorSpace_hsl: 2,
  colorSpace_hwb: 3,
  colorSpace_lab: 4,
  colorSpace_lch: 5,
  colorSpace_oklab: 6,
  colorSpace_oklch: 7,
  colorSpace_prophoto_rgb: 8,
  colorSpace_rec2020: 9,
  colorSpace_srgb: 10,
  colorSpace_srgb_linear: 11,
  colorSpace_xyz: 12,
  colorSpace_xyz_d50: 13,
  colorSpace_xyz_d65: 14,
} as const;

/** Go: func (colorSpace colorSpace) isPolar() bool (css_color_spaces.go:34) */
export function isPolar(cs: number): boolean {
  return cs === colorSpace.colorSpace_hsl || cs === colorSpace.colorSpace_hwb ||
    cs === colorSpace.colorSpace_lch || cs === colorSpace.colorSpace_oklch;
}

// Go: d50 白点常量 (css_color_spaces.go:253)
const d50_x = 0.3457 / 0.3585;
const d50_z = (1.0 - 0.3457 - 0.3585) / 0.3585;

/** Go: func lin_srgb_to_xyz(r, g, b F64) (F64, F64, F64) (css_color_spaces.go:73) */
export function lin_srgb_to_xyz(r: F64, g: F64, b: F64): [F64, F64, F64] {
  return multiplyMatrices([506752/1228815, 87881/245763, 12673/70218, 87098/409605, 175762/245763, 12673/175545, 7918/409605, 87881/737289, 1001167/1053270], r, g, b);
}
/** Go: func xyz_to_lin_srgb(x, y, z F64) (F64, F64, F64) (css_color_spaces.go:82) */
export function xyz_to_lin_srgb(x: F64, y: F64, z: F64): [F64, F64, F64] {
  return multiplyMatrices([12831/3959, -329/214, -1974/3959, -851781/878810, 1648619/878810, 36519/878810, 705/12673, -2585/12673, 705/667], x, y, z);
}
/** Go: func lin_p3_to_xyz(r, g, b F64) (F64, F64, F64) (css_color_spaces.go:99) */
export function lin_p3_to_xyz(r: F64, g: F64, b: F64): [F64, F64, F64] {
  return multiplyMatrices([608311/1250200, 189793/714400, 198249/1000160, 35783/156275, 247089/357200, 198249/2500400, 0, 32229/714400, 5220557/5000800], r, g, b);
}
/** Go: func xyz_to_lin_p3(x, y, z F64) (F64, F64, F64) (css_color_spaces.go:108) */
export function xyz_to_lin_p3(x: F64, y: F64, z: F64): [F64, F64, F64] {
  return multiplyMatrices([446124/178915, -333277/357830, -72051/178915, -14852/17905, 63121/35810, 423/17905, 11844/330415, -50337/660830, 316169/330415], x, y, z);
}
/** Go: func lin_prophoto_to_xyz(r, g, b F64) (F64, F64, F64) (css_color_spaces.go:141) */
export function lin_prophoto_to_xyz(r: F64, g: F64, b: F64): [F64, F64, F64] {
  return multiplyMatrices([0.7977604896723027, 0.13518583717574031, 0.0313493495815248, 0.2880711282292934, 0.7118432178101014, 0.00008565396060525902, 0, 0, 0.8251046025104601], r, g, b);
}
/** Go: func xyz_to_lin_prophoto(x, y, z F64) (F64, F64, F64) (css_color_spaces.go:150) */
export function xyz_to_lin_prophoto(x: F64, y: F64, z: F64): [F64, F64, F64] {
  return multiplyMatrices([1.3457989731028281, -0.25558010007997534, -0.05110628506753401, -0.5446224939028347, 1.5082327413132781, 0.02053603239147973, 0, 0, 1.2119675456389454], x, y, z);
}
/** Go: func lin_a98rgb_to_xyz(r, g, b F64) (F64, F64, F64) (css_color_spaces.go:173) */
export function lin_a98rgb_to_xyz(r: F64, g: F64, b: F64): [F64, F64, F64] {
  return multiplyMatrices([573536/994567, 263643/1420810, 187206/994567, 591459/1989134, 6239551/9945670, 374412/4972835, 53769/1989134, 351524/4972835, 4929758/4972835], r, g, b);
}
/** Go: func xyz_to_lin_a98rgb(x, y, z F64) (F64, F64, F64) (css_color_spaces.go:182) */
export function xyz_to_lin_a98rgb(x: F64, y: F64, z: F64): [F64, F64, F64] {
  return multiplyMatrices([1829569/896150, -506331/896150, -308931/896150, -851781/878810, 1648619/878810, 36519/878810, 16779/1248040, -147721/1248040, 1266979/1248040], x, y, z);
}
/** Go: func lin_2020_to_xyz(r, g, b F64) (F64, F64, F64) (css_color_spaces.go:217) */
export function lin_2020_to_xyz(r: F64, g: F64, b: F64): [F64, F64, F64] {
  return multiplyMatrices([63426534/99577255, 20160776/139408157, 47086771/278816314, 26158966/99577255, 472592308/697040785, 8267143/139408157, 0, 19567812/697040785, 295819943/278816314], r, g, b);
}
/** Go: func xyz_to_lin_2020(x, y, z F64) (F64, F64, F64) (css_color_spaces.go:226) */
export function xyz_to_lin_2020(x: F64, y: F64, z: F64): [F64, F64, F64] {
  return multiplyMatrices([30757411/17917100, -6372589/17917100, -4539589/17917100, -19765991/29648200, 47925759/29648200, 467509/29648200, 792561/44930125, -1921689/44930125, 42328811/44930125], x, y, z);
}

/** Go: func lin_srgb(r, g, b F64) (F64, F64, F64) (css_color_spaces.go:51) */
export function lin_srgb(r: F64, g: F64, b: F64): [F64, F64, F64] {
  const f = (val: F64): F64 => {
    const abs = val.Abs();
    return abs.Value() < 0.04045 ? val.DivConst(12.92)
      : abs.AddConst(0.055).DivConst(1.055).PowConst(2.4).WithSignFrom(val);
  };
  return [f(r), f(g), f(b)];
}

/** Go: func gam_srgb(r, g, b F64) (F64, F64, F64) (css_color_spaces.go:60) */
export function gam_srgb(r: F64, g: F64, b: F64): [F64, F64, F64] {
  const f = (val: F64): F64 => {
    const abs = val.Abs();
    return abs.Value() > 0.0031308
      ? abs.PowConst(1 / 2.4).MulConst(1.055).SubConst(0.055).WithSignFrom(val)
      : val.MulConst(12.92);
  };
  return [f(r), f(g), f(b)];
}

/** Go: func lin_p3(r, g, b F64) (F64, F64, F64) = lin_srgb (css_color_spaces.go:91) */
export function lin_p3(r: F64, g: F64, b: F64): [F64, F64, F64] { return lin_srgb(r, g, b); }
/** Go: func gam_p3(r, g, b F64) (F64, F64, F64) = gam_srgb (css_color_spaces.go:95) */
export function gam_p3(r: F64, g: F64, b: F64): [F64, F64, F64] { return gam_srgb(r, g, b); }

/** Go: func lin_prophoto(r, g, b F64) (F64, F64, F64) (css_color_spaces.go:117) */
export function lin_prophoto(r: F64, g: F64, b: F64): [F64, F64, F64] {
  const f = (val: F64): F64 => { const a = val.Abs(); return a.Value() <= 16 / 512 ? val.DivConst(16) : a.PowConst(1.8).WithSignFrom(val); };
  return [f(r), f(g), f(b)];
}
/** Go: func gam_prophoto(r, g, b F64) (F64, F64, F64) (css_color_spaces.go:129) */
export function gam_prophoto(r: F64, g: F64, b: F64): [F64, F64, F64] {
  const f = (val: F64): F64 => { const a = val.Abs(); return a.Value() >= 1 / 512 ? a.PowConst(1 / 1.8).WithSignFrom(val) : val.MulConst(16); };
  return [f(r), f(g), f(b)];
}
/** Go: func lin_a98rgb(r, g, b F64) (F64, F64, F64) (css_color_spaces.go:159) */
export function lin_a98rgb(r: F64, g: F64, b: F64): [F64, F64, F64] {
  const f = (val: F64): F64 => val.Abs().PowConst(563 / 256).WithSignFrom(val);
  return [f(r), f(g), f(b)];
}
/** Go: func gam_a98rgb(r, g, b F64) (F64, F64, F64) (css_color_spaces.go:166) */
export function gam_a98rgb(r: F64, g: F64, b: F64): [F64, F64, F64] {
  const f = (val: F64): F64 => val.Abs().PowConst(256 / 563).WithSignFrom(val);
  return [f(r), f(g), f(b)];
}
/** Go: func lin_2020(r, g, b F64) (F64, F64, F64) (css_color_spaces.go:191) */
export function lin_2020(r: F64, g: F64, b: F64): [F64, F64, F64] {
  const alpha = 1.09929682680944, beta = 0.018053968510807;
  const f = (val: F64): F64 => { const a = val.Abs(); return a.Value() < beta * 4.5 ? val.DivConst(4.5) : a.AddConst(alpha - 1).DivConst(alpha).PowConst(1 / 0.45).WithSignFrom(val); };
  return [f(r), f(g), f(b)];
}
/** Go: func gam_2020(r, g, b F64) (F64, F64, F64) (css_color_spaces.go:204) */
export function gam_2020(r: F64, g: F64, b: F64): [F64, F64, F64] {
  const alpha = 1.09929682680944, beta = 0.018053968510807;
  const f = (val: F64): F64 => { const a = val.Abs(); return a.Value() > beta ? a.PowConst(0.45).MulConst(alpha).SubConst(alpha - 1).WithSignFrom(val) : val.MulConst(4.5); };
  return [f(r), f(g), f(b)];
}

/** Go: func lab_to_lch(l, a, b F64) (F64, F64, F64) (css_color_spaces.go:316) */
export function lab_to_lch(l: F64, a: F64, b: F64): [F64, F64, F64] {
  let hue = b.Atan2(a).MulConst(180 / Math.PI);
  if (hue.Value() < 0) hue = hue.AddConst(360);
  return [l, a.Squared().Add(b.Squared()).Sqrt(), hue];
}

/** Go: func lch_to_lab(l, c, h F64) (F64, F64, F64) (css_color_spaces.go:325) */
export function lch_to_lab(l: F64, c: F64, h: F64): [F64, F64, F64] {
  return [l, h.MulConst(Math.PI / 180).Cos().Mul(c), h.MulConst(Math.PI / 180).Sin().Mul(c)];
}

/** Go: func xyz_to_oklab(x, y, z F64) (F64, F64, F64) (css_color_spaces.go:332) */
export function xyz_to_oklab(x: F64, y: F64, z: F64): [F64, F64, F64] {
  const XYZtoLMS = [0.8190224432164319, 0.3619062562801221, -0.12887378261216414,
    0.0329836671980271, 0.9292868468965546, 0.03614466816999844,
    0.048177199566046255, 0.26423952494422764, 0.6335478258136937];
  const LMStoOKLab = [0.2104542553, 0.7936177850, -0.0040720468,
    1.9779984951, -2.4285922050, 0.4505937099,
    0.0259040371, 0.7827717662, -0.8086757660];
  const [l, m, s] = multiplyMatrices(XYZtoLMS, x, y, z);
  return multiplyMatrices(LMStoOKLab, l.Cbrt(), m.Cbrt(), s.Cbrt());
}

/** Go: func d65_to_d50(x, y, z F64) (F64, F64, F64) (css_color_spaces.go:235) */
export function d65_to_d50(x: F64, y: F64, z: F64): [F64, F64, F64] {
  const M = [1.0479297925449969, 0.022946870601609652, -0.05019226628920524,
    0.02962780877005599, 0.9904344267538799, -0.017073799063418826,
    -0.009243040646204504, 0.015055191490298152, 0.7518742814281371];
  return multiplyMatrices(M, x, y, z);
}

/** Go: func d50_to_d65(x, y, z F64) (F64, F64, F64) (css_color_spaces.go:244) */
export function d50_to_d65(x: F64, y: F64, z: F64): [F64, F64, F64] {
  const M = [0.955473421488075, -0.02309845494876471, 0.06325924320057072,
    -0.0283697093338637, 1.0099953980813041, 0.021041441191917323,
    0.012314014864481998, -0.020507649298898964, 1.330365926242124];
  return multiplyMatrices(M, x, y, z);
}

/** Go: func xyz_to_lab(x, y, z F64) (F64, F64, F64) (css_color_spaces.go:256) */
export function xyz_to_lab(x_: F64, y_: F64, z_: F64): [F64, F64, F64] {
  const epsilon = 216.0 / 24389;
  const kappa = 24389.0 / 27;
  const x = x_.DivConst(d50_x), y = y_, z = z_.DivConst(d50_z);
  const f0 = x.Value() > epsilon ? x.Cbrt() : x.MulConst(kappa).AddConst(16).DivConst(116);
  const f1 = y.Value() > epsilon ? y.Cbrt() : y.MulConst(kappa).AddConst(16).DivConst(116);
  const f2 = z.Value() > epsilon ? z.Cbrt() : z.MulConst(kappa).AddConst(16).DivConst(116);
  return [f1.MulConst(116).SubConst(16), f0.Sub(f1).MulConst(500), f1.Sub(f2).MulConst(200)];
}

/** Go: func lab_to_xyz(l, a, b F64) (x, y, z F64) (css_color_spaces.go:285) */
export function lab_to_xyz(l: F64, a: F64, b: F64): [F64, F64, F64] {
  const kappa = 24389.0 / 27, epsilon = 216.0 / 24389;
  const f1 = l.AddConst(16).DivConst(116);
  const f0 = a.DivConst(500).Add(f1), f2 = f1.Sub(b.DivConst(200));
  const f0_3 = f0.Cubed(), f2_3 = f2.Cubed();
  const x = f0_3.Value() > epsilon ? f0_3 : f0.MulConst(116).SubConst(16).DivConst(kappa);
  const y = l.Value() > kappa * epsilon ? f1.Cubed() : l.DivConst(kappa);
  const z = f2_3.Value() > epsilon ? f2_3 : f2.MulConst(116).SubConst(16).DivConst(kappa);
  return [x.MulConst(d50_x), y, z.MulConst(d50_z)];
}

/** Go: func multiplyMatrices(A [9]float64, b0 F64, b1 F64, b2 F64) (F64, F64, F64) (css_color_spaces.go:370) */
export function multiplyMatrices(A: number[], b0: F64, b1: F64, b2: F64): [F64, F64, F64] {
  return [
    b0.MulConst(A[0]).Add(b1.MulConst(A[1])).Add(b2.MulConst(A[2])),
    b0.MulConst(A[3]).Add(b1.MulConst(A[4])).Add(b2.MulConst(A[5])),
    b0.MulConst(A[6]).Add(b1.MulConst(A[7])).Add(b2.MulConst(A[8])),
  ];
}

/** Go: func hsl_to_rgb(hue, sat, light F64) (F64, F64, F64) (css_color_spaces.go:453) */
export function hsl_to_rgb(hue_: F64, sat_: F64, light_: F64): [F64, F64, F64] {
  let hue = hue_.DivConst(360);
  hue = hue.Sub(hue.Floor()).MulConst(360);
  const sat = sat_.DivConst(100), light = light_.DivConst(100);
  const f = (n: number): F64 => {
    let k = hue.DivConst(30).AddConst(n).DivConst(12);
    k = k.Sub(k.Floor()).MulConst(12);
    const a = min2(light, light.Neg().AddConst(1)).Mul(sat);
    return light.Sub(max2(new F64(-1), min3(k.SubConst(3), k.Neg().AddConst(9), new F64(1))).Mul(a));
  };
  return [f(0), f(8), f(4)];
}

/** Go: func rgb_to_hsl(red, green, blue F64) (F64, F64, F64) (css_color_spaces.go:473) */
export function rgb_to_hsl(red: F64, green: F64, blue: F64): [F64, F64, F64] {
  const max = max3(red, green, blue), min = min3(red, green, blue);
  let hue = new F64(NaN), sat = new F64(0.0);
  const light = min.Add(max).DivConst(2);
  const d = max.Sub(min);
  if (d.Value() !== 0) {
    const div = min2(light, light.Neg().AddConst(1));
    if (div.Value() !== 0) sat = max.Sub(light).Div(div);
    if (max.Value() === red.Value()) { hue = green.Sub(blue).Div(d); if (green.Value() < blue.Value()) hue = hue.AddConst(6); }
    else if (max.Value() === green.Value()) hue = blue.Sub(red).Div(d).AddConst(2);
    else hue = red.Sub(green).Div(d).AddConst(4);
    hue = hue.MulConst(60);
  }
  return [hue, sat.MulConst(100), light.MulConst(100)];
}

/** Go: func oklab_to_xyz(l, a, b F64) (F64, F64, F64) (css_color_spaces.go:347) */
export function oklab_to_xyz(l: F64, a: F64, b: F64): [F64, F64, F64] {
  const LMStoXYZ = [1.2268798733741557, -0.5578149965554813, 0.28139105017721583,
    -0.04057576262431372, 1.1122868293970594, -0.07171106666151701,
    -0.07637294974672142, -0.4214933239627914, 1.5869240244272418];
  const OKLabtoLMS = [0.99999999845051981432, 0.39633779217376785678, 0.21580375806075880339,
    1.0000000088817607767, -0.1055613423236563494, -0.063854174771705903402,
    1.0000000546724109177, -0.089484182094965759684, -1.2914855378640917399];
  const [lm, mm, sm] = multiplyMatrices(OKLabtoLMS, l, a, b);
  return multiplyMatrices(LMStoXYZ, lm.Cubed(), mm.Cubed(), sm.Cubed());
}

/** Go: func oklab_to_oklch(l, a, b F64) (F64, F64, F64) = lab_to_lch (css_color_spaces.go:362) */
export function oklab_to_oklch(l: F64, a: F64, b: F64): [F64, F64, F64] { return lab_to_lch(l, a, b); }

/** Go: func oklch_to_oklab(l, c, h F64) (F64, F64, F64) = lch_to_lab (css_color_spaces.go:366) */
export function oklch_to_oklab(l: F64, c: F64, h: F64): [F64, F64, F64] { return lch_to_lab(l, c, h); }

/** Go: func delta_eok(L1, a1, b1, L2, a2, b2 F64) F64 (css_color_spaces.go:376) */
export function delta_eok(L1: F64, a1: F64, b1: F64, L2: F64, a2: F64, b2: F64): F64 {
  return L1.Sub(L2).Squared().Add(a1.Sub(a2).Squared()).Add(b1.Sub(b2).Squared()).Sqrt();
}

/** Go: func hwb_to_rgb(hue F64, white F64, black F64) (F64, F64, F64) (css_color_spaces.go:502) */
export function hwb_to_rgb(hue: F64, white: F64, black: F64): [F64, F64, F64] {
  white = white.DivConst(100);
  black = black.DivConst(100);
  if (white.Add(black).Value() >= 1) {
    const gray = white.Div(white.Add(black));
    return [gray, gray, gray];
  }
  const delta = white.Add(black).Neg().AddConst(1);
  const [r, g, b] = hsl_to_rgb(hue, new F64(100), new F64(50));
  return [delta.Mul(r).Add(white), delta.Mul(g).Add(white), delta.Mul(b).Add(white)];
}

/** Go: func rgb_to_hwb(red F64, green F64, blue F64) (F64, F64, F64) (css_color_spaces.go:517) */
export function rgb_to_hwb(red: F64, green: F64, blue: F64): [F64, F64, F64] {
  const [h] = rgb_to_hsl(red, green, blue);
  const white = min3(red, green, blue);
  const black = max3(red, green, blue).Neg().AddConst(1);
  return [h, white.MulConst(100), black.MulConst(100)];
}

// ============================================================================
// 第 107 批：色彩空间转换 3 入口（Go 探针 34 例，逐字节等于 Go）。
// 真值表固化于 testdata/css-colorspace2-go.json（08775be8…）。
// ============================================================================

import { NewF64 } from "../helpers/float.ts";

/** Go: func gamut_mapping_xyz_to_srgb(x, y, z F64) (F64, F64, F64) (css_color_spaces.go:383) */
export function gamut_mapping_xyz_to_srgb(x: F64, y: F64, z: F64): [F64, F64, F64] {
  const [origin_l, origin_c0, origin_h] = oklab_to_oklch(...xyz_to_oklab(x, y, z));
  let origin_c = origin_c0;
  if (origin_l.Value() >= 1 || origin_l.Value() <= 0) return [origin_l, origin_l, origin_l];

  const oklch_to_srgb = (l: F64, c: F64, h: F64): [F64, F64, F64] => {
    const [ol, a, b] = oklch_to_oklab(l, c, h);
    const [ox, oy, oz] = oklab_to_xyz(ol, a, b);
    const [lr, lg, lb] = xyz_to_lin_srgb(ox, oy, oz);
    return gam_srgb(lr, lg, lb);
  };
  const srgb_to_oklab = (r: F64, g: F64, b: F64): [F64, F64, F64] => {
    const [lr, lg, lb] = lin_srgb(r, g, b);
    const [ox, oy, oz] = lin_srgb_to_xyz(lr, lg, lb);
    return xyz_to_oklab(ox, oy, oz);
  };
  const inGamut = (r: F64, g: F64, b: F64): boolean =>
    r.Value() >= 0 && r.Value() <= 1 && g.Value() >= 0 && g.Value() <= 1 && b.Value() >= 0 && b.Value() <= 1;

  let [r, g, b] = oklch_to_srgb(origin_l, origin_c, origin_h);
  if (inGamut(r, g, b)) return [r, g, b];

  const JND = 0.02, epsilon = 0.0001;
  let min = NewF64(0.0), max = origin_c;
  const clip = (v: F64): F64 => v.Value() < 0 ? NewF64(0) : v.Value() > 1 ? NewF64(1) : v;

  while (max.Sub(min).Value() > epsilon) {
    const chroma = min.Add(max).DivConst(2);
    origin_c = chroma;
    [r, g, b] = oklch_to_srgb(origin_l, origin_c, origin_h);
    if (inGamut(r, g, b)) { min = chroma; continue; }
    const [cr, cg, cb] = [clip(r), clip(g), clip(b)];
    const [l1, a1, b1] = srgb_to_oklab(cr, cg, cb);
    const [l2, a2, b2] = srgb_to_oklab(r, g, b);
    const E = delta_eok(l1, a1, b1, l2, a2, b2);
    if (E.Value() < JND) return [cr, cg, cb];
    max = chroma;
  }
  return [r, g, b];
}

/** Go: func xyz_to_colorSpace(x, y, z F64, colorSpace colorSpace) (F64, F64, F64) (css_color_spaces.go:524) */
export function xyz_to_colorSpace(x: F64, y: F64, z: F64, cs: number): [F64, F64, F64] {
  switch (cs) {
    case colorSpace.colorSpace_a98_rgb: return gam_a98rgb(...xyz_to_lin_a98rgb(x, y, z));
    case colorSpace.colorSpace_display_p3: return gam_p3(...xyz_to_lin_p3(x, y, z));
    case colorSpace.colorSpace_hsl: return rgb_to_hsl(...gam_srgb(...xyz_to_lin_srgb(x, y, z)));
    case colorSpace.colorSpace_hwb: return rgb_to_hwb(...gam_srgb(...xyz_to_lin_srgb(x, y, z)));
    case colorSpace.colorSpace_lab: return xyz_to_lab(...d65_to_d50(x, y, z));
    case colorSpace.colorSpace_lch: return lab_to_lch(...xyz_to_lab(...d65_to_d50(x, y, z)));
    case colorSpace.colorSpace_oklab: return xyz_to_oklab(x, y, z);
    case colorSpace.colorSpace_oklch: return oklab_to_oklch(...xyz_to_oklab(x, y, z));
    case colorSpace.colorSpace_prophoto_rgb: return gam_prophoto(...xyz_to_lin_prophoto(...d65_to_d50(x, y, z)));
    case colorSpace.colorSpace_rec2020: return gam_2020(...xyz_to_lin_2020(x, y, z));
    case colorSpace.colorSpace_srgb: return gam_srgb(...xyz_to_lin_srgb(x, y, z));
    case colorSpace.colorSpace_srgb_linear: return xyz_to_lin_srgb(x, y, z);
    case colorSpace.colorSpace_xyz: case colorSpace.colorSpace_xyz_d65: return [x, y, z];
    case colorSpace.colorSpace_xyz_d50: return d65_to_d50(x, y, z);
    default: throw new Error("Internal error");
  }
}

/** Go: func colorSpace_to_xyz(v0, v1, v2 F64, colorSpace colorSpace) (F64, F64, F64) (css_color_spaces.go:573) */
export function colorSpace_to_xyz(v0: F64, v1: F64, v2: F64, cs: number): [F64, F64, F64] {
  switch (cs) {
    case colorSpace.colorSpace_a98_rgb: return lin_a98rgb_to_xyz(...lin_a98rgb(v0, v1, v2));
    case colorSpace.colorSpace_display_p3: return lin_p3_to_xyz(...lin_p3(v0, v1, v2));
    case colorSpace.colorSpace_hsl: return lin_srgb_to_xyz(...lin_srgb(...hsl_to_rgb(v0, v1, v2)));
    case colorSpace.colorSpace_hwb: return lin_srgb_to_xyz(...lin_srgb(...hwb_to_rgb(v0, v1, v2)));
    case colorSpace.colorSpace_lab: return d50_to_d65(...lab_to_xyz(v0, v1, v2));
    case colorSpace.colorSpace_lch: return d50_to_d65(...lab_to_xyz(...lch_to_lab(v0, v1, v2)));
    case colorSpace.colorSpace_oklab: return oklab_to_xyz(v0, v1, v2);
    case colorSpace.colorSpace_oklch: return oklab_to_xyz(...oklch_to_oklab(v0, v1, v2));
    case colorSpace.colorSpace_prophoto_rgb: return d50_to_d65(...lin_prophoto_to_xyz(...lin_prophoto(v0, v1, v2)));
    case colorSpace.colorSpace_rec2020: return lin_2020_to_xyz(...lin_2020(v0, v1, v2));
    case colorSpace.colorSpace_srgb: return lin_srgb_to_xyz(...lin_srgb(v0, v1, v2));
    case colorSpace.colorSpace_srgb_linear: return lin_srgb_to_xyz(v0, v1, v2);
    case colorSpace.colorSpace_xyz: case colorSpace.colorSpace_xyz_d65: return [v0, v1, v2];
    case colorSpace.colorSpace_xyz_d50: return d50_to_d65(v0, v1, v2);
    default: throw new Error("Internal error");
  }
}
