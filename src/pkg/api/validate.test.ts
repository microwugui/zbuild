// 第 44 轮叶子优先规划：API 验证函数真值表（Go 探针固化）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  validatePlatform, validateColor, validateLogStyle, validateASCIIOnly,
  validateExternalPackages, prettyPrintByteCount,
} from "./api_impl.ts";
import { escapeForHTML } from "./serve_other.ts";
import { isValidExtension, extractPathStyle, getObjectProperty, validateFormat, validateSourceMap, validateLogLevel, validateLoader, validateLegalComments, validateTreeShaking, mapKeyForDefine, importKindToResolveKind, resolveKindToImportKind, stripDirPrefix, getObjectPropertyNumber, getObjectPropertyString, getObjectPropertyObject, getObjectPropertyArray, validateResolveExtensions, validateGlobalName } from "./api_impl.ts";
import * as js_ast from "../../internal/js_ast/js_ast.ts";
import { StringToUTF16 } from "../../internal/helpers/utf.ts";
import { Loc } from "../../internal/logger/logger.ts";

const FIXTURE = new URL("../../../testdata/api-validate-go.json", import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));
const SHA = "3ce278d63f03c0a4767ef9984fe637cedd8c5a1570301a6e0fa928e515bb02e3";

interface Row { fn: string; arg: string; out: string; }

test("api 验证叶子真值表：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA, "api-validate fixture sha256");
  const rows: Row[] = JSON.parse(new TextDecoder().decode(bytes));
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "validatePlatform": got = String(validatePlatform(Number(r.arg))); break;
      case "validateColor": got = String(validateColor(Number(r.arg))); break;
      case "validateLogStyle": got = String(validateLogStyle(Number(r.arg))); break;
      case "validateASCIIOnly": got = String(validateASCIIOnly(Number(r.arg))); break;
      case "validateExternalPackages": got = String(validateExternalPackages(Number(r.arg))); break;
      case "prettyPrintByteCount": got = prettyPrintByteCount(Number(r.arg)); break;
      case "escapeForHTML": got = escapeForHTML(r.arg); break;
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} ${r.arg}`);
  }
});

const F2 = new URL("../../../testdata/api-more-go.json", import.meta.url);
const b2 = new Uint8Array(readFileSync(F2));
const S2 = "226dd181a194d333493e405d1535d58cfb2d7c61d01695ea42f00c33af14f922";
interface Row2 { fn: string; arg: string; out: string; }

test("api 辅助叶子：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(b2).digest("hex"), S2, "api-more fixture sha256");
  const rows: Row2[] = JSON.parse(new TextDecoder().decode(b2));
  const obj = new js_ast.EObject();
  const k = new js_ast.EString(new Uint16Array(StringToUTF16(new TextEncoder().encode("foo"))));
  const val = new js_ast.Expr(new js_ast.ENumber(), new Loc(0));
  const prop = new js_ast.Property(); prop.Key = new js_ast.Expr(k, new Loc(0)); prop.ValueOrNil = val;
  obj.Properties.push(prop);
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "isValidExtension": got = String(isValidExtension(r.arg)); break;
      case "extractPathStyle": got = String(extractPathStyle(Number(r.arg), 2)); break;
      case "getObjectProperty": {
        const v = getObjectProperty(new js_ast.Expr(obj, new Loc(0)), r.arg);
        got = v.Data === null ? "nil" : (v.Data.constructor.name === "ENumber" ? "*js_ast.ENumber" : v.Data.constructor.name); break;
      }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} ${r.arg}`);
  }
});

const F4 = new URL("../../../testdata/api-map-go.json", import.meta.url);
const b4 = new Uint8Array(readFileSync(F4));
const S4 = "f3127006f3b1d6db7210ca93dc12059a6fa935133fa6e1a24967ff2d07eadccb";
interface Row4 { fn: string; arg: string; out: string; }

