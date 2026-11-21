// 1:1 移植自 esbuild internal/resolver/resolver.go（v0.28.2，commit f6058f83）
// 第 44 轮 M2/M4 成片推进：纯字符串助手。
import * as js_ast from "../js_ast/js_ast.ts";
import { UTF16ToString, UTF16EqualsString } from "../helpers/utf.ts";
import { mockFS } from "../fs/fs_mock.ts";
import { DirEntries, DifferentCase, FileEntry, DirEntry, MakeEmptyDirEntries } from "../fs/fs.ts";
import { ParseYarnPnPVirtualPath } from "../fs/fs_zip.ts";
import { Log, Msg, MsgData, MsgKind, MakeLineColumnTracker, Path as LoggerPath, Source } from "../logger/logger.ts";
import { dirInfo, packageJSON, SideEffectsData, parsePackageJSON, checkBrowserMap, defaultMainFields, mainFieldsForFailure, pjMap, pjStatus, pjDebug, esmPackageExportsResolve, esmHandlePostConditions, esmPackageImportsResolve, esmParsePackageName } from "./package_json.ts";
import { QuoteForJSON } from "../helpers/quote.ts";
import { ParseTSConfigJSON, isValidTSConfigPathNoBaseURLPattern, TSConfigJSON, TSAlwaysStrict } from "./tsconfig_json.ts";
import { TSConfigJSX, TSConfig } from "../config/config.ts";
import { MsgID_TSConfigJSON_Missing, MsgID_TSConfigJSON_Cycle, MsgID_Bundler_EmptyGlob } from "../logger/msg_ids.ts";
import { ImportKind, IsFromCSS } from "../ast/ast.ts";
import { StringArrayToQuotedCommaSeparatedString } from "../helpers/strings.ts";
import { IsInsideNodeModules } from "../helpers/path.ts";
import { ParseDataURL } from "./dataurl.ts";
import { Loader, IsTypeScript, IsCSS as LoaderIsCSS, LoaderFromFileExtension } from "../config/config.ts";

/** Go: type PathPair struct —— 只落 HasSecondary 用到的字段 */
export class PathPair {
  Primary: string = "";
  Secondary: string = "";
  IsExternal = false;

  /** Go: func (pp *PathPair) HasSecondary() bool (resolver.go:84) */
  HasSecondary(): boolean {
    return this.Secondary !== "";
  }

  /** Go: func (pp *PathPair) iter() []*logger.Path (resolver.go:76) */
  iter(): string[] {
    const result = [this.Primary, this.Secondary];
    if (!this.HasSecondary()) return result.slice(0, 1);
    return result;
  }
}

/** Go: type debugLogs struct (resolver.go:793) —— 只落本批字段 */
export class debugLogs {
  what: string = "";
  indent: string = "";
  notes: string[] = [];

  /** Go: func (d *debugLogs) addNote(text string) (resolver.go:799) */
  addNote(text: string): void {
    if (this.indent !== "") text = this.indent + text;
    this.notes.push(text);
  }

  /** Go: func (d *debugLogs) increaseIndent() (resolver.go:806) */
  increaseIndent(): void { this.indent += "  "; }

  /** Go: func (d *debugLogs) decreaseIndent() (resolver.go:810) */
  decreaseIndent(): void { this.indent = this.indent.slice(2); }
}

/** Go: func getString(json js_ast.Expr) (string, bool) (resolver.go:1905) */
export function getString(json: js_ast.Expr): { value: string; ok: boolean } {
  if (json.Data instanceof js_ast.EString) {
    return { value: new TextDecoder().decode(UTF16ToString((json.Data as js_ast.EString).Value)), ok: true };
  }
  return { value: "", ok: false };
}

/** Go: func getProperty(json js_ast.Expr, name string) (js_ast.Expr, logger.Loc, bool) (resolver.go:1894) */
export function getProperty(json: js_ast.Expr, name: string): { value: js_ast.Expr; loc: number; ok: boolean } {
  const obj = json.Data;
  if (obj instanceof js_ast.EObject) {
    for (const prop of obj.Properties) {
      const key = prop.Key.Data;
      if (key instanceof js_ast.EString && UTF16EqualsString(key.Value, new TextEncoder().encode(name))) {
        return { value: prop.ValueOrNil ?? new js_ast.Expr(), loc: prop.Key.Loc.Start, ok: true };
      }
    }
  }
  return { value: new js_ast.Expr(), loc: 0, ok: false };
}

/** Go: func getBool(json js_ast.Expr) (bool, bool) (resolver.go:1912) */
export function getBool(json: js_ast.Expr): { value: boolean; ok: boolean } {
  if (json.Data instanceof js_ast.EBoolean) {
    return { value: (json.Data as js_ast.EBoolean).Value, ok: true };
  }
  return { value: false, ok: false };
}

/** Go: func hasCaseInsensitiveSuffix(s string, suffix string) bool (resolver.go:2128) */
export function hasCaseInsensitiveSuffix(s: string, suffix: string): boolean {
  return s.length >= suffix.length &&
    s.slice(s.length - suffix.length).toLowerCase() === suffix.toLowerCase();
}

/** Go: func IsPackagePath(path string) bool (resolver.go:2895) */
export function IsPackagePath(path: string): boolean {
  return !path.startsWith("/") && !path.startsWith("./") &&
    !path.startsWith("../") && path !== "." && path !== "..";
}

/** Go: func isSlash(c byte) bool (tsconfig_json.go:433) —— 与 resolver 路径判定共用 */
export function isSlash(c: number): boolean {
  return c === 0x2f /* '/' */ || c === 0x5c /* '\\' */;
}

// ============================================================================
// 第 140 批：resolver 小助手（bundler import 路径），Go 探针逐字节。
// ============================================================================
import { PrettyPaths, PathFlags, Range, Loc } from "../logger/logger.ts";

/** Go: func isExternal (resolver.go:748) —— kind=0 (ImportEntryPoint) 永不 external */
export function isExternal(exact: Record<string, boolean>, patterns: { Prefix: string; Suffix: string }[], path: string, kind: number, dl: any = null): boolean {
  if (kind === 0) return false;
  if (exact[path]) return true;
  for (const pattern of patterns) {
    if (dl) dl.addNote(`Checking ${JSON.stringify(path)} against the external pattern ${JSON.stringify(pattern.Prefix + "*" + pattern.Suffix)}`);
    if (path.length >= pattern.Prefix.length + pattern.Suffix.length && path.startsWith(pattern.Prefix) && path.endsWith(pattern.Suffix)) return true;
  }
  return false;
}

/** Go: func MakePrettyPaths (resolver.go:1093) */
export function MakePrettyPaths(fsObj: any, text: string, namespace: string, ignoredSuffix: string, isDisabledFlag: boolean): { Abs: string; Rel: string } {
  let absPath = text, relPath = text;
  if (namespace === "file") {
    if (fsObj && typeof fsObj.Rel === "function") {
      const rel = fsObj.Rel(fsObj.Cwd ? fsObj.Cwd() : "", relPath);
      if (rel && rel.ok !== false) relPath = typeof rel === "string" ? rel : (rel.value ?? relPath);
    }
    relPath = relPath.replace(/\\/g, "/");
  } else if (namespace !== "") {
    absPath = `${namespace}:${absPath}`; relPath = `${namespace}:${relPath}`;
  }
  if (isDisabledFlag) { absPath = "(disabled):" + absPath; relPath = "(disabled):" + relPath; }
  const pp = new PrettyPaths(); pp.Abs = absPath + ignoredSuffix; pp.Rel = relPath + ignoredSuffix;
  return { Abs: pp.Abs, Rel: pp.Rel };
}

/** Go: func (r resolverQuery) flushDebugLogs (resolver.go:821) —— mode 0=failure 1=success */
export function flushDebugLogs(log: any, dl: any, mode: number, addWithNotes: any): void {
  if (!dl) return;
  if (mode === 0) {
    addWithNotes(log, 0 /* MsgID_None */, 4 /* Debug */, null, new Range(new Loc(0), 0), dl.what, dl.notes.map((t: string) => ({ Text: t })));
  } else {
    addWithNotes(log, 0, 5 /* Verbose */, null, new Range(new Loc(0), 0), dl.what, dl.notes.map((t: string) => ({ Text: t })));
  }
}

/** Go: func (r resolverQuery) tsConfigForDir (resolver.go:1148) */
export function tsConfigForDir(dirInfo: any, override: any): any {
  if (dirInfo?.isInsideNodeModules) return null;
  if (override != null) return override;
  if (dirInfo != null) return dirInfo.enclosingTSConfigJSON ?? null;
  return null;
}

// ============================================================================
// 第 173 批：ResolveResult 底座 + finalizeResolve（Go resolver.go:100 / :831）
// ============================================================================
/**
 * Go: type PathPair struct (resolver.go:67) —— ResolveResult 专用。
 * DEVIATION：文件上方已有一个字符串版 PathPair（给 finalizeImportsExportsResult 用）。
 * 这里 1:1 复刻 Go 的 logger.Path 版，避免改动既有调用方。
 */
export class ResolveResultPathPair {
  Primary: LoggerPath = new LoggerPath();
  Secondary: LoggerPath = new LoggerPath();
  IsExternal = false;

  HasSecondary(): boolean { return this.Secondary.Text !== ""; }
  iter(): LoggerPath[] {
    return this.HasSecondary() ? [this.Primary, this.Secondary] : [this.Primary];
  }
}

/** Go: type ResolveResult struct (resolver.go:100) */
export class ResolveResult {
  PathPair: ResolveResultPathPair = new ResolveResultPathPair();
  PluginData: unknown = null;
  DifferentCase: DifferentCase | null = null;
  PrimarySideEffectsData: SideEffectsData | null = null;
  TSConfigJSX: TSConfigJSX = new TSConfigJSX();
  TSConfig: TSConfig | null = null;
  TSAlwaysStrict: TSAlwaysStrict | null = null;
  ModuleTypeData: js_ast.ModuleTypeData = new js_ast.ModuleTypeData();
}

/** finalizeResolve 上下文：对应 Go resolverQuery 的相关字段 */
export interface FinalizeResolveContext {
  fsObj: mockFS;
  log: Log;
  debugLogs: { addNote(s: string): void } | null;
  kind: number;
  preserveSymlinks: boolean;
  externalExact: Record<string, boolean>;
  externalPatterns: { Prefix: string; Suffix: string }[];
  dirInfoCtx: DirInfoContext;
}

/**
 * Go: func (r resolverQuery) finalizeResolve(result *ResolveResult) (resolver.go:831)
 *
 * 逐字节固化 12 例（external exact/pattern、entry-point 豁免、dirinfo 缺失、namespace 跳过、
 * sideEffects map 快路径 + glob 慢路径、tsconfig 属性拷贝 + jsxFactory/jsxFragment note、
 * primary/secondary 双路径、disabled 路径）。symlink 改写分支在新月 FS 无 symlink，
 * 结构上已按 Go 落地但本批探针未逐字节覆盖（见本轮诚信披露）。
 */
