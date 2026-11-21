// 1:1 移植自 esbuild internal/css_parser/css_parser_selector.go（v0.28.2，commit f6058f83）
// 第 50 轮叶子优先规划：整数解析。真值表由 Go 探针固化在 testdata/css-parser-pure2-go.json。

/** Go: func parseInteger(text string) (string, bool) (css_parser_selector.go:859) */
export function parseInteger(text: string): { value: string; ok: boolean } {
  const n = text.length;
  if (n === 0) return { value: "", ok: false };

  // Trim leading zeros
  let start = 0;
  while (start < n && text[start] === "0") start++;

  // Make sure remaining characters are digits
  if (start === n) return { value: "0", ok: true };
  for (let i = start; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x30 || c > 0x39) return { value: "", ok: false };
  }
  return { value: text.slice(start), ok: true };
}

// ============================================================================
// 第 106 批：selector 纯助手（Go 探针 11 例，逐字节等于 Go）。
// 真值表固化于 testdata/css-sel-go.json（f14efff2…）。
// ============================================================================
import {
  CompoundSelector, ComplexSelector, SubclassSelector, SSPseudoClass, SSPseudoClassWithSelectorList,
  NamespacedName, PseudoClassKindAll,
} from "../css_ast/css_ast.ts";
import { T } from "../css_ast/css_ast.ts";

/** Go: func mergeCompoundSelectors(target *css_ast.CompoundSelector, source css_ast.CompoundSelector) (css_parser_selector.go:115) */
export function mergeCompoundSelectors(target: CompoundSelector, source: CompoundSelector): void {
  if (source.NestingSelectorLocs.length > 0 && target.NestingSelectorLocs.length === 0) {
    target.NestingSelectorLocs = source.NestingSelectorLocs;
  }
  if (source.TypeSelector !== null) {
    if (target.TypeSelector === null) {
      target.TypeSelector = source.TypeSelector;
    } else {
      const ss = new SubclassSelector();
      ss.Range = (source.TypeSelector as NamespacedName).Name.Range;
      const pl = new SSPseudoClassWithSelectorList();
      pl.Kind = PseudoClassKindAll.PseudoClassIs;
      const inner = new ComplexSelector(); inner.Selectors = [new CompoundSelector()];
      inner.Selectors[0].TypeSelector = source.TypeSelector;
      pl.Selectors = [inner];
      ss.Data = pl;
      (target.SubclassSelectors as SubclassSelector[]).push(ss);
    }
  }
  (target.SubclassSelectors as SubclassSelector[]).push(...(source.SubclassSelectors as SubclassSelector[]));
}

/** Go: func containsLocalOrGlobalSelector(sel css_ast.ComplexSelector) bool (css_parser_selector.go:148) */
export function containsLocalOrGlobalSelector(sel: ComplexSelector): boolean {
  for (const s of sel.Selectors) {
    for (const ss of s.SubclassSelectors as SubclassSelector[]) {
      if (ss.Data instanceof SSPseudoClass) {
        if (ss.Data.Name === "global" || ss.Data.Name === "local") return true;
      } else if (ss.Data instanceof SSPseudoClassWithSelectorList) {
        if (ss.Data.Kind === PseudoClassKindAll.PseudoClassGlobal || ss.Data.Kind === PseudoClassKindAll.PseudoClassLocal) return true;
      }
    }
  }
  return false;
}

export const leadingAmpersand = {
  cannotRemoveLeadingAmpersand: 0,
  canAlwaysRemoveLeadingAmpersand: 1,
  canRemoveLeadingAmpersandIfNotFirst: 2,
} as const;
/** Go: func analyzeLeadingAmpersand(sel, isDeclarationContext) leadingAmpersand (css_parser_selector.go:252) */
export function analyzeLeadingAmpersand(sel: ComplexSelector, isDeclarationContext: boolean): number {
  if (sel.Selectors.length > 1) {
    const first = sel.Selectors[0];
    if (first.NestingSelectorLocs.length === 1 && first.Combinator === 0 && first.TypeSelector === null && first.SubclassSelectors.length === 0) {
      const second = sel.Selectors[1];
      const rest = new ComplexSelector(); rest.Selectors = sel.Selectors.slice(1);
      if (second.Combinator === 0 && rest.ContainsNestingCombinator()) {
        // keep
      } else if (second.Combinator !== 0 || second.TypeSelector === null || !isDeclarationContext) {
        return leadingAmpersand.canAlwaysRemoveLeadingAmpersand;
      } else {
        return leadingAmpersand.canRemoveLeadingAmpersandIfNotFirst;
      }
    }
  }
  return leadingAmpersand.cannotRemoveLeadingAmpersand;
}


