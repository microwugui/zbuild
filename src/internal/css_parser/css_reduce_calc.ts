// 1:1 移植自 esbuild internal/css_parser/css_reduce_calc.go（v0.28.2，commit f6058f83）
// 第 50 轮叶子优先规划：calc 浮点还原。真值表由 Go 探针固化在 testdata/css-parser-pure2-go.json。

/** Go: func floatToStringForCalc(a float64) (string, bool) (css_reduce_calc.go:72) */
export function floatToStringForCalc(a: number): { value: string; ok: boolean } {
  // Handle non-finite cases
  if (!Number.isFinite(a)) return { value: "", ok: false };

  // Print the number as a string (Go: fmt.Sprintf("%.05f", a))
  let text = a.toFixed(5);
  while (text[text.length - 1] === "0") text = text.slice(0, -1);
  if (text[text.length - 1] === ".") text = text.slice(0, -1);
  if (text.startsWith("0.")) {
    text = text.slice(1);
  } else if (text.startsWith("-0.")) {
    text = "-" + text.slice(2);
  }

  // Bail if the number is not exactly represented
  const number = parseFloat(text);
  if (Number.isNaN(number) || number !== a) return { value: "", ok: false };

  return { value: text, ok: true };
}

import { Token as ASTToken, T as AT } from "../css_ast/css_ast.ts";

// ============================================================================
// 第 104 批：css 整条 calc 归约链（一次 Go 探针覆盖 14 个真实函数，27 例逐字节等于 Go）
// 真值表固化于 testdata/css-calc-go.json（ce98274b…），out 由 Go 真实调用产生。
// 输入 CSS calc() token 树 → tryToReduceCalcExpression → 输出归约后 token 树 dump。
// ============================================================================


/** Go: calcTermWithOp (css_reduce_calc.go:34) */
interface CalcTermWithOp { data: CalcTerm; opLoc: number; }
/** Go: calcTerm interface (css_reduce_calc.go:40) */
interface CalcTerm {
  convertToToken(whitespace: number): [ASTToken, boolean];
  partiallySimplify(): CalcTerm;
}
const WSBefore = 1, WSAfter = 2;

/** Go: type calcSum struct (css_reduce_calc.go:45) */
export class CalcSum implements CalcTerm {
  terms: CalcTermWithOp[] = [];
  /** Go: func (c *calcSum) convertToToken(...) (css_ast.Token, bool) (css_reduce_calc.go:100) */
  convertToToken(whitespace: number): [ASTToken, boolean] {
    const tokens: ASTToken[] = [];
    const first = this.terms[0].data;
    if (first instanceof CalcProduct) {
      const [t, ok] = first.convertToToken(whitespace); if (!ok) return [new ASTToken(), false];
      for (const ch of (t.Children ?? [])) tokens.push(ch);
    } else {
      const [t, ok] = first.convertToToken(whitespace); if (!ok) return [new ASTToken(), false];
      tokens.push(t);
    }
    for (const term of this.terms.slice(1)) {
      if (term.data instanceof CalcNegate) {
        const [t, ok] = term.data.term.data.convertToToken(whitespace); if (!ok) return [new ASTToken(), false];
        const minus = new ASTToken(); minus.Loc = term.opLoc; minus.Kind = AT.TDelimMinus; minus.Text = "-"; minus.Whitespace = WSBefore | WSAfter;
        tokens.push(minus, t); continue;
      }
      if (term.data instanceof CalcNumeric && term.data.number < 0) {
        const clone = new CalcNumeric(); clone.unit = term.data.unit; clone.number = -term.data.number; clone.loc = term.data.loc;
        const [t, ok] = clone.convertToToken(whitespace); if (!ok) return [new ASTToken(), false];
        const minus = new ASTToken(); minus.Loc = term.opLoc; minus.Kind = AT.TDelimMinus; minus.Text = "-"; minus.Whitespace = WSBefore | WSAfter;
        tokens.push(minus, t); continue;
      }
      const plus = new ASTToken(); plus.Loc = term.opLoc; plus.Kind = AT.TDelimPlus; plus.Text = "+"; plus.Whitespace = WSBefore | WSAfter;
      tokens.push(plus);
      if (term.data instanceof CalcProduct) {
        const [t, ok] = term.data.convertToToken(whitespace); if (!ok) return [new ASTToken(), false];
        for (const ch of (t.Children ?? [])) tokens.push(ch);
      } else {
        const [t, ok] = term.data.convertToToken(whitespace); if (!ok) return [new ASTToken(), false];
        tokens.push(t);
      }
    }
    const root = new ASTToken(); root.Loc = tokens[0].Loc; root.Kind = AT.TOpenParen; root.Text = "("; root.Children = tokens;
    return [root, true];
  }
  /** Go: func (c *calcSum) partiallySimplify() calcTerm (css_reduce_calc.go:297) */
  partiallySimplify(): CalcTerm {
    let terms: CalcTermWithOp[] = [];
    for (const t0 of this.terms) {
      const term: CalcTermWithOp = { data: t0.data.partiallySimplify(), opLoc: t0.opLoc };
      if (term.data instanceof CalcSum) terms.push(...term.data.terms); else terms.push(term);
    }
    for (let i = 0; i < terms.length; i++) {
      const term = terms[i];
      if (term.data instanceof CalcNumeric) {
        const numeric = term.data;
        let end = i + 1;
        for (let j = end; j < terms.length; j++) {
          const term2 = terms[j];
          if (term2.data instanceof CalcNumeric && term2.data.unit.toLowerCase() === numeric.unit.toLowerCase()) {
            numeric.number += term2.data.number;
          } else { terms[end] = term2; end++; }
        }
        terms = terms.slice(0, end);
      }
    }
    if (terms.length === 1) return terms[0].data;
    this.terms = terms; return this;
  }
}

