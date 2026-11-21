// 1:1 移植自 esbuild internal/css_ast/css_ast.go（v0.28.2，commit f6058f83）
// 第 81 轮事故恢复：完整重移植（Token / CrossFileEqualityCheck / Equal 族 / Hash 族 /
// Clone 族 / Rule+R* 规则族 / MediaQuery+MQ* 媒体查询族 / ComplexSelector+SS* 选择器族）。
// 真值表由 Go 包内探针固化在 testdata/css-ast-{leaf,leaf2,range,cluster,string,
// equal,hash,clone}-go.json。第 102 批忠实复刻两处 Go 0.28.2 源码 bug：
//   (a) RAtLayer.Equal 所有路径恒 return false；
//   (b) NamespacedName.Equal 末项用 a.NamespacePrefix.Equal(b.Name)（非 b.NamespacePrefix）。
// 第 103 批忠实复刻 SSPseudoClass.Clone 的 Go bug（浅拷贝 Args、CloneTokens 结果赋给原对象）。
import { HashCombine, HashCombineString } from "../helpers/hash.ts";
import { Loc, Range, Span } from "../logger/logger.ts";
import { LocRef, Ref, SymbolMap, SymbolKind, FollowSymbols, Get } from "../ast/ast.ts";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Go: css_lexer.T —— 全量 token kind 枚举（css_lexer.ts 实测值） */
export const T = {
  TEndOfFile: 0, TAtKeyword: 1, TBadString: 2, TBadURL: 3, TCDC: 4, TCDO: 5,
  TCloseBrace: 6, TCloseBracket: 7, TCloseParen: 8, TColon: 9, TComma: 10, TDelim: 11,
  TDelimAmpersand: 12, TDelimAsterisk: 13, TDelimBar: 14, TDelimCaret: 15, TDelimDollar: 16,
  TDelimDot: 17, TDelimEquals: 18, TDelimExclamation: 19, TDelimGreaterThan: 20, TDelimLessThan: 21,
  TDelimMinus: 22, TDelimPlus: 23, TDelimSlash: 24, TDelimTilde: 25, TDimension: 26, TFunction: 27,
  THash: 28, TIdent: 29, TNumber: 30, TOpenBrace: 31, TOpenBracket: 32, TOpenParen: 33,
  TPercentage: 34, TSemicolon: 35, TString: 36, TURL: 37, TWhitespace: 38, TSymbol: 39,
  TUnterminatedString: 2, // css_lexer TUnterminatedString == TBadString == 2
  String: 36, // 历史别名：部分探针用 T.String 指 TString
} as const;
export type T = number;

/** Go: WhitespaceFlags (css_ast.go:135) */
export const WhitespaceFlags = { WhitespaceBefore: 1, WhitespaceAfter: 2 } as const;
export const WhitespaceBefore = 1, WhitespaceAfter = 2;

/** Go: PercentageFlags (css_ast.go:278) */
export const AllowPercentageBelow0 = 1, AllowPercentageAbove100 = 2, AllowAnyPercentage = 3;

/**
 * Go: type Token struct (css_ast.go:85)
 * Loc/PayloadIndex/UnitOffset/Whitespace 在 port 里就是数字（Loc=logger.Loc.Start）。
 */
export class Token {
  Text: string = "";
  UnitOffset: number = 0;
  Kind: number = 0;
  Children: Token[] | null = null;
  Loc: number = 0;
  PayloadIndex: number = 0;
  Whitespace: number = 0;

  /** Go: func (t Token) PercentageValue() string (css_ast.go:351) */
  PercentageValue(): string { return this.Text.slice(0, this.Text.length - 1); }
  /** Go: func (t Token) DimensionValue() string (css_ast.go:355) */
  DimensionValue(): string { return this.Text.slice(0, this.UnitOffset); }
  /** Go: func (t Token) DimensionUnit() string (css_ast.go:359) */
  DimensionUnit(): string { return this.Text.slice(this.UnitOffset); }

  /** Go: func (t Token) DimensionUnitIsSafeLength() bool (css_ast.go:363) */
  DimensionUnitIsSafeLength(): boolean {
    switch (this.DimensionUnit().toLowerCase()) {
      case "cm": case "em": case "in": case "mm": case "pc": case "pt": case "px": return true;
    }
    return false;
  }
  /** Go: func (t Token) IsZero() bool (css_ast.go:373) */
  IsZero(): boolean { return this.Kind === T.TNumber && this.Text === "0"; }
  /** Go: func (t Token) IsOne() bool (css_ast.go:377) */
  IsOne(): boolean { return this.Kind === T.TNumber && this.Text === "1"; }
  /** Go: func (t Token) IsAngle() bool (css_ast.go:381) */
  IsAngle(): boolean {
    if (this.Kind === T.TDimension) {
      const unit = this.DimensionUnit().toLowerCase();
      return unit === "deg" || unit === "grad" || unit === "rad" || unit === "turn";
    }
    return false;
  }

  /** Go: func (t Token) NumberOrFractionForPercentage(...) (css_ast.go:292) */
  NumberOrFractionForPercentage(percentReferenceRange: number, flags: number): { value: number; ok: boolean } {
    if (this.Kind === T.TNumber) {
      const f = parseFloat(this.Text);
      if (!Number.isNaN(f)) return { value: f, ok: true };
    } else if (this.Kind === T.TPercentage) {
      const f = parseFloat(this.PercentageValue());
      if (!Number.isNaN(f)) {
        if ((flags & 1) === 0 && f < 0) return { value: 0, ok: true };
        if ((flags & 2) === 0 && f > 100) return { value: percentReferenceRange, ok: true };
        return { value: f / 100 * percentReferenceRange, ok: true };
      }
    }
    return { value: 0, ok: false };
  }
  /** Go: func (t Token) ClampedFractionForPercentage() (css_ast.go:314) */
  ClampedFractionForPercentage(): { value: number; ok: boolean } {
    if (this.Kind === T.TPercentage) {
      const f = parseFloat(this.PercentageValue());
      if (!Number.isNaN(f)) {
        if (f < 0) return { value: 0, ok: true };
        if (f > 100) return { value: 1, ok: true };
        return { value: f / 100, ok: true };
      }
    }
    return { value: 0, ok: false };
  }
  /** Go: func (t *Token) TurnLengthIntoNumberIfZero() (css_ast.go:333) */
  TurnLengthIntoNumberIfZero(): boolean {
    if (this.Kind === T.TDimension && this.DimensionValue() === "0") {
      this.Kind = T.TNumber; this.Text = "0"; return true;
    }
    return false;
  }
  /** Go: func (t *Token) TurnLengthOrPercentageIntoNumberIfZero() (css_ast.go:342) */
  TurnLengthOrPercentageIntoNumberIfZero(): boolean {
    if (this.Kind === T.TPercentage && this.PercentageValue() === "0") {
      this.Kind = T.TNumber; this.Text = "0"; return true;
    }
    return this.TurnLengthIntoNumberIfZero();
  }

  /** Go: func (a Token) Equal(b Token, check *CrossFileEqualityCheck) (css_ast.go:163) */
  Equal(b: Token, check: CrossFileEqualityCheck | null): boolean { return tokenEqual(this, b, check); }
  /** Go: func (a Token) EqualIgnoringWhitespace(b Token) (css_ast.go:246) */
  EqualIgnoringWhitespace(b: Token): boolean { return tokenEqualIgnoringWhitespace(this, b); }
}

