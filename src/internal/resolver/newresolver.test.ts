// 第 176 批：NewResolver（Resolver 构造器底座），Go 探针 5 例逐字节固化。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NewDeferLog, DeferLogKind } from "../logger/logger.ts";
import { MockFS, MockUnix } from "../fs/fs_mock.ts";
import { NewResolver } from "./resolver.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/newresolver-go.json", import.meta.url)));
const SHA = "4ec6a2f5f1b00e918a1c1c31882767616eec8fba7db1404447a70299cd7a462a";

test("newresolver fixture sha256 + 5 例逐字节等于 Go（Resolver 构造器）", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const a = r.arg;
    const loaderMap = new Map<string, number>();
    // extOrder ↔ loader：探针里按 CSS/JS/TS 分配，映射由 name 决定（与 Go 探针 cases 对齐）
    const loaderByExt: Record<string, number> = {
      ".js": 10, ".mjs": 10, ".ts": 16, ".css": 4, ".scss": 14,
    };
    for (const ext of a.extOrder) loaderMap.set(ext, loaderByExt[ext] ?? 0);
    const fsobj = MockFS({}, MockUnix, "/");
    const log = NewDeferLog(DeferLogKind.DeferLogAll, null);
    const opts: any = {
      Platform: a.platform, ExtensionOrder: a.extOrder, ExtensionToLoader: loaderMap,
      Conditions: a.conditions, TSConfigRaw: a.tsconfigRaw || "", TSConfigPath: "",
      JSX: { AutomaticRuntime: false, Development: false, Factory: null, Fragment: null, ImportSource: "" },
    };
    const res = NewResolver(0, fsobj, log, opts);
    const jsx = opts.JSX;
    const got = [
      res.cssExtensionOrder, res.nodeModulesExtensionOrder,
      Object.keys(res.esmConditionsDefault).sort(), Object.keys(res.esmConditionsImport).sort(), Object.keys(res.esmConditionsRequire).sort(),
      res.tsConfigOverride !== null,
      [jsx.AutomaticRuntime, jsx.Development, jsx.Factory, jsx.Fragment, jsx.ImportSource],
    ];
    assert.deepEqual(got, r.out, `${a.name}\n got ${JSON.stringify(got)}\nwant ${JSON.stringify(r.out)}`);
  }
});
