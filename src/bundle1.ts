#!/usr/bin/env node
// 最小单文件 bundle 驱动（第 76 轮 · 任务 B）：parse → Link(薄) → print → entry tail。
// 目标：three.core.js（0 import、单 chunk）。复用已移植件（renamer / js_printer / generateEntryPointTailJS），
// 不重新发明。口径：--bundle --format=esm --platform=node --target=esnext --log-level=warning <file>。
// 出字节即可；逐字节由下游 oracle diff 反向驱动。
import { readFileSync, writeFileSync } from "node:fs";
import * as nodePath from "node:path";
import { Log, Path, Source, Loc, NewDeferLog, DeferLogKind } from "./internal/logger/logger.ts";
import { Options as ParseOptions, Parse } from "./internal/js_parser/js_parser.ts";
import { Format, Options as PrintOptions, Print } from "./internal/js_printer/js_printer.ts";
import * as astNS from "./internal/ast/ast.ts";
import * as js_astNS from "./internal/js_ast/js_ast.ts";
import { JSRepr, ExportData } from "./internal/graph/input.ts";
import { LinkerGraph, LinkerFile } from "./internal/graph/graph.ts";
import { ComputeReservedNames, NewNumberRenamer } from "./internal/renamer/renamer.ts";
import { knownGlobals } from "./internal/config/globals.ts";

const ref = (s: number, i: number): astNS.Ref => new astNS.Ref(s, i);
const enc = new TextEncoder();

export interface Bundle1Result { ok: boolean; output: Uint8Array; error?: string; }