/** Go: func TokensEqual(a, b []Token, check *CrossFileEqualityCheck) (css_ast.go:218) */
export function TokensEqual(a: Token[], b: Token[], check: CrossFileEqualityCheck | null): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!tokenEqual(a[i], b[i], check)) return false;
  return true;
}
/** TS 便捷别名（css_decls_transform 用） */
export function TokensEq(a: Token[], b: Token[], check: CrossFileEqualityCheck | null = null): boolean {
  return TokensEqual(a, b, check);
}

/** Go: (*CrossFileEqualityCheck).RefsAreEquivalent 的 nil-receiver 等价：check 为 null 时只有 a==b 成立 */
function refsEquivalent(check: CrossFileEqualityCheck | null, a: Ref, b: Ref): boolean {
  if (a.InnerIndex === b.InnerIndex && a.SourceIndex === b.SourceIndex) return true;
  if (check === null) return false;
  return check.RefsAreEquivalent(a, b);
}

/** 从 import record 取 path 文本（Port 内部 importRecords 为 {Path:{Text}} 或 {path}） */
function importRecordPath(rec: any): string {
  if (!rec) return "";
  if (rec.Path && typeof rec.Path.Text === "string") return rec.Path.Text;
  if (typeof rec.path === "string") return rec.path;
  if (typeof rec.Text === "string") return rec.Text;
  return "";
}

/** Go: Token.Equal 的函数式底座 */
function tokenEqual(a: Token, b: Token, check: CrossFileEqualityCheck | null): boolean {
  if (a.Kind === b.Kind && a.Text === b.Text && a.Whitespace === b.Whitespace) {
    if (a.Kind === T.TURL) {
      if (check === null) {
        if (a.PayloadIndex !== b.PayloadIndex) return false;
      } else {
        if (importRecordPath(check.ImportRecordsA[a.PayloadIndex]) !==
            importRecordPath(check.ImportRecordsB[b.PayloadIndex])) return false;
      }
    }
    if (a.Kind === T.TSymbol) {
      if (check === null) {
        if (a.PayloadIndex !== b.PayloadIndex) return false;
      } else {
        const refA = new Ref(check.SourceIndexA, a.PayloadIndex);
        const refB = new Ref(check.SourceIndexB, b.PayloadIndex);
        if (!check.RefsAreEquivalent(refA, refB)) return false;
      }
    }
    if (a.Children === null && b.Children === null) return true;
    if (a.Children !== null && b.Children !== null && TokensEqual(a.Children, b.Children, check)) return true;
  }
  return false;
}
/** TS 便捷别名 */
export function TokenEqual(a: Token, b: Token, check: CrossFileEqualityCheck | null = null): boolean {
  return tokenEqual(a, b, check);
}

/** Go: func HashTokens(hash uint32, tokens []Token) (css_ast.go:230) */
export function HashTokens(hash: number, tokens: Token[]): number {
  hash = HashCombine(hash, tokens.length >>> 0);
  for (const t of tokens) {
    hash = HashCombine(hash, t.Kind >>> 0);
    if (t.Kind !== T.TURL) hash = HashCombineString(hash, bytes(t.Text));
    if (t.Children !== null) hash = HashTokens(hash, t.Children);
  }
  return hash >>> 0;
}

/** Go: func (a Token) EqualIgnoringWhitespace(b Token) 底座 */
function tokenEqualIgnoringWhitespace(a: Token, b: Token): boolean {
  if (a.Kind === b.Kind && a.Text === b.Text && a.PayloadIndex === b.PayloadIndex) {
    if (a.Children === null && b.Children === null) return true;
    if (a.Children !== null && b.Children !== null && TokensEqualIgnoringWhitespace(a.Children, b.Children)) return true;
  }
  return false;
}
/** Go: func TokensEqualIgnoringWhitespace(a, b []Token) (css_ast.go:257) */
export function TokensEqualIgnoringWhitespace(a: Token[], b: Token[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!tokenEqualIgnoringWhitespace(a[i], b[i])) return false;
  return true;
}
/** TS 便捷别名（css_decls_transform 用单 token 版） */
export function TokenEqualIgnoringWhitespace(a: Token, b: Token): boolean {
  return tokenEqualIgnoringWhitespace(a, b);
}

/** Go: func TokensAreCommaSeparated(tokens []Token) (css_ast.go:272) */
export function TokensAreCommaSeparated(tokens: Token[]): boolean {
  const n = tokens.length;
  if ((n & 1) !== 0) {
    for (let i = 1; i < n; i += 2) if (tokens[i].Kind !== T.TComma) return false;
    return true;
  }
  return false;
}

/** Go: func tokensContainAmpersandRecursive(tokens []Token) (css_ast.go:1201) */
export function tokensContainAmpersandRecursive(tokens: Token[]): boolean {
  for (const t of tokens) {
    if (t.Kind === T.TDelimAmpersand) return true;
    if (t.Children !== null && tokensContainAmpersandRecursive(t.Children)) return true;
  }
  return false;
}

/**
 * Go: type CrossFileEqualityCheck struct (css_ast.go:138)
 */
export class CrossFileEqualityCheck {
  ImportRecordsA: any[] = [];
  ImportRecordsB: any[] = [];
  Symbols: SymbolMap | null = null;
  SourceIndexA: number = 0;
  SourceIndexB: number = 0;

  /** Go: func (check *CrossFileEqualityCheck) RefsAreEquivalent(a, b ast.Ref) (css_ast.go:146) */
  RefsAreEquivalent(a: Ref, b: Ref): boolean {
    if (a.InnerIndex === b.InnerIndex && a.SourceIndex === b.SourceIndex) return true;
    if (this.Symbols === null || this.Symbols.SymbolsForSource === null) return false;
    let ra = FollowSymbols(this.Symbols, a);
    let rb = FollowSymbols(this.Symbols, b);
    if (ra.InnerIndex === rb.InnerIndex && ra.SourceIndex === rb.SourceIndex) return true;
    const symbolA = Get(this.Symbols, ra);
    const symbolB = Get(this.Symbols, rb);
    return symbolA.Kind === SymbolKind.SymbolGlobalCSS && symbolB.Kind === SymbolKind.SymbolGlobalCSS &&
      symbolA.OriginalName === symbolB.OriginalName;
  }
}

// ============================================================================
// Clone 族
// ============================================================================

/** Go: func CloneTokensWithoutImportRecords(tokensIn []Token) (css_ast.go:389) */
export function CloneTokensWithoutImportRecords(tokensIn: Token[]): Token[] {
  const tokensOut: Token[] = [];
  for (const tIn of tokensIn) {
    const t = cloneTokenShallow(tIn);
    if (tIn.Children !== null) t.Children = CloneTokensWithoutImportRecords(tIn.Children);
    tokensOut.push(t);
  }
  return tokensOut;
}
/** TS 底座：浅拷贝 Token */
export function cloneTokenShallow(t: Token): Token {
  const c = new Token();
  c.Text = t.Text; c.UnitOffset = t.UnitOffset; c.Kind = t.Kind;
  c.Loc = t.Loc; c.PayloadIndex = t.PayloadIndex; c.Whitespace = t.Whitespace;
  c.Children = t.Children;
  return c;
}

/** Go: func CloneTokensWithImportRecords(...) (css_ast.go:400) */
export function CloneTokensWithImportRecords(
  tokensIn: Token[], importRecordsIn: any[], tokensOut: Token[] | null, importRecordsOut: any[] | null,
): [Token[], any[]] {
  let out = tokensOut;
  if (out === null) out = [];
  let recsOut = importRecordsOut;
  if (recsOut === null) recsOut = [];
  for (const tIn of tokensIn) {
    const t = cloneTokenShallow(tIn);
    t.Loc = 0;
    if (t.Kind === T.TURL) {
      const idx = recsOut.length;
      recsOut.push(importRecordsIn[tIn.PayloadIndex]);
      t.PayloadIndex = idx;
    }
    if (tIn.Children !== null) {
      const [children, recs] = CloneTokensWithImportRecords(tIn.Children, importRecordsIn, null, recsOut);
      t.Children = children;
      recsOut = recs;
    }
    out.push(t);
  }
  return [out, recsOut];
}

