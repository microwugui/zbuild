// 第 88 批：22 个已移植 validate 助手的「一个整链大探针」逐字节证据。
// Go 探针 tools/go/tmpgen_api_validate_test.bak → testdata/api-validate-chain-go.json（93 行）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  validatePathTemplate, validatePlatform, validateFormat, validateSourceMap,
  validateLegalComments, validateColor, validateLogLevel, validateLogStyle,
  validateASCIIOnly, validateExternalPackages, validateTreeShaking, extractPathStyle,
  validateLoader, validateSupported, validateGlobalName, validateAlias,
  validateResolveExtensions, validateLoaders, validateJSXExpr, validateLogOverrides,
  validateOutputExtensions, validateBannerOrFooter,
  isValidExtension, prettyPrintByteCount, importKindToResolveKind, resolveKindToImportKind, stripDirPrefix,
  Platform, StderrColor, LogStyle, Charset, Packages,
} from "./api_impl.ts";
import { escapeForHTML } from "./serve_other.ts";

const raw = new Uint8Array(readFileSync(new URL("../../../testdata/api-validate-chain-go.json", import.meta.url)));
const SHA = "743e31d8590efd1df73bd97367eb7f49580758cf4aab0263e406147f584fde04";
const fx = JSON.parse(new TextDecoder().decode(raw)) as { rows: { name: string; data: any }[] };
const by = Object.fromEntries(fx.rows.map((r) => [r.name, r.data]));
const check = (name: string, got: any) => assert.deepStrictEqual(got, by[name], name);
const V = (v: number | boolean) => ({ v });
const sortedSS = (m: Map<string, string>) => [...m.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
const sortedSI = (m: Map<string, number>) => [...m.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0).map(([k, v]) => [k, String(v)]);
// Go 探针按字符串键排序（fmt.Sprint 后的 "12" < "6"）
const sortedII = (m: Map<number, number>) => [...m.entries()].sort((a, b) => String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0).map(([k, v]) => [String(k), String(v)]);

test("api-validate-chain 夹具 sha256（128 行）", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
});

test("validatePathTemplate 逐字节等于 Go（6 例）", () => {
  for (const [n, t] of [["empty", ""], ["name", "[name]"], ["chunk", "chunk-[name]-[hash]"],
                        ["dirext", "assets/[dir]/[name][ext]"], ["backslash", "a\\b/[name]"], ["literal", "out.js"]] as const) {
    check("validatePathTemplate:" + n, { parts: validatePathTemplate(t).map((p) => [p.Data, p.Placeholder]) });
  }
});

test("枚举 / 布尔 validate 助手逐字节等于 Go", () => {
  check("validatePlatform:default", V(validatePlatform(Platform.PlatformDefault)));
  check("validatePlatform:browser", V(validatePlatform(Platform.PlatformBrowser)));
  check("validatePlatform:node", V(validatePlatform(Platform.PlatformNode)));
  check("validatePlatform:neutral", V(validatePlatform(Platform.PlatformNeutral)));
  check("validateFormat:default", V(validateFormat(0)));
  check("validateFormat:iife", V(validateFormat(1)));
  check("validateFormat:cjs", V(validateFormat(2)));
  check("validateFormat:esm", V(validateFormat(3)));
  check("validateSourceMap:none", V(validateSourceMap(0)));
  check("validateSourceMap:inline", V(validateSourceMap(1)));
  check("validateSourceMap:linked", V(validateSourceMap(2)));
  check("validateSourceMap:external", V(validateSourceMap(3)));
  check("validateSourceMap:both", V(validateSourceMap(4)));
  check("validateLegalComments:default-bundle", V(validateLegalComments(0, true)));
  check("validateLegalComments:default-nobundle", V(validateLegalComments(0, false)));
  check("validateLegalComments:none", V(validateLegalComments(1, false)));
  check("validateLegalComments:inline", V(validateLegalComments(2, false)));
  check("validateLegalComments:eof", V(validateLegalComments(3, false)));
  check("validateLegalComments:linked", V(validateLegalComments(4, false)));
  check("validateLegalComments:external", V(validateLegalComments(5, false)));
  check("validateColor:ifterminal", V(validateColor(StderrColor.ColorIfTerminal)));
  check("validateColor:never", V(validateColor(StderrColor.ColorNever)));
  check("validateColor:always", V(validateColor(StderrColor.ColorAlways)));
  const llnames = ["silent", "verbose", "debug", "info", "warning", "error"];
  llnames.forEach((n, i) => check("validateLogLevel:" + n, V(validateLogLevel(i))));
  check("validateLogStyle:default", V(validateLogStyle(LogStyle.LogStyleDefault)));
  check("validateLogStyle:clang", V(validateLogStyle(LogStyle.LogStyleClang)));
  check("validateLogStyle:vs", V(validateLogStyle(LogStyle.LogStyleVisualStudio)));
  check("validateASCIIOnly:default", V(validateASCIIOnly(Charset.CharsetDefault)));
  check("validateASCIIOnly:ascii", V(validateASCIIOnly(Charset.CharsetASCII)));
  check("validateASCIIOnly:utf8", V(validateASCIIOnly(Charset.CharsetUTF8)));
  check("validateExternalPackages:default", V(validateExternalPackages(Packages.PackagesDefault)));
  check("validateExternalPackages:bundle", V(validateExternalPackages(Packages.PackagesBundle)));
  check("validateExternalPackages:external", V(validateExternalPackages(Packages.PackagesExternal)));
  check("validateTreeShaking:default-bundle", V(validateTreeShaking(0, true, 0)));
  check("validateTreeShaking:default-iife", V(validateTreeShaking(0, false, 1)));
  check("validateTreeShaking:default-esm", V(validateTreeShaking(0, false, 3)));
  check("validateTreeShaking:false", V(validateTreeShaking(1, true, 0)));
  check("validateTreeShaking:true", V(validateTreeShaking(2, false, 0)));
  check("extractPathStyle:code-on", V(extractPathStyle(1, 1)));
  check("extractPathStyle:code-off", V(extractPathStyle(0, 1)));
  check("extractPathStyle:log-on", V(extractPathStyle(2, 2)));
  check("extractPathStyle:log-off", V(extractPathStyle(1, 2)));
  for (let i = 0; i <= 16; i++) check("validateLoader:" + i, V(validateLoader(i)));
});

