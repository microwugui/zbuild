// bench/printer_opt_diff.mjs —— 直接 Parse→Print，带可配置打印机选项，输出字节。
// 用法: node printer_opt_diff.mjs <srcDir> <inputFile> <optsJson> <outFile>
// 供 printer_fixtures.py 对「基线树 vs 候选树」在同一 fixture/opts 下逐字节比较。
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const [srcDir, inputFile, optsJson, outFile] = process.argv.slice(2);
const { Parse, Options: ParseOptions } = await import(srcDir + "/internal/js_parser/js_parser.ts");
const { Print, Options: PrintOptions, Format } = await import(srcDir + "/internal/js_printer/js_printer.ts");
const { Log, Path, Source } = await import(srcDir + "/internal/logger/logger.ts");

const contents = new Uint8Array(readFileSync(inputFile));
const s = new Source();
s.KeyPath = new Path(); s.KeyPath.Text = inputFile; s.KeyPath.Namespace = "file"; s.Index = 0;
s.Contents = contents; s.PrettyPaths.Rel = inputFile; s.PrettyPaths.Abs = inputFile;
const po = new ParseOptions(); po.mode = 2; po.outputFormat = 3;
const parsed = Parse(new Log(), s, po);
if (!parsed.ok) {
  console.log(JSON.stringify({ ok: false, stage: "parse" }));
  process.exit(1);
}
const opts = new PrintOptions();
opts.OutputFormat = Format.FormatESModule;
opts.LegalComments = 2; // 与 bundle1/bundle_multi 驱动同口径
Object.assign(opts, JSON.parse(optsJson));
const symbols = parsed.ast.Symbols;
const renamer = { NameForSymbol: (ref) => symbols[ref.InnerIndex]?.OriginalName ?? "" };
const res = Print(parsed.ast, symbols, renamer, opts);
writeFileSync(outFile, res.JS);
console.log(JSON.stringify({
  ok: true, len: res.JS.length,
  sha: createHash("sha256").update(res.JS).digest("hex"),
}));