/** Go: type calcProduct struct (css_reduce_calc.go:49) */
export class CalcProduct implements CalcTerm {
  terms: CalcTermWithOp[] = [];
  /** Go: func (c *calcProduct) convertToToken(...) (css_reduce_calc.go:184) */
  convertToToken(whitespace: number): [ASTToken, boolean] {
    const tokens: ASTToken[] = [];
    const [first, ok0] = this.terms[0].data.convertToToken(whitespace); if (!ok0) return [new ASTToken(), false];
    tokens.push(first);
    for (const term of this.terms.slice(1)) {
      if (term.data instanceof CalcInvert) {
        const [t, ok] = term.data.term.data.convertToToken(whitespace); if (!ok) return [new ASTToken(), false];
        const slash = new ASTToken(); slash.Loc = term.opLoc; slash.Kind = AT.TDelimSlash; slash.Text = "/"; slash.Whitespace = whitespace;
        tokens.push(slash, t); continue;
      }
      const [t, ok] = term.data.convertToToken(whitespace); if (!ok) return [new ASTToken(), false];
      const star = new ASTToken(); star.Loc = term.opLoc; star.Kind = AT.TDelimAsterisk; star.Text = "*"; star.Whitespace = whitespace;
      tokens.push(star, t);
    }
    const root = new ASTToken(); root.Loc = tokens[0].Loc; root.Kind = AT.TOpenParen; root.Text = "("; root.Children = tokens;
    return [root, true];
  }
  /** Go: func (c *calcProduct) partiallySimplify() calcTerm (css_reduce_calc.go:342) */
  partiallySimplify(): CalcTerm {
    let terms: CalcTermWithOp[] = [];
    for (const t0 of this.terms) {
      const term: CalcTermWithOp = { data: t0.data.partiallySimplify(), opLoc: t0.opLoc };
      if (term.data instanceof CalcProduct) terms.push(...term.data.terms); else terms.push(term);
    }
    for (let i = 0; i < terms.length; i++) {
      const term = terms[i];
      if (term.data instanceof CalcNumeric && term.data.unit === "") {
        const numeric = term.data;
        let end = i + 1;
        for (let j = end; j < terms.length; j++) {
          const term2 = terms[j];
          if (term2.data instanceof CalcNumeric && term2.data.unit === "") { numeric.number *= term2.data.number; }
          else { terms[end] = term2; end++; }
        }
        terms = terms.slice(0, end); break;
      }
    }
    if (terms.length === 2) {
      const a = terms[0].data, b = terms[1].data;
      if (a instanceof CalcNumeric && b instanceof CalcNumeric) {
        if (a.unit === "") { b.number *= a.number; return b; }
        if (b.unit === "") { a.number *= b.number; return a; }
      }
    }
    for (let i = 1; i < terms.length; i++) {
      const d = terms[i].data;
      if (d instanceof CalcNumeric) {
        const reciprocal = 1 / d.number;
        const mul = floatToStringForCalc(d.number), div = floatToStringForCalc(reciprocal);
        if (mul.ok && div.ok && div.value.length < mul.value.length) {
          d.number = reciprocal;
          const inv = new CalcInvert(); inv.term = { data: d, opLoc: terms[i].opLoc };
          terms[i].data = inv;
        }
      }
    }
    if (terms.length === 1) return terms[0].data;
    this.terms = terms; return this;
  }
}

