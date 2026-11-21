// sourcemap 包的 Go 实测差分：期望值来自包内临时探针 tmpgenprobe_test.go
// （52 例，sha256 9cf613782fbdc034a07cf21c9784ef2302d6797b7bc8f82720b69976f76437e8）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  encodeVLQ, DecodeVLQ, DecodeVLQUTF16, LineColumnOffset, SourceMapPieces, SourceMapShift,
  SourceMapState, MappingsBuffer, AppendSourceMapChunk, appendMappingToBuffer,
  GenerateLineOffsetTables, SourceMap, Mapping, ChunkBuilder, MakeChunkBuilder,
} from "./sourcemap.ts";
import { Joiner } from "../helpers/joiner.ts";
import { MakeIndex32 } from "../ast/ast.ts";
import { Loc } from "../logger/logger.ts";

const bytes = readFileSync(new URL("../../../testdata/sourcemap-probe.json", import.meta.url));
assert.equal(
  createHash("sha256").update(bytes).digest("hex"),
  "9cf613782fbdc034a07cf21c9784ef2302d6797b7bc8f82720b69976f76437e8",
);

interface Row { name: string; in: unknown; out: unknown }
const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
const enc = new TextEncoder();
const utf8 = (b: number[] | Uint8Array): string => Buffer.from(b).toString("utf8");

function makeFindMap(): SourceMap {
  const sm = new SourceMap();
  for (const s of [[0, 0, 0, 0, 0], [0, 10, 0, 1, 2], [2, 0, 1, 3, 4]]) {
    const m = new Mapping();
    m.GeneratedLine = s[0]; m.GeneratedColumn = s[1]; m.SourceIndex = s[2];
    m.OriginalLine = s[3]; m.OriginalColumn = s[4];
    sm.Mappings.push(m);
  }
  return sm;
}

