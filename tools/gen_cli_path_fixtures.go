package main

// 夹具生成器：**真实文件名输入**（不是 stdin）的 CLI 报错/warning 证据。
// 对应 PLAN.md「第 9 次推进」§1 第 3 步。生成器已入库，产物（testdata/logger/cli-paths.json +
// testdata/logger/cli-*.stderr）由 `*.test.ts` 钉 sha256，侧改会失败。
//
// 复现（必须在 /root/port 下运行，原因见下面「为什么」）：
//
//	cd /root/esbuild && mkdir -p tmpcliev && cp /root/port/tools/gen_cli_path_fixtures.go tmpcliev/main.go
//	go build -o /tmp/clievprobe ./tmpcliev
//	cd /root/port && /tmp/clievprobe /tmp/cli-spec.json > testdata/logger/cli-paths.json
//
// 为什么必须在 /root/port 下跑：`PrettyPaths.Rel` 是**相对 cwd** 的路径、`Abs` 由 cwd 推出
// （`internal/resolver/resolver.go:1093-1124` 的 MakePrettyPaths）。探针与真实 CLI 若不在同一个
// cwd，两条路径字符串不可比，夹具就失去意义。
//
// 探针做四件事，任一不成立就 panic（不留「大概对」的余地）：
//  1. 同一入口跑两遍 Build（AbsPaths=0 / api.LogAbsPath），要求两次 message 除 `Location.File`
//     外全等，且分别等于 Rel / Abs —— 两个路径字符串由 Go 给出，不是手拼的。
//  2. 用 `logger.NewStderrLog` 把提取出的 Msg 重放一遍，与真实 CLI stderr 逐字节比。
//  3. 带 override 的用例跑两遍（有/无），要求除 `Kind` 外全等（证明 override 只改 kind）。
//  4. `Log.AddMsgID` 的值语义：Go 是值参数，调用方 Msg 不应被改；此处打印调用方前后字段。

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
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
	IDName string    `json:"idName"`
	ID     int       `json:"id"`
	Text   string    `json:"text"`
	Plugin string    `json:"plugin"`
	Start  int       `json:"start"`
	Len    int       `json:"len"`
	Line   int       `json:"line"`
	Col    int       `json:"col"`
	Notes  []noteOut `json:"notes"`
}

type spec struct {
	Cases []struct {
		Name      string   `json:"name"`
		Entry     string   `json:"entry"`
		Format    string   `json:"format"`
		AbsPaths  string   `json:"absPaths"` // "none" | "log"
		Overrides []string `json:"overrides"` // CLI 原样字符串，如 "equals-nan=error"
		Stderr    string   `json:"stderr"`    // 真实 CLI 的 stderr 文件
	} `json:"cases"`
}