/** Go: type calcNegate struct (css_reduce_calc.go:53) */
export class CalcNegate implements CalcTerm {
  term: CalcTermWithOp = { data: new CalcValue(), opLoc: 0 };
  /** Go: func (c *calcNegate) convertToToken(...) (css_reduce_calc.go:230) */
  convertToToken(whitespace: number): [ASTToken, boolean] {
    const [t, ok] = this.term.data.convertToToken(whitespace); if (!ok) return [new ASTToken(), false];
    const root = new ASTToken(); root.Kind = AT.TOpenParen; root.Text = "(";
    const minusOne = new ASTToken(); minusOne.Loc = this.term.opLoc; minusOne.Kind = AT.TNumber; minusOne.Text = "-1";
    const star = new ASTToken(); star.Loc = this.term.opLoc; star.Kind = AT.TDelimSlash; star.Text = "*"; star.Whitespace = WSBefore | WSAfter;
    root.Children = [minusOne, star, t]; return [root, true];
  }
  /** Go: func (c *calcNegate) partiallySimplify() calcTerm (css_reduce_calc.go:423) */
  partiallySimplify(): CalcTerm {
    this.term.data = this.term.data.partiallySimplify();
    if (this.term.data instanceof CalcNumeric) { this.term.data.number = -this.term.data.number; return this.term.data; }
    if (this.term.data instanceof CalcNegate) return this.term.data.term.data;
    return this;
  }
}

/** Go: type calcInvert struct (css_reduce_calc.go:57) */
export class CalcInvert implements CalcTerm {
  term: CalcTermWithOp = { data: new CalcValue(), opLoc: 0 };
  /** Go: func (c *calcInvert) convertToToken(...) (css_reduce_calc.go:247) */
  convertToToken(whitespace: number): [ASTToken, boolean] {
    const [t, ok] = this.term.data.convertToToken(whitespace); if (!ok) return [new ASTToken(), false];
    const root = new ASTToken(); root.Kind = AT.TOpenParen; root.Text = "(";
    const one = new ASTToken(); one.Loc = this.term.opLoc; one.Kind = AT.TNumber; one.Text = "1";
    const slash = new ASTToken(); slash.Loc = this.term.opLoc; slash.Kind = AT.TDelimSlash; slash.Text = "/"; slash.Whitespace = WSBefore | WSAfter;
    root.Children = [one, slash, t]; return [root, true];
  }
  /** Go: func (c *calcInvert) partiallySimplify() calcTerm (css_reduce_calc.go:442) */
  partiallySimplify(): CalcTerm {
    this.term.data = this.term.data.partiallySimplify();
    if (this.term.data instanceof CalcNumeric && this.term.data.unit === "") { this.term.data.number = 1 / this.term.data.number; return this.term.data; }
    if (this.term.data instanceof CalcInvert) return this.term.data.term.data;
    return this;
  }
}

