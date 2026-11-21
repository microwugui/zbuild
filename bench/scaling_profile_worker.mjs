// Scaling profiler worker: accepts --driver (any worktree's bundle1.ts), warms N
// times, then profiles ONE measured run via V8 inspector CPU profiler.
// Used to detect super-linear growth: same code, inputs at 1x/2x/4x scale.
import inspector from 'node:inspector';
import { writeFileSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
function opt(name, def) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; }
const driver = opt('--driver', '');
const input = opt('--input', '');
const warm = Number(opt('--warm', '2'));
const profilePath = opt('--profile', '/tmp/scaling.cpuprofile');

const m = await import(driver);
const contents = readFileSync(input);
const bundle = () => m.bundleSingleFile(contents, input);

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
