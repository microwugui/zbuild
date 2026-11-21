// 1:1 移植自 esbuild internal/cli_helpers/cli_helpers.go（v0.28.2，commit f6058f83）
// 第 44 轮叶子优先规划：CLI 共享助手。字节证据由 Go 探针固化在
// testdata/cli-helpers-go.json。

/** Go: type ErrorWithNote struct (cli_helpers.go:13) */
export class ErrorWithNote {
  Text: string = "";
  Note: string = "";
}

/** Go: func MakeErrorWithNote(text string, note string) *ErrorWithNote (cli_helpers.go:17) */
export function MakeErrorWithNote(text: string, note: string): ErrorWithNote {
  const e = new ErrorWithNote();
  e.Text = text;
  e.Note = note;
  return e;
}

/** Go: api.Loader 枚举值（Go 探针实测，注意与 config.Loader 不同） */
const LOADERS: Record<string, number> = {
  base64: 1, binary: 2, copy: 3, css: 4, dataurl: 5, default: 6, empty: 7, file: 8,
  "global-css": 9, js: 10, json: 11, jsx: 12, "local-css": 13, text: 14, ts: 15, tsx: 16,
};

/** Go: func ParseLoader(text string) (api.Loader, *ErrorWithNote) (cli_helpers.go:24) */
export function ParseLoader(text: string): { loader: number; err: ErrorWithNote | null } {
  const loader = LOADERS[text];
  if (loader !== undefined) return { loader, err: null };
  return { loader: 0, err: MakeErrorWithNote(`Invalid loader value: ${JSON.stringify(text)}`, "") };
}
