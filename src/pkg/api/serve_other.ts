// 1:1 移植自 esbuild pkg/api/serve_other.go（v0.28.2，commit f6058f83）
// 第 44 轮叶子优先规划：HTML 转义助手。
import { MsgKind, NewDeferLog, DeferLogKind, OutputOptions, TerminalInfo, Colors, UseColor, TerminalColors } from "../../internal/logger/logger.ts";
import { convertMessagesToInternal } from "./api_impl.ts";
import type { PublicMessage } from "./api_impl.ts";

// 第 96 轮成片端口：serve 层可确定性驱动函数簇。Go 探针
// tools/go/tmpgen_serve_pure_test.bak → testdata/serve-pure-go.json（SHA 49d188ce…）。
// 依赖（fs.Rel / stderr 写入 / onRequest 回调）通过参数或字段注入，保持纯可测、非桩。

/** Go: fs.FS 的 Rel/Cwd 子集（serve 路径判定用）；返回 null 表示 Rel 失败。 */
export interface RelFS {
  Rel(base: string, target: string): [string, boolean];
  Cwd(): string;
}

/** Go: fs.FS 的 ServeHTTP 子集（Join/Dir/Base/Ext/EvalSymlinks/ReadDirectory/OpenFile） */
export interface ServeFS extends RelFS {
  Join(...parts: string[]): string;
  Dir(p: string): string;
  Base(p: string): string;
  Ext(p: string): string;
  EvalSymlinks(p: string): [string, boolean];
  /** 返回 [entries(name→kind), err]；err=null 表示成功 */
  ReadDirectory(p: string): [Map<string, number>, string | null];
  /** 返回 [contents, err]；err=null 表示成功 */
  OpenFile(p: string): [Uint8Array, string | null];
}

/** Go: fs.EntryKind (fs.go:19) */
export const DirEntry = 1;
export const FileEntry = 2;

/** Go: type OutputFile struct (api.go:392) —— serve 匹配只需 Path/Contents */
export interface ServeOutputFile { Path: string; Contents: Uint8Array }

/** Go: type ServeOnRequestArgs struct (api.go:512) */
export interface ServeOnRequestArgs {
  RemoteAddress: string; Method: string; Path: string; Status: number; TimeInMS: number;
}

/** Go: func prettyPrintPath(fs fs.FS, path string) string (serve_other.go:740) */
export function prettyPrintPath(fsObj: RelFS, path: string): string {
  const [relPath, ok] = fsObj.Rel(fsObj.Cwd(), path);
  if (ok) return relPath.replaceAll("\\", "/");
  return path;
}

/** Go: func (h *apiHandler) matchQueryPathToResult (serve_other.go:616) */
export function matchQueryPathToResult(
  fsObj: RelFS, absOutputDir: string, queryPath: string, result: { OutputFiles: ServeOutputFile[] },
  dirEntries: Map<string, boolean>, fileEntries: Map<string, boolean>,
): { kind: number; contents: Uint8Array; path: string; isIndex: boolean } {
  let queryIsDir = false;
  let queryDir = queryPath;
  if (queryDir !== "") queryDir += "/";
  for (const file of result.OutputFiles ?? []) {
    const [rel0, ok] = fsObj.Rel(absOutputDir, file.Path);
    if (!ok) continue;
    const relPath = rel0.replaceAll("\\", "/");
    if (relPath === queryPath) return { kind: FileEntry, contents: file.Contents, path: file.Path, isIndex: false };
    const slash = relPath.lastIndexOf("/");
    const dir = slash < 0 ? "" : relPath.slice(0, slash + 1);
    const base = slash < 0 ? relPath : relPath.slice(slash + 1);
    if (base === "index.html" && queryDir === dir) return { kind: FileEntry, contents: file.Contents, path: file.Path, isIndex: true };
    if (relPath.startsWith(queryDir)) {
      const entry = relPath.slice(queryDir.length);
      queryIsDir = true;
      const s = entry.indexOf("/");
      if (s === -1) fileEntries.set(entry, true);
      else { const d = entry.slice(0, s); if (!dirEntries.has(d)) dirEntries.set(d, true); }
    }
  }
  if (queryIsDir) return { kind: DirEntry, contents: new Uint8Array(0), path: "", isIndex: false };
  return { kind: 0, contents: new Uint8Array(0), path: "", isIndex: false };
}