/** Go: func CloneMediaQueriesWithImportRecords(...) (css_ast.go:433) */
export function CloneMediaQueriesWithImportRecords(
  queriesIn: MediaQuery[], importRecordsIn: any[], queriesOut: MediaQuery[] | null, importRecordsOut: any[] | null,
): [MediaQuery[], any[]] {
  let out = queriesOut;
  if (out === null) out = [];
  let recsOut = importRecordsOut;
  if (recsOut === null) recsOut = [];
  for (const query of queriesIn) {
    const q = new MediaQuery();
    q.Loc = query.Loc;
    if (query.Data !== null) {
      const [data, recs] = query.Data.CloneWithImportRecords(importRecordsIn, recsOut);
      q.Data = data; recsOut = recs;
    }
    out.push(q);
  }
  return [out, recsOut];
}

// ============================================================================
// AST / Composes
// ============================================================================

/** Go: type Composes struct (css_ast.go:46) */
export class Composes {
  Names: LocRef[] = [];
  ImportedNames: ImportedComposesName[] = [];
  Properties: Map<string, number> = new Map();
}
/** Go: type ImportedComposesName struct (css_ast.go:66) */
export class ImportedComposesName {
  Alias = "";
  AliasLoc = 0;
  ImportRecordIndex = 0;
}
/** Go: type AST struct (css_ast.go:23) —— TS 导出名 CSSAST */
export class CSSAST {
  Symbols: any[] = [];
  CharFreq: any = null;
  ImportRecords: any[] = [];
  Rules: Rule[] = [];
  SourceMapComment: Span = new Span();
  ApproximateLineCount = 0;
  LocalSymbols: LocRef[] = [];
  LocalScope: Map<string, LocRef> = new Map();
  GlobalScope: Map<string, LocRef> = new Map();
  Composes: Map<any, Composes> = new Map();
  LayersPreImport: string[][] = [];
  LayersPostImport: string[][] = [];
}
/** Go: type AST —— 命名空间访问别名 */
export { CSSAST as AST };

// ============================================================================
// Rule / R* 规则族 + Equal/Hash
// ============================================================================

export type R =
  RAtCharset | RAtImport | RAtKeyframes | RKnownAt | RUnknownAt | RSelector |
  RQualified | RDeclaration | RBadDeclaration | RComment | RAtLayer | RAtMedia | RAtScope;

/** Go: type Rule struct (css_ast.go:451) —— Data 是接口，零值 nil（port 用 null） */
export class Rule {
  Data: R = null as any;
  Loc: number = 0;
}

/** Go: func RulesEqual(a, b []Rule, check) (css_ast.go:461) */
export function RulesEqual(a: Rule[], b: Rule[], check: CrossFileEqualityCheck | null): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!a[i].Data.Equal(b[i].Data, check)) return false;
  return true;
}
/** Go: func HashRules(hash uint32, rules []Rule) (css_ast.go:473) */
export function HashRules(hash: number, rules: Rule[]): number {
  hash = HashCombine(hash, rules.length >>> 0);
  for (const child of rules) {
    const [childHash, ok] = child.Data.Hash();
    hash = HashCombine(hash, ok ? childHash >>> 0 : 0);
  }
  return hash >>> 0;
}

/** Go: type RAtCharset struct (css_ast.go:485) */
export class RAtCharset {
  Encoding = "";
  Equal(rule: R, _check: CrossFileEqualityCheck | null): boolean {
    return rule instanceof RAtCharset && this.Encoding === rule.Encoding;
  }
  Hash(): [number, boolean] { return [HashCombineString(1 >>> 0, bytes(this.Encoding)), true]; }
}

/** Go: ImportConditions (css_ast.go:500) */
export class ImportConditions {
  Queries: MediaQuery[] = [];
  Layers: Token[] = [];
  Supports: Token[] = [];
  CloneWithImportRecords(importRecordsIn: any[], importRecordsOut: any[]): [ImportConditions, any[]] {
    const result = new ImportConditions();
    let recs = importRecordsOut;
    [result.Layers, recs] = CloneTokensWithImportRecords(this.Layers, importRecordsIn, null, recs);
    [result.Supports, recs] = CloneTokensWithImportRecords(this.Supports, importRecordsIn, null, recs);
    [result.Queries, recs] = CloneMediaQueriesWithImportRecords(this.Queries, importRecordsIn, null, recs);
    return [result, recs];
  }
}

/** Go: type RAtImport struct (css_ast.go:533) */
export class RAtImport {
  ImportConditions: ImportConditions | null = null;
  ImportRecordIndex = 0;
  Equal(_rule: R, _check: CrossFileEqualityCheck | null): boolean { return false; }
  Hash(): [number, boolean] { return [0, false]; }
}

/** Go: type KeyframeBlock struct (css_ast.go:553) */
export class KeyframeBlock {
  Selectors: string[] = [];
  Rules: Rule[] = [];
  Loc = 0;
  CloseBraceLoc = 0;
}
/** Go: type RAtKeyframes struct (css_ast.go:546) */
export class RAtKeyframes {
  AtToken = "";
  Name: LocRef = new LocRef();
  Blocks: KeyframeBlock[] = [];
  CloseBraceLoc = 0;
  Equal(rule: R, check: CrossFileEqualityCheck | null): boolean {
    if (!(rule instanceof RAtKeyframes) || !eqFold(this.AtToken, rule.AtToken) ||
        !refsEquivalent(check, this.Name.Ref, rule.Name.Ref) || this.Blocks.length !== rule.Blocks.length) return false;
    for (let i = 0; i < this.Blocks.length; i++) {
      const ai = this.Blocks[i], bi = rule.Blocks[i];
      if (ai.Selectors.length !== bi.Selectors.length) return false;
      for (let j = 0; j < ai.Selectors.length; j++) if (ai.Selectors[j] !== bi.Selectors[j]) return false;
      if (!RulesEqual(ai.Rules, bi.Rules, check)) return false;
    }
    return true;
  }
  Hash(): [number, boolean] {
    let hash = HashCombineString(2 >>> 0, bytes(this.AtToken));
    hash = HashCombine(hash, this.Blocks.length >>> 0);
    for (const block of this.Blocks) {
      hash = HashCombine(hash, block.Selectors.length >>> 0);
      for (const sel of block.Selectors) hash = HashCombineString(hash, bytes(sel));
      hash = HashRules(hash, block.Rules);
    }
    return [hash >>> 0, true];
  }
}

/** strings.EqualFold 近似（ASCII 折衷，选择器名均为 ASCII） */
export function eqFold(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase(); }

/** Go: type RKnownAt struct (css_ast.go:595) */
export class RKnownAt {
  AtToken = "";
  Prelude: Token[] = [];
  Rules: Rule[] = [];
  CloseBraceLoc = 0;
  Equal(rule: R, check: CrossFileEqualityCheck | null): boolean {
    return rule instanceof RKnownAt && eqFold(this.AtToken, rule.AtToken) &&
      TokensEqual(this.Prelude, rule.Prelude, check) && RulesEqual(this.Rules, rule.Rules, check);
  }
  Hash(): [number, boolean] {
    let hash = HashCombineString(3 >>> 0, bytes(this.AtToken));
    hash = HashTokens(hash, this.Prelude);
    hash = HashRules(hash, this.Rules);
    return [hash >>> 0, true];
  }
}

