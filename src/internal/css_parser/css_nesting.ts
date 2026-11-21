// 1:1 移植自 esbuild internal/css_parser/css_nesting.go（v0.28.2，commit f6058f83）
// 第 106 批：selector term count 助手。真值表由 Go 探针固化在 testdata/css-sel-go.json。
import { CompoundSelector, ComplexSelector, SubclassSelector, SSPseudoClassWithSelectorList } from "../css_ast/css_ast.ts";

/** Go: func compoundSelectorTermCount(sel css_ast.CompoundSelector) int (css_nesting.go:119) */
export function compoundSelectorTermCount(sel: CompoundSelector): number {
  let count = 0;
  for (const ss of sel.SubclassSelectors as SubclassSelector[]) {
    count++;
    if (ss.Data instanceof SSPseudoClassWithSelectorList) count += complexSelectorTermCount(ss.Data.Selectors);
  }
  return count;
}
/** Go: func complexSelectorTermCount(selectors []css_ast.ComplexSelector) int (css_nesting.go:130) */
export function complexSelectorTermCount(selectors: ComplexSelector[]): number {
  let count = 0;
  for (const sel of selectors) for (const inner of sel.Selectors) count += compoundSelectorTermCount(inner);
  return count;
}

// ============================================================================
// 第 129 批：nesting 纯助手 4 函数（Go 探针 8 例，nest-helpers-go.json）。
// ============================================================================
import { CSSParser } from "./css_parser.ts";
import { Range, Loc, MsgData, AddErrorWithNotes, AddIDWithNotes } from "../logger/logger.ts";
import { MsgID_CSS_UnsupportedCSSNesting } from "../logger/msg_ids.ts";
import { PseudoClassKindAll, CloneComplexSelector, SSPseudoClass } from "../css_ast/css_ast.ts";

export const keepLeadingCombinator = 0, stripLeadingCombinator = 1;

/** Go: func (p *parser) addExpansionError(loc logger.Loc, n int) (css_nesting.go:140) */
export function addExpansionError(p: CSSParser, loc: number, n: number): void {
  const note = new MsgData();
  note.Text = `CSS nesting expansion was terminated because a rule was generated with ${n} selectors. ` +
    "This limit exists to prevent esbuild from using too much time and/or memory. " +
    "Please change your CSS to use fewer levels of nesting.";
  AddErrorWithNotes(p.log, p.tracker, new Range(new Loc(loc), 0), "CSS nesting is causing too much expansion", [note]);
}

/** Go: func (p *parser) substituteAmpersandsInCompoundSelector(sel, replacementFn, results, strip) []css_ast.CompoundSelector (css_nesting.go:370) */
export function substituteAmpersandsInCompoundSelector(
  p: CSSParser,
  sel: CompoundSelector,
  replacementFn: (loc: number) => ComplexSelector,
  results: CompoundSelector[],
  strip: number,
): CompoundSelector[] {
  for (const nestingSelectorLoc of sel.NestingSelectorLocs) {
    const replacement = replacementFn(nestingSelectorLoc);
    let single = new CompoundSelector();
    if (sel.Combinator === 0 && (replacement.Selectors.length === 1 || results.length === 0)) {
      const last = replacement.Selectors.length - 1;
      results.push(...replacement.Selectors.slice(0, last));
      single = replacement.Selectors[last];
      if (strip === stripLeadingCombinator) single.Combinator = 0;
      sel.Combinator = single.Combinator;
    } else if (replacement.Selectors.length === 1) {
      single = replacement.Selectors[0];
      if (strip === stripLeadingCombinator) single.Combinator = 0;
    } else {
      reportNestingWithGeneratedPseudoClassIs(p, nestingSelectorLoc);
      const plist = new SSPseudoClassWithSelectorList();
      plist.Kind = PseudoClassKindAll.PseudoClassIs;
      plist.Selectors = [CloneComplexSelector(replacement)];
      const ss = new SubclassSelector(plist); ss.Range = new Range(new Loc(nestingSelectorLoc), 0);
      single = new CompoundSelector(); single.SubclassSelectors = [ss];
    }
    let prefix: SubclassSelector[] = [];
    if (single.TypeSelector !== null) {
      if (sel.TypeSelector !== null) {
        reportNestingWithGeneratedPseudoClassIs(p, nestingSelectorLoc);
        const plist = new SSPseudoClassWithSelectorList();
        plist.Kind = PseudoClassKindAll.PseudoClassIs;
        const plistInner = new ComplexSelector();
        const plistCompound = new CompoundSelector(); plistCompound.TypeSelector = sel.TypeSelector;
        plistInner.Selectors = [plistCompound];
        plist.Selectors = [plistInner];
        const ss = new SubclassSelector(plist); ss.Range = (sel.TypeSelector as any).Range();
        prefix = [ss];
      }
      sel.TypeSelector = single.TypeSelector;
    }
    prefix = prefix.concat(single.SubclassSelectors as SubclassSelector[]);
    if (prefix.length > 0) sel.SubclassSelectors = prefix.concat(sel.SubclassSelectors as SubclassSelector[]);
  }
  sel.NestingSelectorLocs = [];
  for (const ss of sel.SubclassSelectors as SubclassSelector[]) {
    const d = ss.Data;
    if (d instanceof SSPseudoClassWithSelectorList) {
      const outer: ComplexSelector[] = [];
      for (const complex of d.Selectors) {
        const inner: CompoundSelector[] = [];
        for (const s0 of complex.Selectors) inner.push(...substituteAmpersandsInCompoundSelector(p, s0, replacementFn, [], stripLeadingCombinator));
        const q = new ComplexSelector(); q.Selectors = inner; outer.push(q);
      }
      d.Selectors = outer;
    }
  }
  results.push(sel);
  return results;
}

