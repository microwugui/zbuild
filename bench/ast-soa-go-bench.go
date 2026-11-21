// AST representation memory microbenchmark (Go), run standalone: `go run ast-soa-go-bench.go N`.
// Question: does the compact/SoA AST representation that helps Rust/Zig (Bun/Oxc)
// also reduce memory in Go — i.e. is the "representation" idea language-agnostic?
// Constructs an isomorphic workload: a binary-expression tree with identifier leaves,
// plus a symbol table. Three representations, all producing the same logical tree:
//   A esbuild:  Expr{Data E(interface), Loc value}, each concrete node heap-allocated
//   B compact:  single flat struct with kind tag + inline fields, no interface, no per-node alloc
//   C SoA:      parallel typed arrays (kind/loc/a/b/op) + integer indices, contiguous
// Measures surviving heap (HeapAlloc after GC) and cumulative TotalAlloc.
package main

import (
	"fmt"
	"os"
	"runtime"
	"strconv"
	"unsafe"
)

type Loc struct{ Start int32 }

// ---------- A: esbuild current representation ----------
type E interface{ isExpr() }
type Expr struct {
	Data E
	Loc  Loc
}
type EBinary struct {
	Left  Expr
	Right Expr
	Op    int32
}
type EIdent struct{ Ref int32 }
func (*EBinary) isExpr() {}
func (*EIdent) isExpr()  {}

func buildA(n int) []Expr {
	nodes := make([]Expr, n)
	for i := 0; i < n; i++ {
		loc := Loc{Start: int32(i)}
		if i < 2 {
			nodes[i] = Expr{Data: &EIdent{Ref: int32(i)}, Loc: loc}
		} else {
			// binary node referencing two prior nodes (by value copy of Expr header)
			nodes[i] = Expr{Data: &EBinary{Left: nodes[i-1], Right: nodes[i-2], Op: 1}, Loc: loc}
		}
	}
	return nodes
}

// ---------- B: compact flat struct, no interface ----------
type FlatNode struct {
	Kind int32 // 0=ident 1=binary
	Loc  int32
	A    int32 // child index or ref
	B    int32 // child index
	Op   int32
}

func buildB(n int) []FlatNode {
	nodes := make([]FlatNode, n)
	for i := 0; i < n; i++ {
		if i < 2 {
			nodes[i] = FlatNode{Kind: 0, Loc: int32(i), A: int32(i)}
		} else {
			nodes[i] = FlatNode{Kind: 1, Loc: int32(i), A: int32(i - 1), B: int32(i - 2), Op: 1}
		}
	}
	return nodes
}

// ---------- C: SoA — parallel typed arrays ----------
type SoA struct {
	kind []int32
	loc  []int32
	a    []int32
	b    []int32
	op   []int32
}

func buildC(n int) *SoA {
	s := &SoA{
		kind: make([]int32, n), loc: make([]int32, n),
		a: make([]int32, n), b: make([]int32, n), op: make([]int32, n),
	}
	for i := 0; i < n; i++ {
		s.loc[i] = int32(i)
		if i < 2 {
			s.kind[i], s.a[i] = 0, int32(i)
		} else {
			s.kind[i], s.a[i], s.b[i], s.op[i] = 1, int32(i-1), int32(i-2), 1
		}
	}
	return s
}

var sink interface{}

func measure(tag string, build func(int) interface{}, n int) {
	runtime.GC()
	var m0, m1, m2 runtime.MemStats
	runtime.ReadMemStats(&m0)
	x := build(n)
	sink = x // keep alive across GC
	runtime.ReadMemStats(&m1)
	total := int64(m1.TotalAlloc) - int64(m0.TotalAlloc)
	runtime.GC() // x still reachable via sink
	runtime.ReadMemStats(&m2)
	live := int64(m2.HeapAlloc) - int64(m0.HeapAlloc)
	fmt.Printf("%-10s live=%8.2f MB  totalalloc=%8.2f MB  bytes/node(live)=%6.1f B/node(alloc)=%6.1f\n",
		tag, float64(live)/1048576, float64(total)/1048576, float64(live)/float64(n), float64(total)/float64(n))
}

func main() {
	n := 1000000
	if len(os.Args) > 1 {
		if v, e := strconv.Atoi(os.Args[1]); e == nil {
			n = v
		}
	}
	fmt.Printf("nodes=%d  sizeof: Expr=%d EBinary=%d EIdent=%d FlatNode=%d Loc=%d\n",
		n, unsafe.Sizeof(Expr{}), unsafe.Sizeof(EBinary{}), unsafe.Sizeof(EIdent{}), unsafe.Sizeof(FlatNode{}), unsafe.Sizeof(Loc{}))
	mode := ""
	for _, a := range os.Args[1:] { if a=="--a"||a=="--b"||a=="--c" { mode=a } }
	switch mode {
	case "--a": measure("A-esbuild", func(n int) interface{} { return buildA(n) }, n)
	case "--b": measure("B-compact", func(n int) interface{} { return buildB(n) }, n)
	case "--c": measure("C-SoA", func(n int) interface{} { return buildC(n) }, n)
	default:
		measure("A-esbuild", func(n int) interface{} { return buildA(n) }, n)
		measure("B-compact", func(n int) interface{} { return buildB(n) }, n)
		measure("C-SoA", func(n int) interface{} { return buildC(n) }, n)
	}
}
