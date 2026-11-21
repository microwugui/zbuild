package main

// 夹具生成器（本轮已跑过；保留下来供复现）。生成器不是测试，不会被 `*.test.ts` 引用。
//
// 用法：在 esbuild 仓库（/root/esbuild，v0.28.2 f6058f83）里建子目录，把本文件放进去：
//   mkdir -p tmpmsgfmt && cp tools/gen_logger_fixtures.go tmpmsgfmt/main.go
//   go run ./tmpmsgfmt extract <spec.json>   → 用 esbuild 公开 API 跑真实用例，把 Msg 结构打成 JSON
//   go run ./tmpmsgfmt fmt <manifest.json>   → 用 internal/logger 复现 CLI 的 stderr（写 stderr）
//   go run ./tmpmsgfmt tracker <spec.json>   → MakeLineColumnTracker 在指定偏移序列上的 line/column/lineText
//   go run ./tmpmsgfmt style <spec.json>     → msg.String（default style）的原始输出字节（hex）
//   go run ./tmpmsgfmt printer <spec.json>   → PrintErrorToStderr / PrintText* / PrintSummary 的输出字节
//   go run ./tmpmsgfmt loglimit <spec.json>  → NewStderrLog 的 message limit / deferred warnings
//
// 关键点：extract 里由 line/column 反推 Loc.Start，并用 tracker 回读校验 line/column 一致，否则 panic。
// 产物（已入库，期望值不再重生成，测试里有 sha256 钉住）：
//   testdata/logger/{cases.json,*.stderr,tracker.json,style.json,printer.json,loglevel.json}

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/ioutil"
	"os"
	"unicode/utf8"

	"github.com/evanw/esbuild/internal/logger"
	"github.com/evanw/esbuild/pkg/api"
)

type noteOut struct {
	Text        string `json:"text"`
	Start       int    `json:"start"`
	Len         int    `json:"len"`
	HasLocation bool   `json:"hasLocation"`
}

type msgOut struct {
	Kind   int       `json:"kind"`
	ID     int       `json:"id"`
	Text   string    `json:"text"`
	Plugin string    `json:"plugin"`
	Start  int       `json:"start"`
	Len    int       `json:"len"`
	Notes  []noteOut `json:"notes"`
	// 期望值（供人读 + 断言用）
	WantLine int `json:"wantLine"`
	WantCol  int `json:"wantCol"`
}

type caseOut struct {
	Name   string   `json:"name"`
	Source string   `json:"source"`
	SHA256 string   `json:"sha256"`
	Args   []string `json:"args"`
	Msgs   []msgOut `json:"msgs"`
}

type spec struct {
	Cases []struct {
		Name   string   `json:"name"`
		Source string   `json:"source"`
		Args   []string `json:"args"`
	} `json:"cases"`
}

// Go logger 的行切分：\n / \r / U+2028 / U+2029，CRLF 算一个换行
func lineStarts(contents string) []int {
	starts := []int{0}
	i := 0
	n := len(contents)
	for i < n {
		r, size := utf8.DecodeRuneInString(contents[i:])
		i += size
		switch r {
		case '\n':
			if i == size || contents[i-size-1] != '\r' {
				starts = append(starts, i)
			}
		case '\r', '\u2028', '\u2029':
			starts = append(starts, i)
		}
	}
	return starts
}

func optsFor(args []string) api.TransformOptions {
	o := api.TransformOptions{Loader: api.LoaderJS, LogLevel: api.LogLevelSilent, Color: api.ColorNever}
	for _, a := range args {
		switch a {
		case "--loader=js":
			o.Loader = api.LoaderJS
		case "--loader=jsx":
			o.Loader = api.LoaderJSX
		case "--format=esm":
			o.Format = api.FormatESModule
		case "--format=cjs":
			o.Format = api.FormatCommonJS
		case "--format=iife":
			o.Format = api.FormatIIFE
		case "--minify":
			o.MinifySyntax, o.MinifyWhitespace, o.MinifyIdentifiers = true, true, true
		case "--target=es2015":
			o.Target = api.ES2015
		case "--charset=ascii":
			o.Charset = api.CharsetASCII
		case "--sourcemap=inline":
			o.Sourcemap = api.SourceMapInline
		}
	}
	return o
}

