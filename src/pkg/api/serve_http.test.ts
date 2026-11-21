// 第 115 轮：apiHandler.ServeHTTP 确定性分支逐字节等于 Go（15 场景，servedir=""）。
// Go 期望：tools/go/tmpgen_servehttp_test.go → testdata/serve-http-go.json（SHA a79989e5…）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { apiHandler, type ServeFS, type ServeRequest, type ServeResponseWriter } from "./serve_other.ts";
import type { PublicMessage } from "./api_impl.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/serve-http-go.json", import.meta.url)));
const SHA = "a79989e58336b251a73f17479d6066206265f47dfdfeb853d62944c78d287e07";
const rows = JSON.parse(new TextDecoder().decode(raw)) as {
  name: string; status: number; headers: Record<string, string>; body: string;
}[];

// 假 FS：Rel 用 /out 前缀；Ext 返回 path 扩展名；其余方法 servedir="" 分支不触发
const fakeFS: ServeFS = {
  Rel: (base, target) => {
    if (target.startsWith(base + "/")) return [target.slice(base.length + 1), true];
    if (target === base) return [".", true];
    return ["", false];
  },
  Cwd: () => "/",
  Join: (...parts) => "/" + parts.join("/").replace(/^\/+|\/+$/g, ""),
  Dir: (p) => p.slice(0, p.lastIndexOf("/")) || "/",
  Base: (p) => p.slice(p.lastIndexOf("/") + 1),
  Ext: (p) => { const b = p.slice(p.lastIndexOf("/") + 1); const i = b.lastIndexOf("."); return i < 0 ? "" : b.slice(i); },
  EvalSymlinks: (p) => [p, true],
  ReadDirectory: () => [new Map(), null],
  OpenFile: () => [new Uint8Array(0), "ENOENT"],
};

const outputs = [
  { Path: "/out/a.js", Contents: new TextEncoder().encode("console.log(1)\n") },
  { Path: "/out/sub/x.css", Contents: new TextEncoder().encode("body{color:red}") },
];
const errMsg: PublicMessage = { ID: "", PluginName: "", Text: "some build error", Location: null, Notes: [], Detail: undefined };
const errResult = { OutputFiles: [] as typeof outputs, Errors: [errMsg] };

type TC = {
  name: string; method: string; path: string; host: string;
  headers?: Record<string, string>; cors?: string[]; hosts?: string[]; errors?: boolean;
};
const cases: TC[] = [
  { name: "cors-wildcard", method: "GET", path: "/nope", host: "localhost", headers: { Origin: "https://a.com" }, cors: ["*"] },
  { name: "cors-exact", method: "GET", path: "/nope", host: "localhost", headers: { Origin: "https://a.com" }, cors: ["https://a.com"] },
  { name: "cors-prefix", method: "GET", path: "/nope", host: "localhost", headers: { Origin: "https://sub.a.com" }, cors: ["https://*.a.com"] },
  { name: "cors-nomatch", method: "GET", path: "/nope", host: "localhost", headers: { Origin: "https://evil.com" }, cors: ["https://a.com"] },
  { name: "host-forbidden", method: "GET", path: "/nope", host: "evil.com", hosts: ["localhost"] },
  { name: "host-strip-port", method: "GET", path: "/nope", host: "localhost:8000", hosts: ["localhost"] },
  { name: "backslash", method: "GET", path: "/a\\b", host: "localhost" },
  { name: "build-error", method: "GET", path: "/a.js", host: "localhost", errors: true },
  { name: "serve-file-js", method: "GET", path: "/a.js", host: "localhost" },
  { name: "head-omit", method: "HEAD", path: "/a.js", host: "localhost" },
  { name: "range", method: "GET", path: "/a.js", host: "localhost", headers: { Range: "bytes=0-4" } },
  { name: "dir-list", method: "GET", path: "/sub/", host: "localhost" },
  { name: "dir-redirect", method: "GET", path: "/sub", host: "localhost" },
  { name: "favicon", method: "GET", path: "/favicon.ico", host: "localhost", headers: { "Accept-Encoding": "gzip" } },
  { name: "not-found", method: "GET", path: "/nope", host: "localhost" },
];

function run(tc: TC): { name: string; status: number; headers: Record<string, string>; body: string } {
  const h = new apiHandler();
  h.fsObj = fakeFS;
  h.absOutputDir = "/out";
  h.corsOrigin = tc.cors ?? [];
  h.hosts = tc.hosts ?? [];
  h.rebuild = () => (tc.errors ? errResult : { OutputFiles: outputs, Errors: [] });
  const headers: Record<string, string> = {};
  let status = 200; // net/http 默认：未显式 WriteHeader 时为 200
  const chunks: number[] = [];
  const res: ServeResponseWriter = {
    headerSet: (k, v) => { headers[k] = v; },
    writeHeader: (s) => { status = s; },
    write: (b) => { for (const x of b) chunks.push(x); },
  };
  const hdr = tc.headers ?? {};
  const req: ServeRequest = {
    method: tc.method, urlPath: tc.path, host: tc.host, remoteAddr: "127.0.0.1",
    headerGet: (k) => hdr[k] ?? "",
  };
  h.ServeHTTP(res, req);
  return { name: tc.name, status, headers, body: Buffer.from(chunks).toString("base64") };
}

test("serve-http 夹具 sha256（15 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("ServeHTTP 15 场景逐字节等于 Go", () => {
  assert.equal(rows.length, cases.length);
  for (let i = 0; i < rows.length; i++) {
    assert.deepEqual(run(cases[i]), rows[i], `scenario ${i}: ${rows[i].name}`);
  }
});
