// Real warm bundle under --trace-turbo-inlining; we grep the log for Next().
import { readFileSync } from 'node:fs';
const m = await import('file:///root/port/src/bundle1.ts');
const src = readFileSync('/root/port/node_modules/typescript/lib/typescript.js');
for (let i = 0; i < 3; i++) m.bundleSingleFile(src, 'x');
const r = m.bundleSingleFile(src, 'x');
console.error('DONE ok=' + r.ok);
