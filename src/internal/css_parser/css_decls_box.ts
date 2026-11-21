// 1:1 移植自 esbuild internal/css_parser/css_decls_box.go（v0.28.2，commit f6058f83）
// 第 96 轮叶子优先规划：unitSafetyTracker 助手。真值表由 Go 探针固化在 testdata/css-box-go.json。
import { T, Token } from "../css_ast/css_ast.ts";

/** Go: unitSafetyStatus (css_decls_box.go:33) */
export const unitSafe = 0, unitUnsafeSingle = 1, unitUnsafeMixed = 2;

/** Go: type unitSafetyTracker struct (css_decls_box.go:52) */
export class unitSafetyTracker {
  unit: string = "";
  status: number = unitSafe;

  /** Go: func (a unitSafetyTracker) isSafeWith(b unitSafetyTracker) bool (css_decls_box.go:58) */
  isSafeWith(b: unitSafetyTracker): boolean {
    return this.status === b.status && this.status !== unitUnsafeMixed && (this.status !== unitUnsafeSingle || this.unit === b.unit);
  }

  /** Go: func (t *unitSafetyTracker) includeUnitOf(token css_ast.Token) (css_decls_box.go:62) */
  includeUnitOf(token: Token): void {
    if (token.Kind === T.TNumber) {
      if (token.Text === "0") return;
    } else if (token.Kind === T.TPercentage) {
      return;
    } else if (token.Kind === T.TDimension) {
      if (token.DimensionUnitIsSafeLength()) return;
      const unit = token.DimensionUnit();
      if (this.status === unitSafe) { this.status = unitUnsafeSingle; this.unit = unit; return; }
      if (this.status === unitUnsafeSingle && this.unit === unit) return;
    }
    this.status = unitUnsafeMixed;
  }
}

// ============================================================================
// 第 109 批：boxTracker 整簇（Go 探针 8 例，逐字节等于 Go）。
// 真值表固化于 testdata/css-box2-go.json（55565ecc…）。
// 覆盖 mangleSides/mangleSide 入口及其内部 updateSide/compactRules。
// ============================================================================
import { Rule, RDeclaration, Token as ASTToken, T as AT } from "../css_ast/css_ast.ts";
import { Loc, Range } from "../logger/logger.ts";
import { expandTokenQuad, compactTokenQuad } from "./css_decls.ts";

/** Go: type boxSide struct (css_decls_box.go:18) */
class BoxSide {
  token: ASTToken = new ASTToken();
  unitSafety: unitSafetyTracker = new unitSafetyTracker();
  ruleIndex = 0;
  wasSingleRule = false;
}
/** Go: type boxTracker struct (css_decls_box.go:25) —— 只落 mangle 用到的字段 */
export class boxTracker {
  keyText = "";
  sides: BoxSide[] = [new BoxSide(), new BoxSide(), new BoxSide(), new BoxSide()];
  allowAuto = false;
  important = false;
  key = 0;

  /** Go: func (box *boxTracker) updateSide(...) (css_decls_box.go:87) */
  updateSide(rules: Rule[], side: number, next: BoxSide): void {
    const old = this.sides[side];
    if (old.token.Kind !== 0 && (!next.wasSingleRule || old.wasSingleRule) &&
        old.unitSafety.status === 0 && next.unitSafety.status === 0) {
      rules[old.ruleIndex] = new Rule();
    }
    this.sides[side] = next;
  }

  /** Go: func (box *boxTracker) mangleSides(...) (css_decls_box.go:96) */
  mangleSides(rules: Rule[], decl: RDeclaration, minifyWhitespace: boolean): void {
    if (this.important !== decl.Important) {
      this.sides = [new BoxSide(), new BoxSide(), new BoxSide(), new BoxSide()];
      this.important = decl.Important;
    }
    const allowedIdent = this.allowAuto ? "auto" : "";
    const quad = expandTokenQuad(decl.Value, allowedIdent);
    if (quad.ok) {
      const unitSafety = new unitSafetyTracker();
      for (const t of quad.result) if (!this.allowAuto || isNumeric(t.Kind)) unitSafety.includeUnitOf(t);
      for (let side = 0; side < quad.result.length; side++) {
        let t = quad.result[side];
        if (unitSafety.status === 0) { t = cloneTok(t); if (turnLenZero(t)) { /* mutated */ } }
        const bs = new BoxSide(); bs.token = t; bs.ruleIndex = rules.length - 1; bs.unitSafety = cloneSafety(unitSafety);
        this.updateSide(rules, side, bs);
      }
      this.compactRules(rules, minifyWhitespace, decl.KeyRange);
    } else {
      this.sides = [new BoxSide(), new BoxSide(), new BoxSide(), new BoxSide()];
    }
  }

