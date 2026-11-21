// 1:1 移植自 esbuild internal/sourcemap/sourcemap.go（v0.28.2，commit f6058f83）
//
// 本文件实现 sourcemap 包的 19 个非测试函数，期望值来自包内临时探针
// `internal/sourcemap/tmpgenprobe_test.go`（52 例，sha256 9cf61378…），探针跑完即删。
// Go 的 `string` 是字节串，TS 统一用 Uint8Array 承载 mappings/prefix/suffix。

import * as ast from "../ast/ast.ts";
import { Index32, MakeIndex32 } from "../ast/ast.ts";
import { Joiner } from "../helpers/joiner.ts";
import { QuoteForJSON } from "../helpers/quote.ts";
import { Loc } from "../logger/logger.ts";

/** Go: type Mapping (sourcemap.go:16) */
export class Mapping {
  GeneratedLine: number = 0;
  GeneratedColumn: number = 0;
  SourceIndex: number = 0;
  OriginalLine: number = 0;
  OriginalColumn: number = 0;
  OriginalName: Index32 = new Index32();
}

/** Go: type SourceContent (sourcemap.go:28) */
export class SourceContent {
  Quoted: string = "";
  Value: Uint16Array = new Uint16Array(0);
}

/** Go: type SourceMap (sourcemap.go:22) */
export class SourceMap {
  Sources: string[] = [];
  SourcesContent: SourceContent[] = [];
  Mappings: Mapping[] = [];
  Names: string[] = [];

  /** Go: func (sm *SourceMap) Find(line, column int32) *Mapping (sourcemap.go:42) */
  Find(line: number, column: number): Mapping | null {
    const mappings = this.Mappings;
    let count = mappings.length;
    let index = 0;
    while (count > 0) {
      const step = count >> 1;
      const i = index + step;
      const m = mappings[i];
      if (m.GeneratedLine < line || (m.GeneratedLine === line && m.GeneratedColumn <= column)) {
        index = i + 1;
        count -= step + 1;
      } else {
        count = step;
      }
    }
    if (index > 0) {
      const m = mappings[index - 1];
      if (m.GeneratedLine === line) return m;
    }
    return null;
  }
}

const base64 = new TextEncoder().encode("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");

/** Go: func encodeVLQ(encoded []byte, value int) []byte (sourcemap.go:85) */
export function encodeVLQ(encoded: number[], value: number): number[] {
  let vlq = value < 0 ? ((-value) << 1) | 1 : value << 1;
  if ((vlq >> 5) === 0) {
    encoded.push(base64[vlq & 31]);
    return encoded;
  }
  for (;;) {
    let digit = vlq & 31;
    vlq >>= 5;
    if (vlq !== 0) digit |= 32;
    encoded.push(base64[digit]);
    if (vlq === 0) break;
  }
  return encoded;
}

/** Go: func DecodeVLQ(encoded []byte, start int) (int, int) (sourcemap.go:120) */
export function DecodeVLQ(encoded: Uint8Array | number[], start: number): [number, number] {
  let shift = 0;
  let vlq = 0;
  for (;;) {
    const index = base64.indexOf(encoded[start]);
    if (index < 0) break;
    vlq |= (index & 31) << shift;
    start++;
    shift += 5;
    if ((index & 32) === 0) break;
  }
  let value = vlq >> 1;
  if ((vlq & 1) !== 0) value = -value;
  return [value | 0, start]; // Go 的整数没有 -0
}

/** Go: func DecodeVLQUTF16(encoded []uint16) (int32, int, bool) (sourcemap.go:150) */
export function DecodeVLQUTF16(encoded: Uint16Array | number[]): [number, number, boolean] {
  const n = encoded.length;
  if (n === 0) return [0, 0, false];
  let current = 0, shift = 0, vlq = 0;
  for (;;) {
    if (current >= n) return [0, 0, false];
    const index = base64.indexOf(encoded[current] & 0xff);
    if (index < 0) return [0, 0, false];
    vlq |= (index & 31) << shift;
    current++;
    shift += 5;
    if ((index & 32) === 0) break;
  }
  let value = vlq >> 1;
  if ((vlq & 1) !== 0) value = -value;
  return [value | 0, current, true]; // Go 的整数没有 -0
}

