// 1:1 移植自 esbuild internal/resolver/tsconfig_json.go（v0.28.2）。第 123 批 Go 探针 40 例。
import { Log, MsgKind, LineColumnTracker, AddID, Source, Loc, Range } from "../logger/logger.ts";
import { MsgID_TSConfigJSON_InvalidJSX, MsgID_TSConfigJSON_InvalidPaths, MsgID_TSConfigJSON_InvalidTarget, MsgID_TSConfigJSON_InvalidImportsNotUsedAsValues, MsgID_TSConfigJSON_InvalidTopLevelOption } from "../logger/msg_ids.ts";
import { IsIdentifier } from "../js_ast/js_ident.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import { ParseJSON, JSONOptions } from "../js_parser/json_parser.ts";
import { JSONFlavor, RangeOfIdentifier } from "../js_lexer/js_lexer.ts";
import { IsInsideNodeModules } from "../helpers/path.ts";
import { UTF16ToString } from "../helpers/utf.ts";
import { getProperty, getString, getBool } from "./resolver.ts";
import { TSConfigJSX, TSConfig, TSJSX, TSTarget, TSImportsNotUsedAsValues, MaybeBool } from "../config/config.ts";

/** Go: func isSlash(c byte) bool (tsconfig_json.go:433) */
export function isSlash(c: number): boolean { return c === 47 /* '/' */ || c === 92 /* '\\' */; }

/** Go: func getSubstitutedPathWithConfigDirTemplate(fs fs.FS, value, basePath string) string (tsconfig_json.go:395) */
export function getSubstitutedPathWithConfigDirTemplate(value: string, basePath: string): string {
  if (value.startsWith("${configDir}")) {
    const rest = value.slice(12).replace(/^(?:\.\/|\/)+/, "");
    const joined = basePath.replace(/\/+$/, "") + "/" + rest;
    return joined.replace(/\/+$/, "") || "/";
  }
  return value;
}

/** Go: func parseMemberExpressionForJSX(log, source, tracker, loc, text) []string (tsconfig_json.go:402) */
export function parseMemberExpressionForJSX(
  log: Log, source: Source, tracker: LineColumnTracker, loc: number, text: string,
): string[] | null {
  if (text === "") return null;
  const parts = text.split(".");
  const enc = new TextEncoder();
  for (const part of parts) {
    if (!IsIdentifier(enc.encode(part))) {
      AddID(log, MsgID_TSConfigJSON_InvalidJSX, MsgKind.Warning, tracker, source.RangeOfString(new Loc(loc)),
        `Invalid JSX member expression: ${JSON.stringify(text)}`);
      return null;
    }
  }
  return parts;
}

/** Go: func isValidTSConfigPathPattern(text string, log, source, tracker, loc) bool (tsconfig_json.go:417) */
export function isValidTSConfigPathPattern(
  text: string, log: Log, source: Source, tracker: LineColumnTracker, loc: number,
): boolean {
  let foundAsterisk = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "*") {
      if (foundAsterisk) {
        AddID(log, MsgID_TSConfigJSON_InvalidPaths, MsgKind.Warning, tracker, source.RangeOfString(new Loc(loc)),
          `Invalid pattern ${JSON.stringify(text)}, must have at most one "*" character`);
        return false;
      }
      foundAsterisk = true;
    }
  }
  return true;
}

/** Go: func isValidTSConfigPathNoBaseURLPattern(text, log, source, tracker **LineColumnTracker, loc) bool (tsconfig_json.go:437) */
export function isValidTSConfigPathNoBaseURLPattern(
  text: string, log: Log, source: Source, holder: { tracker: LineColumnTracker | null }, loc: number,
): boolean {
  const code = (i: number): number => i < text.length ? text.charCodeAt(i) : 0;
  const c0 = code(0), c1 = code(1), c2 = code(2), n = text.length;
  if (c0 === 46 /* '.' */ && (n === 1 || (n === 2 && c1 === 46))) return true;
  if (c0 === 46 && (isSlash(c1) || (c1 === 46 && isSlash(c2)))) return true;
  if (isSlash(c0)) return true;
  if (((c0 >= 97 && c0 <= 122) || (c0 >= 65 && c0 <= 90)) && c1 === 58 && isSlash(c2)) return true;
  if (holder.tracker === null) holder.tracker = loggerExports.MakeLineColumnTracker(source);
  AddID(log, MsgID_TSConfigJSON_InvalidPaths, MsgKind.Warning, holder.tracker, source.RangeOfString(new Loc(loc)),
    `Non-relative path ${JSON.stringify(text)} is not allowed when "baseUrl" is not set (did you forget a leading "./"?)`);
  return false;
}
import * as loggerExports from "../logger/logger.ts";
import { realFS } from "../fs/fs_real.ts";

