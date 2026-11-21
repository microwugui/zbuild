// 1:1 移植自 esbuild internal/resolver/package_json.go（v0.28.2，commit f6058f83）
// 第 44 轮 M2/M4 成片推进：纯字符串助手。
import * as js_ast from "../js_ast/js_ast.ts";
import { Source, Range, Loc, Log, MsgKind, MsgData, AddID, AddIDWithNotes, Path, MakeLineColumnTracker } from "../logger/logger.ts";
import { MsgID_PackageJSON_InvalidType, MsgID_PackageJSON_InvalidBrowser, MsgID_PackageJSON_InvalidSideEffects, MsgID_PackageJSON_InvalidImportsOrExports } from "../logger/msg_ids.ts";
import { ParseJSON, JSONOptions } from "../js_parser/json_parser.ts";
import { getProperty, getString, getBool, IsPackagePath } from "./resolver.ts";
import { UTF16ToString } from "../helpers/utf.ts";
import { IsInsideNodeModules } from "../helpers/path.ts";
import { realFS } from "../fs/fs_real.ts";
import { DirEntries } from "../fs/fs.ts";
import { TSConfigJSON } from "./tsconfig_json.ts";
import { ParseYarnPnPVirtualPath } from "../fs/fs_zip.ts";
import { MakeEmptyDirEntries } from "../fs/fs.ts";

// Go: config.Platform (config.go:152) —— PlatformBrowser=0/Node=1/Neutral=2
const PlatformBrowser = 0, PlatformNode = 1, PlatformNeutral = 2;

/** Go: func globstarToEscapedRegexp(glob string) (string, bool) (package_json.go:481) */
export function globstarToEscapedRegexp(glob: string): { value: string; ok: boolean } {
  let sb = "^";
  let hadWildcard = false;
  const n = glob.length;
  for (let i = 0; i < n; i++) {
    const c = glob[i];
    if ("\\^$.+|()[]{}".includes(c)) {
      sb += "\\" + c;
    } else if (c === "?") {
      sb += ".";
      hadWildcard = true;
    } else if (c === "*") {
      let prevChar = -1;
      if (i > 0) prevChar = glob.charCodeAt(i - 1);
      let starCount = 1;
      while (i + 1 < n && glob[i + 1] === "*") { starCount++; i++; }
      let nextChar = -1;
      if (i + 1 < n) nextChar = glob.charCodeAt(i + 1);
      const isGlobstar = starCount > 1 &&
        (prevChar === 0x2f || prevChar === -1) &&
        (nextChar === 0x2f || nextChar === -1);
      if (isGlobstar) {
        sb += "(?:[^/]*(?:/|$))*";
        i++;
      } else {
        sb += "[^/]*";
      }
      hadWildcard = true;
    } else {
      sb += c;
    }
  }
  sb += "$";
  return { value: sb, ok: hadWildcard };
}

/** Go: func esmParsePackageName(packageSpecifier string) (name, subpath string, ok bool) (package_json.go:1320) */
export function esmParsePackageName(packageSpecifier: string): { name: string; subpath: string; ok: boolean } {
  if (packageSpecifier === "") return { name: "", subpath: "", ok: false };
  let slash = packageSpecifier.indexOf("/");
  let packageName: string;
  if (!packageSpecifier.startsWith("@")) {
    if (slash === -1) slash = packageSpecifier.length;
    packageName = packageSpecifier.slice(0, slash);
  } else {
    if (slash === -1) return { name: "", subpath: "", ok: false };
    let slash2 = packageSpecifier.slice(slash + 1).indexOf("/");
    if (slash2 === -1) slash2 = packageSpecifier.slice(slash + 1).length;
    packageName = packageSpecifier.slice(0, slash + 1 + slash2);
  }
  if (packageName.startsWith(".") || /[\\%]/.test(packageName)) return { name: packageName, subpath: "", ok: false };
  const packageSubpath = "." + packageSpecifier.slice(packageName.length);
  return { name: packageName, subpath: packageSubpath, ok: true };
}

/** Go: type pjStatus uint8 (package_json.go:823) —— Go 探针实测值 */
export const pjStatus = {
  pjStatusUndefined: 0,
  pjStatusUndefinedNoConditionsMatch: 1,
  pjStatusNull: 2,
  pjStatusExact: 3,
  pjStatusExactEndsWithStar: 4,
  pjStatusInexact: 5,
  pjStatusPackageResolve: 6,
  pjStatusInvalidModuleSpecifier: 7,
  pjStatusInvalidPackageConfiguration: 8,
  pjStatusInvalidPackageTarget: 9,
  pjStatusPackagePathNotExported: 10,
  pjStatusPackageImportNotDefined: 11,
  pjStatusModuleNotFound: 12,
  pjStatusModuleNotFoundMissingExtension: 13,
  pjStatusUnsupportedDirectoryImport: 14,
  pjStatusUnsupportedDirectoryImportMissingIndex: 15,
} as const;

/** Go: func (status pjStatus) isUndefined() bool (package_json.go:858) */
export function isUndefined(status: number): boolean {
  return status === pjStatus.pjStatusUndefined || status === pjStatus.pjStatusUndefinedNoConditionsMatch;
}

/** Go: type pjEntry (package_json.go) —— 键→值映射条目 */
export class pjEntry {
  mapData: { key: string; value: pjEntry }[] = [];

  /** Go: func (entry pjEntry) valueForKey(key string) (pjEntry, bool) (package_json.go:631) */
  valueForKey(key: string): { value: pjEntry; ok: boolean } {
    for (const item of this.mapData) {
      if (item.key === key) return { value: item.value, ok: true };
    }
    return { value: new pjEntry(), ok: false };
  }

  /** Go: func (entry pjEntry) keysStartWithDot() bool (package_json.go:819) */
  keysStartWithDot(): boolean {
    return this.mapData.length > 0 && this.mapData[0].key.startsWith(".");
  }
}

/** Go: func findInvalidSegment(path string) string (package_json.go:1074) */
export function findInvalidSegment(path: string): string {
  const firstSlash = path.search(/[/\\]/);
  if (firstSlash === -1) return "";
  path = path.slice(firstSlash + 1);
  while (path !== "") {
    const slash = path.search(/[/\\]/);
    const segment = slash === -1 ? path : path.slice(0, slash);
    path = slash === -1 ? "" : path.slice(slash + 1);
    if (segment === "." || segment === ".." || segment === "node_modules") return segment;
  }
  return "";
}


