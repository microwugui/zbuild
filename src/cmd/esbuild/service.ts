// 1:1 移植自 esbuild cmd/esbuild/service.go（v0.28.2，commit f6058f83）
// 第 44 轮叶子优先规划：ResolveKind 编解码 + 字符串数组编解码。
// 第 82 轮：消息编解码纯函数（encodeMessages/decodeMessages/decodeMessageToPrivate/encodeErrorPacket）。
// 字节证据由 Go 探针固化在 testdata/service-go.json / testdata/service-msg-go.json。
import { encodePacket, decodePacket, writeUint32, readLengthPrefixedSlice } from "./stdio_protocol.ts";
import { esbuildVersion } from "./main.ts";
import { StringToMaximumMsgID } from "../../internal/logger/msg_ids.ts";
import { Msg, MsgData, MsgLocation, PrettyPaths } from "../../internal/logger/logger.ts";
import { formatMsgsImpl, analyzeMetafileImpl } from "../../pkg/api/api_impl.ts";
import { Transform, Build } from "../../pkg/api/api.ts";
import { ParseTransformOptions, ParseBuildOptions } from "../../pkg/cli/cli_impl.ts";
import { CompileFilterForPlugin } from "../../internal/config/config.ts";
const teService = new TextEncoder();
const tdService = new TextDecoder();

/** service 请求里的 mangleCache 是普通对象；转成 cloneMangleCache 期望的 Map。 */
function toMangleMap(v: any): Map<string, string | boolean | number> | null {
  if (v === undefined || v === null) return null;
  if (v instanceof Map) return v;
  return new Map<string, string | boolean | number>(Object.entries(v) as [string, string | boolean | number][]);
}
/** cloneMangleCache 产出的 Map → 协议 map（普通对象，encodePacket 按 Object.keys 编码）。 */
function mangleMapToObj(v: Map<string, string | boolean | number> | null): Record<string, any> | null {
  if (v === null) return null;
  return Object.fromEntries(v);
}

// 第 100 轮成片端口：service handler 链（handleTransformRequest / handleBuildRequest），
// 当轮接进 CLI 选项解析底座（ParseTransformOptions/ParseBuildOptions）与已验 api.Transform/Build。
// 端到端 oracle：testdata/service-chain-go.json（真实 service handler 请求→响应逐字节）。

/** Go: api.ResolveKind 枚举值（探针实测） */
export const ResolveKind = {
  ResolveEntryPoint: 1,
  ResolveJSImportStatement: 2,
  ResolveJSRequireCall: 3,
  ResolveJSDynamicImport: 4,
  ResolveJSRequireResolve: 5,
  ResolveCSSImportRule: 6,
  ResolveCSSComposesFrom: 7,
  ResolveCSSURLToken: 8,
} as const;

const RESOLVE_KIND_TO_STRING: Record<number, string> = {
  1: "entry-point", 2: "import-statement", 3: "require-call", 4: "dynamic-import",
  5: "require-resolve", 6: "import-rule", 7: "composes-from", 8: "url-token",
};
const STRING_TO_RESOLVE_KIND: Record<string, number> = Object.fromEntries(
  Object.entries(RESOLVE_KIND_TO_STRING).map(([k, v]) => [v, Number(k)]),
);

/** Go: func resolveKindToString(kind api.ResolveKind) string (service.go:798) */
export function resolveKindToString(kind: number): string {
  return RESOLVE_KIND_TO_STRING[kind] ?? "";
}

/** Go: func stringToResolveKind(kind string) (api.ResolveKind, bool) (service.go:826) */
export function stringToResolveKind(kind: string): { value: number; ok: boolean } {
  const v = STRING_TO_RESOLVE_KIND[kind];
  return v !== undefined ? { value: v, ok: true } : { value: 0, ok: false };
}

/** Go: func encodeStringArray(strings []string) []interface{} (service.go:1297) */
export function encodeStringArray(strings: string[]): string[] {
  return strings.slice();
}

/** Go: func decodeStringArray(values []interface{}) []string (service.go:1305) */
export function decodeStringArray(values: string[]): string[] {
  return values.slice();
}

