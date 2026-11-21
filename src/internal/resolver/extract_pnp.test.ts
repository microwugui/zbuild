// 第 164 批：extractYarnPnPDataFromJSON，Go 探针 5 例逐字节固化（PnP manifest 加载）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NewDeferLog, DeferLogKind } from "../logger/logger.ts";
import { UTF16ToString } from "../helpers/utf.ts";
import { realFS } from "../fs/fs_real.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import { extractYarnPnPDataFromJSON } from "./yarnpnp.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/extract-pnp-go.json", import.meta.url)));
const SHA = "ef4f4a830fc56f9207160378c22b9bfe5855dc8893281dbe299bedc7fc44e362";

function dumpExpr(e: js_ast.Expr | null): any {
  if (e === null || e.Data === null) return null;
  const d: any = e.Data;
  if (d instanceof js_ast.EString) return ["s", new TextDecoder().decode(UTF16ToString(d.Value))];
  if (d instanceof js_ast.EBoolean) return ["b", d.Value];
  if (d instanceof js_ast.ENull) return ["null"];
  if (d instanceof js_ast.ENumber) return ["n", d.Value];
  if (d instanceof js_ast.EArray) return ["a", d.Items.map(dumpExpr)];
  if (d instanceof js_ast.EObject) {
    const props: { k: string; v: any }[] = d.Properties.map((p: any) => {
      const key = p.Key.Data instanceof js_ast.EString ? new TextDecoder().decode(UTF16ToString(p.Key.Data.Value)) : "";
      return { k: key, v: dumpExpr(p.ValueOrNil ?? null) };
    });
    props.sort((a, b) => a.k < b.k ? -1 : a.k > b.k ? 1 : 0);
    return ["o", props.map((p) => [p.k, p.v])];
  }
  return ["other"];
}

test("extract-pnp fixture sha256 + 5 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const a = r.arg;
    const notes: string[] = [];
    const log = NewDeferLog(DeferLogKind.DeferLogAll, null);
    const dl = { addNote: (s: string) => { notes.push(s); } };
    const map = new Map<string, string>();
    if (a.contents !== "" || a.name === "bad-json") map.set(a.path, a.contents);
    const ctx: any = {
      fsObj: new realFS(false, "/"),
      log,
      debugLogs: dl,
      readFile: (path: string) => {
        const c = map.get(path);
        return c === undefined ? { contents: "", err: "no such file or directory" } : { contents: c, err: null };
      },
    };
    const got = extractYarnPnPDataFromJSON(ctx, a.path, a.mode);
    const msgs = log.Done().map((m: any) => m.Data.Text);
    assert.deepEqual([dumpExpr(got.result), got.source.KeyPath.Text, msgs, notes], r.out,
      `case ${a.name}\n got ${JSON.stringify([dumpExpr(got.result), got.source.KeyPath.Text, msgs, notes])}\nwant ${JSON.stringify(r.out)}`);
  }
});