/** Go: type RUnknownAt struct (css_ast.go:615) */
export class RUnknownAt {
  AtToken = "";
  Prelude: Token[] = [];
  Block: Token[] = [];
  Equal(rule: R, check: CrossFileEqualityCheck | null): boolean {
    return rule instanceof RUnknownAt && eqFold(this.AtToken, rule.AtToken) &&
      TokensEqual(this.Prelude, rule.Prelude, check) && TokensEqual(this.Block, rule.Block, check);
  }
  Hash(): [number, boolean] {
    let hash = HashCombineString(4 >>> 0, bytes(this.AtToken));
    hash = HashTokens(hash, this.Prelude);
    hash = HashTokens(hash, this.Block);
    return [hash >>> 0, true];
  }
}

/** Go: type RSelector struct (css_ast.go:634) */
export class RSelector {
  Selectors: ComplexSelector[] = [];
  Rules: Rule[] = [];
  CloseBraceLoc = 0;
  Equal(rule: R, check: CrossFileEqualityCheck | null): boolean {
    return rule instanceof RSelector && ComplexSelectorsEqual(this.Selectors, rule.Selectors, check) &&
      RulesEqual(this.Rules, rule.Rules, check);
  }
  Hash(): [number, boolean] {
    let hash = HashCombine(5 >>> 0, this.Selectors.length >>> 0);
    hash = HashComplexSelectors(hash, this.Selectors);
    hash = HashRules(hash, this.Rules);
    return [hash >>> 0, true];
  }
}

/** Go: type RQualified struct (css_ast.go:653) */
export class RQualified {
  Prelude: Token[] = [];
  Rules: Rule[] = [];
  CloseBraceLoc = 0;
  Equal(rule: R, check: CrossFileEqualityCheck | null): boolean {
    return rule instanceof RQualified && TokensEqual(this.Prelude, rule.Prelude, check) &&
      RulesEqual(this.Rules, rule.Rules, check);
  }
  Hash(): [number, boolean] {
    let hash = HashTokens(6 >>> 0, this.Prelude);
    hash = HashRules(hash, this.Rules);
    return [hash >>> 0, true];
  }
}

/** D 类型：Go 的 css_ast.D（声明枚举），port 里就是数字 */
export type D = number;

/** Go: type RDeclaration struct (css_ast.go:671) */
export class RDeclaration {
  KeyText = "";
  Value: Token[] = [];
  KeyRange: Range = new Range();
  Key: D = 0;
  Important = false;
  Equal(rule: R, check: CrossFileEqualityCheck | null): boolean {
    return rule instanceof RDeclaration && this.KeyText === rule.KeyText &&
      TokensEqual(this.Value, rule.Value, check) && this.Important === rule.Important;
  }
  Hash(): [number, boolean] {
    let hash: number;
    if (this.Key === 0 /* DUnknown */) {
      hash = this.Important ? 7 : 8;
      hash = HashCombineString(hash >>> 0, bytes(this.KeyText));
    } else {
      hash = this.Important ? 9 : 10;
      hash = HashCombine(hash >>> 0, this.Key >>> 0);
    }
    hash = HashTokens(hash, this.Value);
    return [hash >>> 0, true];
  }
}

/** Go: type RBadDeclaration struct (css_ast.go:705) */
export class RBadDeclaration {
  Tokens: Token[] = [];
  Equal(rule: R, check: CrossFileEqualityCheck | null): boolean {
    return rule instanceof RBadDeclaration && TokensEqual(this.Tokens, rule.Tokens, check);
  }
  Hash(): [number, boolean] { return [HashTokens(7 >>> 0, this.Tokens), true]; }
}

/** Go: type RComment struct (css_ast.go:720) */
export class RComment {
  Text = "";
  Equal(rule: R, _check: CrossFileEqualityCheck | null): boolean {
    return rule instanceof RComment && this.Text === rule.Text;
  }
  Hash(): [number, boolean] { return [HashCombineString(8 >>> 0, bytes(this.Text)), true]; }
}

/** Go: type RAtLayer struct (css_ast.go:735) */
export class RAtLayer {
  Names: string[][] = [];
  Rules: Rule[] = [];
  CloseBraceLoc = 0;
  /** Go:  faithfully reproduced bug — 所有路径恒 false（css_ast.go:742） */
  Equal(_rule: R, _check: CrossFileEqualityCheck | null): boolean { return false; }
  Hash(): [number, boolean] {
    let hash = HashCombine(9 >>> 0, this.Names.length >>> 0);
    for (const parts of this.Names) {
      hash = HashCombine(hash, parts.length >>> 0);
      for (const part of parts) hash = HashCombineString(hash, bytes(part));
    }
    hash = HashRules(hash, this.Rules);
    return [hash >>> 0, true];
  }
}

/** Go: type RAtMedia struct (css_ast.go:774) */
export class RAtMedia {
  Queries: MediaQuery[] = [];
  Rules: Rule[] = [];
  CloseBraceLoc = 0;
  Equal(rule: R, check: CrossFileEqualityCheck | null): boolean {
    return rule instanceof RAtMedia && MediaQueriesEqual(this.Queries, rule.Queries, check) &&
      RulesEqual(this.Rules, rule.Rules, check);
  }
  Hash(): [number, boolean] {
    let hash = HashMediaQueries(10 >>> 0, this.Queries);
    hash = HashRules(hash, this.Rules);
    return [hash >>> 0, true];
  }
}

/** Go: type RAtScope struct (css_ast.go:1109) */
export class RAtScope {
  Start: ComplexSelector[] = [];
  End: ComplexSelector[] = [];
  Rules: Rule[] = [];
  CloseBraceLoc = 0;
  Equal(rule: R, check: CrossFileEqualityCheck | null): boolean {
    return rule instanceof RAtScope && ComplexSelectorsEqual(this.Start, rule.Start, check) &&
      ComplexSelectorsEqual(this.End, rule.End, check) && RulesEqual(this.Rules, rule.Rules, check);
  }
  Hash(): [number, boolean] {
    let hash = HashComplexSelectors(11 >>> 0, this.Start);
    hash = HashComplexSelectors(hash, this.End);
    hash = HashRules(hash, this.Rules);
    return [hash >>> 0, true];
  }
}

// ============================================================================
// MediaQuery / MQ* 媒体查询族
// ============================================================================

export type MQTypeOp = number;
export const MQTypeOp = { MQTypeOpNone: 0, MQTypeOpNot: 1, MQTypeOpOnly: 2 } as const;
export type MQBinaryOp = number;
export const MQBinaryOp = { MQBinaryOpAnd: 0, MQBinaryOpOr: 1 } as const;

export type MQCmp = number;
export const MQCmp = {
  MQCmpNone: 0, MQCmpEq: 1, MQCmpLt: 2, MQCmpLe: 3, MQCmpGt: 4, MQCmpGe: 5,
} as const;

