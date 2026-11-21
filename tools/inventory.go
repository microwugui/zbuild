// inventory.go 用 Go 官方 go/parser 枚举 esbuild 源码中的全部函数声明，
// 产出机器可读的清单（inventory.json），供 progress.ts 逐函数比对进度。
//
// 用法：go run tools/inventory.go <esbuild 源码根目录> [输出文件]
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type Func struct {
	Pkg   string `json:"pkg"`            // 包名（相对路径，如 internal/js_lexer）
	File  string `json:"file"`           // 相对路径
	Recv  string `json:"recv,omitempty"` // 接收者类型名（已去掉 *），非方法为空
	Name  string `json:"name"`
	Start int    `json:"start"` // 起始行
	End   int    `json:"end"`   // 结束行
	Body  bool   `json:"body"`  // 是否有函数体（声明无体表示汇编/外部实现）
	Test  bool   `json:"test"`  // 是否位于 _test.go
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: go run tools/inventory.go <esbuild-root> [out.json]")
		os.Exit(2)
	}
	root := os.Args[1]
	out := "inventory.json"
	if len(os.Args) > 2 {
		out = os.Args[2]
	}
	out, _ = filepath.Abs(out)

	fset := token.NewFileSet()
	var funcs []Func

	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			base := info.Name()
			if base == ".git" || base == "node_modules" || base == "vendor" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		pkg := filepath.ToSlash(filepath.Dir(rel))
		if pkg == "." {
			pkg = "."
		}
		isTest := strings.HasSuffix(rel, "_test.go")

		f, err := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
		if err != nil {
			fmt.Fprintf(os.Stderr, "parse %s: %v\n", rel, err)
			return nil
		}
		for _, decl := range f.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Name == nil {
				continue
			}
			recv := ""
			if fn.Recv != nil && len(fn.Recv.List) > 0 {
				recv = recvName(fn.Recv.List[0].Type)
			}
			start := fset.Position(fn.Pos()).Line
			end := fset.Position(fn.End()).Line
			funcs = append(funcs, Func{
				Pkg:   pkg,
				File:  rel,
				Recv:  recv,
				Name:  fn.Name.Name,
				Start: start,
				End:   end,
				Body:  fn.Body != nil,
				Test:  isTest,
			})
		}
		return nil
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "walk:", err)
		os.Exit(1)
	}

	sort.Slice(funcs, func(i, j int) bool {
		if funcs[i].File != funcs[j].File {
			return funcs[i].File < funcs[j].File
		}
		return funcs[i].Start < funcs[j].Start
	})

	b, err := json.MarshalIndent(funcs, "", "  ")
	if err != nil {
		fmt.Fprintln(os.Stderr, "marshal:", err)
		os.Exit(1)
	}
	if err := os.WriteFile(out, append(b, '\n'), 0644); err != nil {
		fmt.Fprintln(os.Stderr, "write:", err)
		os.Exit(1)
	}

	nonTest, test := 0, 0
	for _, f := range funcs {
		if f.Test {
			test++
		} else {
			nonTest++
		}
	}
	fmt.Printf("wrote %s: %d funcs (non-test %d, test %d)\n", out, len(funcs), nonTest, test)
}

func recvName(e ast.Expr) string {
	switch t := e.(type) {
	case *ast.StarExpr:
		return recvName(t.X)
	case *ast.Ident:
		return t.Name
	case *ast.IndexExpr: // 泛型接收者
		return recvName(t.X)
	case *ast.IndexListExpr:
		return recvName(t.X)
	}
	return ""
}
