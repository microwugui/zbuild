# parseStmt 控制流程图

来源：`src/internal/js_parser/js_parser.ts:4760-5847`（`parseStmt(opts: parseStmtOpts): js_ast.Stmt`）。
语义对应 Go：`internal/js_parser/js_parser.go:7108` 起。以下行号已用 grep 核对（2026-11-21）。

## 主流程（入口 → switch 分派 → 汇合）

```mermaid
flowchart TD
    A["parseStmt(opts)<br/>:4760"] --> B["loc = lexer.Loc()<br/>lexer.CommentsBeforeToken = []<br/>:4761-4765"]
    B --> C{"tokenIs(TEnum)?<br/>:4769"}
    C -->|是| D["若非 ts.Parse → Unexpected()<br/>return parseTypeScriptEnumStmt()<br/>:4770-4772"]
    C -->|否| E["switch (lexer.Token)<br/>:4774"]

    E --> F1["TAt<br/>@装饰器/class"]
    E --> F2["TExport<br/>export ..."]
    E --> F3["TImport<br/>import ..."]
    E --> G1["TSemicolon → 空语句"]
    E --> G2["TOpenBrace → SBlock"]
    E --> G3["TVar / TConst → SLocal"]
    E --> G4["TFunction → parseFnStmt"]
    E --> G5["TClass → parseClassStmt"]
    E --> G6["TIf → SIf (递归 Yes/No)"]
    E --> G7["TReturn → SReturn"]
    E --> G8["TDebugger → 共享节点"]
    E --> G9["TBreak / TContinue → 带 label"]
    E --> G10["TThrow → SThrow"]
    E --> G11["TDo → SDoWhile"]
    E --> G12["TWhile → SWhile"]
    E --> G13["TWith → SWith (非严格)"]
    E --> G14["TSwitch → SSwitch"]
    E --> G15["TTry → STry"]
    E --> G16["TFor → for/for-in/for-of"]
    E --> G17["TIdentifier<br/>namespace/module 消歧 + parseExprOrLetOrUsingStmt<br/>(let/using/await/async)<br/>:5786-5820"]
    E --> H["default (其他 token)"]
    E --> I["其他 case: TDot/TOpenParen/<br/>数字/字符串/模板 → fallthrough 表达式"]

    G1 --> X
    G2 --> X
    G3 --> X
    G4 --> X
    G5 --> X
    G6 --> X
    G7 --> X
    G8 --> X
    G9 --> X
    G10 --> X
    G11 --> X
    G12 --> X
    G13 --> X
    G14 --> X
    G15 --> X
    G16 --> X
    G17 --> X
    I --> X

    H --> J["value = parseExpr(LLowest)<br/>:5838"]
    J --> K{"value 是 EIdentifier<br/>且 token==TColon?<br/>:5841"}
    K -->|是| L["标签语句 SLabel<br/>push/pop label scope<br/>递归 parseStmt(lexicalDecl=3)<br/>:5842-5844"]
    K -->|否| M["ExpectOrInsertSemicolon()<br/>return SExpr(value)<br/>:5846-5847"]
    L --> X
    M --> X
    F1 --> X
    F2 --> X
    F3 --> X
    X["return Stmt"]
```

## 三个大分支的内部结构

### TAt（`@` 装饰器）`:4775-4813`
```mermaid
flowchart TD
    a["parseDecorators()"] --> b{"tokenIs(TClass)?"}
    b -->|是| c["return parseClassStmt(loc,opts,decorators)"]
    b -->|否| d{"tokenIs(TExport)?"}
    d -->|否| e["Unexpected()"]
    d -->|是| f["Next(); 可选 default"]
    f --> g{"tokenIs(TClass)?"}
    g -->|否| e
    g -->|是| h{"有 default?"}
    h -->|否| i["return parseClassStmt(exportOpts)"]
    h -->|是| j["parseClassStmt(isNameOptional) → 生成 default 名<br/>return SExportDefault"]
```

### TExport（`:4814-5056`）—— 结构最深的分支
```mermaid
flowchart TD
    a["校验 moduleScope/namespaceScope<br/>标记 isFileConsideredESM<br/>Next()"] --> b{"tokenIs(TAt)?"}
    b -->|是| aa["return parseStmt(isExport=true)"]
    b -->|否| c{"tokenIs(TEnum)?"}
    c -->|是| aa
    c -->|否| d["switch(token)"]
    d --> d1["Class/Const/Function/Var<br/>→ parseStmt(isExport=true)"]
    d --> d2["Identifier:<br/>let → parseStmt<br/>async function → parseFnStmt<br/>namespace/module → TS namespace stmt"]
    d --> d3["Default:<br/>async function/class/@ → SExportDefault<br/>function/class/* → SExportDefault<br/>as → SExportFrom"]
    d --> d4["Asterisk → SExportStar<br/>OpenBrace → SExportClause / SExportFrom"]
    d1 --> z["return"]
    d2 --> z
    d3 --> z
    d4 --> z
```

### TImport（`:5057-5264`）
```mermaid
flowchart TD
    a["若非 ( 或 . → 普通表达式语句<br/>return SExpr(parseExpr)"] --> b["Next(); switch(token)"]
    b --> b1["( 或 . : import() / import.meta<br/>→ SExpr"]
    b --> b2["StringLiteral / NoSubstTemplate<br/>→ SImport (side-effect)"]
    b --> b3["Asterisk / OpenBrace<br/>→ import 子句解析"]
    b --> b4["Identifier:<br/>type/typeof/TS import-equals<br/>→ parseTypeScriptImportEqualsStmt"]
```

### TFor（`:5602-5785`）—— 三路消歧
```mermaid
flowchart TD
    a["Next(); 可选 await"] --> b["switch(token)"]
    b --> b1["Var/Const/let → 声明式 for"]
    b --> b2["Semicolon → 经典 for(;;)"]
    b --> b3["default → 表达式"]
    b1 --> c{"of / await?"}
    b3 --> c
    c -->|of| d["SForOf"]
    c -->|in| e["SForIn"]
    c -->|都不是| f["SFor (经典三段)"]
```

> 注：TFor 子 switch 的 case 在 `:5632`(Var) / `:5642`(Const) / `:5651`(Semicolon)，default 表达式分支在其后。

## 关键观察（性能视角）

- `parseStmt` 是**一个约 1090 行的大函数**，主体是对 `lexer.Token` 的巨型 switch（20+ case），其中 export/import/for 三个 case 各自又嵌套子 switch 与多次 `parseStmt` 递归。
- 递归再进入 `parseStmt` 的入口有 6+ 处（export 转发、if 的 yes/no、label 体、block 内语句等），这是 inclusive% 远超 100% 的原因。
- 多数 case 的落点是「消费 token → 调 `parseExpr`/`parseFnStmt`/`parseClassStmt` → 包一个 `S*` AST 节点 → return」。
- default 与所有「非语句开头」token 汇合到表达式语句路径（`parseExpr(LLowest)` + 可能的标签消歧 + 分号）。
- `TIdentifier` case 先做 namespace/module 前瞻消歧，再调 `parseExprOrLetOrUsingStmt`（:5810）；返回 null 才 fallthrough 到表达式语句。
