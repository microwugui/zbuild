// 1:1 移植自 esbuild internal/css_parser/css_decls.go（v0.28.2，commit f6058f83）
// 第 51 轮叶子优先规划：四方向 token 展开。真值表由 Go 探针固化在 testdata/css-media-token-go.json。
import { T, Token } from "../css_ast/css_ast.ts";
import { IsNumeric } from "../css_lexer/css_lexer.ts";

/** Go: func expandTokenQuad(tokens []css_ast.Token, allowedIdent string) (result [4]css_ast.Token, ok bool) (css_decls.go:24) */
export function expandTokenQuad(tokens: Token[], allowedIdent: string): { result: Token[]; ok: boolean } {
  const result: Token[] = [new Token(), new Token(), new Token(), new Token()];
  const n = tokens.length;
  if (n < 1 || n > 4) return { result, ok: false };

  // Don't do this if we encounter any unexpected tokens such as "var()"
  for (let i = 0; i < n; i++) {
    const t = tokens[i];
    if (!IsNumeric(t.Kind) && (t.Kind !== T.TIdent || allowedIdent === "" || t.Text !== allowedIdent)) {
      return { result, ok: false };
    }
  }

  result[0] = tokens[0];
  result[1] = n > 1 ? tokens[1] : result[0];
  result[2] = n > 2 ? tokens[2] : result[0];
  result[3] = n > 3 ? tokens[3] : result[1];
  return { result, ok: true };
}

// ============================================================================
// 第 108 批：compactTokenQuad / commaToken（Go 探针 7 例，逐字节等于 Go）。
// 真值表固化于 testdata/css-compact-go.json（d0388e83…）。
// ============================================================================

/** Token.EqualIgnoringWhitespace 的逐字段等价（token 无 children 时的简式） */
function tokEqIW(a: Token, b: Token): boolean {
  return a.Kind === b.Kind && a.Text === b.Text && a.PayloadIndex === b.PayloadIndex;
}

