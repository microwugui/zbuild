// 1:1 移植自 esbuild internal/css_lexer/css_lexer.go（v0.28.2，commit f6058f83）
// 第 44 轮叶子优先规划：CSS token / 字符谓词。真值表由 Go 探针固化在
// testdata/css-lexer-pred-go.json。
import { decodeRune, RuneError } from "../logger/bytes.ts";
import { Loc, Range, Source, Span } from "../logger/logger.ts";

/** Go: type Comment struct (css_lexer.go:189) */
export class CSSComment {
  text: Uint8Array = new Uint8Array(0);
  loc: number = 0;
  tokenIndexAfter = 0;
}

/** Go: css_lexer.T 相关枚举值（Go 探针实测） */
export type T = number;
export const T = {
  TEndOfFile: 0, TAtKeyword: 1, TBadString: 2, TBadURL: 3, TCDC: 4, TCDO: 5,
  TCloseBrace: 6, TCloseBracket: 7, TCloseParen: 8, TColon: 9, TComma: 10, TDelim: 11,
  TDelimAmpersand: 12, TDelimAsterisk: 13, TDelimBar: 14, TDelimCaret: 15, TDelimDollar: 16,
  TDelimDot: 17, TDelimEquals: 18, TDelimExclamation: 19, TDelimGreaterThan: 20, TDelimLessThan: 21,
  TDelimMinus: 22, TDelimPlus: 23, TDelimSlash: 24, TDelimTilde: 25, TDimension: 26, TFunction: 27,
  THash: 28, TIdent: 29, TNumber: 30, TOpenBrace: 31, TOpenBracket: 32, TOpenParen: 33,
  TPercentage: 34, TSemicolon: 35, TString: 36, TURL: 37, TWhitespace: 38, TSymbol: 39,
} as const;
/** Go: TokenFlags (css_lexer.go:118) */
export const IsID = 1, DidWarnAboutSingleLineComment = 2;

/** Go: var tokenToString []string (css_lexer.go:66) */
export const tokenToString: string[] = [
  "end of file", "@-keyword", "bad string token", "bad URL token", '"-->"', '"<!--"', '"}"', '"]"',
  '")"', '":"', '","', "delimiter", '"&"', '"*"', '"|"', '"^"', '"$"', '"."', '"="', '"!"',
  '">"', '"<"', '"-"', '"+"', '"/"', '"~"', "dimension", "function token", "hash token",
  "identifier", "number", '"{"', '"["', '"("', "percentage", '";"', "string token", "URL token",
  "whitespace", "identifier",
];

/** Go: func (t T) String() string (css_lexer.go:110) */
export function String(t: T): string { return tokenToString[t] ?? ""; }

/** Go: func (t T) IsNumeric() bool (css_lexer.go:114) */
export function IsNumeric(t: T): boolean {
  return t === T.TNumber || t === T.TPercentage || t === T.TDimension;
}

/** Go: func IsNameStart(c rune) bool (css_lexer.go:956) */
export function IsNameStart(c: number): boolean {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || c === 0x5f || c >= 0x80 || c === 0x00;
}

/** Go: func IsNameContinue(c rune) bool (css_lexer.go:960) */
export function IsNameContinue(c: number): boolean {
  return IsNameStart(c) || (c >= 0x30 && c <= 0x39) || c === 0x2d;
}

/** Go: func containsAtPreserveOrAtLicense(text string) bool (css_lexer.go:554) */
export function containsAtPreserveOrAtLicense(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "@" && (text.slice(i + 1).startsWith("preserve") || text.slice(i + 1).startsWith("license"))) return true;
  }
  return false;
}