/** Go: func (p *parser) multipleComplexSelectorsToSingleComplexSelector(selectors) func(logger.Loc) css_ast.ComplexSelector (css_nesting.go:460) */
export function multipleComplexSelectorsToSingleComplexSelector(
  _p: CSSParser, selectors: ComplexSelector[],
): (loc: number) => ComplexSelector {
  if (selectors.length === 1) return (_loc: number) => selectors[0];
  let leadingCombinator = 0;
  const clones: ComplexSelector[] = [];
  for (const sel of selectors) {
    leadingCombinator = sel.Selectors[0].Combinator;
    clones.push(CloneComplexSelector(sel));
  }
  return (loc: number): ComplexSelector => {
    const plist = new SSPseudoClassWithSelectorList();
    plist.Kind = PseudoClassKindAll.PseudoClassIs; plist.Selectors = clones;
    const ss = new SubclassSelector(plist); ss.Range = new Range(new Loc(loc), 0);
    const cp = new CompoundSelector(); cp.Combinator = leadingCombinator; cp.SubclassSelectors = [ss];
    const out = new ComplexSelector(); out.Selectors = [cp]; return out;
  };
}

/** Go: func (p *parser) reportNestingWithGeneratedPseudoClassIs(nestingSelectorLoc logger.Loc) (css_nesting.go:492) */
export function reportNestingWithGeneratedPseudoClassIs(p: CSSParser, nestingSelectorLoc: number): void {
  if ((Number(p.options.unsupportedCSSFeatures ?? 0) & 256 /* compat.IsPseudoClass */) !== 0) {
    if (p.nestingWarnings.has(nestingSelectorLoc)) return;
    p.nestingWarnings.set(nestingSelectorLoc, true);
    let text = "Transforming this CSS nesting syntax is not supported in the configured target environment";
    if (p.options.originalTargetEnv) text = `${text} (${p.options.originalTargetEnv})`;
    const note = new MsgData();
    note.Text = 'The nesting transform for this case must generate an ":is(...)" but the configured target environment does not support the ":is" pseudo-class.';
    AddIDWithNotes(p.log, MsgID_CSS_UnsupportedCSSNesting, 1 /* Warning */, p.tracker,
      new Range(new Loc(nestingSelectorLoc), 1), text, [note]);
  }
}

// ============================================================================
// 第 130 批：nesting lowering 三函数（Go 探针 7 例，nest-lower-go.json）。
// ============================================================================
import { Rule, RSelector, RKnownAt, RAtMedia, RAtLayer, UsesPseudoElement } from "../css_ast/css_ast.ts";

/** Go: type lowerNestingContext (css_nesting.go:145) */
export class lowerNestingContext {
  parentSelectorsWithPseudo: ComplexSelector[] = [];
  parentSelectorsNoPseudo: ComplexSelector[] = [];
  loweredRules: Rule[] = [];
}

/** Go: func (p *parser) lowerNestingInRule(rule css_ast.Rule, results []css_ast.Rule) []css_ast.Rule (css_nesting.go:11) */
export function lowerNestingInRule(p: CSSParser, rule: Rule, results: Rule[]): Rule[] {
  const r = rule.Data;
  if (r instanceof RSelector) {
    const scope = (loc: number): ComplexSelector => {
      const cp = new CompoundSelector();
      const ss = new SubclassSelector(new SSPseudoClass());
      (ss.Data as SSPseudoClass).Name = "scope";
      ss.Range = new Range(new Loc(loc), 0);
      cp.SubclassSelectors = [ss];
      const c = new ComplexSelector(); c.Selectors = [cp]; return c;
    };
    const withPseudo: ComplexSelector[] = [], noPseudo: ComplexSelector[] = [];
    for (const sel of r.Selectors) {
      const substituted: CompoundSelector[] = [];
      for (const x of sel.Selectors) substituted.push(...substituteAmpersandsInCompoundSelector(p, x, scope, [], keepLeadingCombinator));
      const lowered = new ComplexSelector(); lowered.Selectors = substituted;
      sel.Selectors = substituted;
      if (!UsesPseudoElement(sel.Selectors)) noPseudo.push(lowered);
      withPseudo.push(lowered);
    }
    const start = results.length;
    results.push(rule);
    const context = new lowerNestingContext();
    context.parentSelectorsWithPseudo = withPseudo;
    context.parentSelectorsNoPseudo = noPseudo;
    context.loweredRules = results;
    r.Rules = lowerNestingInRulesAndReturnRemaining(p, r.Rules, context);
    if (r.Rules.length === 0) {
      context.loweredRules.splice(start, 1);
    }
    return context.loweredRules;
  }
  if (r instanceof RKnownAt || r instanceof RAtLayer || r instanceof RAtMedia) {
    let rules: Rule[] = [];
    for (const child of r.Rules) rules = lowerNestingInRule(p, child, rules);
    r.Rules = rules;
  }
  return results.concat([rule]);
}