/** Go: type calcNumeric struct (css_reduce_calc.go:61) */
export class CalcNumeric implements CalcTerm {
  unit = ""; number = 0; loc = 0;
  /** Go: func (c *calcNumeric) convertToToken(...) (css_reduce_calc.go:264) */
  convertToToken(whitespace: number): [ASTToken, boolean] {
    const fs = floatToStringForCalc(this.number); if (!fs.ok) return [new ASTToken(), false];
    const text = fs.value;
    const t = new ASTToken();
    if (this.unit === "") { t.Loc = this.loc; t.Kind = AT.TNumber; t.Text = text; }
    else if (this.unit === "%") { t.Loc = this.loc; t.Kind = AT.TPercentage; t.Text = text + "%"; }
    else { t.Loc = this.loc; t.Kind = AT.TDimension; t.Text = text + this.unit; t.UnitOffset = text.length; }
    return [t, true];
  }
  /** Go: func (c *calcNumeric) partiallySimplify() calcTerm (css_reduce_calc.go:461) */
  partiallySimplify(): CalcTerm { return this; }
}

/** Go: type calcValue struct (css_reduce_calc.go:67) */
export class CalcValue implements CalcTerm {
  token: ASTToken = new ASTToken(); isInvalidPlusOrMinus = false;
  /** Go: func (c *calcValue) convertToToken(...) (css_reduce_calc.go:291) */
  convertToToken(whitespace: number): [ASTToken, boolean] {
    const t = this.token; t.Whitespace = 0; return [t, true];
  }
  /** Go: func (c *calcValue) partiallySimplify() calcTerm (css_reduce_calc.go:465) */
  partiallySimplify(): CalcTerm { return this; }
}