// ============================================================================
// 第 124 批：selector 叶子 5 函数（Go 探针 23 例，css-sel-leaf-go.json）。
// ============================================================================
import { CSSParser } from "./css_parser.ts";
import { Range, Loc } from "../logger/logger.ts";
import { NameToken, SSAttribute, NthIndex, Token as ASTToken } from "../css_ast/css_ast.ts";
import { T as LT } from "../css_lexer/css_lexer.ts";
import { AddID, AddIDWithNotes, Msg, MsgData, MsgKind } from "../logger/logger.ts";
import { MsgID_CSS_CSSSyntaxError } from "../logger/msg_ids.ts";
import {
  SSHash, SSClass, PseudoClassKindString, HasNthIndex,
  IsInvalidBecauseEmpty, IsSingleAmpersand,
} from "../css_ast/css_ast.ts";
import type { SS } from "../css_ast/css_ast.ts";

/** Go: func (p *parser) nameToken() css_ast.NameToken (css_parser_selector.go:367) */
export function nameToken(p: CSSParser): NameToken {
  const t = p.current();
  const n = new NameToken();
  n.Kind = t.kind; n.Text = p.decoded(); n.Range = new Range(new Loc(t.rangeLoc), t.rangeLen);
  return n;
}

/** Go: func (p *parser) parseCombinator() css_ast.Combinator (css_parser_selector.go:838) */
export function parseCombinator(p: CSSParser): { Loc: number; Byte: number } {
  const t = p.current();
  switch (t.kind) {
    case LT.TDelimGreaterThan: p.advance(); return { Loc: t.rangeLoc, Byte: 62 };
    case LT.TDelimPlus: p.advance(); return { Loc: t.rangeLoc, Byte: 43 };
    case LT.TDelimTilde: p.advance(); return { Loc: t.rangeLoc, Byte: 126 };
    default: return { Loc: 0, Byte: 0 };
  }
}

/** Go: func (p *parser) parseAnyValue() []css_lexer.Token (css_parser_selector.go:794) */
export function parseAnyValue(p: CSSParser): any[] {
  p.stack = [];
  const start = p.index;
  for (;;) {
    switch (p.current().kind) {
      case LT.TCloseParen: case LT.TCloseBracket: case LT.TCloseBrace: {
        const last = p.stack.length - 1;
        if (last < 0 || !p.peek(p.stack[last])) return p.tokens.slice(start, p.index);
        p.stack = p.stack.slice(0, last);
        break;
      }
      case LT.TSemicolon: case LT.TDelimExclamation:
        if (p.stack.length === 0) return p.tokens.slice(start, p.index);
        break;
      case LT.TOpenParen: case LT.TFunction: p.stack.push(LT.TCloseParen); break;
      case LT.TOpenBracket: p.stack.push(LT.TCloseBracket); break;
      case LT.TOpenBrace: p.stack.push(LT.TCloseBrace); break;
      case LT.TEndOfFile: return p.tokens.slice(start, p.index);
    }
    p.advance();
  }
}

