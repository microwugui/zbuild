// 1:1 移植自 esbuild internal/helpers/glob.go（v0.28.2，commit f6058f83）

/** Go: type GlobWildcard uint8 (internal/helpers/glob.go:5) */
export type GlobWildcard = number;
export const GlobWildcard = {
  /** Go: GlobNone */
  GlobNone: 0,
  /** Go: GlobAllExceptSlash */
  GlobAllExceptSlash: 1,
  /** Go: GlobAllIncludingSlash */
  GlobAllIncludingSlash: 2,
};

/** Go: type GlobPart struct (internal/helpers/glob.go:13) */
export class GlobPart {
  Prefix: string = "";
  Wildcard: GlobWildcard = GlobWildcard.GlobNone;
}

/**
 * Go: func ParseGlobPattern(text string) (pattern []GlobPart) (internal/helpers/glob.go:21)
 *
 * The returned array will always be at least one element. If there are no wildcards
 * then it will be exactly one element, and if there are wildcards then it will be
 * more than one element.
 */
export function ParseGlobPattern(text: string): GlobPart[] {
  const pattern: GlobPart[] = [];
  for (;;) {
    const star = text.indexOf("*");
    if (star < 0) {
      const part = new GlobPart();
      part.Prefix = text;
      pattern.push(part);
      break;
    }
    let count = 1;
    while (star + count < text.length && text[star + count] === "*") count++;
    let wildcard: GlobWildcard = GlobWildcard.GlobAllExceptSlash;

    // Allow both "/" and "\" as slashes
    if (
      count > 1 && (star === 0 || text[star - 1] === "/" || text[star - 1] === "\\") &&
      (star + count === text.length || text[star + count] === "/" || text[star + count] === "\\")
    ) {
      wildcard = GlobWildcard.GlobAllIncludingSlash; // A "globstar" path segment
    }

    const part = new GlobPart();
    part.Prefix = text.slice(0, star);
    part.Wildcard = wildcard;
    pattern.push(part);
    text = text.slice(star + count);
  }
  return pattern;
}

/** Go: func GlobPatternToString(pattern []GlobPart) string (internal/helpers/glob.go:46) */
export function GlobPatternToString(pattern: GlobPart[]): string {
  let out = "";
  for (const part of pattern) {
    out += part.Prefix;
    if (part.Wildcard === GlobWildcard.GlobAllExceptSlash) out += "*";
    else if (part.Wildcard === GlobWildcard.GlobAllIncludingSlash) out += "**";
  }
  return out;
}
