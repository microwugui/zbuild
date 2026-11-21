// 1:1 移植自 esbuild internal/helpers/path.go（v0.28.2，commit f6058f83）
//
// 第 26 轮补齐 `IsFileURL` / `FileURLFromFilePath` / `FilePathFromFileURL`（O 批）：
// 三者当前无真实调用点（resolver / fs 未移植），验收改用 Go 探针 fixture
// `testdata/helpers-extra2.json`（`npm run doc:check` 只校文档，不涉及此项）。
//
// DEVIATION（类型）：Go 的 `*url.URL` 用 WHATWG `URL` 承载；Go 的 `fs.FS` 参数在 M3 前
// 用最小结构类型 `{ Cwd(): string }`（只用到 `Cwd()`）。

/**
 * Go: func IsInsideNodeModules(path string) bool (helpers/path.go:10)
 *
 * DEVIATION（等价，不是语义差异）：Go 在 `string` 的**字节**上找 `/` 与 `\`，
 * TS 在 UTF-16 码元上找。两个分隔符都是 ASCII，且比较的 `node_modules` 也是 ASCII，
 * 且 UTF-8 多字节序列里不会出现 0x2F/0x5C，因此对任意合法 UTF-8 路径结果相同。
 */
export function IsInsideNodeModules(path: string): boolean {
  for (;;) {
    // 平台无关：`/` 与 `\` 都当分隔符（用户给的路径可能是任意平台/URL 形态）
    let slash = -1;
    for (let i = path.length - 1; i >= 0; i--) {
      const c = path.charCodeAt(i);
      if (c === 0x2f /* '/' */ || c === 0x5c /* '\\' */) {
        slash = i;
        break;
      }
    }
    if (slash === -1) return false;
    const dir = path.slice(0, slash);
    const base = path.slice(slash + 1);
    if (base === "node_modules") return true;
    path = dir;
  }
}

/** Go: func IsFileURL(fileURL *url.URL) bool (helpers/path.go:29) */
export function IsFileURL(fileURL: URL): boolean {
  return fileURL.protocol === "file:" &&
    (fileURL.host === "" || fileURL.host === "localhost") &&
    fileURL.pathname.startsWith("/");
}

/** Go: func FileURLFromFilePath(filePath string) *url.URL (helpers/path.go:33) */
export function FileURLFromFilePath(filePath: string): URL {
  // Append a trailing slash so that resolving the URL includes the trailing
  // directory, and turn Windows-style paths with volumes into URL-style paths:
  //
  //   "/Users/User/Desktop" => "file:///Users/User/Desktop"
  //   "C:\\Users\\User\\Desktop" => "file:///C:/Users/User/Desktop"
  filePath = filePath.replace(/\\/g, "/");
  if (!filePath.startsWith("/")) filePath = "/" + filePath;
  return new URL("file://" + filePath);
}

/** Go: func FilePathFromFileURL(fs fs.FS, fileURL *url.URL) string (helpers/path.go:48) */
export function FilePathFromFileURL(fs: { Cwd(): string }, fileURL: URL): string {
  // Go 的 url.URL.Path 是已解码的路径；WHATWG URL.pathname 保留百分号编码
  let path = decodeURIComponent(fileURL.pathname);

  // Convert URL-style paths back into Windows-style paths if needed:
  //
  //   "/C:/Users/User/foo.js.map" => "C:\\Users\\User\\foo.js.map"
  if (!fs.Cwd().startsWith("/")) {
    if (path.startsWith("/")) path = path.slice(1);
    path = path.replace(/\//g, "\\"); // This is needed for "filepath.Rel()" to work
  }

  return path;
}