type caseOut struct {
	Name           string   `json:"name"`
	Entry          string   `json:"entry"`
	CLIArgs        []string `json:"cliArgs"`
	Stderr         string   `json:"stderr"`
	StderrBytes    int      `json:"stderrBytes"`
	StderrSha256   string   `json:"stderrSha256"`
	ContentsSha256 string   `json:"contentsSha256"`
	RelPath        string   `json:"relPath"`
	AbsPath        string   `json:"absPath"`
	PathStyle      int      `json:"pathStyle"` // logger.PathStyle：0=RelPath 1=AbsPath
	Overrides      []string `json:"overrides"`
	Msgs           []msgOut `json:"msgs"`
	// override 后 Go 实际发出的 kind（TS 侧重放要能自己算出同样的 kind）
	EmittedKinds []int `json:"emittedKinds"`
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

func convert(src string, kind logger.MsgKind, m api.Message) msgOut {
	starts := lineStarts(src)
	var out msgOut
	out.Kind = int(kind)
	out.IDName = m.ID
	out.ID = int(logger.StringToMaximumMsgID(m.ID))
	out.Text = m.Text
	out.Plugin = m.PluginName
	if m.Location == nil {
		panic("message without location: " + m.Text)
	}
	out.Line = m.Location.Line
	out.Col = m.Location.Column
	out.Start = starts[m.Location.Line-1] + m.Location.Column
	out.Len = m.Location.Length

	// 回读校验：由 start 反推的 line/column 必须与 API 给的一致
	s := &logger.Source{Contents: src}
	s.PrettyPaths.Rel = m.Location.File
	tr := logger.MakeLineColumnTracker(s)
	loc := tr.MsgLocationOrNil(logger.Range{Loc: logger.Loc{Start: int32(out.Start)}, Len: int32(out.Len)})
	if loc == nil || loc.Line != m.Location.Line || loc.Column != m.Location.Column || loc.Length != m.Location.Length {
		panic(fmt.Sprintf("%s: tracker mismatch %+v vs %d:%d/%d", m.Text, loc, m.Location.Line, m.Location.Column, m.Location.Length))
	}

	for _, n := range m.Notes {
		no := noteOut{Text: n.Text}
		if n.Location != nil {
			no.HasLocation = true
			if n.Location.File != m.Location.File {
				// 跨文件 note 需要该文件自己的 Contents；本夹具范围内不支持，宁可炸也不静默造错
				panic("note in a different file is out of scope: " + n.Location.File)
			}
			no.Start = starts[n.Location.Line-1] + n.Location.Column
			no.Len = n.Location.Length
		}
		out.Notes = append(out.Notes, no)
	}
	return out
}

func formatOf(name string) api.Format {
	switch name {
	case "esm":
		return api.FormatESModule
	case "cjs":
		return api.FormatCommonJS
	case "iife":
		return api.FormatIIFE
	case "":
		return api.FormatDefault
	}
	panic("unsupported format: " + name)
}

func levelOf(name string) api.LogLevel {
	switch name {
	case "verbose":
		return api.LogLevelVerbose
	case "debug":
		return api.LogLevelDebug
	case "info":
		return api.LogLevelInfo
	case "warning":
		return api.LogLevelWarning
	case "error":
		return api.LogLevelError
	case "silent":
		return api.LogLevelSilent
	}
	panic("unsupported log level: " + name)
}

// runBuild 跑一次真实的 api.Build，并把 stderr 抓回来。
func runBuild(entry string, format api.Format, absPaths api.AbsPaths, overrides map[string]api.LogLevel) (string, []api.Message, []api.Message) {
	opts := api.BuildOptions{
		EntryPoints: []string{entry},
		Write:       false,
		LogLimit:    6, // CLI 默认值（pkg/cli/cli_impl.go:1092）
		LogLevel:    api.LogLevelInfo,
		Color:       api.ColorNever,
		Format:      format,
		AbsPaths:    absPaths,
		LogOverride: overrides,
	}
	old := os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		panic(err)
	}
	os.Stderr = w
	res := api.Build(opts)
	w.Close()
	os.Stderr = old
	b, err := io.ReadAll(r)
	if err != nil {
		panic(err)
	}
	return string(b), res.Errors, res.Warnings
}

func sameMsgExceptKindAndFile(a, b api.Message) bool {
	if a.Text != b.Text || a.ID != b.ID || a.PluginName != b.PluginName {
		return false
	}
	if (a.Location == nil) != (b.Location == nil) {
		return false
	}
	if a.Location != nil {
		if a.Location.Line != b.Location.Line || a.Location.Column != b.Location.Column ||
			a.Location.Length != b.Location.Length || a.Location.Namespace != b.Location.Namespace {
			return false
		}
	}
	if len(a.Notes) != len(b.Notes) {
		return false
	}
	for i := range a.Notes {
		if a.Notes[i].Text != b.Notes[i].Text {
			return false
		}
		if (a.Notes[i].Location == nil) != (b.Notes[i].Location == nil) {
			return false
		}
	}
	return true
}

