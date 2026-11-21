// 第 85 轮叶子优先规划：css_lexer consumeToEndOfMultiLineComment（Go 探针固化）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Loc, Range, Source } from "../logger/logger.ts";
import { Lexer } from "./css_lexer.ts";

const FIXTURE = new URL("../../../testdata/css-lexer-comment-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "4f054015057c8e2009756a4f7a010f67f830f4ed3873588d88004626a8dd88ce";

interface Row { fn: string; arg: string; out: string; }

test("css-lexer-comment fixture sha256 + 6 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-lexer-comment fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const parts = r.arg.split("|");
    const contents = new Uint8Array(Buffer.from(parts[0], "base64"));
    const start = Number(parts[1]);
    const recordAll = parts[2] === "true";
    const l = new Lexer();
    l.source = new Source(); l.source.Contents = contents; l.contents = contents;
    l.current = start; l.tokenRangeLoc = start; l.tokenRangeLen = start;
    l.recordAllComments = recordAll;
    l.step();
    l.consumeToEndOfMultiLineComment(start);
    let allC = "";
    for (const rg of l.allComments) allC += `${rg.Loc.Start}:${rg.Len};`;
    let legal = "";
    for (const cm of l.legalCommentsBefore) legal += Buffer.from(cm.text).toString("utf8") + ";";
    const smu = `${Buffer.from(l.sourceMappingURLText).toString("utf8")}|${l.sourceMappingURLLoc}:${l.sourceMappingURLLen}`;
    const got = `cur=${l.current};all=${allC};legal=${legal};smu=${smu}`;
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 6);
});
