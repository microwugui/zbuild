// Next() 裁剪假设微基准：把巨型 switch 的每个分支搬成独立小函数，
// 让 V8 对热分支自适应内联、冷分支保持调用，同时缩小 Next 主体体积。
// 对照 A(bigSwitch)：单一 Next() 内含稀疏 codePoint 大 switch（= 真实写法）。
// 对照 B(splitFns) ：Next() 只做 dispatch，每分支调独立小函数。
// 对照 C(active)   ：一个大 while（R8 已测，作参照）。
// 正确性 = 三版 token 直方图逐项相等。
import { readFileSync } from 'node:fs';

const T = { EOF: 0, IDENT: 1, NUMBER: 2, STRING: 3, PUNCT: 4, OP: 5, HASH: 6 };
const isIdentStart = (c) => (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || c === 0x5f || c === 0x24 || c >= 0x80;
const isIdentPart = (c) => isIdentStart(c) || (c >= 0x30 && c <= 0x39);
const isDigit = (c) => c >= 0x30 && c <= 0x39;

// ============ A: 大 switch（基线）============
class BigSwitchLexer {
  constructor(src) { this.src = src; this.n = src.length; this.i = 0; this.tok = 0; this.nl = false; }
  Next() {
    const src = this.src, n = this.n;
    this.nl = false;
    for (;;) {
      const c = this.i < n ? src[this.i] : -1;
      switch (c) {
        case -1: this.tok = T.EOF; return;
        case 0x0d: case 0x0a: this.i++; this.nl = true; continue;
        case 0x09: case 0x20: this.i++; continue;
        case 0x23: this.i++; this.tok = T.HASH; return;
        case 0x28: case 0x29: case 0x5b: case 0x5d: case 0x7b: case 0x7d:
          this.i++; this.tok = T.PUNCT; return;
        case 0x2c: case 0x3a: case 0x3b: case 0x40: case 0x7e:
          this.i++; this.tok = T.PUNCT; return;
        case 0x3f: case 0x25: case 0x26: case 0x7c: case 0x5e:
          this.i++; if (this.i < n && src[this.i] === 0x3d) this.i++; this.tok = T.OP; return;
        case 0x2b: case 0x2d: case 0x2a: case 0x3d: case 0x21:
          this.i++; if (this.i < n && (src[this.i] === 0x3d || src[this.i] === c)) this.i++;
          this.tok = T.OP; return;
        case 0x2f:
          if (this.i + 1 < n && src[this.i + 1] === 0x2f) { this.i += 2; while (this.i < n && src[this.i] !== 0x0a) this.i++; continue; }
          if (this.i + 1 < n && src[this.i + 1] === 0x2a) { this.i += 2; while (this.i + 1 < n && !(src[this.i] === 0x2a && src[this.i + 1] === 0x2f)) this.i++; this.i = Math.min(this.i + 2, n); continue; }
          this.i++; this.tok = T.OP; return;
        case 0x22: case 0x27: {
          const q = c; this.i++;
          while (this.i < n) { const d = src[this.i++]; if (d === q) break; if (d === 0x5c && this.i < n) this.i++; }
          this.tok = T.STRING; return;
        }
        default:
          if (isDigit(c)) { this.i++; while (this.i < n && isDigit(src[this.i])) this.i++; this.tok = T.NUMBER; return; }
          if (isIdentStart(c)) { this.i++; while (this.i < n && isIdentPart(src[this.i])) this.i++; this.tok = T.IDENT; return; }
          this.i++; this.tok = T.PUNCT; return;
      }
    }
  }
}
function runBig(src) {
  const lx = new BigSwitchLexer(src), h = new Array(7).fill(0);
  for (;;) { lx.Next(); if (lx.tok === T.EOF) break; h[lx.tok]++; }
  return h;
}

// ============ B: 分支搬成独立小函数 ============
class SplitLexer {
  constructor(src) { this.src = src; this.n = src.length; this.i = 0; this.tok = 0; this.nl = false; }
  hWS() { this.i++; this.nl = true; }
  hSpace() { this.i++; }
  hHash() { this.i++; return T.HASH; }
  hPunct() { this.i++; return T.PUNCT; }
  hOp() { const src = this.src, n = this.n, c = src[this.i]; this.i++; if (this.i < n && (src[this.i] === 0x3d || src[this.i] === c)) this.i++; return T.OP; }
  hQ() { const src = this.src, n = this.n; this.i++; if (this.i < n && src[this.i] === 0x3d) this.i++; return T.OP; }
  hSlash() {
    const src = this.src, n = this.n;
    if (this.i + 1 < n && src[this.i + 1] === 0x2f) { this.i += 2; while (this.i < n && src[this.i] !== 0x0a) this.i++; return 0; }
    if (this.i + 1 < n && src[this.i + 1] === 0x2a) { this.i += 2; while (this.i + 1 < n && !(src[this.i] === 0x2a && src[this.i + 1] === 0x2f)) this.i++; this.i = Math.min(this.i + 2, n); return 0; }
    this.i++; return T.OP;
  }
  hString(q) { const src = this.src, n = this.n; this.i++; while (this.i < n) { const d = src[this.i++]; if (d === q) break; if (d === 0x5c && this.i < n) this.i++; } return T.STRING; }
  hIdent() { const src = this.src, n = this.n; this.i++; while (this.i < n && isIdentPart(src[this.i])) this.i++; return T.IDENT; }
  hNumber() { const src = this.src, n = this.n; this.i++; while (this.i < n && isDigit(src[this.i])) this.i++; return T.NUMBER; }
  Next() {
    const src = this.src, n = this.n;
    this.nl = false;
    for (;;) {
      const c = this.i < n ? src[this.i] : -1;
      if (c === -1) { this.tok = T.EOF; return; }
      if (c === 0x0d || c === 0x0a) { this.hWS(); continue; }
      if (c === 0x09 || c === 0x20) { this.hSpace(); continue; }
      let t = 0;
      if (c === 0x23) t = this.hHash();
      else if (c === 0x28 || c === 0x29 || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d ||
               c === 0x2c || c === 0x3a || c === 0x3b || c === 0x40 || c === 0x7e) t = this.hPunct();
      else if (c === 0x3f || c === 0x25 || c === 0x26 || c === 0x7c || c === 0x5e) t = this.hQ();
      else if (c === 0x2b || c === 0x2d || c === 0x2a || c === 0x3d || c === 0x21) t = this.hOp();
      else if (c === 0x2f) t = this.hSlash();
      else if (c === 0x22 || c === 0x27) t = this.hString(c);
      else if (isDigit(c)) t = this.hNumber();
      else if (isIdentStart(c)) t = this.hIdent();
      else { this.i++; t = T.PUNCT; }
      if (t !== 0) { this.tok = t; return; }
      // t===0 表示跳过（注释），继续循环
    }
  }
}
function runSplit(src) {
  const lx = new SplitLexer(src), h = new Array(7).fill(0);
  for (;;) { lx.Next(); if (lx.tok === T.EOF) break; h[lx.tok]++; }
  return h;
}

// ============ C: 主动 while（参照）============
function runActive(src) {
  const n = src.length; let i = 0, nl = false; const h = new Array(7).fill(0);
  for (;;) {
    if (i >= n) break;
    const c = src[i];
    if (c === 0x0d || c === 0x0a) { i++; nl = true; continue; }
    if (c === 0x09 || c === 0x20) { i++; continue; }
    if (c === 0x23) { i++; h[T.HASH]++; continue; }
    if (c === 0x28 || c === 0x29 || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d ||
        c === 0x2c || c === 0x3a || c === 0x3b || c === 0x40 || c === 0x7e) { i++; h[T.PUNCT]++; continue; }
    if (c === 0x3f || c === 0x25 || c === 0x26 || c === 0x7c || c === 0x5e) { i++; if (i < n && src[i] === 0x3d) i++; h[T.OP]++; continue; }
    if (c === 0x2b || c === 0x2d || c === 0x2a || c === 0x3d || c === 0x21) { const q = c; i++; if (i < n && (src[i] === 0x3d || src[i] === q)) i++; h[T.OP]++; continue; }
    if (c === 0x2f) {
      if (i + 1 < n && src[i + 1] === 0x2f) { i += 2; while (i < n && src[i] !== 0x0a) i++; continue; }
      if (i + 1 < n && src[i + 1] === 0x2a) { i += 2; while (i + 1 < n && !(src[i] === 0x2a && src[i + 1] === 0x2f)) i++; i = Math.min(i + 2, n); continue; }
      i++; h[T.OP]++; continue;
    }
    if (c === 0x22 || c === 0x27) { const q = c; i++; while (i < n) { const d = src[i++]; if (d === q) break; if (d === 0x5c && i < n) i++; } h[T.STRING]++; continue; }
    if (isDigit(c)) { i++; while (i < n && isDigit(src[i])) i++; h[T.NUMBER]++; continue; }
    if (isIdentStart(c)) { i++; while (i < n && isIdentPart(src[i])) i++; h[T.IDENT]++; continue; }
    i++; h[T.PUNCT]++;
  }
  if (nl) h[T.EOF] += 0;
  return h;
}

let sink = 0;
const sum = (h) => h.reduce((a, b) => a + b, 0);
function time(fn, src, reps) { const t0 = performance.now(); for (let i = 0; i < reps; i++) sink += sum(fn(src)); return performance.now() - t0; }
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

const variants = [['big', runBig], ['split', runSplit], ['active', runActive]];
for (const path of process.argv.slice(2)) {
  const src = new Uint8Array(readFileSync(path));
  const hs = variants.map(([, f]) => f(src));
  const equal = hs.every((h) => h.every((v, i) => v === hs[0][i]));
  if (!equal) { console.log(JSON.stringify({ path, equal, hs })); continue; }
  const reps = Math.max(1, Math.round(120 / Math.max(...variants.map(([, f]) => time(f, src, 1)))));
  for (let i = 0; i < 3; i++) for (const [, f] of variants) f(src);
  if (global.gc) global.gc();
  const med = {};
  for (const [name, f] of variants) { const ts = []; for (let k = 0; k < 8; k++) ts.push(time(f, src, reps)); med[name] = median(ts); }
  console.log(JSON.stringify({
    path, bytes: src.length, tokens: sum(hs[0]), equal, reps,
    bigMs: +med.big.toFixed(1), splitMs: +med.split.toFixed(1), activeMs: +med.active.toFixed(1),
    big_over_split: +(med.big / med.split).toFixed(3),
    big_over_active: +(med.big / med.active).toFixed(3),
    nsPerTok: { big: +(med.big * 1e6 / (reps * sum(hs[0]))).toFixed(1), split: +(med.split * 1e6 / (reps * sum(hs[0]))).toFixed(1), active: +(med.active * 1e6 / (reps * sum(hs[0]))).toFixed(1) },
  }));
}
void sink;
