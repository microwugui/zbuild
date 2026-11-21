// 第 44 轮叶子优先规划：fs 路径纯判定真值表（Go 探针固化）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isReservedName, goFilepath, lazybuf } from "./filepath.ts";

const FIXTURE = new URL("../../../testdata/fs-filepath-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "850445e76f2cdb788acc6f42c680b34061d9c9040861d51748c455fb47931da0";

interface Row { fn: string; arg: string; win: boolean; out: string; }

test("fs 路径叶子真值表：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "fs-filepath fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const fp = new goFilepath(r.win);
    let got: string;
    switch (r.fn) {
      case "isReservedName": got = String(isReservedName(r.arg)); break;
      case "isPathSeparator": got = String(fp.isPathSeparator(r.arg.charCodeAt(0))); break;
      case "fromSlash": got = fp.fromSlash(r.arg); break;
      case "sameWord": { const [a, b] = r.arg.split("|"); got = String(fp.sameWord(a, b)); break; }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} ${JSON.stringify(r.arg)} win=${r.win}`);
  }
});

const F2 = new URL("../../../testdata/fs-lazybuf-go.json", import.meta.url);
const b2 = new Uint8Array(readFileSync(F2));
const S2 = "f20f807a3bcae5576ebe10887811dca4b01ac1c34d037e02b1e4e1747a09514f";
interface Row2 { fn: string; case: string; out: string; }

test("fs lazybuf 叶子真值表：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(b2).digest("hex"), S2, "fs-lazybuf fixture sha256");
  const rows: Row2[] = JSON.parse(new TextDecoder().decode(b2));
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "index": {
        const b = new lazybuf();
        if (r.case === "path1") b.path = "abc";
        else { b.buf = ["x".charCodeAt(0), "y".charCodeAt(0), "z".charCodeAt(0)]; }
        got = String.fromCharCode(b.index(r.case === "path1" ? 1 : 2)); break;
      }
      case "append": {
        const [p, ap] = r.case.split("+");
        const b = new lazybuf(); b.path = p; b.volAndPath = p;
        for (let i = 0; i < ap.length; i++) b.append(ap.charCodeAt(i));
        got = b.string(); break;
      }
      case "string": {
        const b = new lazybuf(); b.volAndPath = "VOLpath"; b.volLen = 3;
        if (r.case === "nobuf") b.w = 4;
        else { b.w = 2; b.buf = ["X".charCodeAt(0), "Y".charCodeAt(0)]; }
        got = b.string(); break;
      }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} ${r.case}`);
  }
});