/** Go: func (p *parser) parseAttributeSelector() (css_ast.SSAttribute, logger.Range) (css_parser_selector.go:556) */
export function parseAttributeSelector(p: CSSParser): { attr: SSAttribute; range: Range } {
  const attr = new SSAttribute();
  const matchingLoc = p.current().rangeLoc;
  p.advance();
  switch (p.current().kind) {
    case LT.TDelimBar:
    case LT.TDelimAsterisk: {
      if (p.peek(LT.TDelimAsterisk)) {
        const prefix = nameToken(p); p.advance();
        attr.NamespacedName.NamespacePrefix = prefix;
      }
      if (!p.expect(LT.TDelimBar)) return { attr, range: new Range() };
      attr.NamespacedName.Name = nameToken(p);
      if (!p.expect(LT.TIdent)) return { attr, range: new Range() };
      break;
    }
    default: {
      attr.NamespacedName.Name = nameToken(p);
      if (!p.expect(LT.TIdent)) return { attr, range: new Range() };
      if (p.next().kind !== LT.TDelimEquals && p.eat(LT.TDelimBar)) {
        const prefix = attr.NamespacedName.Name;
        attr.NamespacedName.NamespacePrefix = prefix;
        attr.NamespacedName.Name = nameToken(p);
        if (!p.expect(LT.TIdent)) return { attr, range: new Range() };
      }
      break;
    }
  }
  p.eat(LT.TWhitespace);
  if (p.eat(LT.TDelimEquals)) attr.MatcherOp = "=";
  else {
    switch (p.current().kind) {
      case LT.TDelimTilde: attr.MatcherOp = "~="; break;
      case LT.TDelimBar: attr.MatcherOp = "|="; break;
      case LT.TDelimCaret: attr.MatcherOp = "^="; break;
      case LT.TDelimDollar: attr.MatcherOp = "$="; break;
      case LT.TDelimAsterisk: attr.MatcherOp = "*="; break;
    }
    if (attr.MatcherOp !== "") {
      p.advance();
      if (!p.expect(LT.TDelimEquals)) return { attr, range: new Range() };
    }
  }
  if (attr.MatcherOp !== "") {
    p.eat(LT.TWhitespace);
    if (!p.peek(LT.TString) && !p.peek(LT.TIdent)) p.unexpected();
    attr.MatcherValue = p.decoded();
    p.advance();
    p.eat(LT.TWhitespace);
    if (p.peek(LT.TIdent)) {
      const modifier = p.decoded();
      if (modifier.length === 1 && ["i", "I", "s", "S"].includes(modifier)) {
        attr.MatcherModifier = modifier.charCodeAt(0);
        p.advance();
      }
    }
  }
  const closeRange = new Range(new Loc(p.current().rangeLoc), p.current().rangeLen);
  if (!p.expectWithMatchingLoc(LT.TCloseBracket, matchingLoc)) closeRange.Len = 0;
  return { attr, range: new Range(new Loc(matchingLoc), closeRange.End() - matchingLoc) };
}

