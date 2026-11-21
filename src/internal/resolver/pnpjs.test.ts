// 第 172 批：tryToExtractYarnPnPDataFromJS + PnP JS 拦截底座，Go 探针 11 例逐字节固化。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NewDeferLog, DeferLogKind } from "../logger/logger.ts";
import { UTF16ToString } from "../helpers/utf.ts";
import { realFS } from "../fs/fs_real.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import { tryToExtractYarnPnPDataFromJS } from "./yarnpnp.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/pnpjs-go.json", import.meta.url)));
const SHA = "803592767b3a55dc770ea8fc277e2b7b6e01a90eff1f34bda25583d2e841d8fd";

/** 镜像 Go 探针 tmpgen_pnpjs_test.go 的 dumpExprLocPJ（含每节点 Loc.Start，验证 remapExprLocsInJSON） */
function dumpExpr(e: js_ast.Expr | null): any {
  if (e === null || e.Data === null) return null;
  const loc = e.Loc.Start;
  const d: any = e.Data;
  if (d instanceof js_ast.EString) return ["s", new TextDecoder().decode(UTF16ToString(d.Value)), loc];
  if (d instanceof js_ast.EBoolean) return ["b", d.Value, loc];
  if (d instanceof js_ast.ENull) return ["null", loc];
  if (d instanceof js_ast.ENumber) return ["n", d.Value, loc];
  if (d instanceof js_ast.EArray) {
    return ["a", d.Items.map(dumpExpr), loc, d.CloseBracketLoc.Start];
  }
  if (d instanceof js_ast.EObject) {
    const props: { k: string; v: any }[] = d.Properties.map((p: any) => {
      const key = p.Key.Data instanceof js_ast.EString ? new TextDecoder().decode(UTF16ToString(p.Key.Data.Value)) : "";
      return { k: key, v: dumpExpr(p.ValueOrNil ?? null) };
    });
    props.sort((a, b) => a.k < b.k ? -1 : a.k > b.k ? 1 : 0);
    return ["o", props.map((p) => [p.k, p.v]), loc, d.CloseBraceLoc.Start];
  }
  return ["other", loc];
}

test("pnpjs fixture sha256 + 11 例逐字节等于 Go（含 PnP 底座全链）", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const a = r.arg;
    const notes: string[] = [];
    const log = NewDeferLog(DeferLogKind.DeferLogAll, null);
    const dl = { addNote: (s: string) => { notes.push(s); } };
    const map = new Map<string, string>();
    if (a.contents !== "") map.set(a.path, a.contents);
    const ctx: any = {
      fsObj: new realFS(false, "/"),
      log,
      debugLogs: dl,
      readFile: (path: string) => {
        const c = map.get(path);
        return c === undefined ? { contents: "", err: "no such file or directory" } : { contents: c, err: null };
      },
    };
    const got = tryToExtractYarnPnPDataFromJS(ctx, a.path, a.mode);
    const msgs = log.Done().map((m: any) => {
      if (m.Data.Location === null) return [m.Data.Text, null];
      return [m.Data.Text, m.Data.Location.Line, m.Data.Location.Column, m.Data.Location.Length];
    });
    const actual = [dumpExpr(got.result), got.source.KeyPath.Text, msgs, notes];
    assert.deepEqual(actual, r.out,
      `case ${a.name}\n got ${JSON.stringify(actual)}\nwant ${JSON.stringify(r.out)}`);
  }
});