/** Go: type expansionKeysArray []pjMapEntry (package_json.go:573) */
export class expansionKeysArray {
  entries: { key: string; value: any; keyRange: any }[] = [];
  constructor(entries: { key: string; value?: any; keyRange?: any }[] = []) {
    this.entries = entries.map((e) => ({ key: e.key, value: e.value, keyRange: e.keyRange }));
  }
  Len(): number { return this.entries.length; }
  Swap(i: number, j: number): void { const t = this.entries[i]; this.entries[i] = this.entries[j]; this.entries[j] = t; }
  Less(i: number, j: number): boolean {
    const keyA = this.entries[i].key, keyB = this.entries[j].key;
    const starA = keyA.indexOf("*"), starB = keyB.indexOf("*");
    const baseA = starA >= 0 ? starA : keyA.length;
    const baseB = starB >= 0 ? starB : keyB.length;
    if (baseA > baseB) return true;
    if (baseB > baseA) return false;
    if (starA < 0) return false;
    if (starB < 0) return true;
    if (keyA.length > keyB.length) return true;
    if (keyB.length > keyA.length) return false;
    return false;
  }
}

// ============================================================================
// 第 140 批：ESM resolution 族（bundler import 路径核心）。Go 探针 232 例逐字节。
// Go: package_json.go pjEntry 全保真底座（此前仅 mapData）。
// ============================================================================
export const pjKind = { pjNull: 0, pjString: 1, pjArray: 2, pjObject: 3, pjInvalid: 4 } as const;

/** Go: type pjDebug (package_json.go:861) */
export class pjDebug {
  invalidBecause = "";
  unmatchedConditions: { Text: string; Range: any }[] = [];
  token: any = null;
  isBecauseOfNullLiteral = false;
}
export const newPjDebug = (token: any = null): pjDebug => { const d = new pjDebug(); d.token = token; return d; };

// 全保真 pjEntry：以独立类 pjEntryFull 落地，避免破坏既有最小底座 pjEntry 的夹具
/** Go: type pjEntry struct (package_json.go:557) */
export class pjEntryFull {
  strData = "";
  arrData: pjEntryFull[] = [];
  mapData: { key: string; value: pjEntryFull; keyRange: any }[] = [];
  expansionKeys: { key: string; value: pjEntryFull; keyRange: any }[] = [];
  firstToken: any = null;
  kind: number = pjKind.pjNull;

  valueForKey(key: string): { value: pjEntryFull; ok: boolean } {
    for (const item of this.mapData) if (item.key === key) return { value: item.value, ok: true };
    return { value: new pjEntryFull(), ok: false };
  }
  keysStartWithDot(): boolean { return this.mapData.length > 0 && this.mapData[0].key.startsWith("."); }
}
export function mkEntry(spec: any): pjEntryFull {
  const e = new pjEntryFull();
  if (!spec) { e.kind = pjKind.pjInvalid; return e; }
  e.kind = spec.k ?? pjKind.pjNull;
  if (spec.s !== undefined) e.strData = spec.s;
  if (spec.t) e.firstToken = { Loc: { Start: spec.t[0] }, Len: spec.t[1] };
  if (spec.a) e.arrData = spec.a.map(mkEntry);
  if (spec.m) {
    for (const p of spec.m) {
      const me = { key: p[0], value: mkEntry(p[1]), keyRange: p[2] ? { Loc: { Start: p[2][0] }, Len: p[2][1] } : { Loc: { Start: 0 }, Len: 0 } };
      e.mapData.push(me);
      if (me.key.endsWith("/") || me.key.includes("*")) e.expansionKeys.push(me);
    }
    // sort.Stable by PATTERN_KEY_COMPARE (descending specificity)
    const cmp = (a: any, b: any): number => {
      const sa = a.key.indexOf("*"), sb = b.key.indexOf("*");
      const ba = sa >= 0 ? sa : a.key.length, bb = sb >= 0 ? sb : b.key.length;
      if (ba > bb) return -1; if (bb > ba) return 1;
      if (sa < 0) return 1; if (sb < 0) return -1;
      if (a.key.length > b.key.length) return -1; if (b.key.length > a.key.length) return 1;
      return 0;
    };
    e.expansionKeys = e.expansionKeys.map((x, i) => ({ x, i })).sort((p, q) => cmp(p.x, q.x) || p.i - q.i).map((p) => p.x);
  }
  return e;
}
const pjIsUndefined = (s: number): boolean => s === 0 || s === 1;

/** Go: func findInvalidSegment(path string) string (package_json.go:1074) —— 已有最小版，补权威导出 */
export function findInvalidSegmentFull(path: string): string {
  const slash = path.search(/[/\\]/);
  if (slash === -1) return "";
  path = path.slice(slash + 1);
  while (path !== "") {
    const s2 = path.search(/[/\\]/);
    const segment = s2 === -1 ? path : path.slice(0, s2);
    path = s2 === -1 ? "" : path.slice(s2 + 1);
    if (segment === "." || segment === ".." || segment === "node_modules") return segment;
  }
  return "";
}

/** Go path.Join for URL-ish paths (forward slashes, clean dots) */
function pathJoin(...parts: string[]): string {
  const joined = parts.filter((p) => p !== "").join("/");
  const isAbs = joined.startsWith("/");
  const segs: string[] = [];
  for (const s of joined.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") { if (segs.length > 0 && segs[segs.length - 1] !== "..") segs.pop(); else if (!isAbs) segs.push(".."); continue; }
    segs.push(s);
  }
  const res = segs.join("/");
  return isAbs ? "/" + res : res;
}