/** Go: func decodeEscapesInToken(inner string) string (css_lexer.go:997) */
export function decodeEscapesInToken(inner: string): string {
  const bytes = new TextEncoder().encode(inner);
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] === 0x5c || bytes[i] === 0x00) break;
    i++;
  }
  if (i === bytes.length) return new TextDecoder().decode(bytes);

  let sb = new TextDecoder().decode(bytes.subarray(0, i));
  let off = i;
  const writeRune = (r: number): void => { sb += globalThis.String.fromCodePoint(r); };
  while (off < bytes.length) {
    let d = decodeRune(bytes, off);
    let c = d.r;
    off += d.width;
    if (c !== 0x5c) {
      writeRune(c === 0x00 ? RuneError : c);
      continue;
    }
    if (off >= bytes.length) { writeRune(RuneError); continue; }
    d = decodeRune(bytes, off);
    c = d.r; off += d.width;
    const h = isHex(c);
    let hex = h.value;
    if (!h.ok) {
      if (c === 0x0a || c === 0x0c) continue;
      if (c === 0x0d) {
        const d2 = decodeRune(bytes, off);
        if (d2.r === 0x0a) off += d2.width;
        continue;
      }
      writeRune(c);
      continue;
    }
    for (let j = 0; j < 5 && off < bytes.length; j++) {
      const d2 = decodeRune(bytes, off);
      const nx = isHex(d2.r);
      if (nx.ok) { hex = hex * 16 + nx.value; off += d2.width; }
      else break;
    }
    if (off < bytes.length) {
      const d2 = decodeRune(bytes, off);
      if (isWhitespace(d2.r)) off += d2.width;
    }
    if (hex === 0 || (hex >= 0xd800 && hex <= 0xdfff) || hex > 0x10ffff) writeRune(RuneError);
    else writeRune(hex);
  }
  return sb;
}

/** Go: func RangeOfIdentifier(source logger.Source, loc logger.Loc) logger.Range (css_lexer.go:615) */
export function RangeOfIdentifier(source: Source, loc: Loc): Range {
  const text = source.Contents;
  const start = loc.Start;
  if (start >= text.length) return new Range(new Loc(start), 0);
  let i = 0;
  const n = text.length - start;
  for (;;) {
    const d = decodeRune(text, start + i);
    const c = d.r, width = d.width;
    if (IsNameContinue(c)) { i += width; continue; }
    if (c === 0x5c && i + 1 < n && !isNewline(text[start + i + 1])) {
      i += width;
      let d2 = decodeRune(text, start + i);
      if (isHex(d2.r).ok) {
        i += d2.width;
        d2 = decodeRune(text, start + i);
        for (let j = 0; j < 5; j++) {
          if (!isHex(d2.r).ok) break;
          i += d2.width;
          d2 = decodeRune(text, start + i);
        }
        if (isWhitespace(d2.r)) i += d2.width;
      }
      continue;
    }
    break;
  }
  if (i > 0 && isWhitespace(text[start + i - 1])) i--;
  return new Range(new Loc(start), i | 0);
}

/** Go: func isNonPrintable(c rune) bool (css_lexer.go:993) */
export function isNonPrintable(c: number): boolean {
  return c <= 0x08 || c === 0x0b || (c >= 0x0e && c <= 0x1f) || c === 0x7f;
}

/** Go: func isNewline(c rune) bool (css_lexer.go:964) */
export function isNewline(c: number): boolean {
  return c === 0x0a || c === 0x0d || c === 0x0c;
}

/** Go: func isWhitespace(c rune) bool (css_lexer.go:972) */
export function isWhitespace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c;
}

/** Go: func isHex(c rune) (int, bool) (css_lexer.go:980) */
export function isHex(c: number): { value: number; ok: boolean } {
  if (c >= 0x30 && c <= 0x39) return { value: c - 0x30, ok: true };
  if (c >= 0x61 && c <= 0x66) return { value: c + (10 - 0x61), ok: true };
  if (c >= 0x41 && c <= 0x46) return { value: c + (10 - 0x41), ok: true };
  return { value: 0, ok: false };
}

/** Go: func WouldStartIdentifierWithoutEscapes(text string) bool (css_lexer.go:594) */
export function WouldStartIdentifierWithoutEscapes(text: string): boolean {
  if (text.length === 0) return false;
  const c = text.codePointAt(0)!;
  if (c > 0x10ffff) return false;
  if (IsNameStart(c)) return true;
  if (c === 0x2d /* '-' */) {
    const width = c > 0xffff ? 2 : 1;
    if (width >= text.length) return false;
    const c2 = text.codePointAt(width)!;
    if (IsNameStart(c2) || c2 === 0x2d) return true;
  }
  return false;
}

