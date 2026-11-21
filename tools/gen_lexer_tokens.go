package js_lexer

// Go 侧 token 适配器（js_lexer 的 token 级 oracle 基准），对应 PLAN.md「第 9 次推进」§3 与
// 「第 5 次推进」里写死的判据：
//   kind（枚举名 + 数值）/ raw（字节 hex）/ range（字节偏移）/ newlineBefore / comments（range + 是否合法注释）
//   / value（identifier 字节、字符串 UTF-16 码元、number 的 IEEE754 位模式）/ 报错的 kind + 原文。
//
// 为什么必须以**包内 _test.go** 的形式存在：`T` 没有运行时枚举名，token 名字只能从
// `js_lexer.go` 的 iota 常量块里用 go/ast 读出来（手抄必然漂移）；而该文件与 `tokenToString`
// 都在包内。适配器只做「取结构体并打印」，**不做任何归一化**（归一化只能发生在比较层）。
//
// 复现：
//   cd /root/esbuild && cp /root/port/tools/gen_lexer_tokens.go internal/js_lexer/tmpadapter_test.go
//   V1（老基准，单位置/单 token 片段，仅留作对照）：
//     LEX_DIRS=/root/port/testdata/esbuild-cases-lex LEX_OUT=/tmp/tokens.jsonl go test -run TestTmpDumpTokens ./internal/js_lexer/
//   V2（本轮新基准，多目录 + 确定性抽样 + 按内容去重）：见 PLAN.md「第 10 次推进」§3 的实跑命令。
//   rm internal/js_lexer/tmpadapter_test.go
//
// 产物（V2）：`testdata/lexer/tokens-from-esbuild-cases.part-*.jsonl`（每行一个记录，
// `r` = token / log / case 摘要 / summary；因单文件拉取上限 1MiB，拆成 4 片，拼接后才是完整夹具）。
// V1 产物 `testdata/lexer/tokens.jsonl` 仅留作对照（单 token 片段，粒度无效）。

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/evanw/esbuild/internal/config"
	"github.com/evanw/esbuild/internal/logger"
)

type commentRec struct {
	Start int  `json:"start"`
	Len   int  `json:"len"`
	Legal bool `json:"legal,omitempty"`
}

type tokenRec struct {
	Rec           string       `json:"r"` // "t"
	Case          string       `json:"case"`
	I             int          `json:"i"`
	Kind          int          `json:"kind"`
	KindName      string       `json:"kindName"`
	RawHex        string       `json:"rawHex"`
	Start         int          `json:"start"`
	Len           int          `json:"len"`
	NlBefore      bool         `json:"nlBefore,omitempty"`
	CommentBefore int          `json:"commentBefore,omitempty"`
	Comments      []commentRec `json:"comments,omitempty"`
	ValueHex      string       `json:"valueHex,omitempty"`
	NumberBits    string       `json:"numberBits,omitempty"`
	ValuePanic    bool         `json:"valuePanic,omitempty"`
}

type logRec struct {
	Rec    string `json:"r"` // "l"
	Case   string `json:"case"`
	Kind   int    `json:"kind"`
	Text   string `json:"text"`
	HasLoc bool   `json:"hasLoc"`
	Line   int    `json:"line,omitempty"`
	Col    int    `json:"col,omitempty"`
	Len    int    `json:"len,omitempty"`
}

type caseRec struct {
	Rec        string `json:"r"` // "c"
	Case       string `json:"case"`
	Contents   int    `json:"contentsBytes"`
	SHA256Hex  string `json:"contentsSha256"`
	Tokens     int    `json:"tokens"`
	Logs       int    `json:"logs"`
	EndOfFile  bool   `json:"endOfFile"`
	Stop       string `json:"stop,omitempty"` // "syntaxError" / "tokenCap"
	PanicValue string `json:"panic,omitempty"`
	// LEX_INLINE=1 时把输入整体嵌进夹具（hex）。用于「语料目录不进仓库」的小语料，
	// 让夹具自包含、测试不依赖那些文件是否被同步到本地。
	ContentsHex string `json:"contentsHex,omitempty"`
}

type summaryRec struct {
	Rec               string `json:"r"` // "s"
	Cases             int    `json:"cases"`
	Tokens            int    `json:"tokens"`
	DistinctKinds     int    `json:"distinctKinds"`
	Logs              int    `json:"logs"`
	SkippedDuplicates int    `json:"skippedDuplicates"`
}

