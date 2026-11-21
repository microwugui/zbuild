// 1:1 移植自 esbuild internal/helpers/stack.go（v0.28.2）
// Go 用 runtime/debug.Stack()；TS 用 Error.stack。格式不同，只保留同样的抽取规则。

/** Go: func PrettyPrintedStack() string */
export function PrettyPrintedStack(): string {
  const stack = (new Error().stack ?? "").trim();
  let lines = stack.split("\n");

  // 去掉首行 "Error" / "Error: msg"
  if (lines.length > 0 && /^Error/.test(lines[0])) lines = lines.slice(1);

  let sb = "";
  for (let line of lines) {
    line = line.trim();
    // Node 的栈帧： "at fn (/path/file.ts:1:2)" 或 "at /path/file.ts:1:2"
    if (line.startsWith("at ")) {
      line = line.slice(3);
      const paren = line.lastIndexOf("(");
      if (paren !== -1 && line.endsWith(")")) {
        const fn = line.slice(0, paren).trim();
        const loc = line.slice(paren + 1, -1);
        if (sb.length > 0) sb += "\n";
        sb += stripPath(fn) + " (" + stripPath(loc) + ")";
        continue;
      }
      if (sb.length > 0) sb += "\n";
      sb += stripPath(line);
      continue;
    }
    if (sb.length > 0) sb += "\n";
    sb += stripPath(line);
  }
  return sb;
}

function stripPath(line: string): string {
  // 去掉仓库绝对路径前缀，只留下 esbuild 内部相对路径
  const idx = line.indexOf("src/internal/");
  if (idx !== -1) return line.slice(idx);
  const idx2 = line.indexOf("internal/");
  if (idx2 !== -1) return line.slice(idx2);
  const idx3 = line.indexOf("src/");
  if (idx3 !== -1) return line.slice(idx3);
  return line;
}
