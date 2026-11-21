// gen_helpers2_fixture.go 生成 helpers 第二批（strings/float/comment/bitset/
// joiner/typos/hash）的差分基准。浮点一律用 IEEE-754 位模式编码，避免格式化差异。
//
// 用法: cd /root/esbuild && go run ./tmpgen3 > /root/port/testdata/helpers2.json
package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"os"

	"github.com/evanw/esbuild/internal/helpers"
)

func fbits(f float64) string { return fmt.Sprintf("%016x", math.Float64bits(f)) }

func main() {
	// ---- F64 ----
	unary := []float64{
		0, math.Copysign(0, -1), 0.5, -0.5, 1.5, -1.5, 2.5, -2.5, 3.7, -3.7,
		0.49999999999999994, 1.0 / 3.0, 1e21, -1e21, 1e-300, 9007199254740992,
		math.NaN(), math.Inf(1), math.Inf(-1), 1, -1, 2, 10,
	}
	var floatCases []map[string]string
	for _, x := range unary {
		a := helpers.NewF64(x)
		floatCases = append(floatCases, map[string]string{
			"x": fbits(x),
			"neg": fbits(a.Neg().Value()), "abs": fbits(a.Abs().Value()),
			"sin": fbits(a.Sin().Value()), "cos": fbits(a.Cos().Value()),
			"log2": fbits(a.Log2().Value()), "round": fbits(a.Round().Value()),
			"floor": fbits(a.Floor().Value()), "ceil": fbits(a.Ceil().Value()),
			"sq": fbits(a.Squared().Value()), "cube": fbits(a.Cubed().Value()),
			"sqrt": fbits(a.Sqrt().Value()), "cbrt": fbits(a.Cbrt().Value()),
			"isNaN": fmt.Sprintf("%v", a.IsNaN()), "value": fbits(a.Value()),
			"addConst": fbits(a.AddConst(2.5).Value()), "subConst": fbits(a.SubConst(2.5).Value()),
			"mulConst": fbits(a.MulConst(-1.25).Value()), "divConst": fbits(a.DivConst(3).Value()),
			"powConst": fbits(a.PowConst(3).Value()),
		})
	}
	pairs := [][2]float64{
		{1.5, -2.5}, {0, -0.0}, {math.NaN(), 1}, {2, 0.5}, {-3, 2}, {1e300, 1e300},
		{math.Inf(1), 2}, {-0.0, 5},
	}
	var binaryCases []map[string]string
	for _, p := range pairs {
		a, b := helpers.NewF64(p[0]), helpers.NewF64(p[1])
		binaryCases = append(binaryCases, map[string]string{
			"a": fbits(p[0]), "b": fbits(p[1]),
			"add": fbits(a.Add(b).Value()), "sub": fbits(a.Sub(b).Value()),
			"mul": fbits(a.Mul(b).Value()), "div": fbits(a.Div(b).Value()),
			"pow": fbits(a.Pow(b).Value()), "atan2": fbits(a.Atan2(b).Value()),
			"sign": fbits(a.WithSignFrom(b).Value()),
			"min2": fbits(helpers.Min2(a, b).Value()), "max2": fbits(helpers.Max2(a, b).Value()),
			"min3": fbits(helpers.Min3(a, b, helpers.NewF64(-7)).Value()),
			"max3": fbits(helpers.Max3(a, b, helpers.NewF64(-7)).Value()),
			"lerp": fbits(helpers.Lerp(a, b, helpers.NewF64(0.25)).Value()),
		})
	}

	// ---- HashCombine ----
	type hashCase struct {
		Seed uint32 `json:"seed"`
		Hash uint32 `json:"hash"`
		Out  uint32 `json:"out"`
	}
	var hashCases []hashCase
	for _, p := range [][2]uint32{{0, 0}, {1, 2}, {0xffffffff, 1}, {12345, 67890}} {
		hashCases = append(hashCases, hashCase{p[0], p[1], helpers.HashCombine(p[0], p[1])})
	}
	type hashStrCase struct {
		Seed uint32 `json:"seed"`
		Text string `json:"text"`
		Out  uint32 `json:"out"`
	}
	var hashStrCases []hashStrCase
	for _, s := range []string{"", "a", "abc", "héllo", "日本語", "😀"} {
		hashStrCases = append(hashStrCases, hashStrCase{7, s, helpers.HashCombineString(7, s)})
	}

	// ---- EscapeClosingTag ----
	type escCase struct {
		Text     string `json:"text"`
		SlashTag string `json:"slashTag"`
		Out      string `json:"out"`
	}
	var escCases []escCase
	for _, p := range [][2]string{
		{"a</b>c", "</b>"}, {"a</B>c", "</b>"}, {"</script></SCRIPT>", "</script>"},
		{"a</b", "</b>"}, {"", "</b>"}, {"</b></b>", "</b>"}, {"x</scRiPt >", "</script>"},
	} {
		escCases = append(escCases, escCase{p[0], p[1], helpers.EscapeClosingTag(p[0], p[1])})
	}

	// ---- BitSet ----
	type bitCase struct {
		Count    uint   `json:"count"`
		Set      []uint `json:"set"`
		HasTrue  []uint `json:"hasTrue"`
		HasFalse []uint `json:"hasFalse"`
		Entries  string `json:"entries"`
	}
	var bitCases []bitCase
	for _, c := range []struct {
		count uint
		set   []uint
	}{{0, nil}, {1, []uint{0}}, {8, []uint{0, 7}}, {17, []uint{1, 8, 16}}} {
		bs := helpers.NewBitSet(c.count)
		for _, b := range c.set {
			bs.SetBit(b)
		}
		var hasTrue, hasFalse []uint
		for b := uint(0); b < c.count; b++ {
			found := false
			for _, s := range c.set {
				if s == b {
					found = true
				}
			}
			if found {
				hasTrue = append(hasTrue, b)
			} else {
				hasFalse = append(hasFalse, b)
			}
		}
		bitCases = append(bitCases, bitCase{c.count, c.set, hasTrue, hasFalse,
			hex.EncodeToString([]byte(bs.String()))})
	}

	// ---- Joiner ----
	type joinerCase struct {
		Strings []string `json:"strings"`
		Bytes   []string `json:"bytes"` // hex
		Length  uint32   `json:"length"`
		Last    byte     `json:"last"`
		Done    string   `json:"done"`
		HasStr  bool     `json:"hasStr"`
		HasByte bool     `json:"hasByte"`
		// 该用例在建好 joiner 之后又调了两次 EnsureNewlineAtEnd（Fixture 必须显式记录调用序列，
		// 否则测试端无从得知，只能看着长度 3 != 4 猜）
		EnsureNewline bool `json:"ensureNewline,omitempty"`
	}
	var joinerCases []joinerCase
	seqs := []struct {
		strs []string
		bs   [][]byte
	}{
		{[]string{"a", "bc"}, nil},
		{nil, [][]byte{{1, 2}, {3}}},
		{[]string{"x"}, [][]byte{{0xff}}},
		{[]string{"", "tail"}, nil},
	}
	for _, s := range seqs {
		var j helpers.Joiner
		for _, str := range s.strs {
			j.AddString(str)
		}
		for _, b := range s.bs {
			j.AddBytes(b)
		}
		bsHex := []string{}
		for _, b := range s.bs {
			bsHex = append(bsHex, hex.EncodeToString(b))
		}
		joinerCases = append(joinerCases, joinerCase{
			Strings: s.strs, Bytes: bsHex, Length: j.Length(), Last: j.LastByte(),
			Done: hex.EncodeToString(j.Done()), HasStr: j.Contains("bc", nil),
			HasByte: j.Contains("", []byte{3}),
		})
	}
	// EnsureNewlineAtEnd
	{
		var j helpers.Joiner
		j.AddString("abc")
		j.EnsureNewlineAtEnd()
		j.EnsureNewlineAtEnd()
		joinerCases = append(joinerCases, joinerCase{
			Strings: []string{"abc"}, Length: j.Length(), Last: j.LastByte(),
			Done:          hex.EncodeToString(j.Done()),
			EnsureNewline: true,
			// 这里也必须**实测**，不能留零值冒充期望值（上一版就是因此把 hasStr 写成了 false）
			HasStr:  j.Contains("bc", nil),
			HasByte: j.Contains("", []byte{3}),
		})
	}

	// ---- TypoDetector ----
	type typoCase struct {
		Valid   []string `json:"valid"`
		Queries []string `json:"queries"`
		Results []string `json:"results"` // 命中时是纠正结果，否则空串
		Oks     []bool   `json:"oks"`
	}
	det := helpers.MakeTypoDetector([]string{"esnext", "es2015", "node", "browser"})
	queries := []string{"esnxt", "esnext", "es2015", "es215", "nod", "ndoe", "browsr", "xyz", ""}
	tc := typoCase{Valid: []string{"esnext", "es2015", "node", "browser"}, Queries: queries}
	for _, q := range queries {
		r, ok := det.MaybeCorrectTypo(q)
		tc.Results = append(tc.Results, r)
		tc.Oks = append(tc.Oks, ok)
	}

	// ---- 字符串数组 / %q 引号 ----
	type strCase struct {
		A      []string   `json:"a"`
		B      []string   `json:"b"`
		Eq     bool       `json:"eq"`
		AA     [][]string `json:"aa"`
		BB     [][]string `json:"bb"`
		AAEq   bool       `json:"aaEq"`
		Joined string     `json:"joined"`
	}
	var strCases []strCase
	strPairs := [][2][]string{
		{[]string{"a", "b"}, []string{"a", "b"}},
		{[]string{"a"}, []string{"a", "b"}},
		{nil, nil},
	}
	for _, p := range strPairs {
		strCases = append(strCases, strCase{
			A: p[0], B: p[1], Eq: helpers.StringArraysEqual(p[0], p[1]),
			AA: [][]string{p[0]}, BB: [][]string{p[1]},
			AAEq: helpers.StringArrayArraysEqual([][]string{p[0]}, [][]string{p[1]}),
			Joined: helpers.StringArrayToQuotedCommaSeparatedString(p[0]),
		})
	}
	// %q 边界：控制字符、引号、反斜杠、非 ASCII、不可打印
	special := []string{"plain", "with space", "quote\"inside", "back\\slash",
		"tab\tnewline\n", "\x00\x1f", "héllo", "日本", "😀", "\u00a0nbsp", "\u200bzwsp"}
	for _, s := range special {
		strCases = append(strCases, strCase{
			A: []string{s}, Joined: helpers.StringArrayToQuotedCommaSeparatedString([]string{s}),
			Eq: true, AAEq: true,
		})
	}

	out := map[string]interface{}{
		"source":       "esbuild internal/helpers (Go, commit f6058f83)",
		"floatUnary":   floatCases,
		"floatBinary":  binaryCases,
		"hash":         hashCases,
		"hashString":   hashStrCases,
		"escape":       escCases,
		"bitset":       bitCases,
		"joiner":       joinerCases,
		"typo":         tc,
		"strings":      strCases,
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", " ")
	if err := enc.Encode(out); err != nil {
		panic(err)
	}
}