/** Go: type apiHandler struct (serve_other.go:39) —— 只落本批方法所需字段 */
export class apiHandler {
  onRequest: ((args: ServeOnRequestArgs) => void) | null = null;
  fsObj: RelFS | null = null;
  absOutputDir = "";
  // 第 112 批：broadcastBuildResult 底座字段（Go apiHandler 同名字段）
  outdirPathPrefix = "";
  publicPath = "";
  // 第 115 轮 ServeHTTP 字段（Go apiHandler 同名）
  servedir = "";
  keyfileToLower = "";
  certfileToLower = "";
  fallback = "";
  hosts: string[] = [];
  corsOrigin: string[] = [];
  rebuild: (() => { OutputFiles: ServeOutputFile[]; Errors?: PublicMessage[] }) | null = null;
  currentHashes: Map<string, string> = new Map();
  /** SSE 流：每个回调收到 {event, data}；Go 是 chan serverSentEvent */
  activeStreams: ((ev: { event: string; data: string }) => void)[] = [];

  /** Go: func (h *apiHandler) notifyRequest (serve_other.go:78) */
  notifyRequest(durationMS: number, remoteAddress: string, method: string, reqPath: string, status: number): void {
    if (this.onRequest !== null) {
      this.onRequest({ RemoteAddress: remoteAddress, Method: method, Path: reqPath, Status: status, TimeInMS: durationMS });
    }
  }

  /** Go: func (h *apiHandler) broadcastBuildResult (serve_other.go:491) —— 第 112 批 */
  broadcastBuildResult(result: { Errors?: unknown[] }, newHashes: Map<string, string>): void {
    const added: string[] = [];
    const removed: string[] = [];
    const updated: string[] = [];
    const qj = (s: string) => dec.decode(QuoteForJSON(new TextEncoder().encode(s), false));

    const urlForPath = (absPath: string): [string, boolean] => {
      const r = stripDirPrefix(absPath, this.absOutputDir, "\\/");
      if (r.ok) {
        let relPath = r.value.replaceAll("\\", "/");
        relPath = posix(this.outdirPathPrefix, relPath);
        const slash = (this.publicPath !== "" && this.publicPath.endsWith("/")) ? "" : "/";
        return [this.publicPath + slash + relPath, true];
      }
      return ["", false];
    };

    if (!result.Errors || result.Errors.length === 0) {
      const oldHashes = this.currentHashes;
      this.currentHashes = newHashes;
      for (const [absPath, newHash] of newHashes) {
        const oldHash = oldHashes.get(absPath);
        if (oldHash === undefined) {
          const [url, ok] = urlForPath(absPath);
          if (ok) added.push(url);
        } else if (newHash !== oldHash) {
          const [url, ok] = urlForPath(absPath);
          if (ok) updated.push(url);
        }
      }
      for (const absPath of oldHashes.keys()) {
        if (!newHashes.has(absPath)) {
          const [url, ok] = urlForPath(absPath);
          if (ok) removed.push(url);
        }
      }
    }

    if (added.length > 0 || removed.length > 0 || updated.length > 0) {
      added.sort(); removed.sort(); updated.sort();
      const arr = (a: string[]) => "[" + a.map(qj).join(",") + "]";
      const data = '{"added":' + arr(added) + ',"removed":' + arr(removed) + ',"updated":' + arr(updated) + "}";
      for (const stream of this.activeStreams) stream({ event: "change", data });
    }
  }

