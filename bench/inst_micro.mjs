// Cold-process microbenchmark: instanceof chain vs numeric-kind dispatch.
// Usage: node inst_micro.mjs <mode>   mode = inst | kind | switch
const mode = process.argv[2] || 'inst';
const N = Number(process.argv[3] || 200000);

const CLASSES = 73;
const bases = [];
for (let i = 0; i < CLASSES; i++) {
  bases.push(class {
    constructor(k) { this._kind = k; }
  });
}
// weighted distribution: a few hot kinds dominate
const hot = [19, 29, 25, 1, 7, 8, 27, 13, 14, 18]; // EIdentifier/EString/ENumber/EArray/ENull/...
const nodes = new Array(N);
for (let i = 0; i < N; i++) {
  const k = i % 3 === 0 ? hot[(i * 7) % hot.length] : (i % CLASSES);
  nodes[i] = new bases[k](k);
}

let sink = 0;
const t0 = performance.now();
for (let i = 0; i < N; i++) {
  const e = nodes[i];
  if (mode === 'inst') {
    let found = 0;
    for (let c = 0; c < CLASSES; c++) {
      if (e instanceof bases[c]) { found = c + 1; break; }
    }
    sink += found;
  } else if (mode === 'kind') {
    let found = 0;
    for (let c = 0; c < CLASSES; c++) {
      if (e._kind === c) { found = c + 1; break; }
    }
    sink += found;
  } else {
    switch (e._kind) {
      case 19: sink += 1; break;
      case 29: sink += 2; break;
      case 25: sink += 3; break;
      case 1: sink += 4; break;
      default: sink += 5;
    }
  }
}
const dt = performance.now() - t0;
console.log(JSON.stringify({ mode, N, ms: Math.round(dt), sink }));