/** Go: func (p *parser) parseNthIndex() (css_ast.NthIndex, bool) (css_parser_selector.go:883) */
export function parseNthIndex(p: CSSParser): { index: NthIndex; ok: boolean } {
  const none = 0, negative = 1, positive = 2;
  const fail = (): { index: NthIndex; ok: boolean } => { p.unexpected(); return { index: new NthIndex(), ok: false }; };
  let t0 = p.current();
  let text0 = p.decoded();
  if (t0.kind === LT.TIdent && (text0 === "even" || text0 === "odd")) {
    p.advance(); p.eat(LT.TWhitespace);
    const idx = new NthIndex(); idx.B = text0; return { index: idx, ok: true };
  }
  if (t0.kind === LT.TNumber) {
    let bNeg = false;
    if (text0.startsWith("-")) { bNeg = true; text0 = text0.slice(1); }
    else if (text0.startsWith("+")) text0 = text0.slice(1);
    const parsed = parseInteger(text0);
    if (!parsed.ok) return fail();
    let b = parsed.value;
    if (bNeg) b = "-" + b;
    p.advance(); p.eat(LT.TWhitespace);
    const idx = new NthIndex(); idx.B = b; return { index: idx, ok: true };
  }
  let aSign = none;
  if (p.eat(LT.TDelimPlus)) { aSign = positive; t0 = p.current(); text0 = p.decoded(); }
  if (t0.kind !== LT.TIdent && t0.kind !== LT.TDimension) return fail();
  if (aSign === none) {
    if (text0.startsWith("-")) { aSign = negative; text0 = text0.slice(1); }
    else if (text0.startsWith("+")) text0 = text0.slice(1);
  }
  const n = text0.indexOf("n");
  if (n < 0) return fail();
  let a: string;
  if (n === 0) a = aSign === negative ? "-1" : "1";
  else {
    const head = parseInteger(text0.slice(0, n));
    if (!head.ok) return fail();
    a = head.value;
    if (aSign === negative) a = "-" + a;
  }
  text0 = text0.slice(n + 1);
  let bSign = none;
  if (text0.startsWith("-")) {
    text0 = text0.slice(1);
    const bparsed = parseInteger(text0);
    if (bparsed.ok) {
      p.advance(); p.eat(LT.TWhitespace);
      const idx = new NthIndex(); idx.A = a; idx.B = "-" + bparsed.value; return { index: idx, ok: true };
    }
    bSign = negative;
  }
  if (text0 !== "") return fail();
  p.advance(); p.eat(LT.TWhitespace);
  if (bSign === none) {
    if (p.eat(LT.TDelimMinus)) { bSign = negative; p.eat(LT.TWhitespace); }
    else if (p.eat(LT.TDelimPlus)) { bSign = positive; p.eat(LT.TWhitespace); }
  }
  const t1 = p.current();
  let text1 = p.decoded();
  if (t1.kind === LT.TNumber) {
    if (bSign === none) {
      if (text1.startsWith("-")) { bSign = negative; text1 = text1.slice(1); }
      else if (text1.startsWith("+")) text1 = text1.slice(1);
    }
    const p1 = parseInteger(text1);
    if (p1.ok) {
      let b = p1.value;
      if (bSign === negative) b = "-" + b;
      p.advance(); p.eat(LT.TWhitespace);
      const idx = new NthIndex(); idx.A = a; idx.B = b; return { index: idx, ok: true };
    }
  }
  if (bSign !== none) { p.expect(LT.TNumber); return { index: new NthIndex(), ok: false }; }
  const idx = new NthIndex(); idx.A = a; return { index: idx, ok: true };
}


// ============================================================================
// 第 125 批：selector 主链 4 函数（Go 探针 114 例，css-chain-go.json）。
// ============================================================================
interface ParseSelectorOpts {
  pseudoClassKind?: number;
  isDeclarationContext?: boolean;
  stopOnCloseParen?: boolean;
  onlyOneComplexSelector?: boolean;
  isForgivingSelectorList?: boolean;
  noLeadingCombinator?: boolean;
}
interface ParseComplexOpts extends ParseSelectorOpts { isFirst?: boolean; }
const disabled = 0, globalMode = 1;

