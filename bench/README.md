# bench（性能对比与 profile）

本目录暂不实现，等所有代码移植完成后再开工（按任务要求：性能分析在代码完成之后）。

届时的方法定案（先记下来，避免之后拍脑袋）：

1. **输入**：`testdata/three/package/build/three.module.js`（658,900 字节）与
   `three.core.js`，两侧读同一份文件，避免 I/O 差异。
2. **工作量对齐**：esbuild 侧用 `GOMAXPROCS=1` 强制单线程（源码中没有 GOMAXPROCS
   设置，见 `grep -rn "GOMAXPROCS" /root/esbuild` 无命中），与 TS 单线程同口径。
3. **计时**：预热若干次，正式跑 N 次取中位数；同时记录 p10/p90。
4. **必须注明的偏置**：Node 的 V8 JIT 预热曲线、进程启动开销（Go 静态二进制 vs
   Node + `--experimental-strip-types` 的类型剥离）、GC 策略差异。
5. **profile**：`node --cpu-prof` 生成 `.cpuprofile`，用自写脚本按
   self-time 聚合到函数级，找出热点后再优化，优化前后都跑同一套 oracle 保证等价。
