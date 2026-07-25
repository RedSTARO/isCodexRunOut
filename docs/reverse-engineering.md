# 本机逆向分析

分析时间：2026-07-25，未使用网络文章或历史版本结构作为依据。

## 安装与启动

PowerShell `Get-AppxPackage OpenAI.Codex` 的实际结果：

| 项目 | 实测值 |
|---|---|
| 来源 | Microsoft Store |
| 包名 | `OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0` |
| AppX 版本 | `26.721.4979.0` |
| 安装位置 | `C:\Program Files\WindowsApps\OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0` |
| 主程序 | `app\ChatGPT.exe` |
| 应用资源 | `app\resources\app.asar` |
| ASAR SHA-256 | `44884f86d619a12c3c0af1b8c65945005bda4379775b03270674c666226ff4b7` |

AppX manifest 声明 full-trust desktop application。进程树实测包含 Owl/Chromium 150.0.7871.128 的 browser、renderer、GPU、network 和 storage 进程，以及 `codex.exe app-server`。ASAR 内 `package.json` 的应用版本为 `26.721.41059`，构建号 5848，Electron 依赖为 42.3.0，入口为 `.vite/build/early-bootstrap.js`。

ASAR 共 5918 个文件，37 个文件标记为 unpacked，主要是 better-sqlite3、node-pty 和两个设备串口/USB native binding。补丁重打包不允许改变这 37 个路径。

## WebView 与标题栏

实际 `webview/index.html` 加载：

- `assets/index-DqK89hOt.js`
- `assets/app-initial-BbEVL4-_.js`
- `assets/app-initial-Cla-mNzi.css`

CSP 的 `script-src` 和 `style-src` 均允许 `'self'`，因此只需加入 ASAR 内同源 JS/CSS，不修改 CSP。

第一行真实标题栏是一个包含 class token `group/application-menu-top-bar` 的 `div`，高度 36 CSS px，内含文件/编辑/视图/帮助等菜单。第二行是
`header[data-app-shell-header-edge-scroll]`，它是页面 header，不能作为目标。

原应用使用：

- `.draggable { -webkit-app-region: drag }`
- `.no-drag { -webkit-app-region: no-drag }`
- `navigator.windowControlsOverlay.getTitlebarAreaRect()`
- `--spacing-token-safe-header-right`

因此补丁使用第一行 flex 正常流、slot drag、widget no-drag，并复用原窗口按钮安全区。实际 DOM 调试确认第一行范围 `top=0, height=36`，第二行从 `top=36` 开始；组件 parent 就是第一行标题栏。

## 额度请求

当前前端查询实测行为：

- endpoint：`GET /wham/usage`
- query key：`rate-limit-status`
- 原客户端刷新周期：约 1 分钟
- retry：关闭
- 窗口聚焦时刷新：开启

renderer 通过 `window.electronBridge.sendMessageFromView` 发送：

```text
type=fetch, requestId, method, url, headers
```

主进程返回 window message：

```text
type=fetch-response, requestId, responseType, status, headers, bodyJsonString
```

原客户端同时发出 `codex-message-from-view` CustomEvent，因此补丁可以先记录真实 usage 请求的 requestId，再只消费对应 response。补充请求使用当前包内已验证的 attach 标记，由主进程完成认证。补丁没有认证值，也不输出请求或响应正文。

## 已确认数据结构

前端 `/wham/usage`：

| 路径 | 已验证含义 |
|---|---|
| `rate_limit.primary_window` | 主要时间窗口 |
| `rate_limit.secondary_window` | 可选的第二时间窗口 |
| `used_percent` | 当前周期已使用百分比 |
| `reset_at` | Unix epoch 秒重置时间 |
| `limit_window_seconds` | 周期秒数 |
| `credits.has_credits` | 是否有 Credits |
| `credits.unlimited` | Credits 是否无限 |
| `credits.balance` | Credits 余额字符串/数值 |
| `plan_type` | 计划类型 |
| `rate_limit_name` | 额度名称 |
| `additional_rate_limits[]` | 其他独立额度桶 |

本机 Store `codex.exe` 版本 `codex-cli 0.146.0-alpha.3.1` 生成的 app-server schema 还确认了：

- 方法 `account/rateLimits/read`
- 通知 `account/rateLimits/updated`
- `rateLimits` 与 `rateLimitsByLimitId`
- `RateLimitWindow.usedPercent`
- `RateLimitWindow.windowDurationMins`
- `RateLimitWindow.resetsAt`
- `limitId`、`limitName`、`planType` 和 credits

通过本机 app-server 实际调用确认当前账户可以返回多个额度桶。测试时主要窗口实际周期为 10080 分钟，即 7 天；另一个具名额度桶同样为 7 天。测试响应当时没有 5 小时窗口，所以实现不会假定或伪造 5 小时窗口。

## 选定的修改方式

`WindowsApps` 的实际 owner 为 `SYSTEM`，普通用户只有读取/执行权限，`TrustedInstaller` 和 `SYSTEM` 有 FullControl。本机中以 medium integrity 打开 `app.asar` 写句柄实际返回 Access denied。

根据当前要求，补丁脚本通过 UAC 提升后临时取得单个 `app.asar` 的 ownership/write ACL，在本地临时目录完成重打包和校验，再直接覆盖当前 Store 文件并恢复 ACL/owner。没有外部悬浮窗口、完整应用副本或原版 ASAR 备份，标准商店入口直接运行被修改的应用。

该方式会使包内容偏离签名发布状态，可能干扰 AppX 完整性、修复和自动更新。卸载只能删除注入，字节级官方恢复依赖 Microsoft Store 修复或重装。