const eof = -1;

/** Go: type Token struct (css_lexer.go:128) —— 只落 DecodedText 用到的字段 */
export class Token {
  rangeLoc: number = 0;
  rangeLen: number = 0;
  unitOffset: number = 0;
  kind: number = 0;
  flags: number = 0;

  /** Go: func (token Token) DecodedText(contents string) string (css_lexer.go:135) */
  DecodedText(contents: Uint8Array): string {
    const raw = contents.subarray(this.rangeLoc, this.rangeLoc + this.rangeLen);
    const dec = new TextDecoder();
    switch (this.kind) {
      case 29 /* TIdent */: case 26 /* TDimension */: return decodeEscapesInToken(dec.decode(raw));
      case 1 /* TAtKeyword */: case 28 /* THash */: return decodeEscapesInToken(dec.decode(raw.subarray(1)));
      case 27 /* TFunction */: return decodeEscapesInToken(dec.decode(raw.subarray(0, raw.length - 1)));
      case 36 /* TString */: return decodeEscapesInToken(dec.decode(raw.subarray(1, raw.length - 1)));
      case 37 /* TURL */: {
        let start = 4, end = raw.length;
        const rawStr = dec.decode(raw);
        if (rawStr[end - 1] === ")") end--;
        while (start < end && isWhitespace(raw[start])) start++;
        while (start < end && isWhitespace(raw[end - 1])) end--;
        return decodeEscapesInToken(dec.decode(raw.subarray(start, end)));
      }
    }
    return dec.decode(raw);
  }
}

/** Go: type lexer struct (css_lexer.go:174) —— 只落状态机助手用到的字段 */
export class Lexer {
  contents: Uint8Array = new Uint8Array(0);
  current: number = 0;
  codePoint: number = eof;
  tokenRangeLoc: number = 0;
  tokenRangeLen: number = 0;
  tokenKind: number = 0;
  tokenFlags: number = 0;
  tokenUnitOffset: number = 0;
  approximateNewlineCount: number = 0;
  oldSingleLineCommentEnd: number = 0;
  source: Source = new Source();
  recordAllComments: boolean = false;
  allComments: Range[] = [];
  legalCommentsBefore: CSSComment[] = [];
  sourceMappingURLText: Uint8Array = new Uint8Array(0);
  sourceMappingURLLoc: number = 0;
  sourceMappingURLLen: number = 0;

  /** Go: func (lexer *lexer) step() (css_lexer.go:256) */
  step(): void {
    let cp: number, width: number;
    if (this.current >= this.contents.length) { cp = eof; width = 0; }
    else { const d = decodeRune(this.contents, this.current); cp = d.r; width = d.width; }
    if (cp === 0x0a) this.approximateNewlineCount++;
    this.codePoint = cp;
    this.tokenRangeLen = this.current - this.tokenRangeLoc;
    this.current += width;
  }

  /** Go: func (lexer *lexer) isValidEscape() bool (css_lexer.go:563) */
  isValidEscape(): boolean {
    if (this.codePoint !== 0x5c) return false;
    let c: number;
    if (this.current >= this.contents.length) c = RuneError;
    else c = decodeRune(this.contents, this.current).r;
    return !isNewline(c);
  }

  /** Go: func (lexer *lexer) wouldStartNumber() bool (css_lexer.go:663) */
  wouldStartNumber(): boolean {
    if (this.codePoint >= 0x30 && this.codePoint <= 0x39) return true;
    if (this.codePoint === 0x2e) {
      if (this.current < this.contents.length) {
        const c = this.contents[this.current];
        return c >= 0x30 && c <= 0x39;
      }
    } else if (this.codePoint === 0x2b || this.codePoint === 0x2d) {
      const n = this.contents.length;
      if (this.current < n) {
        let c = this.contents[this.current];
        if (c >= 0x30 && c <= 0x39) return true;
        if (c === 0x2e && this.current + 1 < n) {
          c = this.contents[this.current + 1];
          return c >= 0x30 && c <= 0x39;
        }
      }
    }
    return false;
  }

