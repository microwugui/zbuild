// 1:1 移植自 esbuild internal/helpers/float.go（v0.28.2）
//
// Go 侧用 F64 包装所有浮点运算，避免编译器把 a*b+c 融合成 FMA 导致跨平台不一致。
// JS 没有隐式 FMA，但保留同样的封装形态，便于逐函数差分比对。
//
// 两处必须自己实现，不能用 JS 内置：
//   1. math.Round 是「半值远离零」，Math.round 是「半值向 +∞」
//   2. math.Cbrt 与 V8 的 Math.cbrt 存在 1 ULP 差异（实测 0.5 → ...3c vs ...3d），
//      这里逐行移植 Go 的 fdlibm 版本以保证逐位一致

export class F64 {
  value: number;

  constructor(a: number) {
    this.value = a;
  }

  /** Go: func (a F64) Value() float64 */
  Value(): number { return this.value; }

  /** Go: func (a F64) IsNaN() bool */
  IsNaN(): boolean { return Number.isNaN(this.value); }

  Neg(): F64 { return new F64(-this.value); }
  Abs(): F64 { return new F64(Math.abs(this.value)); }
  Sin(): F64 { return new F64(Math.sin(this.value)); }
  Cos(): F64 { return new F64(Math.cos(this.value)); }
  Log2(): F64 { return new F64(Math.log2(this.value)); }
  Round(): F64 { return new F64(goRound(this.value)); }
  Floor(): F64 { return new F64(Math.floor(this.value)); }
  Ceil(): F64 { return new F64(Math.ceil(this.value)); }

  Squared(): F64 { return this.Mul(this); }
  Cubed(): F64 { return this.Mul(this).Mul(this); }

  Sqrt(): F64 { return new F64(Math.sqrt(this.value)); }
  Cbrt(): F64 { return new F64(goCbrt(this.value)); }

  Add(b: F64): F64 { return new F64(this.value + b.value); }
  AddConst(b: number): F64 { return new F64(this.value + b); }
  Sub(b: F64): F64 { return new F64(this.value - b.value); }
  SubConst(b: number): F64 { return new F64(this.value - b); }
  Mul(b: F64): F64 { return new F64(this.value * b.value); }
  MulConst(b: number): F64 { return new F64(this.value * b); }
  Div(b: F64): F64 { return new F64(this.value / b.value); }
  DivConst(b: number): F64 { return new F64(this.value / b); }
  Pow(b: F64): F64 { return new F64(Math.pow(this.value, b.value)); }
  PowConst(b: number): F64 { return new F64(Math.pow(this.value, b)); }
  Atan2(b: F64): F64 { return new F64(Math.atan2(this.value, b.value)); }
  WithSignFrom(b: F64): F64 { return new F64(goCopysign(this.value, b.value)); }

  [Symbol.toPrimitive](): number { return this.value; }
}

/** Go: func NewF64(a float64) F64 */
export function NewF64(a: number): F64 {
  return new F64(a);
}

export function Min2(a: F64, b: F64): F64 { return new F64(Math.min(a.value, b.value)); }
export function Max2(a: F64, b: F64): F64 { return new F64(Math.max(a.value, b.value)); }
export function Min3(a: F64, b: F64, c: F64): F64 {
  return new F64(Math.min(Math.min(a.value, b.value), c.value));
}
export function Max3(a: F64, b: F64, c: F64): F64 {
  return new F64(Math.max(Math.max(a.value, b.value), c.value));
}
/** Go: func Lerp(a, b, t F64) F64 = b.Sub(a).Mul(t).Add(a) */
export function Lerp(a: F64, b: F64, t: F64): F64 {
  return b.Sub(a).Mul(t).Add(a);
}

/** Go math.Round：半值远离零；保留 -0；NaN/Inf 原样返回 */
function goRound(x: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  if (x === Math.trunc(x)) return x;
  return x < 0 ? -Math.floor(-x + 0.5) : Math.floor(x + 0.5);
}

/** Go math.Copysign：取 x 的绝对值、y 的符号（含 -0） */
function goCopysign(x: number, y: number): number {
  const negative = y < 0 || Object.is(y, -0);
  return negative ? -Math.abs(x) : Math.abs(x);
}

const dv = new DataView(new ArrayBuffer(8));
function float64bits(x: number): bigint {
  dv.setFloat64(0, x, false);
  return dv.getBigUint64(0, false);
}
function float64frombits(b: bigint): number {
  dv.setBigUint64(0, b, false);
  return dv.getFloat64(0, false);
}

/**
 * 逐行移植 Go math.Cbrt（fdlibm s_cbrt.c），保证与 Go 逐位一致。
 * 源码：/usr/local/go/src/math/cbrt.go
 */
function goCbrt(x: number): number {
  const B1 = 715094163n; // (682-0.03306235651)*2**20
  const B2 = 696219795n; // (664-0.03306235651)*2**20
  const C = 5.42857142857142815906e-01; // 19/35
  const D = -7.05306122448979611050e-01; // -864/1225
  const E = 1.41428571428571436819e+00; // 99/70
  const F = 1.60714285714285720630e+00; // 45/28
  const G = 3.57142857142857150787e-01; // 5/14
  const SmallestNormal = 2.22507385850720138309e-308; // 2**-1022

  if (x === 0 || Number.isNaN(x) || !Number.isFinite(x)) return x;

  let sign = false;
  if (x < 0) {
    x = -x;
    sign = true;
  }

  // rough cbrt to 5 bits
  let t = float64frombits(float64bits(x) / 3n + (B1 << 32n));
  if (x < SmallestNormal) {
    // subnormal number
    t = 2 ** 54;
    t *= x;
    t = float64frombits(float64bits(t) / 3n + (B2 << 32n));
  }

  // new cbrt to 23 bits
  let r = (t * t) / x;
  let s = C + r * t;
  t *= G + F / (s + E + D / s);

  // chop to 22 bits, make larger than cbrt(x)
  t = float64frombits((float64bits(t) & 0xffffffffcn << 28n) + (1n << 30n));

  // one step newton iteration to 53 bits with error less than 0.667ulps
  s = t * t; // t*t is exact
  r = x / s;
  const w = t + t;
  r = (r - t) / (w + r); // r-s is exact
  t = t + t * r;

  if (sign) t = -t;
  return t;
}
