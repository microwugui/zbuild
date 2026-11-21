// 1:1 移植自 esbuild internal/css_parser/css_parser.go（v0.28.2，commit f6058f83）
// 第 50 轮叶子优先规划：数字字符串压缩助手。真值表由 Go 探针固化在 testdata/css-parser-pure2-go.json。
import { Token, T } from "../css_lexer/css_lexer.ts";
import { Token as ASTToken, SSPseudoClass, SSPseudoClassWithSelectorList, SSAttribute, PseudoClassKindAll } from "../css_ast/css_ast.ts";
import type { ComplexSelector, CompoundSelector } from "../css_ast/css_ast.ts";
import { nonDeprecatedElementsSupportedByIE7 } from "./ie7_elements_generated.ts";
import { Source, Loc, Range, Log, Msg, MsgData, MsgKind, LineColumnTracker, AddID, AddMsgID } from "../logger/logger.ts";
import { MsgID_CSS_CSSSyntaxError, MsgID_CSS_InvalidAtLayer, MsgID_CSS_UnsupportedCSSProperty } from "../logger/msg_ids.ts";
import { String as TToString, DidWarnAboutSingleLineComment } from "../css_lexer/css_lexer.ts";
import { LocRef, Ref, Symbol, SymbolKind, InvalidRef, ImportKind, ImportRecordFlags } from "../ast/ast.ts";
import { Rule, RSelector, RKnownAt, RAtMedia, RAtLayer, RComment, RDeclaration, RBadDeclaration, MediaQueriesEqual, CrossFileEqualityCheck } from "../css_ast/css_ast.ts";
import type { R, MediaQuery } from "../css_ast/css_ast.ts";
import type { SymbolMap } from "../ast/ast.ts";
import { atKnownRuleCanBeRemovedIfEmpty } from "./known_at_rules_generated.ts";
import { knownDeclarations } from "./known_declarations_generated.ts";
import { MaybeCorrectDeclarationTypo } from "../css_ast/css_decl_table.ts";
import { tryToReduceCalcExpression } from "./css_reduce_calc.ts";
// 第 137 批：Options / OptionsFromConfig / Parse / computeCharacterFrequency
import { Loader as ConfigLoader } from "../config/config.ts";
import { CharFreq } from "../ast/ast.ts";
import { Tokenize as TokenizeCSS } from "../css_lexer/css_lexer.ts";
import { CSSAST } from "../css_ast/css_ast.ts";
import { Span as LogSpan, MakeLineColumnTracker as MakeTracker } from "../logger/logger.ts";
const WhitespaceBefore = 1, WhitespaceAfter = 2;

/** Go: func mangleNumber(t string) (string, bool) (css_parser.go:2123) */
export function mangleNumber(t: string): { value: string; changed: boolean } {
  const original = t;
  const dot = t.indexOf(".");
  if (dot !== -1) {
    // Remove trailing zeros
    while (t.length > 0 && t[t.length - 1] === "0") t = t.slice(0, -1);
    // Remove the decimal point if it's unnecessary
    if (dot + 1 === t.length) {
      t = t.slice(0, dot);
      if (t === "" || t === "+" || t === "-") t += "0";
    } else {
      // Remove a leading zero
      if (t.length >= 3 && t[0] === "0" && t[1] === "." && t[2] >= "0" && t[2] <= "9") {
        t = t.slice(1);
      } else if (t.length >= 4 && (t[0] === "+" || t[0] === "-") && t[1] === "0" && t[2] === "." && t[3] >= "0" && t[3] <= "9") {
        t = t[0] + t.slice(2);
      }
    }
  }
  return { value: t, changed: t !== original };
}

/** Go: func mangleDimension(value string, unit string) (string, string, bool) (css_parser.go:2102) */
export function mangleDimension(value: string, unit: string): { value: string; unit: string; ok: boolean } {
  const msLen = 2, sLen = 1;
  if (unit.toLowerCase() === "ms") {
    const shifted = shiftDot(value, -3);
    if (shifted.ok && shifted.value.length + sLen < value.length + msLen) {
      return { value: shifted.value, unit: "s", ok: true };
    }
  }
  if (unit.toLowerCase() === "s") {
    const shifted = shiftDot(value, 3);
    if (shifted.ok && shifted.value.length + msLen < value.length + sLen) {
      return { value: shifted.value, unit: "ms", ok: true };
    }
  }
  return { value: "", unit: "", ok: false };
}

/** Go: func shiftDot(text string, dotOffset int) (string, bool) (css_parser.go:2051) */
export function shiftDot(text: string, dotOffset: number): { value: string; ok: boolean } {
  // This doesn't handle numbers with exponents
  if (text.includes("e") || text.includes("E")) return { value: "", ok: false };

  // Handle a leading sign
  let sign = "";
  if (text.length > 0 && (text[0] === "-" || text[0] === "+")) {
    sign = text[0];
    text = text.slice(1);
  }

  // Remove the dot
  let dot = text.indexOf(".");
  if (dot === -1) dot = text.length;
  else text = text.slice(0, dot) + text.slice(dot + 1);

  // Move the dot
  dot += dotOffset;

  // Remove any leading zeros before the dot
  while (text.length > 0 && dot > 0 && text[0] === "0") {
    text = text.slice(1);
    dot--;
  }

  // Remove any trailing zeros after the dot
  while (text.length > 0 && text.length > dot && text[text.length - 1] === "0") {
    text = text.slice(0, -1);
  }

  // Does this number have no fractional component?
  if (dot >= text.length) {
    return { value: sign + text + "0".repeat(dot - text.length), ok: true };
  }

  // Potentially add leading zeros
  if (dot < 0) {
    text = "0".repeat(-dot) + text;
    dot = 0;
  }

  // Insert the dot again
  return { value: sign + text.slice(0, dot) + "." + text.slice(dot), ok: true };
}

/** Go: type Options struct (css_parser.go:46) —— 第 137 批 */
export class Options {
  cssPrefixData: Map<number, number> | null = null;
  originalTargetEnv = "";
  minifySyntax = false;
  minifyWhitespace = false;
  minifyIdentifiers = false;
  unsupportedCSSFeatures: number | bigint = 0;
  symbolMode = 0;
  /** Go: func (a *Options) Equal(b *Options) bool (css_parser.go:107) */
  Equal(b: Options): boolean {
    if (this.originalTargetEnv !== b.originalTargetEnv ||
        Number(this.unsupportedCSSFeatures) !== Number(b.unsupportedCSSFeatures) ||
        this.minifySyntax !== b.minifySyntax || this.minifyWhitespace !== b.minifyWhitespace ||
        this.minifyIdentifiers !== b.minifyIdentifiers || this.symbolMode !== b.symbolMode) return false;
    const a = this.cssPrefixData, b2 = b.cssPrefixData;
    if ((a === null) !== (b2 === null)) return false;
    if (a !== null && b2 !== null) {
      if (a.size !== b2.size) return false;
      for (const [k, v] of a) if (b2.get(k) !== v) return false;
    }
    return true;
  }
}

/** Go: func OptionsFromConfig(loader config.Loader, options *config.Options) Options (css_parser.go:74) */
export function OptionsFromConfig(loader: number, options: any): Options {
  let symbolMode = 0;
  if (loader === ConfigLoader.LoaderGlobalCSS) symbolMode = 1;
  else if (loader === ConfigLoader.LoaderLocalCSS) symbolMode = 2;
  const o = new Options();
  o.cssPrefixData = options?.CSSPrefixData ?? null;
  o.originalTargetEnv = options?.OriginalTargetEnv ?? "";
  o.minifySyntax = !!options?.MinifySyntax;
  o.minifyWhitespace = !!options?.MinifyWhitespace;
  o.minifyIdentifiers = !!options?.MinifyIdentifiers;
  o.unsupportedCSSFeatures = options?.UnsupportedCSSFeatures ?? 0;
  o.symbolMode = symbolMode;
  return o;
}

/** Go: type parser struct (css_parser.go:18) —— 只落 token 访问器用到的字段 */
export class CSSParser {
  tokens: Token[] = [];
  source: Source = new Source();
  index: number = 0;
  log: Log = new Log();
  tracker: LineColumnTracker = new LineColumnTracker();
  prevError: Loc = new Loc(0);
  stack: number[] = [];
  symbolMode = 0; // 0 disabled, 1 global, 2 local（Go symbolMode）
  nestingIsPresent = false;
  // 第 136 批：parseListOfRules / parseAtRule 主链所需字段（Go parser struct）
  allComments: Range[] = [];
  legalComments: { TokenIndexAfter: number; Loc: number; Text: string; Kind: number }[] = [];
  legalCommentIndex = 0;
  inSelectorSubtree = 0;
  layersPreImport: string[][] | null = null;
  hasSeenAtImport = false;
  enclosingAtMedia: MediaQuery[][] = [];
  options: Options = new Options();
  nestingWarnings: Map<number, boolean> = new Map();
  importRecords: any[] = [];
  composes: Map<any, any> = new Map();
  globalScope: Map<string, LocRef> = new Map();
  localScope: Map<string, LocRef> = new Map();
  symbols: Symbol[] = [];
  localSymbols: LocRef[] = [];
  makeLocalSymbols = false;
  anonLayerCount = 0;
  enclosingLayer: string[] = [];
  layersPostImport: string[][] | null = null;

