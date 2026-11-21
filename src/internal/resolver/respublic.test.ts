// 第 175 批：Resolve / ResolveGlob / ProbeResolvePackageAsRelative / TSConfigJSX.ApplyTo
// Go 探针 23 例逐字节固化。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NewDeferLog, DeferLogKind, PathFlags } from "../logger/logger.ts";
import { MockFS, MockUnix } from "../fs/fs_mock.ts";
import { DirEntry } from "../fs/fs.ts";
import { ImportKind } from "../ast/ast.ts";
import { ResolveResult, DebugMeta, Resolve, ResolveGlob, ProbeResolvePackageAsRelative } from "./resolver.ts";
import { TSConfigJSX } from "../config/config.ts";
import { MsgID_Bundler_EmptyGlob } from "../logger/msg_ids.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/respublic-go.json", import.meta.url)));
const SHA = "c828880d098de69546c55a8d7311f8bf2a3c75dedd1997dd7af2e402287191e9";

const tree: Record<string, string> = {
  "/proj/package.json": `{"name":"root"}`,
  "/proj/src/a.js": "",
  "/proj/src/style.css": "",
  "/proj/node_modules/dep/package.json": `{"name":"dep","main":"main.js"}`,
  "/proj/node_modules/dep/main.js": "",
};

function dumpPair(text: string, namespace: string, flags: number, secondary: string | null, external: boolean): any {
  return [[text, namespace, flags, ""], secondary ? [secondary, "file", 0, ""] : null, external];
}
function dumpResult(r: ResolveResult | null): any {
  if (r === null) return null;
  const pp = r.PathPair;
  return [dumpPair(pp.Primary.Text, pp.Primary.Namespace, pp.Primary.Flags, pp.HasSecondary() ? pp.Secondary.Text : null, pp.IsExternal),
    r.PrimarySideEffectsData && r.PrimarySideEffectsData.Source ? r.PrimarySideEffectsData.Source.KeyPath.Text : null,
    r.ModuleTypeData.Type];
}

function makeCtx() {
  const notes: string[] = [];
  const log = NewDeferLog(DeferLogKind.DeferLogAll, null);
  const fsobj = MockFS({ ...tree }, MockUnix, "/");
  const diCtx: any = {
    fsObj: fsobj, log,
    debugLogs: { what: "", indent: "", addNote(s: string) { this.notes.push(this.indent !== "" ? this.indent + s : s); }, increaseIndent() { this.indent += "  "; }, decreaseIndent() { this.indent = this.indent.slice(2); }, notes },
    platform: 1, mainFields: ["main"], preserveSymlinks: false, dirCache: new Map(),
    pnpManifestWasChecked: true,
    readFile: (path: string) => { const c = (tree as any)[path]; return c === undefined ? { contents: "", err: "no such file or directory" } : { contents: c, err: null }; },
  };
  const ctx: any = {
    fsObj: fsobj, log,
    debugLogs: { what: "", indent: "", addNote(s: string) { this.notes.push(this.indent !== "" ? this.indent + s : s); }, increaseIndent() { this.indent += "  "; }, decreaseIndent() { this.indent = this.indent.slice(2); }, notes },
    platform: 1, extensionOrder: [".js"], dirInfoCtx: diCtx, mainFields: ["main"],
    nodeModulesExtensionOrder: [], cssExtensionOrder: [], debugMeta: new DebugMeta(), kind: ImportKind.ImportStmt,
    esmConditionsDefault: { default: true, node: true },
    esmConditionsImport: { default: true, node: true, import: true },
    esmConditionsRequire: { default: true, node: true, require: true },
    externalExact: {}, externalPatterns: [], externalPackages: false, absNodePaths: [],
    pnpManifest: null, tsConfigOverride: null, packageAliases: null, preserveSymlinks: false,
    format: 0, feat: 0n, cwd: "/",
  };
  return { ctx, notes };
}

test("respublic fixture sha256 + 23 例逐字节等于 Go（resolver 顶层入口）", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    const a = r.arg;
    let got: any;
    if (r.fn === "Resolve") {
      const { ctx } = makeCtx();
      if (a.name === "external") ctx.externalExact = { "ext-pkg": true };
      if (a.name === "alias") ctx.packageAliases = { alias: "dep" };
      const out = Resolve(ctx, a.sourceDir, a.importPath, a.kind);
      got = [dumpResult(out.result), [out.debugMeta.ModifiedImportPath, out.debugMeta.notes.length]];
    } else if (r.fn === "ResolveGlob") {
      const { ctx } = makeCtx();
      // pattern from fixture name (mirror Go cases)
      const pats: Record<string, any[]> = {
        simple: [{ Prefix: "./a", Wildcard: 1 }, { Prefix: ".js", Wildcard: 0 }],
        exact: [{ Prefix: "./a.js", Wildcard: 0 }],
        empty: [],
        "no-match": [{ Prefix: "./zzz", Wildcard: 1 }, { Prefix: ".js", Wildcard: 0 }],
        "non-relative": [{ Prefix: "dep/", Wildcard: 1 }],
      };
      const out = ResolveGlob(ctx, a.sourceDir, pats[a.name], ImportKind.ImportStmt, a.pretty ?? a.name);
      const keys = [...out.results.keys()].sort();
      const warn = out.warning === null ? null : [out.warning.ID, out.warning.Kind, out.warning.Text];
      got = [keys.map((k) => [k, dumpResult(out.results.get(k)!)]), warn];
    } else if (r.fn === "ProbeResolvePackageAsRelative") {
      const { ctx } = makeCtx();
      const imp = a.name === "hit" ? "a.js" : "nope.js";
      const out = ProbeResolvePackageAsRelative(ctx, "/proj/src", imp, ImportKind.ImportStmt);
      got = [dumpResult(out.result), [out.debugMeta.ModifiedImportPath, out.debugMeta.notes.length]];
    } else if (r.fn === "ApplyTo") {
      const jsxMap: Record<string, number> = { none: 0, preserve: 1, react: 3, "react-jsx": 4, reactjsdevx: 5, "react-jsxdev": 5, factory: 3 };
      const tj = new TSConfigJSX();
      tj.JSX = jsxMap[a.name];
      if (a.name === "factory") { tj.JSXFactory = ["h"]; tj.JSXFragmentFactory = ["Fragment"]; tj.JSXImportSource = "preact"; }
      const jo: any = { AutomaticRuntime: a.name === "react" || a.name === "factory" ? true : true, Development: true,
        Factory: ["React", "createElement"], Fragment: ["React", "Fragment"], ImportSource: "react" };
      // 与 Go 探针初值对齐：react-jsxdev 初值 false/false，factory 初值 false/false，其余 true/true
      if (a.name === "react-jsxdev" || a.name === "factory") { jo.AutomaticRuntime = false; jo.Development = false; }
      tj.ApplyTo(jo);
      got = [jo.AutomaticRuntime, jo.Development, jo.Factory, jo.Fragment, jo.ImportSource];
    } else {
      throw new Error(`unknown fn ${r.fn}`);
    }
    assert.deepEqual(got, r.out, `${r.fn}/${a.name}\n got ${JSON.stringify(got)}\nwant ${JSON.stringify(r.out)}`);
  }
});
