// gen_xxhash_fixture.go 生成 xxhash 的差分测试基准数据：
// 用真正的 Go 实现算出期望值，TS 移植版必须逐字节一致。
//
// 用法（须放在 esbuild 模块内，因为 import 了 internal 包）：
//   cd /root/esbuild && go run ./tmpgen > /root/port/testdata/xxhash.json
package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"

	"github.com/evanw/esbuild/internal/xxhash"
)

type Case struct {
	Name        string `json:"name"`
	Hex         string `json:"hex"`         // 输入字节的 hex
	Sum64       string `json:"sum64"`       // 一次性 Sum64 结果（16 位 hex）
	Chunks      []int  `json:"chunks"`      // 分块写入的大小序列
	ChunkSum64  string `json:"chunkSum64"`  // 分块写入后的 Sum64
	Marshaled   string `json:"marshaled"`   // MarshalBinary 结果 hex
	Remarshaled string `json:"remarshaled"` // Unmarshal 后再 Marshal
}

func main() {
	var cases []Case
	add := func(name string, data []byte, chunks []int) {
		sum := xxhash.Sum64(data)

		d := xxhash.New()
		off := 0
		for _, n := range chunks {
			if off >= len(data) {
				break
			}
			end := off + n
			if end > len(data) {
				end = len(data)
			}
			d.Write(data[off:end])
			off = end
		}
		if off < len(data) {
			d.Write(data[off:])
		}
		chunkSum := d.Sum64()

		marshaled, err := d.MarshalBinary()
		if err != nil {
			panic(err)
		}

		// 反序列化到新的 Digest，再 Marshal 一遍，验证状态完全可复现
		var d2 xxhash.Digest
		if err := d2.UnmarshalBinary(marshaled); err != nil {
			panic(err)
		}
		remarshaled, err := d2.MarshalBinary()
		if err != nil {
			panic(err)
		}
		// 反序列化后的 digest 继续写入剩余数据，结果必须与原始一致
		if d2.Sum64() != chunkSum {
			panic("unmarshal state mismatch for " + name)
		}

		cases = append(cases, Case{
			Name:        name,
			Hex:         hex.EncodeToString(data),
			Sum64:       fmt.Sprintf("%016x", sum),
			Chunks:      chunks,
			ChunkSum64:  fmt.Sprintf("%016x", chunkSum),
			Marshaled:   hex.EncodeToString(marshaled),
			Remarshaled: hex.EncodeToString(remarshaled),
		})
	}

	// 边界长度：0..70 全覆盖，跨越 32 字节 block 边界
	for n := 0; n <= 70; n++ {
		data := make([]byte, n)
		for i := range data {
			data[i] = byte(i*7 + 13)
		}
		add(fmt.Sprintf("pattern-%02d", n), data, []int{1, 2, 3, 5, 8})
	}

	// 伪随机语料（固定种子，可复现）
	rng := rand.New(rand.NewSource(12345))
	for i := 0; i < 20; i++ {
		n := rng.Intn(300)
		data := make([]byte, n)
		rng.Read(data)
		chunks := []int{rng.Intn(31) + 1, rng.Intn(31) + 1, rng.Intn(31) + 1}
		add(fmt.Sprintf("random-%02d-len%d", i, n), data, chunks)
	}

	// 全零 / 全 0xff，检验掩码
	add("zeros-128", make([]byte, 128), []int{32})
	ff := make([]byte, 96)
	for i := range ff {
		ff[i] = 0xff
	}
	add("ones-96", ff, []int{7, 11, 32})

	out := map[string]interface{}{
		"source": "esbuild internal/xxhash (Go, commit f6058f83)",
		"cases":  cases,
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", " ")
	if err := enc.Encode(out); err != nil {
		panic(err)
	}
}