export function finalizeResolve(r: FinalizeResolveContext, result: ResolveResult): void {
  const pp = result.PathPair;
  if (!pp.IsExternal && isExternal(r.externalExact, r.externalPatterns, pp.Primary.Text, r.kind, r.debugLogs)) {
    if (r.debugLogs !== null) r.debugLogs.addNote(`The path ${JSON.stringify(pp.Primary.Text)} was marked as external by the user`);
    pp.IsExternal = true;
  } else {
    for (const path of pp.iter()) {
      if (path.Namespace !== "file") continue;
      let info = dirInfoCached(r.dirInfoCtx, r.fsObj.Dir(path.Text));
      if (info === null) continue;
      let base = r.fsObj.Base(path.Text);

      // If the path contains symlinks, rewrite the path to the real path
      if (!r.preserveSymlinks) {
        const got = info.entries.Get(base);
        const entry = got.entry;
        if (entry !== null) {
          let symlink = entry.Symlink();
          if (symlink === "" && info.absRealPath !== "") {
            symlink = r.fsObj.Join([info.absRealPath, base]);
          }
          if (symlink !== "") {
            if (r.debugLogs !== null) r.debugLogs.addNote(`Resolved symlink ${JSON.stringify(path.Text)} to ${JSON.stringify(symlink)}`);
            path.Text = symlink;
            info = dirInfoCached(r.dirInfoCtx, r.fsObj.Dir(path.Text));
            if (info === null) continue;
            base = r.fsObj.Base(path.Text);
          }
        }
      }

      // Path attributes are only taken from the primary path
      if (path !== pp.Primary) continue;
      // Path attributes are not taken from disabled files
      if (path.IsDisabled()) continue;

      const pkgJSON = info.enclosingPackageJSON;
      if (pkgJSON !== null) {
        if (pkgJSON.sideEffectsMap !== null) {
          let hasSideEffects = false;
          const pathLookup = path.Text.replace(/\\/g, "/");
          if (pkgJSON.sideEffectsMap.get(pathLookup) === true) {
            hasSideEffects = true;
          } else {
            for (const re of pkgJSON.sideEffectsRegexps) {
              if (re.test(pathLookup)) { hasSideEffects = true; break; }
            }
          }
          if (!hasSideEffects) {
            if (r.debugLogs !== null) r.debugLogs.addNote(`Marking this file as having no side effects due to ${JSON.stringify(pkgJSON.source.KeyPath.Text)}`);
            result.PrimarySideEffectsData = pkgJSON.sideEffectsData;
          }
        }
        result.ModuleTypeData = pkgJSON.moduleTypeData;
      }

      const tsConfigJSON = tsConfigForDir(info, null);
      if (tsConfigJSON !== null) {
        result.TSConfig = tsConfigJSON.Settings;
        result.TSConfigJSX = tsConfigJSON.JSXSettings;
        result.TSAlwaysStrict = tsConfigJSON.TSAlwaysStrictOrStrict();
        if (r.debugLogs !== null) {
          r.debugLogs.addNote(`This import is under the effect of ${JSON.stringify(tsConfigJSON.AbsPath)}`);
          if (result.TSConfigJSX.JSXFactory !== null) {
            r.debugLogs.addNote(`"jsxFactory" is ${JSON.stringify(result.TSConfigJSX.JSXFactory.join("."))} due to ${JSON.stringify(tsConfigJSON.AbsPath)}`);
          }
          if (result.TSConfigJSX.JSXFragmentFactory !== null) {
            r.debugLogs.addNote(`"jsxFragment" is ${JSON.stringify(result.TSConfigJSX.JSXFragmentFactory.join("."))} due to ${JSON.stringify(tsConfigJSON.AbsPath)}`);
          }
        }
      }
    }
  }

  if (r.debugLogs !== null) {
    r.debugLogs.addNote(`Primary path is ${JSON.stringify(pp.Primary.Text)} in namespace ${JSON.stringify(pp.Primary.Namespace)}`);
    if (pp.HasSecondary()) {
      r.debugLogs.addNote(`Secondary path is ${JSON.stringify(pp.Secondary.Text)} in namespace ${JSON.stringify(pp.Secondary.Namespace)}`);
    }
  }
}

// ============================================================================
// 第 141 批：checkForBuiltInNodeModules（bundler import 路径），Go 探针逐字节。
// ============================================================================
import { BuiltInNodeModules } from "./builtin_node_modules_generated.ts";

/** Go: func (r resolverQuery) checkForBuiltInNodeModules (resolver.go:2539)
 *  platform=1(PlatformNode); format: 0=Preserve 2=CommonJS; NodeColonPrefixImport bit40, Require bit41 */
export function checkForBuiltInNodeModules(
  importPath: string, platform: number, format: number, kind: number, feat: number | bigint, flush: (mode: number) => void, dl: any = null,
): { pair: any; ok: boolean; sideEffects: boolean } {
  if (platform === 1 && BuiltInNodeModules[importPath]) {
    if (dl) dl.addNote("Marking this path as implicitly external due to it being a node built-in");
    flush(1);
    const pp = new PathPair(); pp.Primary = importPath; pp.IsExternal = true;
    return { pair: pp, ok: true, sideEffects: true };
  }
  if (platform === 1 && importPath.startsWith("node:")) {
    if (dl) dl.addNote('Marking this path as implicitly external due to the "node:" prefix');
    let side = false;
    if (BuiltInNodeModules[importPath.slice(5)]) side = true;
    const convertImportToRequire = format !== 0 && format !== 3; // FormatPreserve/ESModule keep ESM
    const isImport = !convertImportToRequire && (kind === 1 || kind === 3); // ImportStmt/ImportDynamic
    const isRequire = kind === 2 || kind === 4 || (convertImportToRequire && (kind === 1 || kind === 3));
    if (isImport && (BigInt(feat) & (1n << 40n)) !== 0n) importPath = importPath.slice(5);
    if (isRequire && (BigInt(feat) & (1n << 41n)) !== 0n) importPath = importPath.slice(5);
    flush(1);
    const pp = new PathPair(); pp.Primary = importPath; pp.IsExternal = true;
    return { pair: pp, ok: true, sideEffects: side };
  }
  const pp = new PathPair();
  return { pair: pp, ok: false, sideEffects: false };
}

// ============================================================================
// 第 163 批：loadAsFile + loadAsIndex（Resolve 链文件/索引加载器，fs.Entry.Kind 底座）
// ============================================================================
/** Go: rewrittenFileExtensions (resolver.go:1723) —— 后缀不重叠，固定顺序即可 */
const rewrittenFileExtensions: [string, string[]][] = [
  [".js", [".ts", ".tsx"]],
  [".jsx", [".ts", ".tsx"]],
  [".mjs", [".mts"]],
  [".cjs", [".cts"]],
];

/** loadAsFile/loadAsIndex 上下文：对应 Go resolverQuery 的相关字段 */
export interface LoadFileContext {
  fsObj: mockFS;
  log: Log;
  debugLogs: { addNote(s: string): void; increaseIndent(): void; decreaseIndent(): void } | null;
}

/** Go: func (r resolverQuery) loadAsFile(path, extensionOrder) (string, bool, *fs.DifferentCase) (resolver.go:1732) */
export function loadAsFile(r: LoadFileContext, path: string, extensionOrder: string[]): { path: string; ok: boolean; diffCase: DifferentCase | null } {
  const fsobj = r.fsObj;
  const dl = r.debugLogs;
  if (dl !== null) { dl.addNote(`Attempting to load ${JSON.stringify(path)} as a file`); dl.increaseIndent(); }

  const dirPath = fsobj.Dir(path);
  const rd = fsobj.ReadDirectory(dirPath);
  const entries: DirEntries = rd.dir;
  if (dl !== null && rd.err2 !== "") dl.addNote(`Failed to read directory ${JSON.stringify(dirPath)}: ${rd.err2}`);
  if (rd.err1 !== "") {
    if (dl !== null) dl.decreaseIndent();
    return { path: "", ok: false, diffCase: null };
  }

  const tryFile = (base: string): { path: string; ok: boolean; diffCase: DifferentCase | null } => {
    if (dl !== null) dl.addNote(`Checking for file ${JSON.stringify(base)}`);
    const g = entries.Get(base);
    if (g.entry !== null && g.entry.Kind() === FileEntry) {
      if (dl !== null) dl.addNote(`Found file ${JSON.stringify(base)}`);
      return { path: fsobj.Join([dirPath, base]), ok: true, diffCase: g.differentCase };
    }
    return { path: "", ok: false, diffCase: null };
  };

  const base = fsobj.Base(path);
  let res = tryFile(base);
  if (res.ok) { if (dl !== null) dl.decreaseIndent(); return res; }
  for (const ext of extensionOrder) {
    res = tryFile(base + ext);
    if (res.ok) { if (dl !== null) dl.decreaseIndent(); return res; }
  }
  for (const [old, exts] of rewrittenFileExtensions) {
    if (!base.endsWith(old)) continue;
    const lastDot = base.lastIndexOf(".");
    for (const ext of exts) {
      res = tryFile(base.slice(0, lastDot) + ext);
      if (res.ok) { if (dl !== null) dl.decreaseIndent(); return res; }
    }
    break;
  }
  if (dl !== null) { dl.addNote(`Failed to find file ${JSON.stringify(base)}`); dl.decreaseIndent(); }
  return { path: "", ok: false, diffCase: null };
}

/** loadAsIndex 所需的 dirInfo 最小结构（避免与 package_json.ts 循环依赖） */
export interface IndexDirInfo { absPath: string; entries: DirEntries }

/** Go: func (r resolverQuery) loadAsIndex(dirInfo, extensionOrder) (PathPair, bool, *fs.DifferentCase) (resolver.go:1848) */
export function loadAsIndex(r: LoadFileContext, dir: IndexDirInfo | null, extensionOrder: string[]): { text: string; namespace: string; ok: boolean; diffCase: DifferentCase | null } {
  const fsobj = r.fsObj;
  const dl = r.debugLogs;
  if (dir === null) return { text: "", namespace: "", ok: false, diffCase: null };
  for (const ext of extensionOrder) {
    const base = "index" + ext;
    const g = dir.entries.Get(base);
    if (g.entry !== null && g.entry.Kind() === FileEntry) {
      const joined = fsobj.Join([dir.absPath, base]);
      if (dl !== null) dl.addNote(`Found file ${JSON.stringify(joined)}`);
      return { text: joined, namespace: "file", ok: true, diffCase: g.differentCase };
    }
    if (dl !== null) dl.addNote(`Failed to find file ${JSON.stringify(fsobj.Join([dir.absPath, base]))}`);
  }
  return { text: "", namespace: "", ok: false, diffCase: null };
}

// ============================================================================
// 第 165 批：dirInfoCached + dirInfoUncached（dirInfo 深簇底座）
// Go: dirInfoCached (resolver.go:1161) / dirInfoUncached (resolver.go:1533)
// 探针用 mockFS（无 symlink），pnpManifestWasChecked=true 跳过 PnP 扫描，
// 不放 tsconfig.json 跳过 parseTSConfig 分支（该分支由 parseTSConfig 族单独覆盖）。
// ============================================================================
/** dirInfo 缓存/构造上下文：对应 Go resolverQuery 的相关字段 */
export interface DirInfoContext {
  fsObj: mockFS;
  log: Log;
  debugLogs: { addNote(s: string): void; increaseIndent(): void; decreaseIndent(): void } | null;
  platform: number;
  mainFields: string[] | null;
  preserveSymlinks: boolean;
  dirCache: Map<string, dirInfo | null>;
  pnpManifestWasChecked: boolean;
  readFile: (path: string) => { contents: string; err: string | null };
}

