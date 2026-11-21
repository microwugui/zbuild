// 单文件 transform-equivalent 驱动（第 75 轮 · 任务 A）。
// 目标：TS Parse + 真 NumberRenamer + export tail 重写，逐字节等于
//   /tmp/esbuild-go --loader=js --format=esm --target=esnext （Go transform，无 bundle）。
// 全部复用已移植件：js_parser.Parse / renamer.NumberRenamer / js_printer.Print。
// 仅验证 JS-only、无 import 单文件。
import { Log, Path, Source, Loc } from "./internal/logger/logger.ts";
import { Options as ParseOptions, Parse } from "./internal/js_parser/js_parser.ts";
import { Format, Options as PrintOptions, Print } from "./internal/js_printer/js_printer.ts";
import * as astNS from "./internal/ast/ast.ts";
import * as js_astNS from "./internal/js_ast/js_ast.ts";
import { ComputeReservedNames, NewNumberRenamer } from "./internal/renamer/renamer.ts";

export interface TransformResult { ok: boolean; JS: Uint8Array; error?: string; }

/**
 * Go transform 的单文件等价管线（0 import、esm、esnext、JS-only）：
 *   Parse -> NumberRenamer(non-minify) -> strip export 关键字 -> append export tail -> Print
 *
 * 第 97 轮：`printOpts` 透传 format/minifyWhitespace/lineLimit/charset 到 Print；
 * `parseOpts` 透传 defines/unsupportedJSFeatures 到 Parse（第 98 轮做真：defines 与 target 降级）。
 */
export function transformEquivalent(contents: Uint8Array, printOpts?: PrintOptions, parseOpts?: ParseOptions): TransformResult {
  const source = new Source();
  source.KeyPath = new Path(); source.KeyPath.Text = "<stdin>"; source.Contents = contents;
  const log = new Log();
  const parsed = Parse(log, source, parseOpts ?? new ParseOptions());
  if (!parsed.ok) return { ok: false, JS: new Uint8Array(0), error: "parse failed" };
  const a: any = parsed.ast;

  // --- 1) 构造 SymbolMap（单源文件 sourceIndex=0）并跑 NumberRenamer ---
  const sm = astNS.NewSymbolMap(1);
  sm.SymbolsForSource[0] = a.Symbols;
  const moduleScope: any = a.ModuleScope;
  const reserved = moduleScope ? ComputeReservedNames([moduleScope], sm) : new Map<string, number>();
  // TS parse 期即时绑定会把「在嵌套作用域声明但使用在前」的局部名误当成 unbound，
  // 塞进 moduleScope 而被 ComputeReservedNames 误 reserve。Go 两趟解析会把它们绑定到
  // 真实声明，因而不 reserve。过滤：凡是本文件中有「非 unbound 声明」的名字，都不是真全局。
  {
    const declared = new Set<string>();
    for (const sy of a.Symbols) if (sy.Kind !== astNS.SymbolKind.SymbolUnbound) declared.add(sy.OriginalName);
    for (const name of declared) reserved.delete(name);
  }
  const nr = NewNumberRenamer(sm, reserved);
  if (moduleScope) {
    // Go: 顶层符号来自 live part 的 top-level DeclaredSymbols。TS 骨架的 IsTopLevel 标记
    // 在大文件上不完整（顶层 const 漏标），改用 moduleScope.Members 中「非 unbound」的符号，
    // 即真正声明在模块作用域的符号（排除 parse 期即时绑定产生的 unbound 占位符）。
    for (const m of moduleScope.Members.values()) {
      const mref: any = (m as any).Ref;
      if (mref && a.Symbols[mref.InnerIndex] && a.Symbols[mref.InnerIndex].Kind !== astNS.SymbolKind.SymbolUnbound) {
        nr.AddTopLevelSymbol(mref);
      }
    }
    // Go 只把「收集到的嵌套作用域」（part.Scopes，即 moduleScope 的 Children）传给
    // AssignNamesByScope；模块作用域自身的顶层符号由 AddTopLevelSymbol 单独处理。
    nr.AssignNamesByScope(new Map([[0, moduleScope.Children ?? []]]));
  }

  // --- 2) strip export 关键字：清 SExportClause / IsExport ---
  // FormatPreserve（无 --format）下 Go 保留原导出子句并按单行 print（`export { x };`），
  // 不重生成 tail；仅 ESM/IIFE/CJS 由 tail 重写为多行。
  const preserveFormat = printOpts !== undefined && printOpts.OutputFormat === Format.FormatNone;
  const outStmts: js_astNS.Stmt[] = [];
  for (const p of a.Parts) {
    for (const st of p.Stmts) {
      const d: any = st.Data;
      if (d instanceof js_astNS.SExportClause && !preserveFormat) continue; // 导出子句由 tail 重写
      let s = st;
      if (!preserveFormat) {
        if (d instanceof js_astNS.SLocal && d.IsExport) {
          const c = new js_astNS.SLocal(); c.Decls = d.Decls; c.Kind = d.Kind; c.IsExport = false; c.WasTSImportEquals = d.WasTSImportEquals;
          s = new js_astNS.Stmt(c, st.Loc);
        } else if (d instanceof js_astNS.SFunction && d.IsExport) {
          const c = new js_astNS.SFunction(); c.Fn = d.Fn; c.IsExport = false; s = new js_astNS.Stmt(c, st.Loc);
        } else if (d instanceof js_astNS.SClass && d.IsExport) {
          const c = new js_astNS.SClass(); c.Class = d.Class; c.IsExport = false; s = new js_astNS.Stmt(c, st.Loc);
        }
      }
      outStmts.push(s);
    }
  }

  // --- 3) export tail：alias 排序后逐条 clause（与 generateEntryPointTailJS ESM 分支同构）---
  if (!preserveFormat && a.NamedExports && a.NamedExports.size > 0) {
    const aliases = [...a.NamedExports.keys()].sort();
    const items: js_astNS.ClauseItem[] = [];
    for (const alias of aliases) {
      const ne: any = a.NamedExports.get(alias);
      const ci = new js_astNS.ClauseItem();
      ci.Name = new astNS.LocRef(new Loc(0), ne.Ref); ci.Alias = alias;
      items.push(ci);
    }
    const sec = new js_astNS.SExportClause(); sec.Items = items;
    outStmts.push(new js_astNS.Stmt(sec));
  }

  // --- 4) Print ---
  const outAst = new js_astNS.AST();
  outAst.Symbols = a.Symbols; outAst.ImportRecords = a.ImportRecords; outAst.Directives = a.Directives ?? [];
  outAst.ExprComments = a.ExprComments ?? new Map(); outAst.Hashbang = a.Hashbang ?? "";
  const part = new js_astNS.Part(); part.Stmts = outStmts; outAst.Parts = [part];
  const po = printOpts ?? new PrintOptions();
  if (printOpts === undefined) po.OutputFormat = Format.FormatESModule;
  return { ok: true, JS: Print(outAst, a.Symbols, nr, po).JS };
}
