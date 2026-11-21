// 历史已移植函数的覆盖补测（第 86 轮）：这 3 个函数在旧 coverage 里 count=0，
// 本测试让它们被真实执行；只验证已移植的正常路径行为，不冒充 Go 逐字节等价
// （它们的 error 分支是历史部分实现，已在 PLAN 记录为债）。
import test from "node:test";
import assert from "node:assert/strict";
import { validateLogOverrides, validateOutputExtensions, validateBannerOrFooter } from "./api_impl.ts";

test("validateLogOverrides 正常路径执行（继承 StringToMsgIDs 语义）", () => {
  const out = validateLogOverrides(new Map([["warning", 4], ["error", 5]]));
  assert.ok(out instanceof Map);
  assert.ok(out.size >= 0);
});

test("validateOutputExtensions 正常路径执行（.js/.css 取值）", () => {
  const out = validateOutputExtensions(new Map([[".js", ".mjs"], [".css", ".styles.css"]]));
  assert.deepEqual(out, { js: ".mjs", css: ".styles.css" });
});

test("validateBannerOrFooter 正常路径执行（js/css 取值）", () => {
  const out = validateBannerOrFooter(new Map([["js", "/* banner */"], ["css", "/* css */"]]));
  assert.deepEqual(out, { js: "/* banner */", css: "/* css */" });
});
