// 第 96 轮成片端口：serve 层可确定性驱动函数簇（4 个未移植函数，单探针覆盖）。
// Go 探针 tools/go/tmpgen_serve_pure_test.bak → testdata/serve-pure-go.json（11 行）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { prettyPrintPath, matchQueryPathToResult, apiHandler } from "./serve_other.ts";
import type { RelFS, ServeOutputFile } from "./serve_other.ts";
import { UseColor } from "../../internal/logger/logger.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/serve-pure-go.json", import.meta.url)));
const SHA = "49d188ce7facca2da7522857b49a62a2eb3fe87aa5c9e5f9b2618a854a427e12";
const rows = JSON.parse(new TextDecoder().decode(raw)) as { fn: string; arg: string; out: any }[];

// 模拟 fs.MockFS（MockUnix, cwd=/workspace）：Rel(base,target) 仅当 target 在 base 下才成功。
const relFS: RelFS = {
  Cwd: () => "/workspace",
  Rel: (base: string, target: string): [string, boolean] => {
    if (target === base) return ["", true];
    if (target.startsWith(base + "/")) return [target.slice(base.length + 1), true];
    return [target, false];
  },
};
const ABS = "/out/dist";
const outputs = (): ServeOutputFile[] => [
  { Path: "/out/dist/index.html", Contents: new TextEncoder().encode("<html>") },
  { Path: "/out/dist/js/main.js", Contents: new TextEncoder().encode("js") },
  { Path: "/out/dist/style.css", Contents: new TextEncoder().encode("css") },
];

test("serve-pure 夹具 sha256（11 行）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("prettyPrintPath / matchQueryPathToResult / notifyRequest / printURLs 逐行等于 Go", () => {
  const out = new Map<string, any>();
  const put = (fn: string, arg: string, v: any) => out.set(fn + "|" + arg, v);

  put("prettyPrintPath", "rel", prettyPrintPath(relFS, "/workspace/src/a.js"));

  for (const q of ["", "index.html", "js/main.js", "js", "nope", "style.css"]) {
    const dirs = new Map<string, boolean>();
    const files = new Map<string, boolean>();
    const r = matchQueryPathToResult(relFS, ABS, q, { OutputFiles: outputs() }, dirs, files);
    put("matchQueryPathToResult", q, [r.kind, new TextDecoder().decode(r.contents), r.path, r.isIndex, dirs.size, files.size]);
  }

  {
    const h = new apiHandler();
    let got: any = null;
    h.onRequest = (a) => { got = a; };
    h.notifyRequest(12, "1.2.3.4:5678", "GET", "/foo", 200);
    put("notifyRequest", "args", got ? [got.RemoteAddress, got.Method, got.Path, got.Status, got.TimeInMS] : false);
    h.onRequest = null;
    h.notifyRequest(0, "x", "GET", "/", 404);
    put("notifyRequest", "nil-cb-ok", true);
  }

  // printURLs 用动态 import 避免顶层污染；断言在下方单独测试里做（捕获 write）。
  for (const r of rows) {
    if (r.fn === "printURLs") continue;
    assert.ok(out.has(r.fn + "|" + r.arg), `missing ${r.fn}|${r.arg}`);
    assert.deepEqual(out.get(r.fn + "|" + r.arg), r.out, `${r.fn} ${r.arg}`);
  }
});

test("printURLs 逐字节等于 Go（write 捕获）", async () => {
  const { printURLs } = await import("./serve_other.ts");
  const by = new Map(rows.filter((r) => r.fn === "printURLs").map((r) => [r.arg, r.out] as const));
  let s = "";
  printURLs(["127.0.0.1", "::1", "192.168.1.5"], 8080, false, UseColor.ColorNever, (x) => { s = x; });
  assert.equal(s, by.get("hosts"), "hosts");
  s = "";
  printURLs(["0.0.0.0"], 443, true, UseColor.ColorNever, (x) => { s = x; });
  assert.equal(s, by.get("https"), "https");
});
