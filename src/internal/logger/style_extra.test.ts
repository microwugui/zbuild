// 第 84 轮：msgToStringClang / writeMsgDataClang / msgToStringVisualStudio 差分
// （Go 探针固化 testdata/logger/style-extra-go.json）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Msg, MsgData, MsgLocation, OutputOptions, PrettyPaths, TerminalInfo, UseColor } from "./logger.ts";
import { LogStyle } from "./logger.ts";
import { msgToStringClang } from "./style_clang.ts";
import { msgToStringVisualStudio, VSID } from "./style_visualstudio.ts";

const raw = readFileSync("testdata/logger/style-extra-go.json");
const SHA = "157252d6d8f37d4eaba5f72593242d7ec5443d6edbedb5240a87f9c718b07625";
const fx = JSON.parse(raw.toString("utf8")) as {
  vsids: number[];
  cases: {
    name: string; kind: string; id: number; text: string;
    line: number; column: number; length: number; lineText: string; suggestion: string;
    notes: string[]; useColor: boolean; width: number; pathStyle: string; hasLocation: boolean;
    clangHex: string; visualStudioHex: string;
  }[];
};

const hx = (b: Uint8Array) => Buffer.from(b).toString("hex");
function pathStyle(s: string): number { return s === "abs" ? 1 : 0; }

test("style-extra 夹具 sha256 + VSID 表", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA, "fixture sha256");
  assert.deepEqual(VSID, fx.vsids, "VSID 表逐项等于 Go");
});

test("clang + visualstudio 逐字节等于 Go（8 例）", () => {
  for (const c of fx.cases) {
    const msg = new Msg();
    msg.Kind = c.kind === "error" ? 0 : c.kind === "note" ? 3 : 1;
    msg.ID = c.id;
    const data = new MsgData();
    data.Text = c.text;
    if (c.hasLocation) {
      const loc = new MsgLocation();
      loc.File = new PrettyPaths();
      loc.File.Rel = "src/input.js";
      loc.File.Abs = "/abs/src/input.js";
      loc.LineText = Buffer.from(c.lineText, "utf8");
      loc.Line = c.line;
      loc.Column = c.column;
      loc.Length = c.length;
      loc.Suggestion = c.suggestion;
      data.Location = loc;
    }
    msg.Data = data;
    for (const nt of (c.notes ?? [])) { const d = new MsgData(); d.Text = nt; msg.Notes.push(d); }

    const options = new OutputOptions();
    options.PathStyle = pathStyle(c.pathStyle);
    options.LogStyle = LogStyle.StyleClang;
    const terminalInfo = new TerminalInfo();
    terminalInfo.Width = c.width;
    terminalInfo.UseColorEscapes = c.useColor;

    assert.equal(hx(msgToStringClang(msg, options, terminalInfo)), c.clangHex, `${c.name} clang`);
    assert.equal(hx(msgToStringVisualStudio(msg, options, terminalInfo)), c.visualStudioHex, `${c.name} visualstudio`);
    // 顺带验证 Msg.String 的三风格 dispatch 已接通（不再抛错）
    options.LogStyle = LogStyle.StyleClang;
    assert.equal(hx(msg.String(options, terminalInfo)), c.clangHex, `${c.name} String(clang)`);
    options.LogStyle = LogStyle.StyleVisualStudio;
    assert.equal(hx(msg.String(options, terminalInfo)), c.visualStudioHex, `${c.name} String(visualstudio)`);
  }
});
