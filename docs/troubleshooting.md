# 故障排查

## `patch.cmd` 没有修改应用

检查：

- 是否批准了 UAC。
- Node.js 和 `node_modules` 是否存在。
- Codex 是否成功退出。
- `npm run inspect` 是否仍能找到当前 Store 包和结构锚点。

检查 `%LOCALAPPDATA%\isCodexRunOut\direct-operation.log`。脚本只读取当前
`Get-AppxPackage OpenAI.Codex` 返回的 Store 包，所有写入都限制在
`%LOCALAPPDATA%\isCodexRunOut`。

## 状态仍显示 `installed: false`

运行：

```powershell
npm run status
```

确认输出中的 `activeRoot` 指向
`%LOCALAPPDATA%\isCodexRunOut\codex`，并检查：

- `backupValid`
- `activeAsarHash`
- `injectionPresent`
- `remoteControlEnabled`
- `shortcutsRedirected`
- `environmentRedirected`

任一项为 false 时，检查一键脚本退出码和日志。不要手动复制文件到
`WindowsApps`。

## 启动的仍是 Store 原版

Windows 11 已固定的 Codex 项是 AppX AUMID，脚本不能改写其目标。执行以下任一操作：

1. 从桌面 `Codex` 快捷方式启动。
2. 从开始菜单启动 `ChatGPT (isCodexRunOut)`。
3. 取消固定原 Store 图标，再固定新的用户快捷方式。

## 商店更新失败或更新后补丁消失

Store 包本身未修改。商店更新不会自动更新正在使用的活动副本；更新完成后运行：

```powershell
npm run inspect
npm test
```

结构探测通过后重新双击 `patch.cmd`，它会从新 Store 版本重建两个副本。新版本缺少
任一标题栏、额度或远程控制锚点时会 fail-fast。

## 标题栏没有组件

确认：

- `npm run status` 的 `installed` 和 `injectionPresent` 为 `true`。
- 已完全重启 Codex；现有 renderer 不会热加载被覆盖的 ASAR。
- 窗口有足够安全空间；空间不足时组件会自动隐藏。

如果组件在设置中被关闭，按 `Ctrl+Alt+Q` 打开配置。

## “控制其他设备”没有出现

运行 `npm run status`，确认：

- `remoteControlEnabled` 为 true。
- `deviceKeyHelperPath` 指向活动副本且文件存在。
- 当前进程路径位于 `%LOCALAPPDATA%\isCodexRunOut\codex`，而不是
  `C:\Program Files\WindowsApps`。

设置入口在 Codex 的“设置 → 连接”。如果 status 正常但入口缺失，当前 Store 构建
的 bundle 结构或服务端 gate 行为可能已经变化；重新执行 `npm run inspect`，不要
手动扩大正则匹配范围。

## 远程控制设备密钥失败

密钥文件默认为
`%USERPROFILE%\.codex\remote-control-device-keys.windows.json`。不要手工编辑、
同步或复制该文件。若日志报告 DPAPI 解密失败，常见前提是文件来自另一个 Windows
用户或设备；保留原文件供检查，再由用户决定是否删除并重新注册设备。

## 显示“接口不兼容”

补丁收到的 usage 数据不符合已验证结构，自动解析和补充轮询会停止，不会显示猜测值。先检查 Store 是否更新。诊断不要附带完整响应、Cookie 或令牌。

## 显示“认证失效”或“接口限流”

- 401/403：补丁进入 30 分钟低频，先确认 Codex 本身可登录。
- 429：等待详情中退避结束；补丁尊重 `Retry-After`。
- 手动刷新仍受 3 秒冷却和 429 锁限制。

## ETA 显示“数据不足”或“无明显消耗”

周期线性 ETA 需要窗口时长、下次重置时间和当前已用百分比。缺少周期字段或当前时间不在该周期内时显示“数据不足”；当前使用量为零时显示“无明显消耗”。历史样本数量不影响 ETA。
