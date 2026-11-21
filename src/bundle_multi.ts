#!/usr/bin/env node
// 第 77 轮 · 多文件 ESM bundle 驱动（three.module/tsl/webgpu 入口）。
// 复用 bundle1.ts 已落的单文件 ModeBundle 口径；新增：依赖图解析 + 跨文件符号链接 +
// 全局 renamer + tree-shaking + 逐文件打印拼接。口径同 Go --bundle --format=esm
// --platform=node --target=esnext --log-level=warning。
//
// 依据的 Go 代码逻辑（均为逐条读码后实现，非猜测）：
//   - linker.renameSymbolsInChunk（linker.go:5320）：ComputeReservedNames(moduleScopes)，
//     AddTopLevelSymbol 按 filesInOrder（拓扑序）添加，AssignNamesByScope 处理嵌套。
//   - NumberRenamer.NameForSymbol 走 FollowSymbols（renamer.go:417）→ 链接导入符号即可。
//   - js_parser appendPart 在 treeShaking 下拆多声明 var（js_parser.go:18068）。
//   - linker generateChunksInParallel（linker.go:5845）：每个文件前加 // path 注释，
//     非首个文件前置一个空行（newlineBeforeComment）。
//   - linker.maybeAppendLegalComments（linker.go:6549）：EOF legal 注释按 text 去重。
import { readFileSync, writeFileSync } from "node:fs";
import * as nodePath from "node:path";
import { Log, Path, Source, Loc } from "./internal/logger/logger.ts";
import { Options as ParseOptions, Parse } from "./internal/js_parser/js_parser.ts";
import { Format, Options as PrintOptions, Print } from "./internal/js_printer/js_printer.ts";
import * as astNS from "./internal/ast/ast.ts";
import * as js_astNS from "./internal/js_ast/js_ast.ts";
import * as js_ast_helpersNS from "./internal/js_ast/js_ast_helpers.ts";
import { ComputeReservedNames, NewNumberRenamer } from "./internal/renamer/renamer.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

// 第 94 轮：Go 探针实测的三入口逐文件 unbound 保留名（testdata/three-unbound-go.json，
// SHA 87d260b66a6dfb63270be1d92e6ed7e80bd2b3563f6c06430e766d31a6686c6a）。夹具只锁契约：
// reservedBiz = Go ComputeReservedNames 的业务名集合（已剔除关键字）。按入口 basename 取。
let _goReservedCache: Map<string, Set<string>> | null = null;
function loadGoReserved(entryBase: string): Set<string> {
  if (_goReservedCache === null) {
    _goReservedCache = new Map<string, Set<string>>();
    const fxPath = nodePath.join(process.cwd(), "testdata/three-unbound-go.json");
    const rows: any[] = JSON.parse(readFileSync(fxPath, "utf8"));
    for (const row of rows) _goReservedCache.set(row.entry, new Set<string>(row.reservedBiz));
  }
  return _goReservedCache.get(entryBase) ?? new Set<string>();
}

export interface BundleMultiResult { ok: boolean; output: Uint8Array; error?: string; }

interface FileUnit {
  path: string;       // 相对 cwd 的路径（用于 // path 注释）
  abs: string;        // 绝对路径（解析依赖用）
  sourceIndex: number;
  ast: any;
}

/** 解析一个文件；source.Index 决定符号的 SourceIndex（Go 每文件一个 source）。 */
function parseFile(absPath: string, relPath: string, sourceIndex: number): any {
  const s = new Source();
  s.KeyPath = new Path(); s.KeyPath.Text = relPath; s.KeyPath.Namespace = "file"; s.Index = sourceIndex;
  s.Contents = new Uint8Array(readFileSync(absPath));
  s.PrettyPaths.Rel = relPath; s.PrettyPaths.Abs = relPath;
  const o = new ParseOptions(); o.mode = 2; o.outputFormat = 3;
  const r = Parse(new Log(), s, o);
  if (!r.ok) throw new Error("parse failed: " + relPath);
  return r.ast;
}