// ============================================================================
// 第 141 批：TSConfigJSON helpers（applyExtendedConfig / TSAlwaysStrictOrStrict）
// ============================================================================
/** Go: type TSAlwaysStrict (config.go:576) —— 第 159 批补齐 Source/Range（错误信息用） */
export class TSAlwaysStrict {
  Name = "";
  Source: Source = new Source();
  Range = new Range();
  Value = false;
  constructor(v = false) { this.Value = v; }
}

/** Go: type tsTargetKey (tsconfig_json.go:75) —— Range 保持宽松以兼容旧测试的 plain-object 赋值 */
export class tsTargetKey { LowerValue = ""; Source: Source | null = null; Range: any = new Range(); }

/** Go: type TSConfigPath (tsconfig_json.go:79) */
export class TSConfigPath { Text = ""; Loc = new Loc(0); constructor(text = "", loc = 0) { this.Text = text; this.Loc = new Loc(loc); } }

/** Go: type TSConfigPaths (tsconfig_json.go:84) */
export class TSConfigPaths {
  Map = new Map<string, TSConfigPath[]>();
  Source: Source = new Source();
}

/** Go: type TSConfigJSON (tsconfig_json.go:15) —— 只落本批助手用到的字段 */
export class TSConfigJSON {
  AbsPath = "";
  BaseURL: string | null = null;
  BaseURLForPaths = "";
  tsTargetKey = new tsTargetKey();
  TSStrict: TSAlwaysStrict | null = null;
  TSAlwaysStrict: TSAlwaysStrict | null = null;
  JSXSettings: TSConfigJSX = new TSConfigJSX();
  Settings: TSConfig = new TSConfig();

  /** Go: func (derived *TSConfigJSON) applyExtendedConfig (tsconfig_json.go:45) */
  applyExtendedConfig(base: TSConfigJSON): void {
    if (base.tsTargetKey.Range.Len > 0) this.tsTargetKey = base.tsTargetKey;
    if (base.TSStrict != null) this.TSStrict = base.TSStrict;
    if (base.TSAlwaysStrict != null) this.TSAlwaysStrict = base.TSAlwaysStrict;
    if (base.BaseURL != null) this.BaseURL = base.BaseURL;
    if (base.Paths != null) { this.Paths = base.Paths; this.BaseURLForPaths = base.BaseURLForPaths; }
    this.JSXSettings.ApplyExtendedConfig(base.JSXSettings);
    this.Settings.ApplyExtendedConfig(base.Settings);
  }
  Paths: TSConfigPaths | null = null;

  /** Go: func (config *TSConfigJSON) TSAlwaysStrictOrStrict (tsconfig_json.go:66) */
  TSAlwaysStrictOrStrict(): TSAlwaysStrict | null {
    if (this.TSAlwaysStrict != null) return this.TSAlwaysStrict;
    return this.TSStrict;
  }
}