/** Go: func tryToParseCalcTerm(tokens []css_ast.Token) calcTerm (css_reduce_calc.go:469) */
export function tryToParseCalcTerm(tokens: ASTToken[]): CalcTerm | null {
  const terms: CalcTermWithOp[] = new Array(tokens.length);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    let term: CalcTerm;
    if (token.Kind === AT.TFunction && token.Text.toLowerCase() === "var") return null;
    else if (token.Kind === AT.TOpenParen || (token.Kind === AT.TFunction && token.Text.toLowerCase() === "calc")) {
      const t = tryToParseCalcTerm(token.Children ?? []); if (t === null) return null; term = t;
    } else if (token.Kind === AT.TNumber) {
      const n = parseFloat(token.Text);
      if (!Number.isNaN(n)) { const c = new CalcNumeric(); c.loc = token.Loc; c.number = n; term = c; }
      else { const c = new CalcValue(); c.token = token; term = c; }
    } else if (token.Kind === AT.TPercentage) {
      const n = parseFloat(token.Text.slice(0, token.Text.length - 1));
      if (!Number.isNaN(n)) { const c = new CalcNumeric(); c.loc = token.Loc; c.number = n; c.unit = "%"; term = c; }
      else { const c = new CalcValue(); c.token = token; term = c; }
    } else if (token.Kind === AT.TDimension) {
      const n = parseFloat(token.Text.slice(0, token.UnitOffset));
      if (!Number.isNaN(n)) { const c = new CalcNumeric(); c.loc = token.Loc; c.number = n; c.unit = token.Text.slice(token.UnitOffset); term = c; }
      else { const c = new CalcValue(); c.token = token; term = c; }
    } else if (token.Kind === AT.TIdent && token.Text.toLowerCase() === "infinity") {
      const c = new CalcNumeric(); c.loc = token.Loc; c.number = Infinity; term = c;
    } else if (token.Kind === AT.TIdent && token.Text.toLowerCase() === "-infinity") {
      const c = new CalcNumeric(); c.loc = token.Loc; c.number = -Infinity; term = c;
    } else if (token.Kind === AT.TIdent && token.Text.toLowerCase() === "nan") {
      const c = new CalcNumeric(); c.loc = token.Loc; c.number = NaN; term = c;
    } else {
      const c = new CalcValue(); c.token = token;
      c.isInvalidPlusOrMinus = i > 0 && i + 1 < tokens.length &&
        (token.Kind === AT.TDelimPlus || token.Kind === AT.TDelimMinus) &&
        (((token.Whitespace & WSBefore) === 0 && (tokens[i - 1].Whitespace & WSAfter) === 0) ||
         ((token.Whitespace & WSAfter) === 0 && (tokens[i + 1].Whitespace & WSBefore) === 0));
      term = c;
    }
    terms[i] = { data: term, opLoc: 0 };
  }
  // Collect Product and Invert nodes
  let first = 1;
  while (first + 1 < terms.length) {
    const v = terms[first].data;
    if (v instanceof CalcValue && (v.token.Kind === AT.TDelimAsterisk || v.token.Kind === AT.TDelimSlash)) {
      let last = first;
      while (last + 3 < terms.length) {
        const vv = terms[last + 2].data;
        if (vv instanceof CalcValue && (vv.token.Kind === AT.TDelimAsterisk || vv.token.Kind === AT.TDelimSlash)) last += 2;
        else break;
      }
      const product = new CalcProduct(); product.terms = new Array((last - first) / 2 + 2);
      for (let i = 0; i < product.terms.length; i++) {
        let term = terms[first + i * 2 - 1];
        term = { data: term.data, opLoc: term.opLoc };
        if (i > 0) {
          const op = (terms[first + i * 2 - 2].data as CalcValue).token;
          term.opLoc = op.Loc;
          if (op.Kind === AT.TDelimSlash) { const inv = new CalcInvert(); inv.term = term; term = { data: inv, opLoc: term.opLoc }; }
        }
        product.terms[i] = term;
      }
      terms[first - 1].data = product;
      terms.splice(first, last + 2 - first);
      continue;
    }
    first++;
  }
  // Collect Sum and Negate nodes
  first = 1;
  while (first + 1 < terms.length) {
    const v = terms[first].data;
    if (v instanceof CalcValue && !v.isInvalidPlusOrMinus && (v.token.Kind === AT.TDelimPlus || v.token.Kind === AT.TDelimMinus)) {
      let last = first;
      while (last + 3 < terms.length) {
        const vv = terms[last + 2].data;
        if (vv instanceof CalcValue && !vv.isInvalidPlusOrMinus && (vv.token.Kind === AT.TDelimPlus || vv.token.Kind === AT.TDelimMinus)) last += 2;
        else break;
      }
      const sum = new CalcSum(); sum.terms = new Array((last - first) / 2 + 2);
      for (let i = 0; i < sum.terms.length; i++) {
        let term = terms[first + i * 2 - 1];
        term = { data: term.data, opLoc: term.opLoc };
        if (i > 0) {
          const op = (terms[first + i * 2 - 2].data as CalcValue).token;
          term.opLoc = op.Loc;
          if (op.Kind === AT.TDelimMinus) { const neg = new CalcNegate(); neg.term = term; term = { data: neg, opLoc: term.opLoc }; }
        }
        sum.terms[i] = term;
      }
      terms[first - 1].data = sum;
      terms.splice(first, last + 2 - first);
      continue;
    }
    first++;
  }
  if (terms.length === 1) return terms[0].data;
  return null;
}

/** Go: func (p *parser) tryToReduceCalcExpression(token css_ast.Token) css_ast.Token (css_reduce_calc.go:14) */
export function tryToReduceCalcExpression(token: ASTToken, minifyWhitespace: boolean): ASTToken {
  let term = tryToParseCalcTerm(token.Children ?? []);
  if (term !== null) {
    let whitespace = WSBefore | WSAfter;
    if (minifyWhitespace) whitespace = 0;
    term = term.partiallySimplify();
    const [result, ok] = term.convertToToken(whitespace);
    if (ok) {
      if (result.Kind === AT.TOpenParen) { result.Kind = AT.TFunction; result.Text = "calc"; }
      result.Loc = token.Loc;
      result.Whitespace = WSBefore | WSAfter;
      return result;
    }
  }
  return token;
}