/** Go: func (p *parser) parseCompoundSelector(opts parseComplexSelectorOpts) (css_ast.CompoundSelector, bool) (css_parser_selector.go:376) */
export function parseCompoundSelector(p: CSSParser, opts: ParseComplexOpts): { sel: CompoundSelector; ok: boolean } {
  const sel = new CompoundSelector();
  const startLoc = p.current().rangeLoc;
  const hasLeadingNestingSelector = p.peek(LT.TDelimAmpersand);
  if (hasLeadingNestingSelector) {
    p.nestingIsPresent = true;
    sel.NestingSelectorLocs.push(startLoc);
    p.advance();
  }
  const typeSelectorLoc = p.current().rangeLoc;
  switch (p.current().kind) {
    case LT.TDelimBar:
    case LT.TIdent:
    case LT.TDelimAsterisk: {
      const nsName = new NamespacedName();
      if (!p.peek(LT.TDelimBar)) { nsName.Name = nameToken(p); p.advance(); }
      else nsName.Name.Kind = LT.TIdent;
      if (p.eat(LT.TDelimBar)) {
        if (!p.peek(LT.TIdent) && !p.peek(LT.TDelimAsterisk)) { p.expect(LT.TIdent); return { sel, ok: false }; }
        const prefix = nsName.Name; nsName.NamespacePrefix = prefix;
        nsName.Name = nameToken(p); p.advance();
      }
      sel.TypeSelector = nsName;
      break;
    }
  }
  subclassSelectors: for (;;) {
    const subclassToken = p.current();
    switch (subclassToken.kind) {
      case LT.THash: {
        if ((subclassToken.flags & 1 /* IsID */) === 0) { const s = new SubclassSelector(); return { sel, ok: false }; }
        const nameLoc = subclassToken.rangeLoc + 1;
        const hash = new SSHash(); hash.Name = p.symbolForName(nameLoc, p.decoded());
        const ss = new SubclassSelector(hash); ss.Range = new Range(new Loc(subclassToken.rangeLoc), subclassToken.rangeLen);
        sel.SubclassSelectors.push(ss);
        p.advance();
        break;
      }
      case LT.TDelimDot: {
        p.advance();
        const nameRange = new Range(new Loc(p.current().rangeLoc), p.current().rangeLen);
        const cls = new SSClass(); cls.Name = p.symbolForName(nameRange.Loc.Start, p.decoded());
        const ss = new SubclassSelector(cls); ss.Range = new Range(new Loc(subclassToken.rangeLoc), nameRange.End() - subclassToken.rangeLoc);
        sel.SubclassSelectors.push(ss);
        if (!p.expect(LT.TIdent)) return { sel, ok: false };
        break;
      }
      case LT.TOpenBracket: {
        const { attr, range } = parseAttributeSelector(p);
        if (range.Len === 0) return { sel, ok: false };
        const ss = new SubclassSelector(attr); ss.Range = range;
        sel.SubclassSelectors.push(ss);
        break;
      }
      case LT.TColon: {
        if (p.next().kind === LT.TColon) {
          while (p.peek(LT.TColon)) {
            const firstColonLoc = p.current().rangeLoc;
            const isElement = p.next().kind === LT.TColon;
            if (isElement) p.advance();
            const { ss: pseudo, range } = parsePseudoClassSelector(p, firstColonLoc, isElement);
            if (p.options.minifySyntax && isElement && pseudo instanceof SSPseudoClass && pseudo.Args.length === 0) {
              if (["before", "after", "first-line", "first-letter"].includes(pseudo.Name)) pseudo.IsElement = false;
            }
            const ss = new SubclassSelector(pseudo); ss.Range = range;
            sel.SubclassSelectors.push(ss);
          }
          break;
        }
        const { ss: pseudo, range } = parsePseudoClassSelector(p, subclassToken.rangeLoc, false);
        const ss = new SubclassSelector(pseudo); ss.Range = range;
        sel.SubclassSelectors.push(ss);
        break;
      }
      case LT.TDelimAmpersand: {
        p.nestingIsPresent = true;
        sel.NestingSelectorLocs.push(subclassToken.rangeLoc);
        p.advance();
        break;
      }
      default: break subclassSelectors;
    }
  }
  if (IsInvalidBecauseEmpty(sel)) { p.unexpected(); return { sel, ok: false }; }
  if (hasLeadingNestingSelector && sel.TypeSelector !== null) {
    const r = new Range(new Loc(typeSelectorLoc), p.at(p.index - 1).rangeLoc + p.at(p.index - 1).rangeLen - typeSelectorLoc);
    let text = (sel.TypeSelector as NamespacedName).Name.Text;
    if ((sel.TypeSelector as NamespacedName).NamespacePrefix !== null) text = `${(sel.TypeSelector as NamespacedName).NamespacePrefix!.Text}|${text}`;
    let howToFix: string;
    let suggestion = new TextDecoder().decode(p.source.Contents.subarray(r.Loc.Start, r.Loc.Start + r.Len));
    if (opts.isFirst) { suggestion = `:is(${suggestion})`; howToFix = 'You can wrap this selector in ":is(...)" as a workaround. '; }
    else { r.Len = r.End() - startLoc; suggestion += "&"; howToFix = 'You can move the "&" to the end of this selector as a workaround. '; }
    const msg = new Msg(); msg.Kind = MsgKind.Warning;
    msg.Data = p.tracker.MsgData(r, `Cannot use type selector ${JSON.stringify(text)} directly after nesting selector "&"`);
    if (msg.Data.Location) msg.Data.Location.Suggestion = suggestion;
    const note = new MsgData();
    note.Text = 'CSS nesting syntax does not allow the "&" selector to come before a type selector. ' + howToFix +
      'This restriction exists to avoid problems with SASS nesting, where the same syntax means something very different that has no equivalent in real CSS (appending a suffix to the parent selector).';
    msg.Notes = [note];
    p.log.AddMsg(msg);
    return { sel, ok: false };
  }
  switch (p.current().kind) {
    case LT.TDelimBar: case LT.TIdent: case LT.TDelimAsterisk: p.unexpected(); return { sel, ok: false };
  }
  return { sel, ok: true };
}

