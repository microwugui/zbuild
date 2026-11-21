// codePoint 哈希到 0~255 再 switch（case 内二次区分冲突桶）微基准。
// 用户方向 [40144]：针对 "Next() 大 switch 稀疏→V8 不给 jump table" 的病根，
// 先把稀疏 codePoint 压到 0~255 连续域，骗 V8 生成 jump table；
// 冲突桶（h=0x28 同时被 '(' 和 U+2028 命中）在 case 内用原始 codePoint 二次区分。
//
// 关键1：真实稀疏来自 0x2028/0x2029 离群 case 标签（byte 输入 0..255 装不下），
//   输入用解码后的 codePoint 数组（Int32Array），big 版 switch 真实写出稀疏标签。
// 关键2：真实 Next() 里 a-z/A-Z/0-9 都是显式 case 标签（js_lexer.ts:1307-1358,1407-1416），
//   哈希后正是这 98 个密集 case 让 V8 判据 (max-min<=3n) 成立 → jump table。
//   简化版必须同样显式列出字母数字 case，否则测不出 jump table 效果。
// 关键3：真实 lexer 中所有 >=0x80 codePoint 都是 identifier 字符；直接 hash 会把它们的
//   低 8 位撞进 ASCII 桶误判，故 hash 版前置按 identifier 扫描（"case 内区分"的必要成本）。
//
// 四版对照（同一套简化词法，token 直方图逐项相等才计数）：
//   A big    : switch(cp) 含 0x2028/0x2029 稀疏标签（= 真实写法，0 jump table）
//   B hash   : switch(cp&0xff) 密集域 jump table + 冲突桶二次区分（新方案）
//   C active : 顺序 if 热点排前（R8 已知最强写法，参照）
// 输出配对 ratio=big/variant（>1 为该版更快）+ bootstrap 95% CI（seed 固定）。
import { readFileSync } from 'node:fs';

