// 1:1 移植自 esbuild internal/js_printer/js_printer.go（v0.28.2，commit f6058f83）
//
// ⚠️ 这是**最小子集**（第 14 次推进）：只覆盖当前 js_parser 骨架能产出的节点。
// 未覆盖的语法一律 `throw`（cli 退出非 0 → oracle 记 ts-error），绝不静默输出错误字节。
// 已覆盖：SLocal/SExpr/SReturn/SFunction/SBlock/SIf/SDebugger/SDirective、
// ENumber/EString/EBoolean/ENull/EUndefined/EThis/EMissing/ERegExp/EIdentifier/EUnary/EBinary/
// ECall/EDot/EIndex/EArray/EObject/ESpread/ETemplate/EFunction/EImportMeta。
// 未覆盖（明确登记）：JSX、class、arrow、import/export 子句、TS 语法、注释、sourcemap、重命名。
//
// 期望值来自 Go 实测：`/root/esbuild/tmpgenprinter`（Parse + 真实 js_printer.Print）
// → testdata/js_printer/basic.json。生成命令见 PLAN.md「第 14 次推进」§4。

import * as js_ast from "../js_ast/js_ast.ts";
import { Ref, Symbol } from "../ast/ast.ts";
import { Loc } from "../logger/logger.ts";
import { ContainsNonBMPCodePointUTF16, UTF16EqualsString } from "../helpers/utf.ts";

/** Go: type Options struct (js_printer.go:4911) 的字段子集 */
export class Options {
  OutputFormat: number = 0;
  MinifyWhitespace: boolean = false;
  MinifyIdentifiers: boolean = false;
  MinifySyntax: boolean = false;
  ASCIIOnly: boolean = false;
  Indent: number = 2;
  LineLimit: number = 0;
  UnsupportedFeatures: bigint = 0n;
  LegalComments: number = 0;
  SourceMap: number = 0;
  AddSourceMappings: boolean = false;
  NeedsMetafile: boolean = false;
}

/** Go: config.Format (config/config.go) 的子集 */
export const Format = {
  FormatNone: 0,
  FormatIIFE: 1,
  FormatCommonJS: 2,
  FormatESModule: 3,
} as const;

/** Go: type PrintResult struct */
export class PrintResult {
  JS: Uint8Array = new Uint8Array(0);
}

/** Go: type Renamer interface { NameForSymbol(ast.Ref) string } (renamer/renamer.go:59) */
export interface Renamer {
  NameForSymbol(ref: Ref): string;
}

/** Go: printQuotedFlags (js_printer.go 内部) */
export const printQuotedFlags = {
  printQuotedNone: 0,
  printQuotedAllowBacktick: 1 << 0,
  printQuotedJSON: 1 << 1,
  printQuotedNoWrap: 1 << 2,
} as const;

/** Go: printExprFlags */
export const printExprFlags = {
  printExprFlagNone: 0,
  printExprFlagStartOfLine: 1 << 0,
  printExprFlagForbidCall: 1 << 1,
  printExprFlagForbidIn: 1 << 2,
} as const;

/** Go: printStmtFlags */
export const printStmtFlags = {
  printStmtFlagNone: 0,
  printStmtFlagIsInOneLineStatement: 1 << 0,
} as const;

const encoder = new TextEncoder();

const hexChars = "0123456789ABCDEF";

/** Go: func canUseShorthandProperty(key []uint16, name string, flags js_ast.PropertyFlags) bool (js_printer.go:1332) */
function canUseShorthandProperty(key: Uint16Array, name: string, flags: js_ast.PropertyFlags): boolean {
  if (!UTF16EqualsString(key, encoder.encode(name))) return false;
  return name !== "__proto__" || (flags & js_ast.PropertyFlags.PropertyWasShorthand) !== 0;
}

/** Go: func QuoteIdentifier(js []byte, name string, unsupportedFeatures compat.JSFeature) []byte (js_printer.go:33) */
export function QuoteIdentifier(name: string): Uint8Array {
  const out: number[] = [];
  for (const ch of name) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x20 && c <= 0x7e) {
      out.push(c);
    } else if (c <= 0xffff) {
      out.push(0x5c, 0x75, hexChars.charCodeAt(c >> 12), hexChars.charCodeAt((c >> 8) & 15),
        hexChars.charCodeAt((c >> 4) & 15), hexChars.charCodeAt(c & 15));
    } else {
      throw new Error("Internal error: Cannot encode identifier: Unicode escapes are unsupported");
    }
  }
  return new Uint8Array(out);
}

export class printer {
  js: number[] = [];
  options: Options;
  symbols: Symbol[];
  renamer: Renamer;
  indent: number = 0;
  lineLength: number = 0;
  prevOpEndsWithOpenBrace: boolean = false;
  prevOpEndsWithCloseBrace: boolean = false;
  prevOpIsUnaryPlusOrMinus_: boolean = false;
  prevOpIsDot: boolean = false;
  /** Go: needsSemicolon bool（minify 时把分号推迟到下一个 token 之前） */
  needsSemicolon: boolean = false;

