// 1:1 移植自 Go 标准库 net/http/internal/sniff.go（go1.27.3）。
// 第 115 轮作为 apiHandler.ServeHTTP 的底座落地；供 MIME 无法按扩展名判定时的内容嗅探。

const SNIFF_LEN = 512;

function isWS(b: number): boolean {
  return b === 0x09 || b === 0x0a || b === 0x0c || b === 0x0d || b === 0x20;
}
function isTT(b: number): boolean {
  return b === 0x20 || b === 0x3e;
}

interface Sig { match(data: Uint8Array, firstNonWS: number): string }

class ExactSig implements Sig {
  sig: Uint8Array; ct: string;
  constructor(sig: Uint8Array, ct: string) { this.sig = sig; this.ct = ct; }
  match(data: Uint8Array, _firstNonWS: number): string {
    if (data.length < this.sig.length) return "";
    for (let i = 0; i < this.sig.length; i++) if (data[i] !== this.sig[i]) return "";
    return this.ct;
  }
}

class MaskedSig implements Sig {
  mask: Uint8Array; pat: Uint8Array; ct: string; skipWS: boolean;
  constructor(mask: Uint8Array, pat: Uint8Array, ct: string, skipWS: boolean) {
    this.mask = mask; this.pat = pat; this.ct = ct; this.skipWS = skipWS;
  }
  match(dataIn: Uint8Array, firstNonWS: number): string {
    const data = this.skipWS ? dataIn.subarray(firstNonWS) : dataIn;
    if (this.pat.length !== this.mask.length || data.length < this.pat.length) return "";
    for (let i = 0; i < this.pat.length; i++) if ((data[i] & this.mask[i]) !== this.pat[i]) return "";
    return this.ct;
  }
}

class HTMLSig implements Sig {
  sig: Uint8Array;
  constructor(sig: Uint8Array) { this.sig = sig; }
  match(dataIn: Uint8Array, firstNonWS: number): string {
    const data = dataIn.subarray(firstNonWS);
    if (data.length < this.sig.length + 1) return "";
    for (let i = 0; i < this.sig.length; i++) {
      let db = data[i];
      const b = this.sig[i];
      if (0x41 <= b && b <= 0x5a) db &= 0xdf;
      if (b !== db) return "";
    }
    return isTT(data[this.sig.length]) ? "text/html; charset=utf-8" : "";
  }
}

class MP4Sig implements Sig {
  match(data: Uint8Array, _firstNonWS: number): string {
    if (data.length < 12) return "";
    const boxSize = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
    if (data.length < boxSize || boxSize % 4 !== 0) return "";
    if (!(data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70)) return "";
    for (let st = 8; st < boxSize; st += 4) {
      if (st === 12) continue;
      if (data[st] === 0x6d && data[st + 1] === 0x70 && data[st + 2] === 0x34) return "video/mp4";
    }
    return "";
  }
}

class TextSig implements Sig {
  match(dataIn: Uint8Array, firstNonWS: number): string {
    for (const b of dataIn.subarray(firstNonWS)) {
      if (b <= 0x08 || b === 0x0b || (0x0e <= b && b <= 0x1a) || (0x1c <= b && b <= 0x1f)) return "";
    }
    return "text/plain; charset=utf-8";
  }
}

// byte-string：每个字符码点 0-255 直接映射为单字节（TextEncoder 会把 \xFF 编成两字节，故不用）
const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const html = (s: string) => new HTMLSig(enc(s));
const exact = (s: string, ct: string) => new ExactSig(enc(s), ct);
const rawExact = (bytes: number[], ct: string) => new ExactSig(Uint8Array.from(bytes), ct);
const masked = (maskB: Uint8Array, patB: Uint8Array, ct: string, skipWS = false) => new MaskedSig(maskB, patB, ct, skipWS);
const u = (...b: number[]) => Uint8Array.from(b);