/** Go: type LineColumnOffset (sourcemap.go:190) */
export class LineColumnOffset {
  Lines: number = 0;
  Columns: number = 0;

  /** Go: func (a LineColumnOffset) ComesBefore(b LineColumnOffset) bool (sourcemap.go:193) */
  ComesBefore(b: LineColumnOffset): boolean {
    return this.Lines < b.Lines || (this.Lines === b.Lines && this.Columns < b.Columns);
  }

  /** Go: func (a *LineColumnOffset) Add(b LineColumnOffset) (sourcemap.go:197) */
  Add(b: LineColumnOffset): void {
    if (b.Lines === 0) this.Columns += b.Columns;
    else { this.Lines += b.Lines; this.Columns = b.Columns; }
  }

  /** Go: func (offset *LineColumnOffset) AdvanceBytes(bytes []byte) (sourcemap.go:206) */
  AdvanceBytes(bytes: Uint8Array): void {
    let columns = this.Columns;
    const decoder = new TextDecoder("utf-8");
    let i = 0;
    while (i < bytes.length) {
      const { c, width } = decodeRune(bytes, i);
      i += width;
      if (c === 0x0d || c === 0x0a || c === 0x2028 || c === 0x2029) {
        if (c === 0x0d && i < bytes.length && bytes[i] === 0x0a) { columns++; continue; }
        this.Lines++;
        columns = 0;
      } else columns += c <= 0xffff ? 1 : 2;
    }
    this.Columns = columns;
  }

  /** Go: func (offset *LineColumnOffset) AdvanceString(text string) (sourcemap.go:234) */
  AdvanceString(text: string): void {
    let columns = this.Columns;
    const chars = [...text];
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i].codePointAt(0)!;
      if (c === 0x0d || c === 0x0a || c === 0x2028 || c === 0x2029) {
        if (c === 0x0d && i + 1 < chars.length && chars[i + 1] === "\n") { columns++; continue; }
        this.Lines++;
        columns = 0;
      } else columns += c <= 0xffff ? 1 : 2;
    }
    this.Columns = columns;
  }
}

/** 取一个 UTF-8 码点（对齐 Go 的 utf8.DecodeRune） */
function decodeRune(bytes: Uint8Array, i: number): { c: number; width: number } {
  const b0 = bytes[i];
  let width = 1;
  if (b0 >= 0xf0) width = 4; else if (b0 >= 0xe0) width = 3; else if (b0 >= 0xc0) width = 2;
  if (i + width > bytes.length) width = 1;
  const c = new TextDecoder("utf-8").decode(bytes.subarray(i, i + width)).codePointAt(0) ?? 0xfffd;
  return { c, width };
}

/** Go: type SourceMapPieces (sourcemap.go:258) */
export class SourceMapPieces {
  Prefix: Uint8Array = new Uint8Array(0);
  Mappings: Uint8Array = new Uint8Array(0);
  Suffix: Uint8Array = new Uint8Array(0);

  /** Go: func (pieces SourceMapPieces) HasContent() bool (sourcemap.go:266) */
  HasContent(): boolean {
    return this.Prefix.length + this.Mappings.length + this.Suffix.length > 0;
  }

