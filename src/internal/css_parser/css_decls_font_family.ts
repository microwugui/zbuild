// 1:1 移植自 esbuild internal/css_parser/css_decls_font_family.go（v0.28.2，commit f6058f83）
// 第 105 批：font-family mangle 链，Go 探针固化 13 例于 testdata/css-font-go.json。
import { Token, T } from "../css_ast/css_ast.ts";
import { WouldStartIdentifierWithoutEscapes } from "../css_lexer/css_lexer.ts";
import { IsNameContinue } from "../css_lexer/css_lexer.ts";

const cssWideAndReservedKeywords: Record<string, boolean> = {
  initial: true, inherit: true, unset: true, default: true, revert: true, "revert-layer": true,
};
const genericFamilyNames: Record<string, boolean> = {
  "serif": true, "sans-serif": true, "cursive": true, "fantasy": true, "monospace": true,
  "system-ui": true, "emoji": true, "math": true, "fangsong": true, "ui-serif": true,
  "ui-sans-serif": true, "ui-monospace": true, "ui-rounded": true,
};

/** Go: func isValidCustomIdent(text string, predefinedKeywords map[string]bool) bool (css_decls_font_family.go:138) */
export function isValidCustomIdent(text: string, predefinedKeywords: Record<string, boolean>): boolean {
  const lowered = text.toLowerCase();
  if (predefinedKeywords[lowered]) return false;
  if (cssWideAndReservedKeywords[lowered]) return false;
  if (lowered === "") return false;
  if (!WouldStartIdentifierWithoutEscapes(text)) return false;
  for (const c of text) if (!IsNameContinue(c.codePointAt(0)!)) return false;
  return true;
}

/** Go: func (p *parser) mangleFamilyNameOrGenericName(...) (css_decls_font_family.go:77) */
export function mangleFamilyNameOrGenericName(
  result: Token[], tokens: Token[], minifyWhitespace: boolean,
): [Token[], Token[], boolean] {
  if (tokens.length > 0) {
    const t = tokens[0];
    if (t.Kind === T.TIdent && genericFamilyNames[t.Text]) return [result.concat([t]), tokens.slice(1), true];
    if (t.Kind === T.TString) {
      const names = t.Text.split(" ");
      for (const name of names) if (!isValidCustomIdent(name, genericFamilyNames)) return [result.concat([t]), tokens.slice(1), true];
      for (let i = 0; i < names.length; i++) {
        const nt = new Token();
        nt.Loc = t.Loc; nt.Kind = T.TIdent; nt.Text = names[i];
        nt.Whitespace = (i !== 0 || !minifyWhitespace) ? 1 /* WhitespaceBefore */ : 0;
        result.push(nt);
      }
      return [result, tokens.slice(1), true];
    }
    if (t.Kind === T.TIdent) {
      let tt = t, rest = tokens;
      for (;;) {
        if (!isValidCustomIdent(tt.Text, genericFamilyNames)) return [[], [], false];
        result.push(tt);
        rest = rest.slice(1);
        if (rest.length === 0 || rest[0].Kind !== T.TIdent) break;
        tt = rest[0];
      }
      return [result, rest, true];
    }
  }
  return [[], [], false];
}

/** Go: func (p *parser) mangleFontFamily(tokens []css_ast.Token) ([]css_ast.Token, bool) (css_decls_font_family.go:57) */
export function mangleFontFamily(tokens: Token[], minifyWhitespace: boolean): [Token[] | null, boolean] {
  let [result, rest, ok] = mangleFamilyNameOrGenericName([], tokens, minifyWhitespace);
  if (!ok) return [null, false];
  while (rest.length > 0 && rest[0].Kind === T.TComma) {
    [result, rest, ok] = mangleFamilyNameOrGenericName(result.concat([rest[0]]), rest.slice(1), minifyWhitespace);
    if (!ok) return [null, false];
  }
  if (rest.length > 0) return [null, false];
  return [result, true];
}
