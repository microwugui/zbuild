// 第 126 批：MockFS 构造 + 6 方法（Go 探针 42 例，逐字节）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { MockFS, readDirectory, readFile, openFile, modKey, evalSymlinks } from "./fs_mock.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/fs-batch-go.json", import.meta.url)));
const SHA = "c707911bc059d7321ac3576fc0d9485be10d03d29e096fb54d51d969e6135c46";
const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : (x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);
const inputs: Record<string, string>[] = [
  {},
  { "/a/b/c.txt": "hello" },
  { "/x.js": "js", "/dir/y.css": "css", "/dir/sub/z.txt": "z" },
];
const fsFor = (i: number) => MockFS(inputs[i], 0, "/root");

test("fs-batch fixture sha256 + 42 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: any;
    const arg = r.arg;
    if (r.fn === "MockFS") {
      const fsys = fsFor(arg);
      const dirs: any[] = [];
      for (const k of ["/", "/a", "/a/b", "/dir", "/dir/sub", "/x.js"]) {
        const d = fsys.dirs.get(k);
        if (d) dirs.push([k, d.SortedKeys()]);
      }
      got = { dirs, files: fsys.files.size };
    } else if (Array.isArray(arg)) {
      const fsys = fsFor(arg[0]);
      const path = arg[1] as string;
      switch (r.fn) {
        case "ReadDirectory": {
          const v = fsys.ReadDirectory(path);
          got = { dir: v.dir.dir, keys: v.dir.data === null ? null : v.dir.SortedKeys(), e1: v.err1, e2: v.err2 };
          break;
        }
        case "ReadFile": { const v = fsys.ReadFile(path); got = { text: v.text, e1: v.err1, e2: v.err2 }; break; }
        case "OpenFile": {
          const v = fsys.OpenFile(path);
          if (v.file === null) got = { nil: true, e1: v.err1, e2: v.err2 };
          else got = { nil: false, len: v.file.Len(), read: new TextDecoder().decode(v.file.Read(0, 2).value), readErr: v.file.Read(0, 2).err ?? "", e1: v.err1, e2: v.err2 };
          break;
        }
        default: throw new Error("unknown " + r.fn);
      }
    } else {
      const fsys = fsFor(arg);
      if (r.fn === "ModKey") got = fsys.ModKey("/x.js").err;
      else if (r.fn === "EvalSymlinks") got = fsys.EvalSymlinks("/a/b");
      else throw new Error("unknown " + r.fn);
    }
    assert.equal(JSON.stringify(canon(got)), JSON.stringify(canon(r.out)), `${r.fn} ${JSON.stringify(arg)} => ${JSON.stringify(got)} != ${JSON.stringify(r.out)}`);
  }
  assert.equal(rows.length, 42);
});
