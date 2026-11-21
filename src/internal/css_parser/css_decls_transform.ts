// 1:1 移植自 esbuild internal/css_parser/css_decls_transform.go（v0.28.2，commit f6058f83）
// 第 105 批：turnPercentIntoNumberIfShorter。
import { Token, T } from "../css_ast/css_ast.ts";
import { shiftDot } from "./css_parser.ts";

/** Go: func turnPercentIntoNumberIfShorter(t *css_ast.Token) (css_decls_transform.go:10) */
export function turnPercentIntoNumberIfShorter(t: Token): void {
  if (t.Kind === T.TPercentage) {
    const shifted = shiftDot(t.Text.slice(0, t.Text.length - 1), -2);
    if (shifted.ok && shifted.value.length < t.Text.length) {
      t.Kind = T.TNumber; t.Text = shifted.value;
    }
  }
}

// ============================================================================
// 第 135 批：mangleTransforms（Go 探针 main-chain-go.json，1:1 移植 css_decls_transform.go:21）
// ============================================================================
import { TokensAreCommaSeparated, TokenEqualIgnoringWhitespace } from "../css_ast/css_ast.ts";

/** Go: func (p *parser) mangleTransforms(tokens []css_ast.Token) []css_ast.Token (css_decls_transform.go:21) */
export function mangleTransforms(tokens: Token[]): Token[] {
  for (const token of tokens) {
    if (token.Kind !== T.TFunction || token.Children === null) continue;
    const args = token.Children;
    if (!TokensAreCommaSeparated(args)) continue;
    const n = args.length;
    switch (token.Text.toLowerCase()) {
      case "matrix": {
        if (n === 11) {
          const [a,,c,,d,e,f] = [args[0],args[1],args[2],args[3],args[4],args[5],args[6],args[8],args[10]];
          const a0=args[0], b=args[2], c0=args[4], d0=args[6], e0=args[8], f0=args[10];
          void a; void c; void d; void e; void f;
          if (b.IsZero() && c0.IsZero() && e0.IsZero() && f0.IsZero()) {
            if (TokenEqualIgnoringWhitespace(a0, d0)) { token.Text="scale"; token.Children=[a0]; }
            else if (d0.IsOne()) { token.Text="scaleX"; token.Children=[a0]; }
            else if (a0.IsOne()) { token.Text="scaleY"; token.Children=[d0]; }
            else { token.Text="scale"; token.Children=[a0, args[3], d0]; }
          }
        }
        break;
      }
      case "translate":
        if (n === 1) args[0].TurnLengthOrPercentageIntoNumberIfZero();
        else if (n === 3) {
          args[0].TurnLengthOrPercentageIntoNumberIfZero(); args[2].TurnLengthOrPercentageIntoNumberIfZero();
          if (args[2].IsZero()) token.Children = [args[0]];
          else if (args[0].IsZero()) { token.Text="translateY"; token.Children=[args[2]]; }
        }
        break;
      case "translatex":
        if (n===1) { token.Text="translate"; args[0].TurnLengthOrPercentageIntoNumberIfZero(); }
        break;
      case "translatey": if (n===1) args[0].TurnLengthOrPercentageIntoNumberIfZero(); break;
      case "scale":
        if (n===1) turnPercentIntoNumberIfShorter(args[0]);
        else if (n===3) {
          turnPercentIntoNumberIfShorter(args[0]); turnPercentIntoNumberIfShorter(args[2]);
          if (TokenEqualIgnoringWhitespace(args[0], args[2])) token.Children=[args[0]];
          else if (args[2].IsOne()) { token.Text="scaleX"; token.Children=[args[0]]; }
          else if (args[0].IsOne()) { token.Text="scaleY"; token.Children=[args[2]]; }
        }
        break;
      case "scalex": case "scaley": case "scalez": if (n===1) turnPercentIntoNumberIfShorter(args[0]); break;
      case "rotate": case "rotatex": case "rotatey": case "translatez": case "perspective":
        if (n===1) args[0].TurnLengthIntoNumberIfZero(); break;
      case "rotatez":
        if (n===1) { token.Text="rotate"; args[0].TurnLengthIntoNumberIfZero(); }
        break;
      case "skew":
        if (n===1) args[0].TurnLengthIntoNumberIfZero();
        else if (n===3) { args[0].TurnLengthIntoNumberIfZero(); args[2].TurnLengthIntoNumberIfZero(); if (args[2].IsZero()) token.Children=[args[0]]; }
        break;
      case "skewx":
        if (n===1) { token.Text="skew"; args[0].TurnLengthIntoNumberIfZero(); }
        break;
      case "skewy": if (n===1) args[0].TurnLengthIntoNumberIfZero(); break;
      case "matrix3d": {
        if (n===31) {
          let mask=0;
          for (let i=0;i<16;i++) { const arg=args[i*2]; if (arg.IsZero()) mask|=1<<i; else if (arg.IsOne()) mask|=(1<<16)<<i; }
          const onlyScale=0b1000_0000_0000_0000_0111_1011_1101_1110;
          if ((mask & onlyScale)===onlyScale) {
            const sx=args[0], sy=args[10];
            if (sx.IsOne()&&sy.IsOne()) { token.Text="scaleZ"; token.Children=[args[20]]; }
            else { token.Text="scale3d"; token.Children=[args[0],args[1],args[10],args[11],args[20]]; }
          }
        }
        break;
      }
      case "translate3d":
        if (n===5) {
          args[0].TurnLengthOrPercentageIntoNumberIfZero(); args[2].TurnLengthOrPercentageIntoNumberIfZero(); args[4].TurnLengthIntoNumberIfZero();
          if (args[0].IsZero()&&args[2].IsZero()) { token.Text="translateZ"; token.Children=[args[4]]; }
        }
        break;
      case "scale3d":
        if (n===5) {
          turnPercentIntoNumberIfShorter(args[0]); turnPercentIntoNumberIfShorter(args[2]); turnPercentIntoNumberIfShorter(args[4]);
          if (args[0].IsOne()&&args[2].IsOne()) { token.Text="scaleZ"; token.Children=[args[4]]; }
        }
        break;
      case "rotate3d":
        if (n===7) {
          args[6].TurnLengthIntoNumberIfZero();
          if (args[0].IsOne()&&args[2].IsZero()&&args[4].IsZero()) { token.Text="rotateX"; token.Children=[args[6]]; }
          else if (args[0].IsZero()&&args[2].IsOne()&&args[4].IsZero()) { token.Text="rotateY"; token.Children=[args[6]]; }
        }
        break;
    }
    const kids = token.Children;
    if (kids && kids.length>0) { kids[0].Whitespace &= ~1; kids[kids.length-1].Whitespace &= ~2; }
  }
  return tokens;
}
