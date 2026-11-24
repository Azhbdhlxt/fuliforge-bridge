# FuliForge Bridge（嘉立创 EDA 插件）

把嘉立创 EDA 专业版里的**器件、符号、封装、3D 模型引用、设计规则**搬到本机，供
FuliForge 自动化平台转成 KiCad 库（供 KiCad / Altium 画原理图与 PCB；FreeCAD / Blender / SolidWorks 建模）。

```
嘉立创EDA 插件  ──ws://127.0.0.1:49650-49659/fuliforge──▶  Hub(8787)  ──HTTP──▶  CLI  ──▶  Python 转换器  ──▶  .kicad_sym / .kicad_mod / .kicad_dru
   (本目录)                                          (hub/bridge.mjs)      (cli/lib.mjs)   (engine/forge/easyeda)
```

## 安装

1. 打包（在 `FuliForge` 根目录执行）：

   ```powershell
   powershell -ExecutionPolicy Bypass -File bridge\build.ps1
   ```

   产物：`FuliForge\dist\fuliforge-bridge_v0.1.2.eext`

2. 嘉立创 EDA → 设置 → 扩展 → 扩展管理器 → **从文件安装** → 选上面的 `.eext`。

3. **在扩展管理器里勾选「允许外部交互」**（本插件联网的硬前提，代码无法绕过；不勾则任何 WebSocket 都建不起来）。

4. 重启 EDA（或重新打开工程），顶部菜单出现 **FuliForge**。

> 装完先点「连接状态」：能看到「外部交互: 可用」就说明前置条件满足。
>
> 端口从 49650 起自动找第一个空闲的（49650–49659）。若 49650 已被别的程序占着，
> 插件会认服务端身份、跳过它并自动连到 Hub 真正监听的端口，不需要手工改配置。

## 插件内菜单

| 菜单项 | 作用 |
|---|---|
| 连接状态 | 显示通道、窗口 id、收发计数、外部交互是否可用、默认导出目录 |
| 重新连接 | 手动重扫 49650–49659 |
| 导出当前器件到 FuliForge | 把**当前原理图页所有器件**的符号+封装落盘为 `.sym.log` / `.fp.log`，并写 `easyeda_devices.json` 清单（含位号、LCSC、3D 引用） |
| 导出设计规则 | 从当前 PCB 拉规则配置、网络规则、层叠、图层表，写 `easyeda_rules.json` / `easyeda_layers.json` / `easyeda_rules_meta.json` |

默认导出目录：`<我的文档>\FuliForge\inbox\easyeda`（可通过 RPC 传 `targetDir` 覆盖）。

## 平台侧用法

```powershell
cd C:\Users\33106\Downloads\新建文件夹\kaoyan_ai\FuliForge
.\ff.cmd hub                               # 启动 Hub（含桥接 49650-49659）
.\ff.cmd status                            # 看有没有插件连上、监听的是哪个端口
.\ff.cmd probe                             # 枚举宿主真实可用的 eda.* API（排障第一步）
.\ff.cmd search "0402" --limit 5           # 搜器件
.\ff.cmd device <deviceUuid>               # 取单个器件（符号+封装源码、3D 引用）

.\ff.cmd export --dir lib/easyeda          # 整页器件落盘
.\ff.cmd rules  --dir lib/easyeda/rules    # 规则落盘
.\ff.cmd convert --in lib/easyeda --out lib/kicad   # 转成 KiCad 库
.\ff.cmd sync                              # 上面三步一条龙
```

> `ff.cmd` 会自己找 node（本机 PATH 里没有 `node`），并自动切到 FuliForge 根目录。
> 也可以直接 `node cli/lib.mjs ...`，但需要在正确的目录、且终端能找到 node。

`convert` 调用 `engine/forge/easyeda/cli.py`（纯标准库，系统 Python 即可，不需要 pcbnew）。
`FF_PYTHON` 可指定解释器，`FF_API` 可指定 Hub 地址。

## RPC 能力（17 项）

`ping` `status` `probe` `project.info` `lib.search` `lib.device` `lib.source` `lib.dump`
`model.3d` `rules.dump` `rules.collect` `pcb.drc` `pcb.stackup`
`schematic.devices` `schematic.export` `schematic.netlist` `doc.save`

HTTP 侧封装了更顺手的入口：`/api/ff/status`、`/api/ff/rpc`、`/api/ff/library`、`/api/ff/dump`、
`/api/ff/pull`、`/api/ff/export-schematic`、`/api/ff/rules`。

`/api/ff/pull` 是绕开 EDA 文件系统限制的落盘通道：源码经 WS 回传给 Hub，由 Hub 用 Node 写盘
（EDA 的 `saveFileToFileSystem` 在真实宿主上对任意路径返回 false，此路不通）。

## 协议