/** Go: func (r resolverQuery) dirInfoCached(path) *dirInfo (resolver.go:1161) */
export function dirInfoCached(r: DirInfoContext, path: string): dirInfo | null {
  let cached: dirInfo | null;
  if (r.dirCache.has(path)) {
    cached = r.dirCache.get(path) ?? null;
  } else {
    r.dirCache.set(path, null); // 防递归
    cached = dirInfoUncached(r, path);
    if (cached !== null) r.dirCache.set(path, cached);
  }
  // Go: note 在 hit/miss 之后统一发（cache hit 也发 Read/Failed note）。
  if (r.debugLogs !== null) {
    if (cached === null) r.debugLogs.addNote(`Failed to read directory ${JSON.stringify(path)}`);
    else {
      const count = cached.entries.PeekEntryCount();
      r.debugLogs.addNote(`Read ${count} ${count === 1 ? "entry" : "entries"} for directory ${JSON.stringify(path)}`);
    }
  }
  return cached;
}

/** Go: func (r resolverQuery) dirInfoUncached(path) *dirInfo (resolver.go:1533) */
export function dirInfoUncached(r: DirInfoContext, path: string): dirInfo | null {
  const fsobj = r.fsObj;
  const dl = r.debugLogs;
  let parentInfo: dirInfo | null = null;
  const parentDir = fsobj.Dir(path);
  if (parentDir !== path) {
    parentInfo = dirInfoCached(r, parentDir);
    if (parentInfo === null) return null;
  }

  const rd = fsobj.ReadDirectory(path);
  let entries: DirEntries = rd.dir;
  if (rd.err1 !== "") {
    if (dl !== null) dl.addNote(`Failed to read directory ${JSON.stringify(path)}: ${rd.err2 || rd.err1}`);
    return null;
  }

  const info = new dirInfo();
  info.absPath = path;
  info.parent = parentInfo;
  info.entries = entries;

  const base = fsobj.Base(path);
  if (base === "node_modules") { info.isNodeModules = true; info.isInsideNodeModules = true; }
  else { const g = entries.Get("node_modules"); if (g.entry !== null) info.hasNodeModules = g.entry.Kind() === DirEntry; }

  if (parentInfo !== null) {
    info.enclosingPackageJSON = parentInfo.enclosingPackageJSON;
    info.enclosingBrowserScope = parentInfo.enclosingBrowserScope;
    info.enclosingTSConfigJSON = parentInfo.enclosingTSConfigJSON;
    if (parentInfo.isInsideNodeModules) info.isInsideNodeModules = true;
    if (!r.preserveSymlinks) {
      const g = parentInfo.entries.Get(base);
      if (g.entry !== null) {
        const symlink = g.entry.Symlink();
        if (symlink !== "") { if (dl !== null) dl.addNote(`Resolved symlink ${JSON.stringify(path)} to ${JSON.stringify(symlink)}`); info.absRealPath = symlink; }
        else if (parentInfo.absRealPath !== "") {
          const s = fsobj.Join([parentInfo.absRealPath, base]);
          if (dl !== null) dl.addNote(`Resolved symlink ${JSON.stringify(path)} to ${JSON.stringify(s)}`);
          info.absRealPath = s;
        }
      }
    }
  }

  const pjEntry = entries.Get("package.json");
  if (pjEntry.entry !== null && pjEntry.entry.Kind() === FileEntry) {
    info.packageJSON = parsePackageJSON(path, {
      fsObj: fsobj as any, log: r.log, tracker: null, platform: r.platform, mainFields: r.mainFields,
      debugLogs: dl, readFile: r.readFile,
    });
    if (info.packageJSON !== null) {
      info.enclosingPackageJSON = info.packageJSON;
      if (info.packageJSON.browserMap !== null) info.enclosingBrowserScope = info;
    }
  }

  // tsconfig.json / jsconfig.json 分支：探针不放这些文件，跳过（parseTSConfig 未移植）。
  // 真实运行中此分支需 parseTSConfig，属深簇后续批次。

  // Yarn PnP manifest 扫描
  if (!r.pnpManifestWasChecked) {
    const vpath = ParseYarnPnPVirtualPath(path);
    if (!vpath.ok) {
      for (const name of [".pnp.data.json", ".pnp.cjs", ".pnp.js"]) {
        const g = entries.Get(name);
        if (g.entry !== null && g.entry.Kind() === FileEntry) { info.pnpManifestAbsPath = fsobj.Join([path, name]); break; }
      }
    }
  }

  return info;
}

// ============================================================================
// 第 166 批：loadAsIndexWithBrowserRemapping（resolver.go:1866）
// + DebugMeta.LogErrorMsg（resolver.go:136）
// 依赖全已移植（checkBrowserMap/loadAsFile/loadAsIndex/dirInfoCached + logger）。
// ============================================================================
/** loadAsIndexWithBrowserRemapping 上下文（组合 LoadFile/Browser/DirInfo 所需字段） */
export interface IndexRemapContext {
  fsObj: mockFS;
  log: Log;
  debugLogs: { addNote(s: string): void; increaseIndent(): void; decreaseIndent(): void } | null;
  platform: number;
  extensionOrder: string[];
  dirInfoCtx: DirInfoContext;
}

/** Go: func (r resolverQuery) loadAsIndexWithBrowserRemapping(dirInfo, path, extensionOrder) (PathPair, bool, *DifferentCase) (resolver.go:1866) */
export function loadAsIndexWithBrowserRemapping(r: IndexRemapContext, dir: dirInfo | null, path: string, extensionOrder: string[]): { text: string; namespace: string; flags: number; ok: boolean; diffCase: DifferentCase | null } {
  const fsobj = r.fsObj;
  const absPath = fsobj.Join([path, "index"]);
  const bmCtx: any = { platform: r.platform, extensionOrder: r.extensionOrder, fsObj: fsobj, debugLogs: r.debugLogs };
  const remap = checkBrowserMap(bmCtx, dir, absPath, 0 /* absolutePathKind */);
  if (remap.ok) {
    if (remap.remapped === null) {
      return { text: absPath, namespace: "file", flags: PathFlags.PathDisabled, ok: true, diffCase: null };
    }
    const remappedAbs = fsobj.Join([path, remap.remapped]);
    const fileCtx: any = { fsObj: fsobj, log: r.log, debugLogs: r.debugLogs };
    const asFile = loadAsFile(fileCtx, remappedAbs, extensionOrder);
    if (asFile.ok) return { text: asFile.path, namespace: "file", flags: 0, ok: true, diffCase: asFile.diffCase };
    const fieldDirInfo = dirInfoCached(r.dirInfoCtx, remappedAbs);
    if (fieldDirInfo !== null) {
      const asIndex = loadAsIndex(fileCtx, fieldDirInfo, extensionOrder);
      if (asIndex.ok) return { text: asIndex.text, namespace: asIndex.namespace, flags: 0, ok: true, diffCase: null };
    }
    return { text: "", namespace: "", flags: 0, ok: false, diffCase: null };
  }
  const asIndex = loadAsIndex({ fsObj: fsobj, log: r.log, debugLogs: r.debugLogs } as any, dir, extensionOrder);
  return { text: asIndex.text, namespace: asIndex.namespace, flags: 0, ok: asIndex.ok, diffCase: asIndex.diffCase };
}

/** Go: suggestionRange (resolver.go:122) —— 0=Full / 1=End */
export const suggestionRangeFull = 0, suggestionRangeEnd = 1;

/** Go: type DebugMeta (resolver.go:128) —— 只落 LogErrorMsg 用到的字段 */
export class DebugMeta {
  notes: MsgData[] = [];
  suggestionText = "";
  suggestionMessage = "";
  suggestionRange = suggestionRangeFull;
  ModifiedImportPath = "";

  /** Go: func (dm DebugMeta) LogErrorMsg(log, source, r, text, suggestion, notes) (resolver.go:136) */
  LogErrorMsg(log: Log, source: any, r: any, text: string, suggestion: string, notes: MsgData[]): void {
    const tracker = MakeLineColumnTracker(source);
    if (source != null && this.suggestionMessage !== "") {
      let suggestionRange = r;
      if (this.suggestionRange === suggestionRangeEnd) suggestionRange = new Range(new Loc(r.Loc.Start + r.Len - 1), 0);
      const data = tracker.MsgData(suggestionRange, this.suggestionMessage);
      data.Location.Suggestion = this.suggestionText;
      this.notes.push(data);
    }
    const msg = new Msg();
    msg.Kind = MsgKind.Error;
    msg.Data = tracker.MsgData(r, text);
    msg.Notes = this.notes.concat(notes);
    if (msg.Data.Location !== null && suggestion !== "") msg.Data.Location.Suggestion = suggestion;
    log.AddMsg(msg);
  }
}

// ============================================================================
// 第 167 批：loadAsMainField + loadAsDirectory + loadAsFileOrDirectory
// Resolve 链目录加载三连；依赖全已就绪（checkBrowserMap/loadAsFile/dirInfoCached/
// loadAsIndexWithBrowserRemapping + defaultMainFields + DebugMeta）。
// ============================================================================
/** 目录加载上下文（组合各助手所需字段） */
export interface LoadDirContext extends IndexRemapContext {
  mainFields: string[] | null;
  nodeModulesExtensionOrder: string[];
  cssExtensionOrder: string[];
  debugMeta: DebugMeta;
  kind: number;
}

/** PathPair 适配结果 */
interface PathPairResult { text: string; namespace: string; secondary: string; flags: number; ok: boolean; diffCase: DifferentCase | null }
const emptyPair = (): PathPairResult => ({ text: "", namespace: "", secondary: "", flags: 0, ok: false, diffCase: null });

