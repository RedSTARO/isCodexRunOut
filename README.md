# isCodexRunOut

这是针对当前 Windows Codex Desktop 的原位标题栏补丁。它直接重打包 Microsoft Store 安装目录中的 `app\resources\app.asar`，标准商店入口随后运行修改后的应用本体。

当前本机已验证版本：

- AppX：`OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0`
- AppX 版本：`26.721.4979.0`
- 应用资源版本：`26.721.41059`
- 原始 `app.asar` SHA-256：`44884f86d619a12c3c0af1b8c65945005bda4379775b03270674c666226ff4b7`
- 技术栈：Owl/Chromium 150，Electron 兼容 ASAR WebView

## 先明确风险

该模式：

- 需要管理员权限并修改 `WindowsApps` 中文件的 ACL。
- 不创建原始 ASAR 备份。
- 会使已签名 AppX 的文件内容偏离微软发布版本。
- 可能导致商店更新、包修复或启动完整性检查失败。
- 卸载只能删除补丁注入并重新打包，不能恢复微软原始字节级哈希。
- 需要恢复官方文件时，只能使用 Microsoft Store 的修复、重置或重装。

这是当前实现的预期行为，不是可忽略的告警。

## 一键使用

要求 Node.js 22.12 或更高版本，并先在仓库中安装依赖：

```powershell
npm install
```

随后双击：

- `patch.cmd`：请求 UAC、关闭所有 Codex 实例、直接 patch 当前 AppX、恢复文件 ACL、从标准商店入口重启 Codex。
- `uninstall.cmd`：请求 UAC、关闭 Codex、从当前 ASAR 移除注入、恢复 ACL、重启 Codex。

两个脚本均可重复执行。`patch.cmd` 检测到相同构建时不会再次写入；`uninstall.cmd` 检测不到注入时不会写入。

也可从终端运行：

```powershell
npm run inspect
npm run install:patch
npm run status
npm run uninstall:patch
```

`npm run restore` 在无备份模式下会直接报错。卸载后的 ASAR 是功能上未注入的重打包版本，不等于 Store 原始哈希。

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

ETA 是本地历史采样的统计估计，不是官方预测。样本不足、无明显消费或数据过期时不会输出具体耗尽时间。

详细依据见 [逆向分析](docs/reverse-engineering.md)、[架构](docs/architecture.md)、[测试记录](docs/testing.md) 和 [故障排查](docs/troubleshooting.md)。
