// 1:1 移植自 esbuild internal/js_parser/sourcemap_parser.go（v0.28.2，f6058f83）。第 138 批底座；第 104 轮补 ParseSourceMap。
// Go: type mappingArray []sourcemap.Mapping (sourcemap_parser.go:426)
// ParseSourceMap 期望值由 Go 探针 tools/go/tmpgen_smparse_test.go → testdata/sourcemap-parse-go.json（SHA f63b6f6c…）固化，17 例逐字节。
import * as js_ast from "../js_ast/js_ast.ts";
import { Source, Log, Range, Loc, MsgKind, MakeLineColumnTracker, AddError, AddID } from "../logger/logger.ts";
import { MsgID_SourceMap_InvalidSourceMappings } from "../logger/msg_ids.ts";
import { Mapping, SourceMap, SourceContent, DecodeVLQUTF16 } from "../sourcemap/sourcemap.ts";
import { UTF16ToString, UTF16EqualsString } from "../helpers/utf.ts";
import { FileURLFromFilePath } from "../helpers/path.ts";
import { MakeIndex32, Index32 } from "../ast/ast.ts";
import { ParseJSON, JSONOptions } from "./json_parser.ts";

const dec = new TextDecoder();
/** Go: helpers.UTF16ToString(b) —— Go 的 string 用 JS string 承载（UTF-8 解码） */
function u16str(v: Uint16Array | number[]): string { return dec.decode(UTF16ToString(v)); }
/** Go: helpers.UTF16EqualsString(v, "literal") */
function u16eq(v: Uint16Array | number[], lit: string): boolean { return UTF16EqualsString(v, new TextEncoder().encode(lit)); }
/** Go: fmt.Sprintf("%q", s) 的最小实现（本函数只对 mappings 的单个非法字符调用） */
function goQuote(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"';
}

export class mappingArray {
  items: Mapping[];
  constructor(items: Mapping[] = []) { this.items = items; }
  /** Go: func (a mappingArray) Len() int (sourcemap_parser.go:428) */
  Len(): number { return this.items.length; }
  /** Go: func (a mappingArray) Swap(i int, j int) (sourcemap_parser.go:429) */
  Swap(i: number, j: number): void { const t = this.items[i]; this.items[i] = this.items[j]; this.items[j] = t; }
  /** Go: func (a mappingArray) Less(i int, j int) bool (sourcemap_parser.go:431) */
  Less(i: number, j: number): boolean {
    const ai = this.items[i], aj = this.items[j];
    return ai.GeneratedLine < aj.GeneratedLine || (ai.GeneratedLine === aj.GeneratedLine && ai.GeneratedColumn <= aj.GeneratedColumn);
  }
}

/** Go 的 sort.Stable(mappings)：稳定插入排序（数据量小，行为等价） */
function stableSortMappings(arr: mappingArray): void {
  const a = arr.items;
  for (let i = 1; i < a.length; i++) {
    const cur = a[i];
    let j = i - 1;
    while (j >= 0 && arr.Less(j + 1, j)) { a[j + 1] = a[j]; j--; }
    a[j + 1] = cur;
  }
}

interface SourceMapSection { lineOffset: number; columnOffset: number; sourceMap: js_ast.EObject }