  /** Go: func (box *boxTracker) mangleSide(...) (css_decls_box.go:131) */
  mangleSide(rules: Rule[], decl: RDeclaration, minifyWhitespace: boolean, side: number): void {
    if (this.important !== decl.Important) {
      this.sides = [new BoxSide(), new BoxSide(), new BoxSide(), new BoxSide()];
      this.important = decl.Important;
    }
    const tokens = decl.Value;
    if (tokens.length === 1) {
      const t0 = tokens[0];
      if (isNumeric(t0.Kind) || (t0.Kind === AT.TIdent && this.allowAuto && t0.Text.toLowerCase() === "auto")) {
        const unitSafety = new unitSafetyTracker();
        if (!this.allowAuto || isNumeric(t0.Kind)) unitSafety.includeUnitOf(t0);
        let t = t0;
        if (unitSafety.status === 0) { t = cloneTok(t); if (turnLenZero(t)) tokens[0] = t; }
        const bs = new BoxSide(); bs.token = t; bs.ruleIndex = rules.length - 1; bs.wasSingleRule = true; bs.unitSafety = cloneSafety(unitSafety);
        this.updateSide(rules, side, bs);
        this.compactRules(rules, minifyWhitespace, decl.KeyRange);
        return;
      }
    }
    this.sides = [new BoxSide(), new BoxSide(), new BoxSide(), new BoxSide()];
  }

  /** Go: func (box *boxTracker) compactRules(...) (css_decls_box.go:161) */
  compactRules(rules: Rule[], minifyWhitespace: boolean, keyRange: Range): void {
    if (this.key === 0 /* DUnknown */) return;
    if (this.sides[0].token.Kind === 0 || this.sides[1].token.Kind === 0 ||
        this.sides[2].token.Kind === 0 || this.sides[3].token.Kind === 0) return;
    for (let i = 1; i < 4; i++) if (!this.sides[i].unitSafety.isSafeWith(this.sides[0].unitSafety)) return;
    const tokens = compactTokenQuad(this.sides[0].token, this.sides[1].token, this.sides[2].token, this.sides[3].token, minifyWhitespace);
    let minLoc = 0;
    for (let i = 0; i < 4; i++) { const loc = rules[this.sides[i].ruleIndex].Loc; if (i === 0 || loc < minLoc) minLoc = loc; }
    for (const side of this.sides) rules[side.ruleIndex] = new Rule();
    const decl = new RDeclaration();
    decl.Key = this.key; decl.KeyText = this.keyText; decl.Value = tokens; decl.Important = this.important;
    decl.KeyRange = keyRange;
    const combined = new Rule(); combined.Loc = minLoc; combined.Data = decl;
    rules[this.sides[3].ruleIndex] = combined;
  }
}

function cloneTok(t: ASTToken): ASTToken {
  const c = new ASTToken(); c.Kind = t.Kind; c.Text = t.Text; c.UnitOffset = t.UnitOffset; c.Whitespace = t.Whitespace; c.PayloadIndex = t.PayloadIndex; c.Loc = t.Loc; c.Children = t.Children; return c;
}
function cloneSafety(s: unitSafetyTracker): unitSafetyTracker { const c = new unitSafetyTracker(); c.unit = s.unit; c.status = s.status; return c; }
function isNumeric(kind: number): boolean { return kind === AT.TNumber || kind === AT.TDimension || kind === AT.TPercentage; }
function turnLenZero(t: ASTToken): boolean {
  if (t.Kind === AT.TDimension && t.Text.slice(0, t.UnitOffset) === "0") { t.Kind = AT.TNumber; t.Text = "0"; return true; }
  return false;
}
