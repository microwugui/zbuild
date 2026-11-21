// 第 154 批：linker 助手簇 5 函数，Go 探针 10 例逐字节。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as ast from "../ast/ast.ts";
import * as js_ast from "../js_ast/js_ast.ts";
import { Msg, MsgData, MsgLocation } from "../logger/logger.ts";
import { InputFile, JSRepr } from "../graph/input.ts";
import { LinkerGraph, LinkerFile } from "../graph/graph.ts";
import { ExportData } from "../graph/input.ts";
import { NewDeferLog, DeferLogKind } from "../logger/logger.ts";
import { Loc } from "../logger/logger.ts";
import { linkerContext, chunkInfo } from "./linker.ts";
import { enforceNoCyclicChunkImports, preventExportsFromBeingRenamed, maybeCorrectObviousTypo,
  advanceImportTracker, recoverInternalError } from "./linker.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../testdata/linker-helpers-go.json", import.meta.url)));
const SHA = "c2e214684e5e31a30a084bfa322a32d11630093dbf614a5a6d4bee4cf45d2732";
const ref = (s: number, i: number): ast.Ref => new ast.Ref(s, i);
const dumpMsgs = (log: any): string[] => log.Done().map((m: any) => m.Data.Text);

const ROWS: { fn: string; arg: any; run: () => any }[] = [];
// enforceNoCyclicChunkImports x3
for (const cs of ["acyclic", "cycle", "dynamic-cycle"]) {
  ROWS.push({ fn: "enforceNoCyclicChunkImports", arg: { case: cs }, run: () => {
    const c = new linkerContext(); c.log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, new Map());
    const mkChunk = (to: number, kind: number): chunkInfo => { const ch = new chunkInfo(); ch.crossChunkImports = [{ chunkIndex: to, importKind: kind }]; return ch; };
    if (cs === "acyclic") c.chunks = [mkChunk(1, ast.ImportKind.ImportStmt), new chunkInfo()];
    else if (cs === "cycle") c.chunks = [mkChunk(1, ast.ImportKind.ImportStmt), mkChunk(0, ast.ImportKind.ImportStmt)];
    else c.chunks = [mkChunk(1, ast.ImportKind.ImportDynamic), mkChunk(0, ast.ImportKind.ImportDynamic)];
    enforceNoCyclicChunkImports(c);
    return dumpMsgs(c.log);
  }});
}
// preventExportsFromBeingRenamed x2
for (const cs of ["module", "script"]) {
  ROWS.push({ fn: "preventExportsFromBeingRenamed", arg: { case: cs }, run: () => {
    const c = new linkerContext(); c.graph = new LinkerGraph(); c.graph.Files = [new LinkerFile()];
    const sm = ast.NewSymbolMap(1);
    const s0 = new ast.Symbol(); s0.OriginalName = "foo"; s0.Link = ast.InvalidRef;
    const s1 = new ast.Symbol(); s1.OriginalName = "bar"; s1.Link = ast.InvalidRef;
    sm.SymbolsForSource[0] = [s0, s1]; c.graph.Symbols = sm;
    const ms = new js_ast.Scope(); ms.Members = new Map();
    const m0 = new js_ast.ScopeMember(); m0.Ref = ref(0, 0); ms.Members.set("foo", m0);
    const m1 = new js_ast.ScopeMember(); m1.Ref = ref(0, 1); ms.Members.set("bar", m1);
    let stmts: js_ast.Stmt[] = [];
    if (cs === "module") { const sl = new js_ast.SLocal(); sl.IsExport = true; const d = new js_ast.Decl(); const b = new js_ast.Binding(); const bi = new js_ast.BIdentifier(); bi.Ref = ref(0, 0); b.Data = bi; d.Binding = b; sl.Decls = [d]; stmts = [new js_ast.Stmt()]; stmts[0].Data = sl; }
    const repr = new JSRepr(); repr.AST.ModuleScope = ms; const p = new js_ast.Part(); p.Stmts = stmts; repr.AST.Parts = [p];
    c.graph.Files[0].InputFile.Repr = repr;
    preventExportsFromBeingRenamed(c, 0);
    return { flags: [sm.SymbolsForSource[0][0].Flags, sm.SymbolsForSource[0][1].Flags], kinds: [sm.SymbolsForSource[0][0].Kind, sm.SymbolsForSource[0][1].Kind] };
  }});
}
// maybeCorrectObviousTypo
ROWS.push({ fn: "maybeCorrectObviousTypo", arg: { typo: "expot" }, run: () => {
  const c = new linkerContext(); c.graph = new LinkerGraph(); c.graph.Files = [new LinkerFile()];
  const repr = new JSRepr(); repr.Meta.ResolvedExports = new Map();
  const ed = new ExportData(); ed.SourceIndex = 0; ed.NameLoc = 0; ed.Ref = ref(0, 0);
  repr.Meta.ResolvedExports.set("export", ed); c.graph.Files[0].InputFile.Repr = repr;
  const msg = new Msg(); msg.Data.Location = new MsgLocation();
  maybeCorrectObviousTypo(c, repr, "expot", msg);
  return { suggestion: msg.Data.Location.Suggestion, notes: msg.Notes.map((n: any) => n.Text) };
}});
// advanceImportTracker x3
for (const cs of ["external", "found", "noMatch"]) {
  ROWS.push({ fn: "advanceImportTracker", arg: { case: cs }, run: () => {
    const c = new linkerContext(); c.graph = new LinkerGraph(); c.graph.Files = [new LinkerFile(), new LinkerFile()];
    const file0 = new JSRepr(); file0.AST.ImportRecords = [new js_ast.ImportRecord()]; file0.AST.NamedImports = new Map();
    const ni = new js_ast.NamedImport(); ni.Alias = cs === "noMatch" ? "missing" : "foo"; ni.ImportRecordIndex = 0;
    file0.AST.NamedImports.set("0:5", ni); c.graph.Files[0].InputFile.Repr = file0;
    const file1 = new JSRepr(); file1.AST.ExportsKind = js_ast.ExportsKind.ExportsESM; file1.AST.UsesExportsRef = true;
    file1.Meta.ResolvedExports = new Map();
    const ed = new ExportData(); ed.SourceIndex = 1; ed.Ref = ref(1, 9); ed.NameLoc = 10;
    file1.Meta.ResolvedExports.set("foo", ed); c.graph.Files[1].InputFile.Repr = file1;
    file0.AST.ImportRecords[0].SourceIndex = cs === "external" ? (undefined as any) : 1;
    const [tr, st, data] = advanceImportTracker(c, { sourceIndex: 0, nameLoc: 0, importRef: ref(0, 5) });
    return { status: st, src: tr.sourceIndex, inner: tr.importRef.InnerIndex, data: data.length };
  }});
}
// recoverInternalError x3
for (const cs of ["nopanic", "panic-runtime", "panic-source"]) {
  ROWS.push({ fn: "recoverInternalError", arg: { case: cs }, run: () => {
    const c = new linkerContext(); c.log = NewDeferLog(DeferLogKind.DeferLogNoVerboseOrDebug, new Map());
    let doneCount = 0; const wg = { done: () => { doneCount++; } };
    if (cs === "nopanic") recoverInternalError(c, wg, 0);
    else if (cs === "panic-runtime") recoverInternalError(c, wg, 0, "boom");
    else {
      c.graph = new LinkerGraph(); c.graph.Files = [new LinkerFile(), new LinkerFile()];
      (c.graph.Files[1].InputFile.Source as any).PrettyPaths = { Rel: "src/a.js", Abs: "/p/src/a.js" };
      recoverInternalError(c, wg, 1, "bad");
    }
    return dumpMsgs(c.log);
  }});
}

test("linker-helpers fixture sha256 + 10 例逐字节等于 Go", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA);
  const rows: any[] = JSON.parse(new TextDecoder().decode(bytes));
  assert.equal(rows.length, ROWS.length);
  for (let i = 0; i < rows.length; i++) {
    assert.equal(ROWS[i].fn, rows[i].fn);
    assert.deepEqual(ROWS[i].arg, rows[i].arg, `arg@${i}`);
    assert.deepEqual(ROWS[i].run(), rows[i].out, `${rows[i].fn} ${JSON.stringify(rows[i].arg)} mismatch`);
  }
});