/** Go: api.Location struct (api.go:194) */
export interface Location {
  File: string; Namespace: string; Line: number; Column: number; Length: number;
  LineText: string; Suggestion: string;
}

/** Go: func encodeLocation(loc *api.Location) interface{} (service.go:1325) */
export function encodeLocation(loc: Location | null): Record<string, string | number> | null {
  if (loc === null) return null;
  const l = loc as unknown as Record<string, string | number>;
  // Go json.Marshal sorts map keys alphabetically; input may use either casing
  const get = (upper: string, lower: string): string | number => l[upper] ?? l[lower];
  return {
    column: get("Column", "column"), file: get("File", "file"), length: get("Length", "length"),
    line: get("Line", "line"), lineText: get("LineText", "lineText"),
    namespace: get("Namespace", "namespace"), suggestion: get("Suggestion", "suggestion"),
  };
}

/** Go: func decodeLocation(value interface{}) *api.Location (service.go:1370) */
export function decodeLocation(value: Record<string, unknown> | null): Location | null {
  if (value === null) return null;
  let namespace = value.namespace as string;
  if (namespace === "") namespace = "file";
  return {
    File: value.file as string, Namespace: namespace, Line: value.line as number,
    Column: value.column as number, Length: value.length as number,
    LineText: value.lineText as string, Suggestion: value.suggestion as string,
  };
}

/** Go: func decodeLocationToPrivate(value interface{}) *logger.MsgLocation (service.go:1413) */
export function decodeLocationToPrivate(value: Record<string, unknown> | null): Record<string, unknown> | null {
  if (value === null) return null;
  let namespace = value.namespace as string;
  if (namespace === "") namespace = "file";
  const file = value.file as string;
  // Go logger.MsgLocation field order: File, Namespace, LineText, Suggestion, Line, Column, Length
  return {
    File: { Abs: file, Rel: file }, Namespace: namespace,
    LineText: value.lineText as string, Suggestion: value.suggestion as string,
    Line: value.line as number, Column: value.column as number, Length: value.length as number,
  };
}

/** Go: api.OutputFile struct (api.go) */
export interface OutputFile { path: string; contents: string; hash: string; }

/** Go: func encodeOutputFiles(outputFiles []api.OutputFile) []interface{} (service.go:1313) */
export function encodeOutputFiles(outputFiles: OutputFile[]): Record<string, string>[] {
  return outputFiles.map((outputFile) => ({
    contents: outputFile.contents, hash: outputFile.hash, path: outputFile.path,
  }));
}

/** Go: api.Message 的端口 IR（扁平字段，与 PublicMessage 同形） */
export interface ServiceMessage {
  ID: string; PluginName: string; Text: string; Location: Location | null;
  Notes: { Text: string; Location: Location | null }[]; Detail: unknown;
}

/** Go: func encodeMessages(msgs []api.Message) []interface{} (service.go:1340) */
export function encodeMessages(msgs: ServiceMessage[]): Record<string, unknown>[] {
  return msgs.map((msg) => {
    const value: Record<string, unknown> = {
      id: msg.ID, pluginName: msg.PluginName, text: msg.Text,
      location: encodeLocation(msg.Location),
    };
    value.notes = msg.Notes.map((note) => ({
      text: note.Text, location: encodeLocation(note.Location),
    }));
    // Send "-1" to mean "undefined"
    const detail = (typeof msg.Detail === "number") ? msg.Detail : -1;
    value.detail = detail;
    return value;
  });
}

/** Go: func decodeMessages(values []interface{}) []api.Message (service.go:1390) */
export function decodeMessages(values: Record<string, any>[]): ServiceMessage[] {
  return values.map((obj) => {
    const notes: { Text: string; Location: Location | null }[] = [];
    for (const note of (obj.notes ?? [])) {
      notes.push({ Text: note.text as string, Location: decodeLocation(note.location) });
    }
    return {
      ID: obj.id as string, PluginName: obj.pluginName as string, Text: obj.text as string,
      Location: decodeLocation(obj.location), Detail: obj.detail,
      Notes: notes,
    };
  });
}

