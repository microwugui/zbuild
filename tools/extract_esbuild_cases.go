// extract_esbuild_cases.go 从 esbuild 自带 Go 测试里自动提取输入源码。
// 纯 AST 结构化提取；打印候选总数与各类跳过原因，便于审计覆盖率。
//
// 分类规则：
//   - js_lexer_test.go 的输入是 token 片段（`$`、`0_7`），不是完整程序，
//     单独放 esbuild-cases-lex/，留给将来的 lexer 级 oracle
//   - 调用 expectParseError / expectScanError 的输入是「故意非法」的，
//     记为 expect-error，不进 cli 语料（将来用于比对错误信息）
//   - 其余进 esbuild-cases/，作为 transform 语料
//
// 用法: cd /root/esbuild && go run ./tmpextract <输出根目录>
package main

import (
	"crypto/sha256"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

var testFiles = []string{
	"internal/js_parser/js_parser_test.go",
	"internal/js_lexer/js_lexer_test.go",
	"internal/js_printer/js_printer_test.go",
	"internal/css_parser/css_parser_test.go",
}

const maxSize = 64 * 1024

type stats struct {
	candidates, nonLiteral, dup, tooLong, expectError, kept int
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: go run ./tmpextract <outroot>")
		os.Exit(2)
	}
	outRoot := os.Args[1]

	seen := map[[32]byte]bool{}
	type item struct {
		dir, name string
		data      []byte
	}
	var items []item

	fset := token.NewFileSet()
	for _, file := range testFiles {
		f, err := parser.ParseFile(fset, file, nil, 0)
		if err != nil {
			fmt.Fprintf(os.Stderr, "skip %s: %v\n", file, err)
			continue
		}
		base := strings.TrimSuffix(filepath.Base(file), ".go")
		outSub := "esbuild-cases"
		switch base {
		case "js_lexer_test":
			outSub = "esbuild-cases-lex"
		case "css_parser_test":
			outSub = "esbuild-cases-css" // CSS 输入不能用 --loader=js 跑
		}

		// 第一遍：找到每个本地函数的 contents 参数下标
		contentsArg := map[string]int{}
		for _, decl := range f.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Type == nil || fn.Type.Params == nil {
				continue
			}
			idx := 0
			for _, field := range fn.Type.Params.List {
				if len(field.Names) == 0 {
					idx++
					continue
				}
				for _, name := range field.Names {
					if name.Name == "contents" {
						contentsArg[fn.Name.Name] = idx
					}
					idx++
				}
			}
		}

		// 第二遍：按调用点提取
		st := stats{}
		isLexerFile := base == "js_lexer_test"
		ast.Inspect(f, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			ident, ok := call.Fun.(*ast.Ident)
			if !ok {
				return true
			}
			idx, ok := contentsArg[ident.Name]
			if !ok {
				return true
			}
			st.candidates++

			// js_lexer_test 的 expectLexerError/expectLexerErrorString 是**唯一**的错误路径语料：
			// 单独放进 esbuild-cases-lex-err（供 lexer token oracle 比报错 kind + 原文），不丢。
			if strings.Contains(ident.Name, "Error") {
				if !isLexerFile {
					st.expectError++
					return true
				}
				if idx >= len(call.Args) {
					st.expectError++
					return true
				}
				lit, ok := call.Args[idx].(*ast.BasicLit)
				if !ok || lit.Kind != token.STRING {
					st.expectError++
					return true
				}
				s, err := strconv.Unquote(lit.Value)
				if err != nil || len(s) == 0 || len(s) > maxSize {
					st.expectError++
					return true
				}
				sum := sha256.Sum256([]byte(s))
				if seen[sum] {
					st.dup++
					return true
				}
				seen[sum] = true
				st.kept++
				items = append(items, item{dir: "esbuild-cases-lex-err", name: fmt.Sprintf("%x", sum[:6]), data: []byte(s)})
				return true
			}
			if idx >= len(call.Args) {
				st.nonLiteral++
				return true
			}
			lit, ok := call.Args[idx].(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING {
				st.nonLiteral++
				return true
			}
			s, err := strconv.Unquote(lit.Value)
			if err != nil || len(s) == 0 {
				st.nonLiteral++
				return true
			}
			if len(s) > maxSize {
				st.tooLong++
				return true
			}
			sum := sha256.Sum256([]byte(s))
			if seen[sum] {
				st.dup++
				return true
			}
			seen[sum] = true
			st.kept++
			items = append(items, item{dir: outSub, name: fmt.Sprintf("%x", sum[:6]), data: []byte(s)})
			return true
		})
		fmt.Printf("%-40s candidates=%-4d kept=%-4d expect-error=%-3d non-literal=%-3d dup=%-3d too-long=%d\n",
			base, st.candidates, st.kept, st.expectError, st.nonLiteral, st.dup, st.tooLong)
	}

	sort.Slice(items, func(i, j int) bool {
		if items[i].dir != items[j].dir {
			return items[i].dir < items[j].dir
		}
		return items[i].name < items[j].name
	})
	for _, it := range items {
		p := filepath.Join(outRoot, it.dir)
		if err := os.MkdirAll(p, 0755); err != nil {
			panic(err)
		}
		if err := os.WriteFile(filepath.Join(p, it.name+".js"), it.data, 0644); err != nil {
			panic(err)
		}
	}
	fmt.Printf("total kept=%d\n", len(items))
}
