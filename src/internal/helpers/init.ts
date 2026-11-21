// 节点/对象构造辅助：替代 `Object.assign(new X(), {...})`。
//
// 根因（PLAN.md 第 17 次推进 §3.1）：`Object.assign` 对 source 不做字段名校验，
// 字段名写错、或节点根本没有这个字段时会**静默丢弃**。Go 用结构体字面量，
// 编译器天生会检查。`init<T>(node, ...sources: Partial<T>[])` 让 tsc 把
// 未知字段名报成错误（`Partial<T>` 的键集合受 T 约束），同时保留就地初始化的写法。
//
// 约定：parser / printer / logger 里新建带字段的对象一律用 `init(new X(), {...})`，
// 不再直接写 `Object.assign(new X(), {...})`（`npm run assign:gate` 会守住这条线）。

export function init<T extends object>(node: T, ...sources: Partial<T>[]): T {
  return Object.assign(node, ...sources);
}