  /** Go: func (p *parser) computeCharacterFrequency() *ast.CharFreq (css_parser.go:165) */
  computeCharacterFrequency(): CharFreq | null {
    if (!this.options.minifyIdentifiers) return null;
    const cf = new CharFreq();
    const dec = new TextDecoder();
    cf.Scan(dec.decode(this.source.Contents), 1);
    for (const r of this.allComments) cf.Scan(dec.decode(this.source.TextForRange(r)), -1);
    for (const record of this.importRecords) {
      if (!record.IsSourceIndexValid) cf.Scan(record.Path.Text, -1);
    }
    for (const sym of this.symbols) {
      if (sym.Kind === SymbolKind.SymbolLocalCSS) cf.Scan(sym.OriginalName, -sym.UseCountEstimate);
    }
    return cf;
  }

  /** Go: func (p *parser) advance() (css_parser.go:196) */
  advance(): void { if (this.index < this.tokens.length) this.index++; }
  /** Go: func (p *parser) at(index int) css_lexer.Token (css_parser.go:202) */
  at(index: number): Token {
    if (index < this.tokens.length) return this.tokens[index];
    const tk = new Token(); tk.kind = T.TEndOfFile; tk.rangeLoc = this.source.Contents.length; tk.rangeLen = 0;
    return tk;
  }
  /** Go: func (p *parser) current() css_lexer.Token (css_parser.go:212) */
  current(): Token { return this.at(this.index); }
  /** Go: func (p *parser) next() css_lexer.Token (css_parser.go:216) */
  next(): Token { return this.at(this.index + 1); }
  /** Go: func (p *parser) raw() string (css_parser.go:220) */
  raw(): string {
    const t = this.current();
    return new TextDecoder().decode(this.source.Contents.subarray(t.rangeLoc, t.rangeLoc + t.rangeLen));
  }
  /** Go: func (p *parser) decoded() string (css_parser.go:224) */
  decoded(): string { return this.current().DecodedText(this.source.Contents); }
  /** Go: func (p *parser) peek(kind css_lexer.T) bool (css_parser.go:228) */
  peek(kind: number): boolean { return kind === this.current().kind; }
  /** Go: func (p *parser) eat(kind css_lexer.T) bool (css_parser.go:232) */
  eat(kind: number): boolean { if (this.peek(kind)) { this.advance(); return true; } return false; }

  /** Go: func (p *parser) convertTokens(tokens []css_lexer.Token) []css_ast.Token (css_parser.go:1803) */
  convertTokens(tokens: Token[]): ASTToken[] {
    return this.convertTokensHelper(tokens, T.TEndOfFile, {});
  }
  /** Go: func (p *parser) convertTokensHelper(...) (css_parser.go:1814) —— 非 minify/非 calc 路径 */
  convertTokensHelper(
    tokens: Token[], close: number, opts: { verbatimWhitespace?: boolean; allowImports?: boolean; isInsideCalcFunction?: boolean },
    onConsumed?: (n: number) => void,
  ): ASTToken[] {
    const result: ASTToken[] = [];
    let nextWhitespace = 0;
    const dec = new TextDecoder();
    let i = 0;
    for (;;) {
      if (i >= tokens.length) { onConsumed?.(i); break; }
      const t = tokens[i++];
      if (t.kind === close) { onConsumed?.(i); break; }
      let token = new ASTToken();
      token.Kind = t.kind;
      token.Text = t.DecodedText(this.source.Contents);
      token.UnitOffset = t.unitOffset;
      token.Loc = t.rangeLoc;
      token.Whitespace = nextWhitespace;
      nextWhitespace = 0;
      switch (t.kind) {
        case T.TWhitespace:
          if (result.length > 0) result[result.length - 1].Whitespace |= WhitespaceAfter;
          nextWhitespace = WhitespaceBefore;
          continue;
        case T.TURL: {
          token.PayloadIndex = this.importRecords.length;
          const flags = opts.allowImports ? 0 : ImportRecordFlags.IsUnused;
          this.importRecords.push({ Kind: ImportKind.ImportURL, Path: { Text: token.Text }, Range: { Loc: new Loc(t.rangeLoc), Len: t.rangeLen }, Flags: flags });
          token.Text = "";
          break;
        }
        case T.TFunction: {
          const originalFirst = i < tokens.length ? tokens[i] : null;
          const nestedOpts = { ...opts };
          if (token.Text.toLowerCase() === "var") nestedOpts.verbatimWhitespace = true;
          if (token.Text.toLowerCase() === "calc") nestedOpts.isInsideCalcFunction = true;
          let consumed = 0;
          const nested = this.convertTokensHelper(tokens.slice(i), T.TCloseParen, nestedOpts, (n) => { consumed = n; });
          token.Children = nested;
          i += consumed;
          if (this.options.minifySyntax && token.Text.toLowerCase() === "calc") token = tryToReduceCalcExpression(token, !!this.options.minifyWhitespace);
          if (token.Text.toLowerCase() === "url" && nested.length === 1 && nested[0].Kind === T.TString) {
            token.Kind = T.TURL; token.Text = ""; token.Children = [];
            token.PayloadIndex = this.importRecords.length;
            const flags = opts.allowImports ? 0 : ImportRecordFlags.IsUnused;
            this.importRecords.push({ Kind: ImportKind.ImportURL, Path: { Text: nested[0].Text }, Range: { Loc: new Loc(originalFirst ? originalFirst.rangeLoc : token.Loc), Len: originalFirst ? originalFirst.rangeLen : 0 }, Flags: flags });
          }
          break;
        }
        case T.TOpenParen: {
          let consumed = 0;
          token.Children = this.convertTokensHelper(tokens.slice(i), T.TCloseParen, opts, (n) => { consumed = n; });
          i += consumed;
          break;
        }
        case T.TOpenBrace: {
          let consumed = 0;
          const nested = this.convertTokensHelper(tokens.slice(i), T.TCloseBrace, opts, (n) => { consumed = n; });
          if (!opts.verbatimWhitespace && !this.options.minifyWhitespace && nested.length > 0) {
            nested[0].Whitespace |= WhitespaceBefore;
            nested[nested.length - 1].Whitespace |= WhitespaceAfter;
          }
          token.Children = nested;
          i += consumed;
          break;
        }
        case T.TOpenBracket: {
          let consumed = 0;
          token.Children = this.convertTokensHelper(tokens.slice(i), T.TCloseBracket, opts, (n) => { consumed = n; });
          i += consumed;
          break;
        }
      }
      result.push(token);
    }
    if (!opts.verbatimWhitespace) {
      for (let k = 0; k < result.length; k++) {
        if (k === 0) result[k].Whitespace &= ~WhitespaceBefore;
        if (k + 1 === result.length) result[k].Whitespace &= ~WhitespaceAfter;
        if (result[k].Kind === T.TComma) {
          result[k].Whitespace &= ~WhitespaceBefore;
          if (k > 0) result[k - 1].Whitespace &= ~WhitespaceAfter;
          if (this.options.minifyWhitespace) {
            result[k].Whitespace &= ~WhitespaceAfter;
            if (k + 1 < result.length) result[k + 1].Whitespace &= ~WhitespaceBefore;
          } else {
            result[k].Whitespace |= WhitespaceAfter;
            if (k + 1 < result.length) result[k + 1].Whitespace |= WhitespaceBefore;
          }
        }
      }
    }
    return result;
  }

/** Go: func (p *parser) expect(kind css_lexer.T) bool (css_parser.go:241) */
  expect(kind: number): boolean {
  return this.expectWithMatchingLoc(kind, -1);
  }

/** Go: func (p *parser) expectWithMatchingLoc(kind css_lexer.T, matchingLoc logger.Loc) bool (css_parser.go:245) */
  expectWithMatchingLoc(kind: number, matchingLoc: number): boolean {
  if (this.eat(kind)) return true;
  let t = this.current();
  if ((t.flags & DidWarnAboutSingleLineComment) !== 0) return false;

  let text: string;
  let suggestion = "";
  let notes: MsgData[] = [];
  const expected = TToString(kind as any);
  if (expected.startsWith('"') && expected.endsWith('"')) suggestion = expected.slice(1, -1);

  if ((kind === T.TSemicolon || kind === T.TColon) && this.index > 0 && this.at(this.index - 1).kind === T.TWhitespace) {
    text = `Expected ${expected}`;
    t = this.at(this.index - 1);
  } else if ((kind === T.TCloseBrace || kind === T.TCloseBracket || kind === T.TCloseParen) &&
      matchingLoc !== -1 && matchingLoc + 1 <= this.source.Contents.length) {
    const dec = new TextDecoder();
    const c = dec.decode(this.source.Contents.subarray(matchingLoc, matchingLoc + 1));
    text = `Expected ${expected} to go with ${JSON.stringify(c)}`;
    const nd = this.tracker.MsgData(new Range(new Loc(matchingLoc), 1), `The unbalanced ${JSON.stringify(c)} is here:`);
    notes = [nd];
  } else {
    switch (t.kind) {
      case T.TEndOfFile:
      case T.TWhitespace:
        text = `Expected ${expected} but found ${TToString(t.kind as any)}`;
        break;
      case T.TBadURL:
      case T.TBadString:
        text = `Expected ${expected} but found ${TToString(t.kind as any)}`;
        break;
      default:
        text = `Expected ${expected} but found ${JSON.stringify(this.raw())}`;
        break;
    }
  }

  const len = (t.kind === T.TEndOfFile || t.kind === T.TWhitespace) ? 0 : t.rangeLen;
  if (t.rangeLoc > this.prevError.Start) {
    const data = this.tracker.MsgData(new Range(new Loc(t.rangeLoc), len), text);
    if (data.Location) data.Location.Suggestion = suggestion;
    const msg = new Msg();
    msg.Kind = MsgKind.Warning;
    msg.Data = data;
    msg.Notes = notes;
    AddMsgID(this.log, MsgID_CSS_CSSSyntaxError, msg);
    this.prevError = new Loc(t.rangeLoc);
  }
  return false;
  }

/** Go: func (p *parser) unexpected() (css_parser.go:294) */
  unexpected(): void {
  const t = this.current();
  if (t.rangeLoc > this.prevError.Start && (t.flags & DidWarnAboutSingleLineComment) === 0) {
    let text: string;
    let len = t.rangeLen;
    switch (t.kind) {
      case T.TEndOfFile:
      case T.TWhitespace:
        text = `Unexpected ${TToString(t.kind as any)}`;
        len = 0;
        break;
      case T.TBadURL:
      case T.TBadString:
        text = `Unexpected ${TToString(t.kind as any)}`;
        break;
      default:
        text = `Unexpected ${JSON.stringify(this.raw())}`;
        break;
    }
    AddID(this.log, MsgID_CSS_CSSSyntaxError, MsgKind.Warning, this.tracker, new Range(new Loc(t.rangeLoc), len), text);
    this.prevError = new Loc(t.rangeLoc);
  }
  }

/** Go: func (p *parser) parseComponentValue() (css_parser.go:2494) */
  parseComponentValue(): void {
  switch (this.current().kind) {
    case T.TFunction: this.parseBlock(T.TFunction, T.TCloseParen); break;
    case T.TOpenParen: this.parseBlock(T.TOpenParen, T.TCloseParen); break;
    case T.TOpenBrace: this.parseBlock(T.TOpenBrace, T.TCloseBrace); break;
    case T.TOpenBracket: this.parseBlock(T.TOpenBracket, T.TCloseBracket); break;
    case T.TEndOfFile: this.unexpected(); break;
    default: this.advance(); break;
  }
  }

/** Go: func (p *parser) parseBlock(open, close css_lexer.T) (css_parser.go:2516) */
  parseBlock(open: number, close: number): void {
  const current = this.current();
  const matchingStart = current.rangeLoc + current.rangeLen - 1;
  if (this.expect(open)) {
    while (!this.eat(close)) {
      if (this.peek(T.TEndOfFile)) {
        this.expectWithMatchingLoc(close, matchingStart);
        return;
      }
      this.parseComponentValue();
    }
  }
  }