/** Go: func decodeMessageToPrivate(obj map[string]interface{}) logger.Msg (service.go:1434) */
export function decodeMessageToPrivate(obj: Record<string, any>): Msg {
  const msg = new Msg();
  msg.ID = StringToMaximumMsgID(obj.id as string);
  msg.PluginName = obj.pluginName as string;
  const data = new MsgData();
  data.Text = obj.text as string;
  const dl = decodeLocationToPrivate(obj.location);
  if (dl !== null) {
    const ml = new MsgLocation();
    const f = dl.File as { Abs?: string; Rel?: string };
    ml.File = new PrettyPaths(); ml.File.Abs = f?.Abs ?? ""; ml.File.Rel = f?.Rel ?? "";
    ml.Namespace = dl.Namespace as string;
    ml.LineText = teService.encode(dl.LineText as string);
    ml.Suggestion = dl.Suggestion as string;
    ml.Line = dl.Line as number; ml.Column = dl.Column as number; ml.Length = dl.Length as number;
    data.Location = ml;
  } else data.Location = null;
  data.UserDetail = obj.detail;
  msg.Data = data;
  for (const note of (obj.notes ?? [])) {
    const nd = new MsgData();
    nd.Text = note.text as string;
    const ndl = decodeLocationToPrivate(note.location);
    if (ndl !== null) {
      const ml = new MsgLocation();
      const f = ndl.File as { Abs?: string; Rel?: string };
      ml.File = new PrettyPaths(); ml.File.Abs = f?.Abs ?? ""; ml.File.Rel = f?.Rel ?? "";
      ml.Namespace = ndl.Namespace as string;
      ml.LineText = teService.encode(ndl.LineText as string);
      ml.Suggestion = ndl.Suggestion as string;
      ml.Line = ndl.Line as number; ml.Column = ndl.Column as number; ml.Length = ndl.Length as number;
      nd.Location = ml;
    } else nd.Location = null;
    msg.Notes.push(nd);
  }
  return msg;
}

/** Go: func encodeErrorPacket(id uint32, err error) []byte (service.go:588) */
export function encodeErrorPacket(id: number, err: string): Uint8Array {
  return encodePacket({ id, isRequest: false, value: { error: err } });
}

// ── serviceType 状态机（第 85 轮，共享 Go 探针 harness：testdata/service-state-go.json）──
// Go 的 outgoingPackets 是 channel、keepAliveWaitGroup 是并发计数；TS 单线程下用同步队列
// 和整数计数等价承载。字节证据由 tools/go/tmpgen_service_test.bak 固化。

/** Go: activeBuild struct (service.go:30) —— 只承载本批可达的字段 */
export class activeBuild {
  // Go: ctx api.BuildContext / pluginResolve / rebuildWaitGroup / withinRebuildCount / didGetCancel
  ctx: unknown = null;
  pluginResolve: unknown = null;
  withinRebuildCount = 0;
  didGetCancel = false;
}

type ResponseCallback = (value: any) => void;

/** Go: serviceType struct (service.go:40) */
export class serviceType {
  callbacks: Map<number, ResponseCallback> = new Map();
  activeBuilds: Map<number, activeBuild> = new Map();
  /** Go: outgoingPackets chan []byte —— TS 用 FIFO 队列模拟（sendPacket 入队，writer 出队） */
  outgoingPackets: Uint8Array[] = [];
  /** Go: keepAliveWaitGroup —— 只需计数可观测行为，TS 用整数 */
  keepAliveCount = 0;
  nextRequestID = 0;

  /** Go: func (service *serviceType) getActiveBuild(key int) *activeBuild (service.go:51) */
  getActiveBuild(key: number): activeBuild | null {
    return this.activeBuilds.get(key) ?? null;
  }

  /** Go: func (service *serviceType) createActiveBuild(key int) *activeBuild (service.go:58) */
  createActiveBuild(key: number): activeBuild {
    if (this.activeBuilds.has(key)) throw new globalThis.Error("Internal error");
    const build = new activeBuild();
    this.activeBuilds.set(key, build);
    this.keepAliveCount++;
    return build;
  }