/** Go: func compactTokenQuad(a, b, c, d css_ast.Token, minifyWhitespace bool) []css_ast.Token (css_decls.go:58) */
export function compactTokenQuad(a: Token, b: Token, c: Token, d: Token, minifyWhitespace: boolean): Token[] {
  let tokens: Token[] = [a, b, c, d];
  if (tokEqIW(tokens[3], tokens[1])) {
    if (tokEqIW(tokens[2], tokens[0])) {
      if (tokEqIW(tokens[1], tokens[0])) tokens = tokens.slice(0, 1);
      else tokens = tokens.slice(0, 2);
    } else {
      tokens = tokens.slice(0, 3);
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    let whitespace = 0;
    if (!minifyWhitespace || i > 0) whitespace |= 1; // WhitespaceBefore
    if (i + 1 < tokens.length) whitespace |= 2; // WhitespaceAfter
    tokens[i].Whitespace = whitespace;
  }
  return tokens;
}

/** Go: func (p *parser) commaToken(loc logger.Loc) css_ast.Token (css_decls.go:12) */
export function commaToken(loc: number, minifyWhitespace: boolean): Token {
  const t = new Token();
  t.Loc = loc; t.Kind = 10 /* TComma */; t.Text = ",";
  if (!minifyWhitespace) t.Whitespace = 2 /* WhitespaceAfter */;
  return t;
}

// ============================================================================
// 第 132 批：insertPrefixedDeclaration / lowerInset（Go 探针 17 例，decl-ins-go.json）。
// ============================================================================
import { RDeclaration, Rule, Token as ASTToken, TokensEqual } from "../css_ast/css_ast.ts";
import { knownDeclarations } from "./known_declarations_generated.ts";
const D = (name: string): number => knownDeclarations.get(name) ?? 0;

/** Go: func (p *parser) insertPrefixedDeclaration(rules []css_ast.Rule, prefix string, loc logger.Loc, decl *css_ast.RDeclaration, declarationKeys map[string]struct{}) []css_ast.Rule (css_decls.go:424) */
export function insertPrefixedDeclaration(
  rules: Rule[], prefix: string, loc: number, decl: RDeclaration, declarationKeys: Set<string>,
): Rule[] {
  let keyText = prefix + decl.KeyText;
  if (declarationKeys.has(keyText)) return rules;
  const single = (text: string): boolean => decl.Value.length === 1 && decl.Value[0].Kind === 29 /* TIdent */ && decl.Value[0].Text.toLowerCase() === text;
  if (decl.Key === D("background-clip")) { if (!single("text")) return rules; }
  else if (decl.Key === D("position")) { if (!single("sticky")) return rules; }
  else if ([D("width"), D("min-width"), D("max-width"), D("height"), D("min-height"), D("max-height")].includes(decl.Key)) {
    if (!single("stretch")) return rules;
  }
  const value = decl.Value.map((t) => {
    const c = new ASTToken();
    c.Kind = t.Kind; c.Text = t.Text; c.Loc = t.Loc; c.UnitOffset = t.UnitOffset;
    c.Whitespace = t.Whitespace; c.PayloadIndex = t.PayloadIndex; c.Children = t.Children;
    return c;
  });
  if (decl.Key === D("position")) { keyText = decl.KeyText; value[0].Text = "-webkit-sticky"; }
  else if ([D("width"), D("min-width"), D("max-width"), D("height"), D("min-height"), D("max-height")].includes(decl.Key)) {
    keyText = decl.KeyText;
    if (prefix === "-webkit-") value[0].Text = "-webkit-fill-available";
    else if (prefix === "-moz-") value[0].Text = "-moz-available";
  } else if (decl.Key === D("user-select")) {
    if (prefix === "-moz-" && value.length === 1 && value[0].Kind === 29 && value[0].Text.toLowerCase() === "none") value[0].Text = "-moz-none";
  } else if (decl.Key === D("mask-composite") && prefix === "-webkit-") {
    const map: Record<string, string> = { add: "source-over", subtract: "source-out", intersect: "source-in", exclude: "xor" };
    for (const t of value) if (t.Kind === 29 && map[t.Text] !== undefined) t.Text = map[t.Text];
  }
  if (keyText === decl.KeyText) {
    for (const rule of rules) {
      const prev = rule.Data;
      if (prev instanceof RDeclaration && prev.KeyText === keyText && TokensEqual(prev.Value, value, null)) return rules;
    }
  }
  const inserted = new Rule(); inserted.Loc = loc;
  const d = new RDeclaration(); d.KeyText = keyText; d.KeyRange = decl.KeyRange;
  d.Value = value; d.Important = decl.Important; inserted.Data = d;
  const out = rules.slice(); out[out.length - 1] = inserted;
  out.push(new Rule()); out[out.length - 1].Loc = loc; out[out.length - 1].Data = decl;
  return out;
}

/** Go: func (p *parser) lowerInset(loc logger.Loc, decl *css_ast.RDeclaration) ([]css_ast.Rule, bool) (css_decls.go:526) */
export function lowerInset(loc: number, decl: RDeclaration, minifyWhitespace: boolean): { rules: Rule[]; ok: boolean } {
  const { result: tokens, ok } = expandTokenQuad(decl.Value, "");
  if (!ok) return { rules: [], ok: false };
  const mask = minifyWhitespace ? 0 : ~2 /* WhitespaceAfter */;
  const out: Rule[] = [];
  const keys = [D("top"), D("right"), D("bottom"), D("left")];
  const names = ["top", "right", "bottom", "left"];
  for (let i = 0; i < 4; i++) {
    tokens[i].Whitespace &= mask;
    const r = new Rule(); r.Loc = loc;
    const d = new RDeclaration(); d.KeyText = names[i]; d.Key = keys[i];
    d.KeyRange = decl.KeyRange; d.Value = [tokens[i]]; d.Important = decl.Important;
    r.Data = d; out.push(r);
  }
  return { rules: out, ok: true };
}

// ============================================================================
// 第 135 批：processDeclarations（Go 探针 main-chain-go.json，css_decls.go:84）
// ============================================================================
import { AddID, AddIDWithNotes, MsgData } from "../logger/logger.ts";
import { MsgID_CSS_CSSSyntaxError } from "../logger/msg_ids.ts";
import { CloneTokensWithoutImportRecords } from "../css_ast/css_ast.ts";
import { boxTracker } from "./css_decls_box.ts";
import { borderRadiusTracker } from "./css_decls_border_radius.ts";
import { lowerAndMinifyColor } from "./css_decls_color.ts";
import { lowerAndMinifyGradient } from "./css_decls_gradient.ts";
import { lowerAndMangleBoxShadows } from "./css_decls_box_shadow.ts";
import { handleComposesPragma } from "./css_decls_composes.ts";
import type { composesContext } from "./css_decls_composes.ts";
import { mangleFont } from "./css_decls_font.ts";
import { mangleTransforms } from "./css_decls_transform.ts";
import { CSSParser } from "./css_parser.ts";
import { processContainerName, processContainerShorthand } from "./css_decls_container.ts";
import { processAnimationName, processAnimationShorthand } from "./css_decls_animation.ts";
import { processListStyleShorthand, processListStyleType } from "./css_decls_list_style.ts";
import { mangleFontWeight } from "./css_decls_font_weight.ts";
import { mangleFontFamily } from "./css_decls_font_family.ts";

/** Go: func (p *parser) processDeclarations(rules []css_ast.Rule, composesContext *composesContext) []css_ast.Rule (css_decls.go:84) */
export function processDeclarations(p: CSSParser, rules: Rule[], composesContext: composesContext | null): Rule[] {
  const margin = new boxTracker(); margin.key=D("margin"); margin.keyText="margin"; margin.allowAuto=true;
  const padding = new boxTracker(); padding.key=D("padding"); padding.keyText="padding"; padding.allowAuto=false;
  const inset = new boxTracker(); inset.key=D("inset"); inset.keyText="inset"; inset.allowAuto=true;
  const radius = new borderRadiusTracker();
  const rewritten: Rule[] = [];
  let didWarnAboutComposes = false, wouldClipColorFlag = false;
  let declarationKeys: Set<string> | null = null;
  const minify=!!p.options.minifySyntax;
  if ((Number(p.options.unsupportedCSSFeatures ?? 0) & 256) !== 0) { inset.key = 0; inset.keyText = ""; }
  if (composesContext !== null) {
    for (const ref of composesContext.parentRefs) {
      let composes = p.composes.get(ref);
      if (composes === undefined) { composes = { Names: [], ImportedNames: [], Properties: null }; p.composes.set(ref, composes); }
      if (composes.Properties === null) composes.Properties = new Map();
      for (const rule of rules) {
        const d = rule.Data;
        if (d instanceof RDeclaration && d.Key !== D("composes")) composes.Properties.set(d.KeyText, d.KeyRange.Loc.Start);
      }
    }
  }
  for (let i=0;i<rules.length;i++) {
    let rule = rules[i];
    rewritten.push(rule);
    if (!(rule.Data instanceof RDeclaration)) continue;
    let decl: RDeclaration = rule.Data;
    let wouldClipColor: { value: boolean } | null = null;
    if (wouldClipColorFlag) {
      wouldClipColorFlag=false;
      const clone = new RDeclaration();
      clone.Key=decl.Key; clone.KeyText=decl.KeyText; clone.KeyRange=decl.KeyRange;
      clone.Value=CloneTokensWithoutImportRecords(decl.Value); clone.Important=decl.Important;
      decl=clone; rule.Data=decl;
      const n=rewritten.length-2;
      rewritten.splice(n,0,rule);
    } else wouldClipColor={ value:false };
    const k=decl.Key;
    if (k===D("composes")) {
      if (p.symbolMode!==0) {
        if (composesContext===null) {
          if (!didWarnAboutComposes) { didWarnAboutComposes=true; AddID(p.log, MsgID_CSS_CSSSyntaxError, 1, p.tracker, decl.KeyRange, '"composes" is not valid here'); }
        } else if (composesContext.problemRange.Len>0) {
          if (!didWarnAboutComposes) {
            didWarnAboutComposes=true;
            const note=new MsgData(); note.Text="The parent selector is not a single class selector because of the syntax here:";
            AddIDWithNotes(p.log, MsgID_CSS_CSSSyntaxError, 1, p.tracker, decl.KeyRange, '"composes" only works inside single class selectors', [note]);
          }
        } else handleComposesPragma(p, composesContext, decl.Value);
        rewritten.pop();
      }
    } else if (k===D("background")) {
      for (let j=0;j<decl.Value.length;j++) decl.Value[j]=lowerAndMinifyGradient(p, lowerAndMinifyColor(p,decl.Value[j],wouldClipColor), wouldClipColor);
    } else if ([D("background-image"),D("border-image"),D("mask-image")].includes(k)) {
      for (let j=0;j<decl.Value.length;j++) decl.Value[j]=lowerAndMinifyGradient(p,decl.Value[j],wouldClipColor);
    } else if ([D("background-color"),D("border-block-end-color"),D("border-block-start-color"),D("border-bottom-color"),D("border-color"),
      D("border-inline-end-color"),D("border-inline-start-color"),D("border-left-color"),D("border-right-color"),D("border-top-color"),
      D("caret-color"),D("color"),D("column-rule-color"),D("fill"),D("flood-color"),D("lighting-color"),D("outline-color"),
      D("stop-color"),D("stroke"),D("text-decoration-color"),D("text-emphasis-color")].includes(k)) {
      if (decl.Value.length===1) decl.Value[0]=lowerAndMinifyColor(p,decl.Value[0],wouldClipColor);
    } else if (k===D("transform")) { if (minify) decl.Value=mangleTransforms(decl.Value); }
    else if (k===D("box-shadow")) decl.Value=lowerAndMangleBoxShadows(p,decl.Value,wouldClipColor);
    else if (k===D("container")) handleContainer(p,decl.Value,false);
    else if (k===D("container-name")) handleContainer(p,decl.Value,true);
    else if (k===D("animation")) handleAnimation(p,decl.Value,false);
    else if (k===D("animation-name")) handleAnimation(p,decl.Value,true);
    else if (k===D("list-style")) handleListStyle(p,decl.Value);
    else if (k===D("list-style-type") && decl.Value.length===1) handleListStyleType(p,decl.Value[0]);
    else if (k===D("font") && minify) decl.Value=mangleFont(p,decl.Value);
    else if (k===D("font-family") && minify) { const [v,ok]=mangleFontFamily(decl.Value,p.options.minifyWhitespace); if (ok&&v) decl.Value=v; }
    else if (k===D("font-weight") && decl.Value.length===1 && minify) decl.Value[0]=mangleFontWeight(decl.Value[0]);
    else if (k===D("margin") && minify) margin.mangleSides(rewritten,decl,p.options.minifyWhitespace);
    else if ([D("margin-top"),D("margin-right"),D("margin-bottom"),D("margin-left")].includes(k) && minify) margin.mangleSide(rewritten,decl,p.options.minifyWhitespace,[D("margin-top"),D("margin-right"),D("margin-bottom"),D("margin-left")].indexOf(k));
    else if (k===D("padding") && minify) padding.mangleSides(rewritten,decl,p.options.minifyWhitespace);
    else if ([D("padding-top"),D("padding-right"),D("padding-bottom"),D("padding-left")].includes(k) && minify) padding.mangleSide(rewritten,decl,p.options.minifyWhitespace,[D("padding-top"),D("padding-right"),D("padding-bottom"),D("padding-left")].indexOf(k));
    else if (k===D("inset")) {
      if ((Number(p.options.unsupportedCSSFeatures??0)&256)!==0) {
        const { rules: decls, ok }=lowerInset(rule.Loc,decl,p.options.minifyWhitespace);
        if (ok) { rewritten.pop(); for (const d of decls) { rewritten.push(d); if (minify) inset.mangleSide(rewritten,d.Data as RDeclaration,p.options.minifyWhitespace,rewritten.length-1); } continue; }
      }
      if (minify) inset.mangleSides(rewritten,decl,p.options.minifyWhitespace);
    }
    else if ([D("top"),D("right"),D("bottom"),D("left")].includes(k) && minify) inset.mangleSide(rewritten,decl,p.options.minifyWhitespace,[D("top"),D("right"),D("bottom"),D("left")].indexOf(k));
    else if (k===D("border-radius") && minify) radius.mangleCorners(rewritten,decl,p.options.minifyWhitespace);
    else if ([D("border-top-left-radius"),D("border-top-right-radius"),D("border-bottom-right-radius"),D("border-bottom-left-radius")].includes(k) && minify)
      radius.mangleCorner(rewritten,decl,p.options.minifyWhitespace,[D("border-top-left-radius"),D("border-top-right-radius"),D("border-bottom-right-radius"),D("border-bottom-left-radius")].indexOf(k));
  }
  if (wouldClipColorFlag) { /* 与 Go 一致：仅当下一轮同属性不存在时重处理，此处已无下一轮 */ }
  if (minify) {
    let end=0;
    for (const rule of rewritten) if (rule.Data!=null) { rewritten[end]=rule; end++; }
    return rewritten.slice(0,end);
  }
  return rewritten;
}
function handleContainer(p: CSSParser, tokens: ASTToken[], nameOnly: boolean): void {
  if (nameOnly) { processContainerName(p,tokens); return; }
  processContainerShorthand(p,tokens);
}
function handleAnimation(p: CSSParser, tokens: ASTToken[], nameOnly: boolean): void {
  if (nameOnly) processAnimationName(p,tokens); else processAnimationShorthand(p,tokens);
}
function handleListStyle(p: CSSParser, tokens: ASTToken[]): void { processListStyleShorthand(p,tokens); }
function handleListStyleType(p: CSSParser, token: ASTToken): void { processListStyleType(p,token); }