  /** Go: func (lexer *lexer) consumeEscape() rune (css_lexer.go:728) */
  consumeEscape(): number {
    this.step();
    const c = this.codePoint;
    const h = isHex(c);
    if (h.ok) {
      let hex = h.value;
      this.step();
      for (let i = 0; i < 5; i++) {
        const nx = isHex(this.codePoint);
        if (nx.ok) { this.step(); hex = hex * 16 + nx.value; }
        else break;
      }
      if (isWhitespace(this.codePoint)) this.step();
      if (hex === 0 || (hex >= 0xd800 && hex <= 0xdfff) || hex > 0x10ffff) return RuneError;
      return hex;
    }
    if (c === eof) return RuneError;
    this.step();
    return c;
  }

  /** Go: func (lexer *lexer) consumeToEndOfMultiLineComment(startRange logger.Range) (css_lexer.go:493) */
  consumeToEndOfMultiLineComment(startLoc: number): void {
    const contents = this.contents;
    const dec = new TextDecoder();
    let startOfSourceMappingURL = 0;
    let isLegalComment = false;
    const cp = this.codePoint;
    if (cp === 0x23 /* # */ || cp === 0x40 /* @ */) {
      const marker = new TextEncoder().encode(" sourceMappingURL=");
      const tail = contents.subarray(this.current);
      if (tail.length >= marker.length && marker.every((b, i) => tail[i] === b)) {
        startOfSourceMappingURL = this.current + marker.length;
      }
    } else if (cp === 0x21 /* ! */) {
      isLegalComment = true;
    }
    for (;;) {
      if (this.codePoint === 0x2a /* * */) {
        const endOfSourceMappingURL = this.current - 1;
        this.step();
        if ((this.codePoint as number) === 0x2f /* / */) {
          const commentEnd = this.current;
          this.step();
          if (startOfSourceMappingURL !== 0) {
            let len = 0;
            while (startOfSourceMappingURL + len < endOfSourceMappingURL && !isWhitespace(contents[startOfSourceMappingURL + len])) len++;
            this.sourceMappingURLText = contents.subarray(startOfSourceMappingURL, startOfSourceMappingURL + len);
            this.sourceMappingURLLoc = startOfSourceMappingURL;
            this.sourceMappingURLLen = len;
          }
          if (this.recordAllComments) this.allComments.push(new Range(new Loc(startLoc), commentEnd - startLoc));
          const textBytes = contents.subarray(startLoc, commentEnd);
          if (isLegalComment || containsAtPreserveOrAtLicense(dec.decode(textBytes))) {
            const cm = new CSSComment();
            cm.loc = startLoc;
            cm.text = this.source.CommentTextWithoutIndent(new Range(new Loc(startLoc), commentEnd - startLoc));
            this.legalCommentsBefore.push(cm);
          }
          return;
        }
      } else if (this.codePoint === eof) {
        return; // unterminated: Go logs an error; byte state dump covers terminated cases
      } else {
        this.step();
      }
    }
  }

  /** Go: func (lexer *lexer) wouldStartIdentifier() bool (css_lexer.go:571) */
  wouldStartIdentifier(): boolean {
    if (IsNameStart(this.codePoint)) return true;
    if (this.codePoint === 0x2d /* - */) {
      let c: number, width: number;
      if (this.current >= this.contents.length) { c = RuneError; width = 0; }
      else { const d = decodeRune(this.contents, this.current); c = d.r; width = d.width; }
      if (c === RuneError && width <= 1) return false;
      if (IsNameStart(c) || c === 0x2d) return true;
      if (c === 0x5c) {
        let c2: number;
        if (this.current + width >= this.contents.length) c2 = RuneError;
        else c2 = decodeRune(this.contents, this.current + width).r;
        return !isNewline(c2);
      }
      return false;
    }
    return this.isValidEscape();
  }