func main() {
	logger.API = logger.CLIAPI // CLI 文案与 JS API 文案不同（如 JSX 提示里的 --loader:.js=jsx）

	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	var sp spec
	if err := json.Unmarshal(data, &sp); err != nil {
		panic(err)
	}

	out := struct {
		Note                 string    `json:"note"`
		Cases                []caseOut `json:"cases"`
		AddMsgIDValueSems    string    `json:"addMsgIDValueSemanticsNote"`
		AddMsgIDCallerKind   int       `json:"addMsgIDCallerKind"`
		AddMsgIDCallerID     int       `json:"addMsgIDCallerID"`
		AddMsgIDEmittedKind  int       `json:"addMsgIDEmittedKind"`
		AddMsgIDEmittedID    int       `json:"addMsgIDEmittedID"`
		AddMsgIDCallerDataTx string    `json:"addMsgIDCallerDataText"`
	}{Note: "真实 CLI（/tmp/esbuild-go 0.28.2）以 cwd=/root/port 跑 testdata/logger/src/*.js 的 stderr；" +
		"Rel/Abs 两串由 Go 的 resolver.MakePrettyPaths 经 api.Message.Location.File 回读得到，" +
		"Msg 的 start/len 由 line/column 反推并已用 MakeLineColumnTracker 回读校验。"}

	for _, c := range sp.Cases {
		srcBytes, err := os.ReadFile(c.Entry)
		if err != nil {
			panic(err)
		}
		src := string(srcBytes)
		format := formatOf(c.Format)

		// ---- 1. Rel / Abs 双跑 ----
		relStderr, relErrs, relWarns := runBuild(c.Entry, format, 0, nil)
		absStderr, absErrs, absWarns := runBuild(c.Entry, format, api.LogAbsPath, nil)
		if len(relErrs) != len(absErrs) || len(relWarns) != len(absWarns) {
			panic(c.Name + ": rel/abs 两次构建的消息条数不同")
		}
		for i := range relErrs {
			if !sameMsgExceptKindAndFile(relErrs[i], absErrs[i]) {
				panic(c.Name + ": rel/abs 两次构建的 error 除文件路径外不同")
			}
			if relErrs[i].Location.File == absErrs[i].Location.File {
				panic(c.Name + ": --abs-paths=log 没有改变路径")
			}
		}
		for i := range relWarns {
			if !sameMsgExceptKindAndFile(relWarns[i], absWarns[i]) {
				panic(c.Name + ": rel/abs 两次构建的 warning 除文件路径外不同")
			}
			if relWarns[i].Location.File == absWarns[i].Location.File {
				panic(c.Name + ": --abs-paths=log 没有改变路径")
			}
		}
		if len(relErrs)+len(relWarns) != 1 {
			panic(fmt.Sprintf("%s: 本夹具要求恰好 1 条消息，实际 %d error + %d warning", c.Name, len(relErrs), len(relWarns)))
		}

		var origKind logger.MsgKind
		var orig api.Message
		if len(relErrs) == 1 {
			origKind, orig = logger.Error, relErrs[0]
		} else {
			origKind, orig = logger.Warning, relWarns[0]
		}
		relPath := orig.Location.File
		var absPath string
		if len(absErrs) == 1 {
			absPath = absErrs[0].Location.File
		} else {
			absPath = absWarns[0].Location.File
		}
		if !strings.HasPrefix(absPath, "/") {
			panic(c.Name + ": Abs 路径不是绝对路径: " + absPath)
		}

		// stderr 也应只差路径：把 Abs 串换回 Rel 串后必须与 rel 跑法逐字节相同
		if strings.ReplaceAll(absStderr, absPath, relPath) != relStderr {
			panic(c.Name + ": rel/abs 两次构建的 stderr 除路径外也不同")
		}

		// ---- 2. 带 override（若配置）再跑一遍 ----
		apiOverrides := map[string]api.LogLevel{}
		loggerOverrides := map[logger.MsgID]logger.LogLevel{}
		for _, raw := range c.Overrides {
			eq := strings.IndexByte(raw, '=')
			if eq == -1 {
				panic("bad override: " + raw)
			}
			name, level := raw[:eq], levelOf(raw[eq+1:])
			apiOverrides[name] = level
			logger.StringToMsgIDs(name, logger.LogLevel(level), loggerOverrides)
		}
		absPaths := api.AbsPaths(0)
		pathStyle := logger.RelPath
		if c.AbsPaths == "log" {
			absPaths = api.LogAbsPath
			pathStyle = logger.AbsPath
		}
		_, caseErrs, caseWarns := runBuild(c.Entry, format, absPaths, apiOverrides)
		if len(caseErrs)+len(caseWarns) != 1 {
			panic(fmt.Sprintf("%s: override 后消息数不是 1（%d error + %d warning）", c.Name, len(caseErrs), len(caseWarns)))
		}
		var emitted int
		var emittedMsg api.Message
		if len(caseErrs) == 1 {
			emitted, emittedMsg = int(logger.Error), caseErrs[0]
		} else {
			emitted, emittedMsg = int(logger.Warning), caseWarns[0]
		}
		if !sameMsgExceptKindAndFile(orig, emittedMsg) {
			panic(c.Name + ": override 改变了 kind 之外的字段")
		}
		if len(c.Overrides) > 0 && emitted == int(origKind) {
			panic(c.Name + ": override 没有改变 kind")
		}

		// ---- 3. 用提取出的 Msg 重放，与真实 CLI stderr 逐字节比 ----
		msgs := []msgOut{convert(src, origKind, orig)}
		m := msgs[0]
		source := &logger.Source{Contents: src}
		source.PrettyPaths = logger.PrettyPaths{Abs: absPath, Rel: relPath}
		tracker := logger.MakeLineColumnTracker(source)

		cliBytes, err := os.ReadFile(c.Stderr)
		if err != nil {
			panic(err)
		}

		// 重放
		var replay []byte
		{
			old := os.Stderr
			r, w, err := os.Pipe()
			if err != nil {
				panic(err)
			}
			os.Stderr = w
			log := logger.NewStderrLog(logger.OutputOptions{
				IncludeSource: true,
				MessageLimit:  6,
				Color:         logger.ColorNever,
				LogLevel:      logger.LevelInfo,
				PathStyle:     pathStyle,
				Overrides:     loggerOverrides,
			})
			msg := logger.Msg{Kind: origKind, ID: logger.MsgID(m.ID)}
			msg.PluginName = m.Plugin
			msg.Data = tracker.MsgData(logger.Range{Loc: logger.Loc{Start: int32(m.Start)}, Len: int32(m.Len)}, m.Text)
			for _, n := range m.Notes {
				if n.HasLocation {
					msg.Notes = append(msg.Notes, tracker.MsgData(logger.Range{Loc: logger.Loc{Start: int32(n.Start)}, Len: int32(n.Len)}, n.Text))
				} else {
					msg.Notes = append(msg.Notes, logger.MsgData{Text: n.Text})
				}
			}
			if m.ID != 0 {
				log.AddMsgID(logger.MsgID(m.ID), msg)
			} else {
				log.AddMsg(msg)
			}
			log.Done()
			w.Close()
			os.Stderr = old
			b, err := io.ReadAll(r)
			if err != nil {
				panic(err)
			}
			replay = b
		}
		if hex.EncodeToString(replay) != hex.EncodeToString(cliBytes) {
			panic(fmt.Sprintf("%s: 重放与 CLI stderr 不等\nCLI  : %s\nREPLAY: %s",
				c.Name, hex.EncodeToString(cliBytes), hex.EncodeToString(replay)))
		}
		// 探针自己那次 Build 的 stderr 也必须与 CLI 一致（同参数、同 cwd）
		if c.AbsPaths == "none" && len(c.Overrides) == 0 && hex.EncodeToString([]byte(relStderr)) != hex.EncodeToString(cliBytes) {
			panic(fmt.Sprintf("%s: 探针 Build 的 stderr 与 CLI stderr 不等\nCLI  : %s\nPROBE: %s",
				c.Name, hex.EncodeToString(cliBytes), hex.EncodeToString([]byte(relStderr))))
		}

		sum := sha256.Sum256(srcBytes)
		cliSum := sha256.Sum256(cliBytes)
		co := caseOut{
			Name:           c.Name,
			Entry:          c.Entry,
			CLIArgs:        []string{c.Entry, "--color=false"},
			Stderr:         c.Stderr,
			StderrBytes:    len(cliBytes),
			StderrSha256:   hex.EncodeToString(cliSum[:]),
			ContentsSha256: hex.EncodeToString(sum[:]),
			RelPath:        relPath,
			AbsPath:        absPath,
			PathStyle:      int(pathStyle),
			Overrides:      c.Overrides,
			Msgs:           msgs,
			EmittedKinds:   []int{emitted},
		}
		if c.Format != "" {
			co.CLIArgs = append(co.CLIArgs, "--format="+c.Format)
		}
		if c.AbsPaths == "log" {
			co.CLIArgs = append(co.CLIArgs, "--abs-paths=log")
		}
		for _, raw := range c.Overrides {
			co.CLIArgs = append(co.CLIArgs, "--log-override:"+raw)
		}
		out.Cases = append(out.Cases, co)
	}

	// ---- 4. AddMsgID 的值语义（Go: `func (log Log) AddMsgID(id MsgID, msg Msg)`）----
	{
		ov := map[logger.MsgID]logger.LogLevel{logger.MsgID_JS_EqualsNaN: logger.LevelError}
		log := logger.NewDeferLog(logger.DeferLogAll, ov)
		msg := logger.Msg{Kind: logger.Warning}
		msg.Data.Text = "x"
		log.AddMsgID(logger.MsgID_JS_EqualsNaN, msg)
		peek := log.Peek()
		if len(peek) != 1 {
			panic("AddMsgID 没有发出消息")
		}
		out.AddMsgIDValueSems = "调用方 Msg 是值参数：AddMsgID 之后 msg.Kind/ID 不变，只有发出的副本被改写"
		out.AddMsgIDCallerKind = int(msg.Kind)
		out.AddMsgIDCallerID = int(msg.ID)
		out.AddMsgIDCallerDataTx = msg.Data.Text
		out.AddMsgIDEmittedKind = int(peek[0].Kind)
		out.AddMsgIDEmittedID = int(peek[0].ID)
	}

	b, _ := json.MarshalIndent(out, "", " ")
	os.Stdout.Write(b)
	os.Stdout.WriteString("\n")
}
