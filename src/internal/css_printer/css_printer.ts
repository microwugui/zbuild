// 1:1 移植自 esbuild internal/css_printer/css_printer.go（v0.28.2，commit f6058f83）
// 第 64 轮叶子优先规划：CSS 打印纯助手。真值表由 Go 探针固化在 testdata/css-printer-pure-go.json。
import { T, Token, Rule, CSSAST, RAtCharset, RAtImport, RAtKeyframes, RKnownAt, RUnknownAt, RSelector, RQualified, RDeclaration, RBadDeclaration, RComment, RAtLayer, RAtMedia, RAtScope, MediaQuery, MQArbitraryTokens, MQType, MQNot, MQBinary, MQPlainOrBoolean, MQRange, ComplexSelector, CompoundSelector, SubclassSelector, NamespacedName, SSHash, SSClass, SSAttribute, SSPseudoClass, SSPseudoClassWithSelectorList, NthIndex, MQCmpString, PseudoClassKindString } from "../css_ast/css_ast.ts";
import { IsNameContinue, WouldStartIdentifierWithoutEscapes } from "../css_lexer/css_lexer.ts";
import { decodeRune } from "../logger/bytes.ts";
import { EscapeClosingTag } from "../helpers/comment.ts";
import { QuoteForJSON } from "../helpers/quote.ts";
import { FollowSymbols, Get, SymbolMap, ImportRecordFlags } from "../ast/ast.ts";
import { Ref } from "../ast/ast.ts";
const decodeRuneCss = (bytes: Uint8Array): { r: number; width: number } => decodeRune(bytes, 0);
const te2 = new TextEncoder();

// Go: mqFlags (css_printer.go:412)
const mqNeedsParens = 1, mqAfterIdentifier = 2;
// Go: selectorLayout (css_printer.go:565)
const layoutMultiLine = 0, layoutSingleLine = 1;
// Go: identMode / trailingWhitespace (css_printer.go:1010/1020)
const imNorm = 0, imHash = 1, imDimUnit = 2, imDimUnitAfterExp = 3;
const wsMayNeed = 0, wsCanDiscard = 1;
const InlineStyle = 1 << 6; // compat.CSSFeature

/** Go: const quoteForURL byte = 0 (css_printer.go:18) */
const quoteForURL = 0;

/** Go: func bestQuoteCharForString(text string, forURL bool) byte (css_printer.go:807) */
export function bestQuoteCharForString(text: string, forURLFlag: boolean): number {
  let forURLCost = 0;
  let singleCost = 2;
  let doubleCost = 2;
  for (const c of text) {
    switch (c) {
      case "'": forURLCost++; singleCost++; break;
      case '"': forURLCost++; doubleCost++; break;
      case "(": case ")": case " ": case "\t": forURLCost++; break;
      case "\\": case "\n": case "\r": case "\f": forURLCost++; singleCost++; doubleCost++; break;
    }
  }
  if (forURLFlag && forURLCost < singleCost && forURLCost < doubleCost) return quoteForURL;
  if (singleCost < doubleCost) return 0x27;
  return 0x22;
}

/** Go: func functionMultiLineCommaPeriod(token css_ast.Token) uint8 (css_printer.go:1132) */
export function functionMultiLineCommaPeriod(token: Token): number {
  if (token.Kind === T.TFunction && token.Children !== null) {
    let commaCount = 0;
    for (const t of token.Children) if (t.Kind === T.TComma) commaCount++;
    switch (token.Text.toLowerCase()) {
      case "linear-gradient": case "radial-gradient": case "conic-gradient":
      case "repeating-linear-gradient": case "repeating-radial-gradient": case "repeating-conic-gradient":
        if (commaCount >= 2) return 1;
        break;
      case "matrix":
        if (commaCount === 5) return 2;
        break;
      case "matrix3d":
        if (commaCount === 15) return 4;
        break;
    }
  }
  return 0;
}

/** Go: type printer struct (css_printer.go:20) —— 只落输出助手用到的字段 */
export class Printer {
  css: number[] = [];
  oldLineStart: number = 0;
  oldLineEnd: number = 0;
  lineLimit: number = 0;
  minifyWhitespace: boolean = false;
  asciiOnly: boolean = false;
  unsupportedFeatures: number = 0;
  symbols: SymbolMap = new SymbolMap();
  localNames: Map<string, string> = new Map<string, string>();
  // print-chain state (css_printer.go:20)
  importRecords: any[] = [];
  legalComments: number = 0;
  hasLegalComment: Set<string> | null = null;
  extractedLegalComments: string[] = [];
  jsonMetadataImports: string[] = [];
  inputSourceIndex: number = 0;
  needsMetafile: boolean = false;
  metafileMinify: boolean = false;