/** Go: func (cmp MQCmp) String() (css_ast.go:1057) */
export function MQCmpString(cmp: MQCmp): string {
  switch (cmp) {
    case MQCmp.MQCmpLt: return "<";
    case MQCmp.MQCmpLe: return "<=";
    case MQCmp.MQCmpGt: return ">";
    case MQCmp.MQCmpGe: return ">=";
  }
  return "=";
}
/** Go: func (cmp MQCmp) String() —— 导出别名（第 80 轮 String 方法） */
export function mqCmpString(cmp: MQCmp): string { return MQCmpString(cmp); }
/** Go: func (cmp MQCmp) Dir() (css_ast.go:1071) */
export function Dir(cmp: MQCmp): number {
  if (cmp === MQCmp.MQCmpLt || cmp === MQCmp.MQCmpLe) return -1;
  if (cmp === MQCmp.MQCmpGt || cmp === MQCmp.MQCmpGe) return 1;
  return 0;
}
/** Go: func (cmp MQCmp) Flip() (css_ast.go:1081) */
export function Flip(cmp: MQCmp): MQCmp {
  switch (cmp) {
    case MQCmp.MQCmpLt: return MQCmp.MQCmpGe;
    case MQCmp.MQCmpLe: return MQCmp.MQCmpGt;
    case MQCmp.MQCmpGt: return MQCmp.MQCmpLe;
    case MQCmp.MQCmpGe: return MQCmp.MQCmpLt;
  }
  return cmp;
}
/** Go: func (cmp MQCmp) Reverse() (css_ast.go:1095) */
export function Reverse(cmp: MQCmp): MQCmp {
  switch (cmp) {
    case MQCmp.MQCmpLt: return MQCmp.MQCmpGt;
    case MQCmp.MQCmpLe: return MQCmp.MQCmpGe;
    case MQCmp.MQCmpGt: return MQCmp.MQCmpLt;
    case MQCmp.MQCmpGe: return MQCmp.MQCmpLe;
  }
  return cmp;
}

export type MediaQueryData = MQType | MQNot | MQBinary | MQArbitraryTokens | MQPlainOrBoolean | MQRange;

/** Go: type MediaQuery struct (css_ast.go:792) */
export class MediaQuery {
  Loc: number = 0;
  Data: MediaQueryData | null = null;
}

export type MQ = MediaQueryData;

/** Go: func MediaQueriesEqual(a, b []MediaQuery, check) (css_ast.go:800) */
export function MediaQueriesEqual(a: MediaQuery[], b: MediaQuery[], check: CrossFileEqualityCheck | null): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].Data === null || b[i].Data === null) {
      if (a[i].Data !== b[i].Data) return false;
    } else if (!a[i].Data!.Equal(b[i].Data!, check)) return false;
  }
  return true;
}
/** Go: func MediaQueriesEqualIgnoringWhitespace(a, b []MediaQuery) (css_ast.go:815) */
export function MediaQueriesEqualIgnoringWhitespace(a: MediaQuery[], b: MediaQuery[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].Data === null || b[i].Data === null) {
      if (a[i].Data !== b[i].Data) return false;
    } else if (!a[i].Data!.EqualIgnoringWhitespace(b[i].Data!)) return false;
  }
  return true;
}
/** Go: func HashMediaQueries(hash uint32, queries []MediaQuery) (css_ast.go:830) */
export function HashMediaQueries(hash: number, queries: MediaQuery[]): number {
  hash = HashCombine(hash, queries.length >>> 0);
  for (const q of queries) hash = HashCombine(hash, q.Data === null ? 0 : q.Data.Hash());
  return hash >>> 0;
}

/** Go: type MQType struct (css_ast.go:812) */
export class MQType {
  Op: MQTypeOp = MQTypeOp.MQTypeOpNone;
  Type = "";
  AndOrNull: MediaQuery = new MediaQuery();
  Equal(query: MQ, check: CrossFileEqualityCheck | null): boolean {
    if (!(query instanceof MQType) || this.Op !== query.Op || this.Type !== query.Type) return false;
    return (this.AndOrNull.Data === null && query.AndOrNull.Data === null) ||
      (this.AndOrNull.Data !== null && query.AndOrNull.Data !== null &&
       this.AndOrNull.Data.Equal(query.AndOrNull.Data, check));
  }
  EqualIgnoringWhitespace(query: MQ): boolean {
    if (!(query instanceof MQType) || this.Op !== query.Op || this.Type !== query.Type) return false;
    return (this.AndOrNull.Data === null && query.AndOrNull.Data === null) ||
      (this.AndOrNull.Data !== null && query.AndOrNull.Data !== null &&
       this.AndOrNull.Data.EqualIgnoringWhitespace(query.AndOrNull.Data));
  }
  Hash(): number {
    let hash = HashCombine(0 >>> 0, this.Op >>> 0);
    hash = HashCombineString(hash, bytes(this.Type));
    if (this.AndOrNull.Data !== null) hash = HashCombine(hash, this.AndOrNull.Data.Hash());
    return hash >>> 0;
  }
  CloneWithImportRecords(importRecordsIn: any[], importRecordsOut: any[]): [MQ, any[]] {
    let andOrNull: MediaQueryData | null = null;
    let recs = importRecordsOut;
    if (this.AndOrNull.Data !== null) {
      const [data, r] = this.AndOrNull.Data.CloneWithImportRecords(importRecordsIn, recs);
      andOrNull = data; recs = r;
    }
    const result = new MQType();
    result.Op = this.Op; result.Type = this.Type;
    result.AndOrNull = new MediaQuery(); result.AndOrNull.Data = andOrNull;
    return [result, recs];
  }
}

/** Go: type MQNot struct (css_ast.go:884) */
export class MQNot {
  Inner: MediaQuery = new MediaQuery();
  Equal(query: MQ, check: CrossFileEqualityCheck | null): boolean {
    return query instanceof MQNot && this.Inner.Data !== null && query.Inner.Data !== null &&
      this.Inner.Data.Equal(query.Inner.Data, check);
  }
  EqualIgnoringWhitespace(query: MQ): boolean {
    return query instanceof MQNot && this.Inner.Data !== null && query.Inner.Data !== null &&
      this.Inner.Data.EqualIgnoringWhitespace(query.Inner.Data);
  }
  Hash(): number { return HashCombine(1 >>> 0, this.Inner.Data === null ? 0 : this.Inner.Data.Hash()) >>> 0; }
  CloneWithImportRecords(importRecordsIn: any[], importRecordsOut: any[]): [MQ, any[]] {
    const result = new MQNot();
    let recs = importRecordsOut;
    if (this.Inner.Data !== null) {
      const [data, r] = this.Inner.Data.CloneWithImportRecords(importRecordsIn, recs);
      result.Inner = new MediaQuery(); result.Inner.Data = data; recs = r;
    }
    return [result, recs];
  }
}

/** Go: type MQBinary struct (css_ast.go:922) */
export class MQBinary {
  Op: MQBinaryOp = MQBinaryOp.MQBinaryOpAnd;
  Terms: MediaQuery[] = [];
  Equal(query: MQ, check: CrossFileEqualityCheck | null): boolean {
    return query instanceof MQBinary && this.Op === query.Op && MediaQueriesEqual(this.Terms, query.Terms, check);
  }
  EqualIgnoringWhitespace(query: MQ): boolean {
    return query instanceof MQBinary && this.Op === query.Op && MediaQueriesEqualIgnoringWhitespace(this.Terms, query.Terms);
  }
  Hash(): number {
    let hash = HashCombine(2 >>> 0, this.Op >>> 0);
    hash = HashMediaQueries(hash, this.Terms);
    return hash >>> 0;
  }
  CloneWithImportRecords(importRecordsIn: any[], importRecordsOut: any[]): [MQ, any[]] {
    const result = new MQBinary(); result.Op = this.Op;
    let recs = importRecordsOut;
    const terms: MediaQuery[] = [];
    for (const term of this.Terms) {
      const q = new MediaQuery(); q.Loc = term.Loc;
      if (term.Data !== null) {
        const [data, r] = term.Data.CloneWithImportRecords(importRecordsIn, recs);
        q.Data = data; recs = r;
      }
      terms.push(q);
    }
    result.Terms = terms;
    return [result, recs];
  }
}

