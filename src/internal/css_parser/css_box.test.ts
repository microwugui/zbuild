// 第 96 轮叶子优先规划：unitSafetyTracker 助手（Go 探针固化）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Token } from "../css_ast/css_ast.ts";
import { unitSafetyTracker } from "./css_decls_box.ts";

const FIXTURE = new URL("../../../testdata/css-box-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "c7cda68333319a07e4452bb0122657b4e43a5164414eb9aa4a9f1b9939322651";

interface Row { fn: string; arg: string; out: string; }

test("css-box fixture sha256 + 13 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "css-box fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    if (r.fn === "isSafeWith") {
      const p = r.arg.split("|");
      const a = new unitSafetyTracker(); a.status = Number(p[0]); a.unit = p[1];
      const b = new unitSafetyTracker(); b.status = Number(p[2]); b.unit = p[3];
      got = String(a.isSafeWith(b));
    } else if (r.fn === "includeUnitOf") {
      const pairs: [number, string][] = JSON.parse(r.arg);
      const t = new unitSafetyTracker();
      for (const [kind, text] of pairs) { const tk = new Token(); tk.Kind = kind; tk.Text = text; tk.UnitOffset = Math.max(0, text.length - 2); t.includeUnitOf(tk); }
      got = `${t.status}|${t.unit}`;
    } else throw new Error(`unknown ${r.fn}`);
    assert.equal(got, r.out, `${r.fn}(${r.arg})`);
  }
  assert.equal(rows.length, 13);
});