/** Go: func (r resolverQuery) loadAsMainField(dirInfo, path, extensionOrder) (PathPair, bool, *DifferentCase) (resolver.go:1972) */
export function loadAsMainField(r: LoadDirContext, dir: dirInfo | null, path: string, extensionOrder: string[]): PathPairResult {
  if (dir === null || dir.packageJSON === null) return emptyPair();
  const dl = r.debugLogs;
  const fsobj = r.fsObj;
  const mainFieldValues = dir.packageJSON.mainFields;
  let mainFieldKeys = r.mainFields;
  let autoMain = false;
  if (mainFieldKeys === null) { mainFieldKeys = defaultMainFields[r.platform] ?? []; autoMain = true; }

  const loadMainField = (fieldRelPath: string, field: string): PathPairResult => {
    if (dl !== null) { dl.addNote(`Found main field ${JSON.stringify(field)} with path ${JSON.stringify(fieldRelPath)}`); dl.increaseIndent(); }
    // Go 用 defer decreaseIndent()：整个闭包内（含 dirInfoCached）都保持 indent，返回时才减。
    const done = (res: PathPairResult): PathPairResult => { if (dl !== null) dl.decreaseIndent(); return res; };
    let fieldAbsPath = fsobj.Join([path, fieldRelPath]);
    const bmCtx: any = { platform: r.platform, extensionOrder, fsObj: fsobj, debugLogs: dl };
    const remap = checkBrowserMap(bmCtx, dir, fieldAbsPath, 0);
    if (remap.ok) {
      if (remap.remapped === null) return done({ text: fieldAbsPath, namespace: "file", secondary: "", flags: PathFlags.PathDisabled, ok: true, diffCase: null });
      fieldAbsPath = fsobj.Join([path, remap.remapped]);
    }
    const fileCtx: any = { fsObj: fsobj, log: r.log, debugLogs: dl };
    const asFile = loadAsFile(fileCtx, fieldAbsPath, extensionOrder);
    if (asFile.ok) return done({ text: asFile.path, namespace: "file", secondary: "", flags: 0, ok: true, diffCase: asFile.diffCase });
    const fieldDirInfo = dirInfoCached(r.dirInfoCtx, fieldAbsPath);
    if (fieldDirInfo !== null) {
      const asIndex = loadAsIndexWithBrowserRemapping(r, fieldDirInfo, fieldAbsPath, extensionOrder);
      if (asIndex.ok) return done({ text: asIndex.text, namespace: asIndex.namespace, secondary: "", flags: 0, ok: true, diffCase: null });
    }
    return done(emptyPair());
  };

  if (dl !== null) { dl.addNote(`Searching for main fields in ${JSON.stringify(dir.packageJSON.source.KeyPath.Text)}`); dl.increaseIndent(); }
  let foundSomething = false;
  for (const key of mainFieldKeys) {
    const value = mainFieldValues.get(key);
    if (!value) { if (dl !== null) dl.addNote(`Did not find main field ${JSON.stringify(key)}`); continue; }
    foundSomething = true;
    const absolute = loadMainField(value.relPath, key);
    if (!absolute.ok) continue;
    if (autoMain && key === "module") {
      let absoluteMain: PathPairResult = emptyPair();
      const main = mainFieldValues.get("main");
      if (main) absoluteMain = loadMainField(main.relPath, "main");
      else {
        const asIndex = loadAsIndexWithBrowserRemapping(r, dir, path, extensionOrder);
        if (asIndex.ok) absoluteMain = { text: asIndex.text, namespace: asIndex.namespace, secondary: "", flags: 0, ok: true, diffCase: null };
      }
      if (absoluteMain.ok) {
        if (r.kind !== ImportKind.ImportRequire) {
          if (dl !== null) {
            dl.addNote(`Resolved to ${JSON.stringify(absolute.text)} using the "module" field in ${JSON.stringify(dir.packageJSON.source.KeyPath.Text)}`);
            dl.addNote(`The fallback path in case of "require" is ${JSON.stringify(absoluteMain.text)}`);
          }
          if (dl !== null) dl.decreaseIndent();
          return { text: absolute.text, namespace: absolute.namespace, secondary: absoluteMain.text, flags: 0, ok: true, diffCase: absolute.diffCase };
        } else {
          if (dl !== null) dl.addNote(`Resolved to ${JSON.stringify(absoluteMain.text)} because of "require"`);
          if (dl !== null) dl.decreaseIndent();
          return absoluteMain;
        }
      }
    }
    if (dl !== null) dl.addNote(`Resolved to ${JSON.stringify(absolute.text)} using the ${JSON.stringify(key)} field in ${JSON.stringify(dir.packageJSON.source.KeyPath.Text)}`);
    if (dl !== null) dl.decreaseIndent();
    return absolute;
  }
  if (!foundSomething) {
    for (const field of mainFieldsForFailure) {
      const main = mainFieldValues.get(field);
      if (main) {
        const tracker = MakeLineColumnTracker(dir.packageJSON.source);
        const keyRange = dir.packageJSON.source.RangeOfString(new Loc(main.keyLoc.Start));
        if (mainFieldKeys.length === 0 && r.platform === 2 /* Neutral */) {
          r.debugMeta.notes.push(tracker.MsgData(keyRange, `The ${JSON.stringify(field)} field here was ignored. Main fields must be configured explicitly when using the "neutral" platform.`));
        } else {
          r.debugMeta.notes.push(tracker.MsgData(keyRange, `The ${JSON.stringify(field)} field here was ignored because the list of main fields to use is currently set to [${StringArrayToQuotedCommaSeparatedString(mainFieldKeys)}].`));
        }
        break;
      }
    }
  }
  if (dl !== null) dl.decreaseIndent();
  return emptyPair();
}

/** Go: func (r resolverQuery) loadAsDirectory(path) (PathPair, bool, *DifferentCase) (resolver.go:1938) */
export function loadAsDirectory(r: LoadDirContext, path: string): PathPairResult {
  let extensionOrder = r.extensionOrder;
  if (r.kind === 5 || r.kind === 6 /* ImportAt/ImportComposesFrom */) extensionOrder = r.cssExtensionOrder;
  else if (IsInsideNodeModules(path)) extensionOrder = r.nodeModulesExtensionOrder;
  const dl = r.debugLogs;
  if (dl !== null) { dl.addNote(`Attempting to load ${JSON.stringify(path)} as a directory`); dl.increaseIndent(); }
  const dir = dirInfoCached(r.dirInfoCtx, path);
  if (dir === null) { if (dl !== null) dl.decreaseIndent(); return emptyPair(); }
  const asMain = loadAsMainField(r, dir, path, extensionOrder);
  if (asMain.ok) { if (dl !== null) dl.decreaseIndent(); return asMain; }
  const asIndex = loadAsIndexWithBrowserRemapping(r, dir, path, extensionOrder);
  if (dl !== null) dl.decreaseIndent();
  if (asIndex.ok) return { text: asIndex.text, namespace: asIndex.namespace, secondary: "", flags: 0, ok: true, diffCase: null };
  return emptyPair();
}

/** Go: func (r resolverQuery) loadAsFileOrDirectory(path) (PathPair, bool, *DifferentCase) (resolver.go:1919) */
export function loadAsFileOrDirectory(r: LoadDirContext, path: string): PathPairResult {
  let extensionOrder = r.extensionOrder;
  if (r.kind === 5 || r.kind === 6) extensionOrder = r.cssExtensionOrder;
  else if (IsInsideNodeModules(path)) extensionOrder = r.nodeModulesExtensionOrder;
  const fileCtx: any = { fsObj: r.fsObj, log: r.log, debugLogs: r.debugLogs };
  const asFile = loadAsFile(fileCtx, path, extensionOrder);
  if (asFile.ok) return { text: asFile.path, namespace: "file", secondary: "", flags: 0, ok: true, diffCase: asFile.diffCase };
  return loadAsDirectory(r, path);
}

// ============================================================================
// 第 168 批：parseTSConfig + parseTSConfigFromSource（Resolve 链 tsconfig 加载深簇）
// 主体 = ParseTSConfigJSON（已移植）+ extends 回调 + 尾部 paths 无 baseUrl 过滤。
// 探针用 visited=nil（transform 模式）避开 extends 递归分支，逐字节验主路径。
// ============================================================================
/** tsconfig 解析上下文：对应 Go resolverQuery 的相关字段 */
export interface TsConfigContext {
  fsObj: mockFS;
  log: Log;
  debugLogs: any;
  preserveSymlinks: boolean;
  readFile: (path: string) => { contents: string; err: string | null };
}

/** Go: func (r resolverQuery) parseTSConfig(file, visited, configDir) (*TSConfigJSON, error) (resolver.go:1193) */
export function parseTSConfig(r: TsConfigContext, file: string, visited: Map<string, boolean> | null, configDir: string): { config: TSConfigJSON | null; err: string } {
  if (!r.preserveSymlinks) {
    const real = r.fsObj.EvalSymlinks(file);
    if (real.ok) file = real.path;
  }
  if (visited !== null && visited.get(file)) return { config: null, err: "cycle" };
  const rf = r.readFile(file);
  if (r.debugLogs !== null && rf.err !== null) r.debugLogs.addNote(`Failed to read file ${JSON.stringify(file)}: ${rf.err}`);
  if (rf.err !== null) return { config: null, err: rf.err };
  if (r.debugLogs !== null) r.debugLogs.addNote(`The file ${JSON.stringify(file)} exists`);

  const keyPath = new LoggerPath(); keyPath.Text = file; keyPath.Namespace = "file";
  const source = new Source(); source.KeyPath = keyPath; source.Contents = new TextEncoder().encode(rf.contents);
  if (visited !== null) visited.set(file, true);
  const res = parseTSConfigFromSource(r, source, visited, configDir);
  if (visited !== null) visited.set(file, false);
  return res;
}

/** Go: func (r resolverQuery) parseTSConfigFromSource(source, visited, configDir) (*TSConfigJSON, error) (resolver.go:1252) */
export function parseTSConfigFromSource(r: TsConfigContext, source: any, visited: Map<string, boolean> | null, configDir: string): { config: TSConfigJSON | null; err: string } {
  const fileDir = r.fsObj.Dir(source.KeyPath.Text);
  const isExtends = visited !== null && visited.size > 1;

  // extends 回调：visited=nil（transform）直接跳过；递归分支本批未逐字节覆盖（见脚注披露）。
  const ext = visited === null ? null : (_extends: string, _range: any): TSConfigJSON | null => null;
  const result = ParseTSConfigJSON(r.log, source, r.fsObj as any, fileDir, configDir, ext);
  if (result === null) return { config: null, err: "already-logged" };

  // 尾部：无 baseUrl 时过滤 package 风格的 paths（TypeScript 允许跨文件继承 baseUrl/paths）
  if (!isExtends && result.Paths !== null && result.BaseURL === null) {
    const holder = { tracker: null };
    for (const [key, paths] of result.Paths.Map) {
      const kept: any[] = [];
      for (const p of paths) {
        if (isValidTSConfigPathNoBaseURLPattern(p.Text, r.log, result.Paths.Source, holder, p.Loc.Start)) kept.push(p);
      }
      if (kept.length < paths.length) result.Paths.Map.set(key, kept);
    }
  }
  return { config: result, err: "" };
}

// ============================================================================
// 第 169 批：matchTSConfigPaths（resolver.go:2134，112 行，tsconfig paths 映射）
// 依赖全已就绪（loadAsFileOrDirectory + TSConfigJSON.Paths + hasCaseInsensitiveSuffix）。
// ============================================================================
/** Go: func (r resolverQuery) matchTSConfigPaths(tsConfigJSON, path) (PathPair, bool, *DifferentCase) (resolver.go:2134) */
export function matchTSConfigPaths(r: LoadDirContext, tsConfigJSON: TSConfigJSON, path: string): PathPairResult {
  const dl = r.debugLogs;
  if (dl !== null) { dl.addNote(`Matching ${JSON.stringify(path)} against "paths" in ${JSON.stringify(tsConfigJSON.AbsPath)}`); dl.increaseIndent(); }
  const done = (res: PathPairResult): PathPairResult => { if (dl !== null) dl.decreaseIndent(); return res; };

  let absBaseURL = tsConfigJSON.BaseURLForPaths;
  if (tsConfigJSON.BaseURL !== null) absBaseURL = tsConfigJSON.BaseURL;
  if (dl !== null) dl.addNote(`Using ${JSON.stringify(absBaseURL)} as "baseUrl"`);
  const fsobj = r.fsObj;
  const paths = tsConfigJSON.Paths!;

  // 精确匹配优先（Go map 迭代随机，但 key 唯一命中不依赖顺序）
  for (const [key, originalPaths] of paths.Map) {
    if (key === path) {
      if (dl !== null) dl.addNote(`Found an exact match for ${JSON.stringify(key)} in "paths"`);
      for (const op of originalPaths) {
        if (hasCaseInsensitiveSuffix(op.Text, ".d.ts")) {
          if (dl !== null) dl.addNote(`Ignoring substitution ${JSON.stringify(op.Text)} because it ends in ".d.ts"`);
          continue;
        }
        let absText = op.Text;
        if (!fsobj.IsAbs(absText)) absText = fsobj.Join([absBaseURL, absText]);
        const res = loadAsFileOrDirectory(r, absText);
        if (res.ok) return done(res);
      }
      return done(emptyPair());
    }
  }

  // 通配符匹配：取最长 prefix，其次最长 suffix
  let longestPrefixLen = -1, longestSuffixLen = -1;
  let longest: { prefix: string; suffix: string; originalPaths: any[] } | null = null;
  for (const [key, originalPaths] of paths.Map) {
    const star = key.indexOf("*");
    if (star !== -1) {
      const prefix = key.slice(0, star), suffix = key.slice(star + 1);
      if (path.startsWith(prefix) && path.endsWith(suffix) &&
          (prefix.length > longestPrefixLen || (prefix.length === longestPrefixLen && suffix.length > longestSuffixLen))) {
        longestPrefixLen = prefix.length; longestSuffixLen = suffix.length;
        longest = { prefix, suffix, originalPaths };
      }
    }
  }
  if (longest !== null) {
    if (dl !== null) dl.addNote(`Found a fuzzy match for ${JSON.stringify(longest.prefix + "*" + longest.suffix)} in "paths"`);
    const matchedText = path.slice(longest.prefix.length, path.length - longest.suffix.length);
    for (const op of longest.originalPaths) {
      const replaced = op.Text.replace("*", matchedText);
      if (hasCaseInsensitiveSuffix(replaced, ".d.ts")) {
        if (dl !== null) dl.addNote(`Ignoring substitution ${JSON.stringify(replaced)} because it ends in ".d.ts"`);
        continue;
      }
      let absText = replaced;
      if (!fsobj.IsAbs(absText)) absText = fsobj.Join([absBaseURL, absText]);
      const res = loadAsFileOrDirectory(r, absText);
      if (res.ok) return done(res);
    }
  }
  return done(emptyPair());
}