  /**
   * Go: func (h *apiHandler) serveEventStream(start time.Time, req *http.Request, res http.ResponseWriter)
   *     (serve_other.go:418)。第 114 轮落地：以最小 ResponseWriter/CloseNotifier 抽象承载 SSE 字节输出。
   * Go 用 goroutine + channel 推送事件；TS 以 activeStreams 回调队列同步推送，await closeNotify 收尾，
   * 字节序（headers → retry → event 块 → 关闭移除）与 Go 一致。30s keep-alive 属时序，夹具不覆盖。
   */
  async serveEventStream(startMS: number, req: ServeRequest, res: ServeResponseWriter): Promise<void> {
    if (res.flush !== undefined && res.closeNotify !== undefined) {
      const enc = new TextEncoder();
      const stream = (ev: { event: string; data: string }): void => {
        res.write(enc.encode(`event: ${ev.event}\ndata: ${ev.data}\n\n`));
        res.flush!();
      };
      // Add a new stream to the array of active streams
      this.activeStreams.push(stream);

      // Start the event stream
      res.headerSet("Content-Type", "text/event-stream");
      res.headerSet("Connection", "keep-alive");
      res.headerSet("Cache-Control", "no-cache");
      if (this.onRequest !== null) this.notifyRequest(Date.now() - startMS, req.remoteAddr, req.method, req.urlPath, 200);
      res.writeHeader(200);
      res.write(enc.encode("retry: 500\n"));
      res.flush();

      // Wait for the stream to close, then remove it from the array
      await res.closeNotify();
      const i = this.activeStreams.indexOf(stream);
      if (i >= 0) this.activeStreams.splice(i, 1);
      return;
    }

    // If we get here, then event streaming isn't possible
    if (this.onRequest !== null) this.notifyRequest(Date.now() - startMS, req.remoteAddr, req.method, req.urlPath, 500);
    res.writeHeader(500);
    res.write(new TextEncoder().encode("500 - Event stream error"));
  }