const sniffSignatures: Sig[] = [
  html("<!DOCTYPE HTML"), html("<HTML"), html("<HEAD"), html("<SCRIPT"), html("<IFRAME"),
  html("<H1"), html("<DIV"), html("<FONT"), html("<TABLE"), html("<A"), html("<STYLE"),
  html("<TITLE"), html("<B"), html("<BODY"), html("<BR"), html("<P"), html("<!--"),
  masked(enc("\xFF\xFF\xFF\xFF\xFF"), enc("<?xml"), "text/xml; charset=utf-8", true),
  exact("%PDF-", "application/pdf"),
  exact("%!PS-Adobe-", "application/postscript"),
  masked(u(0xFF, 0xFF, 0x00, 0x00), u(0xFE, 0xFF, 0x00, 0x00), "text/plain; charset=utf-16be"),
  masked(u(0xFF, 0xFF, 0x00, 0x00), u(0xFF, 0xFE, 0x00, 0x00), "text/plain; charset=utf-16le"),
  masked(u(0xEF, 0xBB, 0xBF, 0x00), u(0xEF, 0xBB, 0xBF, 0x00), "text/plain; charset=utf-8"),
  rawExact([0, 0, 1, 0], "image/x-icon"),
  rawExact([0, 0, 2, 0], "image/x-icon"),
  exact("BM", "image/bmp"),
  exact("GIF87a", "image/gif"),
  exact("GIF89a", "image/gif"),
  masked(u(0xFF, 0xFF, 0xFF, 0xFF, 0, 0, 0, 0, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF), enc("RIFF\x00\x00\x00\x00WEBPVP"), "image/webp"),
  rawExact([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "image/png"),
  rawExact([0xFF, 0xD8, 0xFF], "image/jpeg"),
  masked(u(0xFF, 0xFF, 0xFF, 0xFF, 0, 0, 0, 0, 0xFF, 0xFF, 0xFF, 0xFF), enc("FORM\x00\x00\x00\x00AIFF"), "audio/aiff"),
  exact("ID3", "audio/mpeg"),
  masked(u(0xFF, 0xFF, 0xFF, 0xFF, 0xFF), enc("OggS\x00"), "application/ogg"),
  masked(u(0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF), enc("MThd\x00\x00\x00\x06"), "audio/midi"),
  masked(u(0xFF, 0xFF, 0xFF, 0xFF, 0, 0, 0, 0, 0xFF, 0xFF, 0xFF, 0xFF), enc("RIFF\x00\x00\x00\x00AVI "), "video/avi"),
  masked(u(0xFF, 0xFF, 0xFF, 0xFF, 0, 0, 0, 0, 0xFF, 0xFF, 0xFF, 0xFF), enc("RIFF\x00\x00\x00\x00WAVE"), "audio/wave"),
  new MP4Sig(),
  rawExact([0x1A, 0x45, 0xDF, 0xA3], "video/webm"),
  masked(u(...Array(34).fill(0), 0x4c, 0x50), u(...Array(34).fill(0), 0xFF, 0xFF), "application/vnd.ms-fontobject"),
  rawExact([0, 1, 0, 0], "font/ttf"),
  exact("OTTO", "font/otf"),
  exact("ttcf", "font/collection"),
  exact("wOFF", "font/woff"),
  exact("wOF2", "font/woff2"),
  rawExact([0x1F, 0x8B, 0x08], "application/x-gzip"),
  exact("PK\x03\x04", "application/zip"),
  exact("Rar!\x1A\x07\x00", "application/x-rar-compressed"),
  exact("Rar!\x1A\x07\x01\x00", "application/x-rar-compressed"),
  rawExact([0, 0x61, 0x73, 0x6d], "application/wasm"),
  new TextSig(),
];

/** Go: net/http.DetectContentType（sniff.go:15） */
export function DetectContentType(dataIn: Uint8Array): string {
  const data = dataIn.length > SNIFF_LEN ? dataIn.subarray(0, SNIFF_LEN) : dataIn;
  let firstNonWS = 0;
  while (firstNonWS < data.length && isWS(data[firstNonWS])) firstNonWS++;
  for (const sig of sniffSignatures) {
    const ct = sig.match(data, firstNonWS);
    if (ct !== "") return ct;
  }
  return "application/octet-stream";
}
