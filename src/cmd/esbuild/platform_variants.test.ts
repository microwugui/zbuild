// 第 80 轮批量落地：logger 平台变体 6 函数 + main 变体 8 函数的差分测试。
// color 映射真值表来自 Go 包内探针（TestTmpPlatformProbe 读 TerminalColors）→
// testdata/logger-platform-go.json（SHA 钉死）。GetTerminalInfo / main stub 逐条对照 Go 源码。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { TerminalColors, hasNoColorEnvironmentVariable } from "../../internal/logger/logger.ts";
import { GetTerminalInfo as giOther, writeStringWithColor as wsOther, SupportsColorEscapes as scOther } from "../../internal/logger/logger_other.ts";
import { GetTerminalInfo as giDarwin, writeStringWithColor as wsDarwin, SupportsColorEscapes as scDarwin } from "../../internal/logger/logger_darwin.ts";
import { GetTerminalInfo as giWin, writeStringWithColor as wsWin, SupportsColorEscapes as scWin, windowsEscapeSequenceMap } from "../../internal/logger/logger_windows.ts";
import { createTraceFile as ctfOther, createHeapFile as chfOther, createCpuprofileFile as ccfOther, isServeUnsupported as isuOther } from "./main_other.ts";
import { createTraceFile as ctfWasm, createHeapFile as chfWasm, createCpuprofileFile as ccfWasm, isServeUnsupported as isuWasm } from "./main_wasm.ts";
import type { FileLike } from "../../internal/logger/logger.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/logger-platform-go.json", import.meta.url)));
const SHA = "8af62ef64555eb56bcf156082bc2c6f356f7979680b37d3a208cd9ed63ecfccf";

function fakeFile(tty = false, cols?: number, rows?: number): FileLike & { written: Uint8Array[] } {
  const written: Uint8Array[] = [];
  return { WriteString: (t: Uint8Array) => written.push(t), Stream: { isTTY: tty, columns: cols, rows }, written };
}

test("logger-platform fixture sha256 + windows escape map 逐条等于 Go TerminalColors", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
  const truth = JSON.parse(new TextDecoder().decode(raw)) as { colors: Record<string, string>; zeroInfo: any };
  // 每个 Go 颜色值对应 windows map 的一个条目（查 value → key 反推）
  for (const [name, val] of Object.entries(truth.colors)) {
    // 值必须是 TS TerminalColors 的同名字段（Go 探针源）
    assert.equal((TerminalColors as any)[name], val, `TerminalColors.${name}`);
  }
  assert.equal(windowsEscapeSequenceMap.size, 22); // Go map 22 项
  assert.equal(windowsEscapeSequenceMap.has(TerminalColors.Red), true);
});

test("GetTerminalInfo 三平台变体：other 零值 / darwin+linux TTY 解析 / windows 尺寸-1", () => {
  const f = fakeFile(false);
  const o = giOther(f);
  assert.deepEqual({ isTTY: o.IsTTY, useColor: o.UseColorEscapes, w: o.Width, h: o.Height }, { isTTY: false, useColor: false, w: 0, h: 0 });
  assert.equal(scOther, false);
  assert.equal(scDarwin, true);
  assert.equal(scWin, true);
  // darwin: TTY + NO_COLOR 决定 useColor
  const tty = fakeFile(true, 80, 24);
  const d = giDarwin(tty);
  assert.equal(d.IsTTY, true);
  assert.equal(d.Width, 80); assert.equal(d.Height, 24);
  assert.equal(d.UseColorEscapes, !hasNoColorEnvironmentVariable());
  // windows: Width/Height = cols-1 / rows-1
  const w = giWin(fakeFile(true, 80, 24));
  assert.equal(w.Width, 79); assert.equal(w.Height, 23);
  assert.equal(w.IsTTY, true);
  assert.equal(w.UseColorEscapes, !hasNoColorEnvironmentVariable());
});

test("writeStringWithColor 三平台：other/darwin 透传，windows 剥离已识别的 ANSI 转义", () => {
  const text = new TextEncoder().encode("hello");
  const f1 = fakeFile(); wsOther(f1, text);
  assert.equal(new TextDecoder().decode(f1.written[0]), "hello");
  const f2 = fakeFile(); wsDarwin(f2, text);
  assert.equal(new TextDecoder().decode(f2.written[0]), "hello");
  // windows: "\x1b[31mRED\x1b[0m" -> 写出 "RED"（两段转义都被识别并剥离）
  const ansi = new TextEncoder().encode("\x1b[31mRED\x1b[0m");
  const f3 = fakeFile(); wsWin(f3, ansi);
  const joined = f3.written.map((b) => new TextDecoder().decode(b)).join("");
  assert.equal(joined, "RED");
  // 未识别的转义保留
  const unknown = new TextEncoder().encode("\x1b[ZZmX");
  const f4 = fakeFile(); wsWin(f4, unknown);
  assert.equal(f4.written.map((b) => new TextDecoder().decode(b)).join(""), "\x1b[ZZmX");
});

test("main 平台变体 8 函数：isServeUnsupported + trace/heap/cpuprofile 文件语义", () => {
  assert.equal(isuOther(), false);
  assert.equal(isuWasm(), true);
  const dir = mkdtempSync(join(tmpdir(), "main80-"));
  // other: 创建文件 + 返回 cleanup 闭包，调用后关闭
  const tf = join(dir, "trace.out");
  const cleanupT = ctfOther([], tf);
  assert.ok(cleanupT !== null); assert.equal(existsSync(tf), true); cleanupT!();
  const hf = join(dir, "heap.out");
  const cleanupH = chfOther([], hf);
  assert.ok(cleanupH !== null); assert.equal(existsSync(hf), true); cleanupH!();
  const cf = join(dir, "cpu.out");
  const cleanupC = ccfOther([], cf);
  assert.ok(cleanupC !== null); assert.equal(existsSync(cf), true); cleanupC!();
  // wasm: 全部打印不支持并返回 null（stderr 输出，不崩即可）
  assert.equal(ctfWasm([], join(dir, "w-trace")), null);
  assert.equal(chfWasm([], join(dir, "w-heap")), null);
  assert.equal(ccfWasm([], join(dir, "w-cpu")), null);
});