/** Go: func (r resolverQuery) esmHandlePostConditions (package_json.go:879) */
export function esmHandlePostConditions(resolved: string, status: number, debug: pjDebug, dl: any = null): { resolved: string; status: number; debug: pjDebug } {
  if (status !== 3 && status !== 4 && status !== 5) return { resolved, status, debug };
  let resolvedPath: string;
  try { resolvedPath = decodeURIComponent(resolved); }
  catch (e) { dl?.addNote(`The path ${JSON.stringify(resolved)} contains invalid URL escapes: ${String(e)}`); return { resolved, status: 7, debug }; }
  let found = "";
  for (const f of ["%2f", "%2F", "%5c", "%5C"]) if (resolved.includes(f)) { found = f; break; }
  if (found !== "") { dl?.addNote(`The path ${JSON.stringify(resolved)} is not allowed to contain ${JSON.stringify(found)}`); return { resolved, status: 7, debug }; }
  if (resolvedPath.endsWith("/") || resolvedPath.endsWith("\\")) { dl?.addNote(`The path ${JSON.stringify(resolved)} is not allowed to end with a slash`); return { resolved, status: 14, debug }; }
  return { resolved: resolvedPath, status, debug };
}

/** Go: func (r resolverQuery) esmPackageTargetResolve (package_json.go:1096) */
export function esmPackageTargetResolve(
  packageURL: string, target: pjEntryFull, subpath: string, pattern: boolean, internal: boolean,
  conditions: Record<string, boolean>, dl: any = null,
): { resolved: string; status: number; debug: pjDebug } {
  switch (target.kind) {
    case pjKind.pjString: {
      if (dl) { dl.addNote(`Checking path ${JSON.stringify(subpath)} against target ${JSON.stringify(target.strData)}`); dl.increaseIndent(); }
      const decIndent = () => { if (dl) dl.decreaseIndent(); };
      if (!pattern && subpath !== "" && !target.strData.endsWith("/")) {
        if (dl) dl.addNote(`The target ${JSON.stringify(target.strData)} is invalid because it doesn't end in "/"`);
        decIndent();
        const d = newPjDebug(target.firstToken); d.invalidBecause = ` because it doesn't end in "/"`;
        return { resolved: target.strData, status: 7, debug: d };
      }
      if (!target.strData.startsWith("./")) {
        if (internal && !target.strData.startsWith("../") && !target.strData.startsWith("/")) {
          if (pattern) {
            const result = target.strData.split("*").join(subpath);
            if (dl) dl.addNote(`Substituted ${JSON.stringify(subpath)} for "*" in ${JSON.stringify(target.strData)} to get ${JSON.stringify(result)}`);
            decIndent(); return { resolved: result, status: 6, debug: newPjDebug(target.firstToken) };
          }
          const result = target.strData + subpath;
          if (dl) dl.addNote(`Joined ${JSON.stringify(target.strData)} to ${JSON.stringify(subpath)} to get ${JSON.stringify(result)}`);
          decIndent(); return { resolved: result, status: 6, debug: newPjDebug(target.firstToken) };
        }
        if (dl) dl.addNote(`The target ${JSON.stringify(target.strData)} is invalid because it doesn't start with "./"`);
        decIndent();
        const d = newPjDebug(target.firstToken); d.invalidBecause = ` because it doesn't start with "./"`;
        return { resolved: target.strData, status: 9, debug: d };
      }
      const invT = findInvalidSegmentFull(target.strData);
      if (invT !== "") {
        if (dl) dl.addNote(`The target ${JSON.stringify(target.strData)} is invalid because it contains invalid segment ${JSON.stringify(invT)}`);
        decIndent();
        const d = newPjDebug(target.firstToken); d.invalidBecause = ` because it contains invalid segment ${JSON.stringify(invT)}`;
        return { resolved: target.strData, status: 9, debug: d };
      }
      const resolvedTarget = pathJoin(packageURL, target.strData);
      const invS = findInvalidSegmentFull(subpath);
      if (invS !== "") {
        if (dl) dl.addNote(`The path ${JSON.stringify(subpath)} is invalid because it contains invalid segment ${JSON.stringify(invS)}`);
        decIndent();
        const d = newPjDebug(target.firstToken); d.invalidBecause = ` because it contains invalid segment ${JSON.stringify(invS)}`;
        return { resolved: subpath, status: 7, debug: d };
      }
      if (pattern) {
        const result = resolvedTarget.split("*").join(subpath);
        if (dl) dl.addNote(`Substituted ${JSON.stringify(subpath)} for "*" in ${JSON.stringify("." + resolvedTarget)} to get ${JSON.stringify("." + result)}`);
        decIndent();
        let status = 3;
        if (resolvedTarget.endsWith("*") && resolvedTarget.indexOf("*") === resolvedTarget.length - 1) status = 4;
        return { resolved: result, status, debug: newPjDebug(target.firstToken) };
      } else {
        const result = pathJoin(resolvedTarget, subpath);
        if (dl) dl.addNote(`Joined ${JSON.stringify(subpath)} to ${JSON.stringify("." + resolvedTarget)} to get ${JSON.stringify("." + result)}`);
        decIndent(); return { resolved: result, status: 3, debug: newPjDebug(target.firstToken) };
      }
    }
    case pjKind.pjObject: {
      if (dl) {
        const keys = Object.keys(conditions).map((k) => JSON.stringify(k)).sort();
        dl.addNote(`Checking condition map for one of [${keys.join(", ")}]`); dl.increaseIndent();
      }
      const decIndent = () => { if (dl) dl.decreaseIndent(); };
      let didFindMapEntry = false; let lastMapEntry: any = null;
      for (const p of target.mapData) {
        if (p.key === "default" || conditions[p.key]) {
          if (dl) dl.addNote(`The key ${JSON.stringify(p.key)} applies`);
          const r = esmPackageTargetResolve(packageURL, p.value, subpath, pattern, internal, conditions, dl);
          if (pjIsUndefined(r.status)) { didFindMapEntry = true; lastMapEntry = p; continue; }
          decIndent(); return r;
        }
        if (dl) dl.addNote(`The key ${JSON.stringify(p.key)} does not apply`);
      }
      if (dl) dl.addNote("No keys in the map were applicable");
      if (target.mapData.length > 0 && !target.keysStartWithDot()) {
        let t2 = target;
        if (didFindMapEntry && lastMapEntry.value.kind === pjKind.pjObject && lastMapEntry.value.mapData.length > 0 && !lastMapEntry.value.keysStartWithDot()) t2 = lastMapEntry.value;
        const keys = t2.mapData.map((p: any) => ({ Text: p.key, Range: p.keyRange }));
        const d = newPjDebug(t2.firstToken); d.unmatchedConditions = keys;
        decIndent(); return { resolved: "", status: 1, debug: d };
      }
      decIndent(); return { resolved: "", status: 0, debug: newPjDebug(target.firstToken) };
    }
    case pjKind.pjArray: {
      if (target.arrData.length === 0) {
        if (dl) dl.addNote(`The path ${JSON.stringify(subpath)} is set to an empty array`);
        return { resolved: "", status: 2, debug: newPjDebug(target.firstToken) };
      }
      if (dl) { dl.addNote(`Checking for ${JSON.stringify(subpath)} in an array`); dl.increaseIndent(); }
      let lastException = 0; let lastDebug = newPjDebug(target.firstToken);
      for (const tv of target.arrData) {
        const r = esmPackageTargetResolve(packageURL, tv, subpath, pattern, internal, conditions, dl);
        if (r.status === 9 || r.status === 2) { lastException = r.status; lastDebug = r.debug; continue; }
        if (pjIsUndefined(r.status)) continue;
        if (dl) dl.decreaseIndent();
        return r;
      }
      if (dl) dl.decreaseIndent();
      return { resolved: "", status: lastException, debug: lastDebug };
    }
    case pjKind.pjNull: {
      if (dl) dl.addNote(`The path ${JSON.stringify(subpath)} is set to null`);
      const d = newPjDebug(target.firstToken); d.isBecauseOfNullLiteral = true;
      return { resolved: "", status: 2, debug: d };
    }
  }
  if (dl) dl.addNote(`Invalid package target for path ${JSON.stringify(subpath)}`);
  return { resolved: "", status: 9, debug: newPjDebug(target.firstToken) };
}

