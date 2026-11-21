#!/usr/bin/env python3
# 机械翻译 internal/runtime/runtime.go 的 Source() 函数体为 TS。
# Go raw string（反引号）内容无反斜杠、无 ${，可 1:1 映射到 JS 模板字面量。
import re, sys
go = open("/root/esbuild/internal/runtime/runtime.go", encoding="utf-8").read()
# 取函数体：从 'text := `' 到 'return logger.Source{'
start = go.index("text := `")
end = go.index("\treturn logger.Source{", start)
body = go[start:end]
# 按反引号切分：偶数段=代码，奇数段=模板内容
parts = body.split("`")
assert len(parts) % 2 == 1, "unbalanced backticks"
def tx(code):
    # 复合条件先替换（顺序敏感）
    code = code.replace("!unsupportedJSFeatures.Has(compat.ForOf) && !unsupportedJSFeatures.Has(compat.ConstAndLet)", "noForOf && noConstLet")
    code = code.replace("!unsupportedJSFeatures.Has(compat.ObjectExtensions) && !unsupportedJSFeatures.Has(compat.ObjectAccessors)", "noObjExt && noObjAccessors")
    code = code.replace("!unsupportedJSFeatures.Has(compat.ForOf)", "noForOf")
    code = code.replace("!unsupportedJSFeatures.Has(compat.ObjectAccessors)", "noObjAccessors")
    code = code.replace("text := ", "let text = ")
    # if <cond> {  ->  if (<cond>) {
    code = re.sub(r"if (noForOf && noConstLet|noObjExt && noObjAccessors|noForOf|noObjAccessors) \{", r"if (\1) {", code)
    return code
out = []
for i, p in enumerate(parts):
    if i % 2 == 0:
        out.append(tx(p))
    else:
        out.append("`" + p + "`")
ts_body = "".join(out)
header = '''// 1:1 机械翻译自 esbuild internal/runtime/runtime.go（commit f6058f83）的 Source()。
// 由 tools/go/gen_runtime_ts.py 从 Go 源码生成；逐字节证据 testdata/runtime-source-go.json
// （8 组 feature mask 全 Contents SHA 校验，含 three.js 的 esnext/mask=0）。
// 禁止手改：改 Go 源后重跑生成器。
import { JSFeature, Has as HasJS } from "../compat/compat.ts";
import { Source as LoggerSource, Path, PrettyPaths } from "../logger/logger.ts";

export const SourceIndex = 0;

/** Go: func Source(unsupportedJSFeatures compat.JSFeature) logger.Source (runtime.go:18) */
export function Source(unsupportedJSFeatures: bigint): LoggerSource {
  const noForOf = !HasJS(unsupportedJSFeatures, JSFeature.ForOf);
  const noConstLet = !HasJS(unsupportedJSFeatures, JSFeature.ConstAndLet);
  const noObjExt = !HasJS(unsupportedJSFeatures, JSFeature.ObjectExtensions);
  const noObjAccessors = !HasJS(unsupportedJSFeatures, JSFeature.ObjectAccessors);
'''
footer = '''  const src = new LoggerSource();
  src.Index = SourceIndex;
  src.KeyPath = new Path(); src.KeyPath.Text = "<runtime>";
  src.PrettyPaths = new PrettyPaths(); src.PrettyPaths.Abs = "<runtime>"; src.PrettyPaths.Rel = "<runtime>";
  src.IdentifierName = "runtime";
  src.Contents = new TextEncoder().encode(text);
  return src;
}
'''
full = header + ts_body + footer
open("src/internal/runtime/runtime.ts", "w", encoding="utf-8").write(full)
print("wrote runtime.ts bytes=", len(full.encode()))
print("branches:", ts_body.count("if ("))