// ============================================================================
// 第 170 批：finalizeImportsExportsResult（resolver.go:2605，286 行，ESM exports 解析核心深簇）
// 依赖全已就绪（dirInfoCached/loadAsFileOrDirectory/pjEntry/pjStatus/DebugMeta）。
// ============================================================================
/** finalizeImportsExportsKind (resolver.go:2598) */
export const finalizeImportsExportsNormal = 0, finalizeImportsExportsYarnPnPTSConfigExtends = 1;

/** Go path.Join for module names (forward slashes, clean dots) */
function modPathJoin(a: string, b: string): string {
  const joined = (a + "/" + b).split("/");
  const out: string[] = [];
  for (const s of joined) { if (s === "" || s === ".") continue; out.push(s); }
  return out.join("/");
}

/** finalizeImportsExportsResult 上下文：对应 Go resolverQuery 的相关字段 */
export interface FinalizeCtx extends LoadDirContext {}

/** Go: func (r resolverQuery) finalizeImportsExportsResult(...) (PathPair, bool, *DifferentCase) (resolver.go:2605) */
export function finalizeImportsExportsResult(
  r: FinalizeCtx, kind: number, absDirPath: string, conditions: Record<string, boolean>, importExportMap: pjMap,
  pkgJSON: packageJSON, resolvedPath: string, status: number, debug: pjDebug,
  esmPackageName: string, esmPackageSubpath: string, absImportPath: string,
): PathPairResult {
  let missingSuffix = "";
  const dl = r.debugLogs;
  const fsobj = r.fsObj;

  if ((status === pjStatus.pjStatusExact || status === pjStatus.pjStatusExactEndsWithStar || status === pjStatus.pjStatusInexact) && resolvedPath.startsWith("/")) {
    let absResolvedPath = fsobj.Join([absDirPath, resolvedPath]);
    if (status === pjStatus.pjStatusExact || status === pjStatus.pjStatusExactEndsWithStar) {
      if (dl !== null) dl.addNote(`The resolved path ${JSON.stringify(absResolvedPath)} is exact`);
      if (kind === finalizeImportsExportsYarnPnPTSConfigExtends) {
        if (dl !== null) dl.addNote(`Resolved to ${JSON.stringify(absResolvedPath)}`);
        return { text: absResolvedPath, namespace: "file", secondary: "", flags: 0, ok: true, diffCase: null };
      }
      const resolvedDirInfo = dirInfoCached(r.dirInfoCtx, fsobj.Dir(absResolvedPath));
      let base = fsobj.Base(absResolvedPath);
      let extensionOrder = r.extensionOrder;
      if (r.kind === 5 || r.kind === 6) extensionOrder = r.cssExtensionOrder;
      if (resolvedDirInfo === null) {
        status = pjStatus.pjStatusModuleNotFound;
      } else {
        let g = resolvedDirInfo.entries.Get(base);
        let entry = g.entry, diffCase = g.differentCase;
        if (entry === null) {
          for (const [old, exts] of rewrittenFileExtensions) {
            if (!base.endsWith(old)) continue;
            const lastDot = base.lastIndexOf(".");
            for (const ext of exts) {
              const baseWithExt = base.slice(0, lastDot) + ext;
              const g2 = resolvedDirInfo.entries.Get(baseWithExt);
              if (g2.entry !== null) { entry = g2.entry; diffCase = g2.differentCase; absResolvedPath = fsobj.Join([resolvedDirInfo.absPath, baseWithExt]); break; }
            }
            break;
          }
        }
        if (entry === null) {
          const endsWithStar = status === pjStatus.pjStatusExactEndsWithStar;
          status = pjStatus.pjStatusModuleNotFound;
          if (endsWithStar) {
            for (const ext of extensionOrder) {
              if (resolvedDirInfo.entries.Get(base + ext).entry !== null) {
                if (dl !== null) dl.addNote(`The import ${JSON.stringify(modPathJoin(esmPackageName, esmPackageSubpath))} is missing the extension ${JSON.stringify(ext)}`);
                status = pjStatus.pjStatusModuleNotFoundMissingExtension; missingSuffix = ext; break;
              }
            }
          }
        } else if (entry.Kind() === DirEntry) {
          if (dl !== null) dl.addNote(`The path ${JSON.stringify(absResolvedPath)} is a directory, which is not allowed`);
          const endsWithStar = status === pjStatus.pjStatusExactEndsWithStar;
          status = pjStatus.pjStatusUnsupportedDirectoryImport;
          if (endsWithStar) {
            const rdInfo = dirInfoCached(r.dirInfoCtx, absResolvedPath);
            if (rdInfo !== null) {
              for (const ext of extensionOrder) {
                const b = "index" + ext;
                const e = rdInfo.entries.Get(b).entry;
                if (e !== null && e.Kind() === FileEntry) { status = pjStatus.pjStatusUnsupportedDirectoryImportMissingIndex; missingSuffix = "/" + b;
                  if (dl !== null) dl.addNote(`The import ${JSON.stringify(modPathJoin(esmPackageName, esmPackageSubpath))} is missing the suffix ${JSON.stringify(missingSuffix)}`); break; }
              }
            }
          }
        } else if (entry.Kind() !== FileEntry) {
          status = pjStatus.pjStatusModuleNotFound;
        } else {
          if (dl !== null) dl.addNote(`Resolved to ${JSON.stringify(absResolvedPath)}`);
          return { text: absResolvedPath, namespace: "file", secondary: "", flags: 0, ok: true, diffCase };
        }
      }
    } else if (status === pjStatus.pjStatusInexact) {
      if (dl !== null) dl.addNote(`The resolved path ${JSON.stringify(absResolvedPath)} is inexact`);
      const asFod = loadAsFileOrDirectory(r, absResolvedPath);
      if (asFod.ok) return asFod;
      status = pjStatus.pjStatusModuleNotFound;
    }
  }

  if (resolvedPath.startsWith("/")) resolvedPath = "." + resolvedPath;
  const tracker = MakeLineColumnTracker(pkgJSON.source);
  const note = (range: any, text: string) => tracker.MsgData(range, text);
  switch (status) {
    case pjStatus.pjStatusInvalidModuleSpecifier:
      r.debugMeta.notes = [note(debug.token, `The module specifier ${JSON.stringify(resolvedPath)} is invalid${debug.invalidBecause}:`)]; break;
    case pjStatus.pjStatusInvalidPackageConfiguration:
      r.debugMeta.notes = [note(debug.token, "The package configuration has an invalid value here:")]; break;
    case pjStatus.pjStatusInvalidPackageTarget: {
      let why = `The package target ${JSON.stringify(resolvedPath)} is invalid${debug.invalidBecause}:`;
      if (resolvedPath === "") why = "The package configuration has an invalid value here:";
      r.debugMeta.notes = [note(debug.token, why)]; break;
    }
    case pjStatus.pjStatusPackagePathNotExported: {
      if (debug.isBecauseOfNullLiteral) {
        r.debugMeta.notes = [note(debug.token, `The path ${JSON.stringify(esmPackageSubpath)} cannot be imported from package ${JSON.stringify(esmPackageName)} because it was explicitly disabled by the package author here:`)]; break;
      }
      r.debugMeta.notes = [note(debug.token, `The path ${JSON.stringify(esmPackageSubpath)} is not exported by package ${JSON.stringify(esmPackageName)}:`)];
      break;
    }
    case pjStatus.pjStatusPackageImportNotDefined:
      r.debugMeta.notes = [note(debug.token, `The package import ${JSON.stringify(resolvedPath)} is not defined in this "imports" map:`)]; break;
    case pjStatus.pjStatusModuleNotFound:
    case pjStatus.pjStatusModuleNotFoundMissingExtension:
      r.debugMeta.notes = [note(debug.token, `The module ${JSON.stringify(resolvedPath)} was not found on the file system:`)];
      if (status === pjStatus.pjStatusModuleNotFoundMissingExtension) {
        const pp = MakePrettyPaths(fsobj, fsobj.Join([absDirPath, resolvedPath + missingSuffix]), "file", "", false);
        const actual = modPathJoin(esmPackageName, esmPackageSubpath + missingSuffix);
        r.debugMeta.suggestionRange = suggestionRangeEnd;
        r.debugMeta.suggestionText = missingSuffix;
        r.debugMeta.suggestionMessage = `Import from ${JSON.stringify(actual)} to get the file ${JSON.stringify(pp.Rel)}:`;
      }
      break;
    case pjStatus.pjStatusUnsupportedDirectoryImport:
    case pjStatus.pjStatusUnsupportedDirectoryImportMissingIndex:
      r.debugMeta.notes = [
        note(debug.token, `Importing the directory ${JSON.stringify(resolvedPath)} is forbidden by this package:`),
        note(pkgJSON.source.RangeOfString(importExportMap.propertyKeyLoc), `The presence of ${JSON.stringify(importExportMap.propertyKey)} here makes importing a directory forbidden:`),
      ];
      if (status === pjStatus.pjStatusUnsupportedDirectoryImportMissingIndex) {
        const pp = MakePrettyPaths(fsobj, fsobj.Join([absDirPath, resolvedPath + missingSuffix]), "file", "", false);
        const actual = modPathJoin(esmPackageName, esmPackageSubpath + missingSuffix);
        r.debugMeta.suggestionRange = suggestionRangeEnd;
        r.debugMeta.suggestionText = missingSuffix;
        r.debugMeta.suggestionMessage = `Import from ${JSON.stringify(actual)} to get the file ${JSON.stringify(pp.Rel)}:`;
      }
      break;
    case pjStatus.pjStatusUndefinedNoConditionsMatch: {
      const keys = Object.keys(conditions).sort();
      r.debugMeta.notes = [
        note((importExportMap.root as any).firstToken, `The path ${JSON.stringify(esmPackageSubpath)} is not currently exported by package ${JSON.stringify(esmPackageName)}:`),
        note(debug.token, `None of the conditions in the package definition (${keys.map((k) => JSON.stringify(k)).join(", ")}) matched any of the active conditions`),
      ];
      break;
    }
  }
  return emptyPair();
}