/** Go: func ParseSourceMap(log logger.Log, source logger.Source) *sourcemap.SourceMap (sourcemap_parser.go:18) */
export function ParseSourceMap(log: Log, source: Source): SourceMap | null {
  const jopts = new JSONOptions(); jopts.ErrorSuffix = " in source map";
  const parsed = ParseJSON(log, source, jopts);
  if (!parsed.ok) return null;
  const expr = parsed.expr;
  const tracker = MakeLineColumnTracker(source);
  if (!(expr.Data instanceof js_ast.EObject)) {
    AddError(log, tracker, new Range(expr.Loc), "Invalid source map");
    return null;
  }
  const obj = expr.Data as js_ast.EObject;

  const sections: SourceMapSection[] = [];
  let hasSections = false;
  for (const prop of obj.Properties) {
    const key = prop.Key.Data;
    if (!(key instanceof js_ast.EString) || !u16eq(key.Value, "sections")) continue;
    const val = prop.ValueOrNil !== null ? prop.ValueOrNil.Data : null;
    if (val instanceof js_ast.EArray) {
      for (const item of val.Items) {
        if (!(item.Data instanceof js_ast.EObject)) continue;
        const element = item.Data as js_ast.EObject;
        let sectionLineOffset = 0, sectionColumnOffset = 0;
        let sectionSourceMap: js_ast.EObject | null = null;
        for (const sp of element.Properties) {
          const sk = sp.Key.Data;
          if (!(sk instanceof js_ast.EString)) continue;
          switch (u16str(sk.Value)) {
            case "offset": {
              const ov = sp.ValueOrNil !== null ? sp.ValueOrNil.Data : null;
              if (ov instanceof js_ast.EObject) {
                for (const op of ov.Properties) {
                  const ok2 = op.Key.Data;
                  if (!(ok2 instanceof js_ast.EString)) continue;
                  const ovv = op.ValueOrNil !== null ? op.ValueOrNil.Data : null;
                  if (!(ovv instanceof js_ast.ENumber)) continue;
                  switch (u16str(ok2.Value)) {
                    case "line": sectionLineOffset = ovv.Value | 0; break;
                    case "column": sectionColumnOffset = ovv.Value | 0; break;
                  }
                }
              } else {
                AddError(log, tracker, new Range(sp.ValueOrNil!.Loc), 'Expected "offset" to be an object');
                return null;
              }
              break;
            }
            case "map": {
              const mv = sp.ValueOrNil !== null ? sp.ValueOrNil.Data : null;
              if (mv instanceof js_ast.EObject) sectionSourceMap = mv;
              else { AddError(log, tracker, new Range(sp.ValueOrNil!.Loc), 'Expected "map" to be an object'); return null; }
              break;
            }
          }
        }
        if (sectionSourceMap !== null) sections.push({ lineOffset: sectionLineOffset, columnOffset: sectionColumnOffset, sourceMap: sectionSourceMap });
      }
    } else {
      AddError(log, tracker, new Range(prop.ValueOrNil!.Loc), 'Expected "sections" to be an array');
      return null;
    }
    hasSections = true;
    break;
  }
  if (!hasSections) sections.push({ lineOffset: 0, columnOffset: 0, sourceMap: obj });

  let sources: string[] = [];
  let sourcesContent: SourceContent[] = [];
  let names: string[] = [];
  let mappings = new mappingArray();
  let generatedLine = 0, generatedColumn = 0;
  let needSort = false;

  for (const section of sections) {
    let sourcesArray: js_ast.Expr[] = [];
    let sourcesContentArray: js_ast.Expr[] = [];
    let namesArray: js_ast.Expr[] = [];
    let mappingsRaw: Uint16Array = new Uint16Array(0);
    let mappingsStart = 0;
    let sourceRoot = "";
    let hasVersion = false;

    for (const prop of section.sourceMap.Properties) {
      const k = prop.Key.Data;
      if (!(k instanceof js_ast.EString)) continue;
      const v = prop.ValueOrNil !== null ? prop.ValueOrNil.Data : null;
      switch (u16str(k.Value)) {
        case "version": if (v instanceof js_ast.ENumber && v.Value === 3) hasVersion = true; break;
        case "mappings": if (v instanceof js_ast.EString) { mappingsRaw = v.Value; mappingsStart = prop.ValueOrNil!.Loc.Start + 1; } break;
        case "sourceRoot": if (v instanceof js_ast.EString) sourceRoot = u16str(v.Value); break;
        case "sources": if (v instanceof js_ast.EArray) sourcesArray = v.Items; break;
        case "sourcesContent": if (v instanceof js_ast.EArray) sourcesContentArray = v.Items; break;
        case "names": if (v instanceof js_ast.EArray) namesArray = v.Items; break;
      }
    }
    if (!hasVersion) continue;
    const mappingsLen = mappingsRaw.length, sourcesLen = sourcesArray.length, namesLen = namesArray.length;
    if (mappingsLen === 0 || sourcesLen === 0) continue;

    if (section.lineOffset < generatedLine || (section.lineOffset === generatedLine && section.columnOffset < generatedColumn)) needSort = true;
    const lineOffset = section.lineOffset, columnOffset = section.columnOffset;
    const sourceOffset = sources.length, nameOffset = names.length;
    generatedLine = lineOffset; generatedColumn = columnOffset;
    let sourceIndex = sourceOffset, originalLine = 0, originalColumn = 0, originalName = nameOffset;
    let current = 0, errorText = "", errorLen = 0;

    while (current < mappingsLen) {
      if (mappingsRaw[current] === 0x3b /* ';' */) { generatedLine++; generatedColumn = 0; current++; continue; }
      let r = DecodeVLQUTF16(mappingsRaw.subarray(current));
      let delta = r[0], i = r[1], ok = r[2];
      if (!ok) { errorText = "Missing generated column"; errorLen = i; break; }
      if (delta < 0) needSort = true;
      generatedColumn += delta;
      if ((generatedLine === lineOffset && generatedColumn < columnOffset) || generatedColumn < 0) {
        errorText = `Invalid generated column value: ${generatedColumn}`; errorLen = i; break;
      }
      current += i;
      if (current === mappingsLen) break;
      if (mappingsRaw[current] === 0x2c /* ',' */) { current++; continue; }
      if (mappingsRaw[current] === 0x3b /* ';' */) continue;

      r = DecodeVLQUTF16(mappingsRaw.subarray(current)); delta = r[0]; i = r[1]; ok = r[2];
      if (!ok) { errorText = "Missing source index"; errorLen = i; break; }
      sourceIndex += delta;
      if (sourceIndex < sourceOffset || sourceIndex >= sourceOffset + sourcesLen) {
        errorText = `Invalid source index value: ${sourceIndex}`; errorLen = i; break;
      }
      current += i;

      r = DecodeVLQUTF16(mappingsRaw.subarray(current)); delta = r[0]; i = r[1]; ok = r[2];
      if (!ok) { errorText = "Missing original line"; errorLen = i; break; }
      originalLine += delta;
      if (originalLine < 0) { errorText = `Invalid original line value: ${originalLine}`; errorLen = i; break; }
      current += i;

      r = DecodeVLQUTF16(mappingsRaw.subarray(current)); delta = r[0]; i = r[1]; ok = r[2];
      if (!ok) { errorText = "Missing original column"; errorLen = i; break; }
      originalColumn += delta;
      if (originalColumn < 0) { errorText = `Invalid original column value: ${originalColumn}`; errorLen = i; break; }
      current += i;

      let optionalName = new Index32();
      r = DecodeVLQUTF16(mappingsRaw.subarray(current));
      if (r[2]) {
        const nd = r[0], ni = r[1];
        originalName += nd;
        if (originalName < nameOffset || originalName >= nameOffset + namesLen) {
          errorText = `Invalid name index value: ${originalName}`; errorLen = ni; break;
        }
        optionalName = MakeIndex32(originalName >>> 0);
        current += ni;
      }

      if (current < mappingsLen) {
        const c = mappingsRaw[current];
        if (c === 0x2c) current++;
        else if (c !== 0x3b) {
          errorText = `Invalid character after mapping: ${goQuote(u16str(mappingsRaw.subarray(current, current + 1)))}`;
          errorLen = 1; break;
        }
      }

      const m = new Mapping();
      m.GeneratedLine = generatedLine; m.GeneratedColumn = generatedColumn;
      m.SourceIndex = sourceIndex; m.OriginalLine = originalLine; m.OriginalColumn = originalColumn;
      m.OriginalName = optionalName;
      mappings.items.push(m);
    }

    if (errorText !== "") {
      const rr = new Range(new Loc(mappingsStart + current), errorLen);
      AddID(log, MsgID_SourceMap_InvalidSourceMappings, MsgKind.Warning, tracker, rr,
        `Bad "mappings" data in source map at character ${current}: ${errorText}`);
      return null;
    }

    let sourceURLPrefix = "";
    let baseURL: URL | null = null;
    if (sourceRoot !== "") {
      const idx = sourceRoot.lastIndexOf("/");
      sourceURLPrefix = idx !== -1 ? sourceRoot.slice(0, idx + 1) : sourceRoot + "/";
    }
    if (source.KeyPath.Namespace === "file") baseURL = FileURLFromFilePath(source.KeyPath.Text);

    for (const item of sourcesArray) {
      if (item.Data instanceof js_ast.EString) {
        const sourcePath = sourceURLPrefix + u16str(item.Data.Value);
        let out: string;
        if (baseURL !== null) {
          try { out = new URL(sourcePath, baseURL).href; } catch { out = sourcePath; }
        } else {
          try { out = new URL(sourcePath).href; } catch { out = sourcePath; }
        }
        sources.push(out);
      } else sources.push("");
    }

    if (sourcesContentArray.length > 0) {
      for (let k = sourcesContent.length; k < sourceOffset; k++) { const sc = new SourceContent(); sourcesContent.push(sc); }
      for (let i2 = 0; i2 < sourcesContentArray.length; i2++) {
        if (i2 === sourcesLen) break;
        const item = sourcesContentArray[i2];
        if (item.Data instanceof js_ast.EString) {
          const sc = new SourceContent();
          sc.Value = item.Data.Value;
          sc.Quoted = dec.decode(source.TextForRange(source.RangeOfString(item.Loc)));
          sourcesContent.push(sc);
        } else sourcesContent.push(new SourceContent());
      }
    }

    for (const item of namesArray) {
      if (item.Data instanceof js_ast.EString) names.push(u16str(item.Data.Value));
      else names.push("");
    }
  }

  if (sources.length === 0 || mappings.items.length === 0) return null;
  if (needSort) stableSortMappings(mappings);
  const sm = new SourceMap();
  sm.Sources = sources; sm.SourcesContent = sourcesContent; sm.Mappings = mappings.items; sm.Names = names;
  return sm;
}