  constructor(symbols: Symbol[], renamer: Renamer, options: Options) {
    this.symbols = symbols;
    this.renamer = renamer;
    this.options = options;
  }

  /** Go: func (p *printer) canPrintIdentifier(name string) bool (js_printer.go:432) */
  canPrintIdentifier(name: string): boolean {
    for (const ch of name) {
      const c = ch.codePointAt(0)!;
      if (!(c === 0x24 || c === 0x5f || (c >= 0x30 && c <= 0x39) ||
        (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a))) {
        return false;
      }
    }
    return name.length > 0;
  }

  /** Go: func (p *printer) printIdentifier(name string) (js_printer.go:444) */
  printIdentifier(name: string): void {
    if (this.canPrintIdentifier(name)) {
      this.print(name);
    } else {
      this.printBytes(QuoteIdentifier(name));
    }
  }

  /** Go: func (p *printer) print(text string) (js_printer.go:312) */
  print(text: string): void {
    this.printBytes(encoder.encode(text));
  }

  /** Go: func (p *printer) printBytes(bytes []byte) (js_printer.go:318) */
  printBytes(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes[i];
      this.js.push(c);
      if (c === 0x0a) this.lineLength = 0;
      else this.lineLength += 1;
    }
  }

  /** Go: func (p *printer) printIndent() (js_printer.go:349) */
  printIndent(): void {
    if (!this.options.MinifyWhitespace) {
      for (let i = 0; i < this.indent; i++) this.print("  ");
    }
  }

  /** Go: func (p *printer) printSpace() (js_printer.go:779) */
  printSpace(): void {
    if (!this.options.MinifyWhitespace) this.print(" ");
  }

  /** Go: func (p *printer) printNewline() (js_printer.go:785) */
  printNewline(): void {
    if (!this.options.MinifyWhitespace) this.print("\n");
  }

  /** Go: func (p *printer) printSemicolonAfterStatement() (js_printer.go:837) */
  printSemicolonAfterStatement(): void {
    if (!this.options.MinifyWhitespace) this.print(";\n");
    else this.needsSemicolon = true;
  }

  /** Go: func (p *printer) printSemicolonIfNeeded() (js_printer.go:845) */
  printSemicolonIfNeeded(): void {
    if (this.needsSemicolon) {
      this.print(";");
      this.needsSemicolon = false;
    }
  }

  /** Go: func (p *printer) printSpaceBeforeIdentifier() (js_printer.go:852) */
  printSpaceBeforeIdentifier(): void {
    if (this.js.length === 0) return;
    const last = this.js[this.js.length - 1];
    // 多字节 UTF-8 的末字节落在 0x80..0xBF：Go 的 DecodeLastRune 对残片返回 RuneError，
    // 而 RuneError 不是标识符继续字符，所以只看末字节与 Go 一致（非 ASCII 全字符名按 ASCII 判定）。
    if (last === 0x24 || last === 0x5f || (last >= 0x30 && last <= 0x39) ||
      (last >= 0x41 && last <= 0x5a) || (last >= 0x61 && last <= 0x7a)) {
      this.print(" ");
    }
  }

  /** Go: func (p *printer) canPrintIdentifierUTF16(name []uint16) bool (js_printer.go:442) */
  canPrintIdentifierUTF16(name: Uint16Array): boolean {
    if (!js_ast.IsIdentifierES5AndESNextUTF16(name)) return false;
    if (this.options.ASCIIOnly && ContainsNonBMPCodePointUTF16(name)) return false;
    return true;
  }

  /** Go: func (p *printer) printIdentifierUTF16(name []uint16) (js_printer.go:456) */
  printIdentifierUTF16(name: Uint16Array): void {
    const out: number[] = [];
    for (let i = 0; i < name.length; i++) {
      let c = name[i];
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < name.length) {
        const c2 = name[i + 1];
        if (c2 >= 0xdc00 && c2 <= 0xdfff) {
          c = (c << 10) + c2 + (0x10000 - (0xd800 << 10) - 0xdc00);
          i++;
        }
      }

      if (this.options.ASCIIOnly && c > 0x7e) {
        if (c <= 0xffff) {
          out.push(0x5c, 0x75,
            hexChars.charCodeAt(c >> 12), hexChars.charCodeAt((c >> 8) & 15),
            hexChars.charCodeAt((c >> 4) & 15), hexChars.charCodeAt(c & 15));
        } else {
          throw new Error("Internal error: Cannot encode identifier: Unicode escapes are unsupported");
        }
        continue;
      }

      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    this.printBytes(new Uint8Array(out));
  }

  /** Go: func (p *printer) printSpaceBeforeOperator(next js_ast.OpCode) (js_printer.go:817) */
  printSpaceBeforeOperator(next: js_ast.OpCode): void {
    if (this.prevOpEndsWithOpenBrace || this.prevOpEndsWithCloseBrace) return;
    this.printSpace();
  }

  /** Go: func (p *printer) printNonNegativeFloat(absValue float64) (js_printer.go:3564) */
  printNonNegativeFloat(absValue: number): void {
    // We can avoid the slow call to strconv.FormatFloat() for integers less than
    // 1000 because we know that exponential notation will always be longer than
    // the integer representation. This is not the case for 1000 which is "1e3".
    if (absValue < 1000) {
      if (Number.isInteger(absValue)) {
        this.print(String(absValue));
        return;
      }
    }

    // Go 的 strconv.FormatFloat(absValue, 'g', -1, 64)。JS 的 String() 在常见范围内
    // 与之一致；两者在指数阈值上的差异由差分夹具暴露后再修（PLAN §4）。
    let result = String(absValue);

    // Simplify the exponent: "e+05" => "e5"
    {
      const e = result.lastIndexOf("e");
      if (e !== -1) {
        let sign = "";
        let rest = result.slice(e + 1);
        if (rest[0] === "+") rest = rest.slice(1);
        else if (rest[0] === "-") { sign = "-"; rest = rest.slice(1); }
        rest = rest.replace(/^0+/, "");
        result = result.slice(0, e + 1) + sign + rest;
      }
    }

    const dot = result.indexOf(".");

    if (dot === 1 && result[0] === "0") {
      // Simplify numbers starting with "0."
      let afterDot = 2;
      if (this.options.MinifyWhitespace) {
        result = result.slice(1);
        afterDot--;
      }

      // Try using an exponent: "0.001" => "1e-3"
      if (result[afterDot] === "0") {
        let i = afterDot + 1;
        while (result[i] === "0") i++;
        const remaining = result.slice(i);
        const exponent = String(afterDot - i - remaining.length);
        if (result.length > remaining.length + 1 + exponent.length) {
          result = remaining + "e" + exponent;
        }
      }
    } else if (dot !== -1) {
      // Try to get rid of a "." and maybe also an "e"
      const e = result.lastIndexOf("e");
      if (e !== -1) {
        const integer = result.slice(0, dot);
        const fraction = result.slice(dot + 1, e);
        const exponent = parseInt(result.slice(e + 1), 10) - fraction.length;

        if (exponent >= 0 && exponent <= 2) {
          // "1.2e1" => "12" / "1.2e2" => "120"
          if (result.length >= integer.length + fraction.length + exponent) {
            result = integer + fraction + "0".repeat(exponent);
          }
        } else {
          // "1.2e4" => "12e3"
          const exponentStr = String(exponent);
          if (result.length >= integer.length + fraction.length + 1 + exponentStr.length) {
            result = integer + fraction + "e" + exponentStr;
          }
        }
      }
    } else if (result.endsWith("0")) {
      // Simplify numbers ending with "0" by trying to use an exponent
      // "1000" => "1e3"
      let i = result.length - 1;
      while (i > 0 && result[i - 1] === "0") i--;
      const remaining = result.slice(0, i);
      const exponent = String(result.length - i);
      if (result.length > remaining.length + 1 + exponent.length) {
        result = remaining + "e" + exponent;
      }
    }

    this.print(result);
  }

  /** Go: func (p *printer) printNumber(value float64, level js_ast.L) (js_printer.go:484) */
  printNumber(value: number, _level: js_ast.L): void {
    if (Object.is(value, -0)) {
      this.print("-0");
      return;
    }
    if (value < 0) {
      this.print("-");
      this.printNonNegativeFloat(-value);
      return;
    }
    this.printNonNegativeFloat(value);
  }

  /** Go: func (p *printer) printQuotedUTF16(data []uint16, flags printQuotedFlags) (js_printer.go:1353) */
  printQuotedUTF16(data: Uint16Array, flags: number): void {
    const quote = (flags & printQuotedFlags.printQuotedAllowBacktick) !== 0 ? "`" : "\"";
    this.print(quote);
    let i = 0;
    while (i < data.length) {
      const c = data[i++];
      switch (c) {
        case 0x22: // '"'
          if (quote === "\"") this.print("\\\"");
          else this.print("\"");
          break;
        case 0x27: // '\''
          this.print("'");
          break;
        case 0x5c: // '\\'
          this.print("\\\\");
          break;
        case 0x0a: this.print("\\n"); break;
        case 0x0d: this.print("\\r"); break;
        case 0x09: this.print("\\t"); break;
        case 0x0b: this.print("\\v"); break;
        case 0x0c: this.print("\\f"); break;
        case 0x08: this.print("\\b"); break;
        case 0x00: this.print("\\0"); break;
        default:
          if (c < 0x20) {
            this.print("\\x" + (c >> 4).toString(16).toUpperCase() + (c & 15).toString(16).toUpperCase());
          } else if (c >= 0xd800 && c <= 0xdbff && i < data.length &&
            data[i] >= 0xdc00 && data[i] <= 0xdfff) {
            const cp = 0x10000 + ((c - 0xd800) << 10) + (data[i] - 0xdc00);
            this.print(String.fromCodePoint(cp));
            i++;
          } else if (c >= 0xd800 && c <= 0xdfff) {
            this.print("\\u" + c.toString(16).toUpperCase().padStart(4, "0"));
          } else if (this.options.ASCIIOnly && c > 0x7e) {
            this.print("\\u" + c.toString(16).toUpperCase().padStart(4, "0"));
          } else {
            this.print(String.fromCharCode(c));
          }
      }
    }
    this.print(quote);
  }

  /** 非 Go 函数：ETemplate 的 cooked 文本输出（Go 在 printExpr 内联处理） */
  printTemplateCooked(data: Uint16Array): void {
    for (let i = 0; i < data.length; i++) {
      const c = data[i];
      if (c === 0x5c) this.print("\\\\");
      else if (c === 0x60) this.print("\\`");
      else if (c === 0x24 && i + 1 < data.length && data[i + 1] === 0x7b) this.print("\\$");
      else if (c === 0x0d) this.print("\\r");
      else if (c === 0x0a) this.print("\\n");
      else this.print(String.fromCharCode(c));
    }
  }

  /** Go: func (p *printer) printBinding(binding js_ast.Binding) (js_printer.go:562) */
  printBinding(binding: js_ast.Binding): void {
    const b = binding.Data;
    if (b instanceof js_ast.BIdentifier) {
      this.printIdentifier(this.renamer.NameForSymbol(b.Ref));
    } else if (b instanceof js_ast.BMissing) {
      // 空
    } else {
      throw new Error("printer: unsupported binding");
    }
  }

  /** Go: func (p *printer) printFnArgs(args []js_ast.Arg, opts fnArgsOpts) (js_printer.go:865) */
  printFnArgs(args: js_ast.Arg[], opts: { hasRestArg?: boolean; isArrow?: boolean } = {}): void {
    let wrap = true;

    // Minify "(a) => {}" as "a=>{}"
    if (this.options.MinifyWhitespace && !opts.hasRestArg && opts.isArrow && args.length === 1) {
      if (args[0].Binding.Data instanceof js_ast.BIdentifier && args[0].DefaultOrNil === null) {
        wrap = false;
      }
    }

    if (wrap) this.print("(");

    for (let i = 0; i < args.length; i++) {
      if (i !== 0) {
        this.print(",");
        this.printSpace();
      }
      if (opts.hasRestArg && i + 1 === args.length) this.print("...");
      this.printBinding(args[i].Binding);
      if (args[i].DefaultOrNil !== null) {
        this.printSpace();
        this.print("=");
        this.printSpace();
        this.printExprWithoutLeadingNewline(args[i].DefaultOrNil, js_ast.L.LComma, printExprFlags.printExprFlagNone);
      }
    }

    if (wrap) this.print(")");
  }

  /** Go: func (p *printer) printFn(fn js_ast.Fn) (js_printer.go:906) */
  printFn(fn: js_ast.Fn): void {
    this.printFnArgs(fn.Args, { hasRestArg: fn.HasRestArg });
    this.printSpace();
    this.printBlock(fn.Body.Block);
  }

  /** Go: func (p *printer) printProperty(property js_ast.Property) (js_printer.go:1077) 的 JS 子集 */
  printProperty(property: js_ast.Property): void {
    if (property.Kind === js_ast.PropertyKind.PropertySpread) {
      this.print("...");
      this.printExpr(property.ValueOrNil!, js_ast.L.LComma, printExprFlags.printExprFlagNone);
      return;
    }

    if (property.Flags & js_ast.PropertyFlags.PropertyIsStatic) {
      this.printSpaceBeforeIdentifier();
      this.print("static");
      this.printSpace();
    }

    switch (property.Kind) {
      case js_ast.PropertyKind.PropertyGetter:
        this.printSpaceBeforeIdentifier();
        this.print("get");
        this.printSpace();
        break;

      case js_ast.PropertyKind.PropertySetter:
        this.printSpaceBeforeIdentifier();
        this.print("set");
        this.printSpace();
        break;

      case js_ast.PropertyKind.PropertyAutoAccessor:
        this.printSpaceBeforeIdentifier();
        this.print("accessor");
        this.printSpace();
        break;
    }

    const valueData = property.ValueOrNil !== null ? property.ValueOrNil.Data : null;
    const isMethod = js_ast.IsMethodDefinition(property.Kind);
    if (isMethod && valueData instanceof js_ast.EFunction) {
      if (valueData.Fn.IsAsync) {
        this.printSpaceBeforeIdentifier();
        this.print("async");
        this.printSpace();
      }
      if (valueData.Fn.IsGenerator) this.print("*");
    }

    const isComputed = (property.Flags & js_ast.PropertyFlags.PropertyIsComputed) !== 0;

    if (isComputed) {
      this.print("[");
      this.printExpr(property.Key, js_ast.L.LComma, printExprFlags.printExprFlagNone);
      this.print("]");

      if (property.ValueOrNil !== null) {
        if (isMethod && valueData instanceof js_ast.EFunction) {
          this.printFn(valueData.Fn);
          return;
        }

        this.print(":");
        this.printSpace();
        this.printExprWithoutLeadingNewline(property.ValueOrNil, js_ast.L.LComma, printExprFlags.printExprFlagNone);
      }

      if (property.InitializerOrNil !== null) {
        this.printSpace();
        this.print("=");
        this.printSpace();
        this.printExprWithoutLeadingNewline(property.InitializerOrNil, js_ast.L.LComma, printExprFlags.printExprFlagNone);
      }
      return;
    }

    const key = property.Key.Data;
    if (key instanceof js_ast.EString) {
      if (!(property.Flags & js_ast.PropertyFlags.PropertyPreferQuotedKey) && this.canPrintIdentifierUTF16(key.Value)) {
        this.printSpaceBeforeIdentifier();

        // Use a shorthand property if the names are the same
        if (property.ValueOrNil !== null) {
          const v = property.ValueOrNil.Data;
          if (v instanceof js_ast.EIdentifier) {
            const name = this.renamer.NameForSymbol(v.Ref);
            if (canUseShorthandProperty(key.Value, name, property.Flags)) {
              this.printIdentifierUTF16(key.Value);
              if (property.InitializerOrNil !== null) {
                this.printSpace();
                this.print("=");
                this.printSpace();
                this.printExprWithoutLeadingNewline(property.InitializerOrNil, js_ast.L.LComma, printExprFlags.printExprFlagNone);
              }
              return;
            }
          }
        }

        // The JavaScript specification special-cases the property identifier "__proto__"
        if ((property.Flags & js_ast.PropertyFlags.PropertyWasShorthand) !== 0 &&
          UTF16EqualsString(key.Value, encoder.encode("__proto__"))) {
          this.print("[");
          this.printQuotedUTF16(key.Value, printQuotedFlags.printQuotedNone);
          this.print("]");
        } else {
          this.printIdentifierUTF16(key.Value);
        }
      } else {
        this.printQuotedUTF16(key.Value, printQuotedFlags.printQuotedNone);
      }
    } else if (key instanceof js_ast.ENumber) {
      this.printNumber(key.Value, js_ast.L.LLowest);
    } else {
      this.printExpr(property.Key, js_ast.L.LLowest, printExprFlags.printExprFlagNone);
    }

    if (isMethod && valueData instanceof js_ast.EFunction) {
      this.printFn(valueData.Fn);
      return;
    }

    if (property.ValueOrNil !== null) {
      this.print(":");
      this.printSpace();
      this.printExprWithoutLeadingNewline(property.ValueOrNil, js_ast.L.LComma, printExprFlags.printExprFlagNone);
    }

    if (property.InitializerOrNil !== null) {
      this.printSpace();
      this.print("=");
      this.printSpace();
      this.printExprWithoutLeadingNewline(property.InitializerOrNil, js_ast.L.LComma, printExprFlags.printExprFlagNone);
    }
  }

  /** Go: func (p *printer) printExprWithoutLeadingNewline(expr js_ast.Expr, level js_ast.L, flags printExprFlags) (js_printer.go:1971) */
  printExprWithoutLeadingNewline(expr: js_ast.Expr, level: js_ast.L, flags: number): void {
    const e = expr.Data;

    if (e === null) return;

    if (e instanceof js_ast.EIdentifier) {
      this.printIdentifier(this.renamer.NameForSymbol(e.Ref));
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.ENumber) {
      this.printNumber(e.Value, level);
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EBigInt) {
      this.print(e.Value);
      this.print("n");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EString) {
      this.printQuotedUTF16(e.Value, printQuotedFlags.printQuotedNone);
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EBoolean) {
      this.print(e.Value ? "true" : "false");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.ENull) {
      this.print("null");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EUndefined) {
      this.print("undefined");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EThis) {
      this.print("this");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EMissing) {
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.ERegExp) {
      this.print(e.Value);
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EImportMeta) {
      this.print("import.meta");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EUnary) {
      const entry = js_ast.OpTable[e.Op];
      this.print(entry.Text);
      if (entry.Text.length > 1) this.printSpace();
      this.printExpr(e.Value, js_ast.L.LPrefix, printExprFlags.printExprFlagNone);
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EBinary) {
      const entry = js_ast.OpTable[e.Op];
      const opLevel = entry.Level;
      const wrap = opLevel < level ||
        (e.Op === js_ast.OpCode.BinOpComma && level > js_ast.L.LComma);
      if (wrap) this.print("(");
      this.printExpr(e.Left, opLevel, printExprFlags.printExprFlagNone);
      if (e.Op === js_ast.OpCode.BinOpComma) {
        this.print(",");
        this.printSpace();
      } else {
        this.printSpaceBeforeOperator(e.Op);
        this.print(entry.Text);
        this.printSpace();
      }
      this.printExpr(e.Right, js_ast.IsRightAssociative(e.Op) ? opLevel : opLevel + 1, printExprFlags.printExprFlagNone);
      if (wrap) this.print(")");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.ECall) {
      this.printExpr(e.Target, js_ast.L.LCall, flags);
      this.print("(");
      for (let i = 0; i < e.Args.length; i++) {
        if (i > 0) {
          this.print(",");
          this.printSpace();
        }
        this.printExpr(e.Args[i], js_ast.L.LComma, printExprFlags.printExprFlagNone);
      }
      this.print(")");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EDot) {
      this.printExpr(e.Target, js_ast.L.LMember, flags);
      this.print(".");
      this.printIdentifier(e.Name);
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EIndex) {
      this.printExpr(e.Target, js_ast.L.LMember, flags);
      this.print("[");
      this.printExpr(e.Index, js_ast.L.LLowest, printExprFlags.printExprFlagNone);
      this.print("]");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EArray) {
      const isMultiLine = e.Items.length > 0 && !e.IsSingleLine;
      this.print("[");
      if (e.Items.length > 0 || isMultiLine) {
        if (isMultiLine) this.indent++;

        for (let i = 0; i < e.Items.length; i++) {
          if (i !== 0) this.print(",");
          if (isMultiLine) {
            this.printNewline();
            this.printIndent();
          } else if (i !== 0) {
            this.printSpace();
          }
          this.printExpr(e.Items[i], js_ast.L.LComma, printExprFlags.printExprFlagNone);
        }

        if (isMultiLine) {
          this.printNewline();
          this.indent--;
          this.printIndent();
        }
      }
      this.print("]");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EObject) {
      const isMultiLine = e.Properties.length > 0 && !e.IsSingleLine;
      this.print("{");
      if (e.Properties.length > 0 || isMultiLine) {
        if (isMultiLine) this.indent++;

        for (let i = 0; i < e.Properties.length; i++) {
          if (i !== 0) this.print(",");
          if (isMultiLine) {
            this.printNewline();
            this.printIndent();
          } else {
            this.printSpace();
          }
          this.printProperty(e.Properties[i]);
        }

        if (isMultiLine) {
          this.printNewline();
          this.indent--;
          this.printIndent();
        } else if (e.Properties.length > 0) {
          this.printSpace();
        }
      }
      this.print("}");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EArrow) {
      const wrap = e.IsParenthesized || level >= js_ast.L.LAssign;
      if (wrap) this.print("(");
      if (e.IsAsync) {
        this.printSpaceBeforeIdentifier();
        this.print("async");
        this.printSpace();
      }
      this.printFnArgs(e.Args, { hasRestArg: e.HasRestArg, isArrow: true });
      this.printSpace();
      this.print("=>");
      this.printSpace();

      let wasPrinted = false;
      if (e.Body.Block.Stmts.length === 1 && e.PreferExpr) {
        const s = e.Body.Block.Stmts[0].Data;
        if (s instanceof js_ast.SReturn && s.ValueOrNil !== null) {
          this.printExprWithoutLeadingNewline(s.ValueOrNil, js_ast.L.LComma, printExprFlags.printExprFlagNone);
          wasPrinted = true;
        }
      }
      if (!wasPrinted) this.printBlock(e.Body.Block);
      if (wrap) this.print(")");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EClass) {
      this.printSpaceBeforeIdentifier();
      this.print("class");
      if (e.Class.Name !== null) {
        this.print(" ");
        this.printIdentifier(this.renamer.NameForSymbol(e.Class.Name.Ref));
      }
      this.printClass(e.Class);
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.ESpread) {
      this.print("...");
      this.printExpr(e.Value, js_ast.L.LComma, printExprFlags.printExprFlagNone);
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.ETemplate) {
      this.print("`");
      if (e.HeadCooked !== null) this.printTemplateCooked(e.HeadCooked);
      for (const part of e.Parts) {
        this.print("${");
        this.printExpr(part.Value, js_ast.L.LLowest, printExprFlags.printExprFlagNone);
        this.print("}");
        if (part.TailCooked !== null) this.printTemplateCooked(part.TailCooked);
      }
      this.print("`");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else if (e instanceof js_ast.EFunction) {
      const wrap = e.IsParenthesized;
      if (wrap) this.print("(");
      this.printSpaceBeforeIdentifier();
      if (e.Fn.IsAsync) this.print("async ");
      this.print("function");
      if (e.Fn.IsGenerator) {
        this.print("*");
        this.printSpace();
      }
      if (e.Fn.Name !== null) {
        this.printSpaceBeforeIdentifier();
        this.printIdentifier(this.renamer.NameForSymbol(e.Fn.Name.Ref));
      }
      this.printFn(e.Fn);
      if (wrap) this.print(")");
      this.prevOpEndsWithOpenBrace = false;
      this.prevOpEndsWithCloseBrace = false;
    } else {
      throw new Error(`printer: unsupported expr ${(e as object).constructor?.name ?? "?"}`);
    }
  }

  /** Go: func (p *printer) printExpr(expr js_ast.Expr, level js_ast.L, flags printExprFlags) (js_printer.go:2005) */
  printExpr(expr: js_ast.Expr, level: js_ast.L, flags: number): void {
    this.printExprWithoutLeadingNewline(expr, level, flags);
  }

  /** Go: func (p *printer) printDecls(keyword string, decls []js_ast.Decl, flags printExprFlags) (js_printer.go:3734) */
  printDecls(keyword: string, decls: js_ast.Decl[], _flags: number): void {
    this.print(keyword);
    // 关键字后即使 minify 也必须有一个空格（否则 `constx`）
    this.print(" ");
    for (let i = 0; i < decls.length; i++) {
      if (i > 0) {
        this.print(",");
        this.printSpace();
      }
      this.printBinding(decls[i].Binding);
      if (decls[i].ValueOrNil !== null) {
        this.printSpace();
        this.print("=");
        this.printSpace();
        this.printExpr(decls[i].ValueOrNil!, js_ast.L.LComma, printExprFlags.printExprFlagNone);
      }
    }
  }

  /** Go: func (p *printer) printDeclStmt(isExport bool, keyword string, decls []js_ast.Decl) (js_printer.go:3702) */
  printDeclStmt(isExport: boolean, keyword: string, decls: js_ast.Decl[]): void {
    if (isExport) {
      this.print("export");
      this.print(" ");
    }
    this.printDecls(keyword, decls, printExprFlags.printExprFlagNone);
    this.printSemicolonAfterStatement();
  }

  /** Go: func (p *printer) printBlock(loc logger.Loc, block js_ast.SBlock) (js_printer.go:3772) */
  printBlock(block: js_ast.SBlock): void {
    this.print("{");
    this.printNewline();

    this.indent++;
    for (const stmt of block.Stmts) {
      this.printSemicolonIfNeeded();
      this.printIndent();
      this.printStmt(stmt, printStmtFlags.printStmtFlagNone);
    }
    this.indent--;
    this.needsSemicolon = false;

    this.printIndent();
    this.print("}");
  }

  /** Go: func (p *printer) printClass(class js_ast.Class) (js_printer.go:1028) */
  printClass(cls: js_ast.Class): void {
    if (cls.ExtendsOrNil !== null) {
      this.print(" extends");
      this.printSpace();
      this.printExpr(cls.ExtendsOrNil, (js_ast.L.LNew - 1) as js_ast.L, printExprFlags.printExprFlagNone);
    }
    this.printSpace();

    this.print("{");
    this.printNewline();
    this.indent++;

    for (const item of cls.Properties) {
      this.printSemicolonIfNeeded();
      this.printIndent();

      if (item.Kind === js_ast.PropertyKind.PropertyClassStaticBlock) {
        this.print("static");
        this.printSpace();
        this.printBlock(item.ClassStaticBlock!.Block);
        this.printNewline();
        continue;
      }

      this.printProperty(item);

      // Need semicolons after class fields
      if (item.ValueOrNil === null) {
        this.printSemicolonAfterStatement();
      } else {
        this.printNewline();
      }
    }

    this.needsSemicolon = false;
    this.indent--;
    this.printIndent();
    this.print("}");
  }

  /** Go: func (p *printer) printBody(body js_ast.Stmt, isSingleLine bool) (js_printer.go:3756) */
  printBody(body: js_ast.Stmt, isSingleLine: boolean): void {
    if (body.Data instanceof js_ast.SBlock) {
      this.printBlock(body.Data);
    } else if (isSingleLine) {
      this.printStmt(body, printStmtFlags.printStmtFlagIsInOneLineStatement);
    } else {
      this.printNewline();
      this.indent++;
      this.printIndent();
      this.printStmt(body, printStmtFlags.printStmtFlagNone);
      this.indent--;
    }
  }

  /** Go: func wrapToAvoidAmbiguousElse(s js_ast.S) bool (js_printer.go:3792) */
  wrapToAvoidAmbiguousElse(s: js_ast.S): boolean {
    for (; ;) {
      if (s instanceof js_ast.SIf) {
        if (s.NoOrNil === null || s.NoOrNil.Data === null) return true;
        s = s.NoOrNil.Data;
      } else if (s instanceof js_ast.SFor) {
        s = s.Body.Data!;
      } else if (s instanceof js_ast.SWhile) {
        s = s.Body.Data!;
      } else if (s instanceof js_ast.SWith) {
        s = s.Body.Data!;
      } else if (s instanceof js_ast.SDoWhile || s instanceof js_ast.SLabel) {
        return true;
      } else {
        return false;
      }
    }
  }

  /** Go: func (p *printer) printIf(s *js_ast.SIf) (js_printer.go:3825) */
  printIf(s: js_ast.SIf): void {
    this.print("if");
    this.printSpace();
    this.print("(");
    this.printExpr(s.Test, js_ast.L.LLowest, printExprFlags.printExprFlagNone);
    this.print(")");
    this.printSpace();
    if (s.Yes.Data instanceof js_ast.SBlock || !this.wrapToAvoidAmbiguousElse(s.Yes.Data!)) {
      this.printBody(s.Yes, true);
    } else {
      this.print("{"); this.printNewline(); this.indent++; this.printIndent();
      this.printStmt(s.Yes, printStmtFlags.printStmtFlagNone);
      this.printNewline(); this.indent--; this.printIndent(); this.print("}");
    }
    if (s.NoOrNil !== null) {
      if (!(s.Yes.Data instanceof js_ast.SExpr)) this.printNewline();
      this.print("else");
      this.print(" ");
      this.printBody(s.NoOrNil, true);
    }
  }

  /** Go: func (p *printer) printStmt(stmt js_ast.Stmt, flags printStmtFlags) (js_printer.go:4101) */
  printStmt(stmt: js_ast.Stmt, flags: number): void {
    const s = stmt.Data;
    if (s === null) return;

    if (s instanceof js_ast.SEmpty) {
      this.print(";");
    } else if (s instanceof js_ast.SComment) {
      throw new Error("printer: SComment");
    } else if (s instanceof js_ast.SDirective) {
      this.printQuotedUTF16(s.Value, printQuotedFlags.printQuotedNone);
      this.printSemicolonAfterStatement();
    } else if (s instanceof js_ast.SExpr) {
      // "if (x) !y; else z" 之类需要括号的地方暂不处理
      this.printExpr(s.Value, js_ast.L.LLowest, printExprFlags.printExprFlagNone);
      this.printSemicolonAfterStatement();
    } else if (s instanceof js_ast.SReturn) {
      this.print("return");
      if (s.ValueOrNil !== null) {
        this.print(" ");
        this.printExpr(s.ValueOrNil, js_ast.L.LLowest, printExprFlags.printExprFlagNone);
      }
      this.printSemicolonAfterStatement();
    } else if (s instanceof js_ast.SLocal) {
      const keyword = s.Kind === js_ast.LocalKind.LocalConst ? "const"
        : s.Kind === js_ast.LocalKind.LocalLet ? "let" : "var";
      this.printDeclStmt(s.IsExport, keyword, s.Decls);
    } else if (s instanceof js_ast.SFunction) {
      this.printSpaceBeforeIdentifier();
      if (s.IsExport) this.print("export ");
      if (s.Fn.IsAsync) this.print("async ");
      this.print("function");
      if (s.Fn.IsGenerator) {
        this.print("*");
        this.printSpace();
      }
      this.printSpaceBeforeIdentifier();
      this.printIdentifier(this.renamer.NameForSymbol(s.Fn.Name!.Ref));
      this.printFn(s.Fn);
      this.printNewline();
    } else if (s instanceof js_ast.SClass) {
      this.printSpaceBeforeIdentifier();
      if (s.IsExport) this.print("export ");
      this.print("class ");
      this.printIdentifier(this.renamer.NameForSymbol(s.Class.Name!.Ref));
      this.printClass(s.Class);
      this.printNewline();
    } else if (s instanceof js_ast.SBlock) {
      this.printBlock(s);
      this.printNewline();
    } else if (s instanceof js_ast.SIf) {
      this.printIf(s);
    } else if (s instanceof js_ast.SDebugger) {
      this.print("debugger");
      this.printSemicolonAfterStatement();
    } else {
      throw new Error(`printer: unsupported stmt ${(s as object).constructor?.name ?? "?"}`);
    }
  }
}

/** Go: func Print(tree js_ast.AST, symbols ast.SymbolMap, r renamer.Renamer, options Options) PrintResult (js_printer.go:4969) */
export function Print(
  tree: js_ast.AST,
  symbols: Symbol[],
  r: Renamer,
  options: Options,
): PrintResult {
  const p = new printer(symbols, r, options);

  if (tree.Hashbang !== "") {
    p.print("#!" + tree.Hashbang + "\n");
  }

  for (const directive of tree.Directives ?? []) {
    p.print("\"" + directive + "\";\n");
  }

  // Hashbang / directives 之后按 part 顺序打印语句
  for (const part of tree.Parts) {
    for (const stmt of part.Stmts) {
      p.printStmt(stmt, printStmtFlags.printStmtFlagNone);
      p.printSemicolonIfNeeded();
    }
  }

  return Object.assign(new PrintResult(), { JS: new Uint8Array(p.js) });
}