  /** Go: func (p *printer) print(text string) (css_printer.go:803) */
  print(text: string): void {
    for (const b of new TextEncoder().encode(text)) this.css.push(b);
  }

  /** Go: func (p *printer) printIndent(indent int32) (css_printer.go:1116) */
  printIndent(indent: number): void {
    let n = indent;
    if (this.lineLimit > 0 && n * 2 >= this.lineLimit) n = Math.floor(this.lineLimit / 2);
    for (let i = 0; i < n; i++) this.css.push(0x20, 0x20);
  }

  /** Go: func (p *printer) printNthIndex(index css_ast.NthIndex) (css_printer.go:732) */
  printNthIndex(index: NthIndex): void {
    if (index.A !== "") {
      if (index.A === "-1") this.print("-");
      else if (index.A !== "1") this.print(index.A);
      this.print("n");
      if (index.B !== "") {
        if (!index.B.startsWith("-")) this.print("+");
        this.print(index.B);
      }
    } else if (index.B !== "") {
      this.print(index.B);
    }
  }

  /** Go: func (p *printer) printWithEscape(c rune, escape escapeKind, remainingText string, mayNeedWhitespaceAfter bool) (css_printer.go:863) */
  printWithEscape(c: number, escape: number, remainingText: string, mayNeedWhitespaceAfter: boolean): void {
    const utf8 = new TextEncoder();
    if (escape === 1 /* escapeBackslash */ && ((c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46))) escape = 2 /* escapeHex */;
    if (escape === 0 /* escapeNone */) {
      for (const b of utf8.encode(String.fromCodePoint(c))) this.css.push(b);
    } else if (escape === 1 /* escapeBackslash */) {
      this.css.push(0x5c);
      for (const b of utf8.encode(String.fromCodePoint(c))) this.css.push(b);
    } else {
      // escapeHex: Go fmt.Sprintf("\\%x", c)
      for (const b of utf8.encode("\\" + c.toString(16))) this.css.push(b);
      if (c.toString(16).length < 6) {
        const width = utf8.encode(String.fromCodePoint(c)).length;
        const remainingBytes = utf8.encode(remainingText);
        if (width < remainingBytes.length) {
          const next = remainingBytes[width];
          if (next === 0x20 || next === 0x09 || (next >= 0x30 && next <= 0x39) || (next >= 0x61 && next <= 0x66) || (next >= 0x41 && next <= 0x46)) this.css.push(0x20);
        } else if (mayNeedWhitespaceAfter) {
          this.css.push(0x20);
        }
      }
    }
  }

  /** Go: func (p *printer) printNewlinePastLineLimit(indent int32) bool (css_printer.go:999) */
  printNewlinePastLineLimit(indent: number): boolean {
    if (this.currentLineLength() < this.lineLimit) return false;
    this.print("\n");
    if (!this.minifyWhitespace) this.printIndent(indent);
    return true;
  }

