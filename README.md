# isCodexRunOut

这是针对当前 Windows Codex Desktop 的本地副本补丁。它保留 Microsoft Store
安装目录不变，将完整官方目录复制到用户可写位置，再重打包副本中的
`app\resources\app.asar`。

当前本机已验证版本：

- AppX：`OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0`
- AppX 版本：`26.721.4979.0`
- 应用资源版本：`26.721.41059`
- 原始 `app.asar` SHA-256：`44884f86d619a12c3c0af1b8c65945005bda4379775b03270674c666226ff4b7`
- 技术栈：Owl/Chromium 150，Electron 兼容 ASAR WebView

## 安装模型

当前使用两个完整目录：

- `%LOCALAPPDATA%\isCodexRunOut\codex_backup`：每次安装时从当前 Store
  版本重新同步的完整原始副本。
- `%LOCALAPPDATA%\isCodexRunOut\codex`：从 backup 复制后注入补丁的活动副本。

桌面快捷方式、用户开始菜单快捷方式和
`IS_CODEX_RUN_OUT_ROOT`/`IS_CODEX_RUN_OUT_APP` 用户环境变量指向活动副本。
Store 包及其 ACL 不修改。Windows 11 已固定的 Store 图标是 AppX AUMID，不能改写
目标；需要取消固定后固定 `ChatGPT (isCodexRunOut)`。

## 一键使用

要求 Node.js 22.12 或更高版本，并先在仓库中安装依赖：

```powershell
npm install
```

随后双击并批准 UAC：

- `patch.cmd`：同步 Store → backup，关闭 Codex，重建活动副本，注入补丁，
  重定向快捷方式和环境变量，再启动活动副本。
- `uninstall.cmd`：关闭活动副本，恢复原快捷方式和环境变量，删除两个托管副本，
  再启动 Store 原版。

两个脚本均可重复执行。每次 patch 都以当前 Store 版本重建活动副本，避免在旧补丁上
叠加修改。

也可从终端运行：

```powershell
npm run inspect
npm run install:patch
npm run status
npm run uninstall:patch
```

`npm run restore` 只恢复活动副本中的 ASAR 和远程控制 helper；完整卸载应使用
`uninstall.cmd`。

## Windows 远程控制

补丁同时启用 Codex 设置中的“连接 → 控制其他设备”，并为 Windows 提供设备密钥
实现：

- P-256 ECDSA / SHA-256。
- 私钥使用当前 Windows 用户的 DPAPI 加密后保存。
- 密钥文件位于
  `%CODEX_HOME%\remote-control-device-keys.windows.json`；未设置
  `CODEX_HOME` 时位于
  `%USERPROFILE%\.codex\remote-control-device-keys.windows.json`。
- 设备密钥 helper 只安装到活动副本的
  `app\resources\native\rc-device-key.cjs`。

DPAPI 的保护边界是当前 Windows 用户。以同一用户运行的其他进程可以请求 Windows
解密，因此该文件不应同步、共享或复制到其他设备。登录和设备注册仍由 Codex 官方
界面与服务完成。

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
