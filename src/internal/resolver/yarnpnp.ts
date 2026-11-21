// 1:1 移植自 esbuild internal/resolver/yarnpnp.go（v0.28.2，commit f6058f83）
// 第 44 轮 M2/M4 成片推进：纯助手。
import * as js_ast from "../js_ast/js_ast.ts";
import { UTF16ToString } from "../helpers/utf.ts";
import { Source, Range, Loc, LineColumnTracker, MakeLineColumnTracker, Path, AddError } from "../logger/logger.ts";
import { getProperty, getString, getBool, MakePrettyPaths } from "./resolver.ts";
import { ParseJSON, JSONOptions } from "../js_parser/json_parser.ts";
import { Parse, OptionsForYarnPnP } from "../js_parser/js_parser.ts";
import { realFS } from "../fs/fs_real.ts";

/** Go: pnpStatus (yarnpnp.go:131) —— Go 探针实测值 */
export const pnpStatus = {
  pnpErrorGeneric: 0,
  pnpErrorDependencyNotFound: 1,
  pnpErrorUnfulfilledPeerDependency: 2,
  pnpSuccess: 3,
  pnpSkipped: 4,
} as const;

/** Go: func (status pnpStatus) isError() bool (yarnpnp.go:131) */
export function isError(status: number): boolean {
  return status < pnpStatus.pnpSuccess;
}

/** Go: func getStringOrNull(json js_ast.Expr) (string, bool) (yarnpnp.go:585) */
export function getStringOrNull(json: js_ast.Expr): { value: string; ok: boolean } {
  if (json.Data instanceof js_ast.EString) {
    return { value: new TextDecoder().decode(UTF16ToString((json.Data as js_ast.EString).Value)), ok: true };
  }
  if (json.Data instanceof js_ast.ENull) return { value: "", ok: true };
  return { value: "", ok: false };
}

/** Go: func quoteOrNullIfEmpty(str string) string (yarnpnp.go:419) */
export function quoteOrNullIfEmpty(str: string): string {
  if (str !== "") return JSON.stringify(str);
  return "null";
}


/** Go: func parseBareIdentifier(specifier string) (ident string, modulePath string, ok bool) (yarnpnp.go:85) */
export function parseBareIdentifier(specifier: string): { ident: string; modulePath: string; ok: boolean } {
  let ident = "", modulePath = "", ok = false;
  const slash = specifier.indexOf("/");
  if (specifier.startsWith("@")) {
    if (slash === -1) return { ident, modulePath, ok };
    const slash2 = specifier.slice(slash + 1).indexOf("/");
    ident = slash2 !== -1 ? specifier.slice(0, slash + 1 + slash2) : specifier;
  } else {
    ident = slash !== -1 ? specifier.slice(0, slash) : specifier;
  }
  modulePath = specifier.slice(ident.length);
  ok = true;
  return { ident, modulePath, ok };
}

// ============================================================================
// 第 141 批：yarnpnp 纯助手（getDependencyTarget / getPackage / resolveViaFallback / findLocator）
// ============================================================================
/** Go: type pnpIdentAndReference (yarnpnp.go:67) */
export class pnpIdentAndReference { ident = ""; reference = ""; span: any = null; }

/** Go: func getDependencyTarget (yarnpnp.go:597) */
export function getDependencyTarget(json: js_ast.Expr): { ok: boolean; ident: string; reference: string; span: any } {
  const d = json.Data;
  if (d instanceof js_ast.ENull) {
    const v = new pnpIdentAndReference(); v.span = { Loc: { Start: json.Loc.Start }, Len: 4 };
    return { ok: true, ident: v.ident, reference: v.reference, span: v.span };
  }
  if (d instanceof js_ast.EString) {
    const v = new pnpIdentAndReference(); v.reference = new TextDecoder().decode(UTF16ToString((d as js_ast.EString).Value));
    v.span = { Loc: { Start: json.Loc.Start }, Len: 0 };
    return { ok: true, ident: v.ident, reference: v.reference, span: v.span };
  }
  if (d instanceof js_ast.EArray) {
    const items = (d as js_ast.EArray).Items;
    if (items.length === 2) {
      const n = items[0].Data instanceof js_ast.EString ? new TextDecoder().decode(UTF16ToString((items[0].Data as js_ast.EString).Value)) : null;
      const r = items[1].Data instanceof js_ast.EString ? new TextDecoder().decode(UTF16ToString((items[1].Data as js_ast.EString).Value)) : null;
      if (n !== null && r !== null) {
        const v = new pnpIdentAndReference(); v.ident = n; v.reference = r;
        v.span = { Loc: { Start: json.Loc.Start }, Len: (d as js_ast.EArray).CloseBracketLoc.Start + 1 - json.Loc.Start };
        return { ok: true, ident: v.ident, reference: v.reference, span: v.span };
      }
    }
  }
  const v = new pnpIdentAndReference(); v.span = { Loc: { Start: 0 }, Len: 0 };
  return { ok: false, ident: "", reference: "", span: v.span };
}

