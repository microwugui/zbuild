// callgraph: parse esbuild Go sources, emit (pkg,file,recv,name) -> callee names[] edges as JSON.
// Usage: go run tools/callgraph.go /root/esbuild > graph.json  (stdlib only)
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
)

type Func struct {
	Pkg  string   `json:"pkg"`
	File string   `json:"file"`
	Recv string   `json:"recv"`
	Name string   `json:"name"`
	Calls []string `json:"calls"`
}

func pkgOf(root, path string) string {
	rel, _ := filepath.Rel(root, filepath.Dir(path))
	return filepath.ToSlash(rel)
}

func main() {
	root := os.Args[1]
	fset := token.NewFileSet()
	var funcs []Func
	filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") || strings.Contains(path, "/tmp") || strings.Contains(path, "/vendor") {
			return nil
		}
		f, e := parser.ParseFile(fset, path, nil, 0)
		if e != nil { return nil }
		rel, _ := filepath.Rel(root, path)
		pkg := pkgOf(root, path)
		for _, decl := range f.Decls {
			fd, ok := decl.(*ast.FuncDecl)
			if !ok || fd.Body == nil { continue }
			name := fd.Name.Name
			recv := ""
			if fd.Recv != nil && len(fd.Recv.List) > 0 {
				t := fd.Recv.List[0].Type
				switch x := t.(type) {
				case *ast.StarExpr:
					if id, ok := x.X.(*ast.Ident); ok { recv = id.Name }
				case *ast.Ident: recv = x.Name
				}
			}
			var calls []string
			seen := map[string]bool{}
			ast.Inspect(fd.Body, func(n ast.Node) bool {
				var id *ast.Ident
				switch x := n.(type) {
				case *ast.CallExpr:
					switch f := x.Fun.(type) {
					case *ast.Ident: id = f
					case *ast.SelectorExpr: id = f.Sel
					}
				}
				if id != nil && !seen[id.Name] { seen[id.Name] = true; calls = append(calls, id.Name) }
				return true
			})
			funcs = append(funcs, Func{Pkg: pkg, File: filepath.ToSlash(rel), Recv: recv, Name: name, Calls: calls})
		}
		return nil
	})
	b, _ := json.Marshal(funcs)
	fmt.Println(string(b))
}