  /** Go: func (p *printer) printIdent(text string, mode identMode, whitespace trailingWhitespace) (css_printer.go:1027) */
  printIdent(text: string, mode: number, whitespace: number): void {
    const n = new TextEncoder().encode(text).length;
    let initialEscape = 0; // escapeNone
    const identNormal = 0, identHash = 1, identDimensionUnit = 2, identDimensionUnitAfterExponent = 3;
    if (mode === identNormal) {
      if (!WouldStartIdentifierWithoutEscapes(text)) initialEscape = 1; // escapeBackslash
    } else if (mode === identDimensionUnit || mode === identDimensionUnitAfterExponent) {
      if (!WouldStartIdentifierWithoutEscapes(text)) initialEscape = 1;
      else if (n > 0) {
        const c = text.charCodeAt(0);
        if (c >= 0x30 && c <= 0x39) initialEscape = 2; // escapeHex
        else if ((c === 0x65 || c === 0x45) && mode !== identDimensionUnitAfterExponent) {
          if (n >= 2 && text.charCodeAt(1) >= 0x30 && text.charCodeAt(1) <= 0x39) initialEscape = 2;
          else if (n >= 3 && text.charCodeAt(1) === 0x2d && text.charCodeAt(2) >= 0x30 && text.charCodeAt(2) <= 0x39) initialEscape = 2;
        }
      }
    }

    // Fast path
    if (initialEscape === 0) {
      let needsEscape = false;
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c >= 0x80 || !IsNameContinue(c)) { needsEscape = true; break; }
      }
      if (!needsEscape) { this.print(text); return; }
    }

    // Slow path: iterate runes
    let i = 0;
    for (const c of text) {
      const cp = c.codePointAt(0)!;
      let escape = 0;
      const width = new TextEncoder().encode(c).length;
      if (this.asciiOnly && cp >= 0x80) escape = 2;
      else if (cp === 0x0d || cp === 0x0a || cp === 0x0c || cp === 0xFEFF) escape = 2;
      else {
        if (!IsNameContinue(cp)) escape = 1;
        if (i === 0 && initialEscape !== 0) escape = initialEscape;
      }
      const mayNeed = whitespace === 0 /* mayNeedWhitespaceAfter */ && escape !== 0 && i + width === n;
      this.printWithEscape(cp, escape, text.slice(i), mayNeed);
      i += width;
    }
  }

  /** Go: func (p *printer) printSymbol(loc logger.Loc, ref ast.Ref, mode identMode, whitespace trailingWhitespace) (css_printer.go:1100) */
  printSymbol(ref: Ref, mode: number, whitespace: number): void {
    ref = FollowSymbols(this.symbols, ref);
    const originalName = Get(this.symbols, ref).OriginalName;
    const key = `${ref.SourceIndex}:${ref.InnerIndex}`;
    const local = this.localNames.get(key);
    const name = local !== undefined ? local : originalName;
    this.printIdent(name, mode, whitespace);
  }

  /** Go: func (p *printer) printQuotedWithQuote(text string, quote byte, flags printQuotedFlags) (css_printer.go:903) */
  printQuotedWithQuote(text: string, quote: number, flags: number): void {
    const InlineStyle = 1 << 6;
    const quoteForURL = 0, printQuotedNoWrap = 1;
    if (quote !== quoteForURL) this.print(String.fromCharCode(quote));
    const bytes = new TextEncoder().encode(text);
    const n = bytes.length;
    let i = 0, runStart = 0;
    let startLineLength = 0, wrapLongLines = false;
    if (this.lineLimit > 0 && quote !== quoteForURL && (flags & printQuotedNoWrap) === 0) {
      startLineLength = this.currentLineLength();
      if (startLineLength > this.lineLimit) startLineLength = this.lineLimit;
      wrapLongLines = true;
    }
    const utf8 = new TextDecoder();
    const pushRun = (end: number): void => { for (let k = runStart; k < end; k++) this.css.push(bytes[k]); };
    while (i < n) {
      if (wrapLongLines && startLineLength + i >= this.lineLimit) {
        if (runStart < i) { pushRun(i); runStart = i; }
        this.css.push(0x5c, 0x0a);
        startLineLength -= this.lineLimit;
      }
      // decode one rune at i
      const slice = bytes.subarray(i);
      const d = decodeRuneCss(slice);
      const c = d.r, width = d.width;
      let escape = 0;
      if (c === 0x00 || c === 0x0d || c === 0x0a || c === 0x0c) escape = 2;
      else if (c === 0x5c || c === quote) escape = 1;
      else if (c === 0x28 || c === 0x29 || c === 0x20 || c === 0x09 || c === 0x22 || c === 0x27) {
        if (quote === quoteForURL) escape = 1;
      } else if (c === 0x2f) {
        if (!(this.unsupportedFeatures & InlineStyle) && i >= 1 && bytes[i - 1] === 0x3c && i + 6 <= n &&
          utf8.decode(bytes.subarray(i + 1, i + 6)).toLowerCase() === "style") escape = 1;
      } else {
        if ((this.asciiOnly && c >= 0x80) || c === 0xFEFF) escape = 2;
      }
      if (escape !== 0) {
        if (runStart < i) pushRun(i);
        this.printWithEscape(c, escape, utf8.decode(slice), false);
        runStart = i + width;
      }
      i += width;
    }
    if (runStart < n) pushRun(n);
    if (quote !== quoteForURL) this.print(String.fromCharCode(quote));
  }

  /** Go: func (p *printer) printQuoted(text string, flags printQuotedFlags) (css_printer.go:851) */
  printQuoted(text: string, flags: number): void {
    this.printQuotedWithQuote(text, bestQuoteCharForString(text, false), flags);
  }

  /** Go: func (p *printer) currentLineLength() int (css_printer.go:982) */
  currentLineLength(): number {
    const css = this.css;
    const n = css.length;
    const stop = this.oldLineEnd;
    for (let i = n; i > stop; i--) {
      if (css[i - 1] === 0x0d || css[i - 1] === 0x0a) { this.oldLineStart = i; break; }
    }
    return n - this.oldLineStart;
  }

  /** Go: func (p *printer) recordImportPathForMetafile(importRecordIndex uint32) (css_printer.go:86) */
  recordImportPathForMetafile(importRecordIndex: number): void {
    if (!this.needsMetafile) return;
    const record = this.importRecords[importRecordIndex];
    let external = "";
    if (((record.Flags ?? 0) & ImportRecordFlags.ShouldNotBeExternalInMetafile) === 0) external = ",\n          \"external\": true";
    const pathJ = new TextDecoder().decode(QuoteForJSON(te2.encode(record.Path?.Text ?? record.path ?? ""), this.asciiOnly));
    const kindJ = new TextDecoder().decode(QuoteForJSON(te2.encode(record.Kind?.StringForMetafile?.() ?? "import-statement"), this.asciiOnly));
    const tpl = this.metafileMinify
      ? `\n        {\n          \"path\": ${pathJ},\n          \"kind\": ${kindJ}${external}\n        }`
      : `\n        {\n          \"path\": ${pathJ},\n          \"kind\": ${kindJ}${external}\n        }`;
    this.jsonMetadataImports.push(tpl);
  }

  /** Go: func (p *printer) printIndentedComment(indent int32, text string) (css_printer.go:538) */
  printIndentedComment(indent: number, text: string): void {
    if (!(this.unsupportedFeatures & InlineStyle)) {
      text = new TextDecoder().decode(EscapeClosingTag(te2.encode(text), te2.encode("/style")));
    }
    for (;;) {
      const newline = text.indexOf("\n");
      if (newline === -1) break;
      this.print(text.slice(0, newline + 1));
      if (!this.minifyWhitespace) this.printIndent(indent);
      text = text.slice(newline + 1);
    }
    this.print(text);
  }

  /** Go: func (p *printer) printNamespacedName(nsName, whitespace) (css_printer.go:751) */
  printNamespacedName(nsName: NamespacedName, whitespace: number): void {
    if (nsName.NamespacePrefix !== null) {
      const prefix = nsName.NamespacePrefix;
      if (prefix.Kind === T.TIdent) this.printIdent(prefix.Text, imNorm, wsCanDiscard);
      else if (prefix.Kind === T.TDelimAsterisk) this.print("*");
      else throw new Error("Internal error");
      this.print("|");
    }
    const name = nsName.Name;
    if (name.Kind === T.TIdent) this.printIdent(name.Text, imNorm, whitespace);
    else if (name.Kind === T.TDelimAsterisk) this.print("*");
    else if (name.Kind === T.TDelimAmpersand) this.print("&");
    else throw new Error("Internal error");
  }

  /** Go: func (p *printer) printPseudoClassSelector(pseudo, whitespace) (css_printer.go:785) */
  printPseudoClassSelector(pseudo: SSPseudoClass, whitespace: number): void {
    this.print(pseudo.IsElement ? "::" : ":");
    if (pseudo.HasParens) {
      this.printIdent(pseudo.Name, imNorm, wsCanDiscard);
      this.print("(");
      this.printTokens(pseudo.Args, { indent: 0, multiLineCommaPeriod: 0, isDeclaration: false });
      this.print(")");
    } else {
      this.printIdent(pseudo.Name, imNorm, whitespace);
    }
  }

  /** Go: func (p *printer) printComplexSelectors(selectors, indent, layout) (css_printer.go:585) */
  printComplexSelectors(selectors: ComplexSelector[], indent: number, layout: number): void {
    for (let i = 0; i < selectors.length; i++) {
      const complex = selectors[i];
      if (i > 0) {
        if (this.minifyWhitespace) {
          this.print(",");
          if (this.lineLimit > 0) this.printNewlinePastLineLimit(indent);
        } else if (layout === layoutMultiLine) {
          this.print(",\n"); this.printIndent(indent);
        } else this.print(", ");
      }
      for (let j = 0; j < complex.Selectors.length; j++) this.printCompoundSelector(complex.Selectors[j], j === 0, indent);
    }
  }

  /** Go: func (p *printer) printCompoundSelector(sel, isFirst, indent) (css_printer.go:604) */
  printCompoundSelector(sel: CompoundSelector, isFirst: boolean, indent: number): void {
    if (!isFirst && sel.Combinator === 0) {
      if (this.lineLimit <= 0 || !this.printNewlinePastLineLimit(indent)) this.print(" ");
    }
    if (sel.Combinator !== 0) {
      if (!isFirst && !this.minifyWhitespace) this.print(" ");
      this.css.push(sel.Combinator & 0xff);
      if ((this.lineLimit <= 0 || !this.printNewlinePastLineLimit(indent)) && !this.minifyWhitespace) this.print(" ");
    }
    if (sel.TypeSelector !== null) {
      let whitespace = wsMayNeed;
      if (sel.SubclassSelectors.length > 0) whitespace = wsCanDiscard;
      this.printNamespacedName(sel.TypeSelector, whitespace);
    }
    for (const _loc of sel.NestingSelectorLocs) this.print("&");
    for (let i = 0; i < sel.SubclassSelectors.length; i++) {
      const ss = sel.SubclassSelectors[i] as SubclassSelector;
      let whitespace = wsMayNeed;
      if (i + 1 < sel.SubclassSelectors.length) whitespace = wsCanDiscard;
      const d = ss.Data;
      if (d instanceof SSHash) { this.print("#"); this.printSymbol(d.Name.Ref, imNorm, whitespace); }
      else if (d instanceof SSClass) { this.print("."); this.printSymbol(d.Name.Ref, imNorm, whitespace); }
      else if (d instanceof SSAttribute) {
        this.print("[");
        this.printNamespacedName(d.NamespacedName, wsCanDiscard);
        if (d.MatcherOp !== "") {
          this.print(d.MatcherOp);
          let printAsIdent = WouldStartIdentifierWithoutEscapes(d.MatcherValue);
          if (printAsIdent) for (const c of d.MatcherValue) { if (!IsNameContinue(c.codePointAt(0)!)) { printAsIdent = false; break; } }
          if (printAsIdent) this.printIdent(d.MatcherValue, imNorm, wsCanDiscard);
          else this.printQuoted(d.MatcherValue, 0);
        }
        if (d.MatcherModifier !== 0) { this.print(" "); this.print(String.fromCharCode(d.MatcherModifier)); }
        this.print("]");
      }
      else if (d instanceof SSPseudoClass) this.printPseudoClassSelector(d, whitespace);
      else if (d instanceof SSPseudoClassWithSelectorList) {
        this.print(":");
        this.print(PseudoClassKindString(d.Kind));
        this.print("(");
        if (d.Index.A !== "" || d.Index.B !== "") {
          this.printNthIndex(d.Index);
          if (d.Selectors.length > 0) {
            if (this.minifyWhitespace && d.Selectors[0].Selectors[0].TypeSelector === null) this.print(" of");
            else this.print(" of ");
          }
        }
        this.printComplexSelectors(d.Selectors, indent, layoutSingleLine);
        this.print(")");
      }
      else throw new Error("Internal error");
    }
  }

  /** Go: func (p *printer) printMediaQuery(query, flags) (css_printer.go:423) */
  printMediaQuery(query: MediaQuery, flags: number): void {
    const q = query.Data;
    if (q instanceof MQArbitraryTokens) {
      if ((flags & mqAfterIdentifier) !== 0) this.print(" ");
      this.printTokens(q.Tokens, { indent: 0, multiLineCommaPeriod: 0, isDeclaration: false });
      return;
    }
    if (q instanceof MQType) {
      if ((flags & mqAfterIdentifier) !== 0) this.print(" ");
      if (q.Op === 1) this.print("not ");
      else if (q.Op === 2) this.print("only ");
      this.printIdent(q.Type, imNorm, 0);
      if (q.AndOrNull.Data !== null) {
        this.print(" and ");
        let f = 0;
        if (q.AndOrNull.Data instanceof MQBinary && q.AndOrNull.Data.Op === 1) f = mqNeedsParens;
        this.printMediaQuery(q.AndOrNull, f);
      }
    } else if (q instanceof MQNot) {
      if ((flags & mqNeedsParens) !== 0) this.print("(");
      else if ((flags & mqAfterIdentifier) !== 0) this.print(" ");
      this.print("not ");
      this.printMediaQuery(q.Inner, mqNeedsParens);
      if ((flags & mqNeedsParens) !== 0) this.print(")");
    } else if (q instanceof MQBinary) {
      if ((flags & mqNeedsParens) !== 0) this.print("(");
      for (let i = 0; i < q.Terms.length; i++) {
        if (i > 0) {
          if (!this.minifyWhitespace) this.print(" ");
          this.print(q.Op === 0 ? "and " : "or ");
        }
        this.printMediaQuery(q.Terms[i], mqNeedsParens);
      }
      if ((flags & mqNeedsParens) !== 0) this.print(")");
    } else if (q instanceof MQPlainOrBoolean) {
      this.print("(");
      this.printIdent(q.Name, imNorm, 0);
      if (q.ValueOrNil.length > 0) {
        this.print(this.minifyWhitespace ? ":" : ": ");
        this.printTokens(q.ValueOrNil, { indent: 0, multiLineCommaPeriod: 0, isDeclaration: false });
      }
      this.print(")");
    } else if (q instanceof MQRange) {
      const space = this.minifyWhitespace ? "" : " ";
      this.print("(");
      if (q.BeforeCmp !== 0) { this.printTokens(q.Before, { indent: 0, multiLineCommaPeriod: 0, isDeclaration: false }); this.print(space + MQCmpString(q.BeforeCmp) + space); }
      this.printIdent(q.Name, imNorm, 0);
      if (q.AfterCmp !== 0) { this.print(space + MQCmpString(q.AfterCmp) + space); this.printTokens(q.After, { indent: 0, multiLineCommaPeriod: 0, isDeclaration: false }); }
      this.print(")");
    } else throw new Error("Internal error");
  }

  /** Go: func (p *printer) printRuleBlock(rules, indent, closeBraceLoc) (css_printer.go:559) */
  printRuleBlock(rules: Rule[], indent: number, closeBraceLoc: number): void {
    this.print(this.minifyWhitespace ? "{" : "{\n");
    for (let i = 0; i < rules.length; i++) this.printRule(rules[i], indent + 1, this.minifyWhitespace && i + 1 === rules.length);
    if (!this.minifyWhitespace) this.printIndent(indent);
    this.print("}");
  }

  /** Go: func (p *printer) printRule(rule, indent, omitTrailingSemicolon) (css_printer.go:107) */
  printRule(rule: Rule, indent: number, omitTrailingSemicolon: boolean): void {
    const r: any = rule.Data;
    if (r instanceof RComment) {
      if (this.legalComments === 1 /* None */) return;
      if (this.legalComments === 2 || this.legalComments === 3 || this.legalComments === 4) {
        if (this.hasLegalComment === null) this.hasLegalComment = new Set();
        else if (this.hasLegalComment.has(r.Text)) return;
        this.hasLegalComment.add(r.Text);
        this.extractedLegalComments.push(r.Text);
        return;
      }
    }
    if (this.lineLimit > 0) this.printNewlinePastLineLimit(indent);
    if (!this.minifyWhitespace) this.printIndent(indent);

    if (r instanceof RAtCharset) {
      this.print("@charset ");
      this.printQuotedWithQuote(r.Encoding, 0x22, 0);
      this.print(";");
    } else if (r instanceof RAtImport) {
      this.print(this.minifyWhitespace ? "@import" : "@import ");
      const record = this.importRecords[r.ImportRecordIndex];
      let flags = 0;
      if (((record.Flags ?? 0) & ImportRecordFlags.ContainsUniqueKey) !== 0) flags |= 1;
      this.printQuoted(record.Path?.Text ?? record.path ?? "", flags);
      this.recordImportPathForMetafile(r.ImportRecordIndex);
      if (r.ImportConditions !== null) {
        const c = r.ImportConditions;
        let space = !this.minifyWhitespace;
        if (c.Layers.length > 0) { if (space) this.print(" "); this.printTokens(c.Layers, { indent: 0, multiLineCommaPeriod: 0, isDeclaration: false }); space = true; }
        if (c.Supports.length > 0) { if (space) this.print(" "); this.printTokens(c.Supports, { indent: 0, multiLineCommaPeriod: 0, isDeclaration: false }); space = true; }
        if (c.Queries.length > 0) {
          if (space) this.print(" ");
          for (let i = 0; i < c.Queries.length; i++) { if (i > 0) this.print(this.minifyWhitespace ? "," : ", "); this.printMediaQuery(c.Queries[i], 0); }
        }
      }
      this.print(";");
    } else if (r instanceof RAtKeyframes) {
      this.print("@"); this.printIdent(r.AtToken, imNorm, wsMayNeed); this.print(" ");
      this.printSymbol(r.Name.Ref, imNorm, wsCanDiscard);
      if (!this.minifyWhitespace) this.print(" ");
      this.print(this.minifyWhitespace ? "{" : "{\n");
      indent++;
      for (const block of r.Blocks) {
        if (!this.minifyWhitespace) this.printIndent(indent);
        for (let i = 0; i < block.Selectors.length; i++) { if (i > 0) this.print(this.minifyWhitespace ? "," : ", "); this.print(block.Selectors[i]); }
        if (!this.minifyWhitespace) this.print(" ");
        this.printRuleBlock(block.Rules, indent, block.CloseBraceLoc);
        if (!this.minifyWhitespace) this.print("\n");
      }
      indent--;
      if (!this.minifyWhitespace) this.printIndent(indent);
      this.print("}");
    } else if (r instanceof RKnownAt) {
      this.print("@");
      let whitespace = wsMayNeed;
      if (r.Prelude.length === 0) whitespace = wsCanDiscard;
      this.printIdent(r.AtToken, imNorm, whitespace);
      if ((!this.minifyWhitespace && r.Rules.length > 0) || r.Prelude.length > 0) this.print(" ");
      this.printTokens(r.Prelude, { indent: 0, multiLineCommaPeriod: 0, isDeclaration: false });
      if (r.Rules.length === 0) this.print(";");
      else { if (!this.minifyWhitespace && r.Prelude.length > 0) this.print(" "); this.printRuleBlock(r.Rules, indent, r.CloseBraceLoc); }
    } else if (r instanceof RUnknownAt) {
      this.print("@");
      let whitespace = wsMayNeed;
      if (r.Prelude.length === 0) whitespace = wsCanDiscard;
      this.printIdent(r.AtToken, imNorm, whitespace);
      if ((!this.minifyWhitespace && r.Block.length !== 0) || r.Prelude.length > 0) this.print(" ");
      this.printTokens(r.Prelude, { indent: 0, multiLineCommaPeriod: 0, isDeclaration: false });
      if (!this.minifyWhitespace && r.Block.length !== 0 && r.Prelude.length > 0) this.print(" ");
      if (r.Block.length === 0) this.print(";");
      else this.printTokens(r.Block, { indent: 0, multiLineCommaPeriod: 0, isDeclaration: false });
    } else if (r instanceof RSelector) {
      this.printComplexSelectors(r.Selectors, indent, layoutMultiLine);
      if (!this.minifyWhitespace) this.print(" ");
      this.printRuleBlock(r.Rules, indent, r.CloseBraceLoc);
    } else if (r instanceof RQualified) {
      const hasWs = this.printTokens(r.Prelude, { indent: 0, multiLineCommaPeriod: 0, isDeclaration: false });
      if (!hasWs && !this.minifyWhitespace) this.print(" ");
      this.printRuleBlock(r.Rules, indent, r.CloseBraceLoc);
    } else if (r instanceof RDeclaration) {
      this.printIdent(r.KeyText, imNorm, wsCanDiscard);
      this.print(":");
      const hasWs = this.printTokens(r.Value, { indent, multiLineCommaPeriod: 0, isDeclaration: true });
      if (r.Important) {
        if (!hasWs && !this.minifyWhitespace && r.Value.length > 0) this.print(" ");
        this.print("!important");
      }
      if (!omitTrailingSemicolon) this.print(";");
    } else if (r instanceof RBadDeclaration) {
      this.printTokens(r.Tokens, { indent: 0, multiLineCommaPeriod: 0, isDeclaration: false });
      if (!omitTrailingSemicolon) this.print(";");
    } else if (r instanceof RComment) {
      this.printIndentedComment(indent, r.Text);
    } else if (r instanceof RAtLayer) {
      this.print("@layer");
      for (let i = 0; i < r.Names.length; i++) {
        if (i === 0) this.print(" ");
        else if (!this.minifyWhitespace) this.print(", ");
        else this.print(",");
        this.print(r.Names[i].join("."));
      }
      if (r.Rules.length === 0) this.print(";");
      else { if (!this.minifyWhitespace) this.print(" "); this.printRuleBlock(r.Rules, indent, r.CloseBraceLoc); }
    } else if (r instanceof RAtMedia) {
      this.print("@media");
      let flags = 0;
      if (this.minifyWhitespace) flags = mqAfterIdentifier;
      else this.print(" ");
      for (let i = 0; i < r.Queries.length; i++) { if (i > 0) this.print(this.minifyWhitespace ? "," : ", "); this.printMediaQuery(r.Queries[i], flags); flags = 0; }
      if (!this.minifyWhitespace && r.Queries.length > 0) this.print(" ");
      this.printRuleBlock(r.Rules, indent, r.CloseBraceLoc);
    } else if (r instanceof RAtScope) {
      this.print("@scope");
      if (r.Start.length > 0) { this.print(this.minifyWhitespace ? "(" : " ("); this.printComplexSelectors(r.Start, indent, layoutSingleLine); this.print(")"); }
      if (r.End.length > 0) { this.print(this.minifyWhitespace ? "to (" : " to ("); this.printComplexSelectors(r.End, indent, layoutSingleLine); this.print(")"); }
      if (!this.minifyWhitespace) this.print(" ");
      this.printRuleBlock(r.Rules, indent, r.CloseBraceLoc);
    } else throw new Error("Internal error");

    if (!this.minifyWhitespace) this.print("\n");
  }

  /** Go: func (p *printer) printTokens(tokens, opts) bool (css_printer.go:1167) */
  printTokens(tokens: Token[], opts: { indent: number; multiLineCommaPeriod: number; isDeclaration: boolean }): boolean {
    let hasWhitespaceAfter = tokens.length > 0 && ((tokens[0].Whitespace & 1) !== 0);
    let commaPeriod = opts.multiLineCommaPeriod;
    if (!this.minifyWhitespace && opts.isDeclaration) {
      let commaCount = 0;
      for (const t of tokens) {
        if (t.Kind === T.TComma) { commaCount++; if (commaCount >= 2) { commaPeriod = 1; break; } }
        if (t.Kind === T.TFunction && functionMultiLineCommaPeriod(t) > 0) { commaPeriod = 1; break; }
      }
    }
    let commaCount = 0;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.Kind === T.TComma) commaCount++;
      if (t.Kind === T.TWhitespace) { hasWhitespaceAfter = true; continue; }
      if (hasWhitespaceAfter) {
        if (commaPeriod > 0 && (i === 0 || (tokens[i - 1].Kind === T.TComma && commaCount % commaPeriod === 0))) {
          this.print("\n"); this.printIndent(opts.indent + 1);
        } else if (this.lineLimit <= 0 || !this.printNewlinePastLineLimit(opts.indent + 1)) this.print(" ");
      }
      hasWhitespaceAfter = ((t.Whitespace & 2) !== 0) || (i + 1 < tokens.length && ((tokens[i + 1].Whitespace & 1) !== 0));
      let whitespace = hasWhitespaceAfter ? wsMayNeed : wsCanDiscard;

      if (t.Kind === T.TIdent) this.printIdent(t.Text, imNorm, whitespace);
      else if (t.Kind === T.TSymbol) {
        const ref = new Ref(this.inputSourceIndex, t.PayloadIndex);
        this.printSymbol(ref, imNorm, whitespace);
      }
      else if (t.Kind === T.TFunction) { this.printIdent(t.Text, imNorm, whitespace); this.print("("); }
      else if (t.Kind === T.TDimension) {
        const value = t.DimensionValue();
        this.print(value);
        this.printIdent(t.DimensionUnit(), value.includes("e") || value.includes("E") ? imDimUnitAfterExp : imDimUnit, whitespace);
      }
      else if (t.Kind === T.TAtKeyword) { this.print("@"); this.printIdent(t.Text, imNorm, whitespace); }
      else if (t.Kind === T.THash) { this.print("#"); this.printIdent(t.Text, imHash, whitespace); }
      else if (t.Kind === T.TString) this.printQuoted(t.Text, 0);
      else if (t.Kind === T.TURL) {
        const record = this.importRecords[t.PayloadIndex];
        const text = record.Path?.Text ?? record.path ?? "";
        let tryToAvoidQuote = true;
        let flags = 0;
        if (((record.Flags ?? 0) & ImportRecordFlags.ContainsUniqueKey) !== 0) { flags |= 1; tryToAvoidQuote = false; }
        else if (this.lineLimit > 0 && this.currentLineLength() + text.length >= this.lineLimit) tryToAvoidQuote = false;
        this.print("url(");
        this.printQuotedWithQuote(text, bestQuoteCharForString(text, tryToAvoidQuote), flags);
        this.print(")");
        this.recordImportPathForMetafile(t.PayloadIndex);
      }
      else if (t.Kind === T.TUnterminatedString) {
        this.print(t.Text); this.print("\n");
        if (!this.minifyWhitespace) this.printIndent(opts.indent);
        hasWhitespaceAfter = false;
      }
      else this.print(t.Text);

      if (t.Children !== null) {
        let childCommaPeriod = 0;
        if (commaPeriod > 0 && opts.isDeclaration) childCommaPeriod = functionMultiLineCommaPeriod(t);
        if (childCommaPeriod > 0) {
          opts.indent++;
          if (!this.minifyWhitespace) { this.print("\n"); this.printIndent(opts.indent + 1); }
        }
        this.printTokens(t.Children, { indent: opts.indent, multiLineCommaPeriod: childCommaPeriod, isDeclaration: false });
        if (childCommaPeriod > 0) opts.indent--;
        if (t.Kind === T.TFunction || t.Kind === T.TOpenParen) this.print(")");
        else if (t.Kind === T.TOpenBrace) this.print("}");
        else if (t.Kind === T.TOpenBracket) this.print("]");
      }
    }
    if (hasWhitespaceAfter) this.print(" ");
    return hasWhitespaceAfter;
  }
}