/** Go: type pnpPackage (yarnpnp.go:74) */
export class PnpPackage {
  packageDependencies: Record<string, pnpIdentAndReference> = {};
  packageLocation = "";
  packageDependenciesRange = new Range();
  discardFromLookup = false;
}

/** Go: type pnpData (yarnpnp.go:17) —— 第 162 批补齐全字段 */
export class PnpData {
  fallbackExclusionList: Record<string, Record<string, boolean>> | null = null;
  fallbackPool: Record<string, pnpIdentAndReference> | null = null;
  ignorePatternData: RegExp | null = null;
  invalidIgnorePatternData = "";
  packageRegistryData: Record<string, Record<string, PnpPackage>> | null = null;
  packageLocatorsByLocations: Record<string, { locator: pnpIdentAndReference; discardFromLookup: boolean }> | null = null;
  enableTopLevelFallback = false;
  tracker: LineColumnTracker | null = null;
  absPath = "";
  absDirPath = "";
}

/** Go: func (r resolverQuery) getPackage (yarnpnp.go:402) */
export function getPackage(manifest: PnpData, ident: string, reference: string): { ok: boolean; pkg: PnpPackage } {
  const inner = manifest.packageRegistryData ? manifest.packageRegistryData[ident] : undefined;
  if (inner) { const pkg = inner[reference]; if (pkg) return { ok: true, pkg }; }
  return { ok: false, pkg: new PnpPackage() };
}

/** Go: func (r resolverQuery) resolveViaFallback (yarnpnp.go:365) */
export function resolveViaFallback(manifest: PnpData, ident: string): { ok: boolean; ident: string; reference: string } {
  const top = getPackage(manifest, "", "");
  if (!top.ok) return { ok: false, ident: "", reference: "" };
  const dep = top.pkg.packageDependencies[ident];
  if (dep) return { ok: true, ident: dep.ident, reference: dep.reference };
  const fb = manifest.fallbackPool ? manifest.fallbackPool[ident] : undefined;
  if (fb) return { ok: true, ident: fb.ident, reference: fb.reference };
  return { ok: false, ident: "", reference: "" };
}

/** Go: func (r resolverQuery) findLocator (yarnpnp.go:312) */
export function findLocator(manifest: PnpData, moduleUrl: string, fsRel: (from: string, to: string) => { ok: boolean; value: string }): { ok: boolean; ident: string; reference: string } {
  const rel0 = fsRel(manifest.absDirPath, moduleUrl);
  if (!rel0.ok) return { ok: false, ident: "", reference: "" };
  let rel = rel0.value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!rel.endsWith("/")) rel += "/";
  if (!rel.startsWith("./") && !rel.startsWith("../")) rel = "./" + rel;
  for (;;) {
    const entry = manifest.packageLocatorsByLocations ? manifest.packageLocatorsByLocations[rel] : undefined;
    if (!entry || entry.discardFromLookup) {
      const cut = rel.slice(0, rel.length - 1).lastIndexOf("/");
      rel = rel.slice(0, cut + 1);
      if (rel === "") break;
      continue;
    }
    return { ok: true, ident: entry.locator.ident, reference: entry.locator.reference };
  }
  return { ok: false, ident: "", reference: "" };
}