// tokenNames 用 go/ast 读 js_lexer.go 的 iota 常量块（`TEndOfFile T = iota` 起头），
// 按出现顺序取名字 —— 与 Go 的求值规则一致（该块所有 spec 都是隐式重复 iota）。
func tokenNames(t *testing.T) map[T]string {
	t.Helper()
	f, err := parser.ParseFile(token.NewFileSet(), "js_lexer.go", nil, 0)
	if err != nil {
		t.Fatalf("parse js_lexer.go: %v", err)
	}
	for _, decl := range f.Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok || gen.Tok != token.CONST || len(gen.Specs) == 0 {
			continue
		}
		first, ok := gen.Specs[0].(*ast.ValueSpec)
		if !ok || len(first.Names) != 1 || first.Names[0].Name != "TEndOfFile" {
			continue
		}
		names := map[T]string{}
		for i, spec := range gen.Specs {
			vs, ok := spec.(*ast.ValueSpec)
			if !ok {
				continue
			}
			for _, n := range vs.Names {
				names[T(i)] = n.Name
			}
		}
		return names
	}
	t.Fatal("找不到 js_lexer.go 里的 T 常量块")
	return nil
}

func dumpCase(name string, contents string, names map[T]string) (tokens []tokenRec, logs []logRec, panicValue string, eof bool, stop string) {
	log := logger.NewDeferLog(logger.DeferLogNoVerboseOrDebug, nil)
	source := logger.Source{Contents: contents}

	// 硬上限：不加上限时，某个输入会让「不推进」的 token 无限增长把进程 OOM 掉。
	// 触上限不是崩溃，而是一个必须记下来的事实（panic=tokenCap），方便定位是哪一个输入。
	const tokenCap = 500000

	defer func() {
		if r := recover(); r != nil {
			if _, ok := r.(LexerPanic); ok {
				panicValue = "LexerPanic"
			} else {
				panicValue = fmt.Sprintf("%T", r)
			}
		}
		for _, msg := range log.Done() {
			l := logRec{Rec: "l", Case: name, Kind: int(msg.Kind), Text: msg.Data.Text}
			if loc := msg.Data.Location; loc != nil {
				l.HasLoc = true
				l.Line = loc.Line
				l.Col = loc.Column
				l.Len = loc.Length
			}
			logs = append(logs, l)
		}
	}()

	lexer := NewLexer(log, source, config.TSOptions{})
	for i := 0; ; i++ {
		if lexer.Token == TEndOfFile {
			eof = true
			return
		}
		if lexer.Token == TSyntaxError {
			// `TSyntaxError` 是**终止态**：后续 Next() 不再推进（实测 start==end==current 不变），
			// 在真正的解析器里这一步会 panic（lexer.Unexpected 等）。裸 token 循环必须在此停机，
			// 否则会出现「同一个空 token 无限重复」的假象。记录这个 token 后结束。
			rec := tokenRec{
				Rec: "t", Case: name, I: i, Kind: int(lexer.Token), KindName: names[lexer.Token],
				RawHex: hex.EncodeToString([]byte(lexer.Raw())),
				Start:  int(lexer.start), Len: int(lexer.end - lexer.start),
				NlBefore: lexer.HasNewlineBefore, CommentBefore: int(lexer.HasCommentBefore),
			}
			tokens = append(tokens, rec)
			stop = "syntaxError"
			return
		}
		if i >= tokenCap {
			// 不推进的 token 循环：记下事实并停机（不能 OOM）
			panicValue = "tokenCap"
			eof = false
			stop = "tokenCap"
			return
		}
		r := lexer.Range()
		rec := tokenRec{
			Rec:           "t",
			Case:          name,
			I:             i,
			Kind:          int(lexer.Token),
			KindName:      names[lexer.Token],
			RawHex:        hex.EncodeToString([]byte(lexer.Raw())),
			Start:         int(r.Loc.Start),
			Len:           int(r.Len),
			NlBefore:      lexer.HasNewlineBefore,
			CommentBefore: int(lexer.HasCommentBefore),
		}
		legal := map[[2]int]bool{}
		for _, cr := range lexer.LegalCommentsBeforeToken {
			legal[[2]int{int(cr.Loc.Start), int(cr.Len)}] = true
		}
		for _, cr := range lexer.CommentsBeforeToken {
			k := [2]int{int(cr.Loc.Start), int(cr.Len)}
			rec.Comments = append(rec.Comments, commentRec{Start: k[0], Len: k[1], Legal: legal[k]})
		}
		switch lexer.Token {
		case TIdentifier, TEscapedKeyword, TBigIntegerLiteral:
			rec.ValueHex = hex.EncodeToString([]byte(lexer.Identifier.String))
		case TStringLiteral, TNoSubstitutionTemplateLiteral, TTemplateHead, TTemplateMiddle, TTemplateTail:
			func() {
				defer func() {
					if r := recover(); r != nil {
						if _, ok := r.(LexerPanic); !ok {
							panic(r)
						}
						rec.ValuePanic = true
					}
				}()
				units := lexer.StringLiteral()
				buf := make([]byte, 2*len(units))
				for j, u := range units {
					buf[2*j] = byte(u >> 8)
					buf[2*j+1] = byte(u)
				}
				rec.ValueHex = hex.EncodeToString(buf)
			}()
			if rec.ValuePanic {
				// 非法转义：Go 侧的 StringLiteral() 会 panic（错误已进 log），token 流到此为止
				tokens = append(tokens, rec)
				return
			}
		case TNumericLiteral:
			bits := math.Float64bits(lexer.Number)
			buf := make([]byte, 8)
			for j := 0; j < 8; j++ {
				buf[j] = byte(bits >> (56 - 8*j))
			}
			rec.NumberBits = hex.EncodeToString(buf)
		}
		tokens = append(tokens, rec)
		lexer.Next()
	}
}

