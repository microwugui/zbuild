// 对应 esbuild internal/logger/logger_linux.go 的测试。
//
// Go 侧用 ioctl(TCGETS)/ioctl(TIOCGWINSZ) 判断 TTY 与窗口尺寸；TS 侧用 Node stream 的
// isTTY/columns/rows（Node 内部就是同一组 ioctl）。期望行为：非 TTY → 全零；TTY → 带宽高，
// UseColorEscapes 取 !NO_COLOR。

import { test } from "node:test";
import assert from "node:assert/strict";

import { GetTerminalInfo, SupportsColorEscapes, writeStringWithColor } from "./logger_linux.ts";
import { hasNoColorEnvironmentVariable } from "./logger.ts";
import type { FileLike } from "./logger.ts";

test("GetTerminalInfo: 非 TTY → 全零（logger_linux.go:14-30）", () => {
  const info = GetTerminalInfo({ WriteString() {} });
  assert.deepEqual([info.IsTTY, info.UseColorEscapes, info.Width, info.Height], [false, false, 0, 0]);
});

test("GetTerminalInfo: TTY → IsTTY + 宽高；缺 columns/rows 时按 0（ioctl 失败路径）", () => {
  assert.equal(SupportsColorEscapes, true);

  const info = GetTerminalInfo({ WriteString() {}, Stream: { isTTY: true, columns: 100, rows: 40 } });
  assert.equal(info.IsTTY, true);
  assert.equal(info.UseColorEscapes, !hasNoColorEnvironmentVariable());
  assert.deepEqual([info.Width, info.Height], [100, 40]);

  const partial = GetTerminalInfo({ WriteString() {}, Stream: { isTTY: true } });
  assert.deepEqual([partial.IsTTY, partial.Width, partial.Height], [true, 0, 0]);
});

test("writeStringWithColor: 转给 file.WriteString（linux 版没有颜色处理）", () => {
  const chunks: Uint8Array[] = [];
  const file: FileLike = { WriteString: (text) => chunks.push(text) };
  writeStringWithColor(file, new TextEncoder().encode("abc"));
  assert.equal(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString(), "abc");
});