/** Go: type MQArbitraryTokens struct (css_ast.go:953) */
export class MQArbitraryTokens {
  Tokens: Token[] = [];
  Equal(query: MQ, check: CrossFileEqualityCheck | null): boolean {
    return query instanceof MQArbitraryTokens && TokensEqual(this.Tokens, query.Tokens, check);
  }
  EqualIgnoringWhitespace(query: MQ): boolean {
    return query instanceof MQArbitraryTokens && TokensEqualIgnoringWhitespace(this.Tokens, query.Tokens);
  }
  Hash(): number { return HashTokens(3 >>> 0, this.Tokens); }
  CloneWithImportRecords(importRecordsIn: any[], importRecordsOut: any[]): [MQ, any[]] {
    const result = new MQArbitraryTokens();
    const [tokens, recs] = CloneTokensWithImportRecords(this.Tokens, importRecordsIn, null, importRecordsOut);
    result.Tokens = tokens;
    return [result, recs];
  }
}

/** Go: type MQPlainOrBoolean struct (css_ast.go:973) */
export class MQPlainOrBoolean {
  Name = "";
  ValueOrNil: Token[] = [];
  Equal(query: MQ, check: CrossFileEqualityCheck | null): boolean {
    return query instanceof MQPlainOrBoolean && this.Name === query.Name &&
      TokensEqual(this.ValueOrNil, query.ValueOrNil, check);
  }
  EqualIgnoringWhitespace(query: MQ): boolean {
    return query instanceof MQPlainOrBoolean && this.Name === query.Name &&
      TokensEqualIgnoringWhitespace(this.ValueOrNil, query.ValueOrNil);
  }
  Hash(): number {
    let hash = HashCombineString(4 >>> 0, bytes(this.Name));
    hash = HashTokens(hash, this.ValueOrNil);
    return hash >>> 0;
  }
  CloneWithImportRecords(importRecordsIn: any[], importRecordsOut: any[]): [MQ, any[]] {
    const result = new MQPlainOrBoolean(); result.Name = this.Name;
    let recs = importRecordsOut;
    if (this.ValueOrNil.length > 0) {
      const [tokens, r] = CloneTokensWithImportRecords(this.ValueOrNil, importRecordsIn, null, recs);
      result.ValueOrNil = tokens; recs = r;
    }
    return [result, recs];
  }
}

/** Go: type MQRange struct (css_ast.go:1003) */
export class MQRange {
  Before: Token[] = [];
  Name = "";
  After: Token[] = [];
  NameLoc = 0;
  BeforeCmp: MQCmp = 0;
  AfterCmp: MQCmp = 0;
  Equal(query: MQ, check: CrossFileEqualityCheck | null): boolean {
    return query instanceof MQRange && this.BeforeCmp === query.BeforeCmp && this.AfterCmp === query.AfterCmp &&
      this.Name === query.Name && TokensEqual(this.Before, query.Before, check) &&
      TokensEqual(this.After, query.After, check);
  }
  EqualIgnoringWhitespace(query: MQ): boolean {
    return query instanceof MQRange && this.BeforeCmp === query.BeforeCmp && this.AfterCmp === query.AfterCmp &&
      this.Name === query.Name && TokensEqualIgnoringWhitespace(this.Before, query.Before) &&
      TokensEqualIgnoringWhitespace(this.After, query.After);
  }
  Hash(): number {
    let hash = HashTokens(5 >>> 0, this.Before);
    hash = HashCombine(hash, this.BeforeCmp >>> 0);
    hash = HashCombineString(hash, bytes(this.Name));
    hash = HashCombine(hash, this.AfterCmp >>> 0);
    hash = HashTokens(hash, this.After);
    return hash >>> 0;
  }
  CloneWithImportRecords(importRecordsIn: any[], importRecordsOut: any[]): [MQ, any[]] {
    const result = new MQRange();
    let recs = importRecordsOut;
    let tokens: Token[];
    [tokens, recs] = CloneTokensWithImportRecords(this.Before, importRecordsIn, null, recs); result.Before = tokens;
    [tokens, recs] = CloneTokensWithImportRecords(this.After, importRecordsIn, null, recs); result.After = tokens;
    result.BeforeCmp = this.BeforeCmp; result.Name = this.Name; result.AfterCmp = this.AfterCmp;
    return [result, recs];
  }
}

// ============================================================================
// ComplexSelector / CompoundSelector / Combinator / SS* 选择器族
// ============================================================================

/** Go: type Combinator struct (css_ast.go:1266) */
export class Combinator {
  Loc: number = 0;
  Byte: number = 0;
}

/** Go: type CompoundSelector struct (css_ast.go:1271) —— Combinator 在 port 里是数字(Byte)，另有 CombinatorLoc */
export class CompoundSelector {
  // 保留宽松类型（历史基线）：测试构造 {}/ {range} 字面量，消费方按需 cast。
  TypeSelector: any = null;
  SubclassSelectors: any[] = [];
  NestingSelectorLocs: number[] = [];
  Combinator: number = 0;
  CombinatorLoc: number = 0;
  WasEmptyFromLocalOrGlobal = false;

  /** Go: func (sel CompoundSelector) IsSingleAmpersand() (css_ast.go:1281) */
  IsSingleAmpersand(): boolean { return IsSingleAmpersand(this); }
  /** Go: func (sel CompoundSelector) IsInvalidBecauseEmpty() (css_ast.go:1285) */
  IsInvalidBecauseEmpty(): boolean { return IsInvalidBecauseEmpty(this); }
  /** Go: func (sel CompoundSelector) Range() (css_ast.go:1289) */
  Range(): Range {
    let r = new Range();
    if (this.Combinator !== 0) r = new Range(new Loc(this.CombinatorLoc), 1);
    if (this.TypeSelector !== null) r.ExpandBy((this.TypeSelector as NamespacedName).Range());
    for (const loc of this.NestingSelectorLocs) r.ExpandBy(new Range(new Loc(loc), 1));
    for (const ss of this.SubclassSelectors as any[]) {
      const rr: Range | undefined = ss && (ss.Range ?? ss.range);
      if (rr) r.ExpandBy(rr);
    }
    return r;
  }
  /** Go: func (sel CompoundSelector) Clone() (css_ast.go:1300) */
  Clone(): CompoundSelector {
    const clone = new CompoundSelector();
    clone.NestingSelectorLocs = this.NestingSelectorLocs.slice();
    clone.Combinator = this.Combinator;
    clone.CombinatorLoc = this.CombinatorLoc;
    clone.WasEmptyFromLocalOrGlobal = this.WasEmptyFromLocalOrGlobal;
    if (this.TypeSelector !== null) clone.TypeSelector = (this.TypeSelector as NamespacedName).Clone();
    if (this.SubclassSelectors !== null) {
      clone.SubclassSelectors = (this.SubclassSelectors as SubclassSelector[]).map((ss) => {
        const c = new SubclassSelector();
        c.Range = ss.Range;
        c.Data = ss.Data.Clone();
        return c;
      });
    }
    return clone;
  }
}
/** TS 便捷别名 */
export function CloneCompoundSelector(sel: CompoundSelector): CompoundSelector { return sel.Clone(); }