func TestTmpDumpTokens(t *testing.T) {
	dirsEnv := os.Getenv("LEX_DIRS")
	out := os.Getenv("LEX_OUT")
	if dirsEnv == "" || out == "" {
		t.Skip("LEX_DIRS / LEX_OUT 未设置")
	}
	names := tokenNames(t)
	if names[0] != "TEndOfFile" {
		t.Fatalf("名字表 0 号不是 TEndOfFile: %q", names[0])
	}
	inline := os.Getenv("LEX_INLINE") == "1"

	dirs := strings.Split(dirsEnv, ":")
	// LEX_ROOT：夹具里的 case 记为「相对仓库根」的路径（可移植）；不设则照原样记。
	root := strings.TrimSuffix(os.Getenv("LEX_ROOT"), "/")
	strides := make([]int, len(dirs))
	for i := range strides {
		strides[i] = 1
	}
	if s := os.Getenv("LEX_STRIDE"); s != "" {
		parts := strings.Split(s, ":")
		if len(parts) != len(dirs) {
			t.Fatalf("LEX_STRIDE 段数(%d) 与 LEX_DIRS 段数(%d) 不一致", len(parts), len(dirs))
		}
		for i, p := range parts {
			n, err := strconv.Atoi(p)
			if err != nil || n < 1 {
				t.Fatalf("LEX_STRIDE[%d] 非法: %q", i, p)
			}
			strides[i] = n
		}
	}

	f, err := os.Create(out)
	if err != nil {
		t.Fatal(err)
	}
	w := bufio.NewWriter(f)
	enc := json.NewEncoder(w)
	writeRec := func(v interface{}) {
		if err := enc.Encode(v); err != nil {
			t.Fatal(err)
		}
	}

	seen := map[string]bool{}
	var totalTokens, totalLogs, skippedDup, totalCases int
	distinctKinds := map[string]bool{}

	for di, dir := range dirs {
		var files []string
		// 递归枚举（three/package/src 是嵌套目录；esbuild-cases 是平的，递归对它无影响）
		err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if !d.IsDir() && filepath.Ext(path) == ".js" {
				files = append(files, path)
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		sort.Strings(files)

		for fi, rel := range files {
			if fi%strides[di] != 0 {
				continue
			}
			caseName := rel
			if root != "" {
				caseName = strings.TrimPrefix(strings.TrimPrefix(rel, root), "/")
			}
			contents, err := os.ReadFile(rel)
			if err != nil {
				t.Fatal(err)
			}
			inlineContents := ""
			if inline {
				inlineContents = hex.EncodeToString(contents)
			}
			sum := sha256.Sum256(contents)
			sumHex := hex.EncodeToString(sum[:])
			if seen[sumHex] {
				skippedDup++
				continue
			}
			seen[sumHex] = true
			totalCases++

			tokens, logs, panicValue, eof, stop := dumpCase(caseName, string(contents), names)
			for _, rec := range tokens {
				distinctKinds[rec.KindName] = true
				writeRec(rec)
			}
			for _, rec := range logs {
				writeRec(rec)
			}
			writeRec(caseRec{
				Rec: "c", Case: caseName, Contents: len(contents), SHA256Hex: sumHex,
				Tokens: len(tokens), Logs: len(logs), EndOfFile: eof, Stop: stop, PanicValue: panicValue,
				ContentsHex: inlineContents,
			})
			totalTokens += len(tokens)
			totalLogs += len(logs)
		}
	}

	writeRec(summaryRec{
		Rec: "s", Cases: totalCases, Tokens: totalTokens, DistinctKinds: len(distinctKinds),
		Logs: totalLogs, SkippedDuplicates: skippedDup,
	})

	if err := w.Flush(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}
