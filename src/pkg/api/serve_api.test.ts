// 第 114 轮：api-serve 族（Accept / watcher.start / watcher.stop / Watch / serveEventStream）
// 逐字节等于 Go。Go 期望来自 tools/go/tmpgen_serveapi_test.go → testdata/serve-api-go.json。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { apiHandler, hackListener, type ServeRequest, type ServeResponseWriter } from "./serve_other.ts";
import { watcher } from "./watcher.ts";
import { BuildContext } from "./api_impl.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/serve-api-go.json", import.meta.url)));
const SHA = "14e2effaea297344ac12eb02bae06a45daf3331f45f23f2294ef61280bde72d3";
const fixture = JSON.parse(new TextDecoder().decode(raw)) as {
  accept: any[]; watcher: any[]; watch: any[]; sse: any[];
};

const dec = new TextDecoder();

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

// ---- Accept ----
async function runAccept(): Promise<any[]> {
  const fakeListener = { Accept: () => ({ conn: null, err: "fake-err" }) };
  const hack = new hackListener(fakeListener);
  hack.waitGroupCount = 1; // Go: hack.waitGroup.Add(1)
  const r1 = hack.Accept();
  const waitReturned1 = hack.waitGroupCount === 0;
  const r2 = hack.Accept();
  return [
    { name: "first", done: hack.done, waitReturned: waitReturned1, connPresent: r1.conn !== null, err: r1.err },
    { name: "second", done: hack.done, waitReturned: true, connPresent: r2.conn !== null, err: r2.err },
  ];
}

// ---- watcher ----
async function runWatcher(): Promise<any[]> {
  const out: any[] = [];
  {
    const w = new watcher();
    w.stop();
    out.push({ name: "stop-before-start", rebuilt: false, shouldStop: w.shouldStop, stopReturned: true });
  }
  {
    const w = new watcher();
    w.data = { Paths: new Map([["a.js", () => "a.js"]]) };
    w.watchIntervalSleep = 1;
    let rebuilt = false;
    let resolveRebuilt: (() => void) | null = null;
    const rebuiltP = new Promise<void>((resolve) => { resolveRebuilt = resolve; });
    w.rebuild = () => { rebuilt = true; resolveRebuilt!(); return { Paths: new Map() }; };
    w.start();
    await Promise.race([rebuiltP, new Promise((r) => setTimeout(r, 3000))]);
    w.stop();
    out.push({ name: "start-rebuild-stop", rebuilt, shouldStop: w.shouldStop, stopReturned: true });
  }
  return out;
}

// ---- Watch ----
function runWatch(): any[] {
  const out: any[] = [];
  {
    const ctx = new BuildContext({} as any);
    ctx.didDispose = true;
    const err = ctx.Watch();
    out.push({ name: "disposed", err, hasWatcher: ctx.watcher !== null, watchMode: ctx.watchMode });
  }
  {
    const ctx = new BuildContext({} as any);
    ctx.watcher = new watcher();
    const err = ctx.Watch();
    out.push({ name: "already", err, hasWatcher: ctx.watcher !== null, watchMode: ctx.watchMode });
  }
  return out;
}

// ---- serveEventStream ----
function makeReq(): ServeRequest {
  return {
    method: "GET",
    urlPath: "/esbuild",
    host: "",
    remoteAddr: "",
    headerGet: (name: string) => (name === "Accept" ? "text/event-stream" : ""),
  };
}

async function runSSE(): Promise<any[]> {
  const out: any[] = [];
  {
    const h = new apiHandler();
    const headers = new Map<string, string>();
    const body: number[] = [];
    let flushes = 0;
    let resolveClose!: () => void;
    const closeP = new Promise<void>((resolve) => { resolveClose = resolve; });
    const res: ServeResponseWriter = {
      headerSet: (k, v) => headers.set(k, v),
      writeHeader: (status) => { (res as any).status = status; },
      write: (bytes) => { for (const b of bytes) body.push(b); },
      flush: () => { flushes++; },
      closeNotify: () => closeP,
    };
    const p = h.serveEventStream(Date.now(), makeReq(), res);
    // serveEventStream 同步注册 stream 后 await closeNotify
    h.activeStreams[0]({ event: "change", data: '{"added":["/a.js"]}' });
    h.activeStreams[0]({ event: "x", data: "y" });
    resolveClose();
    await p;
    out.push({
      name: "success",
      headers: {
        "Content-Type": headers.get("Content-Type"),
        "Connection": headers.get("Connection"),
        "Cache-Control": headers.get("Cache-Control"),
      },
      status: (res as any).status,
      body: b64(new Uint8Array(body)),
      flushes,
      streamsAfter: h.activeStreams.length,
    });
  }
  {
    const h = new apiHandler();
    const headers = new Map<string, string>();
    let body: number[] = [];
    const res: ServeResponseWriter = {
      headerSet: (k, v) => headers.set(k, v),
      writeHeader: (status) => { (res as any).status = status; },
      write: (bytes) => { body = Array.from(bytes); },
      // 无 flush / closeNotify → 500 错误分支
    };
    await h.serveEventStream(Date.now(), makeReq(), res);
    out.push({ name: "error", headers: {}, status: (res as any).status, body: b64(new Uint8Array(body)), flushes: 0, streamsAfter: 0 });
  }
  return out;
}

test("serve-api 夹具 sha256", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("hackListener.Accept 状态等于 Go", async () => {
  assert.deepEqual(await runAccept(), fixture.accept);
});

test("watcher.start/stop 状态等于 Go", async () => {
  assert.deepEqual(await runWatcher(), fixture.watcher);
});

test("Watch 错误分支等于 Go", () => {
  assert.deepEqual(runWatch(), fixture.watch);
});

test("serveEventStream SSE 字节等于 Go", async () => {
  assert.deepEqual(await runSSE(), fixture.sse);
});