/** Go: func (sel CompoundSelector) IsSingleAmpersand() (css_ast.go:1281) */
export function IsSingleAmpersand(sel: CompoundSelector): boolean {
  return sel.NestingSelectorLocs.length === 1 && sel.Combinator === 0 &&
    sel.TypeSelector === null && sel.SubclassSelectors.length === 0;
}
/** Go: func (sel CompoundSelector) IsInvalidBecauseEmpty() (css_ast.go:1285) */
export function IsInvalidBecauseEmpty(sel: CompoundSelector): boolean {
  return sel.NestingSelectorLocs.length === 0 && sel.TypeSelector === null && sel.SubclassSelectors.length === 0;
}

/** Go: type ComplexSelector struct (css_ast.go:1129) */
export class ComplexSelector {
  Selectors: CompoundSelector[] = [];
  /** Go: func (s ComplexSelector) Clone() (css_ast.go:1151) */
  Clone(): ComplexSelector {
    const clone = new ComplexSelector();
    clone.Selectors = this.Selectors.map((s) => s.Clone());
    return clone;
  }
  /** Go: func (sel ComplexSelector) ContainsNestingCombinator() (css_ast.go:1158) */
  ContainsNestingCombinator(): boolean {
    for (const inner of this.Selectors) {
      if (inner.NestingSelectorLocs.length > 0) return true;
      for (const ss of inner.SubclassSelectors) {
        if (ss.Data instanceof SSPseudoClassWithSelectorList) {
          for (const nested of ss.Data.Selectors) if (nested.ContainsNestingCombinator()) return true;
        }
      }
    }
    return false;
  }
  /** Go: func (sel ComplexSelector) IsRelative() (css_ast.go:1176) */
  IsRelative(): boolean {
    if (this.Selectors[0].Combinator === 0 && this.ContainsNestingCombinator()) return false;
    return true;
  }
  /** Go: func (sel ComplexSelector) UsesPseudoElement() (css_ast.go:1213) */
  UsesPseudoElement(): boolean { return complexSelectorUsesPseudoElement(this); }
  /** Go: func (a ComplexSelector) Equal(b, check) (css_ast.go:1234) */
  Equal(b: ComplexSelector, check: CrossFileEqualityCheck | null): boolean {
    if (this.Selectors.length !== b.Selectors.length) return false;
    for (let i = 0; i < this.Selectors.length; i++) {
      const ai = this.Selectors[i], bi = b.Selectors[i];
      if (ai.NestingSelectorLocs.length !== bi.NestingSelectorLocs.length || ai.Combinator !== bi.Combinator) return false;
      if ((ai.TypeSelector === null) !== (bi.TypeSelector === null)) return false;
      if (ai.TypeSelector !== null && bi.TypeSelector !== null && !ai.TypeSelector.Equal(bi.TypeSelector)) return false;
      if (ai.SubclassSelectors.length !== bi.SubclassSelectors.length) return false;
      for (let j = 0; j < ai.SubclassSelectors.length; j++) {
        if (!ai.SubclassSelectors[j].Data.Equal(bi.SubclassSelectors[j].Data, check)) return false;
      }
    }
    return true;
  }
}
/** TS 便捷别名 */
export function CloneComplexSelector(sel: ComplexSelector): ComplexSelector {
  const clone = new ComplexSelector();
  clone.Selectors = sel.Selectors.map((s) => (s instanceof CompoundSelector ? s.Clone() : cloneCompoundStandalone(s)));
  return clone;
}
/** 独立 CompoundSelector 克隆（消费方可能传普通对象字面量） */
function cloneCompoundStandalone(s: any): CompoundSelector {
  const c = new CompoundSelector();
  c.NestingSelectorLocs = (s.NestingSelectorLocs ?? []).slice();
  c.Combinator = s.Combinator ?? 0;
  c.CombinatorLoc = s.CombinatorLoc ?? 0;
  c.WasEmptyFromLocalOrGlobal = !!s.WasEmptyFromLocalOrGlobal;
  c.TypeSelector = s.TypeSelector ?? null;
  c.SubclassSelectors = (s.SubclassSelectors ?? []).slice();
  return c;
}

/** Go: func (sel ComplexSelector) UsesPseudoElement() 底座 */
function complexSelectorUsesPseudoElement(sel: ComplexSelector): boolean {
  for (const s of sel.Selectors) {
    for (const ss of s.SubclassSelectors as any[]) {
      // 端口存在两种形态：SubclassSelector{Data}（真 parser）与裸 SSPseudoClass（测试 IR）
      const data: any = ss instanceof SubclassSelector ? ss.Data : ss;
      if (data instanceof SSPseudoClass) {
        if (data.IsElement) return true;
        switch (data.Name) {
          case "before": case "after": case "first-line": case "first-letter": return true;
        }
      }
    }
  }
  return false;
}
/** TS 便捷函数（消费方以 CompoundSelector[] 直调） */
export function UsesPseudoElement(selectors: CompoundSelector[]): boolean {
  const sel = new ComplexSelector(); sel.Selectors = selectors;
  return complexSelectorUsesPseudoElement(sel);
}

/** Go: func ComplexSelectorsEqual(a, b []ComplexSelector, check) (css_ast.go:1134) */
export function ComplexSelectorsEqual(a: ComplexSelector[], b: ComplexSelector[], check: CrossFileEqualityCheck | null): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!a[i].Equal(b[i], check)) return false;
  return true;
}
/** Go: func HashComplexSelectors(hash, selectors []ComplexSelector) (css_ast.go:1146) */
export function HashComplexSelectors(hash: number, selectors: ComplexSelector[]): number {
  for (const complex of selectors) {
    hash = HashCombine(hash, complex.Selectors.length >>> 0);
    for (const sel of complex.Selectors) {
      hash = sel.TypeSelector !== null ? HashCombineString(hash, bytes(sel.TypeSelector.Name.Text)) : HashCombine(hash, 0);
      hash = HashCombine(hash, sel.SubclassSelectors.length >>> 0);
      for (const ss of sel.SubclassSelectors) hash = HashCombine(hash, ss.Data.Hash());
      hash = HashCombine(hash, sel.Combinator >>> 0);
    }
  }
  return hash >>> 0;
}

/** Go: type NameToken struct (css_ast.go:1322) */
export class NameToken {
  Text = "";
  Range: Range = new Range();
  Kind: number = 0;
  /** Go: func (a NameToken) Equal(b) (css_ast.go:1327) */
  Equal(b: NameToken): boolean { return this.Text === b.Text && this.Kind === b.Kind; }
}

/** Go: type NamespacedName struct (css_ast.go:1333) */
export class NamespacedName {
  NamespacePrefix: NameToken | null = null;
  Name: NameToken = new NameToken();
  /** Go: func (n NamespacedName) Range() (css_ast.go:1345) */
  Range(): Range {
    if (this.NamespacePrefix !== null) {
      const loc = this.NamespacePrefix.Range.Loc.Start;
      return new Range(new Loc(loc), this.Name.Range.End() - loc);
    }
    return this.Name.Range;
  }
  /** Go: func (n NamespacedName) Clone() (css_ast.go:1352) */
  Clone(): NamespacedName {
    const clone = new NamespacedName();
    clone.Name = this.Name;
    if (this.NamespacePrefix !== null) {
      const prefix = new NameToken();
      prefix.Text = this.NamespacePrefix.Text; prefix.Range = this.NamespacePrefix.Range; prefix.Kind = this.NamespacePrefix.Kind;
      clone.NamespacePrefix = prefix;
    }
    return clone;
  }
  /** Go: func (a NamespacedName) Equal(b) (css_ast.go:1360) —— 忠实复刻末项 bug: a.NamespacePrefix.Equal(b.Name) */
  Equal(b: NamespacedName): boolean {
    return this.Name.Equal(b.Name) && (this.NamespacePrefix === null) === (b.NamespacePrefix === null) &&
      (this.NamespacePrefix === null || b.NamespacePrefix === null || this.NamespacePrefix.Equal(b.Name));
  }
}
/** TS 便捷别名 */
export function CloneNamespacedName(n: NamespacedName): NamespacedName { return n.Clone(); }