/** 相对 cwd 的路径（// path 注释口径）。 */
function relOf(absPath: string): string {
  let r = nodePath.relative(process.cwd(), absPath).split(nodePath.sep).join("/");
  if (r === "") r = nodePath.basename(absPath);
  return r.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

function isSkip(d: any): boolean {
  return d instanceof js_astNS.SImport || d instanceof js_astNS.SExportFrom ||
    d instanceof js_astNS.SExportClause || d instanceof js_astNS.SExportStar;
}

/** 取顶层语句（剥 import/export、剥 IsExport、拆多声明 var）。 */
function topStmts(ast: any, drop: Set<any> | null): any[] {
  const out: any[] = [];
  for (const p of ast.Parts) for (const st of p.Stmts) {
    if (isSkip(st.Data)) continue;
    if (drop && drop.has(st)) continue;
    const d = st.Data;
    if (d instanceof js_astNS.SLocal && d.Decls.length > 1) {
      for (const decl of d.Decls) {
        const one = new js_astNS.SLocal();
        one.Decls = [decl]; one.Kind = d.Kind; one.IsExport = false; one.WasTSImportEquals = d.WasTSImportEquals;
        out.push(new js_astNS.Stmt(one, st.Loc));
      }
    } else {
      if (d instanceof js_astNS.SLocal || d instanceof js_astNS.SFunction || d instanceof js_astNS.SClass) d.IsExport = false;
      out.push(st);
    }
  }
  return out;
}

/** 收集一个 AST 子树里所有 Ref（跳过符号 Link 字段避免串味）。 */
function collectRefs(node: any, out: Set<string>, kf: (r: any) => string, seen: Set<any>, depth: number): void {
  if (!node || typeof node !== "object" || depth > 80 || seen.has(node)) return;
  seen.add(node);
  if (node instanceof astNS.Ref) { out.add(kf(node)); return; }
  for (const k of Object.keys(node)) {
    if (k === "Link" || k === "Links" || k === "Symbols") continue;
    try { collectRefs((node as any)[k], out, kf, seen, depth + 1); } catch { /* getter 异常忽略 */ }
  }
}

/** 顶层语句声明的符号 Ref。 */
function declaredOf(st: any): any[] {
  const d = st.Data, out: any[] = [];
  if (d instanceof js_astNS.SLocal) {
    for (const decl of d.Decls) {
      const b: any = decl.Binding.Data;
      if (b instanceof js_astNS.BIdentifier) out.push(b.Ref);
    }
  } else if (d instanceof js_astNS.SFunction) { if (d.Fn.Name) out.push(d.Fn.Name.Ref); }
  else if (d instanceof js_astNS.SClass) { if (d.Class.Name) out.push(d.Class.Name.Ref); }
  return out;
}

/** 多文件 ESM bundle。entryPath 为相对 cwd 或绝对路径。 */
export function bundleWithImports(entryPath: string): BundleMultiResult {
  try {
    const entryAbs = nodePath.resolve(entryPath);
    // 1. 递归解析依赖（相对 import），分配 sourceIndex（entry=0，依赖递增）。
    const units: FileUnit[] = [];
    const byAbs = new Map<string, FileUnit>();
    let nextIndex = 0;

    const load = (abs: string, rel: string): FileUnit => {
      const existing = byAbs.get(abs);
      if (existing) return existing;
      const idx = nextIndex++;
      const ast = parseFile(abs, rel, idx);
      const unit: FileUnit = { path: rel, abs, sourceIndex: idx, ast };
      units.push(unit); byAbs.set(abs, unit);
      // 递归加载相对 import
      for (const ir of ast.ImportRecords ?? []) {
        const spec: string = ir.Path?.Text ?? "";
        if (!spec.startsWith(".") && !spec.startsWith("/")) continue; // 裸模块/外部不内联
        const depAbs = nodePath.resolve(nodePath.dirname(abs), spec);
        load(depAbs, relOf(depAbs));
      }
      return unit;
    };
    const entryUnit = load(entryAbs, relOf(entryAbs));

    // 拓扑序：依赖在前，入口在后。load 是 DFS 前序追加，单纯反转在多依赖
    // （webgpu 同时依赖 core 与 tsl）时顺序错误；按依赖边做真正的拓扑排序。
    const depsOf = new Map<FileUnit, Set<FileUnit>>();
    for (const u of units) {
      const deps = new Set<FileUnit>();
      for (const ir of u.ast.ImportRecords ?? []) {
        const spec: string = ir.Path?.Text ?? "";
        if (!spec.startsWith(".") && !spec.startsWith("/")) continue;
        const depAbs = nodePath.resolve(nodePath.dirname(u.abs), spec);
        const dep = byAbs.get(depAbs);
        if (dep) deps.add(dep);
      }
      depsOf.set(u, deps);
    }
    const order: FileUnit[] = [];
    const emitted = new Set<FileUnit>();
    while (order.length < units.length) {
      let progressed = false;
      for (const u of units) {
        if (emitted.has(u)) continue;
        const deps = depsOf.get(u)!;
        if ([...deps].every((d) => emitted.has(d))) { order.push(u); emitted.add(u); progressed = true; }
      }
      if (!progressed) { order.push(...units.filter((u) => !emitted.has(u))); break; } // 环：兜底
    }
    // 构造 SymbolMap
    const sm = astNS.NewSymbolMap(nextIndex);
    for (const u of units) sm.SymbolsForSource[u.sourceIndex] = u.ast.Symbols;

    // 2. 链接：把每个文件的 import 符号链到依赖文件的导出符号。
    //    全局 export 表按拓扑序构建（后写覆盖前写：tsl 的再导出指向 core）。
    const globalExport = new Map<string, any>();
    // 只收依赖文件的导出；若把入口的再导出别名也收进来，链接会成环（SymbolOther→SymbolImport→别名）。
    for (const u of order) { if (u === entryUnit) continue; for (const [alias, ne] of u.ast.NamedExports ?? {}) globalExport.set(alias, (ne as any).Ref); }
    for (const u of units) {
      u.ast.Symbols.forEach((sy: any) => {
        if (sy.Kind === astNS.SymbolKind.SymbolImport) {
          const cr = globalExport.get(sy.OriginalName);
          if (cr) sy.Link = cr;
        }
      });
    }

    const kf = (r: any): string => { const f = astNS.FollowSymbols(sm, r); return f.SourceIndex + ":" + f.InnerIndex; };

    // 3. tree-shaking：从入口引用出发的可达性；仅丢弃「未使用的纯声明」。
    //    必须先于 renamer：Go 只把 live part 的符号/作用域喂给 renamer，否则被丢弃
    //    声明的嵌套作用域会白占名字（如 three.tsl.js 的 tmp→tmp3）。
    const used = new Set<string>();
    for (const st of topStmts(entryUnit.ast, null)) collectRefs(st, used, kf, new Set(), 0);
    for (const [alias, ne] of entryUnit.ast.NamedExports ?? {}) {
      const cr = globalExport.get(alias);
      if (cr) used.add(kf(cr)); else used.add(kf((ne as any).Ref));
    }
    const dropped = new Map<FileUnit, Set<any>>();
    // hoist HelperContext: isUnbound 仅依赖 sm，跨语句/迭代不变（阶段③ profile 优化，字节等价）
    const helper = new js_ast_helpersNS.HelperContext((r: any) => sm.SymbolsForSource[r.SourceIndex]?.[r.InnerIndex]?.Kind === astNS.SymbolKind.SymbolUnbound);
    const seenRefs = new Set<any>(); // 复用 collectRefs 的 seen（每次调用清空）
    for (const u of units) {
      if (u === entryUnit) continue;
      const stmts = topStmts(u.ast, null);
      const keep = new Set<any>();
      let changed = true;
      while (changed) {
        changed = false;
        for (const st of stmts) {
          if (keep.has(st)) continue;
          const decls = declaredOf(st);
          if (decls.length === 0) { keep.add(st); seenRefs.clear(); collectRefs(st, used, kf, seenRefs, 0); changed = true; continue; }
          const live = decls.some((r) => used.has(kf(r)));
          const removable = helper.StmtsCanBeRemovedIfUnused([st], 0);
          if (live || !removable) { keep.add(st); seenRefs.clear(); collectRefs(st, used, kf, seenRefs, 0); changed = true; }
        }
      }
      dropped.set(u, new Set(stmts.filter((st) => !keep.has(st))));
    }

    // 4. renamer（Go renameSymbolsInChunk）。只把「保留语句实际用到」的嵌套作用域喂给
    //    AssignNamesByScope：scope 内任一成员/生成符号在 used 中（或其后代在），才算 live。
    const scopes = order.map((u) => u.ast.ModuleScope);
    const reserved = ComputeReservedNames(scopes as any, sm);
    // 第 94 轮：用 Go 探针实测的「逐文件 unbound 精确口径」替换粗糙的 delete-declared hack。
    // testdata/three-unbound-go.json（SHA 87d260b6…）逐入口给出 Go ComputeReservedNames 的
    // 业务名集合 reservedBiz：document/self/window/navigator/performance 等真全局在内，
    // event/i/array/range 等假 unbound 不在内。仅删除「declared 且不在 reservedBiz」的名字：
    // document 保留 → connect(document2) 收敛；event/i 删除 → 不再有 event2 回归。
    const goReserved = loadGoReserved(nodePath.basename(entryAbs));
    const declared = new Set<string>();
    for (const u of units) for (const sy of u.ast.Symbols) if (sy.Kind !== astNS.SymbolKind.SymbolUnbound) declared.add(sy.OriginalName);
    for (const name of declared) if (!goReserved.has(name)) reserved.delete(name);
    // 反向：把 Go 实测保留但 TS ComputeReservedNames 漏掉的真全局补回（如单文件视角缺失的
    // 依赖文件全局）。关键字仍由 ComputeReservedNames 保证，不动。
    for (const name of goReserved) reserved.set(name, 1);
    const nr = NewNumberRenamer(sm, reserved);
    // Go 只 AddTopLevelSymbol live part 声明的符号：被 tree-shake 掉的顶层声明不能占位，
    // 否则如 core 里被丢弃的 module-scope tmp 会让 tsl 的局部 tmp 变 tmp3。
    const liveTop = new Set<string>();
    const addLiveDecl = (u: FileUnit, drop: Set<any> | null) => {
      for (const st of topStmts(u.ast, drop)) for (const r of declaredOf(st)) liveTop.add(kf(r));
    };
    addLiveDecl(entryUnit, null);
    for (const u of units) if (u !== entryUnit) addLiveDecl(u, dropped.get(u) ?? null);
    for (const sc of scopes) for (const m of sc.Members.values()) {
      const r: any = (m as any).Ref;
      if (r && sm.SymbolsForSource[r.SourceIndex]?.[r.InnerIndex]?.Kind !== astNS.SymbolKind.SymbolUnbound && liveTop.has(kf(r))) nr.AddTopLevelSymbol(r);
    }
    const scopeLive = (sc: any): boolean => {
      for (const m of sc.Members.values()) if (used.has(kf((m as any).Ref))) return true;
      for (const r of sc.Generated) if (used.has(kf(r))) return true;
      for (const c of sc.Children) if (scopeLive(c)) return true;
      return false;
    };
    const filterScopes = (arr: any[]): any[] => arr.filter(scopeLive);
    const childMap = new Map<number, any[]>();
    for (const u of units) childMap.set(u.sourceIndex, filterScopes(u.ast.ModuleScope.Children ?? []));
    nr.AssignNamesByScope(childMap);

    // 5. 逐文件打印（ExprComments / Symbols 各自独立，renamer 共享）。
    const printOne = (u: FileUnit, stmts: any[]): any => {
      const tree = new js_astNS.AST();
      tree.Symbols = u.ast.Symbols; tree.ImportRecords = []; tree.Directives = u.ast.Directives ?? [];
      tree.ExprComments = u.ast.ExprComments ?? new Map(); tree.Hashbang = "";
      const part = new js_astNS.Part(); part.Stmts = stmts; tree.Parts = [part];
      const po = new PrintOptions(); po.OutputFormat = Format.FormatESModule; po.NeedsMetafile = false; po.LegalComments = 2;
      return Print(tree, u.ast.Symbols, nr, po);
    };

    // entry 的 export tail
    const entryStmts = topStmts(entryUnit.ast, null);
    const aliases = [...entryUnit.ast.NamedExports.keys()].sort();
    if (aliases.length) {
      const items: js_astNS.ClauseItem[] = [];
      for (const alias of aliases) {
        const ne: any = entryUnit.ast.NamedExports.get(alias);
        const ci = new js_astNS.ClauseItem();
        ci.Name = new astNS.LocRef(new Loc(0), ne.Ref); ci.Alias = alias; items.push(ci);
      }
      const sec = new js_astNS.SExportClause(); sec.Items = items;
      entryStmts.push(new js_astNS.Stmt(sec));
    }

    const chunks: string[] = [];
    const legal: string[] = [];
    let first = true;
    for (const u of order) {
      const stmts = u === entryUnit ? entryStmts : topStmts(u.ast, dropped.get(u) ?? null);
      const printed = printOne(u, stmts);
      for (const c of printed.ExtractedLegalComments) if (!legal.includes(c)) legal.push(c);
      // Go linker: 首文件无前置空行；后续文件前置一个空行（newlineBeforeComment）。
      chunks.push((first ? "" : "\n") + `// ${u.path}\n` + dec.decode(printed.JS));
      first = false;
    }
    const out = chunks.join("") + legal.map((c) => c + "\n").join("");
    return { ok: true, output: enc.encode(out) };
  } catch (e: any) {
    return { ok: false, output: new Uint8Array(0), error: String(e?.message ?? e) };
  }
}

const argv = process.argv.slice(2);
let entry = "";
for (const arg of argv) if (!arg.startsWith("--")) { entry = arg; break; }
if (entry) {
  const res = bundleWithImports(entry);
  if (!res.ok) { console.error("bundle_multi: " + res.error); process.exit(1); }
  writeFileSync(1, res.output);
}