/** 单文件 ESM bundle。path 用于源码路径注释。 */
export function bundleSingleFile(contents: Uint8Array, path: string, suppressHeader = false): Bundle1Result {
  const source = new Source();
  source.KeyPath = new Path(); source.KeyPath.Text = path; source.KeyPath.Namespace = "file";
  source.Contents = contents;
  source.PrettyPaths.Rel = path; source.PrettyPaths.Abs = path;
  const log = new Log();
  // Go --bundle 用 ModeBundle 调 parser：顶层 class→var、const/let→var、导出收集
  // 等 lowering 都在 parser 内完成（对应 Go js_parser lowerClass.finishAndGenerateCode
  // 的 mustConvertStmtToExpr）。这里必须同口径，否则输出形如 `class X {}` 而 Go 是
  // `var X = class {}`。outputFormat=3 即 FormatESModule。
  const parseOpts = new ParseOptions();
  parseOpts.mode = 2; // config.ModeBundle
  parseOpts.outputFormat = 3; // config.FormatESModule
  const parsed = Parse(log, source, parseOpts);
  if (!parsed.ok) return { ok: false, output: new Uint8Array(0), error: "parse failed" };
  const a: any = parsed.ast;

  // --- Link(薄)：单文件 ESM 的两件实事 ---
  // (1) 顶层符号表 + 真 renamer（复用 renamer 29/29）
  const sm = astNS.NewSymbolMap(1);
  sm.SymbolsForSource[0] = a.Symbols;
  const moduleScope: any = a.ModuleScope;
  const reserved = moduleScope ? ComputeReservedNames([moduleScope], sm) : new Map<string, number>();
  // Go linker.renameSymbolsInChunk（linker.go:5335）：ComputeReservedNames + bundle 追加 require/Promise。
  // 第 93 轮：过滤 parse 期即时绑定产生的虚假 unbound（i/array 等），但保留 knownGlobals 中的真全局
  // （document/window/self）——Go 探针 go-unbound-core.json 实测：Go 保留 document/self/window、
  // 不保留 i/array。旧 hack 把 document 也删掉导致 connect(document) 未重命名（四入口首差 929601）。
  const globalNames = new Set<string>();
  for (const parts of knownGlobals) if (parts.length === 1) globalNames.add(parts[0]);
  {
    const declared = new Set<string>();
    for (const sy of a.Symbols) if (sy.Kind !== astNS.SymbolKind.SymbolUnbound) declared.add(sy.OriginalName);
    for (const name of declared) if (!globalNames.has(name)) reserved.delete(name);
  }
  const nr = NewNumberRenamer(sm, reserved);
  if (moduleScope) {
    for (const m of moduleScope.Members.values()) {
      const mr: any = (m as any).Ref;
      if (mr && a.Symbols[mr.InnerIndex] && a.Symbols[mr.InnerIndex].Kind !== astNS.SymbolKind.SymbolUnbound) nr.AddTopLevelSymbol(mr);
    }
    nr.AssignNamesByScope(new Map([[0, moduleScope.Children ?? []]]));
  }

  // (2) 导出解析：NamedExports → SortedAndFilteredExportAliases（供 entry tail）
  const aliases = a.NamedExports && a.NamedExports.size > 0 ? [...a.NamedExports.keys()].sort() : [];

  // --- print body：剥 export 关键字（Mode=Bundle 会下沉到末尾 export 子句）---
  const outStmts: js_astNS.Stmt[] = [];
  for (const p of a.Parts) for (const st of p.Stmts) {
    const d: any = st.Data;
    if (d instanceof js_astNS.SExportClause || d instanceof js_astNS.SExportStar || d instanceof js_astNS.SExportFrom) continue;
    let s = st;
    if (d instanceof js_astNS.SLocal && (d.IsExport || d.Kind !== js_astNS.LocalKind.LocalVar)) {
      // Go ModeBundle: 顶层 const/let 降级为 var（跨文件绑定需要可重新赋值）；IsExport 一并剥离。
      const c = new js_astNS.SLocal(); c.Decls = d.Decls; c.Kind = js_astNS.LocalKind.LocalVar;
      c.IsExport = false; c.WasTSImportEquals = d.WasTSImportEquals;
      s = new js_astNS.Stmt(c, st.Loc);
    } else if (d instanceof js_astNS.SFunction && d.IsExport) {
      const c = new js_astNS.SFunction(); c.Fn = d.Fn; c.IsExport = false; s = new js_astNS.Stmt(c, st.Loc);
    } else if (d instanceof js_astNS.SClass && d.IsExport) {
      const c = new js_astNS.SClass(); c.Class = d.Class; c.IsExport = false; s = new js_astNS.Stmt(c, st.Loc);
    }
    // Go parser 在 treeShaking(bundle) 下把顶层多声明 var 拆成单声明
    // （js_parser.go:18068「Split up top-level multi-declaration variable statements」）。
    // TS 一趟 parser 未落这个 part 拆分，这里补上：var a, b; → var a; var b;。
    const sd: any = s.Data;
    if (sd instanceof js_astNS.SLocal && sd.Decls.length > 1) {
      for (const decl of sd.Decls) {
        const one = new js_astNS.SLocal();
        one.Decls = [decl]; one.Kind = sd.Kind; one.IsExport = sd.IsExport; one.WasTSImportEquals = sd.WasTSImportEquals;
        outStmts.push(new js_astNS.Stmt(one, st.Loc));
      }
    } else outStmts.push(s);
  }
  // entry tail：export { ... }（alias 排序；与 generateEntryPointTailJS ESM 分支同构）
  if (aliases.length > 0) {
    const items: js_astNS.ClauseItem[] = [];
    for (const alias of aliases) {
      const ne: any = a.NamedExports.get(alias);
      const ci = new js_astNS.ClauseItem();
      ci.Name = new astNS.LocRef(new Loc(0), ne.Ref); ci.Alias = alias; items.push(ci);
    }
    const sec = new js_astNS.SExportClause(); sec.Items = items;
    outStmts.push(new js_astNS.Stmt(sec));
  }

  const tree = new js_astNS.AST();
  tree.Symbols = a.Symbols; tree.ImportRecords = a.ImportRecords; tree.Directives = a.Directives ?? [];
  tree.ExprComments = a.ExprComments ?? new Map(); tree.Hashbang = a.Hashbang ?? "";
  const part = new js_astNS.Part(); part.Stmts = outStmts; tree.Parts = [part];
  const po = new PrintOptions(); po.OutputFormat = Format.FormatESModule; po.NeedsMetafile = false;
  // Go --bundle 默认 LegalComments=EndOfFile：legal 注释从头部抽走，末尾归并
  // （js_printer printStmt SComment 分支 → linker maybeAppendLegalComments EndOfFile 分支）。
  po.LegalComments = 2; // config.LegalCommentsEndOfFile
  const printed = Print(tree, a.Symbols, nr, po);
  const body = printed.JS;

  // bundle 路径注释头（Go Mode=Bundle 非 minify 时每个文件加 // <relpath>）
  // Go 的源码路径注释相对 outbase（cwd）计算（PathRelativeToOutbase）。
  let relp = nodePath.relative(process.cwd(), nodePath.resolve(path)).split(nodePath.sep).join("/");
  if (relp === "") relp = nodePath.basename(path);
  relp = relp.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  // 命名输出（EntryPointsAdvanced 带 OutputPath）时 Go 抑制 `// <path>` 头。
  const header = suppressHeader ? new Uint8Array(0) : enc.encode(`// ${relp}\n`);
  // Go maybeAppendLegalComments EndOfFile 分支：每条 first-party legal 注释原样 +
  // "\n" 追加在 chunk 末尾（linker.go:6638）。单文件入口无 node_modules 路径，
  // 全部按 first-party 处理，直接逐条输出（printer 侧已按 text 去重）。
  const tailChunks: Uint8Array[] = [];
  for (const c of printed.ExtractedLegalComments) tailChunks.push(enc.encode(c + "\n"));
  let tailLen = 0; for (const b of tailChunks) tailLen += b.length;
  const out = new Uint8Array(header.length + body.length + tailLen);
  out.set(header, 0); out.set(body, header.length);
  let off = header.length + body.length;
  for (const b of tailChunks) { out.set(b, off); off += b.length; }
  return { ok: true, output: out };
}

function mkSym(name: string): astNS.Symbol { const s = new astNS.Symbol(); s.OriginalName = name; s.Link = astNS.InvalidRef; return s; }

const argv = process.argv.slice(2);
let entry = "";
for (const arg of argv) if (!arg.startsWith("--")) { entry = arg; break; }
if (entry) {
  const res = bundleSingleFile(new Uint8Array(readFileSync(entry)), entry);
  if (!res.ok) { console.error("bundle1: " + res.error); process.exit(1); }
  writeFileSync(1, res.output);
}
