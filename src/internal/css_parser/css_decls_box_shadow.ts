// 1:1 移植自 esbuild internal/css_parser/css_decls_box_shadow.go（v0.28.2）。第 135 批。
import { Token, T } from "../css_ast/css_ast.ts";
import { CSSParser } from "./css_parser.ts";
import { looksLikeColor, lowerAndMinifyColor } from "./css_decls_color.ts";

/** Go: func (p *parser) lowerAndMangleBoxShadow(tokens []css_ast.Token, wouldClipColor *bool) []css_ast.Token (css_decls_box_shadow.go:10) */
export function lowerAndMangleBoxShadow(p: CSSParser, tokens: Token[], wouldClipColor: { value: boolean } | null): Token[] {
  let insetCount=0, colorCount=0, numbersBegin=0, numbersCount=0, numbersDone=false, foundUnexpectedToken=false;
  for (let i=0;i<tokens.length;i++) {
    const t=tokens[i];
    if (t.Kind===T.TNumber||t.Kind===T.TDimension) {
      if (numbersDone) foundUnexpectedToken=true;
      if (p.options.minifySyntax && t.TurnLengthIntoNumberIfZero()) tokens[i]=t;
      if (numbersCount===0) numbersBegin=i;
      numbersCount++;
    } else {
      if (numbersCount!==0) numbersDone=true;
      if (looksLikeColor(t)) { colorCount++; tokens[i]=lowerAndMinifyColor(p,t,wouldClipColor); }
      else if (t.Kind===T.TIdent && t.Text.toLowerCase()==="inset") insetCount++;
      else foundUnexpectedToken=true;
    }
  }
  if (p.options.minifySyntax && insetCount<=1 && colorCount<=1 && numbersCount>2 && numbersCount<=4 && !foundUnexpectedToken) {
    const numbersEnd=numbersBegin+numbersCount;
    while (numbersCount>2 && tokens[numbersBegin+numbersCount-1].IsZero()) numbersCount--;
    tokens = tokens.slice(0,numbersBegin+numbersCount).concat(tokens.slice(numbersEnd));
  }
  for (let i=0;i<tokens.length;i++) {
    let ws=0;
    if (i>0||!p.options.minifyWhitespace) ws|=1;
    if (i+1<tokens.length) ws|=2;
    tokens[i].Whitespace=ws;
  }
  return tokens;
}

/** Go: func (p *parser) lowerAndMangleBoxShadows(tokens []css_ast.Token, wouldClipColor *bool) []css_ast.Token (css_decls_box_shadow.go:81) */
export function lowerAndMangleBoxShadows(p: CSSParser, tokens: Token[], wouldClipColor: { value: boolean } | null): Token[] {
  const n=tokens.length; let end=0, i=0;
  while (i<n) {
    let comma=i;
    while (comma<n && tokens[comma].Kind!==T.TComma) comma++;
    const part=lowerAndMangleBoxShadow(p, tokens.slice(i,comma), wouldClipColor);
    for (const t of part) { tokens[end]=t; end++; }
    if (comma<n) { tokens[end]=tokens[comma]; end++; comma++; }
    i=comma;
  }
  return tokens.slice(0,end);
}
