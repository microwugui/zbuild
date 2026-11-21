// 1:1 移植自 esbuild internal/css_parser/css_decls_animation.go（v0.28.2，commit f6058f83）
// 第 44 轮叶子优先规划：动画名判定。真值表由 Go 探针固化在 testdata/css-animation-go.json。

/** Go: cssWideAndReservedKeywords (css_decls_font_family.go:24) —— CSS 共享底座 */
export const cssWideAndReservedKeywords: Map<string, boolean> = new Map([
  ["initial", true], ["inherit", true], ["unset", true], ["default", true],
  ["revert", true], ["revert-layer", true],
]);

/** Go: func isInvalidAnimationName(text string) bool (css_decls_animation.go:116) */
export function isInvalidAnimationName(text: string): boolean {
  const lower = text.toLowerCase();
  return lower === "none" || (cssWideAndReservedKeywords.get(lower) ?? false);
}

// ============================================================================
// 第 131 批：animation 名处理 3 函数（Go 探针 28 例，decl-helpers-go.json）。
// ============================================================================
import { CSSParser } from "./css_parser.ts";
import { Token as ASTToken } from "../css_ast/css_ast.ts";

/** Go: func (p *parser) handleSingleAnimationName(token *css_ast.Token) (css_decls_animation.go:97) */
export function handleSingleAnimationName(p: CSSParser, token: ASTToken): void {
  if ((token.Kind === 29 /* TIdent */ || (token.Kind === 36 /* TString */ && !p.makeLocalSymbols)) && isInvalidAnimationName(token.Text)) return;
  token.Kind = 39 /* TSymbol */;
  token.PayloadIndex = p.symbolForName(token.Loc, token.Text).Ref.InnerIndex;
}

/** Go: func (p *parser) processAnimationName(tokens []css_ast.Token) (css_decls_animation.go:89) */
export function processAnimationName(p: CSSParser, tokens: ASTToken[]): void {
  for (const t of tokens) if (t.Kind === 29 || t.Kind === 36) handleSingleAnimationName(p, t);
}

/** Go: func (p *parser) processAnimationShorthand(tokens []css_ast.Token) (css_decls_animation.go:11) */
export function processAnimationShorthand(p: CSSParser, tokens: ASTToken[]): void {
  const found = { timingFunction: false, iterationCount: false, direction: false, fillMode: false, playState: false, name: false };
  const lower = (s: string): string => s.toLowerCase();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t.Kind) {
      case 10 /* TComma */:
        found.timingFunction = found.iterationCount = found.direction = found.fillMode = found.playState = found.name = false;
        break;
      case 30 /* TNumber */:
        if (!found.iterationCount) { found.iterationCount = true; continue; }
        break;
      case 29 /* TIdent */: {
        if (!found.timingFunction) {
          if (["linear", "ease", "ease-in", "ease-out", "ease-in-out", "step-start", "step-end"].includes(lower(t.Text))) {
            found.timingFunction = true; continue;
          }
        }
        if (!found.iterationCount && lower(t.Text) === "infinite") { found.iterationCount = true; continue; }
        if (!found.direction) {
          if (["normal", "reverse", "alternate", "alternate-reverse"].includes(lower(t.Text))) { found.direction = true; continue; }
        }
        if (!found.fillMode) {
          if (["none", "forwards", "backwards", "both"].includes(lower(t.Text))) { found.fillMode = true; continue; }
        }
        if (!found.playState) {
          if (["running", "paused"].includes(lower(t.Text))) { found.playState = true; continue; }
        }
        if (!found.name) { handleSingleAnimationName(p, t); found.name = true; continue; }
        break;
      }
      case 36 /* TString */:
        if (!found.name) { handleSingleAnimationName(p, t); found.name = true; continue; }
        break;
    }
  }
}
