// 第 85 轮：serviceType channel 状态机（getActiveBuild/create/destroy/sendPacket）共享 harness
// Go 探针 tmpgen_service_test.go 一次覆盖 10 行，固化 testdata/service-state-go.json。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as sp from "./stdio_protocol.ts";
import { activeBuild, serviceType, encodeErrorPacket } from "./service.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/service-state-go.json", import.meta.url)));
const SHA = "61f1ecf2beeca6f9e7e1cab51329015606225fb9333969aa830611dd0311ddf3";
const fx = JSON.parse(new TextDecoder().decode(raw)) as { rows: { name: string; out: string }[] };
const by = Object.fromEntries(fx.rows.map((r) => [r.name, r.out]));
const hx = (b: Uint8Array) => Buffer.from(b).toString("hex");

test("service-state 共享 harness 夹具 sha256", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("serviceType activeBuild 生命周期 + sendPacket 逐字节等于 Go（10 例共享 harness）", () => {
  const s = new serviceType();
  assert.equal(s.getActiveBuild(5) === null ? "00" : "01", by["get-empty"]);
  const b = s.createActiveBuild(5);
  assert.equal((s.getActiveBuild(5) !== null && b !== null) ? "01" : "00", by["create-then-get"]);
  assert.equal(s.getActiveBuild(6) === null ? "00" : "01", by["get-other-key"]);
  s.destroyActiveBuild(5);
  assert.equal(s.getActiveBuild(5) === null ? "00" : "01", by["get-after-destroy"]);
  s.createActiveBuild(7);
  s.createActiveBuild(8);
  assert.equal((s.getActiveBuild(7) !== null && s.getActiveBuild(8) !== null) ? "01" : "00", by["get-7-and-8"]);
  s.destroyActiveBuild(7);
  assert.equal(
    (s.getActiveBuild(7) === null ? "00" : "01") + (s.getActiveBuild(8) !== null ? "01" : "00"),
    by["get-7-after-destroy-8-alive"],
  );

  const s2 = new serviceType();
  s2.sendPacket(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  assert.equal(hx(s2.outgoingPackets.shift()!), by["sendPacket-bytes"]);
  s2.sendPacket(encodeErrorPacket(3, "boom"));
  assert.equal(hx(s2.outgoingPackets.shift()!), by["sendPacket-error-packet"]);
  assert.equal(s2.nextRequestID.toString(16), by["sendRequest-id-start"]);

  const s3 = new serviceType();
  assert.equal(s3.nextRequestID.toString(16), by["sendRequest-before-id"]);
  // sendRequest: 分配 id、sendPacket、mock callback 注入 response 后返回（Go 探针用 goroutine 喂 callback）
  const res = s3.sendRequest({ command: "ping" }, by["sendRequest-result"]);
  assert.equal(res, by["sendRequest-result"]);
  assert.equal(s3.nextRequestID.toString(16), by["sendRequest-after-id"]);
  assert.equal(hx(s3.outgoingPackets.shift()!).length > 0, true);
});

test("handleIncomingPacket dispatch 错误分支逐字节等于 Go（6 例共享 harness）", () => {
  const s = new serviceType();
  const dispatch = (command: string, key: number): string => {
    // Go 探针用 encodePacket(...)[4:] 作输入；TS encodePacket 字节与 Go 一致（第 82 轮验证）
    const body = sp.encodePacket({ id: 7, isRequest: true, value: { command, key } }).slice(4);
    s.handleIncomingPacket(body);
    let out = "";
    while (s.outgoingPackets.length) out += hx(s.outgoingPackets.shift()!);
    return out;
  };
  assert.equal(dispatch("bogus", 0), by["dispatch-invalid-cmd"]);
  assert.equal(dispatch("resolve", 1), by["dispatch-resolve-inactive"]);
  assert.equal(dispatch("rebuild", 1), by["dispatch-rebuild-inactive"]);
  assert.equal(dispatch("watch", 1), by["dispatch-watch-inactive"]);
  assert.equal(dispatch("cancel", 1), by["dispatch-cancel-inactive"]);
  assert.equal(dispatch("dispose", 1), by["dispatch-dispose-inactive"]);
});

