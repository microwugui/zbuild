// 第 135 批：handleComposesPragma（Go 探针 4 例）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Tokenize } from "../css_lexer/css_lexer.ts";
import { Source, Loc, NewDeferLog, DeferLogKind, MakeLineColumnTracker } from "../logger/logger.ts";
import { CSSParser } from "./css_parser.ts";
import { handleComposesPragma } from "./css_decls_composes.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/composes-go.json", import.meta.url)));
const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);
const SHA = "0795ad423b5565cbe8ad1e5c33d37fe0cb165c228afe0cee223b5531d54a4086";
test("composes fixture sha256 + 4 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null);
    const source = new Source(); source.Contents = new TextEncoder().encode(r.src);
    const p = new CSSParser(); p.tokens = Tokenize(source).tokens; p.source = source; p.log = log;
    p.tracker = MakeLineColumnTracker(source); p.prevError = new Loc(0);
    const ref = { SourceIndex: 0, InnerIndex: 0 };
    p.composes.set(ref, { Names: [], ImportedNames: [], Properties: null });
    const ctx = { parentRefs: [ref], parentRange: new (p.tracker.constructor as any)(), problemRange: { Len: 0 } } as any;
    handleComposesPragma(p, ctx, p.convertTokens(p.tokens));
    const c = p.composes.get(ref);
    const got = { names: c.Names.map((n: any) => p.symbols[n.Ref.InnerIndex].OriginalName), imports: p.importRecords.length,
      msgs: log.Done().map((m: any) => m.Data.Text) };
    assert.equal(JSON.stringify(canon(got)), JSON.stringify(canon({imports:r.imports,msgs:r.msgs,names:r.names})), `${r.src} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 4);
});
