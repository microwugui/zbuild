// 1:1 移植自 esbuild internal/css_parser/css_decls_border_radius.go（v0.28.2，commit f6058f83）
// 第 110 批：borderRadiusTracker 整簇（Go 探针 7 例，逐字节等于 Go）。
// 真值表固化于 testdata/css-br-go.json（fb88ccc9…）。
import { Rule, RDeclaration, Token as ASTToken, T as AT } from "../css_ast/css_ast.ts";
import { unitSafetyTracker } from "./css_decls_box.ts";
import { expandTokenQuad, compactTokenQuad } from "./css_decls.ts";
import { TokensEqualIgnoringWhitespace } from "../css_ast/css_ast.ts";

const borderRadiusTopLeft = 0, borderRadiusTopRight = 1, borderRadiusBottomRight = 2, borderRadiusBottomLeft = 3;

/** Go: type borderRadiusCorner struct (css_decls_border_radius.go:17) */
class BorderRadiusCorner {
  firstToken: ASTToken = new ASTToken();
  secondToken: ASTToken = new ASTToken();
  unitSafety: unitSafetyTracker = new unitSafetyTracker();
  ruleIndex = 0;
  wasSingleRule = false;
}
function cloneTok(t: ASTToken): ASTToken {
  const c = new ASTToken(); c.Kind = t.Kind; c.Text = t.Text; c.UnitOffset = t.UnitOffset; c.Whitespace = t.Whitespace; c.PayloadIndex = t.PayloadIndex; c.Loc = t.Loc; c.Children = t.Children; return c;
}
function cloneSafety(s: unitSafetyTracker): unitSafetyTracker { const c = new unitSafetyTracker(); c.unit = s.unit; c.status = s.status; return c; }
function turnLenZero(t: ASTToken): boolean {
  if (t.Kind === AT.TDimension && t.Text.slice(0, t.UnitOffset) === "0") { t.Kind = AT.TNumber; t.Text = "0"; return true; }
  return false;
}
const newCorners = (): BorderRadiusCorner[] => [new BorderRadiusCorner(), new BorderRadiusCorner(), new BorderRadiusCorner(), new BorderRadiusCorner()];

/** Go: type borderRadiusTracker struct (css_decls_border_radius.go:23) */
export class borderRadiusTracker {
  corners: BorderRadiusCorner[] = newCorners();
  important = false;

  /** Go: func (borderRadius *borderRadiusTracker) updateCorner(...) (css_decls_border_radius.go:28) */
  updateCorner(rules: Rule[], corner: number, next: BorderRadiusCorner): void {
    const old = this.corners[corner];
    if (old.firstToken.Kind !== 0 && (!next.wasSingleRule || old.wasSingleRule) &&
        old.unitSafety.status === 0 && next.unitSafety.status === 0) {
      rules[old.ruleIndex] = new Rule();
    }
    this.corners[corner] = next;
  }

