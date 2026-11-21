// 第 52 轮叶子优先规划：renamer 命名助手（Go 探针固化，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ExportRenamer, numberScope } from "./renamer.ts";

const FIXTURE = new URL("../../../testdata/renamer-name-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "81bb102b54e89608c3224e0e8a6d43bf0ce338c8e8b976ced0a3ddb3e914fcc2";

interface Row { fn: string; arg: string; out: string; }
interface ChainIn { scopes: Record<string, number>[]; name: string; ns: number; }
function buildChain(s: string): numberScope {
  const c: ChainIn = JSON.parse(s);
  let cur: numberScope | null = null;
  for (const m of c.scopes) {
    const scope = new numberScope();
    scope.nameCounts = new Map<string, number>(Object.entries(m));
    scope.parent = cur;
    cur = scope;
  }
  return cur!;
}
function dumpCounts(m: Map<string, number>): string {
  return [...m.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
    .map(([k, v]) => `${k}=${v}`).join(",");
}

test("renamer-name fixture sha256 + 20 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "renamer-name fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "NextRenamedName": {
        const names: string[] = JSON.parse(r.arg);
        const er = new ExportRenamer();
        got = names.map((n) => er.NextRenamedName(n)).join(";");
        break;
      }
      case "NextMinifiedName": {
        const er = new ExportRenamer();
        er.count = Number(r.arg);
        const res: string[] = [];
        for (let i = 0; i < 4; i++) res.push(er.NextMinifiedName());
        got = res.join(";");
        break;
      }
      case "findNameUse": {
        const c: ChainIn = JSON.parse(r.arg);
        got = String(buildChain(r.arg).findNameUse(c.name));
        break;
      }
      case "findUnusedName": {
        const c: ChainIn = JSON.parse(r.arg);
        const scope = buildChain(r.arg);
        got = scope.findUnusedName(c.name, c.ns) + "|" + dumpCounts(scope.nameCounts);
        break;
      }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 20);
});