  /**
   * Go: func (h *apiHandler) ServeHTTP(res http.ResponseWriter, req *http.Request)
   *     (serve_other.go:105)。第 115 轮落地：servedir="" 与 output 覆盖的确定性分支
   * （CORS / Host 校验 / 反斜杠 / 构建错误 / 输出文件+Range+MIME / 目录列表 / 重定向 /
   * favicon / 404）。servedir 真实文件系统分支 M1 不可达（夹具不覆盖），如实保留骨架注释。
   */
  ServeHTTP(res: ServeResponseWriter, req: ServeRequest): void {
    // Add CORS headers to all relevant requests
    const origin = req.headerGet("Origin");
    if (origin !== "") {
      for (const allowed of this.corsOrigin) {
        if (allowed === "*") { res.headerSet("Access-Control-Allow-Origin", "*"); break; }
        else {
          const star = allowed.indexOf("*");
          if (star >= 0) {
            const prefix = allowed.slice(0, star), suffix = allowed.slice(star + 1);
            if (origin.length >= prefix.length + suffix.length && origin.startsWith(prefix) && origin.endsWith(suffix)) {
              res.headerSet("Access-Control-Allow-Origin", origin); break;
            }
          } else if (origin === allowed) { res.headerSet("Access-Control-Allow-Origin", origin); break; }
        }
      }
    }

    // HEAD requests omit the body
    const isHEAD = req.method === "HEAD";
    const writeBody = (bytes: Uint8Array): void => { if (!isHEAD) res.write(bytes); };
    const notify = (status: number): void => {
      if (this.onRequest !== null) this.notifyRequest(0, req.remoteAddr, req.method, req.urlPath, status);
    };

    // Check the "Host" header to prevent DNS rebinding attacks
    if (req.host.includes(":")) {
      // Go: net.SplitHostPort —— 成功则去掉端口
      const m = /^\[?(.*?)\]?:(\d+)$/.exec(req.host);
      if (m) req.host = m[1];
    }
    if (req.host !== "localhost") {
      if (!this.hosts.includes(req.host)) {
        notify(403);
        res.writeHeader(403);
        writeBody(enc(`403 - Forbidden: The host ${goQuote(req.host)} is not allowed`));
        return;
      }
    }

    // All requests containing Windows-style path separators are invalid
    if (req.urlPath.includes("\\")) {
      notify(400); res.writeHeader(400); writeBody(enc("400 - Bad Request")); return;
    }

    // Handle GET and HEAD requests
    if ((isHEAD || req.method === "GET") && req.urlPath.startsWith("/")) {
      const queryPath = pathClean(req.urlPath).replace(/^\//, "");
      const result = this.rebuild !== null ? this.rebuild() : { OutputFiles: [], Errors: [] };
      if (result.Errors && result.Errors.length > 0) {
        res.headerSet("Content-Type", "text/plain; charset=utf-8");
        notify(503); res.writeHeader(503);
        writeBody(enc(errorsToString(result.Errors)));
        return;
      }
      const dirEntries = new Map<string, boolean>();
      const fileEntries = new Map<string, boolean>();
      let kind = 0, contents: Uint8Array = new Uint8Array(0), absPath = "";
      const strip = stripDirPrefix(queryPath, this.outdirPathPrefix, "/");
      if (strip.ok) {
        const m = matchQueryPathToResult(this.fsObj as any, this.absOutputDir, strip.value, result, dirEntries, fileEntries);
        kind = m.kind; contents = m.contents; absPath = m.path;
      }
      // SKELETON（servedir 真实文件系统分支 M1 不可达）

      // Redirect to a trailing slash for directories
      if (kind === DirEntry && !req.urlPath.endsWith("/")) {
        res.headerSet("Location", pathClean(req.urlPath) + "/");
        notify(302); res.writeHeader(302); writeBody(new Uint8Array(0)); return;
      }

      // Serve a directory listing
      if (kind === DirEntry) {
        const html = respondWithDirList(queryPath, dirEntries, fileEntries);
        res.headerSet("Content-Type", "text/html; charset=utf-8");
        res.headerSet("Content-Length", String(html.length));
        notify(200); writeBody(html); return;
      }

      // Serve a file
      if (kind === FileEntry) {
        let status = 200, begin = 0, end = contents.length, isRange = false;
        const range = parseRangeHeader(req.headerGet("Range"), contents.length);
        if (range.ok && range.begin < range.end) {
          isRange = true; begin = range.begin; end = range.end; status = 206;
        }
        const fileBytes = contents.subarray(begin, end);
        let contentType = MimeTypeByExtension(this.fsObj !== null ? (this.fsObj as ServeFS).Ext(absPath) : "");
        if (contentType === "") contentType = DetectContentType(begin === 0 ? fileBytes : contents.subarray(0, Math.min(512, contents.length)));
        if (contentType === "") contentType = "application/octet-stream";
        res.headerSet("Content-Type", contentType);
        if (isRange) res.headerSet("Content-Range", `bytes ${begin}-${end - 1}/${contents.length}`);
        res.headerSet("Content-Length", String(fileBytes.length));
        notify(status); res.writeHeader(status); writeBody(fileBytes); return;
      }
    }

    // Satisfy requests for "favicon.ico" to avoid errors in Firefox developer tools
    if (req.method === "GET" && req.urlPath === "/favicon.ico") {
      for (let encoding of req.headerGet("Accept-Encoding").split(",")) {
        const semi = encoding.indexOf(";");
        if (semi >= 0) encoding = encoding.slice(0, semi);
        if (encoding.trim() === "gzip") {
          res.headerSet("Content-Encoding", "gzip");
          res.headerSet("Content-Type", "image/vnd.microsoft.icon");
          notify(200); writeBody(FAVICON_ICO_GZ); return;
        }
      }
    }

    // Default to a 404
    res.headerSet("Content-Type", "text/plain; charset=utf-8");
    notify(404); res.writeHeader(404); writeBody(enc("404 - Not Found"));
  }
}

const dec = new TextDecoder();
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const goQuote = (s: string): string => JSON.stringify(s).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
// path.Clean (POSIX) —— ServeHTTP 的 URL 路径规范化
function pathClean(p: string): string {
  if (p === "") return ".";
  const rooted = p.startsWith("/");
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop(); else if (!rooted) parts.push(".."); }
    else parts.push(seg);
  }
  const joined = parts.join("/");
  return rooted ? "/" + joined : (joined || ".");
}
// Go: pkg/api/favicon.go favicon_ico_gz（411 字节 gzip）
const FAVICON_ICO_GZ = Uint8Array.from(atob("H4sIAAAAAAACA2NgYGRgYhAQYADSCgwZLAwMagwMDAoKEL6GIANDH1BMAygmABJngIgTBOf//ycJ00r/ye//WZefgatjW3LyP8OZ30Tr5ynp+S+uqALWx3TgzX8JReX/AqGpmGbgsV/IJxJuBvvsff8l5BQwzcDnf6AZwg7eYDNYNlz/zzF5839JScn//LH5ROlHtpPx2BcU9xDST5ReAvoFQlPAfoXpx9BLy/inhf6amWh4Vj35+rHoJVo/Dr1E6cejl6B+AnopABrQMsaB2HKG3PimNH2M2j9qPwH7mXc8+i/sHgym0eVY11wGyzEd+UgT+0F2ihmYgesJERtXFHtAdkuoqGOVo4X96Pbgk6N2+FPNDWSmP6q5gYL0TxU3UJj/2BYehdsBwgJxBXA5jmnbccoNdf8PZPwPZPof6Pw/0OXfQJf/o/XvqP1EYYy+DDY8p37g7J9TT9P2PzXspon9c0jrY1HV/jmk9++oZv8c8vqWVLF/Dvn9Wortn0NZn5oi++dQ3p8n2/45NBtLGM4AANrrYf22FQAA"), (c) => c.charCodeAt(0));
import { QuoteForJSON } from "../../internal/helpers/quote.ts";
import { MimeTypeByExtension } from "../../internal/helpers/mime.ts";
import { DetectContentType } from "../../internal/helpers/sniff.ts";
import { stripDirPrefix } from "./api_impl.ts";
import { join as posix } from "node:path";

