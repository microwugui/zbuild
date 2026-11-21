// 对应 esbuild internal/logger/msg_ids.go 的差分测试。
//
// 期望值来源：`testdata/msgids.json`，由一次性 Go 生成器 `tmpmsgidgen` 产出（已删）：
// 它用 go/ast 解析 msg_ids.go 的 iota 常量块拿到「常量名 → 值」，再对本包导出函数
// `MsgIDToString(id)` 逐个回读「ID → 外部名字」，最后把 StringToMsgIDs 的 case 表
// 与 package.json / tsconfig.json 的区间赋值一并打出来。
// 所以这里的比对是**全量**的（72 个 ID + 54 条 case + 2 个区间），不是抽样。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import * as ids from "./msg_ids.ts";
import { MsgIDToString, StringToMaximumMsgID, StringToMsgIDs, MsgID_None } from "./msg_ids.ts";

const truth = JSON.parse(readFileSync("testdata/msgids.json", "utf8")) as {
  ids: { name: string; value: number; str: string }[];
  pairs: { str: string; id: string }[];
  ranges: { str: string; first: number; last: number }[];
};

// 夹具哈希钉死：防止「侧改夹具让它通过」（生成器见 tools/gen_msg_ids.go）
test("msgids 夹具未被侧改（sha256）", () => {
  const hash = createHash("sha256").update(readFileSync("testdata/msgids.json")).digest("hex");
  assert.equal(hash, "575551aff1eb58c59fcc9a8523279b14161bc753832842ed587e8b78c28f6f38");
});

test("msg_ids: 常量名→值 与 Go 的 iota 块逐条相等（72 个）", () => {
  assert.equal(truth.ids.length, 72);
  assert.equal(ids.MsgID_END + 1, truth.ids.length);
  for (const row of truth.ids) {
    assert.equal((ids as unknown as Record<string, number>)[row.name], row.value, row.name);
  }
});

test("msg_ids: 每个 ID 的 MsgIDToString 与 Go 回读全等（含 package.json/tsconfig.json 折叠）", () => {
  for (const row of truth.ids) assert.equal(MsgIDToString(row.value), row.str, row.name);
  // 区间段的所有 ID 折叠成同一个名字
  assert.equal(MsgIDToString(ids.MsgID_PackageJSON_DeadCondition), "package.json");
  assert.equal(MsgIDToString(ids.MsgID_TSConfigJSON_Cycle), "tsconfig.json");
  // 未知 ID 返回空字符串（Go: msgIDInfo{} 的零值）
  assert.equal(MsgIDToString(ids.MsgID_END), "");
  assert.equal(MsgIDToString(200), "");
});

test("StringToMsgIDs: 54 条 case 与 Go 逐条相等", () => {
  for (const p of truth.pairs) {
    const overrides = new Map<number, number>();
    StringToMsgIDs(p.str, 4, overrides);
    assert.deepEqual([...overrides.entries()], [[(ids as unknown as Record<string, number>)[p.id], 4]], p.str);
  }
});

test("StringToMsgIDs: package.json / tsconfig.json 区间赋值", () => {
  for (const range of truth.ranges) {
    const overrides = new Map<number, number>();
    StringToMsgIDs(range.str, 5, overrides);
    const expected: [number, number][] = [];
    for (let i = range.first; i <= range.last; i++) expected.push([i, 5]);
    assert.deepEqual([...overrides.entries()], expected, range.str);
  }
});

test("StringToMsgIDs: 未知名字不写任何条目（Go 的 default 分支）", () => {
  const overrides = new Map<number, number>();
  StringToMsgIDs("no-such-message-id", 4, overrides);
  assert.equal(overrides.size, 0);
});

test("StringToMaximumMsgID: 取区间最大值 / 单条 ID / 未知", () => {
  assert.equal(StringToMaximumMsgID("package.json"), ids.MsgID_PackageJSON_LAST);
  assert.equal(StringToMaximumMsgID("tsconfig.json"), ids.MsgID_TSConfigJSON_LAST);
  assert.equal(StringToMaximumMsgID("bigint"), ids.MsgID_JS_BigInt);
  assert.equal(StringToMaximumMsgID("no-such-message-id"), MsgID_None);
});
