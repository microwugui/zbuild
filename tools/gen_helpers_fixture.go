// gen_helpers_fixture.go 用 Go 参考实现生成 helpers 中 utf/quote 的差分基准。
// 用法: cd /root/esbuild && go run ./tmpgen2 > /root/port/testdata/helpers.json
package main

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"unicode/utf8"

	"github.com/evanw/esbuild/internal/helpers"
)

type QuoteCase struct {
	Name        string `json:"name"`
	Hex         string `json:"hex"`
	Single      string `json:"single"`
	SingleASCII string `json:"singleAscii"`
	JSON        string `json:"json"`
	JSONASCII   string `json:"jsonAscii"`
}

type UTF16Case struct {
	Name         string   `json:"name"`
	Hex          string   `json:"hex"`
	UTF16        []uint16 `json:"utf16"`
	Back         string   `json:"back"`         // UTF16ToString(utf16)
	ValidBack    string   `json:"validBack"`    // UTF16ToStringWithValidation(utf16).value
	HasNonBMP    bool     `json:"hasNonBmp"`
	Valid        bool     `json:"valid"`
	BadRune      uint16   `json:"badRune"`
	EqualsString bool     `json:"equalsString"` // UTF16EqualsString(utf16, 原始字节)
	Synthetic    bool     `json:"synthetic"`    // 不是由 Hex 反推出来的用例
}

type DecodeCase struct {
	Name  string `json:"name"`
	Hex   string `json:"hex"`
	At    int    `json:"at"`
	R     int    `json:"r"`
	Width int    `json:"width"`
}

func h(s string) string { return hex.EncodeToString([]byte(s)) }

func main() {
	// 注意：Go 源码里不能写孤立代理的 \u 转义，用字节构造 WTF-8 序列
	loneHigh := string([]byte{0xED, 0xA0, 0x80}) // U+D800
	loneLow := string([]byte{0xED, 0xB0, 0x80})  // U+DC00

	texts := []string{
		"", "a", "abc", "a\"b", "a'b", "\\", "\n\t\r\b\f", "héllo", "日本語",
		"😀", "😀😀", "\uFEFF", "a</b>", "</script>", "\x00\x1f\x7f",
		loneHigh, loneLow, strings.Repeat("x", 40),
		"</SCRIPT>", "</ScRiPt >", "<\u2028>", "\u007f\u0080",
	}

	var quotes []QuoteCase
	for i, t := range texts {
		quotes = append(quotes, QuoteCase{
			Name:        "q" + itoa(i),
			Hex:         h(t),
			Single:      hex.EncodeToString(helpers.QuoteSingle(t, false)),
			SingleASCII: hex.EncodeToString(helpers.QuoteSingle(t, true)),
			JSON:        hex.EncodeToString(helpers.QuoteForJSON(t, false)),
			JSONASCII:   hex.EncodeToString(helpers.QuoteForJSON(t, true)),
		})
	}

	var utf16s []UTF16Case
	for i, t := range texts {
		u := helpers.StringToUTF16(t)
		validBack, badRune, ok := helpers.UTF16ToStringWithValidation(u)
		utf16s = append(utf16s, UTF16Case{
			Name:         "u" + itoa(i),
			Hex:          h(t),
			UTF16:        u,
			Back:         h(helpers.UTF16ToString(u)),
			ValidBack:    h(validBack),
			HasNonBMP:    helpers.ContainsNonBMPCodePoint(t),
			Valid:        ok,
			BadRune:      badRune,
			EqualsString: helpers.UTF16EqualsString(u, t),
		})
	}
	// 非法代理对：只校验验证函数，不参与 Hex ↔ UTF16 的往返断言
	bad := []uint16{0x61, 0xD800, 0x62}
	validBack, badRune, ok := helpers.UTF16ToStringWithValidation(bad)
	utf16s = append(utf16s, UTF16Case{
		Name: "invalid", UTF16: bad, Back: h(helpers.UTF16ToString(bad)),
		ValidBack: h(validBack), Valid: ok, BadRune: badRune, Synthetic: true,
	})

	// WTF-8 解码：逐个偏移
	var decodes []DecodeCase
	samples := []string{
		"abc", "é", "日本", "😀", loneHigh, loneLow,
		"\xC3", "\xE6\x97", "\xF0\x9F\x98", "\x80", "\xFF",
	}
	for si, s := range samples {
		for at := 0; at <= len(s); at++ {
			r, w := helpers.DecodeWTF8Rune(s[at:])
			rr := int(r)
			if r == utf8.RuneError {
				rr = 0xFFFD
			}
			decodes = append(decodes, DecodeCase{
				Name: "d" + itoa(si), Hex: h(s), At: at, R: rr, Width: w,
			})
		}
	}

	out := map[string]interface{}{
		"source":  "esbuild internal/helpers (Go, commit f6058f83)",
		"quotes":  quotes,
		"utf16":   utf16s,
		"decodes": decodes,
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", " ")
	if err := enc.Encode(out); err != nil {
		panic(err)
	}
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}
