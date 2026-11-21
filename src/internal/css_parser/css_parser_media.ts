// 1:1 移植自 esbuild internal/css_parser/css_parser_media.go（v0.28.2，commit f6058f83）
// 第 51 轮叶子优先规划：媒体查询 token 扫描助手。真值表由 Go 探针固化在 testdata/css-media-token-go.json。
import { MQCmp, T, Token, Dir, MQPlainOrBoolean, MQNot, MQRange, MediaQuery } from "../css_ast/css_ast.ts";

const WhitespaceBefore = 1;
const WhitespaceAfter = 2;

/** Go: func parsePlainOrBooleanMediaFeature(tokens []css_ast.Token) (*MQPlainOrBoolean, bool) (css_parser_media.go:261) */
export function parsePlainOrBooleanMediaFeature(tokens: Token[]): { result: MQPlainOrBoolean | null; ok: boolean } {
  if (tokens.length === 1 && tokens[0].Kind === T.TIdent) {
    const q = new MQPlainOrBoolean(); q.Name = tokens[0].Text;
    return { result: q, ok: true };
  }
  if (tokens.length >= 3 && tokens[0].Kind === T.TIdent && tokens[1].Kind === 9 /* TColon */) {
    const v = scanMediaValue(tokens.slice(2));
    if (v.rest.length === 0) { const q = new MQPlainOrBoolean(); q.Name = tokens[0].Text; q.ValueOrNil = v.value; return { result: q, ok: true }; }
  }
  return { result: null, ok: false };
}

/** Go: func parseRangeMediaFeature(tokens []css_ast.Token) (*MQRange, bool) (css_parser_media.go:273) */
export function parseRangeMediaFeature(tokens: Token[]): { result: MQRange | null; ok: boolean } {
  const first = scanMediaValue(tokens);
  if (first.value.length > 0) {
    const c1 = scanMediaComparison(first.rest);
    if (c1.cmp !== MQCmp.MQCmpNone) {
      const second = scanMediaValue(c1.rest);
      if (second.value.length > 0) {
        if (second.rest.length === 0) {
          const a = isSingleIdent(first.value);
          if (a.ok) { const q = new MQRange(); q.Name = a.value; q.NameLoc = a.loc; q.AfterCmp = c1.cmp; q.After = second.value; return { result: q, ok: true }; }
          const b = isSingleIdent(second.value);
          if (b.ok) { const q = new MQRange(); q.Before = first.value; q.BeforeCmp = c1.cmp; q.Name = b.value; q.NameLoc = b.loc; return { result: q, ok: true }; }
        } else {
          const b = isSingleIdent(second.value);
          if (b.ok) {
            const c2 = scanMediaComparison(second.rest);
            if (c2.cmp !== MQCmp.MQCmpNone) {
              const f = Dir(c1.cmp), s = Dir(c2.cmp);
              if ((f < 0 && s < 0) || (f > 0 && s > 0)) {
                const third = scanMediaValue(c2.rest);
                if (third.value.length > 0 && third.rest.length === 0) {
                  const q = new MQRange(); q.Before = first.value; q.BeforeCmp = c1.cmp; q.Name = b.value; q.NameLoc = b.loc; q.AfterCmp = c2.cmp; q.After = third.value;
                  return { result: q, ok: true };
                }
              }
            }
          }
        }
      }
    }
  }
  return { result: null, ok: false };
}

/** Go: func lowerMediaRange(loc, name, cmp, value) MediaQuery (css_parser_media.go:233) */
export function lowerMediaRange(loc: number, name: string, cmp: MQCmp, value: Token[]): MediaQuery {
  const q = new MediaQuery(); q.Loc = loc;
  const plain = (n: string): MQPlainOrBoolean => { const p = new MQPlainOrBoolean(); p.Name = n; p.ValueOrNil = value; return p; };
  switch (cmp) {
    case MQCmp.MQCmpLe: q.Data = plain("max-" + name); break;
    case MQCmp.MQCmpGe: q.Data = plain("min-" + name); break;
    case MQCmp.MQCmpLt: { const n = new MQNot(); const inner = new MediaQuery(); inner.Loc = loc; inner.Data = plain("min-" + name); n.Inner = inner; q.Data = n; break; }
    case MQCmp.MQCmpGt: { const n = new MQNot(); const inner = new MediaQuery(); inner.Loc = loc; inner.Data = plain("max-" + name); n.Inner = inner; q.Data = n; break; }
    default: q.Data = plain(name); break;
  }
  return q;
}

