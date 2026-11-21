// Warm large-build profiler worker. Fully warm (N runs), release caches (global.gc),
// then record ONE measured run via the V8 inspector CPU profiler.
import inspector from 'node:inspector';
import { writeFileSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
function opt(name, def) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; }
const input = opt('--input', '');
const warm = Number(opt('--warm', '2'));
const profilePath = opt('--profile', '/tmp/warm-big.cpuprofile');

const m = await import('/root/port-ev/src/bundle1.ts');
const contents = readFileSync(input);
const bundle = () => m.bundleSingleFile(contents, input);

// fully warm: repeated runs; drop references so only JIT feedback/shapes persist
for (let i = 0; i < warm; i++) {
  const r = bundle();
  if (!r.ok) throw new Error('warm run failed: ' + r.error);
}
if (global.gc) global.gc();

const s = new inspector.Session();
s.connect();
s.post('Profiler.enable');
s.post('Profiler.setSamplingInterval', { interval: 200 });
s.post('Profiler.start');
const t0 = performance.now();
const r = bundle();
const wallMs = performance.now() - t0;
const { profile } = await new Promise((resolve) => s.post('Profiler.stop', (err, data) => resolve(data)));
s.disconnect();
writeFileSync(profilePath, JSON.stringify(profile));
console.log(JSON.stringify({ ok: r.ok, outBytes: r.output?.length ?? 0, wallMs: Math.round(wallMs) }));
