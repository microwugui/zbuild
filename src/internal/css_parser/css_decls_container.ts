// 1:1 移植自 esbuild internal/css_parser/css_decls_container.go（v0.28.2）。第 131 批 Go 探针。
import { CSSParser } from "./css_parser.ts";
import { Token as ASTToken } from "../css_ast/css_ast.ts";
import { cssWideAndReservedKeywords } from "./css_decls_animation.ts";

/** Go: func (p *parser) handleSingleContainerName(token *css_ast.Token) (css_decls_container.go:46) */
export function handleSingleContainerName(p: CSSParser, token: ASTToken): void {
  const lower = token.Text.toLowerCase();
  if (lower === "none" || cssWideAndReservedKeywords.get(lower)) return;
  token.Kind = 39 /* TSymbol */;
  token.PayloadIndex = p.symbolForName(token.Loc, token.Text).Ref.InnerIndex;
}

/** Go: func (p *parser) processContainerName(tokens []css_ast.Token) (css_decls_container.go:32) */
export function processContainerName(p: CSSParser, tokens: ASTToken[]): void {
  for (const t of tokens) if (t.Kind !== 29 /* TIdent */) return;
  for (const t of tokens) handleSingleContainerName(p, t);
}

/** Go: func (p *parser) processContainerShorthand(tokens []css_ast.Token) (css_decls_container.go:11) */
export function processContainerShorthand(p: CSSParser, tokens: ASTToken[]): void {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.Kind === 29) continue;
    if (t.Kind === 24 /* TDelimSlash */ && i + 2 === tokens.length && tokens[i + 1].Kind === 29) break;
    return;
  }
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].Kind !== 29) break;
    handleSingleContainerName(p, tokens[i]);
  }
}