/** Go: type SubclassSelector struct (css_ast.go:1367) */
export class SubclassSelector {
  Data: SS;
  Range: Range = new Range();
  constructor(data?: SS) { this.Data = data ?? new SSPseudoClass(); }
}

/** Go: SS 接口 (css_ast.go:1370) */
export type SS = SSHash | SSClass | SSAttribute | SSPseudoClass | SSPseudoClassWithSelectorList;

/** Go: type SSHash struct (css_ast.go:1378) */
export class SSHash {
  Name: LocRef = new LocRef();
  Equal(ss: SS, check: CrossFileEqualityCheck | null): boolean {
    return ss instanceof SSHash && refsEquivalent(check, this.Name.Ref, ss.Name.Ref);
  }
  Hash(): number { return 1; }
  Clone(): SS { const c = new SSHash(); c.Name = this.Name; return c; }
}

/** Go: type SSClass struct (css_ast.go:1397) */
export class SSClass {
  Name: LocRef = new LocRef();
  Equal(ss: SS, check: CrossFileEqualityCheck | null): boolean {
    return ss instanceof SSClass && refsEquivalent(check, this.Name.Ref, ss.Name.Ref);
  }
  Hash(): number { return 2; }
  Clone(): SS { const c = new SSClass(); c.Name = this.Name; return c; }
}

/** Go: type SSAttribute struct (css_ast.go:1416) */
export class SSAttribute {
  MatcherOp = "";
  MatcherValue = "";
  NamespacedName: NamespacedName = new NamespacedName();
  MatcherModifier = 0;
  Equal(ss: SS, _check: CrossFileEqualityCheck | null): boolean {
    return ss instanceof SSAttribute && this.NamespacedName.Equal(ss.NamespacedName) &&
      this.MatcherOp === ss.MatcherOp && this.MatcherValue === ss.MatcherValue &&
      this.MatcherModifier === ss.MatcherModifier;
  }
  Hash(): number {
    let hash = HashCombineString(3 >>> 0, bytes(this.NamespacedName.Name.Text));
    hash = HashCombineString(hash, bytes(this.MatcherOp));
    hash = HashCombineString(hash, bytes(this.MatcherValue));
    return hash >>> 0;
  }
  Clone(): SS { const c = new SSAttribute(); c.MatcherOp = this.MatcherOp; c.MatcherValue = this.MatcherValue; c.NamespacedName = this.NamespacedName.Clone(); c.MatcherModifier = this.MatcherModifier; return c; }
}

/** Go: type SSPseudoClass struct (css_ast.go:1443) */
export class SSPseudoClass {
  Name = "";
  Args: Token[] = [];
  IsElement = false;
  /** Go: Args 为 nil（无括号）vs 空 slice（空括号）的区分；TS 用独立标志承载 */
  HasParens = false;
  Equal(ss: SS, check: CrossFileEqualityCheck | null): boolean {
    return ss instanceof SSPseudoClass && this.Name === ss.Name &&
      TokensEqual(this.Args, ss.Args, check) && this.IsElement === ss.IsElement;
  }
  Hash(): number {
    let hash = HashCombineString(4 >>> 0, bytes(this.Name));
    hash = HashTokens(hash, this.Args);
    return hash >>> 0;
  }
  /** Go: func (ss *SSPseudoClass) Clone() —— 忠实复刻 Go bug：CloneTokens 结果赋给原对象、浅拷贝 */
  Clone(): SS {
    const clone = new SSPseudoClass();
    clone.Name = this.Name; clone.IsElement = this.IsElement; clone.Args = this.Args;
    if (this.Args !== null) this.Args = CloneTokensWithoutImportRecords(this.Args);
    return clone;
  }
}

/** Go: type PseudoClassKind uint8 (css_ast.go:1469) */
export type PseudoClassKind = number;
export const PseudoClassKindAll = {
  PseudoClassGlobal: 0, PseudoClassHas: 1, PseudoClassIs: 2, PseudoClassLocal: 3, PseudoClassNot: 4,
  PseudoClassNthChild: 5, PseudoClassNthLastChild: 6, PseudoClassNthLastOfType: 7, PseudoClassNthOfType: 8, PseudoClassWhere: 9,
} as const;
/** Go 枚举别名（与 PseudoClassKindAll 同值） */
export const PseudoClassKind = PseudoClassKindAll;
/** Go: func (kind PseudoClassKind) HasNthIndex() (css_ast.go:1484) */
export function HasNthIndex(kind: PseudoClassKind): boolean {
  return kind >= 5 /* NthChild */ && kind <= 8 /* NthOfType */;
}
/** Go: func (kind PseudoClassKind) String() (css_ast.go:1488) */
export function PseudoClassKindString(kind: PseudoClassKind): string {
  switch (kind) {
    case 0: return "global";
    case 1: return "has";
    case 2: return "is";
    case 3: return "local";
    case 4: return "not";
    case 5: return "nth-child";
    case 6: return "nth-last-child";
    case 7: return "nth-last-of-type";
    case 8: return "nth-of-type";
    case 9: return "where";
    default: throw new Error("Internal error");
  }
}
/** 先前别名（第 44 轮遗留） */
export function pseudoClassKindString(kind: PseudoClassKind): string { return PseudoClassKindString(kind); }
/** Go: func (kind PseudoClassKind) String() —— 以重导出别名提供 String；board 口径：Go 方法名 String 不挂到 TS number 别名，仍记 missing（batch 103）。测试 import { String } 可用。 */
export { PseudoClassKindString as String };

/** Go: type NthIndex struct (css_ast.go:1516) */
export class NthIndex {
  A = "";
  B = "";
  /** Go: func (index *NthIndex) Minify() (css_ast.go:1521) */
  Minify(): void {
    if (this.B === "even") { this.A = "2"; this.B = ""; return; }
    if (this.A === "2" && this.B === "1") { this.A = ""; this.B = "odd"; return; }
    if (this.A === "0") { this.A = ""; if (this.B === "") this.B = "0"; return; }
    if (this.B === "0" && this.A !== "") this.B = "";
  }
}

/** Go: type SSPseudoClassWithSelectorList struct (css_ast.go:1553) */
export class SSPseudoClassWithSelectorList {
  Selectors: ComplexSelector[] = [];
  Index: NthIndex = new NthIndex();
  Kind: PseudoClassKind = 0;
  Equal(ss: SS, check: CrossFileEqualityCheck | null): boolean {
    return ss instanceof SSPseudoClassWithSelectorList && this.Kind === ss.Kind &&
      this.Index.A === ss.Index.A && this.Index.B === ss.Index.B &&
      ComplexSelectorsEqual(this.Selectors, ss.Selectors, check);
  }
  Hash(): number {
    let hash = HashCombine(5 >>> 0, this.Kind >>> 0);
    hash = HashCombineString(hash, bytes(this.Index.A));
    hash = HashCombineString(hash, bytes(this.Index.B));
    hash = HashComplexSelectors(hash, this.Selectors);
    return hash >>> 0;
  }
  Clone(): SS {
    const clone = new SSPseudoClassWithSelectorList();
    clone.Kind = this.Kind;
    clone.Index = new NthIndex(); clone.Index.A = this.Index.A; clone.Index.B = this.Index.B;
    clone.Selectors = this.Selectors.map((s) => s.Clone());
    return clone;
  }
}