/** Go net.IP.IsLoopback —— IPv4 127/8 与 IPv6 ::1（含 ::ffff:127/8 映射）。 */
function isLoopbackIP(host: string): boolean {
  let h = host;
  const pct = h.indexOf("%"); if (pct >= 0) h = h.slice(0, pct);
  if (h === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(h);
  if (mapped) h = mapped[1];
  const parts = h.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) return Number(parts[0]) === 127;
  return false;
}

/** Go net.JoinHostPort */
function joinHostPort(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

/** Go: func printURLs (serve_other.go:1056) —— write 为注入的输出函数（Go 写 os.Stderr）。 */
export function printURLs(hosts: string[], port: number, https: boolean, useColor: number, write: (s: string) => void): void {
  // Go: PrintTextWithColor 的 useColor 分支。注入写函数时无 TTY 信息：ColorNever/ColorIfTerminal
  // 一律无转义（夹具用 ColorNever）；ColorAlways 用 TerminalColors（Go 侧 SupportsColorEscapes
  // 在该环境为真）。夹具只锁 ColorNever/ColorAlways 口径。
  const colors = useColor === UseColor.ColorAlways ? TerminalColors : new Colors();
  const kinds: string[] = [];
  let maxLen = 0;
  for (const host of hosts) {
    const kind = isLoopbackIP(host) ? "Local" : "Network";
    kinds.push(kind);
    if (kind.length > maxLen) maxLen = kind.length;
  }
  const protocol = https ? "https" : "http";
  let sb = colors.Reset;
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i];
    sb += `\n > ${kind}:${" ".repeat(maxLen - kind.length)} ${colors.Underline}${protocol}://${joinHostPort(hosts[i], port)}/${colors.Reset}`;
  }
  sb += "\n\n";
  write(sb);
}


/** Go: func errorsToString(errors []Message) string (serve_other.go:90) */
export function errorsToString(errors: PublicMessage[]): string {
  const stderrOptions = new OutputOptions(); stderrOptions.IncludeSource = true;
  const terminalOptions = new TerminalInfo();
  let sb = "";
  const limit = 5;
  const logMsgs = convertMessagesToInternal([], MsgKind.Error, errors);
  for (let i = 0; i < logMsgs.length; i++) {
    if (i === limit) { sb += `${limit} out of ${errors.length} errors shown\n`; break; }
    sb += new TextDecoder().decode(logMsgs[i].String(stderrOptions, terminalOptions));
  }
  return sb;
}

/** Go: func escapeForHTML(text string) string (serve_other.go:64) */
export function escapeForHTML(text: string): string {
  text = text.replaceAll("&", "&amp;");
  text = text.replaceAll("<", "&lt;");
  text = text.replaceAll(">", "&gt;");
  return text;
}

/** Go: func escapeForAttribute(text string) string (serve_other.go:71) */
export function escapeForAttribute(text: string): string {
  text = escapeForHTML(text);
  text = text.replaceAll('"', "&quot;");
  text = text.replaceAll("'", "&apos;");
  return text;
}

/** Go: func parseRangeInt(text string, maxValue int) (int, bool) (serve_other.go:599) */
export function parseRangeInt(text: string, maxValue: number): { value: number; ok: boolean } {
  if (text === "") return { value: 0, ok: false };
  let value = 0;
  for (const c of text) {
    if (c < "0" || c > "9") return { value: 0, ok: false };
    value = value * 10 + (c.charCodeAt(0) - 0x30);
    if (value > maxValue) return { value: 0, ok: false };
  }
  return { value, ok: true };
}

