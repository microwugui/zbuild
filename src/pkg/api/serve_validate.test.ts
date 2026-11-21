// 第 115 轮：internalContext.Serve 的 10 个确定性参数校验分支逐字节等于 Go。
// Go 期望：tools/go/tmpgen_serve_test.go → testdata/serve-validate-go.json（SHA 413919e0…）。
// 成功路径需真实 net.Listen（时序/端口不可验），如实登记为禁止端口，不在此夹具。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Serve, type ServeCtx } from "./serve_other.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/serve-validate-go.json", import.meta.url)));
const SHA = "413919e0c1421c47ac5b008c7e8466a691e1a31d888bdcc9c7396d64aa9fb7bb";
const rows = JSON.parse(new TextDecoder().decode(raw)) as { name: string; err: string }[];

type TC = {
  name: string; disposed?: boolean; hasHandler?: boolean;
  keyfile?: string; certfile?: string; servedir?: string; fallback?: string;
  cors?: string[]; entries?: number; writeToStdout?: boolean;
  badServeDir?: boolean; badFallback?: boolean; relOverride?: boolean; relVal?: string;
};
const cases: TC[] = [
  { name: "disposed", disposed: true },
  { name: "already-enabled", hasHandler: true },
  { name: "keyfile-only", keyfile: "/k.pem" },
  { name: "certfile-only", certfile: "/c.pem" },
  { name: "bad-servedir", servedir: "/bad", badServeDir: true },
  { name: "bad-fallback", fallback: "/badfb", badFallback: true },
  { name: "bad-cors", cors: ["a*b*c"] },
  { name: "stdout-one-entry", entries: 1, writeToStdout: true },
  { name: "stdout-two-entries", entries: 2, writeToStdout: true },
  { name: "outdir-outside-servedir", servedir: "/serve", entries: 1, relOverride: true, relVal: "../out" },
];

function run(tc: TC): { name: string; err: string } {
  const badAbs = tc.badServeDir ? "/bad" : tc.badFallback ? "/badfb" : "";
  const serveFS: ServeCtx["serveFS"] = {
    Abs: (p) => (p === badAbs ? ["", false] : [p === "" ? "/" : (p.startsWith("/") ? p : "/" + p), true]),
    Rel: (base, target) => {
      if (tc.relOverride) return [tc.relVal ?? "", true];
      if (target.startsWith(base + "/")) return [target.slice(base.length + 1), true];
      if (target === base) return [".", true];
      return ["", false];
    },
    Cwd: () => "/",
  };
  const ctx = {
    didDispose: tc.disposed ?? false,
    handler: tc.hasHandler ? {} : null,
    serveFS,
    serveEntryPointCount: tc.entries ?? 0,
    serveWriteToStdout: tc.writeToStdout ?? false,
    serveAbsOutputDir: tc.writeToStdout ? "" : "/out",
  };
  const err = Serve(ctx, {
    Keyfile: tc.keyfile ?? "", Certfile: tc.certfile ?? "", Servedir: tc.servedir ?? "",
    Fallback: tc.fallback ?? "", CORS: { Origin: tc.cors ?? null },
  }) ?? "";
  return { name: tc.name, err };
}

test("serve-validate 夹具 sha256（10 场景）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("Serve 10 校验分支逐字节等于 Go", () => {
  assert.equal(rows.length, cases.length);
  for (let i = 0; i < rows.length; i++) {
    assert.deepEqual(run(cases[i]), rows[i], `scenario ${i}: ${rows[i].name}`);
  }
});
