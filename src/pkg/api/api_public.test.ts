// 第 86 轮：api.go 公开薄包装 FormatMessages/AnalyzeMetafile —— 转发到已逐字节验证的 impl。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { FormatMessages, AnalyzeMetafile } from "./api.ts";
import { formatMsgsImpl, analyzeMetafileImpl } from "./api_impl.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/api-format-go.json", import.meta.url)));
const SHA = "9a82ae2d7d761825d7776bf8e8c8cba1488c3ad573397ce65be58941e84add89";

test("公开薄包装转发正确（impl 已由 api_format.test.ts 逐字节对齐 Go）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(raw));
  const msgs = [
    { ID: "", PluginName: "", Text: "simple error", Location: null, Notes: [], Detail: null },
    { ID: "", PluginName: "", Text: "with note", Location: null, Notes: [{ Text: "note one", Location: null }], Detail: null },
  ] as any;
  for (const style of [0, 1, 2]) {
    assert.deepEqual(
      FormatMessages(msgs, { Kind: 0, Color: false, TerminalWidth: 80, LogStyle: style }),
      formatMsgsImpl(msgs, { Kind: 0, Color: false, TerminalWidth: 80, LogStyle: style }),
    );
  }
  for (const mf of ["{}", "{\"outputs\":{\"out.js\":{\"entryPoint\":\"a.js\",\"bytes\":10,\"inputs\":{\"a.js\":{\"bytesInOutput\":10}}}}}"]) {
    for (const verbose of [false, true]) {
      assert.equal(
        AnalyzeMetafile(mf, { Color: false, Verbose: verbose }),
        analyzeMetafileImpl(mf, { Color: false, Verbose: verbose }),
      );
    }
  }
});