  /** Go: func (lexer *lexer) consumeURL(matchingLoc logger.Loc) T (css_lexer.go:795) */
  consumeURL(): number {
    const TURL = 37, TBadURL = 3;
    let valid = true;
    for (;;) {
      if (valid) {
        switch (this.codePoint as number) {
          case 0x29: this.step(); return TURL;
          case eof: return TURL;
          case 0x20: case 0x09: case 0x0a: case 0x0d: case 0x0c:
            this.step();
            while (isWhitespace(this.codePoint)) this.step();
            if (this.codePoint !== 0x29) { if (this.codePoint === eof) return TURL; valid = false; }
            else { this.step(); return TURL; }
            break;
          case 0x22: case 0x27: case 0x28: valid = false; break;
          case 0x5c:
            if (!this.isValidEscape()) valid = false;
            else this.consumeEscape();
            break;
          default:
            if (isNonPrintable(this.codePoint)) valid = false;
            else this.step();
            break;
        }
      } else {
        if (this.codePoint === 0x29 || this.codePoint === eof) { this.step(); return TBadURL; }
        this.step();
      }
    }
  }

  /** Go: func (lexer *lexer) consumeName() string (css_lexer.go:690) */
  consumeName(): string {
    const contents = this.contents;
    if (IsNameContinue(this.codePoint)) {
      const n = contents.length;
      let i = this.current;
      while (i < n && IsNameContinue(contents[i])) i++;
      this.current = i;
      this.step();
    }
    const raw = contents.subarray(this.tokenRangeLoc, this.tokenRangeLoc + this.tokenRangeLen);
    if (!this.isValidEscape()) return new TextDecoder().decode(raw);
    let sb = new TextDecoder().decode(raw);
    sb += globalThis.String.fromCodePoint(this.consumeEscape());
    for (;;) {
      if (IsNameContinue(this.codePoint)) { sb += globalThis.String.fromCodePoint(this.codePoint); this.step(); }
      else if (this.isValidEscape()) sb += globalThis.String.fromCodePoint(this.consumeEscape());
      else break;
    }
    return sb;
  }

  /** Go: func (lexer *lexer) consumeNumeric() T (css_lexer.go:900) */
  consumeNumeric(): number {
    if (this.codePoint === 0x2b || this.codePoint === 0x2d) this.step();
    while (this.codePoint >= 0x30 && this.codePoint <= 0x39) this.step();
    if (this.codePoint === 0x2e) { this.step(); while (this.codePoint >= 0x30 && this.codePoint <= 0x39) this.step(); }
    if (this.codePoint === 0x65 || this.codePoint === 0x45) {
      if (this.current < this.contents.length) {
        let c = this.contents[this.current];
        if ((c === 0x2b || c === 0x2d) && this.current + 1 < this.contents.length) c = this.contents[this.current + 1];
        if (c >= 0x30 && c <= 0x39) {
          this.step();
          if ((this.codePoint as number) === 0x2b || (this.codePoint as number) === 0x2d) this.step();
          while (this.codePoint >= 0x30 && this.codePoint <= 0x39) this.step();
        }
      }
    }
    if (this.wouldStartIdentifier()) { this.tokenUnitOffset = this.tokenRangeLen; this.consumeName(); return T.TDimension; }
    if (this.codePoint === 0x25) { this.step(); return T.TPercentage; }
    return T.TNumber;
  }

  /** Go: func (lexer *lexer) consumeIdentLike() T (css_lexer.go:759) */
  consumeIdentLike(): number {
    const name = this.consumeName();
    if (this.codePoint === 0x28) {
      const matchingLoc = this.tokenRangeLoc + this.tokenRangeLen;
      this.step();
      if (name.length === 3) {
        const u = name.charCodeAt(0), r = name.charCodeAt(1), l = name.charCodeAt(2);
        if ((u === 0x75 || u === 0x55) && (r === 0x72 || r === 0x52) && (l === 0x6c || l === 0x4c)) {
          const savedNl = this.approximateNewlineCount, savedCp = this.codePoint, savedLen = this.tokenRangeLen, savedCur = this.current;
          while (isWhitespace(this.codePoint)) this.step();
          if ((this.codePoint as number) !== 0x22 && (this.codePoint as number) !== 0x27) return this.consumeURL();
          this.approximateNewlineCount = savedNl; this.codePoint = savedCp; this.tokenRangeLen = savedLen; this.current = savedCur;
        }
      }
      return T.TFunction;
    }
    return T.TIdent;
  }