  // ============================================================================
  // 第 119 批：parseURLOrString / expectURLOrString / symbolForName /
  // recordAtLayerRule / expectValidLayerNameIdent（Go 探针 15 例，css-u-go.json）。
  // ============================================================================
  /** Go: func (p *parser) parseURLOrString() (string, logger.Range, bool) (css_parser.go:986) */
  parseURLOrString(): { text: string; range: Range; ok: boolean } {
    const t = this.current();
    switch (t.kind) {
      case T.TString:
      case T.TURL: {
        const text = this.decoded();
        this.advance();
        return { text, range: new Range(new Loc(t.rangeLoc), t.rangeLen), ok: true };
      }
      case T.TFunction: {
        if (this.decoded().toLowerCase() === "url") {
          const matchingStart = t.rangeLoc + t.rangeLen - 1;
          let i = this.index + 1;
          while (this.at(i).kind === T.TWhitespace) i++;
          if (this.at(i).kind === T.TString) {
            const stringIndex = i;
            i++;
            while (this.at(i).kind === T.TWhitespace) i++;
            const close = this.at(i).kind;
            if (close === T.TCloseParen || close === T.TEndOfFile) {
              const st = this.at(stringIndex);
              const text = st.DecodedText(this.source.Contents);
              this.index = i;
              this.expectWithMatchingLoc(T.TCloseParen, matchingStart);
              return { text, range: new Range(new Loc(st.rangeLoc), st.rangeLen), ok: true };
            }
          }
        }
        break;
      }
    }
    return { text: "", range: new Range(), ok: false };
  }

  /** Go: func (p *parser) expectURLOrString() (url string, r logger.Range, ok bool) (css_parser.go:1034) */
  expectURLOrString(): { url: string; range: Range; ok: boolean } {
    const { text, range, ok } = this.parseURLOrString();
    if (!ok) this.expect(T.TURL);
    return { url: text, range, ok };
  }

  /** Go: func (p *parser) symbolForName(loc logger.Loc, name string) ast.LocRef (css_parser.go:311) */
  symbolForName(loc: number, name: string): LocRef {
    const kind: SymbolKind = this.makeLocalSymbols ? SymbolKind.SymbolLocalCSS : SymbolKind.SymbolGlobalCSS;
    const scope = this.makeLocalSymbols ? this.localScope : this.globalScope;
    let entry = scope.get(name);
    if (entry === undefined) {
      entry = new LocRef(new Loc(loc), new Ref(this.source.Index, this.symbols.length));
      const sym = new Symbol(); sym.Kind = kind; sym.OriginalName = name; sym.Link = InvalidRef;
      this.symbols.push(sym);
      scope.set(name, entry);
      if (this.makeLocalSymbols) this.localSymbols.push(entry);
    }
    this.symbols[entry.Ref.InnerIndex].UseCountEstimate++;
    return entry;
  }

  /** Go: func (p *parser) recordAtLayerRule(layers [][]string) (css_parser.go:347) */
  recordAtLayerRule(layers: string[][]): void {
    if (this.anonLayerCount > 0) return;
    for (const layer0 of layers) {
      let layer = layer0;
      if (this.enclosingLayer.length > 0) layer = this.enclosingLayer.concat(layer);
      if (this.layersPostImport === null) this.layersPostImport = [];
      this.layersPostImport.push(layer);
    }
  }

  /** Go: func (p *parser) expectValidLayerNameIdent() (string, bool) (css_parser.go:1788) */
  expectValidLayerNameIdent(): { text: string; ok: boolean } {
    const r = new Range(new Loc(this.current().rangeLoc), this.current().rangeLen);
    const text = this.decoded();
    if (!this.expect(T.TIdent)) return { text: "", ok: false };
    switch (text) {
      case "initial":
      case "inherit":
      case "unset": {
        AddID(this.log, MsgID_CSS_InvalidAtLayer, MsgKind.Warning, this.tracker, r, `${JSON.stringify(text)} cannot be used as a layer name`);
        this.prevError = r.Loc;
        return { text: "", ok: false };
      }
    }
    return { text, ok: true };
  }

  // ============================================================================
  // 第 120 批：dead selector 谓词 + IE7 安全选择器（Go 探针 15 例，css-safe-go.json；
  // 元素表 79 项由 Go 源码机械导出到 ie7_elements_generated.ts）。
  // ============================================================================
  /** Go: func containsDeadSelectors(selectors []css_ast.CompoundSelector) bool (css_parser.go:803) */
  containsDeadSelectors(selectors: CompoundSelector[]): boolean {
    for (const sel of selectors) {
      for (const ss of sel.SubclassSelectors as any[]) {
        const pseudo = ss.Data;
        if (pseudo instanceof SSPseudoClassWithSelectorList && pseudo.Selectors.length === 0 &&
            (pseudo.Kind === PseudoClassKindAll.PseudoClassIs || pseudo.Kind === PseudoClassKindAll.PseudoClassWhere)) return true;
      }
    }
    return false;
  }

  /** Go: func allSelectorsAreDead(selectors []css_ast.ComplexSelector) bool (css_parser.go:816) */
  allSelectorsAreDead(selectors: ComplexSelector[]): boolean {
    for (const sel of selectors) if (!this.containsDeadSelectors(sel.Selectors)) return false;
    return true;
  }

  /** Go: func isSafeSelectors(complexSelectors []css_ast.ComplexSelector) bool (css_parser.go:928) */
  isSafeSelectors(complexSelectors: ComplexSelector[]): boolean {
    for (const complex of complexSelectors) {
      for (const compound of complex.Selectors) {
        if (compound.NestingSelectorLocs.length > 0) return false;
        if (compound.Combinator !== 0) return false;
        const typeSel = compound.TypeSelector as any;
        if (typeSel !== null && typeSel !== undefined) {
          if (typeSel.NamespacePrefix !== null) return false;
          if (typeSel.Name.Kind === T.TIdent && !nonDeprecatedElementsSupportedByIE7.has(typeSel.Name.Text)) return false;
        }
        for (const ss of compound.SubclassSelectors as any[]) {
          const data = ss.Data;
          if (data instanceof SSAttribute) {
            if (data.MatcherModifier !== 0) return false;
          } else if (data instanceof SSPseudoClass) {
            if (data.Args.length === 0 && !data.IsElement) {
              switch (data.Name) {
                case "active": case "first-child": case "hover": case "link": case "visited": continue;
              }
            }
            return false;
          } else if (data instanceof SSPseudoClassWithSelectorList) {
            return false;
          }
        }
      }
    }
    return true;
  }