  /** Go: func (pieces SourceMapPieces) Finalize(shifts []SourceMapShift) []byte (sourcemap.go:275) */
  Finalize(shifts: SourceMapShift[]): Uint8Array {
    if (shifts.length === 1) {
      const out = new Uint8Array(this.Prefix.length + this.Mappings.length + this.Suffix.length);
      out.set(this.Prefix, 0);
      out.set(this.Mappings, this.Prefix.length);
      out.set(this.Suffix, this.Prefix.length + this.Mappings.length);
      return out;
    }
    let startOfRun = 0;
    let current = 0;
    const generated = new LineColumnOffset();
    let prevShiftColumnDelta = 0;
    const j = new Joiner();
    j.AddBytes(this.Prefix);
    while (current < this.Mappings.length) {
      if (this.Mappings[current] === 0x3b) { generated.Lines++; generated.Columns = 0; prevShiftColumnDelta = 0; current++; continue; }
      const potentialEndOfRun = current;
      const [generatedColumnDelta, next] = DecodeVLQ(this.Mappings, current);
      generated.Columns += generatedColumnDelta;
      current = next;
      const potentialStartOfRun = current;
      if (current < this.Mappings.length) {
        [, current] = DecodeVLQ(this.Mappings, current);
        [, current] = DecodeVLQ(this.Mappings, current);
        [, current] = DecodeVLQ(this.Mappings, current);
        if (current < this.Mappings.length) [, current] = DecodeVLQ(this.Mappings, current);
      }
      if (current < this.Mappings.length && this.Mappings[current] === 0x2c) current++;
      let didCrossBoundary = false;
      while (shifts.length > 1 && shifts[1].Before.ComesBefore(generated)) { shifts = shifts.slice(1); didCrossBoundary = true; }
      if (!didCrossBoundary) continue;
      const shift = shifts[0];
      if (shift.After.Lines !== generated.Lines) continue;
      j.AddBytes(this.Mappings.subarray(startOfRun, potentialEndOfRun));
      if (shift.Before.Lines !== shift.After.Lines) throw new Error("Unexpected line change when shifting source maps");
      const shiftColumnDelta = shift.After.Columns - shift.Before.Columns;
      j.AddBytes(Uint8Array.from(encodeVLQ([], generatedColumnDelta + shiftColumnDelta - prevShiftColumnDelta)));
      prevShiftColumnDelta = shiftColumnDelta;
      startOfRun = potentialStartOfRun;
    }
    j.AddBytes(this.Mappings.subarray(startOfRun));
    j.AddBytes(this.Suffix);
    return j.Done();
  }
}

/** Go: type SourceMapShift (sourcemap.go:262) */
export class SourceMapShift {
  Before: LineColumnOffset = new LineColumnOffset();
  After: LineColumnOffset = new LineColumnOffset();
}

/** Go: type SourceMapState (sourcemap.go:379) */
export class SourceMapState {
  GeneratedLine: number = 0;
  GeneratedColumn: number = 0;
  SourceIndex: number = 0;
  OriginalLine: number = 0;
  OriginalColumn: number = 0;
  OriginalName: number = 0;
  HasOriginalName: boolean = false;
}

/** Go: type MappingsBuffer (sourcemap.go:594) */
export class MappingsBuffer {
  Data: Uint8Array = new Uint8Array(0);
  FirstNameOffset: Index32 = new Index32();
}

/** Go: func AppendSourceMapChunk(...) (sourcemap.go:403) */
export function AppendSourceMapChunk(j: Joiner, prevEndState: SourceMapState, startState: SourceMapState, buffer: MappingsBuffer): void {
  if (startState.GeneratedLine !== 0) { j.AddString(new Uint8Array(startState.GeneratedLine).fill(0x3b)); prevEndState.GeneratedColumn = 0; }
  let semicolons = 0;
  while (buffer.Data[semicolons] === 0x3b) semicolons++;
  if (semicolons > 0) { j.AddBytes(buffer.Data.subarray(0, semicolons)); prevEndState.GeneratedColumn = 0; startState.GeneratedColumn = 0; }
  let sourceIndex = 0, originalLine = 0, originalColumn = 0;
  let omitSource = false;
  const [generatedColumn, i0] = DecodeVLQ(buffer.Data, semicolons);
  let i = i0;
  if (i === buffer.Data.length || buffer.Data[i] === 0x2c || buffer.Data[i] === 0x3b) omitSource = true;
  else { [sourceIndex, i] = DecodeVLQ(buffer.Data, i); [originalLine, i] = DecodeVLQ(buffer.Data, i); [originalColumn, i] = DecodeVLQ(buffer.Data, i); }
  startState.GeneratedColumn += generatedColumn;
  startState.SourceIndex += sourceIndex;
  startState.OriginalLine += originalLine;
  startState.OriginalColumn += originalColumn;
  prevEndState.HasOriginalName = false;
  const [rewritten] = appendMappingToBuffer([], j.LastByte(), prevEndState, startState, omitSource);
  j.AddBytes(Uint8Array.from(rewritten));
  if (buffer.FirstNameOffset.IsValid()) {
    const before = buffer.FirstNameOffset.GetIndex();
    const [originalName, after] = DecodeVLQ(buffer.Data, before);
    j.AddBytes(buffer.Data.subarray(i, before));
    j.AddBytes(Uint8Array.from(encodeVLQ([], originalName + startState.OriginalName - prevEndState.OriginalName)));
    j.AddBytes(buffer.Data.subarray(after));
    return;
  }
  j.AddBytes(buffer.Data.subarray(i));
}