func findLine(starts []int, offset int) (line int, col int) {
	line = 0
	for i, s := range starts {
		if s <= offset {
			line = i
		} else {
			break
		}
	}
	return line, offset - starts[line]
}

func convert(src string, m api.Message) msgOut {
	starts := lineStarts(src)
	var out msgOut
	out.Text = m.Text
	out.Plugin = m.PluginName
	out.Kind = int(logger.Error)
	if m.Location == nil {
		panic("message without location: " + m.Text)
	}
	out.Start = starts[m.Location.Line-1] + m.Location.Column
	out.Len = m.Location.Length
	out.WantLine = m.Location.Line
	out.WantCol = m.Location.Column
	// 校验：tracker 从 start 反推回来的 line/column 必须与 API 给的一致
	s := &logger.Source{Contents: src}
	s.PrettyPaths.Rel = m.Location.File
	tr := logger.MakeLineColumnTracker(s)
	loc := tr.MsgLocationOrNil(logger.Range{Loc: logger.Loc{Start: int32(out.Start)}, Len: int32(out.Len)})
	if loc == nil || loc.Line != m.Location.Line || loc.Column != m.Location.Column {
		panic(fmt.Sprintf("tracker mismatch: %v vs %d:%d", loc, m.Location.Line, m.Location.Column))
	}
	for _, n := range m.Notes {
		no := noteOut{Text: n.Text}
		if n.Location != nil {
			no.HasLocation = true
			no.Start = starts[n.Location.Line-1] + n.Location.Column
			no.Len = n.Location.Length
		}
		out.Notes = append(out.Notes, no)
	}
	return out
}

