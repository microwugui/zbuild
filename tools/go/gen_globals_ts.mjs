import fs from 'node:fs';
const fx = JSON.parse(fs.readFileSync('/root/port/testdata/process-defines-go.json','utf8'));
const tableLines = fx.table.map(p => '  ' + JSON.stringify(p.split('.')) + ',').join('\n');
const header = `// 1:1 移植自 esbuild internal/config/globals.go（v0.28.2，commit f6058f83）。第 139 批底座；第 84 轮补 knownGlobals 全表 + ProcessDefines。
// knownGlobals 表与 ProcessDefines 输出真值由 Go 探针固化在 testdata/process-defines-go.json（SHA c7df0a45…）。
import * as js_ast from "../js_ast/js_ast.ts";

/** Go: DefineFlags (globals.go:932) */
export const DefineFlags = {
  CanBeRemovedIfUnused: 1,
  CallCanBeUnwrappedIfUnused: 2,
  MethodCallsMustBeReplacedWithUndefined: 4,
  IsSymbolInstance: 8,
} as const;

/** Go: knownGlobals (globals.go:29) — 807 项，Go 探针逐项固化 */
export const knownGlobals: string[][] = [
`;
const body = `
];

/** Go: DefineExpr (globals.go:920) */
export interface DefineExprData {
  Constant: any;
  Parts: string[];
}

/** Go: DefineData (globals.go:926) — 完整字段（ProcessDefines 产出） */
export interface FullDefineData {
  KeyParts: string[];
  DefineExpr: DefineExprData | null;
  Flags: number;
}

/** Go: ProcessedDefines (globals.go:965) */
export interface ProcessedDefines {
  IdentifierDefines: Map<string, FullDefineData>;
  DotDefines: Map<string, FullDefineData[]>;
}

/** Go: DefineDataLike（兼容 config.ts 对 mergeDefineData 的既有调用） */
export interface DefineDataLike { Flags: number; KeyParts: string[]; [k: string]: any; }

/** Go: func (flags DefineFlags) Has(flag DefineFlags) bool (globals.go:956) */
export function Has(flags: number, flag: number): boolean { return (flags & flag) !== 0; }

/** Go: func mergeDefineData(old, new DefineData) DefineData (globals.go:960) */
export function mergeDefineData(old: DefineDataLike, next: DefineDataLike): DefineDataLike {
  next.Flags |= old.Flags;
  return next;
}

function mergeFull(old: FullDefineData | undefined, next: FullDefineData): FullDefineData {
  if (old === undefined) return { KeyParts: next.KeyParts.slice(), DefineExpr: next.DefineExpr, Flags: next.Flags };
  return { KeyParts: next.KeyParts.slice(), DefineExpr: next.DefineExpr, Flags: next.Flags | old.Flags };
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Go: func ProcessDefines(userDefines []DefineData) ProcessedDefines (globals.go:975) */
export function ProcessDefines(userDefines: FullDefineData[]): ProcessedDefines {
  const result: ProcessedDefines = { IdentifierDefines: new Map(), DotDefines: new Map() };
  for (const parts of knownGlobals) {
    const tail = parts[parts.length - 1];
    if (parts.length === 1) {
      result.IdentifierDefines.set(tail, { KeyParts: [], DefineExpr: null, Flags: DefineFlags.CanBeRemovedIfUnused });
    } else {
      let flags = DefineFlags.CanBeRemovedIfUnused;
      if (parts[0] === "Symbol") flags |= DefineFlags.IsSymbolInstance;
      let arr = result.DotDefines.get(tail);
      if (arr === undefined) { arr = []; result.DotDefines.set(tail, arr); }
      arr.push({ KeyParts: parts, DefineExpr: null, Flags: flags });
    }
  }
  result.IdentifierDefines.set("undefined", { KeyParts: [], DefineExpr: { Constant: js_ast.EUndefinedShared, Parts: [] }, Flags: 0 });
  result.IdentifierDefines.set("NaN", { KeyParts: [], DefineExpr: { Constant: new js_ast.ENumber(NaN), Parts: [] }, Flags: 0 });
  result.IdentifierDefines.set("Infinity", { KeyParts: [], DefineExpr: { Constant: new js_ast.ENumber(Infinity), Parts: [] }, Flags: 0 });
  for (const data of userDefines) {
    if (data.KeyParts.length === 1) {
      const name = data.KeyParts[0];
      result.IdentifierDefines.set(name, mergeFull(result.IdentifierDefines.get(name), data));
      continue;
    }
    const tail = data.KeyParts[data.KeyParts.length - 1];
    let arr = result.DotDefines.get(tail);
    if (arr === undefined) { arr = []; result.DotDefines.set(tail, arr); }
    let found = false;
    for (let i = 0; i < arr.length; i++) {
      if (arraysEqual(data.KeyParts, arr[i].KeyParts)) {
        arr[i] = mergeFull(arr[i], data);
        found = true;
        break;
      }
    }
    if (!found) arr.push({ KeyParts: data.KeyParts.slice(), DefineExpr: data.DefineExpr, Flags: data.Flags });
  }
  return result;
}
`;
fs.writeFileSync('/root/port/src/internal/config/globals.ts.new', header + tableLines + body);
console.log('wrote globals.ts.new lines=', (header+tableLines+body).split('\n').length);