/** Go: func appendMappingToBuffer(...) (sourcemap.go:470) */
export function appendMappingToBuffer(buffer: number[], lastByte: number, prevState: SourceMapState, currentState: SourceMapState, omitSource: boolean): [number[], Index32] {
  if (lastByte !== 0 && lastByte !== 0x3b && lastByte !== 0x22) buffer.push(0x2c);
  encodeVLQ(buffer, currentState.GeneratedColumn - prevState.GeneratedColumn);
  if (!omitSource) {
    encodeVLQ(buffer, currentState.SourceIndex - prevState.SourceIndex);
    encodeVLQ(buffer, currentState.OriginalLine - prevState.OriginalLine);
    encodeVLQ(buffer, currentState.OriginalColumn - prevState.OriginalColumn);
  }
  let nameOffset = new Index32();
  if (currentState.HasOriginalName) { nameOffset = MakeIndex32(buffer.length); encodeVLQ(buffer, currentState.OriginalName - prevState.OriginalName); }
  return [buffer, nameOffset];
}

/** Go: type LineOffsetTable (sourcemap.go:497) */
export class LineOffsetTable {
  columnsForNonASCII: number[] | null = null;
  byteOffsetToFirstNonASCII: number = 0;
  byteOffsetToStartOfLine: number = 0;
}

function initTable(start: number, first: number, cols: number[] | null): LineOffsetTable {
  const t = new LineOffsetTable();
  t.byteOffsetToStartOfLine = start;
  t.byteOffsetToFirstNonASCII = first;
  t.columnsForNonASCII = cols;
  return t;
}

/** Go: func GenerateLineOffsetTables(contents string, approximateLineCount int32) []LineOffsetTable (sourcemap.go:513) */
export function GenerateLineOffsetTables(contents: string, approximateLineCount: number): LineOffsetTable[] {
  let ColumnsForNonASCII: number[] | null = null;
  let ByteOffsetToFirstNonASCII = 0;
  let lineByteOffset = 0, columnByteOffset = 0, column = 0;
  const tables: LineOffsetTable[] = [];
  const bytes = new TextEncoder().encode(contents);
  let i = 0;
  while (i < bytes.length) {
    const { c, width } = decodeRune(bytes, i);
    const byteOffset = i;
    i += width;
    if (column === 0) lineByteOffset = byteOffset;
    if (c > 0x7f && ColumnsForNonASCII === null) { columnByteOffset = byteOffset - lineByteOffset; ByteOffsetToFirstNonASCII = columnByteOffset; ColumnsForNonASCII = []; }
    if (ColumnsForNonASCII !== null) {
      for (let lineBytesSoFar = byteOffset - lineByteOffset; columnByteOffset <= lineBytesSoFar; columnByteOffset++) ColumnsForNonASCII.push(column);
    }
    if (c === 0x0d || c === 0x0a || c === 0x2028 || c === 0x2029) {
      if (c === 0x0d && i < bytes.length && bytes[i] === 0x0a) { column++; continue; }
      tables.push(initTable(lineByteOffset, ByteOffsetToFirstNonASCII, ColumnsForNonASCII));
      columnByteOffset = 0; ByteOffsetToFirstNonASCII = 0; ColumnsForNonASCII = null; column = 0;
    } else column += c <= 0xffff ? 1 : 2;
  }
  if (column === 0) lineByteOffset = bytes.length;
  if (ColumnsForNonASCII !== null) {
    for (let lineBytesSoFar = bytes.length - lineByteOffset; columnByteOffset <= lineBytesSoFar; columnByteOffset++) ColumnsForNonASCII.push(column);
  }
  tables.push(initTable(lineByteOffset, ByteOffsetToFirstNonASCII, ColumnsForNonASCII));
  return tables;
}

