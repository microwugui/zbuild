// gen_js_parser_json_fixture.go 生成 json_parser（js_parser 包内 JSON 子集）
// 的 Go 实测基准：ParseDefineExpr / ParseJSON / isValidJSON 的结果。
//
// 口径：
//   - 每例先跑 ParseDefineExpr(text)（define 文本 → config.DefineExpr + js_ast.E）；
//   - 再跑 ParseJSON(IsForDefine: true)（记录诊断文案与 note 文案）；
//   - 可打印的值（constant 或 compound）用 js_printer.Print 打成字节，
//     与 TS 侧同构（AST{Parts:[{Stmts:[SExpr]}]} + NoOpRenamer + FormatESModule）；
//   - ParseJSON 另跑一次 IsForDefine: false，覆盖 TBigIntegerLiteral 的 Unexpected 分支。
//
// 用法：
//   cd /root/esbuild && go run ./tmpgenjson > /root/port/testdata/js_parser/json.json
//   sha256sum /root/port/testdata/js_parser/json.json   # 记进 PLAN（期望值来源 = Go 实测）
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/evanw/esbuild/internal/ast"
	"github.com/evanw/esbuild/internal/config"
	"github.com/evanw/esbuild/internal/js_ast"
	"github.com/evanw/esbuild/internal/js_parser"
	"github.com/evanw/esbuild/internal/js_printer"
	"github.com/evanw/esbuild/internal/logger"
	"github.com/evanw/esbuild/internal/renamer"
)

type msgOut struct {
	Kind  int      `json:"kind"`
	Text  string   `json:"text"`
	Notes []string `json:"notes,omitempty"`
}

type caseOut struct {
	Text string `json:"text"`

	// ParseDefineExpr
	Parts    []string `json:"parts,omitempty"`
	Constant string   `json:"constant,omitempty"` // ENull/EBoolean/EString/ENumber/EBigInt 的类型名
	Compound bool     `json:"compound,omitempty"`
	ValueOut string   `json:"valueOut,omitempty"` // 可打印值的 JS 字节
	ValueOK  bool     `json:"valueOk,omitempty"`

	// ParseJSON(IsForDefine: true)
	JSONOK    bool     `json:"jsonOk"`
	JSONOut   string   `json:"jsonOut,omitempty"`
	JSONOutOK bool     `json:"jsonOutOk,omitempty"`
	JSONMsgs  []msgOut `json:"jsonMsgs,omitempty"`
	NotDefineOK bool    `json:"notDefineOk"`
	NotDefineMs []msgOut `json:"notDefineMsgs,omitempty"`
}

func typeName(data js_ast.E) string {
	switch data.(type) {
	case *js_ast.ENull:
		return "ENull"
	case *js_ast.EBoolean:
		return "EBoolean"
	case *js_ast.EString:
		return "EString"
	case *js_ast.ENumber:
		return "ENumber"
	case *js_ast.EBigInt:
		return "EBigInt"
	case *js_ast.EArray:
		return "EArray"
	case *js_ast.EObject:
		return "EObject"
	}
	return fmt.Sprintf("%T", data)
}

func printValue(data js_ast.E) (string, bool) {
	tree := js_ast.AST{
		Parts: []js_ast.Part{{Stmts: []js_ast.Stmt{{
			Data: &js_ast.SExpr{Value: js_ast.Expr{Data: data}},
		}}}},
	}
	symbols := ast.NewSymbolMap(1)
	r := renamer.NewNoOpRenamer(symbols)
	return string(js_printer.Print(tree, symbols, r, js_printer.Options{OutputFormat: config.FormatESModule}).JS), true
}

func collectMsgs(log logger.Log) []msgOut {
	out := []msgOut{}
	for _, msg := range log.Done() {
		m := msgOut{Kind: int(msg.Kind), Text: msg.Data.Text}
		for _, note := range msg.Notes {
			m.Notes = append(m.Notes, note.Text)
		}
		out = append(out, m)
	}
	return out
}

func runParseJSON(text string, isForDefine bool) (js_ast.Expr, bool, []msgOut) {
	log := logger.NewDeferLog(logger.DeferLogNoVerboseOrDebug, nil)
	expr, ok := js_parser.ParseJSON(log, logger.Source{Contents: text}, js_parser.JSONOptions{
		IsForDefine: isForDefine,
	})
	return expr, ok, collectMsgs(log)
}

func main() {
	texts := []string{
		"",
		" ",
		"null",
		"true",
		"false",
		"0",
		"1",
		"-1",
		"1.5",
		"-1.5",
		"1e3",
		"1E+3",
		"0.5",
		`"abc"`,
		`"a\"b"`,
		`"\u0041"`,
		`"\n"`,
		`"日"`,
		"[]",
		"[1,2,3]",
		"[1,[2,{}]]",
		"[1,]",
		"[,]",
		"{}",
		`{"a":1}`,
		`{"a":1,"b":[true,null]}`,
		`{"a":1,"a":2}`,
		`{"a":1,}`,
		`{"__proto__":1}`,
		`{"a b":1}`,
		`{a:1}`,
		`{"a":}`,
		`{"a" 1}`,
		"{1:2}",
		"'x'",
		"1n",
		"[1n]",
		"//c\n1",
		"/*c*/1",
		"- 1",
		"[1 2]",
		"tru",
		`"unterminated`,
		"x",
		"1 2",
		// property chain（ParseDefineExpr 的另一条分支）
		"a",
		"a.b",
		"a.b.c",
		"null.x",
		"this.x",
		"import.meta",
		"import.meta.url",
		"import.x",
		"if.x",
		"1.a",
		"a..b",
	}

	out := []caseOut{}
	for _, text := range texts {
		c := caseOut{Text: text}

		de, value := js_parser.ParseDefineExpr(text)
		c.Parts = de.Parts
		if value != nil {
			c.Compound = true
			c.ValueOut, c.ValueOK = printValue(value)
		} else if de.Constant != nil {
			c.Constant = typeName(de.Constant)
			c.ValueOut, c.ValueOK = printValue(de.Constant)
		}

		expr, ok, msgs := runParseJSON(text, true)
		c.JSONOK = ok
		c.JSONMsgs = msgs
		if ok {
			if expr.Data != nil {
				c.JSONOut, c.JSONOutOK = printValue(expr.Data)
			}
		}

		_, ok2, msgs2 := runParseJSON(text, false)
		c.NotDefineOK = ok2
		c.NotDefineMs = msgs2

		out = append(out, c)
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", " ")
	if err := enc.Encode(out); err != nil {
		panic(err)
	}
}
