// 第 72 轮叶子优先规划：css_printer 转义/换行助手（Go 探针固化，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Printer } from "./css_printer.ts";

const FIXTURE = new URL("../../../testdata/css-printer-state2-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "d3bc053d7faf1456edf8401a98732786ee6ba4234fcd66334783c92e0fa2c85a";

interface Row { fn: string; arg: string; out: string; }

test("css-printer-state2 fixture sha256 + 13 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-printer-state2 fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    if (r.fn === "printWithEscape") {
      const parts = r.arg.split("|");
      const c = Number(parts[0]), escape = Number(parts[1]);
      const remaining = Buffer.from(parts[2], "base64").toString("utf8");
      const mayNeed = parts[3] === "true";
      const p = new Printer();
      p.printWithEscape(c, escape, remaining, mayNeed);
      got = Buffer.from(p.css).toString("base64");
    } else if (r.fn === "printNewlinePastLineLimit") {
      const sep = r.arg.split("|");
      const p = new Printer();
      p.css = Array.from(Buffer.from(sep[0], "base64"));
      p.oldLineEnd = Number(sep[1]); p.lineLimit = Number(sep[2]); p.minifyWhitespace = sep[3] === "true";
      got = `${p.printNewlinePastLineLimit(2)}|${Buffer.from(p.css).toString("base64")}`;
    } else throw new Error(`unknown ${r.fn}`);
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 13);
});