func main() {
	mode := os.Args[1]
	file := os.Args[2]
	data, err := ioutil.ReadFile(file)
	if err != nil {
		panic(err)
	}

	switch mode {
	case "extract":
		// CLI 的错误文案里有 API 相关分支（如 JSX 提示里 --loader:.js=jsx vs Loader 映射）
		logger.API = logger.CLIAPI

		var sp spec
		if err := json.Unmarshal(data, &sp); err != nil {
			panic(err)
		}
		out := struct {
			Cases []caseOut `json:"cases"`
		}{}
		for _, c := range sp.Cases {
			srcBytes, err := ioutil.ReadFile(c.Source)
			if err != nil {
				panic(err)
			}
			src := string(srcBytes)
			sum := sha256.Sum256(srcBytes)
			res := api.Transform(src, optsFor(c.Args))
			co := caseOut{Name: c.Name, Source: c.Source, SHA256: hex.EncodeToString(sum[:]), Args: c.Args}
			if len(res.Errors) != 1 {
				panic(fmt.Sprintf("%s: expected 1 error, got %d", c.Name, len(res.Errors)))
			}
			co.Msgs = append(co.Msgs, convert(src, res.Errors[0]))
			out.Cases = append(out.Cases, co)
		}
		b, _ := json.MarshalIndent(out, "", " ")
		os.Stdout.Write(b)
		os.Stdout.WriteString("\n")

	case "fmt":
		var man struct {
			Cases []struct {
				Name   string   `json:"name"`
				Source string   `json:"source"`
				Msgs   []msgOut `json:"msgs"`
			} `json:"cases"`
		}
		if err := json.Unmarshal(data, &man); err != nil {
			panic(err)
		}
		target := os.Stdout // 由调用方把 stdout 重定向到每个用例一个文件
		_ = target
		for _, c := range man.Cases {
			os.Stderr.WriteString("\x00CASE:" + c.Name + "\n")
			srcBytes, err := ioutil.ReadFile(c.Source)
			if err != nil {
				panic(err)
			}
			src := &logger.Source{Contents: string(srcBytes)}
			src.PrettyPaths.Rel = "<stdin>"
			tr := logger.MakeLineColumnTracker(src)
			log := logger.NewStderrLog(logger.OutputOptions{IncludeSource: true, Color: logger.ColorNever})
			for _, m := range c.Msgs {
				msg := logger.Msg{Kind: logger.MsgKind(m.Kind), ID: logger.MsgID(m.ID)}
				msg.PluginName = m.Plugin
				msg.Data = tr.MsgData(logger.Range{Loc: logger.Loc{Start: int32(m.Start)}, Len: int32(m.Len)}, m.Text)
				for _, n := range m.Notes {
					if n.HasLocation {
						msg.Notes = append(msg.Notes, tr.MsgData(logger.Range{Loc: logger.Loc{Start: int32(n.Start)}, Len: int32(n.Len)}, n.Text))
					} else {
						msg.Notes = append(msg.Notes, logger.MsgData{Text: n.Text})
					}
				}
				log.AddMsg(msg)
			}
			log.Done()
		}

	case "loglimit":
		var sps []struct {
			Name         string `json:"name"`
			MessageLimit int    `json:"messageLimit"`
			LogLevel     int    `json:"logLevel"`
			Msgs         []struct {
				Kind int    `json:"kind"`
				Text string `json:"text"`
			} `json:"msgs"`
		}
		if err := json.Unmarshal(data, &sps); err != nil {
			panic(err)
		}
		for _, sp := range sps {
			old := os.Stderr
			r, w, err := os.Pipe()
			if err != nil {
				panic(err)
			}
			os.Stderr = w
			log := logger.NewStderrLog(logger.OutputOptions{
				IncludeSource: false,
				Color:         logger.ColorNever,
				MessageLimit:  sp.MessageLimit,
				LogLevel:      logger.LogLevel(sp.LogLevel),
			})
			for _, m := range sp.Msgs {
				msg := logger.Msg{Kind: logger.MsgKind(m.Kind)}
				msg.Data.Text = m.Text
				log.AddMsg(msg)
			}
			log.Done()
			w.Close()
			os.Stderr = old
			b, err := ioutil.ReadAll(r)
			if err != nil {
				panic(err)
			}
			fmt.Printf("\x00CASE:%s\n%s\n", sp.Name, hex.EncodeToString(b))
		}

	case "printer":
		var sp struct {
			ErrorText string   `json:"errorText"`
			Note      string   `json:"note"`
			Text      string   `json:"text"`
			Summary   []struct {
				Dir         string `json:"dir"`
				Base        string `json:"base"`
				Size        string `json:"size"`
				Bytes       int    `json:"bytes"`
				IsSourceMap bool   `json:"isSourceMap"`
			} `json:"summary"`
			SummaryColor int `json:"summaryColor"`
		}
		if err := json.Unmarshal(data, &sp); err != nil {
			panic(err)
		}
		emit := func(name string, b []byte) {
			fmt.Printf("\x00CASE:%s\n%s\n", name, hex.EncodeToString(b))
		}
		capture := func(f func(w *os.File)) []byte {
			old := os.Stderr
			r, w, err := os.Pipe()
			if err != nil {
				panic(err)
			}
			os.Stderr = w
			f(w)
			w.Close()
			os.Stderr = old
			b, err := ioutil.ReadAll(r)
			if err != nil {
				panic(err)
			}
			return b
		}
		args := []string{"--color=false"}
		emit("print-error", capture(func(w *os.File) {
			logger.PrintErrorToStderr(args, sp.ErrorText)
		}))
		emit("print-error-note", capture(func(w *os.File) {
			logger.PrintErrorWithNoteToStderr(args, sp.ErrorText, sp.Note)
		}))
		emit("print-text-loglevel", capture(func(w *os.File) {
			logger.PrintText(w, logger.LevelInfo, args, func(c logger.Colors) string {
				return "text:" + c.Red + "x" + c.Reset + "\n"
			})
		}))
		emit("print-text-silenced", capture(func(w *os.File) {
			logger.PrintText(w, logger.LevelVerbose, []string{"--log-level=info"}, func(c logger.Colors) string {
				return "must not appear\n"
			})
		}))
		emit("print-text-color-always", capture(func(w *os.File) {
			logger.PrintTextWithColor(w, logger.ColorAlways, func(c logger.Colors) string {
				return "a" + c.Red + "b" + c.Reset + "c" + c.Bold + "d" + c.Reset + "\n"
			})
		}))
		emit("print-text-color-never", capture(func(w *os.File) {
			logger.PrintTextWithColor(w, logger.ColorNever, func(c logger.Colors) string {
				return "a" + c.Red + "b" + c.Reset + "\n"
			})
		}))
		var table logger.SummaryTable
		for _, e := range sp.Summary {
			table = append(table, logger.SummaryTableEntry{Dir: e.Dir, Base: e.Base, Size: e.Size, Bytes: e.Bytes, IsSourceMap: e.IsSourceMap})
		}
		emit("print-summary", capture(func(w *os.File) {
			logger.PrintSummary(logger.UseColor(sp.SummaryColor), table, nil)
		}))
		emit("print-text-color-if-terminal", capture(func(w *os.File) {
			logger.PrintTextWithColor(w, logger.ColorIfTerminal, func(c logger.Colors) string {
				return "t" + c.Green + "u" + c.Reset + "\n"
			})
		}))

	case "style":
		var sps []struct {
			Name                string   `json:"name"`
			LineTextHex         string   `json:"lineTextHex"`
			Line                int      `json:"line"`
			Column              int      `json:"column"`
			Length              int      `json:"length"`
			Text                string   `json:"text"`
			Kind                int      `json:"kind"`
			ID                  int      `json:"id"`
			Plugin              string   `json:"plugin"`
			Suggestion          string   `json:"suggestion"`
			Notes               []string `json:"notes"`
			Width               int      `json:"width"`
			UseColor            bool     `json:"useColor"`
			DisableMaximumWidth bool     `json:"disableMaximumWidth"`
			PathStyle           int      `json:"pathStyle"`
			IncludeSource       bool     `json:"includeSource"`
		}
		if err := json.Unmarshal(data, &sps); err != nil {
			panic(err)
		}
		for _, sp := range sps {
			raw, err := hex.DecodeString(sp.LineTextHex)
			if err != nil {
				panic(err)
			}
			data := logger.MsgData{
				Text: sp.Text,
				Location: &logger.MsgLocation{
					File:       logger.PrettyPaths{Rel: "rel.js", Abs: "/abs/rel.js"},
					LineText:   string(raw),
					Line:       sp.Line,
					Column:     sp.Column,
					Length:     sp.Length,
					Suggestion: sp.Suggestion,
				},
				DisableMaximumWidth: sp.DisableMaximumWidth,
			}
			msg := logger.Msg{Kind: logger.MsgKind(sp.Kind), ID: logger.MsgID(sp.ID), PluginName: sp.Plugin, Data: data}
			for _, n := range sp.Notes {
				msg.Notes = append(msg.Notes, logger.MsgData{Text: n})
			}
			opts := logger.OutputOptions{IncludeSource: sp.IncludeSource, Color: logger.ColorNever, PathStyle: logger.PathStyle(sp.PathStyle)}
			ti := logger.TerminalInfo{Width: sp.Width, UseColorEscapes: sp.UseColor}
			out := msg.String(opts, ti)
			fmt.Printf("\x00CASE:%s\n%s\n", sp.Name, hex.EncodeToString([]byte(out)))
		}

	case "tracker":
		var sps []struct {
			Name        string  `json:"name"`
			ContentsHex string  `json:"contentsHex"`
			Offsets     []int32 `json:"offsets"`
			Mode        string  `json:"mode"` // "one" = 单 tracker 顺序扫；"fresh" = 每个偏移新建
		}
		if err := json.Unmarshal(data, &sps); err != nil {
			panic(err)
		}
		for _, sp := range sps {
			raw, err := hex.DecodeString(sp.ContentsHex)
			if err != nil {
				panic(err)
			}
			src := &logger.Source{Contents: string(raw)}
			tr := logger.MakeLineColumnTracker(src)
			fmt.Printf("\x00CASE:%s\n", sp.Name)
			for _, off := range sp.Offsets {
				t := &tr
				if sp.Mode == "fresh" {
					tr2 := logger.MakeLineColumnTracker(src)
					t = &tr2
				}
				loc := t.MsgLocationOrNil(logger.Range{Loc: logger.Loc{Start: off}})
				if loc == nil {
					fmt.Println("nil")
					continue
				}
				fmt.Printf("%d:%d:%s\n", loc.Line, loc.Column, hex.EncodeToString([]byte(loc.LineText)))
			}
		}
	}
}