/** Go: type Chunk (sourcemap.go:598) */
export class Chunk {
  Buffer: MappingsBuffer = new MappingsBuffer();
  QuotedNames: number[][] = [];
  EndState: SourceMapState = new SourceMapState();
  FinalGeneratedColumn: number = 0;
  ShouldIgnore: boolean = false;
}

function initState(genLine: number, genCol: number, sourceIdx: number, origLine: number, origCol: number): SourceMapState {
  const s = new SourceMapState();
  s.GeneratedLine = genLine; s.GeneratedColumn = genCol; s.SourceIndex = sourceIdx;
  s.OriginalLine = origLine; s.OriginalColumn = origCol;
  return s;
}

/** Go: func MakeChunkBuilder(inputSourceMap *SourceMap, lineOffsetTables []LineOffsetTable, asciiOnly bool) ChunkBuilder (sourcemap.go:640) */
export function MakeChunkBuilder(inputSourceMap: SourceMap | null, lineOffsetTables: LineOffsetTable[], asciiOnly: boolean): ChunkBuilder {
  return new ChunkBuilder(inputSourceMap, lineOffsetTables, asciiOnly);
}

/** Go: type ChunkBuilder (sourcemap.go:610) */
export class ChunkBuilder {
  inputSourceMap: SourceMap | null;
  sourceMap: number[] = [];
  quotedNames: number[][] = [];
  namesMap: Map<string, number> = new Map();
  lineOffsetTables: LineOffsetTable[];
  prevOriginalName: string = "";
  prevState: SourceMapState = new SourceMapState();
  lastGeneratedUpdate: number = 0;
  generatedColumn: number = 0;
  prevGeneratedLen: number = 0;
  prevOriginalLoc: Loc;
  firstNameOffset: Index32 = new Index32();
  hasPrevState: boolean = false;
  asciiOnly: boolean;
  lineStartsWithMapping: boolean = false;
  coverLinesWithoutMappings: boolean;

  /** Go: func MakeChunkBuilder(...) ChunkBuilder (sourcemap.go:640) */
  constructor(inputSourceMap: SourceMap | null, lineOffsetTables: LineOffsetTable[], asciiOnly: boolean) {
    this.inputSourceMap = inputSourceMap;
    this.lineOffsetTables = lineOffsetTables;
    this.asciiOnly = asciiOnly;
    this.prevOriginalLoc = new Loc(-1);
    this.coverLinesWithoutMappings = inputSourceMap === null;
  }

  /** Go: func (b *ChunkBuilder) AddSourceMapping(...) (sourcemap.go:663) */
  AddSourceMapping(originalLoc: Loc, originalName: string, output: Uint8Array): void {
    if (originalLoc.Start === this.prevOriginalLoc.Start &&
        (this.prevGeneratedLen === output.length || this.prevOriginalName === originalName)) return;
    this.prevOriginalLoc = originalLoc;
    this.prevGeneratedLen = output.length;
    this.prevOriginalName = originalName;
    const tables = this.lineOffsetTables;
    let count = tables.length, originalLine = 0;
    while (count > 0) {
      const step = count >> 1, idx = originalLine + step;
      if (tables[idx].byteOffsetToStartOfLine <= originalLoc.Start) { originalLine = idx + 1; count -= step + 1; }
      else count = step;
    }
    originalLine--;
    const line = tables[originalLine];
    let originalColumn = originalLoc.Start - line.byteOffsetToStartOfLine;
    if (line.columnsForNonASCII !== null && originalColumn >= line.byteOffsetToFirstNonASCII) {
      originalColumn = line.columnsForNonASCII[originalColumn - line.byteOffsetToFirstNonASCII];
    }
    this.updateGeneratedLineAndColumn(output);
    if (this.coverLinesWithoutMappings && !this.lineStartsWithMapping && this.generatedColumn > 0 && this.hasPrevState) {
      this.appendMappingWithoutRemapping(initState(this.prevState.GeneratedLine, 0, this.prevState.SourceIndex, this.prevState.OriginalLine, this.prevState.OriginalColumn));
    }
    this.appendMapping(originalName, initState(this.prevState.GeneratedLine, this.generatedColumn, 0, originalLine, originalColumn));
    this.lineStartsWithMapping = true;
  }