  /** Go: func (lexer *lexer) next() (css_lexer.go:279) */
  next(): void {
    for (;;) {
      this.tokenRangeLoc = this.tokenRangeLoc + this.tokenRangeLen;
      this.tokenRangeLen = 0; this.tokenKind = 0; this.tokenFlags = 0; this.tokenUnitOffset = 0;
      const cp = this.codePoint;
      switch (cp) {
        case eof: this.tokenKind = T.TEndOfFile; break;
        case 0x2f: // '/'
          this.step();
          if (this.codePoint === 0x2a) { this.step(); this.consumeToEndOfMultiLineComment(this.tokenRangeLoc); continue; }
          else if (this.codePoint === 0x2f) {
            if (this.tokenRangeLoc >= this.oldSingleLineCommentEnd) {
              let end = this.current;
              while (end < this.contents.length && !isNewline(this.contents[end])) end++;
              this.oldSingleLineCommentEnd = end;
              this.tokenFlags |= DidWarnAboutSingleLineComment;
            }
          }
          this.tokenKind = 24 /* TDelimSlash */; break;
        case 0x20: case 0x09: case 0x0a: case 0x0d: case 0x0c:
          this.step();
          for (;;) {
            if (isWhitespace(this.codePoint)) this.step();
            else if (this.codePoint === 0x2f && this.current < this.contents.length && this.contents[this.current] === 0x2a) {
              this.step(); this.step(); this.consumeToEndOfMultiLineComment(this.tokenRangeLoc);
            } else break;
          }
          this.tokenKind = T.TWhitespace; break;
        case 0x22: case 0x27: this.tokenKind = this.consumeString(); break;
        case 0x23: // '#'
          this.step();
          if (IsNameContinue(this.codePoint) || this.isValidEscape()) {
            this.tokenKind = T.THash;
            if (this.wouldStartIdentifier()) this.tokenFlags |= IsID;
            this.consumeName();
          } else this.tokenKind = T.TDelim;
          break;
        case 0x28: this.step(); this.tokenKind = T.TOpenParen; break;
        case 0x29: this.step(); this.tokenKind = T.TCloseParen; break;
        case 0x5b: this.step(); this.tokenKind = T.TOpenBracket; break;
        case 0x5d: this.step(); this.tokenKind = T.TCloseBracket; break;
        case 0x7b: this.step(); this.tokenKind = T.TOpenBrace; break;
        case 0x7d: this.step(); this.tokenKind = T.TCloseBrace; break;
        case 0x2c: this.step(); this.tokenKind = T.TComma; break;
        case 0x3a: this.step(); this.tokenKind = T.TColon; break;
        case 0x3b: this.step(); this.tokenKind = T.TSemicolon; break;
        case 0x2b: case 0x2e:
          if (this.wouldStartNumber()) this.tokenKind = this.consumeNumeric();
          else { this.step(); this.tokenKind = cp === 0x2b ? 23 /* TDelimPlus */ : 17 /* TDelimDot */; }
          break;
        case 0x2d:
          if (this.wouldStartNumber()) this.tokenKind = this.consumeNumeric();
          else if (this.current + 2 <= this.contents.length && this.contents[this.current] === 0x2d && this.contents[this.current + 1] === 0x3e) { this.step(); this.step(); this.step(); this.tokenKind = T.TCDC; }
          else if (this.wouldStartIdentifier()) this.tokenKind = this.consumeIdentLike();
          else { this.step(); this.tokenKind = 22 /* TDelimMinus */; }
          break;
        case 0x3c:
          if (this.current + 3 <= this.contents.length && this.contents[this.current] === 0x21 && this.contents[this.current+1] === 0x2d && this.contents[this.current+2] === 0x2d) { this.step(); this.step(); this.step(); this.step(); this.tokenKind = T.TCDO; }
          else { this.step(); this.tokenKind = T.TDelimLessThan; }
          break;
        case 0x40:
          this.step();
          if (this.wouldStartIdentifier()) { this.consumeName(); this.tokenKind = T.TAtKeyword; }
          else this.tokenKind = T.TDelim;
          break;
        case 0x5c:
          if (this.isValidEscape()) this.tokenKind = this.consumeIdentLike();
          else { this.step(); this.tokenKind = T.TDelim; }
          break;
        case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: case 0x35: case 0x36: case 0x37: case 0x38: case 0x39:
          this.tokenKind = this.consumeNumeric(); break;
        case 0x3e: this.step(); this.tokenKind = T.TDelimGreaterThan; break;
        case 0x7e: this.step(); this.tokenKind = 25 /* TDelimTilde */; break;
        case 0x26: this.step(); this.tokenKind = 12 /* TDelimAmpersand */; break;
        case 0x2a: this.step(); this.tokenKind = 13 /* TDelimAsterisk */; break;
        case 0x7c: this.step(); this.tokenKind = 14 /* TDelimBar */; break;
        case 0x21: this.step(); this.tokenKind = 19 /* TDelimExclamation */; break;
        case 0x3d: this.step(); this.tokenKind = T.TDelimEquals; break;
        case 0x5e: this.step(); this.tokenKind = 15 /* TDelimCaret */; break;
        case 0x24: this.step(); this.tokenKind = 16 /* TDelimDollar */; break;
        default:
          if (IsNameStart(this.codePoint)) this.tokenKind = this.consumeIdentLike();
          else { this.step(); this.tokenKind = T.TDelim; }
          break;
      }
      return;
    }
  }