/** Go: func (p *parser) parsePseudoClassSelector(loc logger.Loc, isElement bool) (css_ast.SS, logger.Range) (css_parser_selector.go:653) */
export function parsePseudoClassSelector(p: CSSParser, loc: number, isElement: boolean): { ss: SS; range: Range } {
  p.advance();
  if (p.peek(LT.TFunction)) {
    const text = p.decoded();
    const matchingLoc = p.current().rangeLoc + p.current().rangeLen - 1;
    p.advance();
    if (!isElement) {
      let kind = -1;
      let local = p.makeLocalSymbols;
      let known = true;
      switch (text) {
        case "global": kind = PseudoClassKindAll.PseudoClassGlobal; if (p.symbolMode !== disabled) local = false; break;
        case "has": kind = PseudoClassKindAll.PseudoClassHas; break;
        case "is": kind = PseudoClassKindAll.PseudoClassIs; break;
        case "local": kind = PseudoClassKindAll.PseudoClassLocal; if (p.symbolMode !== disabled) local = true; break;
        case "not": kind = PseudoClassKindAll.PseudoClassNot; break;
        case "nth-child": kind = PseudoClassKindAll.PseudoClassNthChild; break;
        case "nth-last-child": kind = PseudoClassKindAll.PseudoClassNthLastChild; break;
        case "nth-of-type": kind = PseudoClassKindAll.PseudoClassNthOfType; break;
        case "nth-last-of-type": kind = PseudoClassKindAll.PseudoClassNthLastOfType; break;
        case "where": kind = PseudoClassKindAll.PseudoClassWhere; break;
        default: known = false; break;
      }
      if (known) {
        const old = p.index;
        if (HasNthIndex(kind)) {
          p.eat(LT.TWhitespace);
          const parsed = parseNthIndex(p);
          if (parsed.ok) {
            let selectors: ComplexSelector[] = [];
            if ((kind === PseudoClassKindAll.PseudoClassNthChild || kind === PseudoClassKindAll.PseudoClassNthLastChild) &&
                p.peek(LT.TIdent) && p.decoded().toLowerCase() === "of") {
              p.advance(); p.eat(LT.TWhitespace);
              const oldLocal = p.makeLocalSymbols;
              const list = parseSelectorList(p, { stopOnCloseParen: true, noLeadingCombinator: true });
              p.makeLocalSymbols = oldLocal;
              if (list.ok) selectors = list.list;
            }
            if (p.options.minifySyntax) parsed.index.Minify();
            if (p.current().kind === LT.TCloseParen) {
              const closeRange = new Range(new Loc(p.current().rangeLoc), p.current().rangeLen);
              if (!p.expectWithMatchingLoc(LT.TCloseParen, matchingLoc)) closeRange.Len = 0;
              const plist = new SSPseudoClassWithSelectorList();
              plist.Kind = kind; plist.Selectors = selectors; plist.Index = parsed.index;
              return { ss: plist, range: new Range(new Loc(loc), closeRange.End() - loc) };
            }
          }
        } else {
          p.eat(LT.TWhitespace);
          const oldLocal = p.makeLocalSymbols;
          p.makeLocalSymbols = local;
          const list = parseSelectorList(p, {
            pseudoClassKind: kind, stopOnCloseParen: true,
            onlyOneComplexSelector: kind === PseudoClassKindAll.PseudoClassGlobal || kind === PseudoClassKindAll.PseudoClassLocal,
            isForgivingSelectorList: kind === PseudoClassKindAll.PseudoClassIs || kind === PseudoClassKindAll.PseudoClassWhere,
          });
          p.makeLocalSymbols = oldLocal;
          if (list.ok) {
            const closeRange = new Range(new Loc(p.current().rangeLoc), p.current().rangeLen);
            if (!p.expectWithMatchingLoc(LT.TCloseParen, matchingLoc)) closeRange.Len = 0;
            const plist = new SSPseudoClassWithSelectorList();
            plist.Kind = kind; plist.Selectors = list.list;
            return { ss: plist, range: new Range(new Loc(loc), closeRange.End() - loc) };
          }
        }
        p.index = old;
      }
    }
    const args = p.convertTokens(parseAnyValue(p));
    const closeRange = new Range(new Loc(p.current().rangeLoc), p.current().rangeLen);
    if (!p.expectWithMatchingLoc(LT.TCloseParen, matchingLoc)) closeRange.Len = 0;
    const pseudo = new SSPseudoClass(); pseudo.IsElement = isElement; pseudo.Name = text; pseudo.Args = args; pseudo.HasParens = true;
    return { ss: pseudo, range: new Range(new Loc(loc), closeRange.End() - loc) };
  }
  const nameRange = new Range(new Loc(p.current().rangeLoc), p.current().rangeLen);
  const name = p.decoded();
  const pseudo = new SSPseudoClass(); pseudo.IsElement = isElement;
  if (p.expect(LT.TIdent)) {
    pseudo.Name = name;
    if (p.symbolMode !== disabled) {
      if (name === "local") p.makeLocalSymbols = true;
      else if (name === "global") p.makeLocalSymbols = false;
    }
  } else nameRange.Len = 0;
  return { ss: pseudo, range: new Range(new Loc(loc), nameRange.End() - loc) };
}