- 插件是**客户端**（`eda.sys_WebSocket.register` 只能连出），Hub 是服务端，端口 49650–49659，路径 `/fuliforge`
- **建连即发 hello**：`{"type":"hello","service":"fuliforge-bridge","server":"fuliforge-hub","protocolVersion":1}`
  插件只在 `service` 和 `server` 都对上时才 register —— 同一端口上可能有别的程序，认错就换下一个端口
- 注册帧：`{"type":"register","windowId","extensionVersion","capabilities":[...],"port"}`
- 之后 `{"type":"rpc","id","method","params"}` → 插件回 `result` / `error`
- 心跳：插件每 10s 主动 ping，12s 内收不到任何帧即判死重连；服务端 180s 无帧断开
- 多窗口各自独立注册；Hub 按键能力与方法挑选窗口

## 已验证到什么程度（离线证据）

| 验证 | 结果 |
|---|---|
| `node --check dist/index.js` | 通过 |
| `bridge/test/mock-e2e.mjs`（mock 宿主 + mock Hub，25 项断言） | 全部通过 |
| `bridge/test/hub-e2e.mjs`（mock 宿主 + **真 Hub** + HTTP API，12 项断言） | 全部通过 |
| 真实工程样例转换（98 符号 / 59 封装 / 79 器件 / 12 类规则） | `kicad-cli sym upgrade`、`fp upgrade` 往返全部通过 |
| 真实宿主首次联调（v0.1.0） | `lib.search` 取到真实 5 条 0402；`lib.device` 取到符号源码 4807B、封装源码 11668B、3D 引用 uuid + transform |

**真实宿主已验证的**：扩展管理器勾「允许外部交互」后桥接能注册、能 RPC，`lib.search` / `lib.device` 在真实器件库上跑通。

**真实宿主还没跑通的**：
- `saveFileToFileSystem` 对任意路径都返回 false（取源成功、写盘失败）→ 已改用 `/api/ff/pull` 由 Hub 写盘
- `sch_PrimitiveComponent.getAllPrimitiveId()` 抛「获取所有器件的图元ID失败」→ `schematic.devices` / `schematic.export` 暂不可用

## v0.1.2 改了什么

1. **自动重连**：`eda.sys_WebSocket` 不提供 onClose 回调，旧版感知不到 Hub 消失。现在插件每 10s 主动 ping，12s 内收不到任何帧就判死、拆连接、重连。
2. **端口占位不再连错**：之前 49650 被另一个程序（Python 的 `eda_bridge.server`）占着，插件连上去以为是 Hub、register 发出去没人处理。现在建连先等 hello，校验 `server: "fuliforge-hub"`，不对就换端口；Hub 也改为显式绑 `127.0.0.1` 并对占用自动顺延。
3. **probe 支持原型链**：`eda.lib_*` 的方法挂在 prototype 上，旧版枚举不到（methods 全空），现在沿原型链收集。

## 已知限制（待审草稿，不要当成品）

1. **3D 模型文件本体拿不到**。器件属性里只有 `3D Model` 的 uuid 与 transform，官方插件 API
   不返回 STEP/OBJ 文件流。当前提供三条兜底：① 器件页手动下载；② 扫描本地库目录/模型缓存；
   ③ 用封装尺寸在 FreeCAD/Blender 重建。需要拍板选哪条做主线。
2. **多子部件符号**（如双二极管 BAT54C 的 `.1/.2`）合并为单 unit，电气连接正确、图形合并。
3. **NGON 焊盘**退化为矩形，manifest 里有 warning 列表。
4. **丝印不合成**：源库没有顶层丝印图元时保持为空，不凭空生成。
5. **单位**：符号 1 unit = 10 mil，封装 1 unit = 1 mil，均由实测校准（R0402 本体 1.0×0.5 mm、
   BAT54CT BBOX 引脚落点吻合）。若某库单位异常，产物尺寸会明显不对，需人工核对。
6. 转换产物一律视为**待审草稿**：进产线前必须人工过一遍焊盘尺寸、引脚号、丝印与 3D 对齐。

## 排障

| 现象 | 处理 |
|---|---|
| `cli/lib.mjs status` 显示 0 个窗口 | ①「允许外部交互」是否勾选；② EDA 是否有打开的工程；③ 是否需要点「重新连接」 |
| 端口 49650 被占用 | Hub 自动顺延到 49659；插件按 hello 身份挑端口，会跳过占位程序，通常无需干预 |
| EDA 重启后插件不自动重连 | v0.1.2 已修（10s 探活、12s 判死）；旧版需手工点一次「重新连接」 |
| 某 RPC 报 `缺少 xxx` | 该 EDA 版本没有这个 API，`probe` 里能看到 `missing`，走降级分支 |
| 导出文件 0 字节 / 报 `source-error` | 工程库器件可能需要 `libraryUuid` 传 `"project"`；先用 `device` 看 `association` |
| 想确认 Hub 收到了什么 | `FuliForge\logs\hub.log`、`logs\hub.out.log` |