test("validateSupported 逐字节等于 Go（4 例）", () => {
  const cases: [string, [string, boolean][]][] = [
    ["empty", []],
    ["js", [["async-await", false], ["top-level-await", true]]],
    ["css", [["inline-style", false], ["color-functions", true]]],
    ["mixed", [["async-await", false], ["inline-style", false], ["bigint", true]]],
  ];
  for (const [n, entries] of cases) {
    const r = validateSupported(new Map(entries));
    check("validateSupported:" + n, { js: String(r.js), jsMask: String(r.jsMask), css: r.css, cssMask: r.cssMask });
  }
});

test("validateGlobalName 逐字节等于 Go（3 例）", () => {
  for (const [n, t] of [["empty", ""], ["simple", "Foo"], ["dotted", "Foo.Bar.Baz"]] as const) {
    const parts = validateGlobalName(t, "(global name)");
    check("validateGlobalName:" + n, { parts: parts.length ? parts : null });
  }
});

test("validateAlias 逐字节等于 Go（2 例）", () => {
  check("validateAlias:valid", { map: sortedSS(validateAlias(new Map([["foo", "bar"], ["@scope/pkg", "x"]]), (p) => p.startsWith("/"))) });
  check("validateAlias:mixed", { map: sortedSS(validateAlias(new Map([["ok/name", "v"], ["./bad", "v"], ["../bad", "v"], ["foo/", "v"], ["@scope/", "v"], ["", "v"]]), (p) => p.startsWith("/"))) });
});

test("validateResolveExtensions 逐字节等于 Go（2 例）", () => {
  check("validateResolveExtensions:nil", { list: validateResolveExtensions(null, () => {}) });
  check("validateResolveExtensions:custom", { list: validateResolveExtensions([".tsx", ".js", ".css"], () => {}) });
});

test("validateLoaders 逐字节等于 Go（2 例）", () => {
  check("validateLoaders:empty", { map: sortedSI(validateLoaders(new Map())) });
  check("validateLoaders:custom", { map: sortedSI(validateLoaders(new Map([[".foo", 10], [".bar", 16], ["", 14]]))) });
});

test("validateJSXExpr 逐字节等于 Go（4 例）", () => {
  for (const [n, t, w] of [["empty", "", "factory"], ["factory", "React.createElement", "factory"],
                           ["fragment-null", "null", "fragment"], ["member", "Preact.h", "factory"]] as const) {
    const r = validateJSXExpr(t, w);
    check("validateJSXExpr:" + n, { parts: r.parts.length ? r.parts : null, constant: r.constant });
  }
});

test("validateLogOverrides 逐字节等于 Go（2 例）", () => {
  check("validateLogOverrides:empty", { map: sortedII(validateLogOverrides(new Map())) });
  check("validateLogOverrides:valid", { map: sortedII(validateLogOverrides(new Map([["bigint", 5], ["direct-eval", 4]]))) });
});

test("validateOutputExtensions / validateBannerOrFooter 逐字节等于 Go（4 例）", () => {
  check("validateOutputExtensions:both", validateOutputExtensions(new Map([[".js", ".mjs"], [".css", ".css2"]])));
  check("validateOutputExtensions:js-only", validateOutputExtensions(new Map([[".js", ".cjs"]])));
  check("validateBannerOrFooter:banner", validateBannerOrFooter(new Map([["js", "// hi"], ["css", "/* hi */"]])));
  check("validateBannerOrFooter:footer", validateBannerOrFooter(new Map([["js", "// bye"]])));
});

test("补充纯助手逐字节等于 Go（isValidExtension / byteCount / kind / escape / stripDir）", () => {
  for (const [n, ext] of [["ok", ".ts"], ["dotonly", "."], ["trailing", "foo."], ["empty", ""]] as const)
    check("isValidExtension:" + n, V(isValidExtension(ext)));
  for (const n of [0, 512, 1024, 1536, 1048576, 1572864, 1073741824])
    check("prettyPrintByteCount:" + n, { v: prettyPrintByteCount(n) });
  for (let i = 0; i <= 7; i++) {
    check("importKindToResolveKind:" + i, V(importKindToResolveKind(i)));
    check("resolveKindToImportKind:" + (i + 1), V(resolveKindToImportKind(i + 1)));
  }
  for (const [n, text] of [["amp", "a&b<c>d"], ["plain", "plain"], ["script", "<script>"]] as const)
    check("escapeForHTML:" + n, { v: escapeForHTML(text) });
  for (const [n, path, prefix, slashes] of [
    ["nofix", "foo/bar", "", "/"], ["exact", "/foo", "/foo", "/"],
    ["slash", "/foo/bar", "/", "/"], ["win", "C:\\foo", "C:\\", "\\/"],
    ["mismatch", "foo/bar", "bar", "/"],
  ] as const) {
    const r = stripDirPrefix(path, prefix, slashes);
    check("stripDirPrefix:" + n, { value: r.value, ok: r.ok });
  }
});