/** Go: func (p *parser) parseComplexSelector(opts parseComplexSelectorOpts) (css_ast.ComplexSelector, bool) (css_parser_selector.go:314) */
export function parseComplexSelector(p: CSSParser, opts: ParseComplexOpts): { result: ComplexSelector; ok: boolean } {
  const result = new ComplexSelector();
  let combinator = { Loc: 0, Byte: 0 };
  if (!opts.noLeadingCombinator) {
    combinator = parseCombinator(p);
    if (combinator.Byte !== 0) { p.nestingIsPresent = true; p.eat(LT.TWhitespace); }
  }
  const first = parseCompoundSelector(p, { ...opts, isFirst: opts.isFirst ?? false });
  if (!first.ok) return { result, ok: false };
  first.sel.Combinator = combinator.Byte;
  first.sel.CombinatorLoc = combinator.Loc;
  result.Selectors.push(first.sel);
  const stop = opts.stopOnCloseParen ? LT.TCloseParen : LT.TOpenBrace;
  for (;;) {
    p.eat(LT.TWhitespace);
    if (p.peek(LT.TEndOfFile) || p.peek(LT.TComma) || p.peek(stop)) break;
    let comb = parseCombinator(p);
    if (comb.Byte !== 0) p.eat(LT.TWhitespace);
    const next = parseCompoundSelector(p, { ...opts, isFirst: false });
    if (!next.ok) return { result, ok: false };
    next.sel.Combinator = comb.Byte;
    next.sel.CombinatorLoc = comb.Loc;
    result.Selectors.push(next.sel);
  }
  return { result, ok: true };
}