test("api 映射助手：fixture sha256 + 25 例等于 Go", () => {
  assert.equal(createHash("sha256").update(b4).digest("hex"), S4, "api-map fixture sha256");
  const rows: Row4[] = JSON.parse(new TextDecoder().decode(b4));
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "mapKeyForDefine": {
        const parts = r.arg.startsWith("[") ? r.arg.slice(1, -1).split(" ").filter(Boolean) : [];
        got = Buffer.from(mapKeyForDefine(parts), "utf8").toString("base64"); break;
      }
      case "importKindToResolveKind": got = String(importKindToResolveKind(Number(r.arg))); break;
      case "resolveKindToImportKind": got = String(resolveKindToImportKind(Number(r.arg))); break;
      case "stripDirPrefix": {
        const [p, pre, sl] = r.arg.slice(1, -1).split(" ");
        const v = stripDirPrefix(p, pre, sl); got = `${v.ok}|${v.value}`; break;
      }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} ${r.arg}`);
  }
});

const F5 = new URL("../../../testdata/api-getprop-go.json", import.meta.url);
const b5 = new Uint8Array(readFileSync(F5));
const S5 = "d66bc47c26bba099afc8e6c7f8872c6c64c45699a4b6564271729749b162c65c";
interface Row5 { fn: string; key: string; out: string; }

test("api getObjectProperty 族：fixture sha256 + 20 例等于 Go", () => {
  assert.equal(createHash("sha256").update(b5).digest("hex"), S5, "api-getprop fixture sha256");
  const rows: Row5[] = JSON.parse(new TextDecoder().decode(b5));
  const obj = new js_ast.EObject();
  const mk = (key: string, data: js_ast.E) => { const p = new js_ast.Property(); p.Key = new js_ast.Expr(new js_ast.EString(new Uint16Array(StringToUTF16(new TextEncoder().encode(key)))), new Loc(0)); p.ValueOrNil = new js_ast.Expr(data, new Loc(0)); obj.Properties.push(p); };
  mk("num", new js_ast.ENumber(42)); mk("str", new js_ast.EString(new Uint16Array(StringToUTF16(new TextEncoder().encode("hi"))))); mk("obj", new js_ast.EObject()); mk("arr", new js_ast.EArray());
  const e = new js_ast.Expr(obj, new Loc(0));
  for (const r of rows) {
    let v: unknown;
    switch (r.fn) {
      case "getObjectPropertyNumber": v = getObjectPropertyNumber(e, r.key); break;
      case "getObjectPropertyString": v = getObjectPropertyString(e, r.key); break;
      case "getObjectPropertyObject": v = getObjectPropertyObject(e, r.key); break;
      case "getObjectPropertyArray": v = getObjectPropertyArray(e, r.key); break;
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(String(v !== null), r.out, `${r.fn} ${r.key}`);
  }
});

const F6 = new URL("../../../testdata/api-val2-go.json", import.meta.url);
const b6 = new Uint8Array(readFileSync(F6));
const S6 = "e46b52e8849d414f9c12e2e8c6d706b82e578c79a9b09a1157200bb369bfb9e0";
interface Row6 { fn: string; arg: string; out: string; errs: number; }

test("api 验证 2：fixture sha256 + 逐例等于 Go", () => {
  assert.equal(createHash("sha256").update(b6).digest("hex"), S6, "api-val2 fixture sha256");
  const rows: Row6[] = JSON.parse(new TextDecoder().decode(b6));
  for (const r of rows) {
    let got = "", errs = 0;
    switch (r.fn) {
      case "validateResolveExtensions": {
        const order = r.arg === "[]" ? null : r.arg.slice(1, -1).split(" ").filter(Boolean);
        got = `[${validateResolveExtensions(order, () => { errs++; }).join(" ")}]`; break;
      }
      case "validateGlobalName": { const name = r.arg.startsWith("[") ? r.arg.slice(1, -1) : r.arg; got = `[${validateGlobalName(name, "", () => { errs++; }).join(" ")}]`; break; }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} ${r.arg} out`);
    assert.equal(errs, r.errs, `${r.fn} ${r.arg} errs`);
  }
});

const F3 = new URL("../../../testdata/api-enum-go.json", import.meta.url);
const b3 = new Uint8Array(readFileSync(F3));
const S3 = "16e81f46a8d5a32406d20767df21467a0eb37f29e91a9613e1601dc943db1a08";
interface Row3 { fn: string; arg: string; out: string; }

test("api 枚举验证：fixture sha256 + 78 例等于 Go", () => {
  assert.equal(createHash("sha256").update(b3).digest("hex"), S3, "api-enum fixture sha256");
  const rows: Row3[] = JSON.parse(new TextDecoder().decode(b3));
  for (const r of rows) {
    let got: string;
    switch (r.fn) {
      case "validateFormat": got = String(validateFormat(Number(r.arg))); break;
      case "validateSourceMap": got = String(validateSourceMap(Number(r.arg))); break;
      case "validateLogLevel": got = String(validateLogLevel(Number(r.arg))); break;
      case "validateLoader": got = String(validateLoader(Number(r.arg))); break;
      case "validateLegalComments": { const [v, b] = r.arg.split("|"); got = String(validateLegalComments(Number(v), b === "true")); break; }
      case "validateTreeShaking": { const [v, b, f] = r.arg.split("|"); got = String(validateTreeShaking(Number(v), b === "true", Number(f))); break; }
      default: throw new Error(`unknown ${r.fn}`);
    }
    assert.equal(got, r.out, `${r.fn} ${r.arg}`);
  }
});