// ============================================================================
// 第 159 批：ParseTSConfigJSON（tsconfig_json.go:350，297 行）—— Resolve 链 tsconfig 解析核心
// Go 签名含 cache.JSONCache/fs.FS；TS 无 JSONCache（ParseJSON 直接等价），fs 用 realFS。
// ============================================================================
/** Go: func ParseTSConfigJSON(log, source, jsonCache, fs, fileDir, configDir, extends) *TSConfigJSON (tsconfig_json.go:350) */
export function ParseTSConfigJSON(
  log: Log,
  source: Source,
  fsobj: realFS,
  fileDir: string,
  configDir: string,
  ext: ((path: string, range: Range) => TSConfigJSON | null) | null,
): TSConfigJSON | null {
  const opts = new JSONOptions();
  opts.Flavor = JSONFlavor.TSConfigJSON;
  const parsed = ParseJSON(log, source, opts);
  const json = parsed.expr;
  if (!parsed.ok) return null;

  const result = new TSConfigJSON();
  result.AbsPath = source.KeyPath.Text;
  const tracker = loggerExports.MakeLineColumnTracker(source);

  // extends
  if (ext !== null) {
    const e = getProperty(json, "extends");
    if (e.ok) {
      const valueG = getString(e.value);
      if (valueG.ok) {
        const base = ext(valueG.value, source.RangeOfString(new Loc(e.loc)));
        if (base !== null) result.applyExtendedConfig(base);
      } else if (e.value.Data instanceof js_ast.EArray) {
        for (const item of (e.value.Data as js_ast.EArray).Items) {
          const s = getString(item);
          if (s.ok) {
            const base = ext(s.value, source.RangeOfString(new Loc(item.Loc.Start)));
            if (base !== null) result.applyExtendedConfig(base);
          }
        }
      }
    }
  }

  // compilerOptions
  const co = getProperty(json, "compilerOptions");
  if (co.ok) {
    const cjson = co.value;

    // baseUrl
    {
      const p = getProperty(cjson, "baseUrl");
      if (p.ok) {
        const g = getString(p.value);
        if (g.ok) {
          let value = getSubstitutedPathWithConfigDirTemplate(g.value, configDir);
          if (!fsobj.IsAbs(value)) value = fsobj.Join([fileDir, value]);
          result.BaseURL = value;
        }
      }
    }

    // jsx
    {
      const p = getProperty(cjson, "jsx");
      if (p.ok) {
        const g = getString(p.value);
        if (g.ok) {
          switch (g.value.toLowerCase()) {
            case "preserve": result.JSXSettings.JSX = TSJSX.TSJSXPreserve; break;
            case "react-native": result.JSXSettings.JSX = TSJSX.TSJSXReactNative; break;
            case "react": result.JSXSettings.JSX = TSJSX.TSJSXReact; break;
            case "react-jsx": result.JSXSettings.JSX = TSJSX.TSJSXReactJSX; break;
            case "react-jsxdev": result.JSXSettings.JSX = TSJSX.TSJSXReactJSXDev; break;
          }
        }
      }
    }

    // jsxFactory
    {
      const p = getProperty(cjson, "jsxFactory");
      if (p.ok) {
        const g = getString(p.value);
        if (g.ok) result.JSXSettings.JSXFactory = parseMemberExpressionForJSX(log, source, tracker, p.value.Loc.Start, g.value);
      }
    }

    // jsxFragmentFactory
    {
      const p = getProperty(cjson, "jsxFragmentFactory");
      if (p.ok) {
        const g = getString(p.value);
        if (g.ok) result.JSXSettings.JSXFragmentFactory = parseMemberExpressionForJSX(log, source, tracker, p.value.Loc.Start, g.value);
      }
    }

    // jsxImportSource
    {
      const p = getProperty(cjson, "jsxImportSource");
      if (p.ok) {
        const g = getString(p.value);
        if (g.ok) result.JSXSettings.JSXImportSource = g.value;
      }
    }

    // experimentalDecorators
    {
      const p = getProperty(cjson, "experimentalDecorators");
      if (p.ok) {
        const g = getBool(p.value);
        if (g.ok) result.Settings.ExperimentalDecorators = g.value ? MaybeBool.True : MaybeBool.False;
      }
    }

    // useDefineForClassFields
    {
      const p = getProperty(cjson, "useDefineForClassFields");
      if (p.ok) {
        const g = getBool(p.value);
        if (g.ok) result.Settings.UseDefineForClassFields = g.value ? MaybeBool.True : MaybeBool.False;
      }
    }

    // target
    {
      const p = getProperty(cjson, "target");
      if (p.ok) {
        const g = getString(p.value);
        if (g.ok) {
          const lower = g.value.toLowerCase();
          let ok = true;
          switch (lower) {
            case "es3": case "es5": case "es6": case "es2015": case "es2016": case "es2017":
            case "es2018": case "es2019": case "es2020": case "es2021":
              result.Settings.Target = TSTarget.TSTargetBelowES2022; break;
            case "es2022": case "es2023": case "es2024": case "es2025": case "es2026": case "esnext":
              result.Settings.Target = TSTarget.TSTargetAtOrAboveES2022; break;
            default:
              ok = false;
              if (!IsInsideNodeModules(source.KeyPath.Text)) {
                AddID(log, MsgID_TSConfigJSON_InvalidTarget, MsgKind.Warning, tracker, source.RangeOfString(new Loc(p.value.Loc.Start)),
                  `Unrecognized target environment ${JSON.stringify(g.value)}`);
              }
          }
          if (ok) {
            result.tsTargetKey = new tsTargetKey();
            result.tsTargetKey.Source = source;
            result.tsTargetKey.Range = source.RangeOfString(new Loc(p.loc));
            result.tsTargetKey.LowerValue = lower;
          }
        }
      }
    }

    // strict
    {
      const p = getProperty(cjson, "strict");
      if (p.ok) {
        const g = getBool(p.value);
        if (g.ok) {
          const vr = RangeOfIdentifier(source, new Loc(p.value.Loc.Start));
          const a = new TSAlwaysStrict(g.value);
          a.Name = "strict";
          a.Source = source;
          a.Range = new Range(new Loc(p.loc), vr.End() - p.loc);
          result.TSStrict = a;
        }
      }
    }

    // alwaysStrict
    {
      const p = getProperty(cjson, "alwaysStrict");
      if (p.ok) {
        const g = getBool(p.value);
        if (g.ok) {
          const vr = RangeOfIdentifier(source, new Loc(p.value.Loc.Start));
          const a = new TSAlwaysStrict(g.value);
          a.Name = "alwaysStrict";
          a.Source = source;
          a.Range = new Range(new Loc(p.loc), vr.End() - p.loc);
          result.TSAlwaysStrict = a;
        }
      }
    }

    // importsNotUsedAsValues
    {
      const p = getProperty(cjson, "importsNotUsedAsValues");
      if (p.ok) {
        const g = getString(p.value);
        if (g.ok) {
          switch (g.value) {
            case "remove": result.Settings.ImportsNotUsedAsValues = TSImportsNotUsedAsValues.TSImportsNotUsedAsValues_Remove; break;
            case "preserve": result.Settings.ImportsNotUsedAsValues = TSImportsNotUsedAsValues.TSImportsNotUsedAsValues_Preserve; break;
            case "error": result.Settings.ImportsNotUsedAsValues = TSImportsNotUsedAsValues.TSImportsNotUsedAsValues_Error; break;
            default:
              AddID(log, MsgID_TSConfigJSON_InvalidImportsNotUsedAsValues, MsgKind.Warning, tracker, source.RangeOfString(new Loc(p.value.Loc.Start)),
                `Invalid value ${JSON.stringify(g.value)} for "importsNotUsedAsValues"`);
          }
        }
      }
    }

    // preserveValueImports
    {
      const p = getProperty(cjson, "preserveValueImports");
      if (p.ok) {
        const g = getBool(p.value);
        if (g.ok) result.Settings.PreserveValueImports = g.value ? MaybeBool.True : MaybeBool.False;
      }
    }

    // verbatimModuleSyntax
    {
      const p = getProperty(cjson, "verbatimModuleSyntax");
      if (p.ok) {
        const g = getBool(p.value);
        if (g.ok) result.Settings.VerbatimModuleSyntax = g.value ? MaybeBool.True : MaybeBool.False;
      }
    }

    // paths
    {
      const p = getProperty(cjson, "paths");
      if (p.ok) {
        if (p.value.Data instanceof js_ast.EObject) {
          result.BaseURLForPaths = fileDir;
          result.Paths = new TSConfigPaths();
          result.Paths.Source = source;
          for (const prop of (p.value.Data as js_ast.EObject).Properties) {
            const keyG = getString(prop.Key);
            if (keyG.ok) {
              if (!isValidTSConfigPathPattern(keyG.value, log, source, tracker, prop.Key.Loc.Start)) continue;
              const pv = prop.ValueOrNil ?? new js_ast.Expr();
              if (pv.Data instanceof js_ast.EArray) {
                for (const item of (pv.Data as js_ast.EArray).Items) {
                  const s = getString(item);
                  if (s.ok) {
                    if (isValidTSConfigPathPattern(s.value, log, source, tracker, item.Loc.Start)) {
                      const text = getSubstitutedPathWithConfigDirTemplate(s.value, configDir);
                      const arr = result.Paths.Map.get(keyG.value) ?? [];
                      arr.push(new TSConfigPath(text, item.Loc.Start));
                      result.Paths.Map.set(keyG.value, arr);
                    }
                  }
                }
              } else {
                AddID(log, MsgID_TSConfigJSON_InvalidPaths, MsgKind.Warning, tracker, source.RangeOfString(new Loc(pv.Loc.Start)),
                  `Substitutions for pattern ${JSON.stringify(keyG.value)} should be an array`);
              }
            }
          }
        }
      }
    }
  }

  // Warn about compiler options not wrapped in "compilerOptions"
  if (json.Data instanceof js_ast.EObject) {
    const topKeys = new Set([
      "alwaysStrict", "baseUrl", "experimentalDecorators", "importsNotUsedAsValues", "jsx",
      "jsxFactory", "jsxFragmentFactory", "jsxImportSource", "paths", "preserveValueImports",
      "strict", "target", "useDefineForClassFields", "verbatimModuleSyntax",
    ]);
    outer: for (const prop of (json.Data as js_ast.EObject).Properties) {
      const key = prop.Key.Data;
      if (key instanceof js_ast.EString && (key as js_ast.EString).Value != null) {
        const k = new TextDecoder().decode(UTF16ToString((key as js_ast.EString).Value));
        if (topKeys.has(k)) {
          AddID(log, MsgID_TSConfigJSON_InvalidTopLevelOption, MsgKind.Warning, tracker, source.RangeOfString(new Loc(prop.Key.Loc.Start)),
            `Expected the ${JSON.stringify(k)} option to be nested inside a "compilerOptions" object`);
          break outer;
        }
      }
    }
  }

  return result;
}
