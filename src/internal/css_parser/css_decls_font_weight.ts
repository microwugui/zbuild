// 1:1 移植自 esbuild internal/css_parser/css_decls_font_weight.go（v0.28.2，commit f6058f83）
// 第 70 轮叶子优先规划：font-weight 压缩助手。真值表由 Go 探针固化在 testdata/css-mangle-go.json。
import { T, Token } from "../css_ast/css_ast.ts";

/** Go: func (p *parser) mangleFontWeight(token css_ast.Token) css_ast.Token (css_decls_font_weight.go:10) */
export function mangleFontWeight(token: Token): Token {
  if (token.Kind !== T.TIdent) return token;
  switch (token.Text.toLowerCase()) {
    case "normal": token.Text = "400"; token.Kind = T.TNumber; break;
    case "bold": token.Text = "700"; token.Kind = T.TNumber; break;
  }
  return token;
}
