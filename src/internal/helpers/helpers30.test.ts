// O 批 helpers（第 30 轮）：Serializer / ThreadSafeWaitGroup / Timer。
// 期望值来自包内临时探针 tmpgen30_test.go（4 例，sha256 86ae5e4b…），用固定时钟保证 0ms 确定。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Log, Msg } from "../logger/logger.ts";
import { MakeSerializer } from "./serializer.ts";
import { MakeThreadSafeWaitGroup } from "./waitgroup.ts";
import { Timer } from "./timer.ts";

const bytes = readFileSync(new URL("../../../testdata/helpers30-probe.json", import.meta.url));
assert.equal(
  createHash("sha256").update(bytes).digest("hex"),
  "86ae5e4b39bb867ccd0c54762fbb01c1e35916811739c4ace955513e9d6deec2",
);
const rows: { name: string; in: string; out: unknown }[] = JSON.parse(new TextDecoder().decode(bytes));

test("O-30：helpers 的 Serializer / WaitGroup / Timer 与 Go 探针逐项一致", () => {
  // Serializer：Enter/Leave 顺序
  const s = MakeSerializer(3);
  const seq: string[] = [];
  s.Enter(0); seq.push("enter0"); s.Leave(0); seq.push("leave0");
  s.Enter(1); seq.push("enter1"); s.Leave(1); seq.push("leave1");
  s.Enter(2); seq.push("enter2"); s.Leave(2); seq.push("leave2");
  assert.deepEqual(seq, rows.find((r) => r.name === "Serializer")!.out);

  // WaitGroup：Add(2) Done Done Wait —— 不抛错即可
  const wg = MakeThreadSafeWaitGroup();
  wg.Add(2); wg.Done(); wg.Done(); wg.Wait();
  assert.equal(wg.counter, 0);
  assert.throws(() => MakeThreadSafeWaitGroup().Add(-1), /negative WaitGroup counter/);
  assert.equal(rows.find((r) => r.name === "WaitGroup")!.out, "ok");

  // Timer：固定时钟 → 0ms，嵌套 + Fork/Join
  const timer = new Timer();
  timer.now = () => 1000;
  timer.Begin("a"); timer.Begin("b"); timer.End("b"); timer.End("a");
  const fork = timer.Fork()!;
  fork.Begin("c"); fork.End("c");
  timer.Join(fork);
  const log = new Log();
  const got: { text: string; notes: string[] }[] = [];
  log.AddMsg = (m: Msg) => got.push({ text: m.Data.Text, notes: m.Notes.map((n) => n.Text) });
  timer.Log(log);
  assert.deepEqual(got, rows.find((r) => r.name === "Timer" && r.in === "nested+fork+join")!.out);

  // nil 安全：TS 没有 nil receiver，但空 Timer 的 Begin/End/Join(null)/Log 不抛错
  const nt = new Timer();
  nt.Begin("x"); nt.End("x"); nt.Join(null); nt.Log(new Log());
  assert.equal(rows.find((r) => r.name === "Timer" && r.in === "nil-safe")!.out, "ok");
});