// ============================================================================
// 第 162 批：compileYarnPnPData + resolveToUnqualified（Resolve 链 Yarn PnP 路径解析核心）
// 一次搭厚 pnpData 底座后正面攻 resolveToUnqualified。
// ============================================================================
/** Go: func compileYarnPnPData(absPath, absDirPath, json, source) *pnpData (yarnpnp.go:426) */
export function compileYarnPnPData(absPath: string, absDirPath: string, json: js_ast.Expr, source: Source): PnpData {
  const data = new PnpData();
  data.absPath = absPath;
  data.absDirPath = absDirPath;
  data.tracker = MakeLineColumnTracker(source);

  // enableTopLevelFallback
  {
    const p = getProperty(json, "enableTopLevelFallback");
    if (p.ok) { const g = getBool(p.value); if (g.ok) data.enableTopLevelFallback = g.value; }
  }

  // fallbackExclusionList: [[ident, [ref,...]], ...]
  {
    const p = getProperty(json, "fallbackExclusionList");
    if (p.ok && p.value.Data instanceof js_ast.EArray) {
      data.fallbackExclusionList = {};
      for (const item of (p.value.Data as js_ast.EArray).Items) {
        if (item.Data instanceof js_ast.EArray) {
          const t = (item.Data as js_ast.EArray).Items;
          if (t.length === 2) {
            const idG = getStringOrNull(t[0]);
            if (idG.ok && t[1].Data instanceof js_ast.EArray) {
              const refs: Record<string, boolean> = {};
              for (const it2 of (t[1].Data as js_ast.EArray).Items) { const r = getString(it2); if (r.ok) refs[r.value] = true; }
              data.fallbackExclusionList[idG.value] = refs;
            }
          }
        }
      }
    }
  }

  // fallbackPool: [[ident, target], ...]
  {
    const p = getProperty(json, "fallbackPool");
    if (p.ok && p.value.Data instanceof js_ast.EArray) {
      data.fallbackPool = {};
      for (const item of (p.value.Data as js_ast.EArray).Items) {
        if (item.Data instanceof js_ast.EArray) {
          const t = (item.Data as js_ast.EArray).Items;
          if (t.length === 2) {
            const idG = getString(t[0]);
            if (idG.ok) {
              const dt = getDependencyTarget(t[1]);
              if (dt.ok) { const v = new pnpIdentAndReference(); v.ident = dt.ident; v.reference = dt.reference; v.span = dt.span; data.fallbackPool[idG.value] = v; }
            }
          }
        }
      }
    }
  }

  // ignorePatternData: strip Go-unsupported negated lookaheads, then compile
  {
    const p = getProperty(json, "ignorePatternData");
    if (p.ok) {
      const g = getString(p.value);
      if (g.ok) {
        let pat = g.value;
        pat = pat.split(`(?!\\.)`).join("");
        pat = pat.split(`(?!(?:^|\\/)\\.)`).join("");
        pat = pat.split(`(?!\\.{1,2}(?:\\/|$))`).join("");
        pat = pat.split(`(?!(?:^|\\/)\\.{1,2}(?:\\/|$))`).join("");
        try { data.ignorePatternData = new RegExp(pat); }
        catch (e) { data.invalidIgnorePatternData = pat; }
      }
    }
  }

  // packageRegistryData
  {
    const p = getProperty(json, "packageRegistryData");
    if (p.ok && p.value.Data instanceof js_ast.EArray) {
      data.packageRegistryData = {};
      data.packageLocatorsByLocations = {};
      for (const item of (p.value.Data as js_ast.EArray).Items) {
        if (item.Data instanceof js_ast.EArray) {
          const tuple = (item.Data as js_ast.EArray).Items;
          if (tuple.length === 2) {
            const pIdent = getStringOrNull(tuple[0]);
            if (pIdent.ok && tuple[1].Data instanceof js_ast.EArray) {
              const refs: Record<string, PnpPackage> = {};
              data.packageRegistryData[pIdent.value] = refs;
              for (const it2 of (tuple[1].Data as js_ast.EArray).Items) {
                if (it2.Data instanceof js_ast.EArray) {
                  const tuple2 = (it2.Data as js_ast.EArray).Items;
                  if (tuple2.length === 2) {
                    const pRef = getStringOrNull(tuple2[0]);
                    if (pRef.ok) {
                      const pkg = tuple2[1];
                      const locP = getProperty(pkg, "packageLocation");
                      const depsP = getProperty(pkg, "packageDependencies");
                      if (locP.ok && depsP.ok) {
                        const locG = getString(locP.value);
                        if (locG.ok && depsP.value.Data instanceof js_ast.EArray) {
                          const arr3 = depsP.value.Data as js_ast.EArray;
                          const deps: Record<string, pnpIdentAndReference> = {};
                          let discard = false;
                          for (const dep of arr3.Items) {
                            if (dep.Data instanceof js_ast.EArray) {
                              const arr4 = (dep.Data as js_ast.EArray).Items;
                              if (arr4.length === 2) {
                                const idG = getString(arr4[0]);
                                if (idG.ok) {
                                  const dt = getDependencyTarget(arr4[1]);
                                  if (dt.ok) { const v = new pnpIdentAndReference(); v.ident = dt.ident; v.reference = dt.reference; v.span = dt.span; deps[idG.value] = v; }
                                }
                              }
                            }
                          }
                          const discardP = getProperty(pkg, "discardFromLookup");
                          if (discardP.ok) { const bG = getBool(discardP.value); if (bG.ok) discard = bG.value; }
                          const pnpPkg = new PnpPackage();
                          pnpPkg.packageLocation = locG.value;
                          pnpPkg.packageDependencies = deps;
                          pnpPkg.packageDependenciesRange = new Range(new Loc(depsP.value.Loc.Start), arr3.CloseBracketLoc.Start + 1 - depsP.value.Loc.Start);
                          pnpPkg.discardFromLookup = discard;
                          refs[pRef.value] = pnpPkg;

                          const loc = locG.value;
                          const existing = data.packageLocatorsByLocations[loc];
                          if (!existing) {
                            const v = new pnpIdentAndReference(); v.ident = pIdent.value; v.reference = pRef.value;
                            data.packageLocatorsByLocations[loc] = { locator: v, discardFromLookup: discard };
                          } else {
                            existing.discardFromLookup = existing.discardFromLookup && discard;
                            if (!discard) { const v = new pnpIdentAndReference(); v.ident = pIdent.value; v.reference = pRef.value; existing.locator = v; }
                            data.packageLocatorsByLocations[loc] = existing;
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  return data;
}

/** pnpResult (yarnpnp.go:105) */
export class pnpResult {
  status = 0;
  pkgDirPath = "";
  pkgIdent = "";
  pkgSubpath = "";
  errorIdent = "";
  errorRange = new Range();
}

/** Go: func (r resolverQuery) resolveToUnqualified(specifier, parentURL, manifest) pnpResult (yarnpnp.go:450) */
export function resolveToUnqualified(
  specifier: string, parentURL: string, manifest: PnpData,
  fsRel: (from: string, to: string) => { ok: boolean; value: string },
  debugLogs: { addNote(s: string): void } | null = null,
): pnpResult {
  if (debugLogs !== null) {
    debugLogs.addNote(`Using Yarn PnP manifest from ${JSON.stringify(manifest.absPath)}`);
    debugLogs.addNote(`  Resolving ${JSON.stringify(specifier)} in ${JSON.stringify(parentURL)}`);
  }
  const bare = parseBareIdentifier(specifier);
  if (!bare.ok) {
    if (debugLogs !== null) debugLogs.addNote(`  Failed to parse specifier ${JSON.stringify(specifier)} into a bare identifier`);
    const rr = new pnpResult(); rr.status = pnpStatus.pnpErrorGeneric; return rr;
  }
  if (debugLogs !== null) debugLogs.addNote(`  Parsed bare identifier ${JSON.stringify(bare.ident)} and module path ${JSON.stringify(bare.modulePath)}`);

  const parentLocator = findLocator(manifest, parentURL, fsRel);
  if (!parentLocator.ok) { const rr = new pnpResult(); rr.status = pnpStatus.pnpSkipped; return rr; }
  if (debugLogs !== null) debugLogs.addNote(`  Found parent locator: [${quoteOrNullIfEmpty(parentLocator.ident)}, ${quoteOrNullIfEmpty(parentLocator.reference)}]`);

  const parentPkg = getPackage(manifest, parentLocator.ident, parentLocator.reference);
  if (!parentPkg.ok) { const rr = new pnpResult(); rr.status = pnpStatus.pnpErrorGeneric; return rr; }
  if (debugLogs !== null) debugLogs.addNote(`  Found parent package at ${JSON.stringify(parentPkg.pkg.packageLocation)}`);

  let referenceOrAlias = parentPkg.pkg.packageDependencies[bare.ident];
  // Go 用两个独立状态：ok=key 存在；reference=="" 表示 peer 依赖（含 null 与缺失 peer）。
  // 不能合并——否则 peer 依赖会错走 dependencyNotFound 分支、errorRange 取错来源。
  let found = !!referenceOrAlias;
  if (!found || referenceOrAlias.reference === "") {
    if (debugLogs !== null) debugLogs.addNote(`  Failed to find ${JSON.stringify(bare.ident)} in "packageDependencies" of parent package`);
    if (manifest.enableTopLevelFallback) {
      if (debugLogs !== null) debugLogs.addNote(`  Searching for a fallback because "enableTopLevelFallback" is true`);
      const exSet = manifest.fallbackExclusionList ? manifest.fallbackExclusionList[parentLocator.ident] : undefined;
      const excluded = !!(exSet && exSet[parentLocator.reference]);
      if (!excluded) {
        const fb = resolveViaFallback(manifest, bare.ident);
        if (fb.reference !== "") {
          const v = new pnpIdentAndReference(); v.ident = fb.ident; v.reference = fb.reference; v.span = new Range();
          referenceOrAlias = v; found = true;
        }
      } else if (debugLogs !== null) {
        debugLogs.addNote(`    Stopping because [${quoteOrNullIfEmpty(parentLocator.ident)}, ${quoteOrNullIfEmpty(parentLocator.reference)}] is in "fallbackExclusionList"`);
      }
    }
  }

  if (!found) {
    const rr = new pnpResult(); rr.status = pnpStatus.pnpErrorDependencyNotFound; rr.errorIdent = bare.ident; rr.errorRange = parentPkg.pkg.packageDependenciesRange; return rr;
  }
  if (referenceOrAlias.reference === "") {
    const rr = new pnpResult(); rr.status = pnpStatus.pnpErrorUnfulfilledPeerDependency; rr.errorIdent = bare.ident; rr.errorRange = referenceOrAlias.span; return rr;
  }

  if (debugLogs !== null) {
    let s: string;
    if (referenceOrAlias.ident !== "") s = `[${JSON.stringify(referenceOrAlias.ident)}, ${JSON.stringify(referenceOrAlias.reference)}]`;
    else s = quoteOrNullIfEmpty(referenceOrAlias.reference);
    debugLogs.addNote(`  Found dependency locator: [${quoteOrNullIfEmpty(bare.ident)}, ${s}]`);
  }

  let dependencyPkg: PnpPackage;
  if (referenceOrAlias.ident !== "") {
    const got = getPackage(manifest, referenceOrAlias.ident, referenceOrAlias.reference);
    if (!got.ok) { const rr = new pnpResult(); rr.status = pnpStatus.pnpErrorGeneric; return rr; }
    dependencyPkg = got.pkg;
  } else {
    const got = getPackage(manifest, bare.ident, referenceOrAlias.reference);
    if (!got.ok) { const rr = new pnpResult(); rr.status = pnpStatus.pnpErrorGeneric; return rr; }
    dependencyPkg = got.pkg;
  }
  if (debugLogs !== null) debugLogs.addNote(`  Found package ${JSON.stringify(bare.ident)} at ${JSON.stringify(dependencyPkg.packageLocation)}`);

  let absDirPath = manifest.absDirPath;
  const isWindows = !absDirPath.startsWith("/");
  if (isWindows) absDirPath = "/" + absDirPath.replace(/\\/g, "/");
  let pkgDirPath = pathJoin(absDirPath, dependencyPkg.packageLocation);
  if (isWindows && pkgDirPath.startsWith("/")) pkgDirPath = pkgDirPath.slice(1).replace(/\\/g, "//");
  if (debugLogs !== null) debugLogs.addNote(`  Resolved ${JSON.stringify(specifier)} via Yarn PnP to ${JSON.stringify(pkgDirPath)} with subpath ${JSON.stringify(bare.modulePath)}`);

  const rr = new pnpResult();
  rr.status = pnpStatus.pnpSuccess; rr.pkgDirPath = pkgDirPath; rr.pkgIdent = bare.ident; rr.pkgSubpath = bare.modulePath;
  return rr;
}

// ============================================================================
// 第 164 批：extractYarnPnPDataFromJSON（PnP manifest 加载，resolveToUnqualified 搭档）
// ============================================================================
/** Go: pnpDataMode (yarnpnp.go:632) */
export const pnpIgnoreErrorsAboutMissingFiles = 0, pnpReportErrorsAboutMissingFiles = 1;

/** extractYarnPnPDataFromJSON 上下文：对应 Go resolverQuery 的相关字段 */
export interface ExtractPnpContext {
  fsObj: realFS;
  log: any;
  debugLogs: { addNote(s: string): void } | null;
  readFile: (path: string) => { contents: string; err: string | null };
}

/** Go: func (r resolverQuery) extractYarnPnPDataFromJSON(pnpDataPath, mode) (js_ast.Expr, logger.Source) (yarnpnp.go:637) */
export function extractYarnPnPDataFromJSON(
  r: ExtractPnpContext, pnpDataPath: string, mode: number,
): { result: js_ast.Expr | null; source: Source } {
  const rf = r.readFile(pnpDataPath);
  if (r.debugLogs !== null && rf.err !== null) {
    r.debugLogs.addNote(`Failed to read file ${JSON.stringify(pnpDataPath)}: ${rf.err}`);
  }
  if (rf.err !== null) {
    if (mode === pnpReportErrorsAboutMissingFiles || rf.err !== "no such file or directory") {
      const pp = MakePrettyPaths(r.fsObj, pnpDataPath, "file", "", false);
      AddError(r.log, null, new Range(), `Cannot read file ${JSON.stringify(pp.Rel)}: ${rf.err}`);
    }
    return { result: null, source: new Source() };
  }
  if (r.debugLogs !== null) r.debugLogs.addNote(`The file ${JSON.stringify(pnpDataPath)} exists`);
  const keyPath = new Path(); keyPath.Text = pnpDataPath; keyPath.Namespace = "file";
  const source = new Source();
  source.KeyPath = keyPath;
  source.Contents = new TextEncoder().encode(rf.contents);
  const parsed = ParseJSON(r.log, source, new JSONOptions());
  return { result: parsed.expr, source };
}

// ============================================================================
// 第 172 批：tryToExtractYarnPnPDataFromJS（PnP JS 拦截主入口，底座落地后正面攻）
// ============================================================================
/**
 * Go: func (r resolverQuery) tryToExtractYarnPnPDataFromJS(pnpDataPath string, mode pnpDataMode) (js_ast.Expr, logger.Source) (yarnpnp.go:655)
 *
 * DEVIATION：Go 经 r.caches.JSCache.Parse（内部 NewDeferLog(log.Overrides) + 重放）解析；
 * TS 无 JSCache，直接调用 js_parser.Parse(log, source, OptionsForYarnPnP())。
 * 首次解析（cache miss）语义一致；r.log 本身即 DeferLog 时消息收集完全一致。
 * 复用 ExtractPnpContext（fsObj/log/debugLogs/readFile 四字段与 JSON 版相同）。
 */
export function tryToExtractYarnPnPDataFromJS(
  r: ExtractPnpContext, pnpDataPath: string, mode: number,
): { result: js_ast.Expr | null; source: Source } {
  const rf = r.readFile(pnpDataPath);
  if (r.debugLogs !== null && rf.err !== null) {
    r.debugLogs.addNote(`Failed to read file ${JSON.stringify(pnpDataPath)}: ${rf.err}`);
  }
  if (rf.err !== null) {
    if (mode === pnpReportErrorsAboutMissingFiles || rf.err !== "no such file or directory") {
      const pp = MakePrettyPaths(r.fsObj, pnpDataPath, "file", "", false);
      AddError(r.log, null, new Range(), `Cannot read file ${JSON.stringify(pp.Rel)}: ${rf.err}`);
    }
    return { result: null, source: new Source() };
  }
  if (r.debugLogs !== null) r.debugLogs.addNote(`The file ${JSON.stringify(pnpDataPath)} exists`);

  const keyPath = new Path(); keyPath.Text = pnpDataPath; keyPath.Namespace = "file";
  const source = new Source();
  source.KeyPath = keyPath;
  source.Contents = new TextEncoder().encode(rf.contents);
  const parsed = Parse(r.log, source, OptionsForYarnPnP());
  const manifest = parsed.ast.ManifestForYarnPnP;
  if (r.debugLogs !== null && manifest !== null && manifest.Data !== null) {
    r.debugLogs.addNote(`  Extracted JSON data from ${JSON.stringify(pnpDataPath)}`);
  }
  return { result: manifest, source };
}

/** Go path.Join (forward slashes, clean dots) */
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
