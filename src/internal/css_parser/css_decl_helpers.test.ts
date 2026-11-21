// 第 131 批：processDeclarations 依赖助手 8 函数（Go 探针 28 例，逐字节）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Token as ASTToken } from "../css_ast/css_ast.ts";
import { CSSParser } from "./css_parser.ts";
import { processAnimationShorthand, processAnimationName, handleSingleAnimationName } from "./css_decls_animation.ts";
import { processContainerShorthand, processContainerName, handleSingleContainerName } from "./css_decls_container.ts";
import { processListStyleShorthand, processListStyleType } from "./css_decls_list_style.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/decl-helpers-go.json", import.meta.url)));
const SHA = "9b825f24506ea34fc503aa5928f60058bb877f6055c431de9663f4bd7f5935da";
const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);
const mk = (local: boolean): CSSParser => { const p = new CSSParser(); p.makeLocalSymbols = local; return p; };
const toks = (kinds: number[], texts: string[]): ASTToken[] => texts.map((t, i) => {
  const x = new ASTToken(); x.Kind = kinds[i]; x.Text = t; x.Loc = i + 1; return x;
});
const dump = (ts: ASTToken[]): any[] => ts.map((t) => [t.Kind, t.Text, t.PayloadIndex]);

test("decl-helpers fixture sha256 + 28 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  const id = 29, str = 36, num = 30;
  const anim = [
    { name: "shorthand", kinds: [id,id,num,id,id,id,id,id,id], texts: ["ease","1s","2","infinite","alternate","forwards","running","foo","bar"] },
    { name: "shorthand-comma", kinds: [id,id,id,id], texts: ["linear","paused","a","b"] },
    { name: "name", kinds: [id,id,str], texts: ["none","foo","bar"] },
  ];
  const cont = [
    { name: "shorthand", kinds: [id,id,24,id], texts: ["foo","bar","/","baz"] },
    { name: "shorthand-bad", kinds: [id,25], texts: ["foo","("] },
    { name: "name", kinds: [id,id], texts: ["foo","none"] },
    { name: "name-bad", kinds: [id,25], texts: ["foo","("] },
  ];
  const lists = [
    { kinds: [27,id,id], texts: ["url(x)","square","inside"] },
    { kinds: [id], texts: ["none"] },
    { kinds: [id,id], texts: ["disc","outside"] },
    { kinds: [id,id,id], texts: ["none","inside","custom"] },
  ];
  let hi = 0, li = 0, ti = 0;
  for (const r of rows) {
    let got: any;
    if (r.fn.startsWith("animation:")) {
      const c = anim.find((x) => x.name === r.fn.slice(10))!, p = mk(!!r.arg), ts = toks(c.kinds, c.texts);
      if (c.name.startsWith("shorthand")) processAnimationShorthand(p, ts); else processAnimationName(p, ts);
      got = dump(ts);
    } else if (r.fn === "handleSingleAnimationName") {
      const p = mk(r.arg[1]), ts = toks([r.arg[0] === "foo" || r.arg[0] === "none" ? (hi < 4 ? id : str) : id], [r.arg[0]]);
      hi++;
      handleSingleAnimationName(p, ts[0]); got = dump(ts);
    } else if (r.fn.startsWith("container:")) {
      const c = cont.find((x) => x.name === r.fn.slice(10))!, p = mk(false), ts = toks(c.kinds, c.texts);
      if (c.name === "name" || c.name === "name-bad") processContainerName(p, ts); else processContainerShorthand(p, ts);
      got = dump(ts);
    } else if (r.fn === "handleSingleContainerName") {
      const ts = toks([id], [r.arg]); handleSingleContainerName(mk(false), ts[0]); got = dump(ts);
    } else if (r.fn === "processListStyleShorthand") {
      const c = lists[li++], ts = toks(c.kinds, c.texts); processListStyleShorthand(mk(false), ts); got = dump(ts);
    } else if (r.fn === "processListStyleType") {
      const ts = toks([id], [r.arg]); processListStyleType(mk(false), ts[0]); got = dump(ts);
      ti++;
    } else throw new Error("unknown " + r.fn);
    assert.equal(JSON.stringify(canon(got)), JSON.stringify(canon(r.out)), `${r.fn} ${JSON.stringify(r.arg)} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 28);
  assert.equal(hi, 8); assert.equal(ti, 3);
});