/** Go: func (p *parser) flattenLocalAndGlobalSelectors(list, sel []css_ast.ComplexSelector) []css_ast.ComplexSelector (css_parser_selector.go:168) */
export function flattenLocalAndGlobalSelectors(p: CSSParser, list: ComplexSelector[], sel: ComplexSelector): ComplexSelector[] {
  if (p.symbolMode !== disabled && containsLocalOrGlobalSelector(sel)) {
    let selectors: CompoundSelector[] = [];
    for (const s0 of sel.Selectors) {
      let s = s0.Clone();
      const old = s.SubclassSelectors;
      s.SubclassSelectors = [];
      for (const ss0 of old) {
        const ss = ss0 as SubclassSelector;
        const data = ss.Data as SS;
        if (data instanceof SSPseudoClass && (data.Name === "global" || data.Name === "local")) continue;
        if (data instanceof SSPseudoClassWithSelectorList &&
            (data.Kind === PseudoClassKindAll.PseudoClassGlobal || data.Kind === PseudoClassKindAll.PseudoClassLocal)) {
          let inner = data.Selectors[0].Selectors.slice();
          if (inner[0].Combinator === 0) { mergeCompoundSelectors(s, inner[0]); inner = inner.slice(1); }
          if (inner.length > 0) {
            if (!IsInvalidBecauseEmpty(s)) selectors.push(s);
            selectors.push(...inner.slice(0, inner.length - 1));
            s = inner[inner.length - 1].Clone();
          }
          continue;
        }
        s.SubclassSelectors.push(ss);
      }
      if (!IsInvalidBecauseEmpty(s)) selectors.push(s);
    }
    if (selectors.length === 0) {
      const holder = new CompoundSelector();
      holder.NestingSelectorLocs.push(sel.Selectors[0].Range().Loc.Start);
      holder.WasEmptyFromLocalOrGlobal = true;
      selectors = [holder];
      p.nestingIsPresent = true;
    }
    sel.Selectors = selectors;
  }
  return list.concat([sel]);
}

/** Go: func (p *parser) parseSelectorList(opts parseSelectorOpts) ([]css_ast.ComplexSelector, bool) (css_parser_selector.go:22) */
export function parseSelectorList(p: CSSParser, opts: ParseSelectorOpts): { list: ComplexSelector[]; ok: boolean } {
  let list: ComplexSelector[] = [];
  if (opts.isForgivingSelectorList && opts.stopOnCloseParen && p.peek(LT.TCloseParen)) return { list, ok: true };
  const first = parseComplexSelector(p, { ...opts, isFirst: true });
  if (!first.ok) return { list, ok: false };
  list = flattenLocalAndGlobalSelectors(p, list, first.result);
  if (opts.onlyOneComplexSelector) {
    if (p.current().kind === LT.TComma) {
      const t = p.current(); p.prevError = new Loc(t.rangeLoc);
      const kind = `:${PseudoClassKindString(opts.pseudoClassKind ?? 0)}(...)`;
      const msg = new Msg(); msg.Kind = MsgKind.Warning;
      msg.Data = p.tracker.MsgData(new Range(new Loc(t.rangeLoc), t.rangeLen), `Unexpected "," inside ${JSON.stringify(kind)}`);
      const note = new MsgData();
      note.Text = 'Different CSS tools behave differently in this case, so esbuild doesn\'t allow it. ' +
        `Either remove this comma or split this selector up into multiple comma-separated ${JSON.stringify(kind)} selectors instead.`;
      msg.Notes = [note];
      p.log.AddMsg(msg);
      return { list, ok: false };
    }
  } else {
    skip: for (;;) {
      p.eat(LT.TWhitespace);
      if (!p.eat(LT.TComma)) break;
      p.eat(LT.TWhitespace);
      const sel = parseComplexSelector(p, opts);
      if (!sel.ok) return { list, ok: false };
      if (p.options.minifySyntax) {
        for (const existing of list) if (sel.result.Equal(existing, null)) continue skip;
      }
      list = flattenLocalAndGlobalSelectors(p, list, sel.result);
    }
  }
  if (p.options.minifySyntax && !opts.stopOnCloseParen) {
    for (let i = 1; i < list.length; i++) {
      if (analyzeLeadingAmpersand(list[i], !!opts.isDeclarationContext) !== 0) list[i].Selectors = list[i].Selectors.slice(1);
    }
    switch (analyzeLeadingAmpersand(list[0], !!opts.isDeclarationContext)) {
      case 1: list[0].Selectors = list[0].Selectors.slice(1); break;
      case 2:
        for (let i = 1; i < list.length; i++) {
          const s = list[i].Selectors[0];
          if (s.NestingSelectorLocs.length === 0 && (s.Combinator !== 0 || s.TypeSelector === null)) {
            list[0].Selectors = list[0].Selectors.slice(1);
            [list[0], list[i]] = [list[i], list[0]];
            break;
          }
        }
        break;
    }
  }
  return { list, ok: true };
}