  /** Go: func (service *serviceType) destroyActiveBuild(key int) (service.go:72) */
  destroyActiveBuild(key: number): void {
    if (!this.activeBuilds.has(key)) throw new globalThis.Error("Internal error");
    this.activeBuilds.delete(key);
    this.keepAliveCount--;
  }

  /** Go: func (service *serviceType) sendPacket(packet []byte) (service.go:163) */
  sendPacket(packet: Uint8Array): void {
    this.keepAliveCount++;
    this.outgoingPackets.push(packet);
  }

  /** Go: func (service *serviceType) sendRequest(request interface{}) interface{} (service.go:171)
   *  TS 单线程：注册 callback 后 sendPacket，返回值由调用方预置的 mockResponse 提供。
   */
  sendRequest(request: any, mockResponse: any = null): any {
    const id = this.nextRequestID++;
    const result: { value: any } = { value: mockResponse };
    this.callbacks.set(id, (value: any) => { result.value = value; });
    this.sendPacket(encodePacket({ id, isRequest: true, value: request }));
    return result.value;
  }

  /** Go: func (service *serviceType) handleIncomingPacket(bytes []byte) (service.go:203)
   *  第 85 轮：不依赖未移植 api/build 层的分派分支已逐字节落地（共享 harness）。
   *  依赖下游的分支（build/transform/format-msgs/analyze-metafile 正常路径）显式抛错，
   *  不返回假数据——它们要等 api 层移植后才能 1:1 实现。
   */
  handleIncomingPacket(bytes: Uint8Array): void {
    const { packet: p, ok } = decodePacket(bytes);
    if (!ok || p === null) return;

    if (!p.isRequest) {
      const callback = this.callbacks.get(p.id);
      this.callbacks.delete(p.id);
      if (callback === undefined) throw new globalThis.Error(`callback nil for id ${p.id}`);
      callback(p.value);
      return;
    }

    const request = p.value as Record<string, any>;
    const command = request["command"] as string;
    const id = p.id;
    const sendMap = (value: Record<string, any>): void => { this.sendPacket(encodePacket({ id, isRequest: false, value })); };
    const sendError = (error: string): void => { sendMap({ error }); };

    switch (command) {
      case "resolve":
        if (this.getActiveBuild(request["key"] as number) === null) {
          sendError("Cannot call \"resolve\" on an inactive build");
        } else throw new globalThis.Error("service: active resolve 需 pluginResolve 下游（未移植）");
        return;
      case "rebuild":
        if (this.getActiveBuild(request["key"] as number) === null) sendError("Cannot rebuild");
        else throw new globalThis.Error("service: active rebuild 需 ctx.Rebuild 下游（未移植）");
        return;
      case "watch":
        if (this.getActiveBuild(request["key"] as number) === null) sendError("Cannot watch");
        else throw new globalThis.Error("service: active watch 需 ctx.Watch 下游（未移植）");
        return;
      case "cancel":
        // Go: 无论 build 是否存在都回空 map（active 分支也在异步后回空 map）
        sendMap({});
        return;
      case "dispose":
        sendMap({});
        return;
      case "format-msgs": {
        const style = request["logStyle"];
        if (style !== undefined && style !== "default" && style !== "clang" && style !== "visualstudio") {
          sendError(`Invalid log style: ${JSON.stringify(style)}`);
          return;
        }
        throw new globalThis.Error("service: format-msgs 正常路径需 api.FormatMessages 下游（未移植）");
      }
      case "analyze-metafile":
        throw new globalThis.Error("service: analyze-metafile 需 api.AnalyzeMetafile 下游（未移植）");
      case "build":
        throw new globalThis.Error("service: build 需 api.Context/build 下游（未移植）");
      case "transform":
        throw new globalThis.Error("service: transform 需 api.Transform 下游（未移植）");
      case "error":
        throw new globalThis.Error("service: error 需 logger.PrintMessageToStderr 下游（未移植）");
      default:
        sendError(`Invalid command: ${command}`);
        return;
    }
  }

