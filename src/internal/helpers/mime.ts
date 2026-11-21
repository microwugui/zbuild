// 1:1 移植自 esbuild internal/helpers/mime.go（v0.28.2，commit f6058f83）

/** Go: var builtinTypesLower (internal/helpers/mime.go:5) */
const builtinTypesLower: Map<string, string> = new Map([
  // Text
  [".css", "text/css; charset=utf-8"],
  [".htm", "text/html; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".markdown", "text/markdown; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".xhtml", "application/xhtml+xml; charset=utf-8"],
  [".xml", "text/xml; charset=utf-8"],

  // Images
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],

  // Audio
  [".mp3", "audio/mpeg"],

  // Fonts
  [".eot", "application/vnd.ms-fontobject"],
  [".otf", "font/otf"],
  [".sfnt", "font/sfnt"],
  [".ttf", "font/ttf"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],

  // Other
  [".pdf", "application/pdf"],
  [".wasm", "application/wasm"],
  [".webmanifest", "application/manifest+json"],
]);

/**
 * Go: func MimeTypeByExtension(ext string) string (internal/helpers/mime.go:46)
 *
 * This is used instead of the platform MIME table because Go's built-in
 * mime.TypeByExtension is broken on Windows.
 */
export function MimeTypeByExtension(ext: string): string {
  let contentType = builtinTypesLower.get(ext);
  if (contentType === undefined) contentType = builtinTypesLower.get(ext.toLowerCase());
  return contentType ?? "";
}