  // ============================================================================
  // 第 127 批：scanForEndOfRule + mangleRules + DeadRuleRemover（Go 探针 17 例）。
  // ============================================================================
  /** Go: func (p *parser) scanForEndOfRule() (endOfRuleScan, int) (css_parser.go:2308) */
  scanForEndOfRule(): { scan: number; index: number } {
    const unknown = 0, semicolon = 1, openBrace = 2;
    const stack: number[] = [];
    const customIdent = 0, customColon = 1, customAccept = 2, customReject = 3;
    let customProp = customIdent;
    const dec = new TextDecoder();
    for (let i = this.index; i < this.tokens.length; i++) {
      const t = this.tokens[i];
      if (customProp < customAccept) {
        if (customProp === customIdent) {
          if (t.kind === T.TIdent && dec.decode(this.source.Contents.subarray(t.rangeLoc)).startsWith("--")) customProp = customColon;
          else if (t.kind !== T.TWhitespace) customProp = customReject;
        } else if (customProp === customColon) {
          if (t.kind === T.TColon) customProp = customAccept;
          else if (t.kind !== T.TWhitespace) customProp = customReject;
        }
      }
      switch (t.kind) {
        case T.TSemicolon:
          if (stack.length === 0) return { scan: semicolon, index: i };
          break;
        case T.TFunction:
        case T.TOpenParen: stack.push(T.TCloseParen); break;
        case T.TOpenBracket: stack.push(T.TCloseBracket); break;
        case T.TOpenBrace:
          if (stack.length === 0 && customProp !== customAccept) return { scan: openBrace, index: i };
          stack.push(T.TCloseBrace);
          break;
        case T.TCloseParen:
        case T.TCloseBracket:
          if (stack.length > 0 && t.kind === stack[stack.length - 1]) stack.pop();
          break;
        case T.TCloseBrace:
          if (stack.length > 0 && t.kind === stack[stack.length - 1]) stack.pop();
          else return { scan: unknown, index: -1 };
          break;
      }
    }
    return { scan: unknown, index: -1 };
  }

  /** Go: func (p *parser) mangleRules(rules []css_ast.Rule, isTopLevel bool) []css_ast.Rule (css_parser.go:588) */
  mangleRules(rules: Rule[], isTopLevel: boolean): Rule[] {
    const out: Rule[] = [];
    let prevNonComment: R | null = null;
    next: for (const rule of rules) {
      let nextNonComment = rule.Data;
      const d = rule.Data;
      if (d instanceof RKnownAt) {
        if (d.Rules.length === 0 && atKnownRuleCanBeRemovedIfEmpty.has(d.AtToken)) continue next;
      } else if (d instanceof RAtMedia) {
        if (d.Rules.length === 0) continue next;
        for (const queries of this.enclosingAtMedia) if (MediaQueriesEqual(d.Queries, queries, null)) { out.push(...d.Rules); continue next; }
      } else if (d instanceof RSelector) {
        if (d.Rules.length === 0) continue next;
        if (prevNonComment !== null && prevNonComment instanceof RSelector) {
          if (RulesEqualSafe(d.Rules, prevNonComment.Rules) && this.isSafeSelectors(d.Selectors) && this.isSafeSelectors(prevNonComment.Selectors)) {
            nextSelector: for (const sel of d.Selectors) {
              for (const prevSel of prevNonComment.Selectors) if (sel.Equal(prevSel, null)) continue nextSelector;
              prevNonComment.Selectors.push(sel);
            }
            continue next;
          }
        }
      } else if (d instanceof RAtLayer) {
        if (d.Rules.length === 0 && d.Names.length > 0) d.Rules = [];
        else if (d.Rules.length === 1 && d.Names.length === 1) {
          const r2 = d.Rules[0].Data;
          if (r2 instanceof RAtLayer && r2.Names.length === 1) {
            d.Names[0] = d.Names[0].concat(r2.Names[0]);
            d.Rules = r2.Rules;
          }
        }
      } else if (d instanceof RComment) nextNonComment = null;
      if (nextNonComment !== null) prevNonComment = nextNonComment;
      out.push(rule);
    }
    if (!isTopLevel) {
      const remover = MakeDeadRuleMangler({ SymbolsForSource: [] });
      return remover.RemoveDeadRulesInPlace(this.source.Index, out, []);
    }
    return out;
  }
}
function RulesEqualSafe(a: Rule[], b: Rule[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!a[i].Data.Equal(b[i].Data, null)) return false;
  return true;
}
export type { R } from "../css_ast/css_ast.ts";


/** Go: type DeadRuleRemover (css_parser.go:732) */
export class DeadRuleRemover {
  entries = new Map<number, { rules: { data: R; callCounter: number }[] }>();
  calls: { importRecords: any[]; sourceIndex: number }[] = [];
  check = new CrossFileEqualityCheck();
  constructor(symbols: SymbolMap) { this.check.Symbols = symbols; }

  /** Go: func (remover *DeadRuleRemover) RemoveDeadRulesInPlace(sourceIndex uint32, rules []css_ast.Rule, importRecords []ast.ImportRecord) []css_ast.Rule (css_parser.go:742) */
  RemoveDeadRulesInPlace(sourceIndex: number, rules: Rule[], importRecords: any[]): Rule[] {
    const callCounter = this.calls.length;
    this.calls.push({ importRecords, sourceIndex });
    const n = rules.length;
    let start = n;
    for (let i = n - 1; i >= 0; i--) {
      const rule = rules[i];
      const sel = rule.Data as RSelector;
      if (sel instanceof RSelector && allSelectorsAreDead(sel.Selectors)) continue;
      const hashResult = (rule.Data as any).Hash?.();
      if (hashResult && hashResult[1]) {
        const hash = hashResult[0] as number;
        const entry = this.entries.get(hash) ?? { rules: [] };
        let skip = false;
        for (const current of entry.rules) {
          let check: CrossFileEqualityCheck | null = null;
          if (current.callCounter !== callCounter) {
            check = this.check;
            const call = this.calls[current.callCounter];
            check.ImportRecordsA = importRecords; check.ImportRecordsB = call.importRecords;
            check.SourceIndexA = sourceIndex; check.SourceIndexB = call.sourceIndex;
          }
          if ((rule.Data as any).Equal(current.data, check)) { skip = true; break; }
        }
        if (skip) continue;
        entry.rules.push({ data: rule.Data, callCounter });
        this.entries.set(hash, entry);
      }
      start--;
      rules[start] = rule;
    }
    return rules.slice(start);
  }
}

/** Go: func MakeDeadRuleMangler(symbols ast.SymbolMap) DeadRuleRemover (css_parser.go:735) */
export function MakeDeadRuleMangler(symbols: SymbolMap): DeadRuleRemover { return new DeadRuleRemover(symbols); }


/** Go: func allSelectorsAreDead(selectors []css_ast.ComplexSelector) bool (css_parser.go:816) */
export function allSelectorsAreDead(selectors: ComplexSelector[]): boolean {
  for (const sel of selectors) {
    let dead = false;
    for (const compound of sel.Selectors) {
      for (const ss of compound.SubclassSelectors as any[]) {
        const d = ss.Data;
        if (d instanceof SSPseudoClassWithSelectorList && d.Selectors.length === 0 &&
            (d.Kind === PseudoClassKindAll.PseudoClassIs || d.Kind === PseudoClassKindAll.PseudoClassWhere)) dead = true;
      }
    }
    if (!dead) return false;
  }
  return true;
}

  /** Go: func (p *parser) parseDeclaration() css_ast.Rule (css_parser.go:2391) */
export function parseDeclaration(p: CSSParser): Rule {
    const rule = new Rule();
    const keyStart = p.index;
    const keyRange = new Range(new Loc(p.tokens[keyStart].rangeLoc), p.tokens[keyStart].rangeLen);
    const keyIsIdent = p.expect(T.TIdent);
    let ok = false;
    if (keyIsIdent) { p.eat(T.TWhitespace); ok = p.eat(T.TColon); }
    const valueStart = p.index;
    for (;;) {
      const kind = p.current().kind;
      if (kind === T.TEndOfFile || kind === T.TSemicolon || kind === T.TCloseBrace) break;
      p.parseComponentValue();
    }
    if (!ok) {
      if (keyIsIdent) {
        const end = keyRange.End();
        if (end > p.prevError.Start) {
          p.prevError = new Loc(end);
          const data = p.tracker.MsgData(new Range(new Loc(end), 0), "Expected \":\"");
          if (data.Location) data.Location.Suggestion = ":";
          const msg = new Msg(); msg.Kind = MsgKind.Warning; msg.Data = data;
          AddMsgID(p.log, MsgID_CSS_CSSSyntaxError, msg);
        }
      }
      const bad = new RBadDeclaration();
      bad.Tokens = p.convertTokens(p.tokens.slice(keyStart, p.index));
      rule.Loc = keyRange.Loc.Start; rule.Data = bad;
      return rule;
    }
    const keyToken = p.tokens[keyStart];
    const keyText = keyToken.DecodedText(p.source.Contents);
    let value = p.tokens.slice(valueStart, p.index);
    const verbatimWhitespace = keyText.startsWith("--");
    let important = false;
    let i = value.length - 1;
    if (i >= 0 && value[i].kind === T.TWhitespace) i--;
    if (i >= 0 && value[i].kind === T.TIdent && value[i].DecodedText(p.source.Contents).toLowerCase() === "important") {
      i--;
      if (i >= 0 && value[i].kind === T.TWhitespace) i--;
      if (i >= 0 && value[i].kind === 19 /* TDelimExclamation */) { value = value.slice(0, i); important = true; }
    }
    const result = p.convertTokensHelper(value, T.TEndOfFile, { allowImports: true, verbatimWhitespace });
    if (!verbatimWhitespace && result.length > 0) {
      if (p.options.minifyWhitespace) result[0].Whitespace &= ~1 /* WhitespaceBefore */;
      else result[0].Whitespace |= 1 /* WhitespaceBefore */;
    }
    const lower = keyText.toLowerCase();
    const key = knownDeclarations.get(lower) ?? 0;
    if (key === 0) {
      const typo = MaybeCorrectDeclarationTypo(lower);
      if (typo.ok) {
        const data = p.tracker.MsgData(keyRange, `${JSON.stringify(keyText)} is not a known CSS property`);
        if (data.Location) data.Location.Suggestion = typo.value;
        const note = new MsgData(); note.Text = `Did you mean ${JSON.stringify(typo.value)} instead?`;
        const msg = new Msg(); msg.Kind = MsgKind.Warning; msg.Data = data; msg.Notes = [note];
        AddMsgID(p.log, MsgID_CSS_UnsupportedCSSProperty, msg);
      }
    }
    const decl = new RDeclaration();
    decl.Key = key; decl.KeyText = keyText; decl.KeyRange = keyRange;
    decl.Value = result; decl.Important = important;
    rule.Loc = keyRange.Loc.Start; rule.Data = decl;
    return rule;
  }