const T = { EOF: 0, IDENT: 1, NUMBER: 2, PUNCT: 3, STRING: 4, OP: 5, NL: 6 };
const isIdentStart = (c) => (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || c === 0x5f || c === 0x24 || c >= 0x80;
const isIdentPart = (c) => isIdentStart(c) || (c >= 0x30 && c <= 0x39);
const isDigit = (c) => c >= 0x30 && c <= 0x39;
const isNL = (c) => c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;
const isWS = (c) => c === 0x09 || c === 0x20;

function decodeWithOutliers(path, inject) {
  const txt = readFileSync(path).toString('utf8');
  const cps = Array.from(txt, (ch) => ch.codePointAt(0));
  let injected = 0;
  if (inject) {
    for (let i = 0; i < cps.length; i += 4096) {
      let j = i; while (j < cps.length && !isNL(cps[j])) j++;
      if (j < cps.length) { cps[j] = (injected % 2 === 0) ? 0x2028 : 0x2029; injected++; }
    }
  }
  return { cps: Int32Array.from(cps), injected };
}

const LOWER = [0x61,0x62,0x63,0x64,0x65,0x66,0x67,0x68,0x69,0x6a,0x6b,0x6c,0x6d,0x6e,0x6f,0x70,0x71,0x72,0x73,0x74,0x75,0x76,0x77,0x78,0x79,0x7a];
const UPPER = [0x41,0x42,0x43,0x44,0x45,0x46,0x47,0x48,0x49,0x4a,0x4b,0x4c,0x4d,0x4e,0x4f,0x50,0x51,0x52,0x53,0x54,0x55,0x56,0x57,0x58,0x59,0x5a];
const DIGIT = [0x30,0x31,0x32,0x33,0x34,0x35,0x36,0x37,0x38,0x39];

// ============ A: 大 switch，显式字母数字 case + 稀疏 0x2028/0x2029（真实写法）============
function runBig(src) {
  const n = src.length; let i = 0; const h = new Array(7).fill(0);
  for (;;) {
    const c = i < n ? src[i] : -1;
    switch (c) {
      case -1: return h;
      case 0x0d: case 0x0a: case 0x2028: case 0x2029: i++; h[T.NL]++; continue;
      case 0x09: case 0x20: i++; continue;
      case 0x23: i++; h[T.OP]++; continue;
      case 0x28: case 0x29: case 0x5b: case 0x5d: case 0x7b: case 0x7d:
      case 0x2c: case 0x3a: case 0x3b: case 0x40: case 0x7e: i++; h[T.PUNCT]++; continue;
      case 0x3f: case 0x25: case 0x26: case 0x7c: case 0x5e: i++; if (i<n && src[i]===0x3d) i++; h[T.OP]++; continue;
      case 0x2b: case 0x2d: case 0x2a: case 0x3d: case 0x21: i++; if (i<n && (src[i]===0x3d || src[i]===c)) i++; h[T.OP]++; continue;
      case 0x2f: i++; h[T.OP]++; continue;
      case 0x22: case 0x27: { const q=c; i++; while(i<n){const d=src[i++]; if(d===q)break;} h[T.STRING]++; continue; }
      case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: case 0x35: case 0x36: case 0x37: case 0x38: case 0x39:
        i++; while(i<n && isDigit(src[i])) i++; h[T.NUMBER]++; continue;
      case 0x61: case 0x62: case 0x63: case 0x64: case 0x65: case 0x66: case 0x67: case 0x68: case 0x69:
      case 0x6a: case 0x6b: case 0x6c: case 0x6d: case 0x6e: case 0x6f: case 0x70: case 0x71: case 0x72:
      case 0x73: case 0x74: case 0x75: case 0x76: case 0x77: case 0x78: case 0x79: case 0x7a:
      case 0x41: case 0x42: case 0x43: case 0x44: case 0x45: case 0x46: case 0x47: case 0x48: case 0x49:
      case 0x4a: case 0x4b: case 0x4c: case 0x4d: case 0x4e: case 0x4f: case 0x50: case 0x51: case 0x52:
      case 0x53: case 0x54: case 0x55: case 0x56: case 0x57: case 0x58: case 0x59: case 0x5a:
      case 0x5f: case 0x24:
        i++; while(i<n && isIdentPart(src[i])) i++; h[T.IDENT]++; continue;
      default:
        if (isIdentStart(c)) { i++; while(i<n && isIdentPart(src[i])) i++; h[T.IDENT]++; continue; }
        i++; h[T.PUNCT]++; continue;
    }
  }
}

// ============ B: cp & 0xff → 密集 switch(jump table) + 冲突桶二次区分 ============
function runHash(src) {
  const n = src.length; let i = 0; const h = new Array(7).fill(0);
  for (;;) {
    const c = i < n ? src[i] : -1;
    if (c < 0) return h;
    // 区分成本1：>=0x80（除行分隔符）先按 identifier 扫描，否则低 8 位会撞进 ASCII 桶
    if (c >= 0x80 && c !== 0x2028 && c !== 0x2029) { i++; while(i<n && isIdentPart(src[i])) i++; h[T.IDENT]++; continue; }
    const key = c & 0xff;
    switch (key) {
      case 0x0d: case 0x0a: i++; h[T.NL]++; continue;
      case 0x28: // '('(0x28) 与 U+2028 冲突，二次区分
        if (c === 0x2028) { i++; h[T.NL]++; continue; }
        i++; h[T.PUNCT]++; continue;
      case 0x29: // ')' 与 U+2029 冲突，二次区分
        if (c === 0x2029) { i++; h[T.NL]++; continue; }
        i++; h[T.PUNCT]++; continue;
      case 0x09: case 0x20: i++; continue;
      case 0x23: i++; h[T.OP]++; continue;
      case 0x5b: case 0x5d: case 0x7b: case 0x7d: case 0x2c: case 0x3a: case 0x3b: case 0x40: case 0x7e: i++; h[T.PUNCT]++; continue;
      case 0x3f: case 0x25: case 0x26: case 0x7c: case 0x5e: i++; if (i<n && src[i]===0x3d) i++; h[T.OP]++; continue;
      case 0x2b: case 0x2d: case 0x2a: case 0x3d: case 0x21: i++; if (i<n && (src[i]===0x3d || src[i]===c)) i++; h[T.OP]++; continue;
      case 0x2f: i++; h[T.OP]++; continue;
      case 0x22: case 0x27: { const q=c; i++; while(i<n){const d=src[i++]; if(d===q)break;} h[T.STRING]++; continue; }
      case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: case 0x35: case 0x36: case 0x37: case 0x38: case 0x39:
        i++; while(i<n && isDigit(src[i])) i++; h[T.NUMBER]++; continue;
      case 0x61: case 0x62: case 0x63: case 0x64: case 0x65: case 0x66: case 0x67: case 0x68: case 0x69:
      case 0x6a: case 0x6b: case 0x6c: case 0x6d: case 0x6e: case 0x6f: case 0x70: case 0x71: case 0x72:
      case 0x73: case 0x74: case 0x75: case 0x76: case 0x77: case 0x78: case 0x79: case 0x7a:
      case 0x41: case 0x42: case 0x43: case 0x44: case 0x45: case 0x46: case 0x47: case 0x48: case 0x49:
      case 0x4a: case 0x4b: case 0x4c: case 0x4d: case 0x4e: case 0x4f: case 0x50: case 0x51: case 0x52:
      case 0x53: case 0x54: case 0x55: case 0x56: case 0x57: case 0x58: case 0x59: case 0x5a:
      case 0x5f: case 0x24:
        i++; while(i<n && isIdentPart(src[i])) i++; h[T.IDENT]++; continue;
      default: i++; h[T.PUNCT]++; continue;
    }
  }
}

// ============ C: 顺序 if（热点排前，参照）============
function runActive(src) {
  const n = src.length; let i = 0; const h = new Array(7).fill(0);
  for (;;) {
    if (i >= n) return h;
    const c = src[i];
    if (isWS(c)) { i++; continue; }
    if (isNL(c)) { i++; h[T.NL]++; continue; }
    if (isIdentStart(c)) { i++; while (i<n && isIdentPart(src[i])) i++; h[T.IDENT]++; continue; }
    if (isDigit(c)) { i++; while (i<n && isDigit(src[i])) i++; h[T.NUMBER]++; continue; }
    if (c===0x28||c===0x29||c===0x5b||c===0x5d||c===0x7b||c===0x7d||c===0x2c||c===0x3a||c===0x3b||c===0x40||c===0x7e) { i++; h[T.PUNCT]++; continue; }
    if (c===0x3f||c===0x25||c===0x26||c===0x7c||c===0x5e) { i++; if(i<n&&src[i]===0x3d)i++; h[T.OP]++; continue; }
    if (c===0x2b||c===0x2d||c===0x2a||c===0x3d||c===0x21) { const q=c; i++; if(i<n&&(src[i]===0x3d||src[i]===q))i++; h[T.OP]++; continue; }
    if (c===0x2f) { i++; h[T.OP]++; continue; }
    if (c===0x23) { i++; h[T.OP]++; continue; }
    if (c===0x22||c===0x27) { const q=c; i++; while(i<n){const d=src[i++]; if(d===q)break;} h[T.STRING]++; continue; }
    i++; h[T.PUNCT]++;
  }
}

// ============ 测量框架 ============
let sink = 0;
const sum = (h) => h.reduce((a, b) => a + b, 0);
function time(fn, src, reps) { const t0 = performance.now(); for (let k=0;k<reps;k++) sink += sum(fn(src)); return performance.now() - t0; }
function median(a) { const s=[...a].sort((x,y)=>x-y); const m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2; }
let seed = 20261121;
function rnd() { seed=(seed*1103515245+12345)&0x7fffffff; return seed/0x80000000; }
function bootRatioCI(base, variant, iters=2000) {
  const n=base.length, rs=[];
  for(let k=0;k<iters;k++){let a=0,b=0;for(let j=0;j<n;j++){const idx=(rnd()*n)|0;a+=base[idx];b+=variant[idx];}rs.push(a/b);}
  rs.sort((x,y)=>x-y);
  return [+rs[(iters*0.025)|0].toFixed(3), +rs[(iters*0.975)|0].toFixed(3)];
}
const variants = [['big', runBig], ['hash', runHash], ['active', runActive]];
const N = 8;
const inject = process.argv.includes('--inject');
const paths = process.argv.slice(2).filter((a) => a !== '--inject');
for (const path of paths) {
  const { cps, injected } = decodeWithOutliers(path, inject);
  const hs = variants.map(([, f]) => f(cps));
  const equal = hs.every((h) => h.every((v, i) => v === hs[0][i]));
  if (!equal) { console.log(JSON.stringify({ path, equal, hs, injected })); continue; }
  const slowest = Math.max(...variants.map(([, f]) => time(f, cps, 1)));
  const reps = Math.max(1, Math.round(120 / slowest));
  for (let i=0;i<3;i++) for (const [,f] of variants) f(cps);
  if (global.gc) global.gc();
  const samples = {}; for (const [name] of variants) samples[name]=[];
  for (let k=0;k<N;k++){ const order = k%2===0?variants:[...variants].reverse(); for(const [name,f] of order) samples[name].push(time(f,cps,reps)); }
  const med={}, nsTok={};
  for (const [name] of variants){ med[name]=median(samples[name]); nsTok[name]=+(med[name]*1e6/(reps*sum(hs[0]))).toFixed(1); }
  const ratioVsBig={};
  for (const [name] of variants){ if(name==='big')continue; ratioVsBig[name]={median:+(med.big/med[name]).toFixed(3), ci95:bootRatioCI(samples.big,samples[name])}; }
  console.log(JSON.stringify({ path, cps:cps.length, tokens:sum(hs[0]), equal, injected, reps,
    medMs:Object.fromEntries(Object.entries(med).map(([k,v])=>[k,+v.toFixed(1)])), nsPerTok:nsTok, ratioVsBig }));
}
void sink;