/** Go: func (p *parser) lowerNestingInRulesAndReturnRemaining(rules, context) []css_ast.Rule (css_nesting.go:107) */
export function lowerNestingInRulesAndReturnRemaining(p: CSSParser, rules: Rule[], context: lowerNestingContext): Rule[] {
  let n = 0;
  for (const child0 of rules) {
    const child = lowerNestingInRuleWithContext(p, child0, context);
    if (child.Data != null) { rules[n] = child; n++; }
  }
  return rules.slice(0, n);
}

/** Go: func (p *parser) lowerNestingInRuleWithContext(rule, context) css_ast.Rule (css_nesting.go:153) */
export function lowerNestingInRuleWithContext(p: CSSParser, rule: Rule, context: lowerNestingContext): Rule {
  const r = rule.Data;
  if (r instanceof RSelector) {
    const oldLen = r.Selectors.length;
    const oldComplexity = complexSelectorTermCount(r.Selectors);
    for (const sel of r.Selectors) {
      if (sel.IsRelative()) {
        const amp = new CompoundSelector(); amp.NestingSelectorLocs = [rule.Loc];
        sel.Selectors = [amp].concat(sel.Selectors);
      }
    }
    const canIs = (Number(p.options.unsupportedCSSFeatures ?? 0) & 256) === 0;
    if (canIs || context.parentSelectorsNoPseudo.length <= 1) {
      for (const complex of r.Selectors) {
        const results: CompoundSelector[] = [];
        const parent = multipleComplexSelectorsToSingleComplexSelector(p, context.parentSelectorsNoPseudo);
        for (const compound of complex.Selectors) substituteAmpersandsInCompoundSelector(p, compound, parent, results, keepLeadingCombinator);
        complex.Selectors = results;
      }
    } else {
      const selectors: ComplexSelector[] = [];
      const indices: number[] = [];
      for (;;) {
        let offset = 0;
        const parent = (_loc: number): ComplexSelector => {
          if (offset === indices.length) indices.push(0);
          const index = indices[offset]; offset++;
          return context.parentSelectorsNoPseudo[index];
        };
        for (const complex0 of r.Selectors) {
          const complex = new ComplexSelector(); complex.Selectors = complex0.Selectors.slice();
          const results: CompoundSelector[] = [];
          for (const compound of complex.Selectors) substituteAmpersandsInCompoundSelector(p, compound, parent, results, keepLeadingCombinator);
          complex.Selectors = results;
          selectors.push(complex);
          offset = 0;
        }
        let carry = indices.length;
        while (carry > 0) {
          const idx = carry - 1;
          if (indices[idx] + 1 < context.parentSelectorsNoPseudo.length) { indices[idx]++; break; }
          indices[idx] = 0; carry--;
        }
        if (carry === 0) break;
      }
      r.Selectors = selectors;
    }
    if (r.Selectors.length > oldLen && r.Selectors.length > 0xFF00) { addExpansionError(p, rule.Loc, r.Selectors.length); return new Rule(); }
    const n = complexSelectorTermCount(r.Selectors);
    if (n > oldComplexity && n > 0xFF00) { addExpansionError(p, rule.Loc, n); return new Rule(); }
    context.loweredRules = lowerNestingInRule(p, rule, context.loweredRules);
    return new Rule();
  }
  if (r instanceof RKnownAt || r instanceof RAtMedia || r instanceof RAtLayer) {
    const childContext = new lowerNestingContext();
    childContext.parentSelectorsWithPseudo = context.parentSelectorsWithPseudo;
    childContext.parentSelectorsNoPseudo = context.parentSelectorsNoPseudo;
    r.Rules = lowerNestingInRulesAndReturnRemaining(p, r.Rules, childContext);
    if (r.Rules.length > 0) {
      const holder = new Rule(); const sel = new RSelector();
      sel.Selectors = context.parentSelectorsWithPseudo; sel.Rules = r.Rules;
      holder.Loc = rule.Loc; holder.Data = sel;
      childContext.loweredRules = [holder].concat(childContext.loweredRules);
    }
    if (r instanceof RAtLayer || childContext.loweredRules.length > 0) {
      if (childContext.loweredRules.length > 0) {
        r.Rules = childContext.loweredRules;
        context.loweredRules.push(rule);
      } else r.Rules = childContext.loweredRules;
    }
    return new Rule();
  }
  return rule;
}