// 第 136 批：主链五函数所需导入（与 Go css_parser.go 同文件口径）
import { AddIDWithNotes } from "../logger/logger.ts";
import { MsgID_CSS_InvalidAtCharset, MsgID_CSS_UnsupportedAtCharset, MsgID_CSS_InvalidAtImport, MsgID_CSS_UnsupportedAtNamespace } from "../logger/msg_ids.ts";
import { RQualified, RAtCharset, RAtImport, RAtKeyframes, KeyframeBlock, RAtScope, RUnknownAt, ImportConditions, SSClass, IsSingleAmpersand, UsesPseudoElement } from "../css_ast/css_ast.ts";
import { parseSelectorList } from "./css_parser_selector.ts";
import { parseMediaQueryListUntil } from "./css_parser_media.ts";
import { processDeclarations } from "./css_decls.ts";
import { isInvalidAnimationName } from "./css_decls_animation.ts";
import { lowerNestingInRule } from "./css_nesting.ts";
import { specialAtRules } from "./special_at_rules_generated.ts";
import type { composesContext } from "./css_decls_composes.ts";

// Go: type atRuleValidity / atRuleKind
export const atRuleInvalid = 0, atRuleValid = 1, atRuleInvalidAfter = 2;
export const atRuleUnknown = 0, atRuleDeclarations = 1, atRuleInheritContext = 2, atRuleQualifiedOrEmpty = 3, atRuleEmpty = 4;
export const endOfRuleSemicolon = 1, endOfRuleOpenBrace = 2;
const NestingFeature = 2048; // compat.Nesting = 1 << 11

export interface ListOfDeclarationsOpts { composesContext?: composesContext | null; canInlineNoOpNesting?: boolean; }
export interface AtRuleContext {
  afterLoc?: number; charsetValidity?: number; importValidity?: number;
  canInlineNoOpNesting?: boolean; isDeclarationList?: boolean; isTopLevel?: boolean;
}
export interface RuleContext { isTopLevel?: boolean; parseSelectors?: boolean; }
export interface ParseQualifiedRuleOpts { isAlreadyInvalid?: boolean; isTopLevel?: boolean; isDeclarationContext?: boolean; }
export interface ParseSelectorOpts {
  composesContext?: composesContext | null;
  pseudoClassKind?: number; isDeclarationContext?: boolean; stopOnCloseParen?: boolean;
  onlyOneComplexSelector?: boolean; isForgivingSelectorList?: boolean; noLeadingCombinator?: boolean;
}

/** Go: func (p *parser) parseListOfDeclarations(opts listOfDeclarationsOpts) []css_ast.Rule (css_parser.go:508) */
export function parseListOfDeclarations(p: CSSParser, opts: ListOfDeclarationsOpts): Rule[] {
  let list: Rule[] = [];
  let foundNesting = false;
  for (;;) {
    const kind = p.current().kind;
    if (kind === T.TWhitespace || kind === T.TSemicolon) { p.advance(); continue; }
    if (kind === T.TEndOfFile || kind === T.TCloseBrace) {
      list = processDeclarations(p, list, opts.composesContext ?? null);
      if (p.options.minifySyntax) {
        list = p.mangleRules(list, false);
        if (opts.canInlineNoOpNesting) {
          if (foundNesting) {
            const inlineDecls: Rule[] = [];
            let n = 0;
            for (const rule of list) {
              if (rule.Data instanceof RSelector && rule.Data.Selectors.length === 1) {
                const sel = rule.Data.Selectors[0];
                if (sel.Selectors.length === 1 && IsSingleAmpersand(sel.Selectors[0])) {
                  inlineDecls.push(...rule.Data.Rules);
                  continue;
                }
              }
              list[n] = rule; n++;
            }
            list = list.slice(0, n).concat(inlineDecls);
          }
        }
      }
      return list;
    }
    if (kind === T.TAtKeyword) {
      if (p.inSelectorSubtree > 0) p.nestingIsPresent = true;
      list.push(parseAtRule(p, {
        charsetValidity: atRuleInvalid, importValidity: atRuleInvalid,
        canInlineNoOpNesting: !!opts.canInlineNoOpNesting,
        isDeclarationList: true, isTopLevel: false,
      }));
      continue;
    }
    const scan = p.scanForEndOfRule();
    if (scan.scan === endOfRuleOpenBrace) {
      p.nestingIsPresent = true;
      foundNesting = true;
      const rule = parseSelectorRule(p, false, {
        isDeclarationContext: true,
        composesContext: opts.composesContext ?? null,
      });
      if (rule.Data instanceof RSelector && rule.Data.Selectors.length === 1) {
        const first = rule.Data.Selectors[0];
        if (first.Selectors.length === 1) {
          const f = first.Selectors[0];
          if (f.WasEmptyFromLocalOrGlobal && IsSingleAmpersand(f)) {
            list.push(...rule.Data.Rules);
            continue;
          }
        }
      }
      list.push(rule);
    } else {
      list.push(parseDeclaration(p));
    }
  }
}

/** Go: func (p *parser) parseQualifiedRule(opts parseQualifiedRuleOpts) css_ast.Rule (css_parser.go:2254) */
export function parseQualifiedRule(p: CSSParser, opts: ParseQualifiedRuleOpts): Rule {
  const preludeStart = p.index;
  const preludeLoc = p.current().rangeLoc;
  for (;;) {
    const kind = p.current().kind;
    if (kind === T.TOpenBrace || kind === T.TEndOfFile) break;
    if (kind === T.TCloseBrace) { if (!opts.isTopLevel) break; }
    if (kind === T.TSemicolon && opts.isDeclarationContext) {
      const rule = new Rule(); rule.Loc = preludeLoc;
      const d = new RBadDeclaration();
      d.Tokens = p.convertTokens(p.tokens.slice(preludeStart, p.index));
      rule.Data = d;
      return rule;
    }
    p.parseComponentValue();
  }
  const qualified = new RQualified();
  qualified.Prelude = p.convertTokens(p.tokens.slice(preludeStart, p.index));
  const matchingLoc = p.current().rangeLoc;
  if (p.eat(T.TOpenBrace)) {
    qualified.Rules = parseListOfDeclarations(p, {});
    const closeBraceLoc = p.current().rangeLoc;
    if (p.expectWithMatchingLoc(T.TCloseBrace, matchingLoc)) qualified.CloseBraceLoc = closeBraceLoc;
  } else if (!opts.isAlreadyInvalid) {
    p.expect(T.TOpenBrace);
  }
  const rule = new Rule(); rule.Loc = preludeLoc; rule.Data = qualified;
  return rule;
}

/** Go: func (p *parser) parseSelectorRule(isTopLevel bool, opts parseSelectorOpts) css_ast.Rule (css_parser.go:2151) */
export function parseSelectorRule(p: CSSParser, isTopLevel: boolean, opts: ParseSelectorOpts): Rule {
  const local = p.makeLocalSymbols;
  const preludeStart = p.index;
  const { list, ok } = parseSelectorList(p, opts as any);
  if (ok) {
    let canInlineNoOpNesting = true;
    for (const sel of list) {
      if (UsesPseudoElement(sel.Selectors)) { canInlineNoOpNesting = false; break; }
    }
    const selector = new RSelector();
    selector.Selectors = list;
    const matchingLoc = p.current().rangeLoc;
    if (p.expect(T.TOpenBrace)) {
      p.inSelectorSubtree++;
      const declOpts: ListOfDeclarationsOpts = { canInlineNoOpNesting };
      if (opts.composesContext && list.length === 1 && list[0].Selectors.length === 1 && IsSingleAmpersand(list[0].Selectors[0])) {
        declOpts.composesContext = opts.composesContext;
      } else {
        const first = list[0].Selectors[0];
        const cc: composesContext = { parentRefs: [], parentRange: first.Range(), problemRange: new Range() };
        if (opts.composesContext) cc.problemRange = opts.composesContext.parentRange;
        for (const sel of list) {
          const f = sel.Selectors[0];
          if (f.Combinator !== 0) cc.problemRange = new Range(new Loc(f.CombinatorLoc), 1);
          else if (f.TypeSelector !== null && f.TypeSelector !== undefined) cc.problemRange = (f.TypeSelector as any).Range();
          else if (f.NestingSelectorLocs.length > 0) cc.problemRange = new Range(new Loc(f.NestingSelectorLocs[0]), 1);
          else {
            for (let i = 0; i < f.SubclassSelectors.length; i++) {
              const ss = f.SubclassSelectors[i] as any;
              if (ss.Data instanceof SSClass && i === 0) cc.parentRefs.push((ss.Data as SSClass).Name.Ref);
              else cc.problemRange = (ss as { Range: Range }).Range;
            }
          }
          if (cc.problemRange.Len > 0) break;
          if (sel.Selectors.length > 1) { cc.problemRange = sel.Selectors[1].Range(); break; }
        }
        declOpts.composesContext = cc;
      }
      selector.Rules = parseListOfDeclarations(p, declOpts);
      p.inSelectorSubtree--;
      const closeBraceLoc = p.current().rangeLoc;
      if (p.expectWithMatchingLoc(T.TCloseBrace, matchingLoc)) selector.CloseBraceLoc = closeBraceLoc;
      p.makeLocalSymbols = local;
      const rule = new Rule(); rule.Loc = p.tokens[preludeStart].rangeLoc; rule.Data = selector;
      return rule;
    }
  }
  p.makeLocalSymbols = local;
  p.index = preludeStart;
  return parseQualifiedRule(p, {
    isAlreadyInvalid: true, isTopLevel,
    isDeclarationContext: !!opts.isDeclarationContext,
  });
}