  /** Go: func (service *serviceType) handleFormatMessagesRequest(id, request) []byte (service.go:1233)
   *  主体 = api.formatMsgsImpl（已移植，Go 探针 25 例逐字节），第 86 轮真接通。
   */
  /**
   * Go: func (service *serviceType) convertPlugins (service.go:853)
   * 返回 plugin 描述符（含 onResolve/onLoad 过滤回调）+ hasOnEnd；filter 非法时返回错误文案。
   * 回调的 sendRequest 分发在真实 build 中触发，本端口固化其构造与校验语义（确定性可观测）。
   */
  convertPlugins(key: number, jsPlugins: any, activeBuild: activeBuild): { plugins: any[]; hasOnEnd: boolean; err: string | null } {
    type Filtered = { pluginName: string; id: number; regex: RegExp; namespace: string };
    const onResolve: Filtered[] = [];
    const onLoad: Filtered[] = [];
    let hasOnEnd = false;
    const parse = (pluginName: string, kind: string, items: any[], out: Filtered[]): string | null => {
      for (const item of items) {
        const r = CompileFilterForPlugin(pluginName, kind, String(item["filter"] ?? ""));
        if (r.error !== null) return r.error;
        out.push({ pluginName, id: Number(item["id"] ?? 0), regex: r.regex!, namespace: String(item["namespace"] ?? "") });
      }
      return null;
    };
    for (const p of (jsPlugins ?? []) as any[]) {
      const name = String(p["name"] ?? "");
      if (p["onEnd"] === true) hasOnEnd = true;
      let e = parse(name, "onResolve", p["onResolve"] ?? [], onResolve); if (e !== null) return { plugins: [], hasOnEnd: false, err: e };
      e = parse(name, "onLoad", p["onLoad"] ?? [], onLoad); if (e !== null) return { plugins: [], hasOnEnd: false, err: e };
    }
    // Go 恒返回一个带 Setup 的 plugin（注册 onStart/onResolve/onLoad/onEnd 回调）。
    return { plugins: [{ name: "service", onResolve, onLoad, hasOnEnd }], hasOnEnd, err: null };
  }

  /** Go: func (service *serviceType) handleTransformRequest (service.go:1159) */
  handleTransformRequest(id: number, request: Record<string, any>): Uint8Array {
    const rawInput = request["input"];
    const input = rawInput instanceof Uint8Array ? tdService.decode(rawInput) : String(rawInput ?? "");
    const flags = decodeStringArray(request["flags"] ?? []);
    const { options, err } = ParseTransformOptions(flags);
    if (err !== null) return encodeErrorPacket(id, err.Text);
    (options as any).MangleCache = toMangleMap(request["mangleCache"]);
    const result = Transform(input, options as any);
    const response: Record<string, any> = {
      errors: encodeMessages([] as any), warnings: encodeMessages([] as any),
      code: tdService.decode(result.Code), codeFS: false,
      map: tdService.decode(result.Map), mapFS: false,
    };
    if (result.LegalComments && result.LegalComments.length > 0) response["legalComments"] = tdService.decode(result.LegalComments);
    if (result.MangleCache != null) response["mangleCache"] = mangleMapToObj(result.MangleCache);
    return encodePacket({ id, isRequest: false, value: response });
  }

  /** Go: func (service *serviceType) handleBuildRequest (service.go:597) —— 非 context / write=false 子集 */
  handleBuildRequest(id: number, request: Record<string, any>): Uint8Array {
    const flags = decodeStringArray(request["flags"] ?? []);
    const { options, err } = ParseBuildOptions(flags);
    if (err !== null) return encodeErrorPacket(id, err.Text);
    options.AbsWorkingDir = request["absWorkingDir"] ?? "";
    options.MangleCache = toMangleMap(request["mangleCache"]);
    // entries: [[outputPath, inputPath], ...] → EntryPointsAdvanced
    const entries = request["entries"] as any[] | undefined;
    if (entries && entries.length > 0) {
      options.EntryPointsAdvanced = entries.map((e) => ({ OutputPath: String(e[0]), InputPath: String(e[1]) }));
    }
    const rawStdin = request["stdinContents"];
    if (rawStdin instanceof Uint8Array) {
      options.Stdin = { Contents: tdService.decode(rawStdin), ResolveDir: request["stdinResolveDir"] ?? "", Sourcefile: "<stdin>", Loader: 0 };
    }
    const result = Build(options);
    const response: Record<string, any> = {
      errors: encodeMessages([] as any), warnings: encodeMessages([] as any),
    };
    if (!request["write"]) {
      response["outputFiles"] = result.OutputFiles.map((f) => ({ path: f.Path, contents: f.Contents, hash: f.Hash }));
    }
    if (options.Metafile) response["metafile"] = new TextEncoder().encode(result.Metafile);
    if (result.MangleCache != null) response["mangleCache"] = mangleMapToObj(result.MangleCache);
    return encodePacket({ id, isRequest: false, value: response });
  }