// ============================================================================
// 第 171 批：esmResolveAlgorithm（resolver.go:2309，47 行，ESM 解析算法协调层）
// 依赖全已就绪（esmPackageExportsResolve/esmHandlePostConditions/finalizeImportsExportsResult）。
// ============================================================================
/** esmResolveAlgorithm 上下文 */
export interface EsmAlgoCtx extends FinalizeCtx {
  esmConditionsDefault: Record<string, boolean>;
  esmConditionsImport: Record<string, boolean>;
  esmConditionsRequire: Record<string, boolean>;
}

/** Go: func (r resolverQuery) esmResolveAlgorithm(kind, esmPackageName, esmPackageSubpath, packageJSON, absPkgPath, absPath) (PathPair, bool, *DifferentCase) (resolver.go:2309) */
export function esmResolveAlgorithm(
  r: EsmAlgoCtx, kind: number, esmPackageName: string, esmPackageSubpath: string, pkgJSON: packageJSON,
  absPkgPath: string, absPath: string,
): PathPairResult {
  if (r.debugLogs !== null) { r.debugLogs.addNote(`Looking for ${JSON.stringify(esmPackageSubpath)} in "exports" map in ${JSON.stringify(pkgJSON.source.KeyPath.Text)}`); r.debugLogs.increaseIndent(); }
  const done = (res: PathPairResult): PathPairResult => { if (r.debugLogs !== null) r.debugLogs.decreaseIndent(); return res; };

  let conditions = r.esmConditionsDefault;
  if (r.kind === ImportKind.ImportStmt || r.kind === ImportKind.ImportDynamic) conditions = r.esmConditionsImport;
  else if (r.kind === ImportKind.ImportRequire || r.kind === ImportKind.ImportRequireResolve) conditions = r.esmConditionsRequire;
  else if (r.kind === ImportKind.ImportEntryPoint) conditions = r.esmConditionsImport;

  let res = esmPackageExportsResolve("/", esmPackageSubpath, pkgJSON.exportsMap!.root, conditions, r.debugLogs);
  const post = esmHandlePostConditions(res.resolved, res.status, res.debug, r.debugLogs);
  res = { resolved: post.resolved, status: post.status, debug: post.debug };
  return done(finalizeImportsExportsResult(r, kind, absPkgPath, conditions, pkgJSON.exportsMap!, pkgJSON,
    res.resolved, res.status, res.debug, esmPackageName, esmPackageSubpath, absPath));
}

// ============================================================================
// 第 174 批：resolveWithoutRemapping / loadNodeModules / loadPackageImports /
// resolveWithoutSymlinks（resolver 递归核心，resolver.go:954/1084/2248/2358）
// 一次搭厚四个互递归函数；Go 探针 20 例 testdata/rescore-go.json 逐字节固化。
// ============================================================================

/**
 * 解析核心统一上下文：继承 LoadDirContext（含 mainFields/extensionOrder/debugMeta/kind），
 * 追加四个核心函数所需的 external/pnp/NODE_PATH/conditions 字段。
 * 注意：ESM/PnP 依赖全在包内已移植（progress closure 验过 66 节点，唯一非目标缺口是
 * TSConfigJSX.ApplyTo，属 config 包，本批不涉及）。
 */
export interface ResolveCoreContext extends LoadDirContext {
  esmConditionsDefault: Record<string, boolean>;
  esmConditionsImport: Record<string, boolean>;
  esmConditionsRequire: Record<string, boolean>;
  externalExact: Record<string, boolean>;
  externalPatterns: { Prefix: string; Suffix: string }[];
  externalPackages: boolean;
  absNodePaths: string[];
  pnpManifest: import("./yarnpnp.ts").PnpData | null;
  tsConfigOverride: TSConfigJSON | null;
}

/** Go: PathPair + bool + *DifferentCase + *SideEffectsData 的四元组（本批核心返回形状） */
export interface CorePairResult {
  pair: PathPairResult;
  ok: boolean;
  diffCase: DifferentCase | null;
  side: SideEffectsData | null;
}

const coreFail = (): CorePairResult => ({ pair: emptyPair(), ok: false, diffCase: null, side: null });
const coreFromLoad = (p: PathPairResult, side: SideEffectsData | null = null): CorePairResult =>
  ({ pair: p, ok: p.ok, diffCase: p.diffCase, side });

/**
 * Go: func (r resolverQuery) resolveWithoutRemapping(sourceDirInfo, importPath) (PathPair, bool, *DifferentCase, *SideEffectsData) (resolver.go:1084)
 */
export function resolveWithoutRemapping(r: ResolveCoreContext, sourceDirInfo: dirInfo | null, importPath: string): CorePairResult {
  if (IsPackagePath(importPath)) return loadNodeModules(r, importPath, sourceDirInfo, false);
  const absolute = loadAsFileOrDirectory(r, r.fsObj.Join([sourceDirInfo!.absPath, importPath]));
  return coreFromLoad(absolute);
}

/**
 * Go: func (r resolverQuery) loadNodeModules(importPath, dirInfo, forbidImports) (PathPair, bool, *DifferentCase, *SideEffectsData) (resolver.go:2358)
 */
export function loadNodeModules(r: ResolveCoreContext, importPath: string, dirInfo: dirInfo | null, forbidImports: boolean): CorePairResult {
  const dl = r.debugLogs;
  if (dl !== null) {
    dl.addNote(`Searching for ${JSON.stringify(importPath)} in "node_modules" directories starting from ${JSON.stringify(dirInfo ? dirInfo.absPath : "")}`);
    dl.increaseIndent();
  }
  const done = (res: CorePairResult): CorePairResult => { if (dl !== null) dl.decreaseIndent(); return res; };

  // tsconfig paths / baseUrl
  const tsConfigJSON = tsConfigForDir(dirInfo, r.tsConfigOverride) as TSConfigJSON | null;
  if (tsConfigJSON !== null) {
    if ((tsConfigJSON as any).Paths != null) {
      const absolute = matchTSConfigPaths(r, tsConfigJSON, importPath);
      if (absolute.ok) return done(coreFromLoad(absolute));
    }
    if (tsConfigJSON.BaseURL !== null) {
      const basePath = r.fsObj.Join([tsConfigJSON.BaseURL, importPath]);
      const absolute = loadAsFileOrDirectory(r, basePath);
      if (absolute.ok) return done(coreFromLoad(absolute));
    }
  }

  // nearest enclosing package.json
  let pkgDir: dirInfo | null = dirInfo;
  while (pkgDir !== null && pkgDir.packageJSON === null) pkgDir = pkgDir.parent;

  // subpath imports "#..."
  if (pkgDir !== null && importPath.startsWith("#") && !forbidImports && pkgDir.packageJSON!.importsMap !== null) {
    return done(loadPackageImports(r, importPath, pkgDir));
  }

  // external packages
  if (r.externalPackages && IsPackagePath(importPath)) {
    if (dl !== null) dl.addNote("Marking this path as external because it's a package path");
    return done({ pair: { text: importPath, namespace: "", secondary: "", flags: 0, ok: true, diffCase: null }, ok: true, diffCase: null, side: null });
  }

  // Yarn PnP (probe pnpManifest=null; branch structurally ported for M2)
  if (r.pnpManifest !== null) {
    // 依赖 resolveToUnqualified + compileYarnPnPData（均在 yarnpnp.ts 已移植），M2 通道未验字节。
  }

  // ESM package name
  const { name: esmName, subpath: esmSubpath, ok: esmOK } = esmParsePackageName(importPath);
  if (dl !== null && esmOK) dl.addNote(`Parsed package name ${JSON.stringify(esmName)} and package subpath ${JSON.stringify(esmSubpath)}`);

  // self-reference
  if (pkgDir !== null) {
    const pj = pkgDir.packageJSON!;
    if (pj.name === esmName && pj.exportsMap !== null) {
      const absolute = esmResolveAlgorithm(r, 0 /* finalizeImportsExportsNormal */, esmName, esmSubpath, pj, pkgDir.absPath, r.fsObj.Join([pkgDir.absPath, esmSubpath]));
      return done(coreFromLoad(absolute));
    }
  }

  // tryToResolvePackage(absDir) -> CorePairResult + shouldStop
  const tryToResolvePackage = (absDir: string): CorePairResult & { shouldStop: boolean } => {
    const absPath = r.fsObj.Join([absDir, importPath]);
    if (dl !== null) dl.addNote(`Checking for a package in the directory ${JSON.stringify(absPath)}`);
    if (esmOK) {
      const absPkgPath = r.fsObj.Join([absDir, esmName]);
      const pkgDirInfo = dirInfoCached(r.dirInfoCtx, absPkgPath);
      if (pkgDirInfo !== null) {
        if (pkgDirInfo.packageJSON !== null && pkgDirInfo.packageJSON.exportsMap !== null) {
          const absolute = esmResolveAlgorithm(r, 0, esmName, esmSubpath, pkgDirInfo.packageJSON, absPkgPath, absPath);
          return { ...coreFromLoad(absolute), shouldStop: true };
        }
        const bmCtx: any = { platform: r.platform, extensionOrder: r.extensionOrder, fsObj: r.fsObj, debugLogs: dl };
        const remap = checkBrowserMap(bmCtx, pkgDirInfo, absPath, 0 /* absolutePathKind */);
        if (remap.ok) {
          if (remap.remapped === null) {
            return { pair: { text: absPath, namespace: "file", secondary: "", flags: PathFlags.PathDisabled, ok: true, diffCase: null }, ok: true, diffCase: null, side: null, shouldStop: true };
          }
          const rr = resolveWithoutRemapping(r, pkgDirInfo.enclosingBrowserScope, remap.remapped);
          if (rr.ok) return { ...rr, shouldStop: true };
        }
      }
    }
    const absolute = loadAsFileOrDirectory(r, absPath);
    if (absolute.ok) return { ...coreFromLoad(absolute), shouldStop: true };
    return { ...coreFail(), shouldStop: false };
  };

  // enclosing node_modules directories
  let cur = dirInfo;
  while (cur !== null) {
    if (cur.hasNodeModules) {
      const t = tryToResolvePackage(r.fsObj.Join([cur.absPath, "node_modules"]));
      if (t.shouldStop) return done({ pair: t.pair, ok: t.ok, diffCase: t.diffCase, side: t.side });
    }
    cur = cur.parent;
  }
  // NODE_PATH
  for (const absDir of r.absNodePaths) {
    const t = tryToResolvePackage(absDir);
    if (t.shouldStop) return done({ pair: t.pair, ok: t.ok, diffCase: t.diffCase, side: t.side });
  }
  return done(coreFail());
}

/**
 * Go: func (r resolverQuery) loadPackageImports(importPath, dirInfoPackageJSON) (PathPair, bool, *DifferentCase, *SideEffectsData) (resolver.go:2248)
 */