/** Go: func (p *parser) parseListOfRules(context ruleContext) []css_ast.Rule (css_parser.go:366) */
export function parseListOfRules(p: CSSParser, context: RuleContext): Rule[] {
  const atCtx: AtRuleContext = {};
  if (context.isTopLevel) {
    atCtx.charsetValidity = atRuleValid;
    atCtx.importValidity = atRuleValid;
    atCtx.isTopLevel = true;
  }
  let rules: Rule[] = [];
  let didFindAtImport = false;
  for (;;) {
    if (context.isTopLevel) p.nestingIsPresent = false;
    while (p.legalCommentIndex < p.legalComments.length) {
      const comment = p.legalComments[p.legalCommentIndex];
      if (comment.TokenIndexAfter > p.index) break;
      if (comment.TokenIndexAfter === p.index) {
        const rule = new Rule(); rule.Loc = comment.Loc;
        const d = new RComment(); d.Text = comment.Text; rule.Data = d;
        rules.push(rule);
      }
      p.legalCommentIndex++;
    }
    const kind = p.current().kind;
    if (kind === T.TEndOfFile) break;
    if (kind === T.TCloseBrace) { if (!context.isTopLevel) break; }
    if (kind === T.TWhitespace) { p.advance(); continue; }
    if (kind === T.TAtKeyword) {
      const rule = parseAtRule(p, atCtx);
      if (context.isTopLevel) {
        const d = rule.Data;
        if (d instanceof RAtCharset) {
          // nothing
        } else if (d instanceof RAtImport) {
          didFindAtImport = true;
          if (atCtx.charsetValidity === atRuleValid) {
            atCtx.afterLoc = rule.Loc; atCtx.charsetValidity = atRuleInvalidAfter;
          }
        } else if (d instanceof RAtLayer) {
          if (atCtx.charsetValidity === atRuleValid) {
            atCtx.afterLoc = rule.Loc; atCtx.charsetValidity = atRuleInvalidAfter;
          }
          if (atCtx.importValidity === atRuleValid && (d.Rules !== null && d.Rules !== undefined && d.Rules.length > 0 || didFindAtImport)) {
            atCtx.afterLoc = rule.Loc; atCtx.charsetValidity = atRuleInvalidAfter; atCtx.importValidity = atRuleInvalidAfter;
          }
        } else {
          if (atCtx.importValidity === atRuleValid) {
            atCtx.afterLoc = rule.Loc; atCtx.charsetValidity = atRuleInvalidAfter; atCtx.importValidity = atRuleInvalidAfter;
          }
        }
      }
      if (p.nestingIsPresent && (Number(p.options.unsupportedCSSFeatures ?? 0) & NestingFeature) !== 0 && context.isTopLevel) {
        rules = lowerNestingInRule(p, rule, rules);
      } else {
        rules.push(rule);
      }
      continue;
    }
    if (kind === T.TCDO || kind === T.TCDC) {
      if (context.isTopLevel) { p.advance(); continue; }
    }
    if (atCtx.importValidity === atRuleValid) {
      atCtx.afterLoc = p.current().rangeLoc;
      atCtx.charsetValidity = atRuleInvalidAfter;
      atCtx.importValidity = atRuleInvalidAfter;
    }
    if (!context.isTopLevel) {
      const scan = p.scanForEndOfRule();
      if (scan.scan === endOfRuleSemicolon) {
        const tokens = p.convertTokens(p.tokens.slice(p.index, scan.index));
        const rule = new Rule(); rule.Loc = p.current().rangeLoc;
        const d = new RBadDeclaration(); d.Tokens = tokens; rule.Data = d;
        rules.push(rule);
        p.index = scan.index + 1;
        continue;
      }
    }
    let rule: Rule;
    if (context.parseSelectors) {
      rule = parseSelectorRule(p, !!context.isTopLevel, {});
    } else {
      rule = parseQualifiedRule(p, { isTopLevel: !!context.isTopLevel });
    }
    if (p.nestingIsPresent && (Number(p.options.unsupportedCSSFeatures ?? 0) & NestingFeature) !== 0 && context.isTopLevel) {
      rules = lowerNestingInRule(p, rule, rules);
    } else {
      rules.push(rule);
    }
  }
  if (p.options.minifySyntax) return p.mangleRules(rules, !!context.isTopLevel);
  return rules;
}