/** Go: path.Dir (POSIX, 供 respondWithDirList) */
function posixDir(p: string): string {
  const i = p.lastIndexOf("/");
  if (i < 0) return ".";
  if (i === 0) return "/";
  return p.slice(0, i);
}
/** Go: path.Join (POSIX, 供 respondWithDirList) */
function posixJoin(a: string, b: string): string {
  if (a === "/") return "/" + b;
  return a + "/" + b;
}

/** Go: func respondWithDirList(queryPath string, dirEntries, fileEntries map[string]bool) []byte (serve_other.go:664) */
export function respondWithDirList(queryPath: string, dirEntries: Map<string, boolean>, fileEntries: Map<string, boolean>): Uint8Array {
  queryPath = "/" + queryPath;
  let queryDir = queryPath;
  if (queryDir !== "/") queryDir += "/";
  let html = "<!doctype html>\n" +
    "<meta charset=\"utf8\">\n" +
    "<style>\n" +
    "body { margin: 30px; color: #222; background: #fff; font: 16px/22px sans-serif; }\n" +
    "a { color: inherit; text-decoration: none; }\n" +
    "a:hover { text-decoration: underline; }\n" +
    "a:visited { color: #777; }\n" +
    "@media (prefers-color-scheme: dark) {\n" +
    "  body { color: #fff; background: #222; }\n" +
    "  a:visited { color: #aaa; }\n" +
    "}\n" +
    "</style>\n" +
    "<title>Directory: " + escapeForHTML(queryDir) + "</title>\n" +
    "<h1>Directory: ";
  const parts = queryPath === "/" ? [""] : queryPath.split("/");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i + 1 < parts.length) html += "<a href=\"" + escapeForAttribute(parts.slice(0, i + 1).join("/")) + "/\">";
    html += escapeForHTML(part) + "/";
    if (i + 1 < parts.length) html += "</a>";
  }
  html += "</h1>\n";
  if (queryPath !== "/") {
    let parentDir = posixDir(queryPath);
    if (parentDir !== "/") parentDir += "/";
    html += `<div>📁 <a href="${escapeForAttribute(parentDir)}">../</a></div>\n`;
  }
  const dirs = [...dirEntries.keys()].sort();
  for (const entry of dirs) {
    html += `<div>📁 <a href="${escapeForAttribute(posixJoin(queryPath, entry))}/">${escapeForHTML(entry)}/</a></div>\n`;
  }
  const files = [...fileEntries.keys()].sort();
  for (const entry of files) {
    html += `<div>📄 <a href="${escapeForAttribute(posixJoin(queryPath, entry))}">${escapeForHTML(entry)}</a></div>\n`;
  }
  return new TextEncoder().encode(html);
}

/** Go: func parseRangeHeader(r string, contentLength int) (int, int, bool) (serve_other.go:583) */
export function parseRangeHeader(r: string, contentLength: number): { begin: number; end: number; ok: boolean } {
  if (r.startsWith("bytes=")) {
    r = r.slice(6);
    const dash = r.indexOf("-");
    if (dash !== -1) {
      const begin = parseRangeInt(r.slice(0, dash), contentLength - 1);
      if (begin.ok) {
        const end = parseRangeInt(r.slice(dash + 1), contentLength - 1);
        if (end.ok) return { begin: begin.value, end: end.value + 1, ok: true };
      }
    }
  }
  return { begin: 0, end: 0, ok: false };
}

/** Go: http.Request 的最小只读抽象（serveEventStream / ServeHTTP 注入用） */
export interface ServeRequest {
  method: string;
  urlPath: string;
  host: string;
  remoteAddr: string;
  headerGet(name: string): string;
}

/** Go: http.ResponseWriter + Flusher + CloseNotifier 的最小抽象（可注入） */
export interface ServeResponseWriter {
  headerSet(key: string, value: string): void;
  writeHeader(status: number): void;
  write(bytes: Uint8Array): void;
  /** Go: http.Flusher.Flush（缺失表示不支持流式） */
  flush?: () => void;
  /** Go: http.CloseNotifier.CloseNotify（返回的 promise 在客户端断开时 resolve） */
  closeNotify?: () => Promise<void>;
}

