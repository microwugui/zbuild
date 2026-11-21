// 1:1 移植自 esbuild internal/test/util.go（v0.28.2，commit f6058f83）
// 三个测试辅助函数。Go 的 *testing.T 在 TS 侧用 node:assert 表达等价语义：observed !== expected 时失败。
// AssertEqualWithDiff 复用本包 diff()，颜色由 CheckIfWindows() 反向决定（与 Go 同）。
import assert from "node:assert/strict";
import { Path, PrettyPaths, Source } from "../logger/logger.ts";
import { checkIfWindows } from "../fs/iswin.ts";
import { diff } from "./diff.ts";

/** Go: func AssertEqual(t *testing.T, observed interface{}, expected interface{}) (util.go:11) */
export function AssertEqual(observed: unknown, expected: unknown): void {
  assert.equal(observed, expected);
}

/** Go: func AssertEqualWithDiff(t *testing.T, observed interface{}, expected interface{}) (util.go:18) */
export function AssertEqualWithDiff(observed: unknown, expected: unknown): void {
  if (observed !== expected) {
    const stringA = String(observed);
    const stringB = String(expected);
    const color = !checkIfWindows();
    throw new Error("\n" + diff(stringB, stringA, color));
  }
}

/** Go: func SourceForTest(contents string) logger.Source (util.go:28) */
export function SourceForTest(contents: string): Source {
  const s = new Source();
  s.Index = 0;
  s.KeyPath = new Path(); s.KeyPath.Text = "<stdin>";
  s.PrettyPaths = new PrettyPaths(); s.PrettyPaths.Abs = "<stdin>"; s.PrettyPaths.Rel = "<stdin>";
  s.Contents = new TextEncoder().encode(contents);
  s.IdentifierName = "stdin";
  return s;
}
