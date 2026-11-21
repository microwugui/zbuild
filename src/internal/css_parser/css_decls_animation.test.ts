// 第 44 轮叶子优先规划：CSS 动画名判定真值表（Go 探针固化）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isInvalidAnimationName } from "./css_decls_animation.ts";

const FIXTURE = new URL("../../../testdata/css-animation-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "9cbaf263c23b57891aec0e67e0cdc1907f047e934da3fd0cdecb3d5504caf6f1";

test("CSS 动画名判定：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-animation fixture sha256");
  const rows: { text: string; out: string }[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    assert.equal(String(isInvalidAnimationName(r.text)), r.out, `isInvalidAnimationName(${r.text})`);
  }
});
