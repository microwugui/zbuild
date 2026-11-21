# M1 Parse+Print 差异聚类表（机械生成）

> 数据源：`npm run m1 -- --clusters`（唯一合法口径：Go `js_parser.Parse` + `js_printer.Print` 不经 linker vs TS 直接 `Parse` + `Print`）。
> 分类是**机械启发式 + 人工复核**：差异侧先按首差异处 token 对分组，再用源码里的 `@jsx*` / 语法特征归到根因类别；失败侧用 `Log.Msgs[0]` 文案 + 源码特征归类。
> 每组的「代表用例」固定取 id 排序后的前 3 个（可复现）。根因类别与 Go 函数对应见下方两张表。

- 生成时间：2026-11-17T03:04:11.660Z
- 总计：Go 可解析 4238，逐字节相等 4136（97.6%），差异 102，TS parse/print 失败 0
- 首差异字节：median 4 / max 753145，分布 `{"0":35,"1-10":49,"11-100":15,"101-1000":0,">1000":3}`
- **trivial equal**（输出 0 字节或 ≤64 字节）：**3207** 例（其中 0 字节 **7** 例）；扣掉后等价比 **21.9%**（分母不变）

## 分源指标

| 来源 | Go ok | 相等 | 相等率 | 差异 | TS 失败 |
| --- | ---: | ---: | ---: | ---: | ---: |
| three-src | 757 | 756 | 99.9% | 1 | 0 |
| three-build | 5 | 3 | 60.0% | 2 | 0 |
| esbuild-cases | 3476 | 3377 | 97.2% | 99 | 0 |

## 根因类别（差异侧）

| 根因类别 | 例数 | 代表用例（前 3） | 对应 Go 函数 | 预计 equal 增益（上限） |
| --- | ---: | --- | --- | ---: |
| 其他（逐例单点） | 72 | esbuild-cases/019798516aa5.js, esbuild-cases/03320008f222.js, esbuild-cases/065bff054133.js | — | 72 |
| 注释位置（表达式/语句级） | 13 | esbuild-cases/066ac3fb2081.js, esbuild-cases/0b9fa734e490.js, esbuild-cases/353b132557cf.js | js_printer.go:1917 printExprCommentsAtLoc / 3905 printIndentedComment | 13 |
| undefined 作为赋值目标被错误代换 | 6 | esbuild-cases/02dac9b4ca5a.js, esbuild-cases/546e4431b212.js, esbuild-cases/5553693d023b.js | js_parser visit pass assignTarget 判断（js_parser.go:13764） | 6 |
| 模板 </script> 防注入 lowering / automatic runtime | 5 | esbuild-cases/63087e69671b.js, esbuild-cases/69c8850390a8.js, esbuild-cases/7656c07fa9f0.js | js_parser 模板 lowering / jsx runtime | 5 |
| 字符串控制字符转义 | 3 | esbuild-cases/3743b66ef793.js, esbuild-cases/dda821a85a1c.js, esbuild-cases/eabc3474e7ac.js | js_printer.go:65 printUnquotedUTF16 | 3 |
| 一元表达式在 ** / delete 下的括号 | 2 | esbuild-cases/7153ba19565f.js, esbuild-cases/e41a2bd84e1a.js | js_printer.go:3431 BinOpPow leftLevel / js_printer.go:2005 printExpr | 2 |
| 可选链 continuation / 调用目标括号 | 1 | esbuild-cases/3eb5a43605f0.js | js_parser parseSuffix optionalChain + js_printer.go:2389 ECall 目标 | 1 |

> 「预计 equal 增益」是上限（= 例数）：同一例修完首个差异后可能还有后续差异。

## 根因类别（失败侧，先修诊断后的归因）

| 根因类别 | 例数 | 代表用例（前 3） | 首条文案样例 | 对应 Go 函数 |
| --- | ---: | --- | --- | --- |

## 附录 A. 失败侧（TS parse/print 失败，按首条文案归一）

| 组 | 例数 | 代表用例 | 首条文案样例 |
| --- | ---: | --- | --- |

## 附录 B. 差异侧（首差异 token 对，机械分组）

