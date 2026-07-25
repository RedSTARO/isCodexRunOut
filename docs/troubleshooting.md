# 故障排查

## `npm run launch` 报告 Codex 正在运行

补丁副本与商店原版默认使用同一个 Codex 用户数据目录，不能同时作为正常实例运行。先从 Codex 菜单正常退出所有窗口，确认托盘或后台主进程也已退出，再启动。

安装过程不要求退出原版，因为它只复制只读文件；启动、恢复和卸载需要退出补丁版。

## 状态显示 `updateDetected: true`

微软商店包名或源 ASAR 哈希已经变化。不要继续使用旧副本：

```powershell
npm run uninstall:patch
npm run inspect
npm test
npm run install:patch
```

如果 `inspect` 报缺少结构锚点，需要先更新本项目的兼容代码，不能跳过检查。

## 标题栏没有组件

依次检查：

```powershell
npm run status
```

确认：

- `installed` 为 `true`
- `updateDetected` 为 `false`
- `sourceUntouched`、`backupValid` 和 `injectionPresent` 都为 `true`
- 启动路径是 `status` 输出的用户目录 `ChatGPT.exe`，不是微软商店快捷方式

如果组件曾在设置里关闭，按 `Ctrl+Alt+Q` 打开配置。安全空间不足时组件会自动隐藏，此时放宽窗口后再检查。

## 显示“接口不兼容”

补丁收到 usage 响应，但字段不符合已验证结构。自动解析和补充轮询会停止，不会继续显示猜测值。先运行 `npm run status` 判断是否发生客户端更新。诊断不要附带完整响应、Cookie 或令牌。

## 显示“认证失效”或“接口限流”

- 401/403：先确认 Codex 原应用能正常登录；补丁进入 30 分钟低频，不会高频重试。
- 429：等待详情中退避时间结束；补丁尊重 `Retry-After`。
- 手动刷新同样受 3 秒冷却和 429 锁限制。

## ETA 一直是“数据不足”

具体 ETA 至少需要 3 个真实变化样本、2 分钟跨度和 2 个正向消耗区间。额度百分比长期不变时显示“无明显消耗”。这不是故障。

关闭自动补充轮询不会关闭 Codex 自身约一分钟一次的刷新；它也不会清空历史。清空历史后必须重新积累样本。

## 恢复或卸载被拒绝

- 补丁版仍运行：正常退出后重试。
- 备份哈希不匹配：不要手动覆盖；保留现场并检查 `%LOCALAPPDATA%\isCodexRunOut\state.json`。
- 目标 ASAR 是未知第三种哈希：命令会 fail-fast，避免覆盖其他修改。

微软商店原版始终保留，可直接从商店快捷方式启动。卸载删除本地副本和备份时使用直接删除，不进入回收站；原版仍可恢复使用。
