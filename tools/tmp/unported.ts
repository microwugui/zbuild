import * as fs from "node:fs";
import ts from "/root/port/node_modules/typescript/lib/typescript.js";
const inv = JSON.parse(fs.readFileSync("inventory.json","utf8"));
function names(file: string): Set<string> {
  const out = new Set<string>();
  if (!fs.existsSync(file)) return out;
  const sf = ts.createSourceFile(file, fs.readFileSync(file,"utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) out.add(node.name.text);
    else if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) out.add(node.name.text);
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) out.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
const only = process.argv[2] || "js_parser.go";
const rows = inv.filter((x: any) => x.pkg === "internal/js_parser" && x.file.endsWith(only) && x.body && !x.test);
const tsFile = "src/internal/js_parser/" + only.replace(/\.go$/, ".ts");
const have = names(tsFile);
const miss = rows.filter((x: any) => !have.has(x.name));
console.log(`${only}: total ${rows.length} ported ${rows.length - miss.length} missing ${miss.length} (ts=${tsFile})`);
for (const m of miss) console.log(`${m.start}\t${m.name}`);
