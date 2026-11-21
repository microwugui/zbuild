// 1:1 移植自 esbuild internal/helpers/typos.go（v0.28.2）
// 该函数只处理配置项名称（ASCII），因此用 JS string 承载，按码点迭代。
// DEVIATION: 参数类型 string（UTF-16 码元）而非 UTF-8 字节；删除字符必须按**码点下标**删，
// 不能用 String.replace(ch, "")——Go 的 correct[:i]+correct[i+RuneLen(ch):] 删的是「第 i 个码点」。

/** Go: correct[:i] + correct[i+utf8.RuneLen(ch):] —— 按码点下标删一个字符 */
function removeRuneAt(s: string, index: number, runeLen: number): string {
  return s.slice(0, index) + s.slice(index + runeLen);
}

export class TypoDetector {
  oneCharTypos: Map<string, string>;

  constructor(oneCharTypos: Map<string, string>) {
    this.oneCharTypos = oneCharTypos;
  }

  /** Go: func (detector TypoDetector) MaybeCorrectTypo(typo string) (string, bool) */
  MaybeCorrectTypo(typo: string): { value: string; ok: boolean } {
    // 少了一个字符
    const direct = this.oneCharTypos.get(typo);
    if (direct !== undefined) return { value: direct, ok: true };

    // 多了一个字符（按码点下标逐个删，和 Go 的 typo[:i]+typo[i+RuneLen(ch):] 一致）
    let index = 0;
    for (const ch of typo) {
      const stripped = removeRuneAt(typo, index, ch.length);
      const corrected = this.oneCharTypos.get(stripped);
      if (corrected !== undefined) return { value: corrected, ok: true };
      index += ch.length;
    }
    return { value: "", ok: false };
  }
}

/** Go: func MakeTypoDetector(valid []string) TypoDetector */
export function MakeTypoDetector(valid: string[]): TypoDetector {
  const oneCharTypos = new Map<string, string>();
  for (const correct of valid) {
    if (correct.length > 3) {
      let index = 0;
      for (const ch of correct) {
        oneCharTypos.set(removeRuneAt(correct, index, ch.length), correct);
        index += ch.length;
      }
    }
  }
  return new TypoDetector(oneCharTypos);
}
