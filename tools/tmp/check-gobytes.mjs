import fs from "node:fs"; import path from "node:path"; import ts from "typescript";
const d=JSON.parse(fs.readFileSync("tools/tmp/gobytes-candidates.json","utf8"));
function decls(file){if(!fs.existsSync(file))return new Set();const sf=ts.createSourceFile(file,fs.readFileSync(file,"utf8"),ts.ScriptTarget.Latest,false,ts.ScriptKind.TS);const names=new Set();const v=(n)=>{if((ts.isFunctionDeclaration(n)||ts.isMethodDeclaration(n))&&n.name)names.add(n.name.text);ts.forEachChild(n,v);};v(sf);return names;}
const dirFor=(pkg)=>"src/"+pkg;
let bad=[];
for(const e of d){
 const dir=dirFor(e.pkg);let found=false;
 const walk=(dd)=>{for(const f of fs.readdirSync(dd)){const p=path.join(dd,f);const st=fs.statSync(p);if(st.isDirectory())walk(p);else if(f.endsWith(".ts")&&decls(p).has(e.fn))found=true;}};
 if(fs.existsSync(dir))walk(dir);
 if(!found)bad.push(e.pkg+":"+e.recv+"."+e.fn);
}
console.log("total",d.length,"not-found-in-TS",bad.length,bad.join(", "));
