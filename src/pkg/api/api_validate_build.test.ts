// 第 89 批：validateBuildOptions 本体整函数逐字节证据。
// Go 探针 tools/go/tmpgen_vbo_test.bak → testdata/vbo-go.json（7 行 config.Options 全字段）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { validateBuildOptions, type BuildOptionsInput } from "./api_impl.ts";
import { MockFS, MockUnix } from "../../internal/fs/fs_mock.ts";
import { NewDeferLog, DeferLogKind } from "../../internal/logger/logger.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/vbo-go.json", import.meta.url)));
const SHA = "2a5f65149ab4d6e1433813163160b98b3fc760a1f6e775edc09f3e81e67dd9b5";
const fx = JSON.parse(new TextDecoder().decode(raw)) as { rows: { name: string; data: any }[] };
const by = Object.fromEntries(fx.rows.map((r) => [r.name, r.data]));

// ---- Go dumpVBO 的 TS 镜像 ----
const vboExpr = (e: any): string => {
  if (e === null || e === undefined) return "empty";
  if (e.Constant !== null && e.Constant !== undefined) return "const";
  if (e.constant === true) return "const";
  const parts = e.Parts ?? e.parts;
  if (parts && parts.length > 0) return "parts:" + parts.join(".");
  return "empty";
};
const vboTmpl = (ts: any[]): string => ts.map((t) => `${t.Data}:${t.Placeholder};`).join("");
const sortedKV = (m: Map<string, string> | Map<string, number>): string[][] =>
  [...m.entries()].map(([k, v]) => [k, String(v)]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
const sortedNum = (m: Map<number, number>): string[][] =>
  [...m.entries()].map(([k, v]) => [String(k), String(v)]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

function vboDefines(d: any): any {
  if (!d) return {};
  const ids: Record<string, string> = {};
  for (const [k, v] of d.IdentifierDefines as Map<string, any>) {
    ids[k] = v.KeyParts.join(".") + "|" + v.Flags + "|" + vboExpr(v.DefineExpr);
  }
  const dots: Record<string, string[]> = {};
  for (const [tail, arr] of d.DotDefines as Map<string, any[]>) {
    dots[tail] = arr.map((v) => v.KeyParts.join(".") + "|" + v.Flags + "|" + vboExpr(v.DefineExpr)).sort();
  }
  return { ids, dots };
}

function dumpVBO(o: any, eps: any[], log: any): any {
  const pre: string[] = [];
  for (const [k, v] of o.ExternalSettings.PreResolve.Exact as Map<string, boolean>) if (v) pre.push(k);
  pre.sort();
  const post: string[] = [];
  for (const [k, v] of o.ExternalSettings.PostResolve.Exact as Map<string, boolean>) if (v) post.push(k);
  post.sort();
  const entryPts = eps.map((ep) => [ep.InputPath, ep.OutputPath]);
  const inj = (o.InjectedDefines ?? []).map((d: any) => d.Name + ":" + d.SourceContents);
  const mp = o.MangleProps ? o.MangleProps.source : "";
  const rp = o.ReserveProps ? o.ReserveProps.source : "";
  const stdin = o.Stdin === null || o.Stdin === undefined ? null : {
    loader: o.Stdin.Loader, contents: o.Stdin.Contents, source: o.Stdin.SourceFile, dir: o.Stdin.AbsResolveDir,
  };
  const errors = log.Peek().map((m: any) => m.Data.Text);
  const arrOrNull = (x: any) => (x === undefined || x === null ? null : x);
  return {
    jsFeat: String(o.UnsupportedJSFeatures), cssFeat: o.UnsupportedCSSFeatures,
    jsOv: String(o.UnsupportedJSFeatureOverrides), jsMask: String(o.UnsupportedJSFeatureOverridesMask),
    cssOv: o.UnsupportedCSSFeatureOverrides, cssMask: o.UnsupportedCSSFeatureOverridesMask,
    targetEnv: o.OriginalTargetEnv, platform: o.Platform, format: o.OutputFormat, mode: o.Mode,
    sourceMap: o.SourceMap, legalComments: o.LegalComments,
    jsx: {
      preserve: o.JSX.Preserve, auto: o.JSX.AutomaticRuntime, dev: o.JSX.Development,
      import: o.JSX.ImportSource, sideEffects: o.JSX.SideEffects,
      factory: vboExpr(o.JSX.Factory), fragment: vboExpr(o.JSX.Fragment),
    },
    defines: vboDefines(o.Defines), injected: inj,
    minWhitespace: o.MinifyWhitespace, minIdents: o.MinifyIdentifiers, minSyntax: o.MinifySyntax,
    lineLimit: o.LineLimit, dropLabels: o.DropLabels, dropDebugger: o.DropDebugger,
    mangleProps: mp, reserveProps: rp, mangleQuoted: o.MangleQuoted,
    asciiOnly: o.ASCIIOnly, treeShaking: o.TreeShaking, keepNames: o.KeepNames, ignoreDCE: o.IgnoreDCEAnnotations,
    globalName: o.GlobalName.length ? o.GlobalName : null, codeSplitting: o.CodeSplitting,
    outfile: o.AbsOutputFile, outdir: o.AbsOutputDir, outbase: o.AbsOutputBase,
    writeStdout: !!o.WriteToStdout, allowOverwrite: o.AllowOverwrite,
    entryT: vboTmpl(o.EntryPathTemplate), chunkT: vboTmpl(o.ChunkPathTemplate), assetT: vboTmpl(o.AssetPathTemplate),
    outJS: o.OutputExtensionJS, outCSS: o.OutputExtensionCSS, loaders: sortedKV(o.ExtensionToLoader),
    extOrder: o.ExtensionOrder, mainFields: arrOrNull(o.MainFields), conditions: arrOrNull(o.Conditions), absNodePaths: o.AbsNodePaths,
    extPre: pre, extPost: post, extPackages: o.ExternalPackages, aliases: sortedKV(o.PackageAliases),
    tsconfig: o.TSConfigPath, tsconfigRaw: o.TSConfigRaw, publicPath: o.PublicPath, injectPaths: o.InjectPaths,
    codeStyle: o.CodePathStyle, logStyle: o.LogPathStyle, metaStyle: o.MetafilePathStyle,
    jsBanner: o.JSBanner, jsFooter: o.JSFooter, cssBanner: o.CSSBanner, cssFooter: o.CSSFooter,
    preserveSymlinks: o.PreserveSymlinks, sourceRoot: o.SourceRoot, excludeSources: o.ExcludeSourcesContent,
    needsMetafile: o.NeedsMetafile, prefixes: sortedNum(o.CSSPrefixData), stdin,
    entryPoints: entryPts, errors,
  };
}

const realFS = MockFS({}, MockUnix, "/home/user/project");
const cases: Record<string, BuildOptionsInput> = {
  empty: { Write: false },
  "bundle-basic": {
    Bundle: true, Write: true, EntryPoints: ["src/index.js"], Outdir: "dist", Target: 8,
    MinifyWhitespace: true, MinifyIdentifiers: true, MinifySyntax: true, Define: new Map([["NODE_ENV", '"production"']]),
  },
  "node-outfile": { Write: true, Platform: 2, Outfile: "out.js", Bundle: true, EntryPoints: ["a.js"] },
  "neutral-splitting": { Write: true, Platform: 3, Splitting: true, Outdir: "dist", Format: 3, Bundle: true, EntryPoints: ["a.js"] },
  errors: { Write: true, EntryPoints: ["a.js", "b.js"], External: ["foo"], Splitting: true },
  "jsx-stdin": {
    Write: true, JSX: 2, JSXFactory: "React.createElement", JSXFragment: "React.Fragment",
    Stdin: { Contents: "let x=1", Loader: 15, Sourcefile: "in.ts", ResolveDir: "src" },
    Supported: new Map([["async-await", false]]),
  },
  full: {
    Write: true, Bundle: true, EntryPoints: ["a.js"], Outdir: "dist", Outbase: "src", Format: 3,
    Target: 6, Charset: 1, TreeShaking: 2, GlobalName: "MyLib",
    Banner: new Map([["js", "// hi"]]), Footer: new Map([["css", "/* f */"]]),
    OutExtension: new Map([[".js", ".mjs"]]), EntryNames: "[dir]/[name]", ChunkNames: "chunks/[name]",
    PublicPath: "https://cdn/", Conditions: ["browser"], MainFields: ["module", "main"],
    NodePaths: ["node_modules"], Inject: ["react"], Pure: ["Object.assign"], DropLabels: ["DEV"],
    MangleProps: "^_", KeepNames: true, LegalComments: 1, Sourcemap: 2,
  },
};

test("vbo 夹具 sha256（7 行 config.Options 全字段）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("validateBuildOptions 整函数逐字节等于 Go（7 例）", () => {
  for (const [name, opts] of Object.entries(cases)) {
    const log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, null);
    const { options, entryPoints } = validateBuildOptions(opts, log, realFS);
    assert.deepStrictEqual(dumpVBO(options, entryPoints, log), by[name], "validateBuildOptions:" + name);
  }
});
