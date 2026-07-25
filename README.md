# isCodexRunOut

这是针对当前 Windows Codex Desktop 的标题栏补丁。它从 Microsoft Store 安装目录创建本地副本，只重打包副本中的 `app\resources\app.asar`，再通过快捷方式启动修改后的应用本体。

当前本机已验证版本：

- AppX：`OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0`
- AppX 版本：`26.721.4979.0`
- 应用资源版本：`26.721.41059`
- 原始 `app.asar` SHA-256：`44884f86d619a12c3c0af1b8c65945005bda4379775b03270674c666226ff4b7`
- 技术栈：Owl/Chromium 150，Electron 兼容 ASAR WebView

## 先明确风险

该模式：

- 需要管理员权限读取并复制当前 AppX 布局、关闭 Codex 进程和更新快捷方式。
- 在 `%LOCALAPPDATA%\isCodexRunOut` 保存一份原始副本和一份补丁副本，磁盘占用约为应用安装体积的两倍。
- 不修改 `WindowsApps` 中的 Store 源文件，标准商店入口仍启动未注入版本。
- Store 更新后，本地副本不会自动同步，必须重新运行 `install.cmd`。
- 安装会重定向匹配的 Codex 快捷方式，并保存原值供卸载恢复。

这是当前实现的预期行为，不是可忽略的告警。

## 一键使用

要求 Node.js 22.12 或更高版本。随后双击：

- `install.cmd`：缺少依赖时自动执行 `npm ci`，随后请求 UAC、关闭所有 Codex 实例、创建并 patch 本地应用副本、重定向快捷方式并启动补丁副本。
- `uninstall.cmd`：请求 UAC、关闭 Codex、恢复快捷方式和环境变量、删除本地副本，再启动 Store 版本。

两个脚本均可重复执行。`install.cmd` 会复用已安装的依赖，并重新生成当前补丁副本；`uninstall.cmd` 会移除补丁副本并恢复快捷方式。

也可从终端运行：

```powershell
npm run inspect
npm run install:patch
npm run status
npm run uninstall:patch
```

`npm run restore` 会用原始副本恢复补丁副本中的 ASAR；`uninstall.cmd` 则删除两个本地副本和补丁状态。

## 标题栏

组件位于 Codex 第一行应用菜单标题栏中，作为普通 flex 子项右对齐在原生窗口按钮安全区左侧。默认文本形态为：

```text
7d · 13%
```

中间使用半透明居中点分隔。组件根据实时可用空间逐档降级：

`完整 → 隐藏状态 → 隐藏重置 → 隐藏 ETA → 隐藏进度条 → 仅百分比 → 整体隐藏`

正常“最新”状态不占标题栏；离线、过期、限流、认证失败或接口不兼容时才显示状态。slot 保持 `drag`，组件交互区为 `no-drag`。

## 数据与配置

补丁优先旁听 Codex 自身 `/wham/usage` 请求结果。需要补充刷新时复用 Codex 主进程请求桥，由主进程附加认证；补丁不读取、保存或输出令牌、Cookie 或认证值。

点击组件可配置：

- 主额度和额度窗口可见性
- 标准/紧凑密度、进度、ETA、重置、状态与时间格式
- 关闭、预设或自定义补充轮询（30 秒至 24 小时）
- 后台倍率或固定周期、隐藏暂停、上线/启动刷新
- 请求超时、历史保留、调试日志、清空历史与恢复默认

ETA 以 `下次重置时间 - 窗口时长` 推导上次重置时间，再按“本周期已过时间 / 当前已用百分比”计算周期平均速率并线性外推。它不是官方预测；缺少周期字段、使用量为零或数据过期时不输出具体耗尽时间。

详细依据见 [逆向分析](docs/reverse-engineering.md)、[架构](docs/architecture.md)、[测试记录](docs/testing.md) 和 [故障排查](docs/troubleshooting.md)。
