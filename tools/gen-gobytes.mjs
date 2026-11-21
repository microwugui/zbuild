#!/usr/bin/env node
// go-bytes 等价登记生成器：从 tools/go-bytes-fixtures.json 清单生成 tools/go-bytes-functions.json。
// 每产出一条 Go 探针 byte fixture：往清单追加一行（必要时给 fns），重跑本脚本，再跑 npm run progress。
import fs from "node:fs"; import crypto from "node:crypto"; import path from "node:path";
const root = process.cwd();
const inv = JSON.parse(fs.readFileSync(path.join(root,"inventory.json"),"utf8")).filter(g=>!g.test&&g.body);
const list = JSON.parse(fs.readFileSync(path.join(root,"tools/go-bytes-fixtures.json"),"utf8"));
const idx={}; for(const g of inv){const k=g.pkg+":"+g.name;(idx[k]=idx[k]||[]).push(g);}
const out=[];
for(const spec of list.fixtures){
  const fx=path.join(root,"testdata",spec.fixture);
  if(!fs.existsSync(fx)){console.error("fixture 缺失:",spec.fixture);process.exit(2);}
  const raw=fs.readFileSync(fx);
  const sha=crypto.createHash("sha256").update(raw).digest("hex");
  const d=JSON.parse(raw);
  const fns=spec.fns??[...new Set(d.map(x=>x.fn))];
  for(const fk of fns){
    const base=String(fk).replace(/\.(deep|nil|noPrefix|minify)$/,"");
    const parts=base.split(".");
    const recv=parts.length>=2?parts[parts.length-2]:"";
    const name=parts[parts.length-1];
    const entries=idx[spec.pkg+":"+name]??[];
    const match=recv?entries.find(e=>(e.recv??"")===recv):entries[0];
    if(!match){console.error("inventory 未匹配:",spec.pkg,fk);process.exit(2);}
    out.push({pkg:spec.pkg,recv:match.recv??"",fn:match.name,fixture:spec.fixture,sha,evidence:spec.note});
  }
}
const seen=new Set();const entries=[];
for(const e of out){const k=e.pkg+":"+e.recv+":"+e.fn;if(seen.has(k))continue;seen.add(k);entries.push(e);}
entries.sort((a,b)=>a.pkg.localeCompare(b.pkg)||a.recv.localeCompare(b.recv)||a.fn.localeCompare(b.fn));
const doc={schema:"go-bytes-functions-v1",note:"逐函数 Go 实测等价登记：一条=一个 Go 非测试函数，期望值由 Go 参考实现当场产出并与 TS 逐字节比对（fixture 钉 SHA）。progress.ts 校验 fixture SHA + inventory 存在 + TS 已移植 + 被测试执行后计为 equivGoBytes。互斥优先级 oracle>unit>go-bytes；unit 通道（临时等价，M4 回 oracle 重跑）不受影响。1-ULP known-deviation 项 evidence 已标注。新增 fixture：追加 tools/go-bytes-fixtures.json 后重跑本脚本。",count:entries.length,entries};
fs.writeFileSync(path.join(root,"tools/go-bytes-functions.json"),JSON.stringify(doc,null,2)+"\n");
const by={};entries.forEach(e=>by[e.pkg]=(by[e.pkg]||0)+1);
console.log("go-bytes 登记",entries.length,"函数",JSON.stringify(by));
