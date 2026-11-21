// 第 44 轮 glob 底座链：globPatternFromExpr（js_parser.go:16758）。
// byte oracle 由 Go 0.28.2 包内探针（internal/js_parser/tmpgen_glob_test.go，跑完即删）
// 用 Parse 后对 EImportCall.path 调 globPatternFromExpr 的 parts 实测，
// 固化在 testdata/js_parser/glob-pattern-go.json（<W> = wildcard）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Log, Path, Source } from "../logger/logger.ts";
import { Lexer } from "../js_lexer/js_lexer.ts";
import { newParser, Parse, Options } from "./js_parser.ts";
import * as js_ast from "../js_ast/js_ast.ts";

const FIXTURE = new URL("../../../testdata/js_parser/glob-pattern-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "3753583edd7b5209d89fb3c2342b064029c6c16168c503a96fd0b8a93738921a";

interface Row { name: string; src: string; parts: string[]; }

function partsOf(src: string): string[] {
  const s = new Source();
  s.Index = 1; // 非 runtime.SourceIndex，避免与 import record 冲突
  s.Contents = new TextEncoder().encode(src);
  s.KeyPath = new Path();
  s.KeyPath.Text = "<stdin>";
  const o = new Options();
  const parsed = Parse(new Log(), s, o);
  let path: js_ast.Expr | null = null;
  for (const part of parsed.ast.Parts) {
    for (const st of part.Stmts) {
      if (st.Data instanceof js_ast.SExpr) {
        const se = st.Data as js_ast.SExpr;
        if (se.Value.Data instanceof js_ast.EImportCall) path = (se.Value.Data as js_ast.EImportCall).Expr;
      }
    }
  }
  if (path === null) return [];
  // globPatternFromExpr 只读 this.source；用 newParser 绑定同一 source 即可直调。
  const p = newParser(new Log(), s, Lexer.NewLexer(new Log(), s, o.ts), o);
  const { parts } = p.globPatternFromExpr(path);
  if (parts === null) return [];
  return parts.map((pt) => pt.isWildcard ? "<W>" : pt.text);
}

test("glob 底座链：fixture sha256 + 5 例 parts 逐项等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "glob-pattern fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  assert.equal(rows.length, 5, "5 例");
  for (const row of rows) {
    assert.deepEqual(partsOf(row.src), row.parts, `glob ${row.name}`);
  }
});