/** Go: func (r resolverQuery) esmPackageImportsExportsResolve (package_json.go:997) */
export function esmPackageImportsExportsResolve(
  matchKey: string, matchObj: pjEntryFull, packageURL: string, isImports: boolean,
  conditions: Record<string, boolean>, dl: any = null,
): { resolved: string; status: number; debug: pjDebug } {
  if (dl) dl.addNote(`Checking object path map for ${JSON.stringify(matchKey)}`);
  if (!matchKey.endsWith("/") && matchKey.indexOf("*") < 0) {
    const ex = matchObj.valueForKey(matchKey);
    if (ex.ok) {
      if (dl) dl.addNote(`Found exact match for ${JSON.stringify(matchKey)}`);
      return esmPackageTargetResolve(packageURL, ex.value, "", false, isImports, conditions, dl);
    }
  }
  for (const expansion of matchObj.expansionKeys) {
    const star = expansion.key.indexOf("*");
    if (star >= 0) {
      const patternBase = expansion.key.slice(0, star);
      if (matchKey.startsWith(patternBase)) {
        const patternTrailer = expansion.key.slice(star + 1);
        if (patternTrailer === "" || (matchKey.endsWith(patternTrailer) && matchKey.length >= expansion.key.length)) {
          const subpath = matchKey.slice(patternBase.length, matchKey.length - patternTrailer.length);
          if (dl) dl.addNote(`The key ${JSON.stringify(expansion.key)} matched with ${JSON.stringify(subpath)} left over`);
          return esmPackageTargetResolve(packageURL, expansion.value, subpath, true, isImports, conditions, dl);
        }
      }
    } else {
      if (matchKey.startsWith(expansion.key)) {
        const subpath = matchKey.slice(expansion.key.length);
        if (dl) dl.addNote(`The key ${JSON.stringify(expansion.key)} matched with ${JSON.stringify(subpath)} left over`);
        const r = esmPackageTargetResolve(packageURL, expansion.value, subpath, false, isImports, conditions, dl);
        if (r.status === 3 || r.status === 4) r.status = 5;
        return r;
      }
    }
    if (dl) dl.addNote(`The key ${JSON.stringify(expansion.key)} did not match`);
  }
  if (dl) dl.addNote(`No keys matched ${JSON.stringify(matchKey)}`);
  return { resolved: "", status: 2, debug: newPjDebug(matchObj.firstToken) };
}

/** Go: func (r resolverQuery) esmPackageImportsResolve (package_json.go:927) */
export function esmPackageImportsResolve(specifier: string, imports: pjEntryFull, conditions: Record<string, boolean>, dl: any = null): { resolved: string; status: number; debug: pjDebug } {
  if (imports.kind !== pjKind.pjObject) return { resolved: "", status: 8, debug: newPjDebug(imports.firstToken) };
  const r = esmPackageImportsExportsResolve(specifier, imports, "/", true, conditions, dl);
  if (r.status !== 2 && r.status !== 0) return r;
  if (dl) dl.addNote(`The package import ${JSON.stringify(specifier)} is not defined`);
  return { resolved: specifier, status: 11, debug: newPjDebug(imports.firstToken) };
}

/** Go: func (r resolverQuery) esmPackageExportsResolve (package_json.go:948) */
export function esmPackageExportsResolve(packageURL: string, subpath: string, exports: pjEntryFull, conditions: Record<string, boolean>, dl: any = null): { resolved: string; status: number; debug: pjDebug } {
  if (exports.kind === pjKind.pjInvalid) {
    if (dl) dl.addNote("Invalid package configuration");
    return { resolved: "", status: 8, debug: newPjDebug(exports.firstToken) };
  }
  let debugToReturn = newPjDebug(exports.firstToken);
  if (subpath === ".") {
    let mainExport = new pjEntryFull(); mainExport.kind = pjKind.pjNull;
    if (exports.kind === pjKind.pjString || exports.kind === pjKind.pjArray || (exports.kind === pjKind.pjObject && !exports.keysStartWithDot())) {
      mainExport = exports;
    } else if (exports.kind === pjKind.pjObject) {
      const dot = exports.valueForKey(".");
      if (dot.ok) { if (dl) dl.addNote(`Using the entry for "."`); mainExport = dot.value; }
    }
    if (mainExport.kind !== pjKind.pjNull) {
      const r = esmPackageTargetResolve(packageURL, mainExport, "", false, false, conditions, dl);
      if (r.status !== 2 && r.status !== 0) return r;
      debugToReturn = r.debug;
    }
  } else if (exports.kind === pjKind.pjObject && exports.keysStartWithDot()) {
    const r = esmPackageImportsExportsResolve(subpath, exports, packageURL, false, conditions, dl);
    if (r.status !== 2 && r.status !== 0) return r;
    debugToReturn = r.debug;
  }
  if (dl) dl.addNote(`The path ${JSON.stringify(subpath)} is not exported`);
  return { resolved: "", status: 10, debug: debugToReturn };
}

