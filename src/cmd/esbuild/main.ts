// 1:1 移植自 esbuild cmd/esbuild/main.go（v0.28.2）—— main 的 os.Args 预扫描确定性核心。
// 第 119 轮：Go 探针 testdata/main-scan-go.json（SHA 38eec378…）逐字节固化。
// Go 的 os.Exit/stdio 副作用由调用方注入（earlyAction 字段返回，不在此 os.exit）。

/** Go: const esbuildVersion = "0.28.2" (version.go:3) */
export const esbuildVersion = "0.28.2";

export interface MainScan {
  heapFile: string; traceFile: string; cpuProfile: string;
  isRunningService: boolean; sendPings: boolean;
  isWatch: boolean; isWatchForever: boolean; isServe: boolean; useTimer: boolean;
  args: string[] | null;
  earlyAction: string; // "help" | "version:<v>" | "version-mismatch:<host>" | ""
}

/**
 * Go: main.go:162-240 os.Args 预扫描。第 119 轮落地为纯函数：副作用（help/version/版本不匹配
 * 的 stderr 输出 + os.Exit）以 earlyAction 返回，由调用方执行；useTimer 对全局的写入以字段返回。
 * 逐字复刻 Go 分支顺序（help/version/heap/trace/timing/cpuprofile/service/ping/default）。
 */
export function main(osArgsIn: string[]): MainScan {
  const osArgs = osArgsIn.slice();
  const r: MainScan = {
    heapFile: "", traceFile: "", cpuProfile: "",
    isRunningService: false, sendPings: false,
    isWatch: false, isWatchForever: false, isServe: false, useTimer: false,
    args: null, earlyAction: "",
  };
  let argsEnd = 0;
  for (const arg0 of osArgs) {
    let arg = arg0;
    if (arg === "-h" || arg === "-help" || arg === "--help" || arg === "/?") {
      r.earlyAction = "help"; return r;
    } else if (arg === "--version") {
      r.earlyAction = "version:" + esbuildVersion; return r;
    } else if (arg.startsWith("--heap=")) {
      r.heapFile = arg.slice("--heap=".length);
    } else if (arg.startsWith("--trace=")) {
      r.traceFile = arg.slice("--trace=".length);
    } else if (arg.startsWith("--timing")) {
      r.useTimer = true;
    } else if (arg.startsWith("--cpuprofile=")) {
      r.cpuProfile = arg.slice("--cpuprofile=".length);
    } else if (arg.startsWith("--service=")) {
      const hostVersion = arg.slice("--service=".length);
      r.isRunningService = true;
      if (hostVersion !== esbuildVersion) { r.earlyAction = "version-mismatch:" + hostVersion; return r; }
    } else if (arg.startsWith("--ping")) {
      r.sendPings = true;
    } else {
      if (arg === "--watch" || arg === "--watch=true") {
        r.isWatch = true;
      } else if (arg === "--watch=forever") {
        arg = "--watch"; r.isWatch = true; r.isWatchForever = true;
      } else if (arg === "--serve" || arg.startsWith("--serve=") ||
        arg.startsWith("--servedir=") || arg.startsWith("--serve-fallback=")) {
        r.isServe = true;
      }
      osArgs[argsEnd] = arg; argsEnd++;
    }
  }
  r.args = osArgs.slice(0, argsEnd);
  return r;
}