test("sourcemap：52 例 Go 实测差分（19 个函数）", () => {
  let finalizeCall = 0;
  for (const r of rows) {
    switch (r.name) {
      case "encodeVLQ":
        assert.equal(utf8(encodeVLQ([], r.in as number)), r.out, `encodeVLQ ${r.in}`);
        break;
      case "DecodeVLQ":
        assert.deepEqual(DecodeVLQ(enc.encode(r.in as string), 0), r.out, `DecodeVLQ ${r.in}`);
        break;
      case "DecodeVLQUTF16": {
        const u = new Uint16Array([...(r.in as string)].map((c) => c.charCodeAt(0)));
        assert.deepEqual(DecodeVLQUTF16(u), r.out, `DecodeVLQUTF16 ${JSON.stringify(r.in)}`);
        break;
      }
      case "AdvanceBytes": {
        const off = new LineColumnOffset();
        off.AdvanceBytes(enc.encode(r.in as string));
        assert.deepEqual([off.Lines, off.Columns], r.out, `AdvanceBytes ${JSON.stringify(r.in)}`);
        break;
      }
      case "AdvanceString": {
        const off = new LineColumnOffset();
        off.AdvanceString(r.in as string);
        assert.deepEqual([off.Lines, off.Columns], r.out, `AdvanceString ${JSON.stringify(r.in)}`);
        break;
      }
      case "ComesBefore": {
        const a = new LineColumnOffset(); a.Lines = 1;
        const b = new LineColumnOffset(); b.Columns = 9;
        assert.equal(a.ComesBefore(b), r.out, "ComesBefore 1:0 vs 0:9");
        break;
      }
      case "Add": {
        const parts = (r.in as string).split("+");
        const p0 = parts[0].split(":").map(Number);
        const p1 = parts[1].split(":").map(Number);
        const off = new LineColumnOffset(); off.Lines = p0[0]; off.Columns = p0[1];
        const add = new LineColumnOffset(); add.Lines = p1[0]; add.Columns = p1[1];
        off.Add(add);
        assert.deepEqual([off.Lines, off.Columns], r.out, `Add ${r.in}`);
        break;
      }
      case "GenerateLineOffsetTables": {
        const tables = GenerateLineOffsetTables(r.in as string, 4);
        const got = tables.map((t) => ({ b: t.byteOffsetToStartOfLine, f: t.byteOffsetToFirstNonASCII, c: t.columnsForNonASCII }));
        assert.deepEqual(got, r.out, `GenerateLineOffsetTables ${JSON.stringify(r.in)}`);
        break;
      }
      case "Find": {
        const m = makeFindMap().Find((r.in as number[])[0], (r.in as number[])[1]);
        const got = m ? [m.GeneratedLine, m.GeneratedColumn, m.SourceIndex, m.OriginalLine, m.OriginalColumn] : null;
        assert.deepEqual(got, r.out, `Find ${r.in}`);
        break;
      }
      case "HasContent": {
        const pieces = new SourceMapPieces();
        if (r.in === "x") pieces.Prefix = enc.encode("x");
        assert.equal(pieces.HasContent(), r.out, `HasContent ${r.in}`);
        break;
      }
      case "Finalize": {
        // 探针两条：① Prefix=P Mappings=AAAA Suffix=S；② 仅 Mappings=A;;B
        const pieces = new SourceMapPieces();
        if (finalizeCall === 0) { pieces.Prefix = enc.encode("P"); pieces.Mappings = enc.encode("AAAA"); pieces.Suffix = enc.encode("S"); }
        else pieces.Mappings = enc.encode(r.in as string);
        finalizeCall++;
        assert.equal(utf8(pieces.Finalize([new SourceMapShift()])), r.out, `Finalize ${r.in}`);
        break;
      }
      case "ChunkBuilder": {
        const cb = MakeChunkBuilder(null, GenerateLineOffsetTables("0123456789\nabc\n", 2), false);
        cb.AddSourceMapping(new Loc(0), "foo", enc.encode("a"));
        cb.AddSourceMapping(new Loc(1), "", enc.encode("ab"));
        cb.AddSourceMapping(new Loc(11), "", enc.encode("ab\nc"));
        const chunk = cb.GenerateChunk(enc.encode("ab\nc"));
        const want = r.out as { data: string; quoted: string[]; end: Record<string, number>; final: number; ignore: boolean };
        assert.equal(utf8(chunk.Buffer.Data), want.data, "ChunkBuilder.data");
        // Go 的 [][]byte 经 JSON 编成 base64 字符串
        assert.deepEqual(chunk.QuotedNames.map((q) => Buffer.from(q).toString("base64")), want.quoted, "ChunkBuilder.quoted");
        assert.deepEqual(
          { GeneratedLine: chunk.EndState.GeneratedLine, GeneratedColumn: chunk.EndState.GeneratedColumn,
            SourceIndex: chunk.EndState.SourceIndex, OriginalLine: chunk.EndState.OriginalLine,
            OriginalColumn: chunk.EndState.OriginalColumn, OriginalName: chunk.EndState.OriginalName,
            HasOriginalName: chunk.EndState.HasOriginalName },
          want.end, "ChunkBuilder.end",
        );
        assert.equal(chunk.FinalGeneratedColumn, want.final, "ChunkBuilder.final");
        assert.equal(chunk.ShouldIgnore, want.ignore, "ChunkBuilder.ignore");
        break;
      }
      case "AppendSourceMapChunk": {
        const j = new Joiner();
        const prev = new SourceMapState();
        prev.GeneratedColumn = 2; prev.SourceIndex = 1; prev.OriginalLine = 3; prev.OriginalColumn = 4;
        const start = new SourceMapState();
        start.GeneratedColumn = 5; start.SourceIndex = 0; start.OriginalLine = 0; start.OriginalColumn = 0;
        start.HasOriginalName = true; start.OriginalName = 7;
        const buffer = new MappingsBuffer();
        buffer.Data = enc.encode("AAAAA,G");
        buffer.FirstNameOffset = MakeIndex32(6);
        AppendSourceMapChunk(j, prev, start, buffer);
        assert.equal(utf8(j.Done()), r.out, "AppendSourceMapChunk");
        break;
      }
      case "appendMappingToBuffer": {
        const prev = new SourceMapState();
        prev.GeneratedColumn = 2; prev.SourceIndex = 1; prev.OriginalLine = 3; prev.OriginalColumn = 4;
        const start = new SourceMapState();
        start.GeneratedColumn = 5; start.SourceIndex = 0; start.OriginalLine = 0; start.OriginalColumn = 0;
        start.HasOriginalName = true; start.OriginalName = 7;
        const [data, nameOff] = appendMappingToBuffer([], 0, prev, start, false);
        const want = r.out as { data: string; nameOff: number };
        assert.equal(utf8(data), want.data, "appendMappingToBuffer.data");
        assert.equal(nameOff.GetIndex(), want.nameOff, "appendMappingToBuffer.nameOff");
        break;
      }
      default:
        throw new Error(`未知探针用例: ${r.name}`);
    }
  }
});
