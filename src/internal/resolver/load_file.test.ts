// 第 163 批：loadAsFile + loadAsIndex，Go 探针 13 例逐字节固化（fs.Entry.Kind 底座）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NewDeferLog, DeferLogKind } from "../logger/logger.ts";
import { MockFS, MockUnix } from "../fs/fs_mock.ts";
import { DifferentCase } from "../fs/fs.ts";
import { loadAsFile, loadAsIndex } from "./resolver.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/load-file-go.json", import.meta.url)));
const SHA = "24d72a0282964dd6304e3b5f1804652a57b1fbf003464e0ce882baf19c65ef63";

const dumpDC = (dc: DifferentCase | null): any => dc === null ? null : [dc.Dir, dc.Query, dc.Actual];

test("load-file fixture sha256 + 13 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  const files: Record<string, string> = {
    "/dir/a.js": "", "/dir/b.ts": "", "/dir/index.js": "",
    "/dir/sub/c.tsx": "", "/dir/x.json": "",
  };
  for (const r of rows) {
    const a = r.arg;
    const notes: string[] = [];
    let indent = "";
    const dl = {
      addNote: (s: string) => { notes.push(indent + s); },
      increaseIndent: () => { indent += "  "; },
      decreaseIndent: () => { indent = indent.slice(2); },
    };
    const fsobj = MockFS(files, MockUnix, "/");
    const ctx: any = { fsObj: fsobj, log: NewDeferLog(DeferLogKind.DeferLogAll, null), debugLogs: dl };
    if (r.fn === "loadAsFile") {
      const got = loadAsFile(ctx, a.path, a.eo);
      assert.deepEqual([got.path, got.ok, dumpDC(got.diffCase), notes], r.out,
        `loadAsFile ${a.path}\n got ${JSON.stringify([got.path, got.ok, dumpDC(got.diffCase), notes])}\nwant ${JSON.stringify(r.out)}`);
    } else if (r.fn === "loadAsIndex") {
      const rd = fsobj.ReadDirectory(a.dir);
      const dir = { absPath: a.dir, entries: rd.dir };
      const got = loadAsIndex(ctx, dir, a.eo);
      assert.deepEqual([got.text, got.namespace, got.ok, dumpDC(got.diffCase), notes], r.out,
        `loadAsIndex ${a.dir}\n got ${JSON.stringify([got.text, got.namespace, got.ok, dumpDC(got.diffCase), notes])}\nwant ${JSON.stringify(r.out)}`);
    }
  }
});