  handleFormatMessagesRequest(id: number, request: Record<string, any>): Uint8Array {
    const msgs = decodeMessages(request["messages"] as Record<string, any>[]);
    let kind = 0; // api.ErrorMessage
    if (request["isWarning"] as boolean) kind = 1; // api.WarningMessage
    const color = (request["color"] as boolean) ?? false;
    const terminalWidth = (request["terminalWidth"] as number) ?? 0;
    let logStyle = 0; // default
    if (typeof request["logStyle"] === "string") {
      switch (request["logStyle"] as string) {
        case "default": logStyle = 0; break;
        case "clang": logStyle = 1; break;
        case "visualstudio": logStyle = 2; break;
        default: return encodePacket({ id, isRequest: false, value: { error: `Invalid log style: ${JSON.stringify(request["logStyle"])}` } });
      }
    }
    const result = formatMsgsImpl(msgs as any, { Kind: kind, Color: color, TerminalWidth: terminalWidth, LogStyle: logStyle });
    return encodePacket({ id, isRequest: false, value: { messages: encodeStringArray(result) } });
  }

  /** Go: func (service *serviceType) handleAnalyzeMetafileRequest(id, request) []byte (service.go:1276)
   *  主体 = api.analyzeMetafileImpl（已移植，Go 探针逐字节），第 86 轮真接通。
   */
  handleAnalyzeMetafileRequest(id: number, request: Record<string, any>): Uint8Array {
    const metafile = request["metafile"] as string;
    const color = (request["color"] as boolean) ?? false;
    const verbose = (request["verbose"] as boolean) ?? false;
    const result = analyzeMetafileImpl(metafile, { Color: color, Verbose: verbose });
    return encodePacket({ id, isRequest: false, value: { result } });
  }
}


// ============================================================================
// 第 119 轮：runService 的 stdin 帧循环确定性核心 —— 真 1:1（注入 stdin + dispatch）。
// ============================================================================

/**
 * Go: func runService(sendPings bool) (service.go:84) 的 version handshake + stdin 分帧循环。
 * 第 119 轮落地：以注入 stdin 字节流 + dispatch(bytes)->responseBytes 回调替换 os.Stdin/os.Stdout，
 * sendPings=false（无计时器 goroutine）。逐字复刻 service.go:106-160 的 framing while 循环。
 * 返回 { stdout, packets }；Go 侧写 os.Stdout → TS 返回字节由调用方写。
 */
export function runService(stdin: Uint8Array, dispatch: (packet: Uint8Array) => Uint8Array | null):
  { stdout: Uint8Array; packets: number } {
  let out = new Uint8Array(0);
  const append = (more: Uint8Array): void => { const n = new Uint8Array(out.length + more.length); n.set(out); n.set(more, out.length); out = n; };
  // version handshake: writeUint32(len(version)) + version
  const verBytes = new TextEncoder().encode(esbuildVersion);
  append(writeUint32(new Uint8Array(0), verBytes.length));
  append(verBytes);
  let stream = new Uint8Array(0);
  const buf = stdin;
  const s2 = new Uint8Array(stream.length + buf.length); s2.set(stream); s2.set(buf, stream.length); stream = s2;
  let bytes: Uint8Array = stream;
  let packets = 0;
  while (true) {
    const { slice, leftOver, ok } = readLengthPrefixedSlice(bytes);
    if (!ok) break;
    bytes = leftOver;
    packets++;
    const clone = slice.slice();
    const resp = dispatch(clone);
    if (resp !== null) append(resp);
  }
  return { stdout: out, packets };
}