/** Go: func isSingleIdent(tokens []css_ast.Token) (string, logger.Loc, bool) (css_parser_media.go:352) */
export function isSingleIdent(tokens: Token[]): { value: string; loc: number; ok: boolean } {
  if (tokens.length === 1 && tokens[0].Kind === T.TIdent) {
    return { value: tokens[0].Text, loc: tokens[0].Loc, ok: true };
  }
  return { value: "", loc: 0, ok: false };
}

/** Go: func scanMediaComparison(tokens []css_ast.Token) (css_ast.MQCmp, []css_ast.Token) (css_parser_media.go:360) */
export function scanMediaComparison(tokens: Token[]): { cmp: MQCmp; rest: Token[] } {
  if (tokens.length >= 1) {
    switch (tokens[0].Kind) {
      case T.TDelimEquals:
        return { cmp: MQCmp.MQCmpEq, rest: tokens.slice(1) };
      case T.TDelimLessThan:
        if (tokens.length >= 2 && tokens[1].Kind === T.TDelimEquals &&
          ((tokens[0].Whitespace & WhitespaceAfter) | (tokens[1].Whitespace & WhitespaceBefore)) === 0) {
          return { cmp: MQCmp.MQCmpLe, rest: tokens.slice(2) };
        }
        return { cmp: MQCmp.MQCmpLt, rest: tokens.slice(1) };
      case T.TDelimGreaterThan:
        if (tokens.length >= 2 && tokens[1].Kind === T.TDelimEquals &&
          ((tokens[0].Whitespace & WhitespaceAfter) | (tokens[1].Whitespace & WhitespaceBefore)) === 0) {
          return { cmp: MQCmp.MQCmpGe, rest: tokens.slice(2) };
        }
        return { cmp: MQCmp.MQCmpGt, rest: tokens.slice(1) };
    }
  }
  return { cmp: MQCmp.MQCmpNone, rest: tokens };
}

/** Go: func scanMediaValue(tokens []css_ast.Token) ([]css_ast.Token, []css_ast.Token) (css_parser_media.go:387) */
export function scanMediaValue(tokens: Token[]): { value: Token[]; rest: Token[] } {
  let n = 0;
  if (tokens.length >= 1) {
    switch (tokens[0].Kind) {
      case T.TDimension:
      case T.TIdent:
        n = 1;
        break;
      case T.TNumber:
        if (tokens.length >= 3 && tokens[1].Kind === T.TDelimSlash && tokens[2].Kind === T.TNumber) n = 3;
        else n = 1;
        break;
    }
  }
  // Trim whitespace at the endpoints (note: Go trims in-place; TS clones to avoid mutating fixtures)
  const value = tokens.slice(0, n).map((t) => new Token());
  for (let i = 0; i < n; i++) {
    value[i].Kind = tokens[i].Kind;
    value[i].Text = tokens[i].Text;
    value[i].Loc = tokens[i].Loc;
    value[i].Whitespace = tokens[i].Whitespace;
  }
  if (n > 0) {
    value[0].Whitespace &= ~WhitespaceBefore;
    value[n - 1].Whitespace &= ~WhitespaceAfter;
  }
  return { value, rest: tokens.slice(n) };
}

// ============================================================================
// 第 118 批：media 解析链 7 函数（Go 探针 23 例，css-media-go.json）。
// Go 的 parser 方法在 TS 以显式 p: CSSParser 参数呈现，IR dump 逐字节。
// ============================================================================
import { CSSParser } from "./css_parser.ts";
import { MQType, MQBinary, MQArbitraryTokens, Flip } from "../css_ast/css_ast.ts";
import type { MediaQueryData } from "../css_ast/css_ast.ts";
import { T as LT } from "../css_lexer/css_lexer.ts";
import { Token as ASTToken } from "../css_ast/css_ast.ts";

// Go 的 convertTokens 会把 "(" ... ")" 合成一个带 Children 的 token；本文件只做媒体查询
// 所需的单组折叠，避免改动 css_parser.ts 里已由批量探针钉死的 convertTokensHelper。
function convertGrouped(p: CSSParser, toks: any[]): ASTToken[] {
  if (toks.length >= 1 && toks[0].kind === LT.TOpenParen) {
    const inner = toks.slice(1);
    if (inner.length > 0 && inner[inner.length - 1].kind === LT.TCloseParen) inner.pop();
    const token = new ASTToken();
    token.Kind = LT.TOpenParen; token.Text = "("; token.Loc = toks[0].rangeLoc;
    token.Children = p.convertTokens(inner);
    return [token];
  }
  return p.convertTokens(toks);
}
const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const mkQ = (loc: number, data: MediaQueryData): MediaQuery => { const q = new MediaQuery(); q.Loc = loc; q.Data = data; return q; };
const emptyQ = (): MediaQuery => new MediaQuery();

