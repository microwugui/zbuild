// 由 Go internal/css_parser/css_parser.go 的 atKnownRuleCanBeRemovedIfEmpty 表机械导出（勿手改）
export const atKnownRuleCanBeRemovedIfEmpty = new Set<string>([
  "media", "supports", "font-face", "page", "bottom-center", "bottom-left-corner", "bottom-left", "bottom-right-corner",
  "bottom-right", "left-bottom", "left-middle", "left-top", "right-bottom", "right-middle", "right-top", "top-center",
  "top-left-corner", "top-left", "top-right-corner", "top-right", "scope", "font-palette-values", "container",
]);
