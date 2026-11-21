// 第 44 轮 CharFreq 底座链：computeCharacterFrequency（js_parser.go:18481）。
// byte oracle 由 Go 0.28.2 包内探针（internal/js_parser/tmpgen_charfreq_test.go，跑完即删）
// 用 MinifyIdentifiers=true + Parse 后 tree.CharFreq 的 64 个 int32 实测，
// 固化在 testdata/js_parser/charfreq-go.json。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Log, Path, Source } from "../logger/logger.ts";
import { Parse, Options } from "./js_parser.ts";

const FIXTURE = new URL("../../../testdata/js_parser/charfreq-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "a56f0a1a2d8171b04e3ae8b05d724b56f939269cc5af8fdc5b4ba79567ac0e77";

interface Row { name: string; src: string; freq: number[]; }

function freq(src: string): number[] | null {
  const s = new Source();
  s.Index = 1; // 非 runtime.SourceIndex(0)，否则 Go 返回 nil
  s.Contents = new TextEncoder().encode(src);
  s.KeyPath = new Path();
  s.KeyPath.Text = "<stdin>";
  const o = new Options();
  o.minifyIdentifiers = true;
  const r = Parse(new Log(), s, o);
  if (!r.ok || r.ast.CharFreq === null) return null;
  return [...r.ast.CharFreq.values];
}

test("CharFreq 底座链：fixture sha256 + 5 例 64 值逐项等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "charfreq fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  assert.equal(rows.length, 5, "5 例");
  for (const row of rows) {
    assert.deepEqual(freq(row.src), row.freq, `charfreq ${row.name}`);
  }
});
