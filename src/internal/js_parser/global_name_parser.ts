// 1:1 移植自 esbuild internal/js_parser/global_name_parser.go（v0.28.2，commit f6058f83）
// 第 44 轮归置：原实现误放在 js_parser.ts，按约定「一个 Go 文件 = 一个 TS 文件」搬到本文件。
import { Log, Source } from "../logger/logger.ts";
import { UTF16ToString } from "../helpers/utf.ts";
import { Lexer, LexerPanic } from "../js_lexer/js_lexer.ts";
import { T } from "../js_lexer/tables.ts";

const decoder = new TextDecoder();
function bytesToString(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** Go: func ParseGlobalName(log logger.Log, source logger.Source) (result []string, ok bool) (global_name_parser.go:9) */
export function ParseGlobalName(log: Log, source: Source): { result: string[]; ok: boolean } {
  let ok = true;
  const result: string[] = [];
  try {
    const lexer = Lexer.NewLexerGlobalName(log, source);

    // Start off with an identifier or a keyword that results in an object
    result.push(bytesToString(lexer.Identifier.String));
    switch (lexer.Token) {
      case T.TThis:
        lexer.Next();
        break;

      case T.TImport:
        // Handle "import.meta"
        lexer.Next();
        lexer.Expect(T.TDot);
        result.push(bytesToString(lexer.Identifier.String));
        lexer.ExpectContextualKeyword("meta");
        break;

      default:
        lexer.Expect(T.TIdentifier);
    }

    // Follow with dot or index expressions
    while (lexer.Token !== T.TEndOfFile) {
      switch (lexer.Token) {
        case T.TDot:
          lexer.Next();
          if (!lexer.IsIdentifierOrKeyword()) {
            lexer.Expect(T.TIdentifier);
          }
          result.push(bytesToString(lexer.Identifier.String));
          lexer.Next();
          break;

        case T.TOpenBracket:
          lexer.Next();
          result.push(bytesToString(UTF16ToString(lexer.StringLiteral())));
          lexer.Expect(T.TStringLiteral);
          lexer.Expect(T.TCloseBracket);
          break;

        default:
          lexer.Expect(T.TDot);
      }
    }

    return { result, ok };
  } catch (e) {
    if (e instanceof LexerPanic) {
      // Go 的命名返回值在 panic 时仍然带着已经 append 的部分
      ok = false;
      return { result, ok };
    }
    throw e;
  }
}