/** Go: func (p *parser) parseAtRule(context atRuleContext) css_ast.Rule (css_parser.go:1196) */
export function parseAtRule(p: CSSParser, context: AtRuleContext): Rule {
  const atToken = p.decoded();
  const atRange = new Range(new Loc(p.current().rangeLoc), p.current().rangeLen);
  const lowerAtToken = atToken.toLowerCase();
  let kind = specialAtRules[lowerAtToken] ?? atRuleUnknown;
  p.advance();

  const preludeStart = p.index;
  let namedReturn: Rule | null = null;
  abort: {
    switch (lowerAtToken) {
      case "charset":
        switch (context.charsetValidity ?? atRuleInvalid) {
          case atRuleInvalid:
            AddID(p.log, MsgID_CSS_InvalidAtCharset, MsgKind.Warning, p.tracker, atRange, '"@charset" must be the first rule in the file');
            break;
          case atRuleInvalidAfter:
            AddIDWithNotes(p.log, MsgID_CSS_InvalidAtCharset, MsgKind.Warning, p.tracker, atRange,
              '"@charset" must be the first rule in the file',
              [p.tracker.MsgData(new Range(new Loc(context.afterLoc ?? 0), 0), 'This rule cannot come before a "@charset" rule')]);
            break;
          case atRuleValid: {
            kind = atRuleEmpty;
            p.expect(T.TWhitespace);
            if (p.peek(T.TString)) {
              const encoding = p.decoded();
              if (encoding.toLowerCase() !== "utf-8") {
                AddID(p.log, MsgID_CSS_UnsupportedAtCharset, MsgKind.Warning, p.tracker,
                  new Range(new Loc(p.current().rangeLoc), p.current().rangeLen),
                  `"UTF-8" will be used instead of unsupported charset ${JSON.stringify(encoding)}`);
              }
              p.advance();
              p.expect(T.TSemicolon);
              const rule = new Rule(); rule.Loc = atRange.Loc.Start;
              const d = new RAtCharset(); d.Encoding = encoding; rule.Data = d;
              namedReturn = rule; break abort;
            }
            p.expect(T.TString);
            break;
          }
        }
        break;
      case "import":
        switch (context.importValidity ?? atRuleInvalid) {
          case atRuleInvalid:
            AddID(p.log, MsgID_CSS_InvalidAtImport, MsgKind.Warning, p.tracker, atRange, '"@import" is only valid at the top level');
            break;
          case atRuleInvalidAfter:
            AddIDWithNotes(p.log, MsgID_CSS_InvalidAtImport, MsgKind.Warning, p.tracker, atRange,
              'All "@import" rules must come first',
              [p.tracker.MsgData(new Range(new Loc(context.afterLoc ?? 0), 0), 'This rule cannot come before an "@import" rule')]);
            break;
          case atRuleValid: {
            kind = atRuleEmpty;
            p.eat(T.TWhitespace);
            const u = p.expectURLOrString();
            if (u.ok) {
              const conditions = new ImportConditions();
              let importConditionsStart = p.index;
              p.eat(T.TWhitespace);
              if ((p.peek(T.TIdent) || p.peek(T.TFunction)) && p.decoded().toLowerCase() === "layer") {
                p.parseComponentValue();
                conditions.Layers = p.convertTokens(p.tokens.slice(importConditionsStart, p.index));
                importConditionsStart = p.index;
                if (conditions.Layers.length > 0) conditions.Layers[0].Whitespace &= ~(1 | 2);
              }
              p.eat(T.TWhitespace);
              if (p.peek(T.TFunction) && p.decoded().toLowerCase() === "supports") {
                p.parseComponentValue();
                conditions.Supports = p.convertTokens(p.tokens.slice(importConditionsStart, p.index));
                importConditionsStart = p.index;
                if (conditions.Supports.length > 0) conditions.Supports[0].Whitespace &= ~(1 | 2);
              }
              conditions.Queries = parseMediaQueryListUntil(p, (k) => k === T.TSemicolon || k === T.TOpenBrace || k === T.TCloseBrace || k === T.TEndOfFile);
              if (p.peek(T.TOpenBrace)) break abort;
              let importConditions: ImportConditions | null = null;
              if (conditions.Layers.length > 0 || conditions.Supports.length > 0 || conditions.Queries.length > 0) importConditions = conditions;
              p.expect(T.TSemicolon);
              const importRecordIndex = p.importRecords.length;
              p.importRecords.push({ Kind: ImportKind.ImportAt, Path: { Text: u.url }, Range: u.range, IsUnused: false });
              if (!p.hasSeenAtImport) {
                p.hasSeenAtImport = true;
                p.layersPreImport = p.layersPostImport;
                p.layersPostImport = null;
              }
              const rule = new Rule(); rule.Loc = atRange.Loc.Start;
              const d = new RAtImport(); d.ImportRecordIndex = importRecordIndex; d.ImportConditions = importConditions; rule.Data = d;
              namedReturn = rule; break abort;
            }
            break;
          }
        }
        break;
      case "keyframes":
      case "-webkit-keyframes":
      case "-moz-keyframes":
      case "-ms-keyframes":
      case "-o-keyframes": {
        p.eat(T.TWhitespace);
        const nameLoc = p.current().rangeLoc;
        let name = "";
        if (p.peek(T.TIdent)) {
          name = p.decoded();
          if (isInvalidAnimationName(name)) {
            const msg = new Msg(); msg.Kind = MsgKind.Warning;
            msg.Data = p.tracker.MsgData(new Range(new Loc(p.current().rangeLoc), p.current().rangeLen), `Cannot use ${JSON.stringify(name)} as a name for "@keyframes" without quotes`);
            const nd = new MsgData(); nd.Text = `You can put ${JSON.stringify(name)} in quotes to prevent it from becoming a CSS keyword.`;
            msg.Notes = [nd];
            if (msg.Data.Location) msg.Data.Location.Suggestion = JSON.stringify(name);
            p.log.AddMsg(msg);
            break abort;
          }
          p.advance();
        } else if (p.peek(T.TString)) {
          name = p.decoded();
          p.advance();
          if (!p.makeLocalSymbols && isInvalidAnimationName(name)) break abort;
        } else if (!p.expect(T.TIdent)) {
          break abort;
        }
        p.eat(T.TWhitespace);
        const blockStart = p.index;
        const matchingLoc = p.current().rangeLoc;
        if (p.expect(T.TOpenBrace)) {
          const blocks: KeyframeBlock[] = [];
          badSyntax: for (;;) {
            const k0 = p.current().kind;
            if (k0 === T.TWhitespace) { p.advance(); continue; }
            if (k0 === T.TCloseBrace) {
              const closeBraceLoc = p.current().rangeLoc;
              p.advance();
              const rule = new Rule(); rule.Loc = atRange.Loc.Start;
              const d = new RAtKeyframes(); d.AtToken = atToken; d.Name = p.symbolForName(nameLoc, name); d.Blocks = blocks; d.CloseBraceLoc = closeBraceLoc;
              rule.Data = d; namedReturn = rule; break abort;
            }
            if (k0 === T.TEndOfFile) break badSyntax;
            if (k0 === T.TOpenBrace) { p.expect(T.TPercentage); break badSyntax; }
            let selectors: string[] = [];
            let firstSelectorLoc = 0;
            selectors: for (;;) {
              const t = p.current();
              switch (t.kind) {
                case T.TWhitespace: p.advance(); continue;
                case T.TOpenBrace: {
                  const blockMatchingLoc = p.current().rangeLoc;
                  p.advance();
                  const rules = parseListOfDeclarations(p, {});
                  let closeBraceLoc = p.current().rangeLoc;
                  if (!p.expectWithMatchingLoc(T.TCloseBrace, blockMatchingLoc)) closeBraceLoc = 0;
                  if (!p.options.minifySyntax || rules.length > 0) {
                    const b = new KeyframeBlock(); b.Selectors = selectors; b.Rules = rules; b.Loc = firstSelectorLoc; b.CloseBraceLoc = closeBraceLoc;
                    blocks.push(b);
                  }
                  break selectors;
                }
                case T.TCloseBrace:
                case T.TEndOfFile:
                  p.expect(T.TOpenBrace); break badSyntax;
                case T.TIdent:
                case T.TPercentage: {
                  if (firstSelectorLoc === 0) firstSelectorLoc = p.current().rangeLoc;
                  let text = p.decoded();
                  if (t.kind === T.TIdent) {
                    if (text.toLowerCase() === "from") {
                      if (p.options.minifySyntax) text = "0%";
                    } else if (text.toLowerCase() !== "to") {
                      p.expect(T.TPercentage);
                    }
                  } else if (p.options.minifySyntax && text === "100%") {
                    text = "to";
                  }
                  selectors.push(text);
                  p.advance();
                  p.eat(T.TWhitespace);
                  if (p.eat(T.TComma)) {
                    p.eat(T.TWhitespace);
                    const kk = p.current().kind;
                    if (kk !== T.TIdent && kk !== T.TPercentage) { p.expect(T.TPercentage); break badSyntax; }
                  } else {
                    const kk = p.current().kind;
                    if (kk !== T.TOpenBrace && kk !== T.TCloseBrace && kk !== T.TEndOfFile) { p.expect(T.TComma); break badSyntax; }
                  }
                  break;
                }
                default:
                  p.expect(T.TPercentage); break badSyntax;
              }
            }
          }
          for (;;) {
            if (p.peek(T.TCloseBrace) || p.peek(T.TEndOfFile)) break;
            p.parseComponentValue();
          }
          p.expectWithMatchingLoc(T.TCloseBrace, matchingLoc);
          const prelude = p.convertTokens(p.tokens.slice(preludeStart, blockStart));
          const block = p.convertTokensHelper(p.tokens.slice(blockStart, p.index), T.TEndOfFile, { allowImports: true });
          const rule = new Rule(); rule.Loc = atRange.Loc.Start;
          const d = new RUnknownAt(); d.AtToken = atToken; d.Prelude = prelude; d.Block = block; rule.Data = d;
          namedReturn = rule; break abort;
        }
        break;
      }
      case "layer": {
        let names: string[][] = [];
        p.eat(T.TWhitespace);
        if (p.peek(T.TIdent)) {
          for (;;) {
            let id = p.expectValidLayerNameIdent();
            if (!id.ok) break abort;
            const name = [id.text];
            for (;;) {
              p.eat(T.TWhitespace);
              if (!p.eat(T.TDelimDot)) break;
              p.eat(T.TWhitespace);
              id = p.expectValidLayerNameIdent();
              if (!id.ok) break abort;
              name.push(id.text);
            }
            names.push(name);
            p.eat(T.TWhitespace);
            if (!p.eat(T.TComma)) break;
            p.eat(T.TWhitespace);
          }
        }
        const matchingLoc = p.current().rangeLoc;
        if (names.length <= 1 && p.eat(T.TOpenBrace)) {
          p.recordAtLayerRule(names);
          const oldEnclosingLayer = p.enclosingLayer.slice();
          if (names.length === 1) p.enclosingLayer = p.enclosingLayer.concat(names[0]);
          else p.anonLayerCount++;
          let rules: Rule[];
          if (context.isDeclarationList) {
            rules = parseListOfDeclarations(p, { canInlineNoOpNesting: !!context.canInlineNoOpNesting });
          } else {
            rules = parseListOfRules(p, { parseSelectors: true });
          }
          if (names.length !== 1) p.anonLayerCount--;
          p.enclosingLayer = oldEnclosingLayer;
          let closeBraceLoc = p.current().rangeLoc;
          if (!p.expectWithMatchingLoc(T.TCloseBrace, matchingLoc)) closeBraceLoc = 0;
          const rule = new Rule(); rule.Loc = atRange.Loc.Start;
          const d = new RAtLayer(); d.Names = names.length ? names : (null as any); d.Rules = rules; d.CloseBraceLoc = closeBraceLoc; rule.Data = d;
          namedReturn = rule; break abort;
        }
        if (names.length >= 1 && p.eat(T.TSemicolon)) {
          p.recordAtLayerRule(names);
          const rule = new Rule(); rule.Loc = atRange.Loc.Start;
          const d = new RAtLayer(); d.Names = names.length ? names : (null as any); rule.Data = d;
          namedReturn = rule; break abort;
        }
        const k = p.current().kind;
        if (k === T.TEndOfFile) {
          p.expect(T.TSemicolon); p.recordAtLayerRule(names);
          const rule = new Rule(); rule.Loc = atRange.Loc.Start;
          const d = new RAtLayer(); d.Names = names.length ? names : (null as any); rule.Data = d;
          namedReturn = rule; break abort;
        } else if (k === T.TCloseBrace) {
          p.expect(T.TSemicolon);
          if (!context.isTopLevel) {
            p.recordAtLayerRule(names);
            const rule = new Rule(); rule.Loc = atRange.Loc.Start;
            const d = new RAtLayer(); d.Names = names.length ? names : (null as any); rule.Data = d;
            namedReturn = rule; break abort;
          }
        } else if (k === T.TOpenBrace) {
          p.expect(T.TSemicolon);
        } else {
          p.unexpected();
        }
        break;
      }
      case "media": {
        const queries = parseMediaQueryListUntil(p, (k) => k === T.TOpenBrace);
        const matchingLoc = p.current().rangeLoc;
        if (!p.expect(T.TOpenBrace)) break abort;
        p.enclosingAtMedia.push(queries);
        let rules: Rule[];
        if (context.isDeclarationList) {
          rules = parseListOfDeclarations(p, { canInlineNoOpNesting: !!context.canInlineNoOpNesting });
        } else {
          rules = parseListOfRules(p, { parseSelectors: true });
        }
        p.enclosingAtMedia.pop();
        let closeBraceLoc = p.current().rangeLoc;
        if (!p.expectWithMatchingLoc(T.TCloseBrace, matchingLoc)) closeBraceLoc = 0;
        const rule = new Rule(); rule.Loc = atRange.Loc.Start;
        const d = new RAtMedia(); d.Queries = queries; d.Rules = rules; d.CloseBraceLoc = closeBraceLoc; rule.Data = d;
        namedReturn = rule; break abort;
      }
      case "scope": {
        let ok = true;
        let start: ComplexSelector[] = [];
        p.eat(T.TWhitespace);
        if (p.eat(T.TOpenParen)) {
          const res = parseSelectorList(p, { stopOnCloseParen: true });
          start = res.list; ok = res.ok;
          if (!ok || !p.expect(T.TCloseParen)) break abort;
          p.eat(T.TWhitespace);
        }
        let end: ComplexSelector[] = [];
        if (p.decoded().toLowerCase() === "to" && p.eat(T.TIdent)) {
          p.eat(T.TWhitespace);
          if (!p.expect(T.TOpenParen)) break abort;
          const res = parseSelectorList(p, { stopOnCloseParen: true });
          end = res.list; ok = res.ok;
          if (!ok || !p.expect(T.TCloseParen)) break abort;
        }
        p.eat(T.TWhitespace);
        const matchingLoc = p.current().rangeLoc;
        if (!p.expect(T.TOpenBrace)) break abort;
        let rules: Rule[];
        if (context.isDeclarationList) {
          rules = parseListOfDeclarations(p, { canInlineNoOpNesting: !!context.canInlineNoOpNesting });
        } else {
          rules = parseListOfRules(p, { parseSelectors: true });
        }
        let closeBraceLoc = p.current().rangeLoc;
        if (!p.expectWithMatchingLoc(T.TCloseBrace, matchingLoc)) closeBraceLoc = 0;
        const rule = new Rule(); rule.Loc = atRange.Loc.Start;
        const d = new RAtScope(); d.Start = start; d.End = end; d.Rules = rules; d.CloseBraceLoc = closeBraceLoc; rule.Data = d;
        namedReturn = rule; break abort;
      }
      default:
        if (kind === atRuleUnknown && lowerAtToken === "namespace") {
          AddID(p.log, MsgID_CSS_UnsupportedAtNamespace, MsgKind.Warning, p.tracker, atRange, '"@namespace" rules are not supported');
        }
    }
  }
  if (namedReturn !== null) return namedReturn;

  p.index = preludeStart;
  prelude: for (;;) {
    const k = p.current().kind;
    if (k === T.TOpenBrace || k === T.TEndOfFile) break prelude;
    if (k === T.TSemicolon || k === T.TCloseBrace) {
      const prelude = p.convertTokens(p.tokens.slice(preludeStart, p.index));
      if (kind === atRuleQualifiedOrEmpty) {
        break prelude;
      } else if (kind === atRuleEmpty || kind === atRuleUnknown) {
        p.expect(T.TSemicolon);
        const rule = new Rule(); rule.Loc = atRange.Loc.Start;
        const d = new RUnknownAt(); d.AtToken = atToken; d.Prelude = prelude; rule.Data = d;
        return rule;
      } else {
        p.expect(T.TOpenBrace); p.eat(T.TSemicolon);
        const rule = new Rule(); rule.Loc = atRange.Loc.Start;
        const d = new RUnknownAt(); d.AtToken = atToken; d.Prelude = prelude; rule.Data = d;
        return rule;
      }
    }
    p.parseComponentValue();
  }
  const prelude = p.convertTokens(p.tokens.slice(preludeStart, p.index));
  const blockStart = p.index;

  switch (kind) {
    case atRuleEmpty: {
      p.expect(T.TSemicolon);
      p.parseBlock(T.TOpenBrace, T.TCloseBrace);
      const block = p.convertTokens(p.tokens.slice(blockStart, p.index));
      const rule = new Rule(); rule.Loc = atRange.Loc.Start;
      const d = new RUnknownAt(); d.AtToken = atToken; d.Prelude = prelude; d.Block = block; rule.Data = d;
      return rule;
    }
    case atRuleDeclarations: {
      const matchingLoc = p.current().rangeLoc;
      p.expect(T.TOpenBrace);
      const rules = parseListOfDeclarations(p, {});
      let closeBraceLoc = p.current().rangeLoc;
      if (!p.expectWithMatchingLoc(T.TCloseBrace, matchingLoc)) closeBraceLoc = 0;
      if (prelude.length === 1 && lowerAtToken === "counter-style") {
        const t = prelude[0];
        if (t.Kind === T.TIdent) {
          t.Kind = T.TSymbol;
          t.PayloadIndex = p.symbolForName(t.Loc, t.Text).Ref.InnerIndex;
        }
      }
      const rule = new Rule(); rule.Loc = atRange.Loc.Start;
      const d = new RKnownAt(); d.AtToken = atToken; d.Prelude = prelude; d.Rules = rules; d.CloseBraceLoc = closeBraceLoc; rule.Data = d;
      return rule;
    }
    case atRuleInheritContext: {
      const matchingLoc = p.current().rangeLoc;
      p.expect(T.TOpenBrace);
      let rules: Rule[];
      if (context.isDeclarationList) {
        rules = parseListOfDeclarations(p, { canInlineNoOpNesting: !!context.canInlineNoOpNesting });
      } else {
        rules = parseListOfRules(p, { parseSelectors: true });
      }
      let closeBraceLoc = p.current().rangeLoc;
      if (!p.expectWithMatchingLoc(T.TCloseBrace, matchingLoc)) closeBraceLoc = 0;
      if (prelude.length >= 1 && lowerAtToken === "container") {
        const t = prelude[0];
        if (t.Kind === T.TIdent && t.Text.toLowerCase() !== "not") {
          t.Kind = T.TSymbol;
          t.PayloadIndex = p.symbolForName(t.Loc, t.Text).Ref.InnerIndex;
        }
      }
      const rule = new Rule(); rule.Loc = atRange.Loc.Start;
      const d = new RKnownAt(); d.AtToken = atToken; d.Prelude = prelude; d.Rules = rules; d.CloseBraceLoc = closeBraceLoc; rule.Data = d;
      return rule;
    }
    case atRuleQualifiedOrEmpty: {
      const matchingLoc = p.current().rangeLoc;
      if (p.eat(T.TOpenBrace)) {
        const rules = parseListOfRules(p, { parseSelectors: true });
        let closeBraceLoc = p.current().rangeLoc;
        if (!p.expectWithMatchingLoc(T.TCloseBrace, matchingLoc)) closeBraceLoc = 0;
        const rule = new Rule(); rule.Loc = atRange.Loc.Start;
        const d = new RKnownAt(); d.AtToken = atToken; d.Prelude = prelude; d.Rules = rules; d.CloseBraceLoc = closeBraceLoc; rule.Data = d;
        return rule;
      }
      p.expect(T.TSemicolon);
      const rule = new Rule(); rule.Loc = atRange.Loc.Start;
      const d = new RKnownAt(); d.AtToken = atToken; d.Prelude = prelude; rule.Data = d;
      return rule;
    }
    default: {
      p.parseBlock(T.TOpenBrace, T.TCloseBrace);
      const block = p.convertTokensHelper(p.tokens.slice(blockStart, p.index), T.TEndOfFile, { allowImports: true });
      const rule = new Rule(); rule.Loc = atRange.Loc.Start;
      const d = new RUnknownAt(); d.AtToken = atToken; d.Prelude = prelude; d.Block = block; rule.Data = d;
      return rule;
    }
  }
}

