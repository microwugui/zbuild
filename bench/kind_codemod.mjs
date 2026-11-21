// CodEmitted performance experiment: add a numeric discriminant to js_ast E/S
// nodes and replace `instanceof js_ast.EXXX/SXXX` with an inlined numeric-kind
// type guard. Pure mechanical rewrite; output bytes must stay identical.
//
// Usage: node bench/kind_codemod.mjs /root/port-kind
import ts from 'typescript';
import fs from 'fs';
import path from 'path';

const ROOT = process.argv[2];
if (!ROOT) throw new Error('usage: node kind_codemod.mjs <tree-root>');
const AST = path.join(ROOT, 'src/internal/js_ast/js_ast.ts');

// 1) enumerate E/S subclasses in declaration order
let astText = fs.readFileSync(AST, 'utf8');
const classes = [];
for (const m of astText.matchAll(/export class ((?:E|S)[A-Za-z0-9_]+) extends (E|S) \{/g)) {
  classes.push({ name: m[1], base: m[2] });
}
console.log('subclasses:', classes.length);
if (classes.length === 0) throw new Error('no subclasses found');
const byName = new Map(classes.map((c) => [c.name, c]));

// 2) inject ExprKind enum + kindIs type guard right after base class E
// NOTE: node --experimental-strip-types cannot handle TS `enum` (needs codegen).
// Use a plain const object + a type alias instead; both are erasure-only syntax.
const enumLines = ['export const ExprKind = {', '  None: 0,'];
classes.forEach((c, i) => enumLines.push(`  ${c.name}: ${i + 1},`));
enumLines.push('} as const;');
enumLines.push('export type ExprKind = (typeof ExprKind)[keyof typeof ExprKind];');
const guard = `
/** Fast numeric-kind discriminant check (replaces instanceof prototype walks). */
export function kindIs<T>(v: unknown, kind: number): v is T {
  return v != null && (v as { _kind: number })._kind === kind;
}
`;
const eBaseRe = /export class E \{\n  isExpr\(\): void \{\}\n\}/;
const sBaseRe = /export class S \{\n  isStmt\(\): void \{\}\n\}/;
if (!eBaseRe.test(astText) || !sBaseRe.test(astText)) throw new Error('base class anchor not found');
// Do NOT declare _kind on the base classes: an erasure-only class field on E/S
// would run once in super() AND again in each subclass initializer (two writes
// per node). Only subclasses set it, so each node pays exactly one write.
astText = astText.replace(eBaseRe, `export class E {\n  isExpr(): void {}\n}\n\n${enumLines.join('\n')}\n${guard}`);
astText = astText.replace(sBaseRe, `export class S {\n  isStmt(): void {}\n}`);
for (const c of classes) {
  const re = new RegExp(`(export class ${c.name} extends ${c.base} \\{)`);
  if (!re.test(astText)) throw new Error(`subclass anchor not found: ${c.name}`);
  astText = astText.replace(re, `$1\n  _kind = ExprKind.${c.name};`);
}
fs.writeFileSync(AST, astText);
console.log('injected enum/guard/_kind into js_ast.ts');

// 3) walk all non-test .ts files, replace `instanceof js_ast.EXXX/SXXX`
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'coverage' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && p !== AST) out.push(p);
  }
  return out;
}
let total = 0;
const perFile = {};
for (const file of walk(path.join(ROOT, 'src'))) {
  let text = fs.readFileSync(file, 'utf8');
  if (!text.includes('instanceof js_ast.')) continue;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits = [];
  (function visit(node) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) {
      const rhs = node.right;
      let cls = null;
      if (ts.isPropertyAccessExpression(rhs) && rhs.expression.getText(sf) === 'js_ast') cls = rhs.name.text;
      if (cls && byName.has(cls)) {
        const leftText = node.left.getText(sf);
        const repl = `js_ast.kindIs<js_ast.${cls}>(${leftText}, js_ast.ExprKind.${cls})`;
        edits.push({ start: node.getStart(sf), end: node.end, repl });
      }
    }
    ts.forEachChild(node, visit);
  })(sf);
  if (edits.length) {
    for (const e of edits.sort((a, b) => b.start - a.start)) {
      text = text.slice(0, e.start) + e.repl + text.slice(e.end);
    }
    fs.writeFileSync(file, text);
    total += edits.length;
    perFile[path.relative(ROOT, file)] = edits.length;
  }
}
console.log('replaced instanceof sites:', total);
console.log('by file:', JSON.stringify(Object.fromEntries(Object.entries(perFile).sort((a,b)=>b[1]-a[1]).slice(0,12)), null, 2));
