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
// Correctness guards (this round widened coverage to `with` scopes):
//   - with-scope side effects are reproduced exactly: each frame records the
//     count of ScopeWith frames below it, so isInsideWithScope (which gates
//     MustKeepDueToWithStmt and MustNotBeRenamed) is computed in O(1) for the
//     currentScope..declaringScope path, matching findSymbolSlow.
//   - "arguments" references fall back to the slow path (ForbidArguments is
//     set dynamically during the visit pass and only affects that name).
//   - decoratorScope jumps change p.currentScope directly off the DFS stack;
//     a guard (currentScope == top frame scope) sends those lookups to the slow
//     path, and the stack self-heals after the decorator visit.
//   - Class scopes remain excluded (dynamic innerClassName members /
//     ForbidArguments desync the snapshot stack); TS files remain excluded
//     (namespace-alias side effects). Both stay byte-identical via fallback.
//   - fastSymVerify (env GOPORT_FASTSYM_VERIFY=1) runs BOTH paths and panics on
//     any ref/declareLoc/insideWith mismatch: a machine-checked proof over the
//     whole test suite and all corpora.

import (
	"os"

	"github.com/evanw/esbuild/internal/ast"
	"github.com/evanw/esbuild/internal/js_ast"
	"github.com/evanw/esbuild/internal/logger"
)

type fastScopeFrame struct {
	scope     *js_ast.Scope
	added     []string // names pushed by this frame (for exact rollback)
	isWith    int      // 1 if scope.Kind == ScopeWith
	withBefore int     // number of ScopeWith frames strictly below this frame
}

// Called once, lazily, on the first findSymbol of a file (visit pass, after
// hoistSymbols and all module-scope modifications are done).
func (p *parser) fastInit() {
	if p.fastSymInit {
		return
	}
	p.fastSymInit = true
	p.fastSymVerify = os.Getenv("GOPORT_FASTSYM_VERIFY") != ""

	// Conservative: TS files have decoratorScope jumps and namespace-alias side
	// effects. Keep them on the original path (widened in a later round).
	if p.options.ts.Parse || !fastBindFileIsSafe(p.moduleScope) {
		return
	}

	p.fastVis = make(map[string][]*fastScopeFrame)
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

// With scopes are allowed on the fast path (isInsideWithScope is reproduced
// exactly via per-frame with counts). Class scopes are still excluded: they
// add members (innerClassName) and set ForbidArguments dynamically mid-visit,
// which desyncs a snapshot stack and broke byte-exactness in testing. TS files
// are excluded separately for namespace-alias side effects.
func fastBindFileIsSafe(root *js_ast.Scope) bool {
	if root == nil {
		return false
	}
	var visit func(*js_ast.Scope) bool
	visit = func(s *js_ast.Scope) bool {
		// Class scopes add members (innerClassName) and set ForbidArguments
		// dynamically during the visit pass, desyncing the snapshot stack.
		switch s.Kind {
		case js_ast.ScopeClassName, js_ast.ScopeClassBody, js_ast.ScopeClassStaticInit:
			return false
		}
		if s.TSNamespace != nil {
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
	withBefore := 0
	if n := len(p.fastFrames); n > 0 {
		top := p.fastFrames[n-1]
		withBefore = top.withBefore + top.isWith
	}
	frame := &fastScopeFrame{scope: scope, withBefore: withBefore}
	if scope.Kind == js_ast.ScopeWith {
		frame.isWith = 1
	}
	scope.Members.ForEach(func(name string, _ js_ast.ScopeMember) {
		p.fastVis[name] = append(p.fastVis[name], frame)
		frame.added = append(frame.added, name)
	})
	p.fastFrames = append(p.fastFrames, frame)
}

// Pop the top scope frame, removing exactly the names it pushed.
func (p *parser) fastPop() {
	f := p.fastFrames[len(p.fastFrames)-1]
	for i := len(f.added) - 1; i >= 0; i-- {
		name := f.added[i]
		stack := p.fastVis[name]
		stack = stack[:len(stack)-1] // top must be this frame (DFS discipline)
		if len(stack) == 0 {
			delete(p.fastVis, name)
		} else {
			p.fastVis[name] = stack
		}
	}
	p.fastFrames = p.fastFrames[:len(p.fastFrames)-1]
}

// fastFind returns the ref/declareLoc for `name` in O(1) using the shadow
// stack, plus whether the currentScope..declaringScope path crosses a with
// scope. The bool ok is false if the name is not visible on the current path.
func (p *parser) fastFind(name string) (ref ast.Ref, declareLoc logger.Loc, insideWith bool, ok bool) {
	stack := p.fastVis[name]
	if len(stack) == 0 {
		return ast.Ref{}, logger.Loc{}, false, false
	}
	f := stack[len(stack)-1]
	member, found := f.scope.Members.Get(name)
	if !found {
		return ast.Ref{}, logger.Loc{}, false, false
	}
	// currentScope is the top frame (guarded by the caller). The walked path in
	// findSymbolSlow covers frames [f .. top]; count ScopeWith frames there.
	top := p.fastFrames[len(p.fastFrames)-1]
	insideWith = (top.withBefore + top.isWith) > f.withBefore
	return member.Ref, member.Loc, insideWith, true
}

// findSymbolUnbound is true when a name is declared somewhere on the current
// DFS stack — used to decide whether the fast path can serve a lookup at all.
func (p *parser) fastStackIsCurrent() bool {
	if len(p.fastFrames) == 0 {
		return false
	}
	return p.fastFrames[len(p.fastFrames)-1].scope == p.currentScope
}

// findSymbolPure mirrors findSymbol's pure chain walk with NO side effects:
// no error logging, no symbol creation, no recordUsage, no flags. Used only by
// the equivalence verifier. Returns ok=false for what would be an unbound ref.
func (p *parser) findSymbolPure(name string) (ref ast.Ref, declareLoc logger.Loc, insideWith bool, ok bool) {
	for s := p.currentScope; s != nil; s = s.Parent {
		if s.Kind == js_ast.ScopeWith {
			insideWith = true
		}
		if member, found := s.Members.Get(name); found {
			return member.Ref, member.Loc, insideWith, true
		}
	}
	return ast.Ref{}, logger.Loc{}, false, false
}
