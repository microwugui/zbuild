// 被动 lexer vs 主动 lexer：写法对比微基准（非完整实现）。
// 同一套简化词法规则；正确性 = 两版 token 直方图逐项相等。
// 被动版：driver 每次调 Next() 取一个 token（对齐 esbuild TS 移植现状）。
// 主动版：一个大 while 循环就地扫描（无逐 token 方法调用，状态用局部变量）。
import { readFileSync, statSync } from 'node:fs';

const T = { EOF: 0, IDENT: 1, NUMBER: 2, PUNCT: 3, STRING: 4 };
const isIdentStart = (c) => (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || c === 0x5f || c === 0x24 || c >= 0x80;
const isIdentPart = (c) => isIdentStart(c) || (c >= 0x30 && c <= 0x39);
const isDigit = (c) => c >= 0x30 && c <= 0x39;
const isWS = (c) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

// ---------- 被动：Next() 方法，每次出一 token ----------
class PassiveLexer {
  constructor(src) { this.src = src; this.n = src.length; this.current = 0; this.start = 0; this.token = T.EOF; this.hasNewline = false; }
  Next() {
    this.hasNewline = false; // 对齐真实 lexer 每次调用的字段重置
    const src = this.src, n = this.n;
    for (;;) {
      this.start = this.current;
      if (this.current >= n) { this.token = T.EOF; return; }
      const c = src[this.current];
      if (isWS(c)) { this.current++; if (c === 0x0a) this.hasNewline = true; continue; }
      if (isIdentStart(c)) {
        this.current++;
        while (this.current < n && isIdentPart(src[this.current])) this.current++;
        this.token = T.IDENT; return;
      }
      if (isDigit(c)) {
        this.current++;
        while (this.current < n && isDigit(src[this.current])) this.current++;
        this.token = T.NUMBER; return;
      }
      if (c === 0x22 || c === 0x27) {
        const q = c; this.current++;
        while (this.current < n) {
          const d = src[this.current++];
          if (d === q) break;
          if (d === 0x5c && this.current < n) this.current++;
        }
        this.token = T.STRING; return;
      }
      if (c === 0x2f && src[this.current + 1] === 0x2f) {
        this.current += 2;
        while (this.current < n && src[this.current] !== 0x0a) this.current++;
        continue;
      }
      if (c === 0x2f && src[this.current + 1] === 0x2a) {
        this.current += 2;
        while (this.current + 1 < n && !(src[this.current] === 0x2a && src[this.current + 1] === 0x2f)) this.current++;
        this.current = Math.min(this.current + 2, n); continue;
      }
      this.current++; this.token = T.PUNCT; return;
    }
  }
}
function runPassive(src) {
  const lx = new PassiveLexer(src);
  const h = [0, 0, 0, 0, 0];
  for (;;) { lx.Next(); if (lx.token === T.EOF) break; h[lx.token]++; }
  return h;
}

// ---------- 主动：一个大 while，局部状态，无逐 token 方法调用 ----------
function runActive(src) {
  const n = src.length;
  let current = 0, hasNewline = false;
  const h = [0, 0, 0, 0, 0];
  for (;;) {
    if (current >= n) break;
    const c = src[current];
    if (isWS(c)) { current++; if (c === 0x0a) hasNewline = true; continue; }
    if (isIdentStart(c)) {
      current++;
      while (current < n && isIdentPart(src[current])) current++;
      h[T.IDENT]++; continue;
    }
    if (isDigit(c)) {
      current++;
      while (current < n && isDigit(src[current])) current++;
      h[T.NUMBER]++; continue;
    }
    if (c === 0x22 || c === 0x27) {
      const q = c; current++;
      while (current < n) {
        const d = src[current++];
        if (d === q) break;
        if (d === 0x5c && current < n) current++;
      }
      h[T.STRING]++; continue;
    }
    if (c === 0x2f && src[current + 1] === 0x2f) {
      current += 2;
      while (current < n && src[current] !== 0x0a) current++;
      continue;
    }
    if (c === 0x2f && src[current + 1] === 0x2a) {
      current += 2;
      while (current + 1 < n && !(src[current] === 0x2a && src[current + 1] === 0x2f)) current++;
      current = Math.min(current + 2, n); continue;
    }
    current++; h[T.PUNCT]++;
  }
  if (hasNewline) h[T.EOF] += 0; // 保持与被动版等价的状态写入，避免被 DCE
  return h;
}

let sink = 0;
function sum(h) { return h[0] + h[1] + h[2] + h[3] + h[4]; }
function time(fn, src, reps) {
  const t0 = performance.now();
  for (let i = 0; i < reps; i++) sink += sum(fn(src));
  return performance.now() - t0;
}
function median(a) { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

const inputs = process.argv.slice(2);
const N = 8;
for (const path of inputs) {
  const src = new Uint8Array(readFileSync(path));
  // 正确性：两版 token 直方图逐项相等
  const hp = runPassive(src), ha = runActive(src);
  const equal = hp.every((v, i) => v === ha[i]);
  if (!equal) { console.log(JSON.stringify({ path, equal, hp, ha })); continue; }

  // 自适应 reps：让单次测量落在 ~120ms，避免太小被噪声淹没
  const oneP = time(runPassive, src, 1);
  const oneA = time(runActive, src, 1);
  const reps = Math.max(1, Math.round(120 / Math.max(oneP, oneA)));

  // 预热
  for (let i = 0; i < 3; i++) { runPassive(src); runActive(src); }
  if (global.gc) global.gc();

  const ratios = [];
  const pms = [], ams = [];
  for (let i = 0; i < N; i++) {
    let p, a;
    if (i % 2 === 0) { p = time(runPassive, src, reps); a = time(runActive, src, reps); }
    else { a = time(runActive, src, reps); p = time(runPassive, src, reps); }
    pms.push(p); ams.push(a); ratios.push(p / a);
  }
  const toks = sum(hp);
  console.log(JSON.stringify({
    path, bytes: src.length, tokens: toks, equal,
    reps, onePassiveMs: +oneP.toFixed(2), oneActiveMs: +oneA.toFixed(2),
    passiveMedianMs: +median(pms).toFixed(1), activeMedianMs: +median(ams).toFixed(1),
    speedup_passive_over_active: +median(ratios).toFixed(3),
    ratios: ratios.map(r => +r.toFixed(3)),
    nsPerToken_passive: +(median(pms) * 1e6 / (reps * toks)).toFixed(1),
    nsPerToken_active: +(median(ams) * 1e6 / (reps * toks)).toFixed(1),
  }));
}
void sink;
