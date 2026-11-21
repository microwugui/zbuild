// 1:1 移植自 esbuild internal/test/diff.go（v0.28.2，commit f6058f83）
// 纯算法三函数：diff / diffRec / lcSubstr。逐字节真值表由 Go 探针固化在
// testdata/test-diff-go.json（16 例：color true/false，含空串/删除/插入/最长公共子串）。
import { TerminalColors } from "../logger/logger.ts";

/** Go: func diff(old string, new string, color bool) string (diff.go:10) */
export function diff(old: string, newStr: string, color: boolean): string {
  return diffRec([], old.split("\n"), newStr.split("\n"), color).join("\n");
}

/** Go: func diffRec(result []string, old []string, new []string, color bool) []string (diff.go:15) */
export function diffRec(result: string[], old: string[], newStr: string[], color: boolean): string[] {
  const [o, n, common] = lcSubstr(old, newStr);
  if (common === 0) {
    for (const line of old) result.push(color ? `${TerminalColors.Red}-${line}${TerminalColors.Reset}` : "-" + line);
    for (const line of newStr) result.push(color ? `${TerminalColors.Green}+${line}${TerminalColors.Reset}` : "+" + line);
  } else {
    diffRec(result, old.slice(0, o), newStr.slice(0, n), color);
    for (const line of old.slice(o, o + common)) result.push(color ? `${TerminalColors.Dim} ${line}${TerminalColors.Reset}` : " " + line);
    diffRec(result, old.slice(o + common), newStr.slice(n + common), color);
  }
  return result;
}

/** Go: func lcSubstr(S []string, T []string) (int, int, int) (diff.go:51) */
export function lcSubstr(S: string[], T: string[]): [number, number, number] {
  const r = S.length, n = T.length;
  let Lprev = new Array<number>(n).fill(0), Lnext = new Array<number>(n).fill(0);
  let z = 0, retI = 0, retJ = 0;
  for (let i = 0; i < r; i++) {
    for (let j = 0; j < n; j++) {
      if (S[i] === T[j]) {
        Lnext[j] = j === 0 ? 1 : Lprev[j - 1] + 1;
        if (Lnext[j] > z) { z = Lnext[j]; retI = i + 1; retJ = j + 1; }
      } else Lnext[j] = 0;
    }
    [Lprev, Lnext] = [Lnext, Lprev]; // Go: Lprev, Lnext = Lnext, Lprev
  }
  return [retI - z, retJ - z, z];
}