/** Go: net.Listener 的最小抽象（hackListener 包装用） */
export interface NetListenerLike {
  Accept(): { conn: unknown; err: string | null };
}

/**
 * Go: type hackListener struct (serve_other.go:1038) + Accept (serve_other.go:1046)。
 * 拦截第一次 Accept 以判定 serve 调用是否成功启动；waitGroup 用计数模拟（Done 后归零）。
 */
export class hackListener {
  Listener: NetListenerLike;
  done = false;
  err: string | null = null;
  waitGroupCount = 0;
  constructor(listener: NetListenerLike) { this.Listener = listener; }

  /** Go: func (hack *hackListener) Accept() (net.Conn, error) */
  Accept(): { conn: unknown; err: string | null } {
    if (!this.done) {
      this.done = true;
      this.waitGroupCount -= 1; // sync.WaitGroup.Done()
    }
    return this.Listener.Accept();
  }
}


/** Go: internalContext.Serve 的校验上下文（Go 里 ctx 是 internalContext） */
export interface ServeCtx {
  didDispose: boolean;
  handler: unknown;
  serveFS: { Abs(p: string): [string, boolean]; Rel(base: string, target: string): [string, boolean]; Cwd(): string } | null;
  serveEntryPointCount: number;
  serveWriteToStdout: boolean;
  serveAbsOutputDir: string;
}
/** Go: api.ServeOptions 的校验子集 */
export interface ServeOpts {
  Keyfile: string; Certfile: string; Servedir: string; Fallback: string; CORS: { Origin: string[] | null };
}
/**
 * Go: func (ctx *internalContext) Serve(serveOptions ServeOptions) (ServeResult, error)
 *     (serve_other.go:747) 的 net.Listen 之前确定性校验分支。第 115 轮落地（文件归位：本函数属 serve_other.go）。
 * 成功路径需真实 net.Listen + http.Server + TLS（时序/端口不可确定性字节验证），如实登记为禁止端口。
 * 返回 null 表示“校验通过”。
 */
export function Serve(ctx: ServeCtx, so: ServeOpts): string | null {
  if (ctx.didDispose) return "Cannot serve a disposed context";
  if (ctx.handler !== null) return "Serve mode has already been enabled";
  if ((so.Keyfile !== "") !== (so.Certfile !== "")) return "Must specify both key and certificate for HTTPS";
  const fsObj = ctx.serveFS;
  if (so.Servedir !== "") {
    if (fsObj === null || !fsObj.Abs(so.Servedir)[1]) return `Invalid serve path: ${so.Servedir}`;
  }
  if (so.Fallback !== "") {
    if (fsObj === null || !fsObj.Abs(so.Fallback)[1]) return `Invalid fallback path: ${so.Fallback}`;
  }
  for (const origin of so.CORS.Origin ?? []) {
    const star = origin.indexOf("*");
    if (star >= 0 && origin.slice(star + 1).includes("*")) return `Invalid origin: ${origin}`;
  }
  if (ctx.serveEntryPointCount > 0) {
    if (ctx.serveWriteToStdout) {
      const what = ctx.serveEntryPointCount === 1 ? "an entry point" : "entry points";
      return `Cannot serve ${what} without an output path`;
    }
    if (so.Servedir !== "" && ctx.serveAbsOutputDir !== "") {
      const rel = fsObj !== null ? fsObj.Rel(so.Servedir, ctx.serveAbsOutputDir) : (["", false] as [string, boolean]);
      if (!rel[1]) return `Cannot compute relative path from ${JSON.stringify(so.Servedir)} to ${JSON.stringify(ctx.serveAbsOutputDir)}\n`;
      const relPath = rel[0].replaceAll("\\", "/");
      if (relPath === ".." || relPath.startsWith("../")) {
        const pp = (p: string): string => {
          if (fsObj === null) return p;
          const r = fsObj.Rel(fsObj.Cwd(), p);
          return r[1] ? r[0].replaceAll("\\", "/") : p;
        };
        return `Output directory ${JSON.stringify(pp(ctx.serveAbsOutputDir))} must be contained in serve directory ${JSON.stringify(pp(so.Servedir))}`;
      }
    }
  }
  return null;
}
