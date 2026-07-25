# 故障排查

## `patch.cmd` 没有修改应用

检查：

- 是否批准了 UAC。
- Node.js 和 `node_modules` 是否存在。
- Codex 是否成功退出。
- 当前用户是否属于本机 Administrators。
- `npm run inspect` 是否仍能找到当前 Store 包和结构锚点。

脚本只对当前 `Get-AppxPackage OpenAI.Codex` 返回的包操作，并拒绝包目录外路径。

## 状态仍显示 `installed: false`

运行：

```powershell
npm run status
```

如果当前 ASAR 没有注入标记，说明管理员阶段未完成或覆盖失败。检查一键脚本窗口的退出码。不要手动复制不明 ASAR 到 `WindowsApps`。

## Codex 无法从商店入口启动

原位修改可能触发 AppX 完整性或包状态问题。由于没有备份，恢复方式是：

1. Windows 设置 → 应用 → Codex → 高级选项 → 修复。
2. 修复无效则重置。
3. 仍无效则从 Microsoft Store 卸载并重新安装 Codex。

`uninstall.cmd` 只移除补丁注入，不能保证恢复微软发布哈希。

## 商店更新失败或更新后补丁消失

这是原位修改的预期风险。先让商店完成修复/更新，再运行：

```powershell
npm run inspect
npm test
```

只有结构探测通过后才能重新双击 `patch.cmd`。新版本缺少锚点时脚本会 fail-fast。

## 标题栏没有组件

确认：

- `npm run status` 的 `installed` 和 `injectionPresent` 为 `true`。
- 已完全重启 Codex；现有 renderer 不会热加载被覆盖的 ASAR。
- 窗口有足够安全空间；空间不足时组件会自动隐藏。

如果组件在设置中被关闭，按 `Ctrl+Alt+Q` 打开配置。

## 显示“接口不兼容”

补丁收到的 usage 数据不符合已验证结构，自动解析和补充轮询会停止，不会显示猜测值。先检查 Store 是否更新。诊断不要附带完整响应、Cookie 或令牌。

## 显示“认证失效”或“接口限流”

- 401/403：补丁进入 30 分钟低频，先确认 Codex 本身可登录。
- 429：等待详情中退避结束；补丁尊重 `Retry-After`。
- 手动刷新仍受 3 秒冷却和 429 锁限制。

## ETA 显示“数据不足”或“无明显消耗”

周期线性 ETA 需要窗口时长、下次重置时间和当前已用百分比。缺少周期字段或当前时间不在该周期内时显示“数据不足”；当前使用量为零时显示“无明显消耗”。历史样本数量不影响 ETA。
