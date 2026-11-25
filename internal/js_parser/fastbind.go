package js_parser

// goport exp-declbind prototype (local, rollback-safe).
//
// Declaration-time symbol resolution: during the visit pass the parser walks
// the scope tree in strict DFS order via pushScopeForVisitPass/popScope. We
// maintain a global "shadow stack" per name: for the set of scopes on the
// current DFS path that declare `name`, the innermost one sits on top.
//
// findSymbol then becomes O(1): look at the top scope for `name` and read its
// Members entry. This removes the O(depth) parent-chain walk that is the root
// of the deep12k O(n^2) hotspot. Unlike the previously-refuted "one map per
// scope" cache, total storage is O(number of declarations) because each scope
// member is pushed once and popped once, and we store scope POINTERS (reading
// Members fresh at lookup time, so later mutations are visible).
//
// Correctness guards:
//   - Enabled only on files that are safe (no `with`, no class scopes whose
//     ForbidArguments/`arguments` errors fire mid-visit, no TS namespace
//     aliases) — see fastBindFileIsSafe. Otherwise everything falls back to
//     the original chain walk, byte-identical by construction.
//   - fastSymVerify (env GOPORT_FASTSYM_VERIFY=1) runs BOTH paths and panics on
//     any ref/declareLoc mismatch, giving a machine-checked equivalence proof
//     over the whole test suite and all corpora.

import (
	"os"

	"github.com/evanw/esbuild/internal/ast"
	"github.com/evanw/esbuild/internal/js_ast"
	"github.com/evanw/esbuild/internal/logger"
)

type fastScopeFrame struct {
	scope *js_ast.Scope
	added []string // names pushed by this frame (for exact rollback)
}

// Called once, lazily, on the first findSymbol of a file (visit pass, after
// hoistSymbols and all module-scope modifications are done).
func (p *parser) fastInit() {
	if p.fastSymInit {
		return
	}
	p.fastSymInit = true
	p.fastSymVerify = os.Getenv("GOPORT_FASTSYM_VERIFY") != ""

	// Conservative: TS files have decoratorScope jumps and more findSymbol
	// side effects (namespace aliases). Keep them on the original path.
	if p.options.ts.Parse || !fastBindFileIsSafe(p.moduleScope) {
		return
	}

	p.fastVis = make(map[string][]*js_ast.Scope)
	// Rebuild the path from the module scope down to the current scope by
	// walking parents. This handles scopes pushed before the first findSymbol.
	chain := make([]*js_ast.Scope, 0, 16)
	for s := p.currentScope; s != nil; s = s.Parent {
		chain = append(chain, s)
	}
	for i := len(chain) - 1; i >= 0; i-- {
		p.fastPush(chain[i])
	}
	p.fastSymOn = true
}

// A file is safe for the O(1) path iff no scope can trigger findSymbol's
// side effects while walking the chain: `with`, class scopes (which set
// ForbidArguments mid-visit and create inner-class members), or TS namespace
// aliases. In those rare files we keep the original behavior.
func fastBindFileIsSafe(root *js_ast.Scope) bool {
	if root == nil {
		return false
	}
	var visit func(*js_ast.Scope) bool
	visit = func(s *js_ast.Scope) bool {
		switch s.Kind {
		case js_ast.ScopeWith, js_ast.ScopeClassName, js_ast.ScopeClassBody, js_ast.ScopeClassStaticInit:
			return false
		}
		if s.ForbidArguments || s.TSNamespace != nil {
			return false
		}
		for _, c := range s.Children {
			if !visit(c) {
				return false
			}
		}
		return true
	}
	return visit(root)
}

// Push a scope's members onto the shadow stack.
func (p *parser) fastPush(scope *js_ast.Scope) {
	frame := fastScopeFrame{scope: scope}
	scope.Members.ForEach(func(name string, _ js_ast.ScopeMember) {
		p.fastVis[name] = append(p.fastVis[name], scope)
		frame.added = append(frame.added, name)
	})
	p.fastFrames = append(p.fastFrames, frame)
}

// Pop the top scope frame, removing exactly the names it pushed.
func (p *parser) fastPop() {
	f := &p.fastFrames[len(p.fastFrames)-1]
	for i := len(f.added) - 1; i >= 0; i-- {
		name := f.added[i]
		stack := p.fastVis[name]
		stack = stack[:len(stack)-1] // top must be this frame's scope (DFS discipline)
		if len(stack) == 0 {
			delete(p.fastVis, name)
		} else {
			p.fastVis[name] = stack
		}
	}
	p.fastFrames = p.fastFrames[:len(p.fastFrames)-1]
}

// fastFind returns the ref/declareLoc for `name` in O(1) using the shadow
// stack. The bool is false if the name is not visible on the current path.
func (p *parser) fastFind(name string) (ref ast.Ref, declareLoc logger.Loc, ok bool) {
	stack := p.fastVis[name]
	if len(stack) == 0 {
		return ast.Ref{}, logger.Loc{}, false
	}
	top := stack[len(stack)-1]
	member, found := top.Members.Get(name)
	if !found {
		return ast.Ref{}, logger.Loc{}, false
	}
	return member.Ref, member.Loc, true
}

// findSymbolPure mirrors findSymbol's pure chain walk with NO side effects:
// no error logging, no symbol creation, no recordUsage, no flags. Used only by
// the equivalence verifier. Returns ok=false for what would be an unbound ref.
func (p *parser) findSymbolPure(name string) (ref ast.Ref, declareLoc logger.Loc, ok bool) {
	for s := p.currentScope; s != nil; s = s.Parent {
		if member, found := s.Members.Get(name); found {
			return member.Ref, member.Loc, true
		}
	}
	return ast.Ref{}, logger.Loc{}, false
}
