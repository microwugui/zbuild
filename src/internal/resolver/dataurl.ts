// 1:1 移植自 esbuild internal/resolver/dataurl.go（v0.28.2，commit f6058f83）
// 第 44 轮 M2/M4 成片推进：data URL 解析整链（ParseDataURL / DecodeMIMEType / DecodeData）。
// byte oracle 由 Go 包内探针（internal/resolver/tmpgen_dataurl_test.go，跑完即删）固化在
// testdata/resolver-dataurl-go.json。

export const MIMETypeUnsupported = 0;
export const MIMETypeTextCSS = 1;
export const MIMETypeTextJavaScript = 2;
export const MIMETypeApplicationJSON = 3;
export type MIMEType = number;

/** Go: type DataURL struct (dataurl.go:10) */
export class DataURL {
  mimeType: string = "";
  data: string = "";
  isBase64: boolean = false;

  /** Go: func (parsed DataURL) DecodeMIMEType() MIMEType (dataurl.go:31) */
  DecodeMIMEType(): MIMEType {
    // Remove things like ";charset=utf-8"
    let mimeType = this.mimeType;
    const semicolon = mimeType.indexOf(";");
    if (semicolon !== -1) mimeType = mimeType.slice(0, semicolon);

    switch (mimeType) {
      case "text/css": return MIMETypeTextCSS;
      case "text/javascript": return MIMETypeTextJavaScript;
      case "application/json": return MIMETypeApplicationJSON;
      default: return MIMETypeUnsupported;
    }
  }

  /** Go: func (parsed DataURL) DecodeData() (string, error) (dataurl.go:47) */
  DecodeData(): { value: string; err: string | null } {
    if (this.isBase64) {
      // Go base64.StdEncoding.DecodeString 的非法输入报 `illegal base64 data at input byte N`，
      // N 为第一个非法字节下标（source map 注释提示逐字节依赖此文案）。先按此定位首个非法字节。
      const bad = goBase64FirstBadByte(this.data);
      if (bad !== -1) {
        return { value: "", err: `could not decode base64 data: illegal base64 data at input byte ${bad}` };
      }
      try {
        const value = Buffer.from(this.data, "base64").toString("utf8");
        return { value, err: null };
      } catch (e) {
        return { value: "", err: `could not decode base64 data: ${String(e)}` };
      }
    }
    try {
      // Go url.PathUnescape ≈ decodeURIComponent（对 %ZZ 等抛错）
      const value = decodeURIComponent(this.data);
      return { value, err: null };
    } catch (e) {
      return { value: "", err: `could not decode percent-escaped data: ${String(e)}` };
    }
  }
}

// Go encoding/base64.StdEncoding 首个非法字节下标（长度须为 4 的倍数，字符集 A-Za-z0-9+/=）。
// 与 Go 的 CorruptInputError 对齐：返回第一个非法字符的下标，合法返回 -1。
function goBase64FirstBadByte(data: string): number {
  const isAlnum = (c: number) =>
    (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) ||
    (c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2f;
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    if (c === 0x3d /* '=' */) {
      // '=' 只允许出现在末 1-2 位
      if (i < data.length - 2) return i;
      continue;
    }
    if (!isAlnum(c)) return i;
  }
  // 长度不是 4 的倍数时，Go 报在最后一个完整解码块之后的位置
  if (data.length % 4 !== 0) return data.length - (data.length % 4);
  return -1;
}

/** Go: func ParseDataURL(url string) (parsed DataURL, ok bool) (dataurl.go:16) */
export function ParseDataURL(url: string): { parsed: DataURL; ok: boolean } {
  const parsed = new DataURL();
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    if (comma !== -1) {
      parsed.mimeType = url.slice("data:".length, comma);
      parsed.data = url.slice(comma + 1);
      if (parsed.mimeType.endsWith(";base64")) {
        parsed.mimeType = parsed.mimeType.slice(0, parsed.mimeType.length - ";base64".length);
        parsed.isBase64 = true;
      }
      return { parsed, ok: true };
    }
  }
  return { parsed, ok: false };
}
