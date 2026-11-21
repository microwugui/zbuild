#!/usr/bin/env node
/**
 * src/cli.ts —— 最小可执行管线（第 14 次推进）
 *
 * stdin → js_parser.Parse → js_printer.Print → stdout。
 * 只支持 `--loader=js` 与 `--format=esm`；其余参数（--format=cjs/iife、--sourcemap、
 * TS/JSX loader、minify 的 syntax/identifiers 部分）一律显式报错退出（非 0），
 * 不静默输出错误字节——oracle 会把它记成 ts-error，而不是 ts-missing/equal。
 *
 * 这是 M1 端到端管线的起点：`tools/oracle.ts` 的 ts 侧从这里接上。
 */

import { readFileSync } from "node:fs";

import { Log, Path, Source } from "./internal/logger/logger.ts";
import { Options, Parse } from "./internal/js_parser/js_parser.ts";
import { Format, Options as PrintOptions, Print } from "./internal/js_printer/js_printer.ts";
import { SClass, SFunction, SLocal } from "./internal/js_ast/js_ast.ts";
import type { Ref } from "./internal/ast/ast.ts";

const args = process.argv.slice(2);

let loader = "js";
let format: number = Format.FormatNone;
let minifyWhitespace = false;
let asciiOnly = false;
let unsupported: string | null = null;

for (const arg of args) {
  if (arg.startsWith("--loader=")) {
    loader = arg.slice("--loader=".length);
  } else if (arg.startsWith("--format=")) {
    const value = arg.slice("--format=".length);
    if (value === "esm") format = Format.FormatESModule;
    else if (value === "cjs") format = Format.FormatCommonJS;
    else if (value === "iife") format = Format.FormatIIFE;
    else unsupported = `unknown format: ${value}`;
  } else if (arg === "--minify") {
    minifyWhitespace = true;
  } else if (arg.startsWith("--charset=")) {
    asciiOnly = arg.slice("--charset=".length) === "ascii";
  } else if (arg.startsWith("--sourcemap")) {
    unsupported = "--sourcemap is not implemented";
  } else if (arg.startsWith("--target=")) {
    // 目标环境降级（lowering）尚未移植：只有 esnext 是无操作，其余显式报错退出（不静默）。
    if (arg.slice("--target=".length) !== "esnext") {
      unsupported = `target ${arg.slice("--target=".length)} is not implemented`;
    }
  } else if (arg.startsWith("--")) {
    unsupported = `unknown flag: ${arg}`;
  }
}

if (loader !== "js") unsupported = `loader ${loader} is not implemented`;
if (format !== Format.FormatESModule) unsupported = "only --format=esm is implemented";

if (unsupported !== null) {
  console.error(`ERROR: ${unsupported}`);
  process.exit(1);
}

const contents = readFileSync(0);
const source = new Source();
source.Index = 0;
source.Contents = contents;
source.KeyPath = new Path();
source.KeyPath.Text = "<stdin>";

const log = new Log();
const options = new Options();
const { ast, ok } = Parse(log, source, options);

if (!ok) {
  console.error("ERROR: parse failed");
  process.exit(1);
}

// Go 的 CLI 走 linker：linker 会把 export 声明改写成文件末尾的 export 子句
// （"export const x = 1" → "const x = 1;" + 末尾 "export { x };"）。
// 这里只做第一步（去掉声明上的 IsExport）——末尾的 export 子句属 linker（M2，未移植），
// 所以 module 用例的字节相等在 M2 前不可能达成；see PLAN.md「第 15 次推进」§0。
for (const part of ast.Parts) {
  for (const stmt of part.Stmts) {
    const data = stmt.Data;
    if (data instanceof SLocal || data instanceof SFunction || data instanceof SClass) {
      data.IsExport = false;
    }
  }
}

const symbols = ast.Symbols;
const renamer = {
  NameForSymbol(ref: Ref): string {
    return symbols[ref.InnerIndex].OriginalName;
  },
};

const printOptions = new PrintOptions();
printOptions.OutputFormat = format;
printOptions.MinifyWhitespace = minifyWhitespace;
printOptions.ASCIIOnly = asciiOnly;

const result = Print(ast, symbols, renamer, printOptions);
process.stdout.write(result.JS);