  /** Go: func (b *ChunkBuilder) GenerateChunk(output []byte) Chunk (sourcemap.go:721) */
  GenerateChunk(output: Uint8Array): Chunk {
    this.updateGeneratedLineAndColumn(output);
    let shouldIgnore = true;
    for (const c of this.sourceMap) { if (c !== 0x3b) { shouldIgnore = false; break; } }
    const chunk = new Chunk();
    chunk.Buffer.Data = Uint8Array.from(this.sourceMap);
    chunk.Buffer.FirstNameOffset = this.firstNameOffset;
    chunk.QuotedNames = this.quotedNames;
    chunk.EndState = this.prevState;
    chunk.FinalGeneratedColumn = this.generatedColumn;
    chunk.ShouldIgnore = shouldIgnore;
    return chunk;
  }

  /** Go: func (b *ChunkBuilder) updateGeneratedLineAndColumn(output []byte) (sourcemap.go:744) */
  updateGeneratedLineAndColumn(output: Uint8Array): void {
    let i = this.lastGeneratedUpdate;
    while (i < output.length) {
      const { c, width } = decodeRune(output, i);
      const byteIndex = i;
      i += width;
      if (c === 0x0d || c === 0x0a || c === 0x2028 || c === 0x2029) {
        if (c === 0x0d && byteIndex + 1 < output.length && output[byteIndex + 1] === 0x0a) continue;
        if (this.coverLinesWithoutMappings && !this.lineStartsWithMapping && this.hasPrevState) {
          this.appendMappingWithoutRemapping(initState(this.prevState.GeneratedLine, 0, this.prevState.SourceIndex, this.prevState.OriginalLine, this.prevState.OriginalColumn));
        }
        this.prevState.GeneratedLine++;
        this.prevState.GeneratedColumn = 0;
        this.generatedColumn = 0;
        this.sourceMap.push(0x3b);
        this.lineStartsWithMapping = false;
      } else this.generatedColumn += c <= 0xffff ? 1 : 2;
    }
    this.lastGeneratedUpdate = output.length;
  }

  /** Go: func (b *ChunkBuilder) appendMapping(...) (sourcemap.go:789) */
  appendMapping(originalName: string, currentState: SourceMapState): void {
    if (this.inputSourceMap !== null) {
      const mapping = this.inputSourceMap.Find(currentState.OriginalLine, currentState.OriginalColumn);
      if (mapping === null) return;
      currentState.SourceIndex = mapping.SourceIndex;
      currentState.OriginalLine = mapping.OriginalLine;
      currentState.OriginalColumn = mapping.OriginalColumn;
      if (mapping.OriginalName.IsValid()) originalName = this.inputSourceMap.Names[mapping.OriginalName.GetIndex()];
    }
    if (originalName !== "") {
      let idx = this.namesMap.get(originalName);
      if (idx === undefined) {
        idx = this.quotedNames.length;
        this.quotedNames.push(Array.from(QuoteForJSON(new TextEncoder().encode(originalName), this.asciiOnly)));
        this.namesMap.set(originalName, idx);
      }
      currentState.OriginalName = idx;
      currentState.HasOriginalName = true;
    }
    this.appendMappingWithoutRemapping(currentState);
  }

  /** Go: func (b *ChunkBuilder) appendMappingWithoutRemapping(...) (sourcemap.go:829) */
  appendMappingWithoutRemapping(currentState: SourceMapState): void {
    const lastByte = this.sourceMap.length === 0 ? 0 : this.sourceMap[this.sourceMap.length - 1];
    const [data, nameOffset] = appendMappingToBuffer(this.sourceMap, lastByte, this.prevState, currentState, false);
    this.sourceMap = data;
    const prevOriginalName = this.prevState.OriginalName;
    this.prevState = currentState;
    if (!currentState.HasOriginalName) this.prevState.OriginalName = prevOriginalName;
    else if (!this.firstNameOffset.IsValid()) this.firstNameOffset = nameOffset;
    this.hasPrevState = true;
  }
}
