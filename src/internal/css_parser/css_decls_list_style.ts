// 1:1 移植自 esbuild internal/css_parser/css_decls_list_style.go（v0.28.2）。第 131 批 Go 探针。
import { CSSParser } from "./css_parser.ts";
import { Token as ASTToken } from "../css_ast/css_ast.ts";
import { cssWideAndReservedKeywords } from "./css_decls_animation.ts";
import { predefinedCounterStyles } from "./predefined_counter_styles_generated.ts";

/** Go: func (p *parser) processListStyleType(t *css_ast.Token) (css_decls_list_style.go:99) */
export function processListStyleType(p: CSSParser, t: ASTToken): void {
  if (t.Kind === 29 /* TIdent */) {
    const lower = t.Text.toLowerCase();
    if (lower !== "none" && !cssWideAndReservedKeywords.get(lower) && !predefinedCounterStyles.has(lower)) {
      t.Kind = 39 /* TSymbol */;
      t.PayloadIndex = p.symbolForName(t.Loc, t.Text).Ref.InnerIndex;
    }
  }
}

/** Go: func (p *parser) processListStyleShorthand(tokens []css_ast.Token) (css_decls_list_style.go:20) */
export function processListStyleShorthand(p: CSSParser, tokens: ASTToken[]): void {
  if (tokens.length < 1 || tokens.length > 3) return;
  let foundImage = false, foundPosition = false, typeIndex = -1, noneCount = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t.Kind) {
      case 36 /* TString */: return;
      case 37 /* TURL */:
        if (!foundImage) { foundImage = true; continue; }
        break;
      case 27 /* TFunction */:
        if (!foundImage) {
          if (["src", "linear-gradient", "repeating-linear-gradient", "radial-gradient", "radial-linear-gradient"].includes(t.Text.toLowerCase())) {
            foundImage = true; continue;
          }
        }
        break;
      case 29 /* TIdent */: {
        const lower = t.Text.toLowerCase();
        if (lower === "none") { noneCount++; continue; }
        if (!foundPosition && (lower === "inside" || lower === "outside")) { foundPosition = true; continue; }
        if (typeIndex === -1) {
          if (cssWideAndReservedKeywords.get(lower) || predefinedCounterStyles.has(lower)) return;
          typeIndex = i; continue;
        }
        break;
      }
    }
    return;
  }
  if (typeIndex !== -1) {
    if (!foundImage && noneCount > 0) noneCount--;
    if (noneCount > 0) return;
    const t = tokens[typeIndex];
    if (t.Kind === 29) {
      t.Kind = 39 /* TSymbol */;
      t.PayloadIndex = p.symbolForName(t.Loc, t.Text).Ref.InnerIndex;
    }
  }
}