  /** Go: func (borderRadius *borderRadiusTracker) mangleCorners(...) (css_decls_border_radius.go:48) */
  mangleCorners(rules: Rule[], decl: RDeclaration, minifyWhitespace: boolean): void {
    if (this.important !== decl.Important) { this.corners = newCorners(); this.important = decl.Important; }
    const tokens = decl.Value;
    let beforeSplit = tokens.length, afterSplit = tokens.length;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].Kind === AT.TDelimSlash) {
        if (beforeSplit === tokens.length) { beforeSplit = i; afterSplit = i + 1; }
        else { this.corners = newCorners(); return; }
      }
    }
    const unitSafety = new unitSafetyTracker();
    for (const t of tokens.slice(0, beforeSplit)) unitSafety.includeUnitOf(t);
    for (const t of tokens.slice(afterSplit)) unitSafety.includeUnitOf(t);
    const firstRadii = expandTokenQuad(tokens.slice(0, beforeSplit), "");
    const lastRadii = expandTokenQuad(tokens.slice(afterSplit), "");
    if (!firstRadii.ok || (beforeSplit < afterSplit && !lastRadii.ok)) { this.corners = newCorners(); return; }
    for (let corner = 0; corner < 4; corner++) {
      let t = firstRadii.result[corner];
      if (unitSafety.status === 0) { t = cloneTok(t); turnLenZero(t); }
      const bc = new BorderRadiusCorner(); bc.firstToken = t; bc.secondToken = t; bc.unitSafety = cloneSafety(unitSafety); bc.ruleIndex = rules.length - 1;
      this.updateCorner(rules, corner, bc);
    }
    if (lastRadii.ok) {
      for (let corner = 0; corner < 4; corner++) {
        let t = lastRadii.result[corner];
        if (unitSafety.status === 0) { t = cloneTok(t); turnLenZero(t); }
        this.corners[corner].secondToken = t;
      }
    }
    this.compactRules(rules, minifyWhitespace);
  }

  /** Go: func (borderRadius *borderRadiusTracker) mangleCorner(...) (css_decls_border_radius.go:98) */
  mangleCorner(rules: Rule[], decl: RDeclaration, minifyWhitespace: boolean, corner: number): void {
    if (this.important !== decl.Important) { this.corners = newCorners(); this.important = decl.Important; }
    const tokens = decl.Value;
    const numeric = (k: number): boolean => k === AT.TNumber || k === AT.TDimension || k === AT.TPercentage;
    if ((tokens.length === 1 && numeric(tokens[0].Kind)) || (tokens.length === 2 && numeric(tokens[0].Kind) && numeric(tokens[1].Kind))) {
      let firstToken = tokens[0];
      let secondToken = firstToken;
      if (tokens.length === 2) secondToken = tokens[1];
      const unitSafety = new unitSafetyTracker();
      unitSafety.includeUnitOf(firstToken);
      unitSafety.includeUnitOf(secondToken);
      if (unitSafety.status === 0 && turnLenZero(firstToken)) tokens[0] = firstToken;
      if (tokens.length === 2) {
        if (unitSafety.status === 0 && turnLenZero(secondToken)) tokens[1] = secondToken;
        if (TokensEqualIgnoringWhitespace([firstToken], [secondToken])) { tokens[0].Whitespace &= ~2; decl.Value = tokens.slice(0, 1); }
      }
      const bc = new BorderRadiusCorner(); bc.firstToken = firstToken; bc.secondToken = secondToken; bc.unitSafety = cloneSafety(unitSafety); bc.ruleIndex = rules.length - 1; bc.wasSingleRule = true;
      this.updateCorner(rules, corner, bc);
      this.compactRules(rules, minifyWhitespace);
    } else {
      this.corners = newCorners();
    }
  }

  /** Go: func (borderRadius *borderRadiusTracker) compactRules(...) (css_decls_border_radius.go:157) */
  compactRules(rules: Rule[], minifyWhitespace: boolean): void {
    const eof = 0;
    if (this.corners.some((c) => c.firstToken.Kind === eof)) return;
    for (let i = 1; i < 4; i++) if (!this.corners[i].unitSafety.isSafeWith(this.corners[0].unitSafety)) return;
    let tokens = compactTokenQuad(this.corners[0].firstToken, this.corners[1].firstToken, this.corners[2].firstToken, this.corners[3].firstToken, minifyWhitespace);
    const secondTokens = compactTokenQuad(this.corners[0].secondToken, this.corners[1].secondToken, this.corners[2].secondToken, this.corners[3].secondToken, minifyWhitespace);
    if (!TokensEqualIgnoringWhitespace(tokens, secondTokens)) {
      let whitespace = 0; if (!minifyWhitespace) whitespace = 1 | 2;
      const slash = new ASTToken(); slash.Loc = tokens[tokens.length - 1].Loc; slash.Kind = AT.TDelimSlash; slash.Text = "/"; slash.Whitespace = whitespace;
      tokens = [...tokens, slash, ...secondTokens];
    }
    let minLoc = 0;
    for (let i = 0; i < 4; i++) { const loc = rules[this.corners[i].ruleIndex].Loc; if (i === 0 || loc < minLoc) minLoc = loc; }
    for (const c of this.corners) rules[c.ruleIndex] = new Rule();
    const decl = new RDeclaration(); decl.Key = 66 /* DBorderRadius */; decl.KeyText = "border-radius"; decl.Value = tokens; decl.Important = this.important;
    const combined = new Rule(); combined.Loc = minLoc; combined.Data = decl;
    rules[this.corners[3].ruleIndex] = combined;
  }
}
