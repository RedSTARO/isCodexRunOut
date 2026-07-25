# isCodexRunOut

这是一个针对当前 Windows 版 Codex Desktop 的本地、可回滚标题栏补丁。它把额度组件作为 Codex 第一行应用菜单标题栏中的普通 flex 子项注入，不创建外部悬浮窗，也不增加第二层标题栏。

当前本机已验证版本：

- AppX：`OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0`
- AppX 版本：`26.721.4979.0`
- 应用资源版本：`26.721.41059`
- 原始 `app.asar` SHA-256：`44884f86d619a12c3c0af1b8c65945005bda4379775b03270674c666226ff4b7`
- 技术栈：Owl/Chromium 150，Electron 兼容 ASAR WebView

其他版本必须先通过结构探测，不能仅凭版本号假定兼容。

## 使用

要求 Node.js 22.12 或更高版本。当前实现已在 Node.js 24.16.0 验证。

```powershell
npm install
npm run inspect
npm test
npm run install:patch
```

安装不会改写 `C:\Program Files\WindowsApps`。它在
`%LOCALAPPDATA%\isCodexRunOut` 建立原版备份和可写应用副本。安装完成后，先正常退出所有正在运行的 Codex，再启动补丁副本：

```powershell
npm run launch
```

微软商店快捷方式仍启动微软商店管理的原版。补丁版必须使用上面的启动命令；这是保持原签名目录和自动更新不被破坏的代价。

常用维护命令：

```powershell
npm run status
npm run restore
npm run uninstall:patch
```

- `status`：检查商店更新、源文件哈希、备份、补丁 ASAR 和注入标记。
- `restore`：把本地应用副本恢复为备份的原版 ASAR，保留副本和备份。
- `uninstall:patch`：先恢复，再删除本地副本、状态和备份。用户配置及额度历史不会被直接删除。
- 重复安装、恢复和卸载都是幂等操作。
- 恢复或卸载时若补丁版仍在运行，命令会直接失败，避免覆盖运行中的资源。

Codex 更新后，`status` 会报告 `updateDetected: true`，`launch` 会拒绝启动旧副本。处理流程：

```powershell
npm run uninstall:patch
npm run inspect
npm test
npm run install:patch
```

如果新版本缺少已验证的标题栏、请求桥或数据结构锚点，安装会 fail-fast。

## 界面与配置

组件根据标题栏实时可用空间逐档降级：

`完整 → 隐藏状态 → 隐藏重置 → 隐藏 ETA → 隐藏进度条 → 仅百分比 → 整体隐藏`

实际实现保留一部分标题栏拖动空间，并测量当前内容宽度后选档，不依赖固定窗口宽度。正常“最新”状态不占标题栏；离线、过期、限流、认证失败或接口不兼容时才显示状态。

点击组件打开详情面板。可配置：

- 主额度自动或固定选择、额度窗口可见性
- 标准/紧凑密度以及进度、ETA、重置、状态和时间格式
- 关闭、预设或自定义补充轮询（30 秒至 24 小时）
- 后台倍率或固定后台周期、隐藏暂停、上线/启动刷新
- 请求超时、历史保留、调试日志、清空历史和恢复默认值

组件关闭后可用 `Ctrl+Alt+Q` 打开配置。设置即时写入 Codex 用户配置目录对应 WebView origin 的 `localStorage`。

## 数据与限制

补丁优先旁听 Codex 自身 `/wham/usage` 请求结果。需要补充刷新时，它复用 Codex 已有主进程请求桥，由主进程附加认证；补丁代码不读取、保存或输出令牌、Cookie 或认证头的值。

预计耗尽时间是本地采样的统计估计，不是官方预测。样本不足、无明显消费或数据过期时不会输出具体 ETA；预计耗尽晚于重置时显示“本周期预计不会耗尽”。

已确认的限制和未完成的人工验收见 [测试记录](docs/testing.md)；逆向依据见 [逆向分析](docs/reverse-engineering.md)；故障处理见 [故障排查](docs/troubleshooting.md)。