  /** Go: func (lexer *lexer) consumeString() T (css_lexer.go:866) */
  consumeString(): number {
    const quote = this.codePoint;
    this.step();
    for (;;) {
      switch (this.codePoint) {
        case 0x5c: // '\\'
          this.step();
          if ((this.codePoint as number) === 0x0d) { this.step(); if ((this.codePoint as number) === 0x0a) this.step(); continue; }
          break;
        case eof: case 0x0a: case 0x0d: case 0x0c:
          return 2; // TUnterminatedString
        case quote:
          this.step();
          return 36; // TString
      }
      this.step();
    }
  }
}

/** Go: func Tokenize(log, source, options) TokenizeResult (css_lexer.go:207) */
export function Tokenize(source: Source, options: { recordAllComments?: boolean } = {}): {
  tokens: Token[]; allComments: Range[]; legalComments: CSSComment[];
  approximateLineCount: number; sourceMapComment: Span;
} {
  const l = new Lexer();
  l.recordAllComments = !!options.recordAllComments;
  l.contents = source.Contents;
  l.source = source;
  l.step();
  if (l.codePoint === 0xFEFF) l.step();
  l.next();
  const tokens: Token[] = [];
  const legalComments: CSSComment[] = [];
  const attach = () => {
    for (const cm of l.legalCommentsBefore) { cm.tokenIndexAfter = tokens.length; legalComments.push(cm); }
    l.legalCommentsBefore = [];
  };
  while (l.tokenKind !== T.TEndOfFile) {
    attach();
    const tk = new Token();
    tk.rangeLoc = l.tokenRangeLoc; tk.rangeLen = l.tokenRangeLen;
    tk.kind = l.tokenKind; tk.flags = l.tokenFlags; tk.unitOffset = l.tokenUnitOffset;
    tokens.push(tk);
    l.next();
  }
  attach();
  const span = new Span();
  span.Text = l.sourceMappingURLText;
  span.Range = new Range(new Loc(l.sourceMappingURLLoc), l.sourceMappingURLLen);
  return {
    tokens,
    allComments: l.allComments,
    legalComments,
    approximateLineCount: l.approximateNewlineCount + 1,
    sourceMapComment: span,
  };
}