/** Go: func (p *parser) looksLikeMediaCondition() bool (css_parser_media.go:96) */
export function looksLikeMediaCondition(p: CSSParser): boolean {
  const kind = p.current().kind;
  return kind === LT.TOpenParen || kind === LT.TFunction ||
    (kind === LT.TIdent && eq(p.decoded(), "not") && p.next().kind === LT.TWhitespace && p.at(p.index + 2).kind === LT.TOpenParen);
}

/** Go: func (p *parser) parseMediaQuery() (css_ast.MediaQuery, bool) (css_parser_media.go:39) */
export function parseMediaQuery(p: CSSParser): { query: MediaQuery; ok: boolean } {
  const loc = p.current().rangeLoc;
  if (looksLikeMediaCondition(p)) return parseMediaCondition(p, 0 /* mediaWithOr */);

  const mediaType = p.decoded();
  if (!p.peek(LT.TIdent)) { p.expect(LT.TIdent); return { query: emptyQ(), ok: false }; }
  let op = 0;
  if (eq(mediaType, "not")) op = 1;
  else if (eq(mediaType, "only")) op = 2;
  let name = mediaType;
  if (op !== 0) {
    p.advance(); p.eat(LT.TWhitespace);
    name = p.decoded();
    if (!p.peek(LT.TIdent)) { p.expect(LT.TIdent); return { query: emptyQ(), ok: false }; }
  }
  if (eq(name, "only") || eq(name, "not") || eq(name, "and") || eq(name, "or") || eq(name, "layer")) {
    p.unexpected(); return { query: emptyQ(), ok: false };
  }
  p.advance(); p.eat(LT.TWhitespace);

  let andOrNull = emptyQ();
  if (p.peek(LT.TIdent) && eq(p.decoded(), "and")) {
    p.advance(); p.eat(LT.TWhitespace);
    const inner = parseMediaCondition(p, 1 /* mediaWithoutOr */);
    if (!inner.ok) return { query: emptyQ(), ok: false };
    andOrNull = inner.query;
  }
  const data = new MQType(); data.Op = op; data.Type = name; data.AndOrNull = andOrNull;
  return { query: mkQ(loc, data), ok: true };
}

/** Go: func (p *parser) parseMediaCondition(or mediaOr) (css_ast.MediaQuery, bool) (css_parser_media.go:111) */
export function parseMediaCondition(p: CSSParser, or: number): { query: MediaQuery; ok: boolean } {
  const loc = p.current().rangeLoc;
  if (p.peek(LT.TIdent) && eq(p.decoded(), "not")) {
    p.advance(); p.eat(LT.TWhitespace);
    const inner = parseMediaInParens(p);
    if (!inner.ok) return { query: emptyQ(), ok: false };
    return { query: maybeSimplifyMediaNot(p, loc, inner.query), ok: true };
  }
  const first = parseMediaInParens(p);
  if (!first.ok) return { query: emptyQ(), ok: false };
  p.eat(LT.TWhitespace);
  if (p.peek(LT.TIdent)) {
    const keyword = p.decoded();
    if (eq(keyword, "and") || (or === 0 && eq(keyword, "or"))) {
      const op = keyword.length === 2 ? 1 : 0;
      let inner = appendMediaTerm(p, [], first.query, op);
      for (;;) {
        p.advance(); p.eat(LT.TWhitespace);
        const next = parseMediaInParens(p);
        if (!next.ok) return { query: emptyQ(), ok: false };
        inner = appendMediaTerm(p, inner, next.query, op);
        p.eat(LT.TWhitespace);
        if (!p.peek(LT.TIdent) || !eq(p.decoded(), keyword)) break;
      }
      const data = new MQBinary(); data.Op = op; data.Terms = inner;
      return { query: mkQ(loc, data), ok: true };
    }
  }
  return first;
}

/** Go: func (p *parser) appendMediaTerm(inner []css_ast.MediaQuery, term css_ast.MediaQuery, op) []css_ast.MediaQuery (css_parser_media.go:160) */
export function appendMediaTerm(p: CSSParser, inner: MediaQuery[], term: MediaQuery, op: number): MediaQuery[] {
  if (term.Data instanceof MQBinary && term.Data.Op === op && p.options.minifySyntax) return inner.concat(term.Data.Terms);
  return inner.concat([term]);
}

