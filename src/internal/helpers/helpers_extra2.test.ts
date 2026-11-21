// O 批（第 26 轮）：helpers 的 dataurl / mime / path / glob 子集。
//
// 期望值全部来自 Go 探针 `/root/esbuild/tmpgenhelpers2`（临时程序，跑完即删）：
// 直接调用 `internal/helpers` 的真实函数，把 `(fn, args, out, ok)` 写成 JSON。
// 下面的 sha256 钉死这份 fixture，防止它被手改。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { EncodeStringAsPercentEscapedDataURL, EncodeStringAsShortestDataURL } from "./dataurl.ts";
import { MimeTypeByExtension } from "./mime.ts";
import { FilePathFromFileURL, FileURLFromFilePath, IsFileURL } from "./path.ts";
import { GlobPatternToString, ParseGlobPattern } from "./glob.ts";

interface Entry {
  fn: string;
  args: string[];
  out: string;
  ok: boolean;
  outB64?: string;
}

test("O 批：dataurl / mime / path / glob 与 Go 探针逐字节一致", () => {
  const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/helpers-extra2.json", import.meta.url)));
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "141a5ce4f01808cdd96154fc152b20e96b35759dd8d2904d20570590db61d197",
  );

  const entries: Entry[] = JSON.parse(new TextDecoder().decode(bytes));
  const seen = new Set<string>();

  for (const e of entries) {
    seen.add(e.fn);
    // outB64 是权威值（Go 的 string 是字节串）；out 只是同一内容的可读副本
    const want = e.outB64 !== undefined ? Buffer.from(e.outB64, "base64").toString("utf8") : e.out;
    const argsText = JSON.stringify(e.args);

    switch (e.fn) {
      case "EncodeStringAsShortestDataURL":
        assert.equal(
          EncodeStringAsShortestDataURL(e.args[0], new TextEncoder().encode(e.args[1])),
          want,
          argsText,
        );
        break;

      case "EncodeStringAsPercentEscapedDataURL": {
        const got = EncodeStringAsPercentEscapedDataURL(e.args[0], new TextEncoder().encode(e.args[1]));
        assert.equal(got.ok, e.ok, argsText);
        assert.equal(got.value, want, argsText);
        break;
      }

      case "MimeTypeByExtension":
        assert.equal(MimeTypeByExtension(e.args[0]), want, argsText);
        break;

      case "IsFileURL":
        // Go 用 fmt.Sprint(bool) → "true"/"false"
        assert.equal(String(IsFileURL(new URL(e.args[0]))), want, argsText);
        break;

      case "FileURLFromFilePath":
        assert.equal(FileURLFromFilePath(e.args[0]).href, want, argsText);
        break;

      case "FilePathFromFileURL":
        assert.equal(FilePathFromFileURL({ Cwd: () => e.args[0] }, new URL(e.args[1])), want, argsText);
        break;

      case "ParseGlobPattern":
        // Go 侧是 %v 的结构体打印；这里只校验「至少一个元素」，回写等价由 GlobPatternToString 那一项校验
        assert.ok(ParseGlobPattern(e.args[0]).length >= 1, argsText);
        break;

      case "GlobPatternToString":
        assert.equal(GlobPatternToString(ParseGlobPattern(e.args[0])), want, argsText);
        break;

      default:
        assert.fail(`fixture 里出现未知 fn：${e.fn}`);
    }
  }

  // 8 个 Go 函数都被这份 fixture 覆盖（isHex 由含 "%25" 的用例间接触发）
  assert.deepEqual([...seen].sort(), [
    "EncodeStringAsPercentEscapedDataURL",
    "EncodeStringAsShortestDataURL",
    "FilePathFromFileURL",
    "FileURLFromFilePath",
    "GlobPatternToString",
    "IsFileURL",
    "MimeTypeByExtension",
    "ParseGlobPattern",
  ]);
});