| Go token → TS token | 例数 | 代表用例 | Go 片段 | TS 片段 |
| --- | ---: | --- | --- | --- |
| "(0""(" → x"x" | 13 | esbuild-cases/03320008f222.js, esbuild-cases/2583436b392c.js, esbuild-cases/3c0158f03f66.js |  |  |
| x"x" → import"i" | 11 | esbuild-cases/019798516aa5.js, esbuild-cases/0d940912b3f6.js, esbuild-cases/0fc27d743ac9.js | sert: {} });\n |  |
| undefined"u" → void"v" | 6 | esbuild-cases/02dac9b4ca5a.js, esbuild-cases/546e4431b212.js, esbuild-cases/5553693d023b.js |  |  |
| "(0""(" → y"y" | 6 | esbuild-cases/32ca5ac1edf4.js, esbuild-cases/3a8b8c688ebf.js, esbuild-cases/4f1888abe433.js |  |  |
| "(f""(" → foo"f" | 5 | esbuild-cases/3f909e14d1fe.js, esbuild-cases/746dee18150b.js, esbuild-cases/7c83ac04ce6b.js |  |  |
| import"i" → String"S" | 5 | esbuild-cases/63087e69671b.js, esbuild-cases/69c8850390a8.js, esbuild-cases/7656c07fa9f0.js | String.raw(_a \|\| (_a = __template(["", "<\/script"])), a);\n |  |
| x"x" → for"f" | 4 | esbuild-cases/158de5cf81e6.js, esbuild-cases/94afe2e50a1d.js, esbuild-cases/9619c3ba5121.js |  |  |
| "(i""(" → import"i" | 4 | esbuild-cases/463159492594.js, esbuild-cases/91891b2fa5be.js, esbuild-cases/da8187186b72.js |  |  |
| ",]""," → "] ""]" | 4 | esbuild-cases/46d36ffbebe1.js, esbuild-cases/871e5c215960.js, esbuild-cases/af5d702a5054.js |  |  |
| "(l""(" → let"l" | 4 | esbuild-cases/591126b44e5e.js, esbuild-cases/a054d160eca1.js, esbuild-cases/c62d61921d34.js |  |  |
| "//""/" → luminanceCoefficients"l" | 3 | three/package/build/three.tsl.js, three/package/build/three.webgpu.nodes.js, three/package/src/nodes/display/ColorAdjustment.js | float(1),\n  // ASC CDL v1.2 explicitly requires Rec. 709 luminance coefficients | float(1),\n  luminanceCoefficients = vec3(ColorManagement.getLuminanceCoefficien |
| "(a""(" → async"a" | 3 | esbuild-cases/07bbad18b9d6.js, esbuild-cases/42117be04722.js, esbuild-cases/8f66089393dc.js |  |  |
| "\\0""\\" → "\u0000\"""\u0000" | 3 | esbuild-cases/3743b66ef793.js, esbuild-cases/dda821a85a1c.js, esbuild-cases/eabc3474e7ac.js |  |  |
| "/*""/" → RegExp"R" | 3 | esbuild-cases/bd9faddccd70.js, esbuild-cases/ef3d99292aec.js, esbuild-cases/ff3bf56cd55a.js |  |  |
| "(c""(" → c"c" | 2 | esbuild-cases/065bff054133.js, esbuild-cases/f2c3718b7856.js |  |  |
| "\n ""\n" → "/*""/" | 2 | esbuild-cases/066ac3fb2081.js, esbuild-cases/afd8bdddffcc.js |  |  |
| " *"" " → "* ""*" | 2 | esbuild-cases/283af29d260b.js, esbuild-cases/4969c96eb4bc.js |  |  |
| "/*""/" → Object"O" | 2 | esbuild-cases/353b132557cf.js, esbuild-cases/78d6531a2051.js |  |  |
| "{\n""{" → let"l" | 2 | esbuild-cases/6aa1948a5f69.js, esbuild-cases/bdd87a149268.js | n |  |
| undefined"u" → "(v""(" | 2 | esbuild-cases/7153ba19565f.js, esbuild-cases/e41a2bd84e1a.js |  |  |
| "[\"""[" → ".x""." | 2 | esbuild-cases/8378d9e3cc70.js, esbuild-cases/9e5fb32614d8.js |  |  |
| "[\"""[" → "𐀀""ð" | 2 | esbuild-cases/92b7dcf5739f.js, esbuild-cases/942ef3070f20.js |  |  |
| "/*""/" → 0"0" | 1 | esbuild-cases/0b9fa734e490.js |  |  |
| x"x" → "{\n""{" | 1 | esbuild-cases/2a836f489344.js | n |  return c;\n |
| "}\n""}" → "  "" " | 1 | esbuild-cases/3e0e33593987.js |  |  |
| a"a" → "(a""(" | 1 | esbuild-cases/3eb5a43605f0.js |  |  |
| "[\"""[" → ".\ud800""." | 1 | esbuild-cases/54a1880f1442.js |  |  |
| x"x" → void"v" | 1 | esbuild-cases/563b94371910.js |  |  |
| "\"\ud800""[" → "𐀀""." | 1 | esbuild-cases/6b3033449d69.js | ;\n |  |
| z"z" → ";\n"";" | 1 | esbuild-cases/6c184d722793.js |  |  |
| "/*""/" → 1"1" | 1 | esbuild-cases/74535bdc1b0b.js |  |  |
| <EOF>"<EOF>" → void"v" | 1 | esbuild-cases/cb28eafc61a5.js |  |  |
| _y"_" → y"y" | 1 | esbuild-cases/e6a6cff63172.js |  }\n};\n | }\n};\n |
| "[\"""[" → " ."" " | 1 | esbuild-cases/edf5901776b0.js |  |  |

