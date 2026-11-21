import fs from "node:fs"; import crypto from "node:crypto";
const inv=JSON.parse(fs.readFileSync("inventory.json","utf8")).filter(g=>!g.test&&g.body);
const specs=[
 ["css-ast-hash-go.json","internal/css_ast","第101批 Hash 整链，Go 包内探针 IR 逐字节"],
 ["css-ast-equal-go.json","internal/css_ast","第102批 Equal 整链，Go 包内探针 IR 逐字节（含跨文件 check）"],
 ["css-ast-clone-go.json","internal/css_ast","第103批 Clone 整链，Go 包内探针 dump 逐字节"],
 ["css-calc-go.json","internal/css_parser","第104批 calc 归约链，Go 包内探针逐字节"],
 ["css-font-go.json","internal/css_parser","第105批 font-family mangle，Go 包内探针逐字节"],
 ["css-font2-go.json","internal/css_parser","第105批 turnPercent，Go 探针逐字节"],
 ["css-sel-go.json","internal/css_parser","第106批 selector 助手，Go 探针逐字节"],
 ["css-colorspaces3-go.json","internal/css_parser","第107批 色彩空间入口，Go 探针；1-ULP known-deviation 口径(toFixed10)"],
 ["css-compact-go.json","internal/css_parser","第108批 compactTokenQuad/commaToken，Go 探针逐字节"],
 ["css-box2-go.json","internal/css_parser","第109批 boxTracker，Go 探针 dump 逐字节"],
 ["css-br-go.json","internal/css_parser","第110批 borderRadiusTracker，Go 探针 dump 逐字节"],
];
const idx={};for(const g of inv){const k=g.pkg+":"+g.name;(idx[k]=idx[k]||[]).push(g);}
const fnOverrides={
 "css-calc-go.json":["tryToReduceCalcExpression","floatToStringForCalc","convertToToken","partiallySimplify","tryToParseCalcTerm"],
 "css-box2-go.json":["updateSide","mangleSides","mangleSide","compactRules"],
 "css-br-go.json":["updateCorner","mangleCorners","mangleCorner","compactRules"],
};
const out=[];
for(const [fixture,pkg,note] of specs){
  const raw=fs.readFileSync("testdata/"+fixture);
  const sha=crypto.createHash("sha256").update(raw).digest("hex");
  const d=JSON.parse(raw);
  const fns=fnOverrides[fixture]??[...new Set(d.map(x=>x.fn))];
  for(const fk of fns){
    const base=fk.replace(/\.(deep|nil|noPrefix|minify)$/,"");
    const parts=base.split(".");
    const recv=parts.length>=2?parts[parts.length-2]:"";
    const name=parts[parts.length-1];
    const entries=idx[pkg+":"+name]??[];
    const match=recv?entries.find(e=>(e.recv??"")===recv):entries[0];
    if(!match)continue;
    out.push({pkg,recv:match.recv??"",fn:match.name,fixture,sha,evidence:note});
  }
}
const seen=new Set();const entries=[];
for(const e of out){const k=e.pkg+":"+e.recv+":"+e.fn;if(seen.has(k))continue;seen.add(k);entries.push(e);}
entries.sort((a,b)=>a.pkg.localeCompare(b.pkg)||a.recv.localeCompare(b.recv)||a.fn.localeCompare(b.fn));
const doc={
  schema:"go-bytes-functions-v1",
  note:"逐函数 Go 实测等价登记：一条 = 一个 Go 非测试函数，其期望值由 Go 参考实现当场产出并与 TS 逐字节比对（fixture 钉 SHA）。progress.ts 读取本表：校验 fixture SHA + inventory 存在 + TS 已移植 + 被测试执行后，计为 equivGoBytes。互斥优先级 oracle>unit>go-bytes；unit 通道（临时等价，M4 回 oracle 重跑）不受本表影响。色彩空间 3 入口为 1-ULP known-deviation 口径(toFixed10)，evidence 已标注。每产出一条 Go 探针 fixture 必须同步登记至此。",
  count:entries.length,
  entries,
};
fs.writeFileSync("tools/go-bytes-functions.json",JSON.stringify(doc,null,2)+"\n");
console.log("written",entries.length,"entries");
const by={};entries.forEach(e=>by[e.pkg]=(by[e.pkg]||0)+1);console.log(JSON.stringify(by));
