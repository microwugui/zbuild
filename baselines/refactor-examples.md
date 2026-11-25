# 已重构点的可读性速览

只收录**已经重构并保留在分支里**的改动（证伪回滚的实验不放）。
每个给「改前 / 改后」最小示意，不要求编译通过，只看改完长什么样、好不好读。

- 重构点 1 在 `exp-declbind` @ ecdf55c
- 重构点 2 在 `exp-expr` @ 8109497

---

## 重构点 1：findSymbol 声明期符号解析（遮蔽栈）

### 改前：查找 = 沿父链爬，每层检查
```go
func (p *parser) findSymbol(name string) Result {
    ref, declareLoc := Ref{}, Loc{}
    insideWith := false
    for s := p.currentScope; s != nil; s = s.Parent {
        if s.Kind == ScopeWith { insideWith = true }   // with 副作用
        if m, ok := s.Members.Get(name); ok {
            ref, declareLoc = m.Ref, m.Loc
            break
        }
    }
    if insideWith { /* 标记不可重命名 */ }
    p.recordUsage(ref)
    return Result{ref, declareLoc, insideWith}
}
```
深嵌套每层引用外层变量 → 每层都爬 N 层 → O(N²)。

### 改后：访问 pass 进出 scope 时维护遮蔽栈，查找取栈顶
```go
// 数据结构：每个 name 一个栈，栈顶 = 当前路径上最内层声明它的 scope
vis map[string][]*Scope

// 访问 pass 进入 scope：把这个 scope 声明的 name 压栈（fastbind.go）
func (p *parser) fastPush(scope *Scope) {
    f := &frame{scope: scope}
    f.withBefore = 当前 with 前缀计数
    if scope.Kind == ScopeWith { f.isWith = 1 }
    for name := range scope.Members {
        p.vis[name] = append(p.vis[name], f)
        f.added = append(f.added, name)      // 记下来，退出时精确弹
    }
    p.frames = append(p.frames, f)
}

// 退出 scope：弹掉这次压的
func (p *parser) fastPop() {
    f := 栈顶 frame
    for name := range f.added { p.vis[name] = p.vis[name][:len-1] }
    p.frames = p.frames[:len-1]
}

// 查找：O(1)
func (p *parser) findSymbol(name string) Result {
    if p.fastOn && name != "arguments" && p.currentScope == 栈顶frame.scope {
        f := 栈顶(p.vis[name])               // 最内层声明处
        m := f.scope.Members.Get(name)
        insideWith := (top.withBefore + top.isWith) > f.withBefore  // with 副作用 O(1) 模拟
        if p.verify { 断言 f === 原爬链结果 }  // 双算断言护栏
        if insideWith { 标记不可重命名 }
        p.recordUsage(m.Ref)
        return Result{m.Ref, m.Loc, insideWith}
    }
    return p.findSymbolSlow(name)            // 不安全文件 / arguments 回退原逻辑
}
```

**可读性自评**：
- 好的地方：`findSymbol` 主体从"for 爬链"变成"取栈顶"，查找意图一眼可见；
  原爬链完整保留为 `findSymbolSlow` 兜底，读者能对照。
- 需要想一下的地方：
  1. `insideWith := (top.withBefore + top.isWith) > f.withBefore` 这个前缀计数不等式
     ——建议封成 `crossesWith(from, to)` 命名函数，比裸表达式好读。
  2. 快路径依赖"访问 pass 是 DFS、`fastPush/fastPop` 与 scope 进出严格配对"这个隐含前提，
     代码里只有注释说明，最好在 `fastPush` 处加断言（已部分有 `fastStackIsCurrent` 守卫）。
  3. 门控条件 `name != "arguments" && p.currentScope == 栈顶` 挤在一行，
     拆成具名小函数（如 `canUseFastPath(name)`）会更清楚。

---

## 重构点 2：object 字面量 properties 预分配

### 改前
```go
case TOpenBrace:                       // 解析 { ... }
    properties := []js_ast.Property{} // 零容量，append 时 1→2→4 反复扩容复制
    for ... {
        properties = append(properties, parseProperty())
    }
```

### 改后
```go
case TOpenBrace:
    properties := make([]js_ast.Property, 0, 4)  // 一次给 4 个槽，省掉前几轮复制
    for ... {
        properties = append(properties, parseProperty())
    }
```

**可读性自评**：改动就 1 行，无新增抽象，可读性零负担；`0, 4` 的意图靠一行注释说明
（"object 通常 ≤4 属性"）。这是全会话性价比最高的重构——最难的部分是找到该改哪一行
（靠 pprof 定位到 196MB 的 `properties=append`），而不是改动本身。

---

## 一句话总结
两个已重构点里，查找重构（点1）改变了控制流结构、可读性中等偏上但有几个表达式值得再封装；
预分配（点2）是零抽象的一行改动、可读性最好且收益最大。若要提升可读性，优先给点1的
with 判断和门控条件抽具名函数。
