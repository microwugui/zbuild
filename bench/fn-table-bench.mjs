// 函数指针表 + ASCII 查表索引微基准（Next() 巨型 switch 的候选优化）。
// 调研 bench/switch-opt-research.md §2/§4 判读的下一张卡：
//   社区 opcode 场景（0-255 连续）函数表 25×；但本项目 codePoint 稀疏、token 分布
//   极度倾斜（ws/标点/标识符占绝大多数），查表 + 间接调用在 V8 里可能 megamorphic
//   无法内联——必须量出来，不能套用社区结论。
// 四版对照（同一套简化词法规则，token 直方图逐项相等才计数）：
//   A big    : 单一 Next() 内含稀疏 codePoint 大 switch（= 真实写法 / split-bench 的 A）
//   B table  : 128 项 Uint8Array 把 ASCII cp 映射到槽位，函数指针数组按槽位直跳（新假设）
//   C hotif  : Next() 内顺序 if，热点(ws/ident)排前（调研 §3 判读的"真实原因"候选）
//   D active : 一个大 while 就地扫描、局部状态（R8 已测最强写法，参照）
// 输出配对 ratio（big/variant，>1 = 该版比 big 快）+ bootstrap 95% CI。
import { readFileSync } from 'node:fs';

const T = { EOF: 0, IDENT: 1, NUMBER: 2, PUNCT: 3, STRING: 4, OP: 5, HASH: 6 };
const isIdentStart = (c) => (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || c === 0x5f || c === 0x24 || c >= 0x80;
const isIdentPart = (c) => isIdentStart(c) || (c >= 0x30 && c <= 0x39);
const isDigit = (c) => c >= 0x30 && c <= 0x39;

// ============ A: 大 switch（基线，= 真实 Next() 写法）============
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

// ============ B: 128 项 ASCII 查表 + 函数指针数组 ============
// slot 0=PUNCT 是默认值（未列出的 ASCII 全落这里，对齐 A 的 default 分支 PUNCT）
const SL = { PUNCT: 0, NL: 1, SP: 2, HASH: 3, OPQ: 4, OP: 5, SLASH: 6, STR: 7, NUM: 8, IDENT: 9, COUNT: 10 };
const slotOf = new Uint8Array(128);
slotOf[0x0a] = SL.NL; slotOf[0x0d] = SL.NL;
slotOf[0x09] = SL.SP; slotOf[0x20] = SL.SP;
slotOf[0x23] = SL.HASH;
for (const c of [0x3f, 0x25, 0x26, 0x7c, 0x5e]) slotOf[c] = SL.OPQ;
for (const c of [0x2b, 0x2d, 0x2a, 0x3d, 0x21]) slotOf[c] = SL.OP;
slotOf[0x2f] = SL.SLASH;
slotOf[0x22] = SL.STR; slotOf[0x27] = SL.STR;
for (let c = 0x30; c <= 0x39; c++) slotOf[c] = SL.NUM;
for (let c = 0x61; c <= 0x7a; c++) slotOf[c] = SL.IDENT;
for (let c = 0x41; c <= 0x5a; c++) slotOf[c] = SL.IDENT;
slotOf[0x5f] = SL.IDENT; slotOf[0x24] = SL.IDENT;
// >=0x80 字节在 dispatch 处直接映射 IDENT（A 里 isIdentStart(c>=0x80) 为真）
// handler(lx, c) -> t：0 = 跳过继续循环，非 0 = token
function hPunct(lx) { lx.i++; return T.PUNCT; }
function hNL(lx) { lx.i++; lx.nl = true; return 0; }
function hSP(lx) { lx.i++; return 0; }
function hHash(lx) { lx.i++; return T.HASH; }
function hOPQ(lx) { const src = lx.src, n = lx.n; lx.i++; if (lx.i < n && src[lx.i] === 0x3d) lx.i++; return T.OP; }
function hOP(lx, c) { const src = lx.src, n = lx.n; lx.i++; if (lx.i < n && (src[lx.i] === 0x3d || src[lx.i] === c)) lx.i++; return T.OP; }
function hSlash(lx) {
  const src = lx.src, n = lx.n;
  if (lx.i + 1 < n && src[lx.i + 1] === 0x2f) { lx.i += 2; while (lx.i < n && src[lx.i] !== 0x0a) lx.i++; return 0; }
  if (lx.i + 1 < n && src[lx.i + 1] === 0x2a) { lx.i += 2; while (lx.i + 1 < n && !(src[lx.i] === 0x2a && src[lx.i + 1] === 0x2f)) lx.i++; lx.i = Math.min(lx.i + 2, n); return 0; }
  lx.i++; return T.OP;
}
function hStr(lx, c) { const src = lx.src, n = lx.n, q = c; lx.i++; while (lx.i < n) { const d = src[lx.i++]; if (d === q) break; if (d === 0x5c && lx.i < n) lx.i++; } return T.STRING; }
function hNum(lx) { const src = lx.src, n = lx.n; lx.i++; while (lx.i < n && isDigit(src[lx.i])) lx.i++; return T.NUMBER; }
function hIdent(lx) { const src = lx.src, n = lx.n; lx.i++; while (lx.i < n && isIdentPart(src[lx.i])) lx.i++; return T.IDENT; }
const HANDLERS = [hPunct, hNL, hSP, hHash, hOPQ, hOP, hSlash, hStr, hNum, hIdent];

class TableLexer {
  constructor(src) { this.src = src; this.n = src.length; this.i = 0; this.tok = 0; this.nl = false; }
  Next() {
    const src = this.src, n = this.n;
    this.nl = false;
    for (;;) {
      const c = this.i < n ? src[this.i] : -1;
      if (c < 0) { this.tok = T.EOF; return; }
      const slot = c < 128 ? slotOf[c] : SL.IDENT;
      const t = HANDLERS[slot](this, c);
      if (t !== 0) { this.tok = t; return; }
    }
  }
}
function runTable(src) {
  const lx = new TableLexer(src), h = new Array(7).fill(0);
  for (;;) { lx.Next(); if (lx.tok === T.EOF) break; h[lx.tok]++; }
  return h;
}

// ============ C: 顺序 if，热点排前（Next() 方法，无拆函数）============
class HotIfLexer {
  constructor(src) { this.src = src; this.n = src.length; this.i = 0; this.tok = 0; this.nl = false; }
  Next() {
    const src = this.src, n = this.n;
    this.nl = false;
    for (;;) {
      const c = this.i < n ? src[this.i] : -1;
      if (c < 0) { this.tok = T.EOF; return; }
      // 热点优先：空白（覆盖 65.8 万次）与标识符（18 万）
      if (c === 0x09 || c === 0x20) { this.i++; continue; }
      if (c === 0x0a || c === 0x0d) { this.i++; this.nl = true; continue; }
      if (isIdentStart(c)) { this.i++; while (this.i < n && isIdentPart(src[this.i])) this.i++; this.tok = T.IDENT; return; }
      if (isDigit(c)) { this.i++; while (this.i < n && isDigit(src[this.i])) this.i++; this.tok = T.NUMBER; return; }
      // 标点/操作符（49.5 万次）
      if (c === 0x28 || c === 0x29 || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d ||
          c === 0x2c || c === 0x3a || c === 0x3b || c === 0x40 || c === 0x7e) { this.i++; this.tok = T.PUNCT; return; }
      if (c === 0x23) { this.i++; this.tok = T.HASH; return; }
      if (c === 0x3f || c === 0x25 || c === 0x26 || c === 0x7c || c === 0x5e) { this.i++; if (this.i < n && src[this.i] === 0x3d) this.i++; this.tok = T.OP; return; }
      if (c === 0x2b || c === 0x2d || c === 0x2a || c === 0x3d || c === 0x21) { const q = c; this.i++; if (this.i < n && (src[this.i] === 0x3d || src[this.i] === q)) this.i++; this.tok = T.OP; return; }
      if (c === 0x2f) {
        if (this.i + 1 < n && src[this.i + 1] === 0x2f) { this.i += 2; while (this.i < n && src[this.i] !== 0x0a) this.i++; continue; }
        if (this.i + 1 < n && src[this.i + 1] === 0x2a) { this.i += 2; while (this.i + 1 < n && !(src[this.i] === 0x2a && src[this.i + 1] === 0x2f)) this.i++; this.i = Math.min(this.i + 2, n); continue; }
        this.i++; this.tok = T.OP; return;
      }
      if (c === 0x22 || c === 0x27) { const q = c; this.i++; while (this.i < n) { const d = src[this.i++]; if (d === q) break; if (d === 0x5c && this.i < n) this.i++; } this.tok = T.STRING; return; }
      this.i++; this.tok = T.PUNCT; return;
    }
  }
}
function runHotIf(src) {
  const lx = new HotIfLexer(src), h = new Array(7).fill(0);
  for (;;) { lx.Next(); if (lx.tok === T.EOF) break; h[lx.tok]++; }
  return h;
}

// ============ D: 主动 while（局部状态，R8 参照）============
function runActive(src) {
  const n = src.length; let i = 0, nl = false; const h = new Array(7).fill(0);
  for (;;) {
    if (i >= n) break;
    const c = src[i];
    if (c === 0x09 || c === 0x20) { i++; continue; }
    if (c === 0x0a || c === 0x0d) { i++; nl = true; continue; }
    if (isIdentStart(c)) { i++; while (i < n && isIdentPart(src[i])) i++; h[T.IDENT]++; continue; }
    if (isDigit(c)) { i++; while (i < n && isDigit(src[i])) i++; h[T.NUMBER]++; continue; }
    if (c === 0x28 || c === 0x29 || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d ||
        c === 0x2c || c === 0x3a || c === 0x3b || c === 0x40 || c === 0x7e) { i++; h[T.PUNCT]++; continue; }
    if (c === 0x23) { i++; h[T.HASH]++; continue; }
    if (c === 0x3f || c === 0x25 || c === 0x26 || c === 0x7c || c === 0x5e) { i++; if (i < n && src[i] === 0x3d) i++; h[T.OP]++; continue; }
    if (c === 0x2b || c === 0x2d || c === 0x2a || c === 0x3d || c === 0x21) { const q = c; i++; if (i < n && (src[i] === 0x3d || src[i] === q)) i++; h[T.OP]++; continue; }
    if (c === 0x2f) {
      if (i + 1 < n && src[i + 1] === 0x2f) { i += 2; while (i < n && src[i] !== 0x0a) i++; continue; }
      if (i + 1 < n && src[i + 1] === 0x2a) { i += 2; while (i + 1 < n && !(src[i] === 0x2a && src[i + 1] === 0x2f)) i++; i = Math.min(i + 2, n); continue; }
      i++; h[T.OP]++; continue;
    }
    if (c === 0x22 || c === 0x27) { const q = c; i++; while (i < n) { const d = src[i++]; if (d === q) break; if (d === 0x5c && i < n) i++; } h[T.STRING]++; continue; }
    i++; h[T.PUNCT]++;
  }
  if (nl) h[T.EOF] += 0;
  return h;
}

// ============ 测量框架 ============
let sink = 0;
const sum = (h) => h.reduce((a, b) => a + b, 0);
function time(fn, src, reps) { const t0 = performance.now(); for (let i = 0; i < reps; i++) sink += sum(fn(src)); return performance.now() - t0; }
function median(a) { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
// 可复现的伪随机（bootstrap CI 固定 seed）
let seed = 20261121;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; }
function bootRatioCI(base, variant, iters = 2000) {
  const n = base.length, rs = [];
  for (let k = 0; k < iters; k++) {
    let a = 0, b = 0;
    for (let j = 0; j < n; j++) { const idx = (rnd() * n) | 0; a += base[idx]; b += variant[idx]; }
    rs.push(a / b);
  }
  rs.sort((x, y) => x - y);
  return [+rs[(iters * 0.025) | 0].toFixed(3), +rs[(iters * 0.975) | 0].toFixed(3)];
}

const variants = [['big', runBig], ['table', runTable], ['hotif', runHotIf], ['active', runActive]];
const N = 8;
for (const path of process.argv.slice(2)) {
  const src = new Uint8Array(readFileSync(path));
  const hs = variants.map(([, f]) => f(src));
  const equal = hs.every((h) => h.every((v, i) => v === hs[0][i]));
  if (!equal) { console.log(JSON.stringify({ path, equal, hs })); continue; }
  const slowest = Math.max(...variants.map(([, f]) => time(f, src, 1)));
  const reps = Math.max(1, Math.round(120 / slowest));
  for (let i = 0; i < 3; i++) for (const [, f] of variants) f(src);
  if (global.gc) global.gc();
  const samples = {};
  for (const [name] of variants) samples[name] = [];
  for (let k = 0; k < N; k++) {
    // 正/反序交替，抵消系统性漂移
    const order = k % 2 === 0 ? variants : [...variants].reverse();
    for (const [name, f] of order) samples[name].push(time(f, src, reps));
  }
  const med = {}, nsTok = {};
  for (const [name] of variants) {
    med[name] = median(samples[name]);
    nsTok[name] = +(med[name] * 1e6 / (reps * sum(hs[0]))).toFixed(1);
  }
  const ratioVsBig = {};
  for (const [name] of variants) {
    if (name === 'big') continue;
    ratioVsBig[name] = {
      median: +(med.big / med[name]).toFixed(3),
      ci95: bootRatioCI(samples.big, samples[name]),
    };
  }
  console.log(JSON.stringify({
    path, bytes: src.length, tokens: sum(hs[0]), equal, reps,
    medMs: Object.fromEntries(Object.entries(med).map(([k, v]) => [k, +v.toFixed(1)])),
    nsPerTok: nsTok,
    ratioVsBig, // >1 = 该版比 big 快；ci95 不含 1 才算显著
  }));
}
void sink;