/** Go: func Print(tree css_ast.AST, symbols ast.SymbolMap, options Options) PrintResult (css_printer.go:68) */
export function Print(tree: CSSAST, symbols: SymbolMap, options: {
  minifyWhitespace?: boolean; asciiOnly?: boolean; lineLimit?: number;
  needsMetafile?: boolean; metafileMinify?: boolean; inputSourceIndex?: number;
  unsupportedFeatures?: number; leadingWhitespace?: string;
}): { CSS: Uint8Array; extractedLegalComments: string[]; jsonMetadataImports: string[] } {
  const p = new Printer();
  p.minifyWhitespace = options.minifyWhitespace ?? false;
  p.asciiOnly = options.asciiOnly ?? false;
  p.lineLimit = options.lineLimit ?? 0;
  p.needsMetafile = options.needsMetafile ?? false;
  p.metafileMinify = options.metafileMinify ?? false;
  p.inputSourceIndex = options.inputSourceIndex ?? 0;
  p.unsupportedFeatures = options.unsupportedFeatures ?? 0;
  p.symbols = symbols;
  if (options.leadingWhitespace) p.print(options.leadingWhitespace);
  p.importRecords = tree.ImportRecords;
  for (const rule of tree.Rules) p.printRule(rule, 0, false);
  return { CSS: new Uint8Array(p.css), extractedLegalComments: p.extractedLegalComments, jsonMetadataImports: p.jsonMetadataImports };
}