export const esmReverseExact = 0, esmReversePattern = 1, esmReversePrefix = 2;

/** Go: func (r resolverQuery) esmPackageTargetReverseResolve (package_json.go:1401) */
export function esmPackageTargetReverseResolve(query: string, key: string, target: pjEntryFull, kind: number, conditions: Record<string, boolean>): { ok: boolean; subpath: string; token: any } {
  const hit = (sub: string) => ({ ok: true, subpath: sub, token: target.firstToken });
  switch (target.kind) {
    case pjKind.pjString:
      if (kind === esmReverseExact) { if (query === target.strData) return hit(key); }
      else if (kind === esmReversePrefix) { if (query.startsWith(target.strData)) return hit(key + query.slice(target.strData.length)); }
      else if (kind === esmReversePattern) {
        const star = target.strData.indexOf("*");
        const keyWithoutTrailingStar = key.endsWith("*") ? key.slice(0, -1) : key;
        if (star === -1) { if (query === target.strData) return hit(keyWithoutTrailingStar); break; }
        const prefix = target.strData.slice(0, star), suffix = target.strData.slice(star + 1);
        if (!suffix.includes("*") && query.startsWith(prefix)) {
          const afterPrefix = query.slice(prefix.length);
          if (afterPrefix.endsWith(suffix)) return hit(keyWithoutTrailingStar + afterPrefix.slice(0, afterPrefix.length - suffix.length));
        }
      }
      break;
    case pjKind.pjObject:
      for (const p of target.mapData) if (p.key === "default" || conditions[p.key]) {
        const r = esmPackageTargetReverseResolve(query, key, p.value, kind, conditions);
        if (r.ok) return r;
      }
      break;
    case pjKind.pjArray:
      for (const tv of target.arrData) { const r = esmPackageTargetReverseResolve(query, key, tv, kind, conditions); if (r.ok) return r; }
      break;
  }
  return { ok: false, subpath: "", token: { Loc: { Start: 0 }, Len: 0 } };
}

/** Go: func (r resolverQuery) esmPackageImportsExportsReverseResolve (package_json.go:1365) */
export function esmPackageImportsExportsReverseResolve(query: string, matchObj: pjEntryFull, conditions: Record<string, boolean>): { ok: boolean; subpath: string; token: any } {
  if (!query.endsWith("*")) {
    for (const e of matchObj.mapData) {
      const r = esmPackageTargetReverseResolve(query, e.key, e.value, esmReverseExact, conditions);
      if (r.ok) return r;
    }
  }
  for (const expansion of matchObj.expansionKeys) {
    if (expansion.key.endsWith("*")) {
      const r = esmPackageTargetReverseResolve(query, expansion.key, expansion.value, esmReversePattern, conditions);
      if (r.ok) return r;
    }
    const r2 = esmPackageTargetReverseResolve(query, expansion.key, expansion.value, esmReversePrefix, conditions);
    if (r2.ok) return r2;
  }
  return { ok: false, subpath: "", token: { Loc: { Start: 0 }, Len: 0 } };
}

/** Go: func (r resolverQuery) esmPackageExportsReverseResolve (package_json.go:1351) */
export function esmPackageExportsReverseResolve(query: string, root: pjEntryFull, conditions: Record<string, boolean>): { ok: boolean; subpath: string; token: any } {
  if (root.kind === pjKind.pjObject && root.keysStartWithDot()) {
    const r = esmPackageImportsExportsReverseResolve(query, root, conditions);
    if (r.ok) return r;
  }
  return { ok: false, subpath: "", token: { Loc: { Start: 0 }, Len: 0 } };
}

// ============================================================================
// 第 141 批：parseImportsExportsMap（JSON → pjEntry 全保真树），Go 探针逐字节。
// ============================================================================
import { RangeOfIdentifier as JSRangeOfIdentifier } from "../js_lexer/js_lexer.ts";
import { MakeLineColumnTracker as MLCT } from "../logger/logger.ts";

/** Go: type pjMap (package_json.go:541) */
export class pjMap { root: pjEntryFull = new pjEntryFull(); propertyKey = ""; propertyKeyLoc: any = null; }

