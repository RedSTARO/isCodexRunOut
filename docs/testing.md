# 测试与验收记录

测试日期：2026-07-25。环境为 Windows、单显示器 1440×900；Codex renderer 实际参数包含 `device-scale-factor=2`。

## 自动化

执行：

```powershell
npm run build
npm run check
npm test
```

结果：19/19 通过。覆盖：

- 配置白名单、轮询上下限、关闭值、后台倍率和固定周期
- wham 与 app-server 两种真实字段形状、多额度桶和非法数据 fail-fast
- ETA 样本不足、无消费、真实时间间隔、重置周期、晚于重置、主窗口选择
- 历史去重、损坏隔离
- in-flight 去重、429、认证失败、不兼容停止和指数退避
- HTML 单次注入
- ASAR patch、重复 patch、unpatch 往返测试，包括 unpacked 集合与内容哈希
- 恢复文件的校验、切换和临时文件清理

## 原位 patch/unpatch

普通权限下对 Store `app.asar` 打开写句柄的实测结果为 Access denied；文件 owner 为 `SYSTEM`，`TrustedInstaller`/`SYSTEM` 有 FullControl，Users 只有 Read/Execute。因此一键脚本必须经过 UAC、`takeown` 和临时 ACL grant。

直接运行 `node scripts/cli.mjs direct-install` 会在构建和写入前 fail-fast，并在失败后再次确认 Store ASAR 仍保持原始 SHA-256。

在不写 `WindowsApps` 的情况下，以真实 Store ASAR 完成了临时目录 patch→unpatch 往返：

- 输入原始哈希：`44884f86d619a12c3c0af1b8c65945005bda4379775b03270674c666226ff4b7`
- 候选补丁哈希：`f308372e1beb459d3a9373abc307cb0b52b86834875191cee3b92c3b64c5109e`
- unpatch 重打包哈希：`93db607e04b9eaa3d139d7b9ef5eb5b2678b66f68ac3492efb0639c46a2400aa`
- unpacked 文件数：37，集合和内容哈希一致
- 往返后 Store 源哈希未变化
- unpatch 哈希与 Store 原哈希不同，证明无备份卸载不能声称字节级恢复

自提权脚本已通过 PowerShell parser 检查，但没有在本任务进程内执行管理员覆盖：脚本会关闭正在承载本任务的 Codex。实际原位覆盖需要用户双击 `patch.cmd` 并批准 UAC。

原位覆盖没有自动回滚或备份。候选在覆盖前完成全部结构和哈希检查，但覆盖本身若失败只能由 Store 修复/重装。

## 实际窗口与自适应

使用独立空白用户数据目录启动补丁 `ChatGPT.exe`，临时在 localhost 开启 CDP，只读取 DOM/样式和调整测试 viewport。没有复用或导出当前 Codex 登录材料。

实际主窗结果：

- 注入实例存在，标题栏锚点状态 `mounted`
- 数据 Hook 状态 `existing-client-result`
- 兼容状态 `compatible`
- safe area 状态 `valid`
- slot parent 为第一行标题栏
- 标题栏和 slot 高度均为 36 px，没有增加高度
- slot 是 `drag`，widget 是 `no-drag`
- widget 在标题栏可用 slot 内右对齐，右边界仍受 native safe area 检查
- 右对齐复测：slot 右边界 1143 px，widget 右边界 1135 px，保留 8 px 内边距，`justify-content=flex-end`，safe area 为 `valid`
- 第二行页面 header 从 y=36 开始，没有被注入
- 点击组件可打开详情面板，Escape 可关闭
- `initialRoute=/avatar-overlay` 的辅助窗口没有创建补丁实例

自适应实测：

| viewport 宽度 | slot 宽度 | widget 宽度 | 档位 | 可见字段 |
|---:|---:|---:|---|---|
| 1400 | 988 | 296 | full | 名称、百分比、进度、ETA、重置 |
| 1100 | 784 | 281 | full | 名称、百分比、进度、ETA、重置 |
| 900 | 584 | 271 | full | 名称、百分比、进度、ETA、重置 |
| 760 | 444 | 264 | full | 名称、百分比、进度、ETA、重置 |
| 640 | 324 | 180 | eta | 名称、百分比、进度、ETA |
| 520 | 204 | 103 | bar | 名称、百分比、进度 |

正常 fresh 状态在所有档位均不占标题栏；异常状态只在空间允许时显示。组件收缩时没有覆盖左侧菜单或右侧 native safe area。

当前构建在额度名称与百分比之间插入 `icr-widget-separator`，文本为居中点 `·`，opacity 为 0.45；仅百分比档位会同时隐藏名称和分隔点。

## 真实数据行为

- 已实际收到 Codex 自身 `/wham/usage` 请求结果并显示多个真实额度窗口。
- 详情数据来自 `codex-existing`，没有使用示例百分比。
- 实际账户当时没有 5 小时窗口，界面没有制造 5 小时项。
- 空白历史时显示“数据不足”；积累不变样本后显示“无明显消耗”，不显示具体虚假 ETA。
- 多窗口测试中只有一个 Web Locks Leader，辅助头像窗不启动运行时。

## 尚未自动确认

以下项目不能从当前单显示器和 CDP DOM 测试中得出完整结论，不能标记为已通过：

- 物理第二显示器上的拖动、缩放和每屏 DPI 切换：本机只有一个显示器。
- 鼠标双击标题栏最大化/还原和右键系统菜单：slot 的非组件区域已实测为 `drag`，但没有用禁止的 Computer Use 代替人工输入。
- 长时间休眠/唤醒、数小时后台退避和真实 429：逻辑由自动化测试覆盖，未等待真实服务器制造这些状态。
- 实际认证失效、服务端字段突变和 Credits 消费：只做了合成错误测试。
- 完整发起 Codex 编码任务、终端和插件业务回归：测试副本能启动、渲染主页并读取额度，但未在独立空白配置中执行真实任务。

人工验收时应双击 `patch.cmd`，批准 UAC，等待标准 Store 入口重启后逐项验证双击、右键、最大化、侧栏开关和一段正常任务流程。
