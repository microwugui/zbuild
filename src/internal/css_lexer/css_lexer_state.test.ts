// 第 83 轮叶子优先规划：css_lexer 状态机助手（Go 探针固化）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Lexer } from "./css_lexer.ts";

const FIXTURE = new URL("../../../testdata/css-lexer-state-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "b57a52f40420b33ef80938a2472e27cb42a10cdedb78d010f81c42b991444cbf";

interface Row { fn: string; arg: string; out: string; }

test("css-lexer-state fixture sha256 + 17 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-lexer-state fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    if (r.fn === "step") {
      const sep = r.arg.lastIndexOf("|");
      const contents = Buffer.from(r.arg.slice(0, sep), "base64");
      const times = Number(r.arg.slice(sep + 1));
      const l = new Lexer(); l.contents = new Uint8Array(contents);
      l.step();
      let trace = "";
      for (let i = 0; i < times; i++) {
        trace += `${l.codePoint}:${l.current}:${l.tokenRangeLen};`;
        l.step();
      }
      got = trace;
    } else if (r.fn === "isValidEscape" || r.fn === "wouldStartNumber") {
      const parts = r.arg.split("|");
      const contents = Buffer.from(parts[0], "base64");
      const l = new Lexer(); l.contents = new Uint8Array(contents);
      l.current = Number(parts[1]); l.codePoint = Number(parts[2]);
      got = String(r.fn === "isValidEscape" ? l.isValidEscape() : l.wouldStartNumber());
    } else if (r.fn === "consumeEscape") {
      const l = new Lexer(); l.contents = new Uint8Array(Buffer.from(r.arg, "utf8"));
      l.step();
      got = `${l.consumeEscape()}|${l.current}`;
    } else throw new Error(`unknown ${r.fn}`);
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 17);
});
