// 1:1 移植自 esbuild internal/css_parser/css_decls_composes.go（v0.28.2）。第 135 批。
import { Token, T } from "../css_ast/css_ast.ts";
import { Range, Loc } from "../logger/logger.ts";
import { CSSParser } from "./css_parser.ts";
import { MsgID_CSS_CSSSyntaxError } from "../logger/msg_ids.ts";
import { AddID } from "../logger/logger.ts";
import { ImportKind } from "../ast/ast.ts";

/** Go: type composesContext (css_decls_composes.go:12) */
export interface composesContext { parentRefs: any[]; parentRange: Range; problemRange: Range; }
export interface Composes { Names: any[]; ImportedNames: any[]; Properties: Map<string, number> | null; }

/** Go: func (p *parser) handleComposesPragma(context composesContext, tokens []css_ast.Token) (css_decls_composes.go:19) */
export function handleComposesPragma(p: CSSParser, context: composesContext, tokens: Token[]): void {
  const names: { loc: number; text: string }[] = [];
  let fromGlobal = false;
  for (let i=0;i<tokens.length;i++) {
    const t=tokens[i];
    if (t.Kind===T.TIdent) {
      if (t.Text.toLowerCase()==="from" && i+2===tokens.length) {
        const last=tokens[i+1];
        if (last.Kind===T.TString||last.Kind===37 /* TURL */) {
          let importRecordIndex=0;
          if (last.Kind===T.TString) {
            importRecordIndex=p.importRecords.length;
            const rec: any = {}; rec.Kind=ImportKind.ImportComposesFrom;
            rec.Path = { Text: last.Text };
            rec.Range=p.source.RangeOfString(new Loc(last.Loc));
            p.importRecords.push(rec);
          } else importRecordIndex=last.PayloadIndex;
          for (const parentRef of context.parentRefs) {
            const composes=p.composes.get(parentRef) ?? { Names:[], ImportedNames:[], Properties:null };
            for (const name of names) composes.ImportedNames.push({ ImportRecordIndex:importRecordIndex, Alias:name.text, AliasLoc:name.loc });
            p.composes.set(parentRef, composes);
          }
          return;
        }
        if (last.Kind===T.TIdent) {
          if (last.Text.toLowerCase()==="global") { fromGlobal=true; break; }
          AddID(p.log, MsgID_CSS_CSSSyntaxError, 1, p.tracker, new Range(new Loc(t.Loc),0),
            `"composes" declaration uses invalid location ${JSON.stringify(last.Text)}`);
          p.prevError=new Loc(t.Loc); return;
        }
      }
      names.push({ loc:t.Loc, text:t.Text }); continue;
    }
    const text = [37 /* TURL */,3 /* TBadURL */,36 /* TString */,2 /* TUnterminatedString */].includes(t.Kind)
      ? `Unexpected ${t.Text}` : `Unexpected ${JSON.stringify(t.Text)}`;
    AddID(p.log, MsgID_CSS_CSSSyntaxError, 1, p.tracker, new Range(new Loc(t.Loc),0), text);
    p.prevError=new Loc(t.Loc); return;
  }
  const old=p.makeLocalSymbols;
  if (fromGlobal) p.makeLocalSymbols=false;
  for (const parentRef of context.parentRefs) {
    const composes=p.composes.get(parentRef) ?? { Names:[], ImportedNames:[], Properties:null };
    for (const name of names) composes.Names.push(p.symbolForName(name.loc,name.text));
    p.composes.set(parentRef, composes);
  }
  p.makeLocalSymbols=old;
}
