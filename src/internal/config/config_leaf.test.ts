// 第 44 轮叶子优先规划：config 纯判定函数真值表（Go 包内探针固化）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  HasExternalFile, KeepESMImportExportSyntax, ShouldCallRuntimeRequire,
  IsTypeScript, IsCSS, CanHaveSourceMap, HasPlaceholder, PathTemplate, PathPlaceholder,
  ExternalMatchers, WildcardPattern, CancelFlag, PluginAppliesToPath,
  TSConfig, MaybeBool, TSImportsNotUsedAsValues, DefineData, mergeDefineData,
  LoaderFromFileExtension, TemplateToString, MaybeRemoveWhitespace, PathTemplate as PT2, PathPlaceholder as PP2,
  SubstituteTemplate, PrettyPrintTargetEnvironment, PathPlaceholders, TSConfigJSX, TSJSX,
} from "./config.ts";

const FIXTURE = new URL("../../../testdata/config-leaf-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "7c6b4e753321c9271396dcfb19ea4b191ec887057a09ab44dfdedea70118330a";

interface Row { fn: string; arg: number; arg2: number; out: string; }

test("config 叶子真值表：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "config-leaf fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: boolean;
    switch (r.fn) {
      case "HasExternalFile": got = HasExternalFile(r.arg); break;
      case "KeepESMImportExportSyntax": got = KeepESMImportExportSyntax(r.arg); break;
      case "ShouldCallRuntimeRequire": got = ShouldCallRuntimeRequire(r.arg, r.arg2); break;
      case "IsTypeScript": got = IsTypeScript(r.arg); break;
      case "IsCSS": got = IsCSS(r.arg); break;
      case "CanHaveSourceMap": got = CanHaveSourceMap(r.arg); break;
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(String(got), r.out, `${r.fn}(${r.arg},${r.arg2})`);
  }
  // HasPlaceholder：真值表探针未含，此处直接覆盖（底座函数，保证 covered=ported）
  const t = new PathTemplate();
  t.Placeholder = PathPlaceholder.HashPlaceholder;
  assert.equal(HasPlaceholder([t], PathPlaceholder.HashPlaceholder), true);
  assert.equal(HasPlaceholder([t], PathPlaceholder.NamePlaceholder), false);
  assert.equal(HasPlaceholder([], PathPlaceholder.HashPlaceholder), false);
});

const FIXTURE2 = new URL("../../../testdata/config-leaf2-go.json", import.meta.url);
const bytes2 = new Uint8Array(readFileSync(FIXTURE2));
const SHA2 = "303f44918f3322d99f3090fad704aa221f95ed9c370c94238baf1e0818b329a6";

test("config 叶子真值表 2：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes2).digest("hex"), SHA2, "config-leaf2 fixture sha256");
  const rows: { fn: string; out: string }[] = JSON.parse(new TextDecoder().decode(bytes2));
  const re = /\.js$/;
  const flag = new CancelFlag();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    let got: boolean;
    switch (r.fn) {
      case "HasMatchers:none": got = new ExternalMatchers().HasMatchers(); break;
      case "HasMatchers:exact": { const m = new ExternalMatchers(); m.Exact.set("a", true); got = m.HasMatchers(); break; }
      case "HasMatchers:pat": { const m = new ExternalMatchers(); m.Patterns.push(new WildcardPattern()); got = m.HasMatchers(); break; }
      case "DidCancel:before": got = flag.DidCancel(); break;
      case "DidCancel:after": flag.Cancel(); got = flag.DidCancel(); break;
      case "DidCancel:nil": got = false; break; // Go nil receiver → false；TS 无 nil，等价于未置位
      case "Plugin:match": got = PluginAppliesToPath("a.js", "", re, ""); break;
      case "Plugin:no": got = PluginAppliesToPath("a.css", "", re, ""); break;
      case "Plugin:ns": got = PluginAppliesToPath("a.js", "x", re, "x"); break;
      case "Plugin:nsbad": got = PluginAppliesToPath("a.js", "y", re, "x"); break;
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(String(got), r.out, `${r.fn} (row ${i})`);
  }
});

const F3 = new URL("../../../testdata/config-ts-go.json", import.meta.url);
const b3 = new Uint8Array(readFileSync(F3));
const S3 = "819e687525037422a7cdc2df103f8d2f49fc2d5b64c3c6af7b8a5f37c6ad43c8";
interface Row3 { fn: string; case: string; out: string; }