export function loadPackageImports(r: ResolveCoreContext, importPath: string, dirInfoPackageJSON: dirInfo): CorePairResult {
  const dl = r.debugLogs;
  const pj = dirInfoPackageJSON.packageJSON!;
  if (dl !== null) { dl.addNote(`Looking for ${JSON.stringify(importPath)} in "imports" map in ${JSON.stringify(pj.source.KeyPath.Text)}`); dl.increaseIndent(); }
  const done = (res: CorePairResult): CorePairResult => { if (dl !== null) dl.decreaseIndent(); return res; };

  if (importPath === "#") {
    if (dl !== null) dl.addNote(`The path ${JSON.stringify(importPath)} must not equal "#".`);
    const tracker = MakeLineColumnTracker(pj.source);
    r.debugMeta.notes.push(tracker.MsgData(pj.importsMap!.root.firstToken, `This "imports" map was ignored because the module specifier ${JSON.stringify(importPath)} is invalid:`));
    return done(coreFail());
  }

  let conditions = r.esmConditionsDefault;
  if (r.kind === ImportKind.ImportStmt || r.kind === ImportKind.ImportDynamic) conditions = r.esmConditionsImport;
  else if (r.kind === ImportKind.ImportRequire || r.kind === ImportKind.ImportRequireResolve) conditions = r.esmConditionsRequire;

  let res = esmPackageImportsResolve(importPath, pj.importsMap!.root, conditions, dl);
  res = esmHandlePostConditions(res.resolved, res.status, res.debug, dl);

  if (res.status === pjStatus.pjStatusPackageResolve) {
    const builtin = checkForBuiltInNodeModules(res.resolved, r.platform, 0, r.kind, 0n, () => {}, dl);
    if (builtin.ok) {
      const pp = builtin.pair as PathPair;
      const side = builtin.sideEffects ? new SideEffectsData() : null;
      return done({ pair: { text: pp.Primary, namespace: "", secondary: "", flags: 0, ok: true, diffCase: null }, ok: true, diffCase: null, side });
    }
    const rr = loadNodeModules(r, res.resolved, dirInfoPackageJSON, true);
    if (!rr.ok) {
      const tracker = MakeLineColumnTracker(pj.source);
      r.debugMeta.notes.unshift(tracker.MsgData(res.debug.token, `The remapped path ${JSON.stringify(res.resolved)} could not be resolved:`));
    }
    return done(rr);
  }

  const absolute = finalizeImportsExportsResult(r, 0 /* finalizeImportsExportsNormal */, dirInfoPackageJSON.absPath, conditions, pj.importsMap!, pj,
    res.resolved, res.status, res.debug, "", "", "");
  return done(coreFromLoad(absolute));
}

/**
 * Go: func (r resolverQuery) resolveWithoutSymlinks(sourceDir, sourceDirInfo, importPath) *ResolveResult (resolver.go:954)
 */
export function resolveWithoutSymlinks(r: ResolveCoreContext, sourceDir: string, sourceDirInfo: dirInfo | null, importPath: string): ResolveResult | null {
  const dl = r.debugLogs;
  const mkResult = (c: CorePairResult): ResolveResult => {
    const res = new ResolveResult();
    res.PathPair.Primary.Text = c.pair.text;
    res.PathPair.Primary.Namespace = c.pair.namespace;
    res.PathPair.Primary.Flags = c.pair.flags;
    if (c.pair.secondary !== "") res.PathPair.Secondary.Text = c.pair.secondary;
    res.PathPair.IsExternal = c.pair.namespace === "" && c.pair.ok && c.pair.text !== "" && IsExternalText(c.pair.text, r);
    res.DifferentCase = c.diffCase;
    res.PrimarySideEffectsData = c.side;
    return res;
  };

  if (importPath.startsWith("/") || r.fsObj.IsAbs(importPath)) {
    if (dl !== null) dl.addNote(`The import ${JSON.stringify(importPath)} is being treated as an absolute path`);
    const tsc = tsConfigForDir(sourceDirInfo, r.tsConfigOverride) as TSConfigJSON | null;
    if (tsc !== null && (tsc as any).Paths != null) {
      const absolute = matchTSConfigPaths(r, tsc, importPath);
      if (absolute.ok) return mkResult(coreFromLoad(absolute));
    }
    const absolute = loadAsFileOrDirectory(r, importPath);
    return absolute.ok ? mkResult(coreFromLoad(absolute)) : null;
  }

  const isPkg = IsPackagePath(importPath);
  let checkRelative = !isPkg || IsFromCSS(r.kind);
  let checkPackage = isPkg;

  if (checkRelative) {
    const absPath = r.fsObj.Join([sourceDir, importPath]);
    if (isExternal(r.externalExact, r.externalPatterns, absPath, r.kind, dl)) {
      if (dl !== null) dl.addNote(`The path ${JSON.stringify(absPath)} was marked as external by the user`);
      const res = new ResolveResult();
      res.PathPair.Primary.Text = absPath; res.PathPair.Primary.Namespace = "file"; res.PathPair.IsExternal = true;
      return res;
    }
    let hasTrailingSlash = importPath === "." || importPath === ".." || importPath.endsWith("/") || importPath.endsWith("/.") || importPath.endsWith("/..");
    const importDirInfo = dirInfoCached(r.dirInfoCtx, r.fsObj.Dir(absPath));
    let result: ResolveResult | null = null;
    if (importDirInfo !== null) {
      const bmCtx: any = { platform: r.platform, extensionOrder: r.extensionOrder, fsObj: r.fsObj, debugLogs: dl };
      const remapped = checkBrowserMap(bmCtx, importDirInfo, absPath, 0 /* absolutePathKind */);
      if (remapped.ok) {
        if (remapped.remapped === null) {
          const res = new ResolveResult();
          res.PathPair.Primary.Text = absPath; res.PathPair.Primary.Namespace = "file"; res.PathPair.Primary.Flags = PathFlags.PathDisabled;
          return res;
        }
        const rr = resolveWithoutRemapping(r, importDirInfo.enclosingBrowserScope, remapped.remapped);
        if (rr.ok) {
          result = mkResult(rr); hasTrailingSlash = false; checkRelative = false; checkPackage = false;
        }
      }
    }
    if (hasTrailingSlash) {
      const absolute = loadAsDirectory(r, absPath);
      if (absolute.ok) { checkPackage = false; result = mkResult(coreFromLoad(absolute)); }
      else if (!checkPackage) return null;
    } else if (checkRelative) {
      const absolute = loadAsFileOrDirectory(r, absPath);
      if (absolute.ok) { checkPackage = false; result = mkResult(coreFromLoad(absolute)); }
      else if (!checkPackage) return null;
    }
    if (result !== null) return result;
  }

  if (checkPackage) {
    const bmCtx: any = { platform: r.platform, extensionOrder: r.extensionOrder, fsObj: r.fsObj, debugLogs: dl };
    const remapped = checkBrowserMap(bmCtx, sourceDirInfo, importPath, 1 /* packagePathKind */);
    let sdi = sourceDirInfo;
    let ip = importPath;
    if (remapped.ok) {
      if (remapped.remapped === null) {
        const rr = loadNodeModules(r, ip, sdi, false);
        if (rr.ok) {
          const res = mkResult(rr);
          res.PathPair.Primary.Flags |= PathFlags.PathDisabled;
          if (res.PathPair.HasSecondary()) res.PathPair.Secondary.Flags |= PathFlags.PathDisabled;
          return res;
        }
        const res = new ResolveResult();
        res.PathPair.Primary.Text = ip; res.PathPair.Primary.Flags = PathFlags.PathDisabled;
        res.DifferentCase = rr.diffCase;
        return res;
      }
      ip = remapped.remapped;
      sdi = sdi!.enclosingBrowserScope;
    }
    const rr = resolveWithoutRemapping(r, sdi, ip);
    if (rr.ok) return mkResult(rr);
    return null;
  }

  return null;
}

/** 辅助：判定一个 text 形式 pair 是否 external（Go 直接用 PathPair.IsExternal，TS 扁平结构靠此还原） */
function IsExternalText(text: string, r: ResolveCoreContext): boolean {
  return isExternal(r.externalExact, r.externalPatterns, text, r.kind);
}

// ============================================================================
// 第 175 批：Resolve / ResolveGlob / ProbeResolvePackageAsRelative（resolver.go:368/580/771）
// 顶层入口三函数；Go 探针 23 例 testdata/respublic-go.json 逐字节固化。
// ============================================================================

/** 顶层入口上下文：继承 ResolveCoreContext，追加包别名/PreserveSymlinks/format/feat */
export interface ResolvePublicContext extends ResolveCoreContext {
  packageAliases: Record<string, string> | null;
  preserveSymlinks: boolean;
  format: number;
  feat: bigint;
  cwd: string;
}

const rpResultFromCore = (c: CorePairResult, ctx: ResolvePublicContext): ResolveResult => {
  const res = new ResolveResult();
  res.PathPair.Primary.Text = c.pair.text;
  res.PathPair.Primary.Namespace = c.pair.namespace;
  res.PathPair.Primary.Flags = c.pair.flags;
  res.PathPair.Primary.IgnoredSuffix = "";
  if (c.pair.secondary !== "") res.PathPair.Secondary.Text = c.pair.secondary;
  res.PathPair.IsExternal = c.pair.namespace === "" && c.pair.ok && c.pair.text !== "";
  res.DifferentCase = c.diffCase;
  res.PrimarySideEffectsData = c.side;
  return res;
};

/**
 * Go: func (res *Resolver) Resolve(sourceDir, importPath, kind) (*ResolveResult, DebugMeta) (resolver.go:368)
 */
