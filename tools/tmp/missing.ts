import fs from "node:fs"; import path from "node:path"; import ts from "typescript";
const inv: any[] = JSON.parse(fs.readFileSync("inventory.json","utf8")).filter(g=>!g.test&&g.body);
const cache=new Map<string,Set<string>>();
const decls=(f:string)=>{if(cache.has(f))return cache.get(f)!;const p=path.join("src",f.replace(/\.go$/,".ts"));const s=new Set<string>();if(fs.existsSync(p)){const sf=ts.createSourceFile(p,fs.readFileSync(p,"utf8"),ts.ScriptTarget.Latest,false,ts.ScriptKind.TS);const v=(n:ts.Node)=>{if((ts.isFunctionDeclaration(n)||ts.isMethodDeclaration(n))&&n.name&&ts.isIdentifier(n.name))s.add(n.name.text);else if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&n.initializer&&(ts.isArrowFunction(n.initializer)||ts.isFunctionExpression(n.initializer)))s.add(n.name.text);ts.forEachChild(n,v);};v(sf);}cache.set(f,s);return s;};
const pkg=process.argv[2]; const arr=inv.filter(g=>g.pkg===pkg&&!decls(g.file).has(g.name));
const byFile=new Map<string,any[]>();for(const g of arr){const a=byFile.get(g.file)??[];a.push(g);byFile.set(g.file,a);}
for(const [f,gs] of [...byFile].sort()){console.log(`${f} (${gs.length})`);for(const g of gs.sort((a,b)=>a.start-b.start))console.log(`  ${g.start}: ${g.recv?g.recv+'.':''}${g.name}`);}
