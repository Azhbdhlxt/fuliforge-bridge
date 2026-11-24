# FuliForge Bridge

嘉立创 EDA 专业版插件：把**器件、符号、封装、3D 模型引用、设计规则**导出到本机，再由 FuliForge 平台转成 KiCad / Altium 可用的库，供 FreeCAD / Blender / SolidWorks 做结构建模。

## 通道

```
嘉立创EDA 插件 ──ws://127.0.0.1:49650-49659/fuliforge──▶ Hub(8787) ──HTTP──▶ CLI ──▶ Python 转换器 ──▶ .kicad_sym / .kicad_mod / .kicad_dru
```

插件是**客户端**（`eda.sys_WebSocket.register` 只能连出），Hub 是服务端。

## 安装

1. 从 Releases 下载 `fuliforge-bridge_v<版本>.eext`
2. EDA → 设置 → 扩展 → 扩展管理器 → **从文件安装**
3. **勾选「允许外部交互」**（联网的硬前提，代码无法绕过；不勾则任何 WebSocket 都建不起来）
4. 重启 EDA（或重开工程），顶部菜单出现 **FuliForge**

> 端口从 49650 起自动找空闲端口（49650–49659）。若 49650 被别的程序占用，插件会校验服务端身份后跳过它，自动连到 Hub 真正监听的端口。

## 菜单

| 项 | 作用 |
|---|---|
| 连接状态 | 通道、窗口 id、收发计数、外部交互是否可用、默认导出目录 |
| 重新连接 | 手动重扫 49650–49659 |
| 导出当前器件到 FuliForge | 当前原理图页所有器件的符号 + 封装落盘，并写 `easyeda_devices.json` 清单 |
| 导出设计规则 | 规则配置、网络规则、层叠、图层表 → `easyeda_rules.json` / `easyeda_layers.json` |
| 关于… | 版本与协议信息 |

## RPC 能力（17 项）

`ping` `status` `probe` `project.info` `lib.search` `lib.device` `lib.source` `lib.dump`
`model.3d` `rules.dump` `rules.collect` `pcb.drc` `pcb.stackup`
`schematic.devices` `schematic.export` `schematic.netlist` `doc.save`

## 协议

- **建连即发 hello**：`{"type":"hello","service":"fuliforge-bridge","server":"fuliforge-hub","protocolVersion":1}`
- 插件只在 `service` 与 `server` 都对上时才 register —— 同一端口上可能有别的程序，认错就换下一个端口
- 注册后 `{"type":"rpc","id","method","params"}` → 插件回 `result` / `error`
- 心跳：插件每 10s 主动 ping，12s 内收不到任何帧即判死重连；服务端 180s 无帧断开
- 多窗口各自独立注册；Hub 按能力与方法挑选窗口

## 打包

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1
```

产物：`dist/fuliforge-bridge_v<version>.eext`

## 版本

| 版本 | 说明 |
|---|---|
| 0.1.2 | 自动重连（10s 探活、12s 判死）、端口占位身份校验、probe 沿原型链枚举 |
| 0.1.1 | 心跳探活、send 失败即断链 |
| 0.1.0 | 首个可用版本：器件 / 符号 / 封装 / 设计规则导出 |

## 已知限制（待审草稿）

1. **3D 模型文件本体拿不到**：官方插件 API 只返回 uuid 与 transform，STEP/OBJ 需另行获取
2. **多子部件符号**（如双二极管）合并为单 unit，电气连接正确、图形合并
3. **NGON 焊盘**退化为矩形，清单里带 warning
4. 转换产物一律视为**待审草稿**：进产线前必须人工复核焊盘尺寸、引脚号、丝印与 3D 对齐

MIT License
