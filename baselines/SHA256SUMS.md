# goport 基线二进制清单（字节等价硬门参照系）

这些二进制是 M0–M4 字节等价第一硬门的**唯一参照**。原文件位于易失的 `/tmp`，
且经实测用当前工具链无法按 SHA 复现，故固化到 `baselines/` 并提交到 goport 孤儿分支。

- `/tmp/esbuild-go`：esbuild 0.28.2 基线参照二进制（原工具链 `go.version=1.26.5` 构建）。
- `/tmp/goport-go126`：`GOTOOLCHAIN=go1.26.5` 对 goport 未改源码重建（**≠** 基线 sha，原因未确证）。
- `/tmp/goport-go`：系统 `go 1.27.3` 对 goport 未改源码重建（**≠** 基线 sha）。

固化日期：2026-11-21。校验命令：`sha256sum -c SHA256SUMS`（在本目录）。

## SHA256

```
b8387dbab66e8c2ce90ce0397e7efd94814f61601c6e351a59d1f7dd0abbee11  esbuild-go.base
27a1330e20215a93299dd1f155c425d3d1659e2a34e5175e997930892562760e  goport-go126.base
a42bea909a159eb4757c759c2a1834a99f42e21e7d04ce627870f0e32f3699bc  goport-go.base
```

## 复现负结果（如实记录，勿臆测根因）

| 构建口径 | sha256 前缀 | 与基线 b8387d 关系 |
| --- | --- | --- |
| 基线 `/tmp/esbuild-go` | b8387d | 参照 |
| go1.26.5 重建 `/tmp/goport-go126` | 27a1330 | 不等 |
| 系统 go1.27.3 重建 `/tmp/goport-go` | a42bea | 不等 |

结论：字节等价门验的是**输出产物**，不是二进制 sha。二进制 sha 不可复现的根因未确证，不臆测。