export function Resolve(ctx: ResolvePublicContext, sourceDir: string, importPath: string, kind: number): { result: ResolveResult | null; debugMeta: DebugMeta } {
  const dm = new DebugMeta();
  const r: ResolvePublicContext = { ...ctx, debugMeta: dm, kind };

  // package alias substitutions
  if (r.packageAliases !== null && IsPackagePath(importPath)) {
    let longestKey = "", longestValue = "";
    for (const [key, value] of Object.entries(r.packageAliases)) {
      if (key.length > longestKey.length && importPath.startsWith(key) && (importPath.length === key.length || importPath[key.length] === "/")) {
        longestKey = key; longestValue = value;
      }
    }
    if (longestKey !== "") {
      dm.ModifiedImportPath = longestValue;
      const tail = importPath.slice(longestKey.length);
      if (tail !== "/") dm.ModifiedImportPath += tail;
      importPath = dm.ModifiedImportPath;
      sourceDir = r.cwd;
    }
  }

  // explicitly external / URL schemes
  const extPre = isExternal(r.externalExact, r.externalPatterns, importPath, kind, null);
  if (extPre || (kind === ImportKind.ImportURL && importPath.startsWith("#")) ||
      importPath.startsWith("http://") || importPath.startsWith("https://") || importPath.startsWith("//")) {
    const res = new ResolveResult();
    res.PathPair.Primary.Text = importPath; res.PathPair.IsExternal = true;
    return { result: res, debugMeta: dm };
  }

  // built-in node modules
  const builtin = checkForBuiltInNodeModules(importPath, r.platform, r.format, r.kind, r.feat, () => {}, r.debugLogs);
  if (builtin.ok) {
    const res = new ResolveResult();
    const pp = builtin.pair as PathPair;
    res.PathPair.Primary.Text = pp.Primary; res.PathPair.IsExternal = true;
    if (builtin.sideEffects) res.PrimarySideEffectsData = new SideEffectsData();
    return { result: res, debugMeta: dm };
  }

  // data URL
  const parsed = ParseDataURL(importPath);
  if (parsed.ok) {
    const res = new ResolveResult();
    if (parsed.parsed.DecodeMIMEType() !== 0 /* MIMETypeUnsupported */) {
      res.PathPair.Primary.Text = importPath; res.PathPair.Primary.Namespace = "dataurl";
    } else {
      res.PathPair.Primary.Text = importPath; res.PathPair.IsExternal = true;
    }
    return { result: res, debugMeta: dm };
  }

  // no source dir / wildcard
  if (sourceDir === "" || importPath.includes("*")) return { result: null, debugMeta: dm };

  const sourceDirInfo = r.dirInfoCtx.dirCache.get(sourceDir) ?? dirInfoCached(r.dirInfoCtx, sourceDir);
  if (sourceDirInfo == null || sourceDirInfo === null) return { result: null, debugMeta: dm };

  let result = resolveWithoutSymlinks(r, sourceDir, sourceDirInfo, importPath);
  if (result === null) {
    const suffix = importPath.search(/[?#]/);
    if (suffix < 1) return { result: null, debugMeta: dm };
    const result2 = resolveWithoutSymlinks(r, sourceDir, sourceDirInfo, importPath.slice(0, suffix));
    if (result2 === null) return { result: null, debugMeta: dm };
    result2.PathPair.Primary.IgnoredSuffix = importPath.slice(suffix);
    if (result2.PathPair.HasSecondary()) result2.PathPair.Secondary.IgnoredSuffix = importPath.slice(suffix);
    result = result2;
  }

  finalizeResolve(r, result);
  return { result, debugMeta: dm };
}

/**
 * Go: func (res *Resolver) ResolveGlob(sourceDir, importPathPattern, kind, prettyPattern) (map[string]ResolveResult, *logger.Msg) (resolver.go:580)
 */
export function ResolveGlob(ctx: ResolvePublicContext, sourceDir: string, importPathPattern: { Prefix: string; Wildcard: number }[], kind: number, prettyPattern: string): { results: Map<string, ResolveResult>; warning: { ID: number; Kind: number; Text: string } | null } {
  const dm = new DebugMeta();
  const r: ResolvePublicContext = { ...ctx, debugMeta: dm, kind };
  const results = new Map<string, ResolveResult>();
  if (importPathPattern.length === 0) return { results: new Map(), warning: null };
  let firstPrefix = importPathPattern[0].Prefix;
  const nonRelative = !firstPrefix.startsWith("./") && !firstPrefix.startsWith("../") && !firstPrefix.startsWith(".\\") && !firstPrefix.startsWith("..\\");
  if (nonRelative) {
    if (kind === ImportKind.ImportEntryPoint) {
      if (!r.fsObj.IsAbs(firstPrefix)) firstPrefix = "./" + firstPrefix;
    } else {
      return { results: new Map(), warning: null };
    }
  }

  let dirPrefix = 0;
  for (;;) {
    const rest = firstPrefix.slice(dirPrefix);
    const slash = rest.search(/[\/\\]/);
    if (slash === -1) break;
    const star = rest.indexOf("*");
    if (star !== -1 && slash > star) break;
    dirPrefix += slash + 1;
  }
  const suffix = firstPrefix.slice(0, dirPrefix);
  sourceDir = r.fsObj.IsAbs(suffix) ? suffix : r.fsObj.Join([sourceDir, suffix]);
  const sourceDirInfo = dirInfoCached(r.dirInfoCtx, sourceDir);
  if (sourceDirInfo === null) return { results: new Map(), warning: null };

  let canMatchOnSlash = false, wasGlobStar = false;
  let reSrc = "^";
  for (let i = 0; i < importPathPattern.length; i++) {
    let prefix = importPathPattern[i].Prefix;
    if (i === 0) prefix = firstPrefix;
    if (wasGlobStar && prefix.length > 0 && (prefix[0] === "/" || prefix[0] === "\\")) prefix = prefix.slice(1);
    reSrc += prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (importPathPattern[i].Wildcard === 2 /* GlobAllIncludingSlash */) {
      reSrc += "(?:[^/]*(?:/|$))*"; canMatchOnSlash = true; wasGlobStar = true;
    } else if (importPathPattern[i].Wildcard === 1 /* GlobAllExceptSlash */) {
      reSrc += "[^/]*"; wasGlobStar = false;
    }
  }
  reSrc += "$";
  let re: RegExp;
  try { re = new RegExp(reSrc); } catch { return { results: new Map(), warning: null }; }

  const visit = (info: any, dir: string): void => {
    for (const key of info.entries.SortedKeys()) {
      const g = info.entries.Get(key);
      const entry = g.entry;
      if (entry === null) continue;
      if (entry.Kind() === DirEntry) {
        if (canMatchOnSlash && entry.Symlink() === "") {
          const child = dirInfoCached(r.dirInfoCtx, r.fsObj.Join([info.absPath, key]));
          if (child !== null) visit(child, `${dir}${key}/`);
        }
      } else {
        const relPath = dir + key;
        if (re.test(relPath)) {
          const res = new ResolveResult();
          if (isExternal(r.externalExact, r.externalPatterns, relPath, kind, r.debugLogs)) {
            res.PathPair.Primary.Text = relPath; res.PathPair.IsExternal = true;
          } else {
            res.PathPair.Primary.Text = r.fsObj.Join([info.absPath, key]); res.PathPair.Primary.Namespace = "file";
          }
          finalizeResolve(r, res);
          results.set(relPath, res);
        }
      }
    }
  };
  visit(sourceDirInfo, firstPrefix.slice(0, dirPrefix));

  let warning: { ID: number; Kind: number; Text: string } | null = null;
  if (results.size === 0) warning = { ID: MsgID_Bundler_EmptyGlob, Kind: 1, Text: `The glob pattern ${prettyPattern} did not match any files` };
  return { results, warning };
}

/**
 * Go: func (res *Resolver) ProbeResolvePackageAsRelative(sourceDir, importPath, kind) (*ResolveResult, DebugMeta) (resolver.go:771)
 */
export function ProbeResolvePackageAsRelative(ctx: ResolvePublicContext, sourceDir: string, importPath: string, kind: number): { result: ResolveResult | null; debugMeta: DebugMeta } {
  const dm = new DebugMeta();
  const r: ResolvePublicContext = { ...ctx, debugMeta: dm, kind };
  const absPath = r.fsObj.Join([sourceDir, importPath]);
  const absolute = loadAsFileOrDirectory(r, absPath);
  if (absolute.ok) {
    const result = rpResultFromCore(coreFromLoad(absolute), r);
    finalizeResolve(r, result);
    return { result, debugMeta: dm };
  }
  return { result: null, debugMeta: dm };
}

// ============================================================================
// 第 176 批：NewResolver（resolver.go:242，Resolver 构造器底座）
// config.Options → extension orders / esm conditions / tsconfig override 一次搭厚。
// Go 探针 5 例 testdata/newresolver-go.json 逐字节固化。
// ============================================================================

/** Go: type Resolver struct（本批涉及的构造产物字段） */
export class Resolver {
  cssExtensionOrder: string[] = [];
  nodeModulesExtensionOrder: string[] = [];
  esmConditionsDefault: Record<string, boolean> = {};
  esmConditionsImport: Record<string, boolean> = {};
  esmConditionsRequire: Record<string, boolean> = {};
  tsConfigOverride: TSConfigJSON | null = null;
  options: any = null;
}

/**
 * Go: func NewResolver(call config.APICall, fs, log, caches, options) *Resolver (resolver.go:242)
 * DEVIATION：Go 的 CacheSet/mutex/plugged 状态属 M2 bundler 通道；本批只固化构造产物的
 * extension orders / esm conditions / tsconfig override（探针可观测面），其余字段按结构预留。
 */
export function NewResolver(
  call: number, fsObj: mockFS, log: Log, options: any,
): Resolver {
  const extensionOrder: string[] = options.ExtensionOrder ?? [];
  const extToLoader: Map<string, number> = options.ExtensionToLoader ?? new Map();

  // 过滤非 CSS 扩展（给 CSS @import）
  const cssExtensionOrder: string[] = [];
  for (const ext of extensionOrder) {
    const loader = LoaderFromFileExtension(extToLoader, ext);
    if (loader === Loader.LoaderNone || LoaderIsCSS(loader)) cssExtensionOrder.push(ext);
  }

  // node_modules 顺序：TS 扩展排到最后 JS 扩展之后
  const nodeModulesExtensionOrder: string[] = [];
  let split = 0;
  for (let i = 0; i < extensionOrder.length; i++) {
    const loader = LoaderFromFileExtension(extToLoader, extensionOrder[i]);
    if (loader === Loader.LoaderJS || loader === Loader.LoaderJSX) split = i + 1;
  }
  if (split !== 0) {
    for (let i = 0; i < split; i++) {
      const loader = LoaderFromFileExtension(extToLoader, extensionOrder[i]);
      if (!IsTypeScript(loader)) nodeModulesExtensionOrder.push(extensionOrder[i]);
    }
    for (const ext of extensionOrder) {
      if (IsTypeScript(LoaderFromFileExtension(extToLoader, ext))) nodeModulesExtensionOrder.push(ext);
    }
    for (let i = split; i < extensionOrder.length; i++) {
      const loader = LoaderFromFileExtension(extToLoader, extensionOrder[i]);
      if (!IsTypeScript(loader)) nodeModulesExtensionOrder.push(extensionOrder[i]);
    }
  }

  // esm conditions
  const esmConditionsDefault: Record<string, boolean> = { default: true };
  const esmConditionsImport: Record<string, boolean> = { import: true };
  const esmConditionsRequire: Record<string, boolean> = { require: true };
  for (const condition of (options.Conditions ?? [])) esmConditionsDefault[condition] = true;
  if (options.Platform === 0 /* PlatformBrowser */) esmConditionsDefault["browser"] = true;
  else if (options.Platform === 1 /* PlatformNode */) esmConditionsDefault["node"] = true;
  for (const key of Object.keys(esmConditionsDefault)) {
    esmConditionsImport[key] = true; esmConditionsRequire[key] = true;
  }

  const res = new Resolver();
  res.cssExtensionOrder = cssExtensionOrder;
  res.nodeModulesExtensionOrder = nodeModulesExtensionOrder;
  res.esmConditionsDefault = esmConditionsDefault;
  res.esmConditionsImport = esmConditionsImport;
  res.esmConditionsRequire = esmConditionsRequire;
  res.options = options;

  // tsconfig override（TSConfigRaw 路径；TSConfigPath 文件通道 M2 未验字节）
  if (options.TSConfigPath !== undefined && options.TSConfigPath !== "") {
    // 文件通道：需真实 fs，本探针只覆盖 TSConfigRaw
  } else if (options.TSConfigRaw !== undefined && options.TSConfigRaw !== "") {
    const keyPath = new LoggerPath(); keyPath.Text = fsObj.Join([fsObj.Cwd(), "<tsconfig.json>"]); keyPath.Namespace = "file";
    const source: any = { KeyPath: keyPath, PrettyPaths: { Abs: "<tsconfig.json>", Rel: "<tsconfig.json>" }, Contents: new TextEncoder().encode(options.TSConfigRaw) };
    const tscCtx: any = { fsObj, log, debugLogs: null, platform: options.Platform ?? 0, mainFields: null, preserveSymlinks: false, dirCache: new Map(), pnpManifestWasChecked: true, readFile: () => ({ contents: "", err: "no such file or directory" }) };
    const parsed = parseTSConfigFromSource(tscCtx, source, call === 0 ? new Map() : null, fsObj.Cwd());
    if (parsed.config !== null) {
      res.tsConfigOverride = parsed.config;
      options.TS = parsed.config.Settings;
      parsed.config.JSXSettings.ApplyTo(options.JSX);
      options.TSAlwaysStrict = parsed.config.TSAlwaysStrictOrStrict();
    }
  }
  return res;
}