/** Go: func Parse(log logger.Log, source logger.Source, options Options) css_ast.AST (css_parser.go:122) */
export function Parse(log: any, source: Source, options: Options): CSSAST {
  const result = TokenizeCSS(source, { recordAllComments: options.minifyIdentifiers });
  const p = new CSSParser();
  p.log = log;
  p.source = source;
  p.tracker = MakeTracker(source);
  p.options = options;
  p.tokens = result.tokens;
  p.allComments = result.allComments;
  p.legalComments = result.legalComments.map((c) => ({
    TokenIndexAfter: c.tokenIndexAfter, Loc: c.loc,
    Text: new TextDecoder().decode(c.text), Kind: 0,
  }));
  p.prevError = new Loc(-1);
  p.composes = new Map();
  p.localScope = new Map();
  p.globalScope = new Map();
  p.makeLocalSymbols = options.symbolMode === 2;
  p.symbolMode = options.symbolMode;
  const rules = parseListOfRules(p, { isTopLevel: true, parseSelectors: true });
  p.expect(T.TEndOfFile);
  const ast = new CSSAST();
  ast.Rules = rules;
  ast.CharFreq = p.computeCharacterFrequency();
  ast.Symbols = p.symbols;
  ast.ImportRecords = p.importRecords;
  ast.ApproximateLineCount = result.approximateLineCount;
  ast.SourceMapComment = result.sourceMapComment;
  ast.LocalSymbols = p.localSymbols;
  ast.LocalScope = p.localScope;
  ast.GlobalScope = p.globalScope;
  ast.Composes = p.composes;
  ast.LayersPreImport = p.layersPreImport;
  ast.LayersPostImport = p.layersPostImport;
  return ast;
}
