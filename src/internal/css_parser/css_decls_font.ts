// 1:1 移植自 esbuild internal/css_parser/css_decls_font.go（v0.28.2，commit f6058f83）
// 第 50 轮叶子优先规划：font-size 关键字判定。真值表由 Go 探针固化在 testdata/css-parser-pure2-go.json。
import { T, Token } from "../css_ast/css_ast.ts";

/** Go: var fontSizeKeywords = map[string]bool (css_decls_font.go:108) */
const fontSizeKeywords = new Set<string>([
  "xx-small", "x-small", "small", "medium", "large", "x-large", "xx-large", "xxx-large",
  "larger", "smaller",
]);

/** Go: func isFontSize(token css_ast.Token) bool (css_decls_font.go:125) */
export function isFontSize(token: Token): boolean {
  if (token.Kind === T.TDimension || token.Kind === T.TPercentage) return true;
  if (token.Kind === T.TIdent) return fontSizeKeywords.has(token.Text.toLowerCase());
  return false;
}

// 第 135 批：mangleFont（Go 探针 main-chain-go.json）
import { mangleFontWeight } from "./css_decls_font_weight.ts";
import { mangleFontFamily } from "./css_decls_font_family.ts";
import { CSSParser } from "./css_parser.ts";

/** Go: func (p *parser) mangleFont(tokens []css_ast.Token) []css_ast.Token (css_decls_font.go:13) */
export function mangleFont(p: CSSParser, tokens: Token[]): Token[] {
  const result: Token[] = [];
  let pos = 0;
  for (; pos < tokens.length; pos++) {
    const token = tokens[pos];
    if (isFontSize(token)) break;
    switch (token.Kind) {
      case T.TIdent: {
        const lower = token.Text.toLowerCase();
        if (lower === "normal") continue;
        if (lower === "italic") { result.push(token); break; }
        if (lower === "oblique") {
          if (pos + 1 < tokens.length && tokens[pos + 1].IsAngle()) { result.push(token, tokens[pos + 1]); pos++; continue; }
          result.push(token); break;
        }
        if (["small-caps", "bold", "bolder", "lighter", "ultra-condensed", "extra-condensed", "condensed", "semi-condensed", "semi-expanded", "expanded", "extra-expanded", "ultra-expanded"].includes(lower)) {
          if (["bold", "bolder", "lighter"].includes(lower)) { result.push(mangleFontWeight(token)); continue; }
          result.push(token); break;
        }
        return tokens;
      }
      case T.TNumber: {
        const v = Number(token.Text);
        if (!Number.isFinite(v) || v < 1 || v > 1000) return tokens;
        result.push(token); break;
      }
      default: return tokens;
    }
  }
  if (pos === tokens.length) return tokens;
  result.push(tokens[pos]); pos++;
  if (pos < tokens.length && tokens[pos].Kind === T.TDelimSlash) {
    if (pos + 1 === tokens.length) return tokens;
    result.push(tokens[pos], tokens[pos + 1]); pos += 2;
    if (p.options.minifyWhitespace) {
      result[result.length - 3].Whitespace &= ~2;
      result[result.length - 2].Whitespace = 0;
      result[result.length - 1].Whitespace &= ~1;
    }
  }
  const [family, ok] = mangleFontFamily(tokens.slice(pos), p.options.minifyWhitespace);
  if (ok && family !== null) {
    if (result.length > 0 && family.length > 0 && family[0].Kind !== T.TString) family[0].Whitespace |= 1;
    return result.concat(family);
  }
  return tokens;
}
