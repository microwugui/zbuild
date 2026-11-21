// tmpgenparseprint —— M1 常驻差分通道的 Go 参考端（保留不删）
//
// 协议：
//   stdin  = JSON 数组 [{"id": "...", "path": "...", "mode": "js|ts|minify"}]
//   stdout = JSON 数组 [{"id","sourceSha256","ok","error","outBase64","outBytes","outSha256"}]
//
// mode（第 21 轮新增；第 28 轮加 target 降级档）：
//   "" / "js" = M1 默认口径（JS-only、target=esnext、无 minify）
//   "ts"       = ts.Parse=1 + jsx.Parse=1
//   "minify"   = MinifyWhitespace + MinifySyntax（parser 与 printer 同时开）
//   "es2015" / "es2016" / "es2017" = target=<N>（UnsupportedJSFeatures + OriginalTargetEnv，
//              给 I/J 批的 lower* 提供触发通道；位掩码由 compat.UnsupportedJSFeatures 现算）
//   js 模式的 stdout 与第 20 轮逐字节相同（入参多一个 mode 字段不影响输出）。
//
// 参照实现严格是 js_parser.Parse + js_printer.Print，**不经 linker**；
// 与 tmpbaseline16 的临时探针口径一致（PLAN.md「第 16 次推进」§2），
// 但这里落成常驻生成器，由 tools/m1.ts 每次 --check 重新运行并与
// tools/parseprint.json 里钉死的 aggregate sha256 比对（防自证循环）。
//
// 用法（由 tools/m1.ts 调用）：
//   cd /root/esbuild && go run ./tmpgenparseprint < corpus.json > out.json
package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"

	"github.com/evanw/esbuild/internal/ast"
	"github.com/evanw/esbuild/internal/compat"
	"github.com/evanw/esbuild/internal/config"
	"github.com/evanw/esbuild/internal/js_parser"
	"github.com/evanw/esbuild/internal/js_printer"
	"github.com/evanw/esbuild/internal/logger"
	"github.com/evanw/esbuild/internal/renamer"
)

type inCase struct {
	ID   string `json:"id"`
	Path string `json:"path"`
	// "" / "js" = M1 默认口径；"ts" = ts.Parse=1；"minify" = MinifyWhitespace+MinifySyntax
	Mode string `json:"mode"`
}

type outCase struct {
	ID           string `json:"id"`
	SourceSha256 string `json:"sourceSha256"`
	OK           bool   `json:"ok"`
	Error        string `json:"error,omitempty"`
	OutBase64    string `json:"outBase64,omitempty"`
	OutBytes     int    `json:"outBytes"`
	OutSha256    string `json:"outSha256,omitempty"`
}

func run(contents string, mode string) ([]byte, bool) {
	parseOptions := config.Options{}
	printOptions := js_printer.Options{OutputFormat: config.FormatESModule}
	switch mode {
	case "", "js":
		// M1 默认口径（第 16–20 轮）
	case "ts":
		parseOptions.TS = config.TSOptions{Parse: true}
		// 不开 JSX 的话 235 个 JSX 例会在 Go 侧 panic（Parse→ok=false），ts 通道就白丢掉一截语料；
		// TS 侧的 Options 默认 jsx.Parse=true，两边必须同口径。
		parseOptions.JSX.Parse = true
	case "minify":
		parseOptions.MinifyWhitespace = true
		parseOptions.MinifySyntax = true
		printOptions.MinifyWhitespace = true
		printOptions.MinifySyntax = true
	case "es2015", "es2016", "es2017":
		year := 2015
		if mode == "es2016" {
			year = 2016
		} else if mode == "es2017" {
			year = 2017
		}
		parseOptions.UnsupportedJSFeatures = compat.UnsupportedJSFeatures(map[compat.Engine]compat.Semver{
			compat.ES: {Parts: []int{year}},
		})
		parseOptions.OriginalTargetEnv = mode
	default:
		panic("unknown mode: " + mode)
	}

	log := logger.NewDeferLog(logger.DeferLogNoVerboseOrDebug, nil)
	source := logger.Source{Index: 0, KeyPath: logger.Path{Text: "<stdin>"}, Contents: contents}
	tree, ok := js_parser.Parse(log, source, js_parser.OptionsFromConfig(&parseOptions))
	if !ok {
		return nil, false
	}
	symbols := ast.NewSymbolMap(1)
	symbols.SymbolsForSource[0] = tree.Symbols
	r := renamer.NewNoOpRenamer(symbols)
	js := js_printer.Print(tree, symbols, r, printOptions).JS
	return []byte(js), true
}

func sha(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func main() {
	var in []inCase
	if err := json.NewDecoder(os.Stdin).Decode(&in); err != nil {
		panic(err)
	}
	out := make([]outCase, 0, len(in))
	for _, c := range in {
		contents, err := os.ReadFile(c.Path)
		if err != nil {
			out = append(out, outCase{ID: c.ID, Error: "read-error"})
			continue
		}
		js, ok := run(string(contents), c.Mode)
		if !ok {
			out = append(out, outCase{ID: c.ID, SourceSha256: sha(contents), Error: "parse-error"})
			continue
		}
		out = append(out, outCase{
			ID:           c.ID,
			SourceSha256: sha(contents),
			OK:           true,
			OutBase64:    base64.StdEncoding.EncodeToString(js),
			OutBytes:     len(js),
			OutSha256:    sha(js),
		})
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(out); err != nil {
		panic(err)
	}
}
