// 第 44 轮叶子优先规划：CLI 参数解析（Go 探针字节证据）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isBoolFlag, parseBoolFlag, splitWithEmptyCheck, parseLogLevel, parseLogStyle } from "./cli_impl.ts";

const FIXTURE = new URL("../../../testdata/cli-impl-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "811fb0285ab2e0222c000721a041eef16e5d26092a758d879ec2b18ef48896b4";

interface Row { fn: string; arg: string; out: string; }

test("CLI 参数解析：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "cli-impl fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const m = r.arg.match(/^\[(.*) (.*)\]$/);
    const [a, b] = m ? [m[1], m[2]] : [r.arg, ""];
    let got: string;
    switch (r.fn) {
      case "isBoolFlag": got = String(isBoolFlag(a, b)); break;
      case "parseBoolFlag": { const v = parseBoolFlag(r.arg, r.arg === "--flag"); got = `${v.value}|${v.err === null ? "nil" : v.err.Text}`; break; }
      case "splitWithEmptyCheck": got = `[${splitWithEmptyCheck(a, b).join(" ")}]`; break;
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} ${r.arg}`);
  }
});

const F2 = new URL("../../../testdata/cli-log-go.json", import.meta.url);
const b2 = new Uint8Array(readFileSync(F2));
const S2 = "4ff57bfc71324b0c42191c8c0a2e4f70b0bac015552a6914e956c4f7df09bf00";
interface Row2 { fn: string; arg: string; out: string; }

test("CLI log 解析：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(b2).digest("hex"), S2, "cli-log fixture sha256");
  const rows: Row2[] = JSON.parse(new TextDecoder().decode(b2));
  for (const r of rows) {
    const v = r.fn === "parseLogLevel" ? parseLogLevel(r.arg, `--log-level=${r.arg}`) : parseLogStyle(r.arg, `--log-style=${r.arg}`);
    assert.equal(`${v.value}|${v.err === null ? "nil" : v.err.Text}`, r.out, `${r.fn} ${r.arg}`);
  }
});