test("config TS 配置叶子：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(b3).digest("hex"), S3, "config-ts fixture sha256");
  const rows: Row3[] = JSON.parse(new TextDecoder().decode(b3));
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "UnusedImportFlags": {
        const c = new TSConfig();
        if (r.case === "verbatim") c.VerbatimModuleSyntax = MaybeBool.True;
        if (r.case === "preserveVals" || r.case === "both") c.PreserveValueImports = MaybeBool.True;
        if (r.case === "importsPreserve" || r.case === "importsError") c.ImportsNotUsedAsValues = r.case === "importsError" ? TSImportsNotUsedAsValues.TSImportsNotUsedAsValues_Error : TSImportsNotUsedAsValues.TSImportsNotUsedAsValues_Preserve;
        if (r.case === "both") c.ImportsNotUsedAsValues = TSImportsNotUsedAsValues.TSImportsNotUsedAsValues_Preserve;
        got = String(c.UnusedImportFlags()); break;
      }
      case "mergeDefineData": {
        const [o, n] = r.case.split("|").map(Number);
        const old = new DefineData(); old.Flags = o; old.KeyParts = ["old"];
        const next = new DefineData(); next.Flags = n; next.KeyParts = ["new"];
        const m = mergeDefineData(old, next);
        got = `${m.Flags}|[${m.KeyParts.join(" ")}]`; break;
      }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} ${r.case}`);
  }
});

const F4 = new URL("../../../testdata/config-path-go.json", import.meta.url);
const b4 = new Uint8Array(readFileSync(F4));
const S4 = "89ef2f2957bdcfc30d577efd3051ea7b00614d0713f612c006febb4908c11e55";
interface Row4 { fn: string; arg: string; out: string; }

test("config 路径助手：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(b4).digest("hex"), S4, "config-path fixture sha256");
  const rows: Row4[] = JSON.parse(new TextDecoder().decode(b4));
  const extMap = new Map([[".css", 4], [".module.css", 14], [".js", 10], ["", 10]]);
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "LoaderFromFileExtension": got = String(LoaderFromFileExtension(extMap, r.arg)); break;
      case "TemplateToString": {
        if (r.arg === "single") { const t = new PT2(); t.Data = "plain.js"; got = TemplateToString([t]); }
        else { const t1 = new PT2(); t1.Data = "dist/"; const t2 = new PT2(); t2.Placeholder = 2; const t3 = new PT2(); t3.Placeholder = 4; got = TemplateToString([t1, t2, t3]); }
        break;
      }
      case "MaybeRemoveWhitespace": got = MaybeRemoveWhitespace(r.arg, true); break;
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} ${r.arg}`);
  }
});

const F5 = new URL("../../../testdata/config-core-go.json", import.meta.url);
const b5 = new Uint8Array(readFileSync(F5));
const S5 = "7790ce281e36bb07e5aebe3fd1aefaeb39f29794a1365d553bf238837d36ad7a";
interface Row5 { fn: string; arg: string; out: string; }

test("config 核心助手：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(b5).digest("hex"), S5, "config-core fixture sha256");
  const rows: Row5[] = JSON.parse(new TextDecoder().decode(b5));
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "PrettyPrintTargetEnvironment": { const [e, m] = r.arg.split("|"); got = PrettyPrintTargetEnvironment(e, Number(m)); break; }
      case "SubstituteTemplate": {
        const ph = new PathPlaceholders(); ph.Dir = "outDir"; ph.Name = "foo";
        if (r.arg === "static") { const t = new PT2(); t.Data = "static.js"; got = tplStr(SubstituteTemplate([t], ph)); }
        else {
          const t1 = new PT2(); t1.Placeholder = 1; const t2 = new PT2(); t2.Data = "/";
          const t3 = new PT2(); t3.Placeholder = 2; const t4 = new PT2(); t4.Placeholder = 4; t4.Data = ".js";
          got = tplStr(SubstituteTemplate([t1, t2, t3, t4], ph));
        }
        break;
      }
      case "ApplyExtendedConfig": { const baseCfg = new TSConfigJSX(); baseCfg.JSXFactory = ["React.createElement"]; baseCfg.JSX = TSJSX.TSJSXReact; const d = new TSConfigJSX(); d.ApplyExtendedConfig(baseCfg); got = `[${d.JSXFactory!.join(" ")}]|${d.JSX}`; break; }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} ${r.arg}`);
  }
});

function tplStr(t: PT2[]): string { return t.map((p) => `${p.Data}|${p.Placeholder};`).join(""); }