/** Go: func (p *parser) parseMediaInParens() (css_ast.MediaQuery, bool) (css_parser_media.go:170) */
export function parseMediaInParens(p: CSSParser): { query: MediaQuery; ok: boolean } {
  p.eat(LT.TWhitespace);
  const start = p.index;
  const isFunction = p.eat(LT.TFunction);
  if (!isFunction && !p.expect(LT.TOpenParen)) return { query: emptyQ(), ok: false };
  p.eat(LT.TWhitespace);

  if (!isFunction && looksLikeMediaCondition(p)) {
    const inner = parseMediaCondition(p, 0);
    if (!inner.ok) return { query: emptyQ(), ok: false };
    p.eat(LT.TWhitespace);
    if (!p.expect(LT.TCloseParen)) return { query: emptyQ(), ok: false };
    return inner;
  }

  while (!p.peek(LT.TCloseParen) && !p.peek(LT.TEndOfFile)) p.parseComponentValue();
  const end = p.index;
  if (!p.expect(LT.TCloseParen)) return { query: emptyQ(), ok: false };
  const tokens = convertGrouped(p, p.tokens.slice(start, end));
  const loc = tokens.length > 0 ? tokens[0].Loc : 0;

  if (!isFunction && tokens.length === 1 && tokens[0].Children) {
    const children = tokens[0].Children;
    const plain = parsePlainOrBooleanMediaFeature(children);
    if (plain.ok) return { query: mkQ(loc, plain.result!), ok: true };
    const range = parseRangeMediaFeature(children);
    if (range.ok) return { query: mkQ(loc, range.result!), ok: true };
  }
  const arbitrary = new MQArbitraryTokens(); arbitrary.Tokens = tokens;
  return { query: mkQ(loc, arbitrary), ok: true };
}

/** Go: func (p *parser) maybeSimplifyMediaNot(loc logger.Loc, inner css_ast.MediaQuery) css_ast.MediaQuery (css_parser_media.go:315) */
export function maybeSimplifyMediaNot(p: CSSParser, loc: number, inner: MediaQuery): MediaQuery {
  if (p.options.minifySyntax && inner.Data) {
    if (inner.Data instanceof MQNot) return inner.Data.Inner;
    if (inner.Data instanceof MQBinary) {
      const terms: MediaQuery[] = [];
      for (const term of inner.Data.Terms) {
        if (term.Data instanceof MQNot) terms.push(term.Data.Inner);
        else break;
      }
      if (terms.length === inner.Data.Terms.length) {
        inner.Data.Op ^= 1; inner.Data.Terms = terms;
        return inner;
      }
    }
    if (inner.Data instanceof MQRange) {
      const d = inner.Data;
      if ((d.BeforeCmp === 0 && d.AfterCmp !== 1) || (d.AfterCmp === 0 && d.BeforeCmp !== 1)) {
        d.BeforeCmp = Flip(d.BeforeCmp); d.AfterCmp = Flip(d.AfterCmp);
        return inner;
      }
    }
  }
  const not = new MQNot(); not.Inner = inner;
  return mkQ(loc, not);
}

/** Go: func (p *parser) parseMediaQueryListUntil(stop func(css_lexer.T) bool) []css_ast.MediaQuery (css_parser_media.go:13) */
export function parseMediaQueryListUntil(p: CSSParser, stop: (kind: number) => boolean): MediaQuery[] {
  const queries: MediaQuery[] = [];
  p.eat(LT.TWhitespace);
  while (!p.peek(LT.TEndOfFile) && !stop(p.current().kind)) {
    const start = p.index;
    const parsed = parseMediaQuery(p);
    let query = parsed.query;
    if (!parsed.ok) {
      p.index = start;
      const loc = p.current().rangeLoc;
      while (!p.peek(LT.TEndOfFile) && !stop(p.current().kind) && !p.peek(LT.TComma)) p.parseComponentValue();
      const tokens = convertGrouped(p, p.tokens.slice(start, p.index));
      const arbitrary = new MQArbitraryTokens(); arbitrary.Tokens = tokens;
      query = mkQ(loc, arbitrary);
    }
    queries.push(query);
    p.eat(LT.TWhitespace);
    if (!p.eat(LT.TComma)) break;
    p.eat(LT.TWhitespace);
  }
  return queries;
}
