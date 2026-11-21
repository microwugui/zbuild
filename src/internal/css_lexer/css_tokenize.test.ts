// 第 98 轮叶子优先规划：CSS 整条 tokenize 链（一次探针，逐字节等于 Go）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Source } from "../logger/logger.ts";
import { Tokenize } from "./css_lexer.ts";

const FIXTURE = new URL("../../../testdata/css-tokenize-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "d46bc7dc401e35b0b30342265ebd90e581fe3bc8476bc59e140ca6ebe01aee74";

interface Row { src: string; out: string; }

test("css-tokenize fixture sha256 + 32 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-tokenize fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
  for (const r of rows) {
    const srcBytes = new TextEncoder().encode(r.src);
    const src = new Source(); src.Contents = srcBytes;
    const { tokens } = Tokenize(src);
    const got = tokens.map((tk) => {
      const text = new TextDecoder().decode(srcBytes.subarray(tk.rangeLoc, tk.rangeLoc + tk.rangeLen));
      return `${tk.kind}:${b64(text)}:${tk.rangeLoc}:${tk.rangeLen}:${tk.unitOffset}:${tk.flags};`;
    }).join("");
    assert.equal(got, r.out, JSON.stringify(r.src));
  }
  assert.equal(rows.length, 32);
});
