// One warm build, then time a single measured run; print ms + output sha for pairing.
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2);
function opt(name, def) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; }
const driver = opt('--driver', '');
const input = opt('--input', '');
const warm = Number(opt('--warm', '2'));

const m = await import(driver);
const contents = readFileSync(input);
const bundle = () => m.bundleSingleFile(contents, input);

for (let i = 0; i < warm; i++) {
  const r = bundle();
  if (!r.ok) throw new Error('warm run failed: ' + r.error);
}
if (global.gc) global.gc();

const t0 = performance.now();
const r = bundle();
const ms = Math.round(performance.now() - t0);
const sha = createHash('sha256').update(r.output).digest('hex').slice(0, 16);
console.log(JSON.stringify({ ok: r.ok, ms, outBytes: r.output?.length ?? 0, sha }));
