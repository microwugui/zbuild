// helpers/path.go 的 Go 实测差分测试。
//
// 期望值由 `tools/gen_helpers_path_fixture.go` 生成（常驻生成器）：
//   cd /root/esbuild && go run ./tmpgenpath > /root/port/testdata/helpers-path.json
// 夹具 sha256 钉死在下方（PIN_SHA256）；不一致即说明夹具被改过。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { IsInsideNodeModules } from "./path.ts";

const PIN_SHA256 = "b095ff2b2d1f6f6efeb682c65bdd0090f33c12e44389821d0b4c6d4d9b55404f";

const cases: { in: string; out: boolean }[] = JSON.parse(
  readFileSync(new URL("../../../testdata/helpers-path.json", import.meta.url), "utf8"),
);

test("helpers-path 夹具 sha256 锁定", () => {
  const bytes = readFileSync(new URL("../../../testdata/helpers-path.json", import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), PIN_SHA256);
});

test("IsInsideNodeModules 与 Go 逐例相同（含 Windows / URL / 尾斜杠）", () => {
  assert.ok(cases.length >= 15, "语料不得缩水");
  for (const c of cases) {
    assert.equal(IsInsideNodeModules(c.in), c.out, `IsInsideNodeModules(${JSON.stringify(c.in)})`);
  }
});