/** Go: func parseImportsExportsMap (package_json.go:640) —— 只用 root/key 做返回，诊断走 log */
export function parseImportsExportsMap(
  source: any, log: any, json: js_ast.Expr, propertyKey: string, propertyKeyLoc: any,
): pjMap | null {
  const tracker = MLCT(source);
  const visit = (expr: js_ast.Expr): pjEntryFull => {
    const d = expr.Data;
    if (d instanceof js_ast.ENull) {
      const e = new pjEntryFull(); e.kind = pjKind.pjNull; e.firstToken = JSRangeOfIdentifier(source, expr.Loc); return e;
    }
    if (d instanceof js_ast.EString) {
      const e = new pjEntryFull(); e.kind = pjKind.pjString; e.firstToken = source.RangeOfString(expr.Loc);
      e.strData = new TextDecoder().decode(UTF16ToString((d as js_ast.EString).Value)); return e;
    }
    if (d instanceof js_ast.EArray) {
      const e = new pjEntryFull(); e.kind = pjKind.pjArray; e.firstToken = { Loc: { Start: expr.Loc.Start }, Len: 1 };
      e.arrData = (d as js_ast.EArray).Items.map(visit); return e;
    }
    if (d instanceof js_ast.EObject) {
      const e = new pjEntryFull(); e.kind = pjKind.pjObject; e.firstToken = { Loc: { Start: expr.Loc.Start }, Len: 1 };
      let isConditionalSugar: boolean | null = null;
      for (let i = 0; i < (d as js_ast.EObject).Properties.length; i++) {
        const prop = (d as js_ast.EObject).Properties[i];
        const keyE = prop.Key.Data;
        const key = keyE instanceof js_ast.EString ? new TextDecoder().decode(UTF16ToString(keyE.Value)) : "";
        const keyRange = source.RangeOfString(prop.Key.Loc);
        const cur = !key.startsWith(".");
        if (i === 0) isConditionalSugar = cur;
        else if (isConditionalSugar !== cur) {
          const bad = new pjEntryFull(); bad.kind = pjKind.pjInvalid; bad.firstToken = e.firstToken; return bad;
        }
        const me = { key, value: visit(prop.ValueOrNil ?? new js_ast.Expr()), keyRange };
        e.mapData.push(me);
        if (key.endsWith("/") || key.includes("*")) e.expansionKeys.push(me);
      }
      // sort.Stable expansionKeys by PATTERN_KEY_COMPARE
      const cmp = (a: any, b: any): number => {
        const sa = a.key.indexOf("*"), sb = b.key.indexOf("*");
        const ba = sa >= 0 ? sa : a.key.length, bb = sb >= 0 ? sb : b.key.length;
        if (ba > bb) return -1; if (bb > ba) return 1;
        if (sa < 0) return 1; if (sb < 0) return -1;
        if (a.key.length > b.key.length) return -1; if (b.key.length > a.key.length) return 1;
        return 0;
      };
      e.expansionKeys = e.expansionKeys.map((x, i) => ({ x, i })).sort((p, q) => cmp(p.x, q.x) || p.i - q.i).map((p) => p.x);
      return e;
    }
    // EBoolean/ENumber/other → invalid with firstToken
    const bad = new pjEntryFull(); bad.kind = pjKind.pjInvalid;
    if (d instanceof js_ast.EBoolean || d instanceof js_ast.ENumber) bad.firstToken = JSRangeOfIdentifier(source, expr.Loc);
    else bad.firstToken = { Loc: { Start: expr.Loc.Start }, Len: 0 };
    AddID(log, MsgID_PackageJSON_InvalidImportsOrExports, MsgKind.Warning, tracker, bad.firstToken,
      "This value must be a string, an object, an array, or null");
    return bad;
  };
  const root = visit(json);
  if (root.kind === pjKind.pjNull) return null;
  const m = new pjMap(); m.root = root; m.propertyKey = propertyKey; m.propertyKeyLoc = propertyKeyLoc;
  return m;
}

// ============================================================================
// 第 160 批：packageJSON 底座 + parsePackageJSON（package_json.go:251，227 行）
// Resolve 链核心构造器：一次产出 name/mainFields/moduleTypeData/browserMap/
// sideEffects/importsMap/exportsMap，解锁 dirInfo/checkBrowserMap 等下游。
// TS 无 cache.FSCache（读文件用 readFile 回调注入，测试传内存 map）。
// ============================================================================
/** Go: type mainField (package_json.go) */
export class mainField { relPath = ""; keyLoc = new Loc(0); }

/** Go: type SideEffectsData (resolver.go:88) */
export class SideEffectsData {
  Source: Source | null = null;
  PluginName = "";
  Range = new Range();
  IsSideEffectsArrayInJSON = false;
}

/** Go: type packageJSON (package_json.go:20) */
export class packageJSON {
  name = "";
  mainFields = new Map<string, mainField>();
  moduleTypeData = new js_ast.ModuleTypeData();
  tsconfig = "";
  browserMap: Map<string, string | null> | null = null;
  sideEffectsMap: Map<string, boolean> | null = null;
  sideEffectsRegexps: RegExp[] = [];
  sideEffectsData: SideEffectsData | null = null;
  importsMap: pjMap | null = null;
  exportsMap: pjMap | null = null;
  source = new Source();
}

/** Go: defaultMainFields (resolver.go:23) / mainFieldsForFailure (resolver.go:59) */
export const defaultMainFields: Record<number, string[]> = {
  [PlatformBrowser]: ["browser", "module", "main"],
  [PlatformNode]: ["main", "module"],
  [PlatformNeutral]: [],
};
export const mainFieldsForFailure = ["main", "module"];

/** parsePackageJSON 上下文：对应 Go resolverQuery 的相关字段 */
export interface PkgJSONContext {
  fsObj: realFS;
  log: Log;
  tracker: any; // LineColumnTracker —— 由调用方按 source 构造
  platform: number;
  mainFields: string[] | null;
  debugLogs: { addNote(s: string): void } | null;
  /** 模拟 cache.FSCache.ReadFile(fs, path) -> {contents, err} */
  readFile: (path: string) => { contents: string; err: string | null };
}