## 附录 C. trivial equal（必须能从等价比里一眼扣掉）

| 用例 | 来源 | Go 输出字节 |
| --- | --- | ---: |
| esbuild-cases/00184171a8b3.js | esbuild-cases | 14 |
| esbuild-cases/0034212e0640.js | esbuild-cases | 13 |
| esbuild-cases/004a10e3a9a1.js | esbuild-cases | 22 |
| esbuild-cases/005f3de20a02.js | esbuild-cases | 37 |
| esbuild-cases/0078f0b112b3.js | esbuild-cases | 29 |
| esbuild-cases/007df22cd991.js | esbuild-cases | 14 |
| esbuild-cases/008741375add.js | esbuild-cases | 36 |
| esbuild-cases/009fd157cf0d.js | esbuild-cases | 28 |
| esbuild-cases/00a8e33e1a22.js | esbuild-cases | 34 |
| esbuild-cases/00c8908a0a39.js | esbuild-cases | 19 |
| esbuild-cases/00db31a87345.js | esbuild-cases | 41 |
| esbuild-cases/00e58cf745f6.js | esbuild-cases | 27 |
| esbuild-cases/00eead17c463.js | esbuild-cases | 13 |
| esbuild-cases/010d35468df6.js | esbuild-cases | 22 |
| esbuild-cases/012274f0353d.js | esbuild-cases | 29 |
| esbuild-cases/01247da455e0.js | esbuild-cases | 23 |
| esbuild-cases/01330fba86dc.js | esbuild-cases | 18 |
| esbuild-cases/013517e00ddf.js | esbuild-cases | 55 |
| esbuild-cases/0156b209cded.js | esbuild-cases | 30 |
| esbuild-cases/01bc4d7c5f2b.js | esbuild-cases | 23 |
| esbuild-cases/0211191462e5.js | esbuild-cases | 47 |
| esbuild-cases/02192151d254.js | esbuild-cases | 35 |
| esbuild-cases/02194291dcd0.js | esbuild-cases | 10 |
| esbuild-cases/024af7a6a663.js | esbuild-cases | 46 |
| esbuild-cases/027c288fd0b1.js | esbuild-cases | 12 |
| esbuild-cases/0282cca06bc4.js | esbuild-cases | 12 |
| esbuild-cases/029aadc18b61.js | esbuild-cases | 37 |
| esbuild-cases/02a3e42b5b2e.js | esbuild-cases | 18 |
| esbuild-cases/02a4d5a81c64.js | esbuild-cases | 15 |
| esbuild-cases/02c42bc6a302.js | esbuild-cases | 21 |
| esbuild-cases/031974d7d9f2.js | esbuild-cases | 17 |
| esbuild-cases/031c0ab8941e.js | esbuild-cases | 45 |
| esbuild-cases/0331c33cf879.js | esbuild-cases | 22 |
| esbuild-cases/0341b2c5c623.js | esbuild-cases | 10 |
| esbuild-cases/034496c7561f.js | esbuild-cases | 14 |
| esbuild-cases/034b6f84e602.js | esbuild-cases | 10 |
| esbuild-cases/0352ce69d2d1.js | esbuild-cases | 19 |
| esbuild-cases/035648be5900.js | esbuild-cases | 31 |
| esbuild-cases/0379065b3de3.js | esbuild-cases | 18 |
| esbuild-cases/03978d91a49a.js | esbuild-cases | 33 |
| esbuild-cases/03bf6cfc6948.js | esbuild-cases | 10 |
| esbuild-cases/03dd8a3c098f.js | esbuild-cases | 9 |
| esbuild-cases/03ec6b708533.js | esbuild-cases | 11 |
| esbuild-cases/03f109759f33.js | esbuild-cases | 52 |
| esbuild-cases/0400c7c5e880.js | esbuild-cases | 34 |
| esbuild-cases/040193ffdf32.js | esbuild-cases | 51 |
| esbuild-cases/040f502d0d78.js | esbuild-cases | 21 |
| esbuild-cases/0419f1bd906e.js | esbuild-cases | 60 |
| esbuild-cases/042a8327e060.js | esbuild-cases | 21 |
| esbuild-cases/043909ed38c3.js | esbuild-cases | 19 |
| esbuild-cases/04464709a163.js | esbuild-cases | 15 |
| esbuild-cases/04472d7cbe9d.js | esbuild-cases | 34 |
| esbuild-cases/04612d285c82.js | esbuild-cases | 26 |
| esbuild-cases/049a02562f7e.js | esbuild-cases | 22 |
| esbuild-cases/04a6fb169345.js | esbuild-cases | 4 |
| esbuild-cases/04a913a4bbeb.js | esbuild-cases | 26 |
| esbuild-cases/04e6a1a7128e.js | esbuild-cases | 55 |
| esbuild-cases/04f41b5062d6.js | esbuild-cases | 22 |
| esbuild-cases/055d95d4a21a.js | esbuild-cases | 46 |
| esbuild-cases/055fa79b320a.js | esbuild-cases | 35 |
| esbuild-cases/05db8d8cff2f.js | esbuild-cases | 21 |
| esbuild-cases/05fe2bef99dd.js | esbuild-cases | 32 |
| esbuild-cases/0607e3ed96a8.js | esbuild-cases | 21 |
| esbuild-cases/06118fb9f661.js | esbuild-cases | 7 |
| esbuild-cases/063e47c1e369.js | esbuild-cases | 15 |
| esbuild-cases/064ce93f4cab.js | esbuild-cases | 25 |
| esbuild-cases/0661410879ff.js | esbuild-cases | 31 |
| esbuild-cases/0661889fb6b2.js | esbuild-cases | 12 |
| esbuild-cases/0679ba5c1ca4.js | esbuild-cases | 26 |
| esbuild-cases/0688ba84bdfb.js | esbuild-cases | 13 |
| esbuild-cases/0693ee859d40.js | esbuild-cases | 18 |
| esbuild-cases/06d1ac989c5f.js | esbuild-cases | 24 |
| esbuild-cases/06da2ad76392.js | esbuild-cases | 17 |
| esbuild-cases/06f6d234301b.js | esbuild-cases | 32 |
| esbuild-cases/07034e29f726.js | esbuild-cases | 13 |
| esbuild-cases/071f9c409368.js | esbuild-cases | 16 |
| esbuild-cases/0726cfd441ac.js | esbuild-cases | 25 |
| esbuild-cases/07358b69b64d.js | esbuild-cases | 31 |
| esbuild-cases/07503f7518b6.js | esbuild-cases | 16 |
| esbuild-cases/07579c9e4fca.js | esbuild-cases | 15 |
| esbuild-cases/0776c913788f.js | esbuild-cases | 15 |
| esbuild-cases/077b8ec427fc.js | esbuild-cases | 50 |
| esbuild-cases/07983edb783c.js | esbuild-cases | 41 |
| esbuild-cases/07adf5126381.js | esbuild-cases | 15 |
| esbuild-cases/07d5a91ace41.js | esbuild-cases | 12 |
| esbuild-cases/07ddcc9629b1.js | esbuild-cases | 21 |
| esbuild-cases/07e38f742b9d.js | esbuild-cases | 11 |
| esbuild-cases/07e9906af525.js | esbuild-cases | 26 |
| esbuild-cases/07ebd6b04ef4.js | esbuild-cases | 35 |
| esbuild-cases/07fb03d15357.js | esbuild-cases | 15 |
| esbuild-cases/080497c4eb3a.js | esbuild-cases | 30 |
| esbuild-cases/080a9ed42855.js | esbuild-cases | 5 |
| esbuild-cases/080eaa0d5848.js | esbuild-cases | 34 |
| esbuild-cases/082e65177149.js | esbuild-cases | 21 |
| esbuild-cases/084dbdccd81b.js | esbuild-cases | 31 |
| esbuild-cases/0878d8bfc72e.js | esbuild-cases | 44 |
| esbuild-cases/08bc1667c3ec.js | esbuild-cases | 26 |
| esbuild-cases/08cf61db85a9.js | esbuild-cases | 23 |
| esbuild-cases/08e6655c432a.js | esbuild-cases | 53 |
| esbuild-cases/09290b199db2.js | esbuild-cases | 27 |
| esbuild-cases/094245a952e5.js | esbuild-cases | 13 |
| esbuild-cases/09479dcfb0d8.js | esbuild-cases | 33 |
| esbuild-cases/094f21d14494.js | esbuild-cases | 63 |
| esbuild-cases/0963d7f133a6.js | esbuild-cases | 7 |
| esbuild-cases/096da2215a74.js | esbuild-cases | 27 |
| esbuild-cases/098174055bfb.js | esbuild-cases | 20 |
| esbuild-cases/0983091972dc.js | esbuild-cases | 28 |
| esbuild-cases/0987c3b67956.js | esbuild-cases | 11 |
| esbuild-cases/09b5beb7fd0f.js | esbuild-cases | 11 |
| esbuild-cases/09bc294f5821.js | esbuild-cases | 27 |
| esbuild-cases/09c284688b49.js | esbuild-cases | 40 |
| esbuild-cases/09cc035f0882.js | esbuild-cases | 61 |
| esbuild-cases/09d28acd467d.js | esbuild-cases | 7 |
| esbuild-cases/09e7a978598d.js | esbuild-cases | 31 |
| esbuild-cases/09f1b9267c68.js | esbuild-cases | 41 |
| esbuild-cases/09f742eecd2b.js | esbuild-cases | 61 |
| esbuild-cases/09f9e9328427.js | esbuild-cases | 19 |
| esbuild-cases/0a03882f4714.js | esbuild-cases | 12 |
| esbuild-cases/0a19ca77ad78.js | esbuild-cases | 20 |
| esbuild-cases/0a21b9ca7365.js | esbuild-cases | 27 |
| esbuild-cases/0a287df05d13.js | esbuild-cases | 20 |
| esbuild-cases/0a40978850b7.js | esbuild-cases | 13 |
| esbuild-cases/0a4e6800300a.js | esbuild-cases | 27 |
| esbuild-cases/0a5006ffa808.js | esbuild-cases | 29 |
| esbuild-cases/0a5414b256a0.js | esbuild-cases | 30 |
| esbuild-cases/0a706d043651.js | esbuild-cases | 19 |
| esbuild-cases/0a8f9d3eff5a.js | esbuild-cases | 41 |
| esbuild-cases/0aa78c8b3159.js | esbuild-cases | 32 |
| esbuild-cases/0aabe3f44ba3.js | esbuild-cases | 17 |
| esbuild-cases/0ab343ca3ced.js | esbuild-cases | 39 |
| esbuild-cases/0ab5810c727a.js | esbuild-cases | 33 |
| esbuild-cases/0b06dce970ca.js | esbuild-cases | 21 |
| esbuild-cases/0b49e41740ad.js | esbuild-cases | 27 |
| esbuild-cases/0b5570d62b55.js | esbuild-cases | 23 |
| esbuild-cases/0b572d5ea890.js | esbuild-cases | 17 |
| esbuild-cases/0b5bd52c73ab.js | esbuild-cases | 21 |
| esbuild-cases/0b81da2779ac.js | esbuild-cases | 11 |
| esbuild-cases/0b8aecfb7552.js | esbuild-cases | 8 |
| esbuild-cases/0bc8a19d3055.js | esbuild-cases | 12 |
| esbuild-cases/0bd88c74113d.js | esbuild-cases | 30 |
| esbuild-cases/0bf068541a6b.js | esbuild-cases | 16 |
| esbuild-cases/0c1200137f90.js | esbuild-cases | 55 |
| esbuild-cases/0c1e487ac4c4.js | esbuild-cases | 30 |
| esbuild-cases/0c4f9fe97765.js | esbuild-cases | 18 |
| esbuild-cases/0c54b086bd66.js | esbuild-cases | 14 |
| esbuild-cases/0c939a710049.js | esbuild-cases | 9 |
| esbuild-cases/0caa2b392b45.js | esbuild-cases | 17 |
| esbuild-cases/0cdc7ce85db2.js | esbuild-cases | 33 |
| esbuild-cases/0cdcbfe82e9f.js | esbuild-cases | 25 |
| esbuild-cases/0d146d0ff405.js | esbuild-cases | 10 |
| esbuild-cases/0d54c9d51cd7.js | esbuild-cases | 10 |
| esbuild-cases/0d68cf9e8203.js | esbuild-cases | 25 |
| esbuild-cases/0d6987e83c9c.js | esbuild-cases | 11 |
| esbuild-cases/0d8ead125bff.js | esbuild-cases | 46 |
| esbuild-cases/0d9bf6242f2a.js | esbuild-cases | 25 |
| esbuild-cases/0d9e84c7b4a6.js | esbuild-cases | 16 |
| esbuild-cases/0da8ddf5f5cd.js | esbuild-cases | 16 |
| esbuild-cases/0dae4d76e673.js | esbuild-cases | 15 |
| esbuild-cases/0dc9356a6df7.js | esbuild-cases | 32 |
| esbuild-cases/0dd3cc22cb03.js | esbuild-cases | 15 |
| esbuild-cases/0dee726d9d8f.js | esbuild-cases | 32 |
| esbuild-cases/0df3057527b5.js | esbuild-cases | 17 |
| esbuild-cases/0e0ad00fee99.js | esbuild-cases | 12 |
| esbuild-cases/0e2e80232d0b.js | esbuild-cases | 34 |
| esbuild-cases/0e38523f3f05.js | esbuild-cases | 25 |
| esbuild-cases/0e4369fe9821.js | esbuild-cases | 10 |
| esbuild-cases/0e664548d0bd.js | esbuild-cases | 42 |
| esbuild-cases/0e6800436ea1.js | esbuild-cases | 31 |
| esbuild-cases/0e76d9038fb3.js | esbuild-cases | 22 |
| esbuild-cases/0e84ba40ce11.js | esbuild-cases | 11 |
| esbuild-cases/0e89c58d297d.js | esbuild-cases | 45 |
| esbuild-cases/0eb28c90827c.js | esbuild-cases | 26 |
| esbuild-cases/0eca0154f118.js | esbuild-cases | 47 |
| esbuild-cases/0ed7a8cae7cc.js | esbuild-cases | 28 |
| esbuild-cases/0ee780a4632c.js | esbuild-cases | 56 |
| esbuild-cases/0f16ed401656.js | esbuild-cases | 20 |
| esbuild-cases/0f21d61893b0.js | esbuild-cases | 39 |
| esbuild-cases/0f71b4c15338.js | esbuild-cases | 37 |
| esbuild-cases/0f81f79dfa98.js | esbuild-cases | 10 |
| esbuild-cases/0fa1af5099fc.js | esbuild-cases | 21 |
| esbuild-cases/0fa2c66284c0.js | esbuild-cases | 33 |
| esbuild-cases/0fba750c49a7.js | esbuild-cases | 30 |
| esbuild-cases/0fc8a360d42f.js | esbuild-cases | 45 |
| esbuild-cases/0fd2e38749d8.js | esbuild-cases | 36 |
| esbuild-cases/0fdb80149655.js | esbuild-cases | 18 |
| esbuild-cases/0ff9c677634b.js | esbuild-cases | 18 |
| esbuild-cases/101c95a9b130.js | esbuild-cases | 49 |
| esbuild-cases/102fe580e682.js | esbuild-cases | 34 |
| esbuild-cases/10349bf5edca.js | esbuild-cases | 13 |
| esbuild-cases/104ee3231c06.js | esbuild-cases | 23 |
| esbuild-cases/1063764f8523.js | esbuild-cases | 20 |
| esbuild-cases/10749684eab8.js | esbuild-cases | 16 |
| esbuild-cases/108476388df6.js | esbuild-cases | 46 |
| esbuild-cases/109313ad912c.js | esbuild-cases | 33 |
| esbuild-cases/109c9dde4419.js | esbuild-cases | 32 |
| esbuild-cases/10ad73601da8.js | esbuild-cases | 12 |
| esbuild-cases/10c7b6140dd3.js | esbuild-cases | 25 |
| esbuild-cases/10e7ad76830e.js | esbuild-cases | 30 |
| esbuild-cases/1118f9c842d8.js | esbuild-cases | 15 |
| esbuild-cases/114b6649fce2.js | esbuild-cases | 10 |
| …其余 3007 例省略（见 m1.json） | | |

