// gen_helpers_path_fixture.go 生成 helpers/path.go 的 Go 实测基准。
//
// 用法：
//   cd /root/esbuild && go run ./tmpgenpath > /root/port/testdata/helpers-path.json
package main

import (
	"encoding/json"
	"os"

	"github.com/evanw/esbuild/internal/helpers"
)

type out struct {
	In  string `json:"in"`
	Out bool   `json:"out"`
}

func main() {
	inputs := []string{
		"",
		"a",
		"a.js",
		"node_modules",
		"/node_modules",
		"a/node_modules",
		"a/node_modules/b",
		"a/node_modules/b/c",
		"node_modules/a/node_modules/b",
		`a\node_modules\b`,
		`C:\x\node_modules\y`,
		`C:\node_modules`,
		"a/node_modulesx/b",
		"node_modules_foo/bar",
		"foo/node_modules/",
		"foo/node_modules//bar",
		"./node_modules/a.js",
		"/a/b/node_modules/c/d/e.js",
		"http://example.com/node_modules/a.js",
	}
	res := make([]out, 0, len(inputs))
	for _, in := range inputs {
		res = append(res, out{In: in, Out: helpers.IsInsideNodeModules(in)})
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", " ")
	if err := enc.Encode(res); err != nil {
		panic(err)
	}
}