/** Go: func (r resolverQuery) parsePackageJSON(inputPath string) *packageJSON (package_json.go:251) */
export function parsePackageJSON(inputPath: string, r: PkgJSONContext): packageJSON | null {
  const fsobj = r.fsObj;
  const packageJSONPath = fsobj.Join([inputPath, "package.json"]);
  const rf = r.readFile(packageJSONPath);
  if (r.debugLogs !== null && rf.err !== null) {
    r.debugLogs.addNote(`Failed to read file ${JSON.stringify(packageJSONPath)}: ${rf.err}`);
  }
  if (rf.err !== null) {
    // Cannot read file: error path. 探针不触发此分支（内容总存在）。
    return null;
  }
  if (r.debugLogs !== null) r.debugLogs.addNote(`The file ${JSON.stringify(packageJSONPath)} exists`);

  const keyPath = new Path(); keyPath.Text = packageJSONPath; keyPath.Namespace = "file";
  const jsonSource = new Source();
  jsonSource.KeyPath = keyPath;
  jsonSource.Contents = new TextEncoder().encode(rf.contents);
  const tracker = MakeLineColumnTracker(jsonSource);

  const parsed = ParseJSON(r.log, jsonSource, new JSONOptions());
  const json = parsed.expr;
  if (!parsed.ok) return null;

  const pj = new packageJSON();
  pj.source = jsonSource;

  // name
  {
    const p = getProperty(json, "name");
    if (p.ok) { const g = getString(p.value); if (g.ok) pj.name = g.value; }
  }

  // type
  {
    const p = getProperty(json, "type");
    if (p.ok) {
      const g = getString(p.value);
      if (g.ok) {
        switch (g.value) {
          case "commonjs":
            pj.moduleTypeData.Type = js_ast.ModuleType.ModuleCommonJS_PackageJSON;
            pj.moduleTypeData.Source = jsonSource;
            pj.moduleTypeData.Range = jsonSource.RangeOfString(new Loc(p.value.Loc.Start));
            break;
          case "module":
            pj.moduleTypeData.Type = js_ast.ModuleType.ModuleESM_PackageJSON;
            pj.moduleTypeData.Source = jsonSource;
            pj.moduleTypeData.Range = jsonSource.RangeOfString(new Loc(p.value.Loc.Start));
            break;
          default: {
            const notes: MsgData[] = [{ Text: "The \"type\" field must be set to either \"commonjs\" or \"module\"." } as MsgData];
            let kind: MsgKind = MsgKind.Warning;
            if (g.value.endsWith(".d.ts")) {
              notes[0] = tracker.MsgData(jsonSource.RangeOfString(new Loc(p.loc)),
                "TypeScript type declarations use the \"types\" field, not the \"type\" field:");
              (notes[0] as any).Location.Suggestion = "\"types\"";
              if (IsInsideNodeModules(jsonSource.KeyPath.Text)) kind = MsgKind.Debug;
            }
            AddIDWithNotes(r.log, MsgID_PackageJSON_InvalidType, kind, tracker, jsonSource.RangeOfString(new Loc(p.value.Loc.Start)),
              `${JSON.stringify(g.value)} is not a valid value for the "type" field`, notes);
          }
        }
      } else {
        // type 值非字符串
        AddID(r.log, MsgID_PackageJSON_InvalidType, MsgKind.Warning, tracker,
          new Range(new Loc(p.value.Loc.Start), 0), "The value for \"type\" must be a string");
      }
    }
  }

  // tsconfig
  {
    const p = getProperty(json, "tsconfig");
    if (p.ok) { const g = getString(p.value); if (g.ok) pj.tsconfig = g.value; }
  }

  // main fields
  let mainFields = r.mainFields;
  if (mainFields === null) mainFields = defaultMainFields[r.platform] ?? [];
  for (const field of mainFields) {
    const p = getProperty(json, field);
    if (p.ok) {
      const g = getString(p.value);
      if (g.ok && g.value !== "") { const mf = new mainField(); mf.keyLoc = new Loc(p.loc); mf.relPath = g.value; pj.mainFields.set(field, mf); }
    }
  }
  for (const field of mainFieldsForFailure) {
    if (!pj.mainFields.has(field)) {
      const p = getProperty(json, field);
      if (p.ok) { const g = getString(p.value); if (g.ok && g.value !== "") { const mf = new mainField(); mf.keyLoc = new Loc(p.loc); mf.relPath = g.value; pj.mainFields.set(field, mf); } }
    }
  }

  // browser (only when targeting browser)
  {
    const p = getProperty(json, "browser");
    if (p.ok && r.platform === PlatformBrowser) {
      if (p.value.Data instanceof js_ast.EObject) {
        const bm = new Map<string, string | null>();
        for (const prop of (p.value.Data as js_ast.EObject).Properties) {
          const keyG = getString(prop.Key);
          const pv = prop.ValueOrNil ?? new js_ast.Expr();
          if (keyG.ok && pv.Data != null) {
            const valG = getString(pv);
            if (valG.ok) bm.set(keyG.value, valG.value);
            else {
              const bG = getBool(pv);
              if (bG.ok) { if (!bG.value) bm.set(keyG.value, null); }
              else AddID(r.log, MsgID_PackageJSON_InvalidBrowser, MsgKind.Warning, tracker,
                new Range(new Loc(pv.Loc.Start), 0), "Each \"browser\" mapping must be a string or a boolean");
            }
          }
        }
        pj.browserMap = bm;
      }
    }
  }

  // sideEffects
  {
    const p = getProperty(json, "sideEffects");
    if (p.ok) {
      const data = p.value.Data;
      if (data instanceof js_ast.EBoolean) {
        if (!data.Value) {
          pj.sideEffectsMap = new Map<string, boolean>();
          const se = new SideEffectsData(); se.IsSideEffectsArrayInJSON = false;
          se.Source = jsonSource; se.Range = jsonSource.RangeOfString(new Loc(p.loc));
          pj.sideEffectsData = se;
        }
      } else if (data instanceof js_ast.EArray) {
        pj.sideEffectsMap = new Map<string, boolean>();
        const se = new SideEffectsData(); se.IsSideEffectsArrayInJSON = true;
        se.Source = jsonSource; se.Range = jsonSource.RangeOfString(new Loc(p.loc));
        pj.sideEffectsData = se;
        for (const itemJSON of (data as js_ast.EArray).Items) {
          if (!(itemJSON.Data instanceof js_ast.EString) || (itemJSON.Data as js_ast.EString).Value == null) {
            AddID(r.log, MsgID_PackageJSON_InvalidSideEffects, MsgKind.Warning, tracker,
              new Range(new Loc(itemJSON.Loc.Start), 0), "Expected string in array for \"sideEffects\"");
            continue;
          }
          let pattern = new TextDecoder().decode(UTF16ToString((itemJSON.Data as js_ast.EString).Value));
          if (!pattern.includes("/")) pattern = "**/" + pattern;
          let absPattern = fsobj.Join([inputPath, pattern]);
          absPattern = absPattern.replace(/\\/g, "/");
          const { value: re, ok: hadWildcard } = globstarToEscapedRegexp(absPattern);
          if (hadWildcard) { pj.sideEffectsRegexps.push(new RegExp(re)); continue; }
          pj.sideEffectsMap.set(absPattern, true);
        }
      } else {
        AddID(r.log, MsgID_PackageJSON_InvalidSideEffects, MsgKind.Warning, tracker,
          new Range(new Loc(p.value.Loc.Start), 0), "The value for \"sideEffects\" must be a boolean or an array");
      }
    }
  }

  // imports
  {
    const p = getProperty(json, "imports");
    if (p.ok) {
      const im = parseImportsExportsMap(jsonSource, r.log, p.value, "imports", new Loc(p.loc));
      if (im !== null) {
        if (im.root.kind !== pjKind.pjObject) {
          AddID(r.log, MsgID_PackageJSON_InvalidImportsOrExports, MsgKind.Warning, tracker,
            im.root.firstToken ?? new Range(), "The value for \"imports\" must be an object");
        }
        pj.importsMap = im;
      }
    }
  }

  // exports
  {
    const p = getProperty(json, "exports");
    if (p.ok) {
      const ex = parseImportsExportsMap(jsonSource, r.log, p.value, "exports", new Loc(p.loc));
      if (ex !== null) pj.exportsMap = ex;
    }
  }

  return pj;
}

// ============================================================================
// 第 161 批：dirInfo 底座 + checkBrowserMap（package_json.go:94，155 行）
// Resolve 链 browser 字段 remapping；消费第 160 批 packageJSON.browserMap 底座。
// ============================================================================
/** Go: browserPathKind (package_json.go:87) —— absolutePathKind=0 / packagePathKind=1 */
export const absolutePathKind = 0, packagePathKind = 1;

/** Go: type dirInfo (resolver.go:1126) —— 只落 checkBrowserMap 用到的字段 */
export class dirInfo {
  parent: dirInfo | null = null;
  enclosingBrowserScope: dirInfo | null = null;
  absPath = "";
  pnpManifestAbsPath = "";
  entries: DirEntries = new DirEntries();
  packageJSON: packageJSON | null = null;
  enclosingPackageJSON: packageJSON | null = null;
  enclosingTSConfigJSON: TSConfigJSON | null = null;
  absRealPath = "";
  isNodeModules = false;
  hasNodeModules = false;
  isInsideNodeModules = false;
}

/** checkBrowserMap 上下文：对应 Go resolverQuery 的相关字段 */
export interface BrowserContext {
  platform: number;
  extensionOrder: string[];
  fsObj: realFS;
  debugLogs: { addNote(s: string): void } | null;
}

/** Go: func (r resolverQuery) checkBrowserMap(resolveDirInfo, inputPath, kind) (*string, bool) (package_json.go:94) */
export function checkBrowserMap(r: BrowserContext, resolveDirInfo: dirInfo | null, inputPath: string, kind: number): { remapped: string | null; ok: boolean } {
  if (r.platform !== PlatformBrowser) return { remapped: null, ok: false };
  const dl = r.debugLogs;
  if (resolveDirInfo === null || resolveDirInfo.enclosingBrowserScope === null) {
    if (dl !== null) dl.addNote(`No "browser" map found in directory ${JSON.stringify(resolveDirInfo ? resolveDirInfo.absPath : "")}`);
    return { remapped: null, ok: false };
  }
  const scope = resolveDirInfo.enclosingBrowserScope;
  const pj = scope.packageJSON!;
  const browserMap = pj.browserMap ?? new Map<string, string | null>();
  let curInputPath = inputPath;

  const checkPath = (pathToCheck: string, includeImplicitExtensions: boolean): boolean => {
    if (dl !== null) dl.addNote(`Checking for ${JSON.stringify(pathToCheck)} in the "browser" map in ${JSON.stringify(pj.source.KeyPath.Text)}`);
    if (dl !== null) dl.addNote(`  Checking for ${JSON.stringify(pathToCheck)}`);
    if (browserMap.has(pathToCheck)) { curInputPath = pathToCheck; return true; }
    if (includeImplicitExtensions) {
      for (const ext of r.extensionOrder) {
        const extPath = pathToCheck + ext;
        if (dl !== null) dl.addNote(`  Checking for ${JSON.stringify(extPath)}`);
        if (browserMap.has(extPath)) { curInputPath = extPath; return true; }
      }
    }
    let indexPath = pathJoin(pathToCheck, "index");
    if (IsPackagePath(indexPath) && !IsPackagePath(pathToCheck)) indexPath = "./" + indexPath;
    if (dl !== null) dl.addNote(`  Checking for ${JSON.stringify(indexPath)}`);
    if (browserMap.has(indexPath)) { curInputPath = indexPath; return true; }
    if (includeImplicitExtensions) {
      for (const ext of r.extensionOrder) {
        const extPath = indexPath + ext;
        if (dl !== null) dl.addNote(`  Checking for ${JSON.stringify(extPath)}`);
        if (browserMap.has(extPath)) { curInputPath = extPath; return true; }
      }
    }
    return false;
  };

  // absolute path -> relative to browser map location
  if (kind === absolutePathKind) {
    const rel = r.fsObj.Rel(scope.absPath, curInputPath);
    if (!rel.ok) return { remapped: null, ok: false };
    curInputPath = rel.value.replace(/\\/g, "/");
  }
  if (curInputPath === ".") return { remapped: null, ok: false };

  let ok = checkPath(curInputPath, true);
  if (!ok && IsPackagePath(curInputPath)) {
    if (kind === absolutePathKind) {
      ok = checkPath("./" + curInputPath, true);
    } else if (kind === packagePathKind) {
      let isInSamePackage = true;
      for (let info: dirInfo | null = resolveDirInfo; info !== null && info !== scope; info = info.parent) {
        if (info.isNodeModules) { isInSamePackage = false; break; }
      }
      if (isInSamePackage) {
        let relativePathPrefix = "./";
        const rel = r.fsObj.Rel(scope.absPath, resolveDirInfo.absPath);
        if (rel.ok && rel.value !== ".") relativePathPrefix += rel.value.replace(/\\/g, "/") + "/";
        ok = checkPath(relativePathPrefix + curInputPath, false);
      }
    }
  }

  let remapped: string | null = null;
  if (browserMap.has(curInputPath)) remapped = browserMap.get(curInputPath) ?? null;
  // Go 返回的 remapped 是命中时的 *string；命中 disabled(nil) 时 ok=true 但 remapped=null。
  // 上面用 browserMap.has(curInputPath) 判定命中；curInputPath 在 checkPath 命中时被更新。
  if (dl !== null) {
    if (ok) {
      if (remapped === null) dl.addNote(`Found ${JSON.stringify(curInputPath)} marked as disabled`);
      else dl.addNote(`Found ${JSON.stringify(curInputPath)} mapping to ${JSON.stringify(remapped)}`);
    } else {
      dl.addNote(`Failed to find ${JSON.stringify(curInputPath)}`);
    }
  }
  return { remapped, ok };
}
